/**
 * Normalization Module — consumes MarketSnapshotReceived events and publishes
 * NormalizedMarketUpdated.
 *
 * It must not write snapshots back into `markets`. Scanner owns catalog fields
 * such as selection_status/tradable. Re-persisting stream snapshots here
 * clobbers that catalog state and destabilizes the WS pricing tier.
 *
 * Family fields (familyId, familyKey, regime, horizon) are set to null;
 * family matching was removed in Phase 6. AlgoDecisionModule drives
 * selection via algoRules + SelectedMarketCache.
 */

import type { RuntimeModule, EventBus, NormalizedMarket } from "@plankton/domain";
import type { Logger } from "../../logger.js";

export interface NormalizationModuleDeps {
  bus: EventBus;
  log: Logger;
}

export class NormalizationModule implements RuntimeModule {
  private static readonly SUMMARY_LOG_WINDOW_MS = 30_000;
  private unsubscribe: (() => void) | null = null;
  private readonly log: Logger;
  private lastSummaryLogAtMs = 0;
  private summaryWindow = {
    batchCount: 0,
    normalizedMarkets: 0,
  };

  constructor(private readonly deps: NormalizationModuleDeps) {
    this.log = deps.log.child({ module: "normalization" });
  }

  async start(): Promise<void> {
    this.unsubscribe = this.deps.bus.subscribe("MarketSnapshotReceived", async (payload) => {
      await this.handleSnapshot(payload);
    });

    this.log.info("normalization module started");
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.log.info("normalization module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: this.unsubscribe !== null,
      detail: this.unsubscribe ? "subscribed" : "not started",
    };
  }

  private async handleSnapshot(payload: {
    readonly markets: readonly NormalizedMarket[];
    readonly timestamp: number;
  }): Promise<void> {
    const enriched: NormalizedMarket[] = [];

    for (const market of payload.markets) {
      enriched.push({
        ...market,
        outcomeIndex: market.outcomeIndex ?? null,
        regime: null,
        horizon: null,
      });
    }

    this.summaryWindow.batchCount++;
    this.summaryWindow.normalizedMarkets += enriched.length;

    this.log.debug({ total: enriched.length }, "normalization complete");
    this.logSummaryIfNeeded(payload.timestamp);

    await this.deps.bus.publish("NormalizedMarketUpdated", {
      markets: enriched,
      timestamp: Date.now(),
    });
  }

  private logSummaryIfNeeded(nowMs: number): void {
    if (this.lastSummaryLogAtMs === 0) {
      this.lastSummaryLogAtMs = nowMs;
      return;
    }
    if (nowMs - this.lastSummaryLogAtMs < NormalizationModule.SUMMARY_LOG_WINDOW_MS) {
      return;
    }
    const avgBatchSize =
      this.summaryWindow.batchCount > 0
        ? this.summaryWindow.normalizedMarkets / this.summaryWindow.batchCount
        : 0;
    this.log.info(
      {
        batches: this.summaryWindow.batchCount,
        normalizedMarkets: this.summaryWindow.normalizedMarkets,
        normalizedAvgBatchSize: Number(avgBatchSize.toFixed(2)),
        windowMs: nowMs - this.lastSummaryLogAtMs,
      },
      "normalization summary",
    );
    this.lastSummaryLogAtMs = nowMs;
    this.summaryWindow = {
      batchCount: 0,
      normalizedMarkets: 0,
    };
  }
}
