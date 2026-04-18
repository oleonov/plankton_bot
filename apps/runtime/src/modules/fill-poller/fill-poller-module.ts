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
  ExchangeGateway,
  FillRepository,
  OrderRepository,
  EventBus,
} from "@plankton/domain";
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
  onImportObserved?:
    | ((summary: { imported: number; skipped: number; timestamp: number }) => void)
    | undefined;
}

export class FillPollerModule implements RuntimeModule {
  private readonly log: Logger;
  private highWatermarkMs = 0;
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
      const sinceMs = Math.max(0, this.highWatermarkMs - this.deps.overlapMs);
      const fills = await this.deps.gateway.getFills(sinceMs);

      if (fills.length > 0) {
        const result = await importExchangeFills(fills, {
          fillRepo: this.deps.fillRepo,
          orderRepo: this.deps.orderRepo,
          bus: this.deps.bus,
          log: this.log,
        });

        // Advance watermark to latest fill timestamp
        for (const f of fills) {
          if (f.timestamp > this.highWatermarkMs) {
            this.highWatermarkMs = f.timestamp;
          }
        }

        if (result.imported > 0) {
          this.log.info(
            { imported: result.imported, skipped: result.skipped },
            "fill poller imported fills",
          );
        }
        this.deps.onImportObserved?.({
          imported: result.imported,
          skipped: result.skipped,
          timestamp: Date.now(),
        });
      }

      this.pollCount++;
    } finally {
      this.polling = false;
    }
  }
}
