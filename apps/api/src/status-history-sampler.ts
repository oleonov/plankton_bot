/**
 * StatusHistorySampler — records the Status screen's history from the API
 * process (not the runtime), so a runtime outage is captured as `crit`, not a
 * grey gap. Each tick folds the current per-series severity into today's
 * UTC-day bucket (worst-of-day, accumulating observed seconds), and an hourly
 * prune keeps the table to a rolling window.
 *
 * Fail-soft: write/prune failures never crash the API and never touch the
 * trading/control request path — they are logged at most once per 5 minutes and
 * retried on the next tick.
 */

import type Database from "better-sqlite3";
import type { StatusSev, StatusSeries } from "@krabs/domain";
import type { LedgerPool } from "./ledger-pool.js";
import { resolveActiveLedger } from "./active-ledger.js";
import { collectSystemHealthSnapshot } from "./system-health-snapshot.js";
import {
  upsertStatusBucket,
  pruneStatusHistory,
  startOfUtcDay,
  DAY_MS,
  STATUS_HISTORY_WINDOW_DAYS,
} from "./status-history-store.js";

export interface StatusHistorySamplerOpts {
  ledgerDb: Database.Database;
  controlDb: Database.Database;
  ledgerPool?: LedgerPool;
  marketDataStaleThresholdMs: number;
  intervalMs?: number;
  windowDays?: number;
  pruneEveryMs?: number;
}

const WARN_THROTTLE_MS = 300_000;

export class StatusHistorySampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private lastPruneMs = 0;
  private lastWarnMs = 0;
  private readonly intervalMs: number;
  private readonly windowDays: number;
  private readonly pruneEveryMs: number;

  constructor(private readonly opts: StatusHistorySamplerOpts) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.windowDays = opts.windowDays ?? STATUS_HISTORY_WINDOW_DAYS;
    this.pruneEveryMs = opts.pruneEveryMs ?? 3_600_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Record one observation. `nowMs` is injectable for tests. */
  tick(nowMs: number = Date.now()): void {
    try {
      // First tick assumes one interval elapsed; later ticks use the real delta,
      // clamped so a sampler outage cannot inflate a single bucket.
      const elapsedMs =
        this.lastTickMs === 0
          ? this.intervalMs
          : Math.min(Math.max(nowMs - this.lastTickMs, 0), this.intervalMs * 2);
      this.lastTickMs = nowMs;
      const elapsedSecs = elapsedMs / 1000;

      const { db } = resolveActiveLedger(
        this.opts.ledgerDb,
        this.opts.controlDb,
        this.opts.ledgerPool,
      );
      const { snapshot } = collectSystemHealthSnapshot(
        db,
        this.opts.controlDb,
        this.opts.marketDataStaleThresholdMs,
      );

      const bucketTs = startOfUtcDay(nowMs);
      const series: { series: StatusSeries; sev: StatusSev; detail: string }[] = [
        { series: "uptime", sev: snapshot.uptime, detail: snapshot.paused ? "paused" : "" },
        ...snapshot.modules.map((m) => ({ series: m.series, sev: m.s, detail: m.detail })),
      ];

      const write = this.opts.controlDb.transaction(() => {
        for (const s of series) {
          upsertStatusBucket(this.opts.controlDb, {
            series: s.series,
            bucketTs,
            sev: s.sev,
            downSecs: s.sev === "ok" ? 0 : elapsedSecs,
            critSecs: s.sev === "crit" ? elapsedSecs : 0,
            knownSecs: elapsedSecs,
            detail: s.sev === "ok" ? null : s.detail || null,
          });
        }
      });
      write();

      this.maybePrune(nowMs);
    } catch (err) {
      this.warn("sample failed", err);
    }
  }

  private maybePrune(nowMs: number): void {
    if (this.lastPruneMs !== 0 && nowMs - this.lastPruneMs < this.pruneEveryMs) return;
    this.lastPruneMs = nowMs;
    try {
      const cutoff = startOfUtcDay(nowMs) - this.windowDays * DAY_MS;
      pruneStatusHistory(this.opts.controlDb, cutoff);
    } catch (err) {
      this.warn("prune failed", err);
    }
  }

  private warn(msg: string, err: unknown): void {
    const now = Date.now();
    if (this.lastWarnMs !== 0 && now - this.lastWarnMs < WARN_THROTTLE_MS) return;
    this.lastWarnMs = now;
    // eslint-disable-next-line no-console
    console.warn(`[status-history] ${msg}:`, err instanceof Error ? err.message : err);
  }
}
