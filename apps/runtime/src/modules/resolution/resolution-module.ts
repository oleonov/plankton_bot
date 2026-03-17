/**
 * ResolutionModule — detects resolved markets and settles positions.
 *
 * Polling loop:
 *  1. Find open/dust positions on markets past endDate + grace period
 *  2. Confirm resolution via Gamma API
 *  3. Close positions, record settlement PnL
 *  4. Recompute family state (direct call, not event-triggered)
 *  5. Publish MarketResolved + PositionSettled events
 */

import type {
  EventBus,
  RuntimeModule,
  MarketRepository,
  MarketResolutionRepository,
  FamilyRulesProvider,
  FamilyId,
} from "@plankton/domain";
import type { FamilyExposureCalculator } from "../risk-inventory/family-exposure.js";
import type { ResolutionDetector } from "./resolution-detector.js";
import type { PositionSettler } from "./position-settler.js";
import type { Logger } from "../../logger.js";

export interface ResolutionModuleDeps {
  detector: ResolutionDetector;
  settler: PositionSettler;
  marketRepo: MarketRepository;
  resolutionRepo: MarketResolutionRepository;
  rulesProvider: FamilyRulesProvider;
  exposureCalculator: FamilyExposureCalculator;
  bus: EventBus;
  log: Logger;
  checkIntervalMs: number;
  graceMinutes: number;
}

export class ResolutionModule implements RuntimeModule {
  private intervalHandle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: ResolutionModuleDeps) {}

  async start(): Promise<void> {
    // Run once at startup (non-blocking)
    this.runCheck().catch((err) =>
      this.deps.log.error(err, "startup resolution check failed"),
    );

    this.intervalHandle = setInterval(() => {
      this.runCheck().catch((err) =>
        this.deps.log.error(err, "resolution check failed"),
      );
    }, this.deps.checkIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Exposed for testing. */
  async runCheck(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const resolutions = await this.deps.detector.detect(this.deps.graceMinutes);
      let totalSettled = 0;

      for (const resolution of resolutions) {
        // Persist resolution record
        this.deps.resolutionRepo.save({
          conditionId: resolution.conditionId,
          resolution: resolution.resolution,
          resolvedAt: resolution.resolvedAt,
          detectedAt: new Date().toISOString(),
          source: resolution.source,
          rawResponse: resolution.rawResponse,
        });

        // Mark markets as inactive
        for (const candidate of resolution.candidates) {
          this.deps.marketRepo.deactivate(candidate.tokenId);
        }

        // Do not auto-settle when resolution is unknown — we don't know the
        // winner, so settling would treat every position as a total loss.
        // Record + deactivate (above), but skip position closure.
        if (resolution.resolution === "unknown") {
          this.deps.log.warn(
            { conditionId: resolution.conditionId, source: resolution.source },
            "resolution is unknown — skipping auto-settlement (requires manual review)",
          );
          totalSettled += 0;

          await this.deps.bus.publish("MarketResolved", {
            conditionId: resolution.conditionId,
            tokenIds: resolution.candidates.map((c) => c.tokenId),
            resolution: resolution.resolution,
            resolvedAt: resolution.resolvedAt,
            source: resolution.source,
            timestamp: Date.now(),
          });
          continue;
        }

        // Filter candidates to only families with autoSettleResolvedMarkets enabled
        const settleable = {
          ...resolution,
          candidates: resolution.candidates.filter((c) => {
            const bundle = this.deps.rulesProvider.getRule(c.familyId);
            if (!bundle) return true; // unknown family → settle by default
            return bundle.rules.tailSuppression.autoSettleResolvedMarkets;
          }),
        };

        if (settleable.candidates.length < resolution.candidates.length) {
          this.deps.log.info(
            { conditionId: resolution.conditionId,
              skipped: resolution.candidates.length - settleable.candidates.length },
            "skipped settlement for families with autoSettleResolvedMarkets=false",
          );
        }

        // Settle positions
        const settled = settleable.candidates.length > 0
          ? this.deps.settler.settle(settleable)
          : [];
        totalSettled += settled.length;

        // Publish events (EventBus.publish is async — must await)
        await this.deps.bus.publish("MarketResolved", {
          conditionId: resolution.conditionId,
          tokenIds: resolution.candidates.map((c) => c.tokenId),
          resolution: resolution.resolution,
          resolvedAt: resolution.resolvedAt,
          source: resolution.source,
          timestamp: Date.now(),
        });

        for (const s of settled) {
          await this.deps.bus.publish("PositionSettled", s);
        }

        this.deps.log.info(
          {
            conditionId: resolution.conditionId,
            resolution: resolution.resolution,
            settledCount: settled.length,
          },
          `resolved market — settled ${settled.length} positions`,
        );
      }

      // Recompute family state for affected families.
      // FamilyExposureChanged is an OUTPUT event — not a trigger.
      // We call the calculator directly.
      const affectedFamilies = new Set<FamilyId>(
        resolutions.flatMap((r) => r.candidates.map((c) => c.familyId)),
      );
      for (const familyId of affectedFamilies) {
        const updated = this.deps.exposureCalculator.recompute(familyId, false);
        await this.deps.bus.publish("FamilyExposureChanged", {
          familyId,
          totalExposureUsdc: updated.openValueUsdc,
          openPositionCount: updated.openPositionCount,
          familyState: updated,
          timestamp: Date.now(),
        });
      }

      return totalSettled;
    } finally {
      this.running = false;
    }
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: true,
      detail: `interval=${this.deps.checkIntervalMs}ms grace=${this.deps.graceMinutes}min`,
    };
  }
}
