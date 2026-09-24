/**
 * Fill Poller Module — lightweight, fast-interval fill detection.
 *
 * Polls the exchange for new fills on a configurable interval (default 5s).
 * Uses a high-watermark with overlap window to avoid boundary-condition fill loss.
 * Dedup by fillId via shared importExchangeFills().
 *
 * Does NOT handle phantom orders, drift detection, or full reconciliation.
 * That remains the Reconciliation module's job (60s interval, safety net).
 */

import type {
  RuntimeModule,
  ExchangeFill,
  ExchangeGateway,
  FillRepository,
  OrderRepository,
  EventBus,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import { importExchangeFills } from "../reconciliation/fill-reconciler.js";

export interface FillPollerModuleDeps {
  gateway: ExchangeGateway;
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  bus: EventBus;
  log: Logger;
  pollIntervalMs: number;
  overlapMs: number;
  /** Relative fill-completion tolerance forwarded to importExchangeFills (#36). */
  fillCompletionTolerance?: number | undefined;
  /** Diagnostics sink for the hot-path fetch latency, otherwise invisible. */
  runtimeMetrics?:
    | { writeCounter?: (name: string, value?: number, labels?: string | null) => void }
    | undefined;
  onImportObserved?:
    | ((summary: {
        imported: number;
        skipped: number;
        deferred: number;
        timestamp: number;
      }) => void)
    | undefined;
}

export class FillPollerModule implements RuntimeModule {
  private readonly log: Logger;
  private highWatermarkMs = 0;
  private readonly deferredFillTimestamps = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private started = false;
  private pollCount = 0;

  constructor(private readonly deps: FillPollerModuleDeps) {
    this.log = deps.log.child({ module: "fill-poller" });
  }

  async start(): Promise<void> {
    // Seed watermark from latest persisted fill timestamp
    const latest = this.deps.fillRepo.getLatestTimestamp();
    this.highWatermarkMs = latest ?? Date.now();

    this.timer = setInterval(() => {
      this.poll().catch((err) => this.log.error({ err }, "fill poller error"));
    }, this.deps.pollIntervalMs);

    this.started = true;
    this.log.info(
      { pollIntervalMs: this.deps.pollIntervalMs, watermark: this.highWatermarkMs },
      "fill poller started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    this.log.info("fill poller stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) return { ok: false, detail: "not started" };
    return {
      ok: true,
      detail: `polls=${this.pollCount} watermark=${this.highWatermarkMs}`,
    };
  }

  /** Exposed for testing — in production driven by the interval timer. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const deferredSinceMs = Math.min(
        this.highWatermarkMs,
        ...this.deferredFillTimestamps.values(),
      );
      const sinceMs = Math.max(0, deferredSinceMs - this.deps.overlapMs);
      const fills = await this.fetchFills(sinceMs);

      if (fills.length > 0) {
        const result = await importExchangeFills(fills, {
          fillRepo: this.deps.fillRepo,
          orderRepo: this.deps.orderRepo,
          bus: this.deps.bus,
          log: this.log,
          gateway: this.deps.gateway,
          fillCompletionTolerance: this.deps.fillCompletionTolerance,
          deferPendingExactFills: true,
        });

        const fetchedFillIds = new Set(fills.map((fill) => fill.fillId));
        const deferredFillIds = new Set(result.deferredFillIds);
        for (const fillId of fetchedFillIds) {
          if (!deferredFillIds.has(fillId)) this.deferredFillTimestamps.delete(fillId);
        }
        for (const fill of fills) {
          if (deferredFillIds.has(fill.fillId)) {
            this.deferredFillTimestamps.set(fill.fillId, fill.timestamp);
          }
        }

        // Advance watermark to latest fill timestamp
        for (const f of fills) {
          if (f.timestamp > this.highWatermarkMs) {
            this.highWatermarkMs = f.timestamp;
          }
        }

        if (result.imported > 0 || result.deferred > 0) {
          this.log.info(
            { imported: result.imported, skipped: result.skipped, deferred: result.deferred },
            "fill poller processed fills",
          );
        }
        this.deps.onImportObserved?.({
          imported: result.imported,
          skipped: result.skipped,
          deferred: result.deferred,
          timestamp: Date.now(),
        });
      }

      this.pollCount++;
    } finally {
      this.polling = false;
    }
  }

  /** Upstream page latency dominates the real poll cadence — measure it, failures included. */
  private async fetchFills(sinceMs: number): Promise<ExchangeFill[]> {
    const startedAt = Date.now();
    try {
      return await this.deps.gateway.getFills(sinceMs);
    } finally {
      try {
        this.deps.runtimeMetrics?.writeCounter?.("fill_poller_fetch_ms", Date.now() - startedAt);
        this.deps.runtimeMetrics?.writeCounter?.("fill_poller_fetch_count", 1);
      } catch {
        /* Diagnostics must not interrupt fill import. */
      }
    }
  }
}
