/**
 * StatusHistorySampler — records the Status screen's history from the API
 * process (not the runtime). Each tick folds the current per-series state into
 * today's UTC-day bucket and an hourly prune keeps the table to a rolling window.
 *
 * A deploy restarts the runtime; the sampler comes up before the runtime has
 * finished booting + reconnecting market data. To avoid painting a planned
 * restart (or an intentional pause) as a red outage, the tick classifies itself:
 *
 *   !runtimeLive && !inWarmup   -> crit         (dead runtime IS an outage, even if
 *                                                 the paused flag is still set)
 *   paused && runtimeLive       -> paused        (intentional pause; excluded from uptime)
 *   inWarmup && !ready          -> maintenance   (deploy warm-up; excluded from uptime)
 *   else                        -> normal ok/warn/crit
 *
 * Liveness is heartbeat-based (a dead runtime stops rewriting its heartbeat), and
 * the initial readiness latch requires heartbeat + market timestamps strictly
 * AFTER the sampler started — so a stale pre-restart row cannot latch readiness.
 * A 5-min warm-up backstop guarantees a genuinely stuck deploy still records crit.
 *
 * Fail-soft: write/prune failures never crash the API and are logged ≤ once/5 min.
 */

import type Database from "better-sqlite3";
import type { StatusSev, StatusSeries } from "@krabs/domain";
import type { LedgerPool } from "./ledger-pool.js";
import { resolveActiveLedger } from "./active-ledger.js";
import {
  collectSystemHealthSnapshot,
  computeModuleSeverities,
  RUNTIME_HEARTBEAT_STALE_MS,
  type SystemHealthSnapshot,
} from "./system-health-snapshot.js";
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
  warmupBackstopMs?: number;
  heartbeatStaleMs?: number;
}

const WARN_THROTTLE_MS = 300_000;
const WARMUP_BACKSTOP_MS = 300_000; // 5 min: a deploy that isn't ready by now IS an outage

type TickState = "crit" | "paused" | "maintenance" | "normal";

interface SeriesWrite {
  series: StatusSeries;
  sev: StatusSev;
  downSecs: number;
  critSecs: number;
  knownSecs: number;
  maintenanceSecs: number;
  pausedSecs: number;
  detail: string | null;
}

export class StatusHistorySampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private lastPruneMs = 0;
  private lastWarnMs = 0;
  private samplerStartedAtMs = 0;
  private readyLatched = false;
  private readonly intervalMs: number;
  private readonly windowDays: number;
  private readonly pruneEveryMs: number;
  private readonly warmupBackstopMs: number;
  private readonly heartbeatStaleMs: number;

  constructor(private readonly opts: StatusHistorySamplerOpts) {
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.windowDays = opts.windowDays ?? STATUS_HISTORY_WINDOW_DAYS;
    this.pruneEveryMs = opts.pruneEveryMs ?? 3_600_000;
    this.warmupBackstopMs = opts.warmupBackstopMs ?? WARMUP_BACKSTOP_MS;
    this.heartbeatStaleMs = opts.heartbeatStaleMs ?? RUNTIME_HEARTBEAT_STALE_MS;
  }

  start(): void {
    if (this.timer) return;
    this.samplerStartedAtMs = Date.now();
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
      if (this.samplerStartedAtMs === 0) this.samplerStartedAtMs = nowMs;
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
        nowMs,
      );

      const writes = this.buildWrites(nowMs, elapsedSecs, snapshot);
      const bucketTs = startOfUtcDay(nowMs);
      const write = this.opts.controlDb.transaction(() => {
        for (const w of writes) upsertStatusBucket(this.opts.controlDb, { ...w, bucketTs });
      });
      write();

      this.maybePrune(nowMs);
    } catch (err) {
      this.warn("sample failed", err);
    }
  }

  private buildWrites(
    nowMs: number,
    elapsedSecs: number,
    snapshot: SystemHealthSnapshot,
  ): SeriesWrite[] {
    const state = this.classify(nowMs, snapshot);
    const moduleSeries = snapshot.modules.map((m) => m.series);
    const allSeries: StatusSeries[] = ["uptime", ...moduleSeries];

    if (state !== "normal") {
      const sev: StatusSev = state === "crit" ? "crit" : "ok";
      const detail = state === "crit" ? "no heartbeat" : state === "paused" ? "paused" : "starting";
      return allSeries.map((series) => ({
        series,
        sev,
        downSecs: sev === "ok" ? 0 : elapsedSecs,
        critSecs: sev === "crit" ? elapsedSecs : 0,
        knownSecs: elapsedSecs,
        maintenanceSecs: state === "maintenance" ? elapsedSecs : 0,
        pausedSecs: state === "paused" ? elapsedSecs : 0,
        detail,
      }));
    }

    // Normal: real per-series severity, recomputed with the sampler's own (nowMs-
    // based) liveness so recording is deterministic and not tied to Date.now().
    const marketStale =
      snapshot.marketDataUpdatedAtMs === null
        ? null
        : nowMs - snapshot.marketDataUpdatedAtMs > this.opts.marketDataStaleThresholdMs;
    const { uptime, modules } = computeModuleSeverities({
      runtimeAlive: true,
      marketDataStale: marketStale,
      reconciliation: snapshot.reconciliation,
      breakerOpen: snapshot.breakerOpen,
      paused: false,
    });
    const normal = (series: StatusSeries, sev: StatusSev, detail: string): SeriesWrite => ({
      series,
      sev,
      downSecs: sev === "ok" ? 0 : elapsedSecs,
      critSecs: sev === "crit" ? elapsedSecs : 0,
      knownSecs: elapsedSecs,
      maintenanceSecs: 0,
      pausedSecs: 0,
      detail: sev === "ok" ? null : detail || null,
    });
    return [normal("uptime", uptime, ""), ...modules.map((m) => normal(m.series, m.s, m.detail))];
  }

  private classify(nowMs: number, snapshot: SystemHealthSnapshot): TickState {
    const hbMs = snapshot.runtimeHeartbeatAtMs;
    const mdMs = snapshot.marketDataUpdatedAtMs;
    const hbFresh = hbMs !== null && nowMs - hbMs < this.heartbeatStaleMs;
    const hbPostStart = hbMs !== null && hbMs > this.samplerStartedAtMs;
    const mdFresh = mdMs !== null && nowMs - mdMs < this.opts.marketDataStaleThresholdMs;
    const mdPostStart = mdMs !== null && mdMs > this.samplerStartedAtMs;

    // Initial latch requires FRESH POST-START evidence — a stale pre-restart row
    // cannot flip us out of warm-up.
    const ready = hbFresh && hbPostStart && mdFresh && mdPostStart;
    this.readyLatched ||= ready;
    const runtimeLive = hbFresh && (this.readyLatched || hbPostStart);
    const inWarmup = !this.readyLatched && nowMs - this.samplerStartedAtMs < this.warmupBackstopMs;

    if (!runtimeLive && !inWarmup) return "crit"; // dead runtime, even if paused flag set
    if (snapshot.paused && runtimeLive) return "paused";
    if (inWarmup && !ready) return "maintenance";
    return "normal";
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
