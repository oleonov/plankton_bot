/**
 * Family Exposure — recomputes and persists FamilyState after
 * position/inventory changes.
 *
 * Computes from persisted positions and lots:
 *  - openValueUsdc: sum of open position cost bases
 *  - openPositionCount: count of open positions
 *  - openDustCount: count of dust positions
 *  - currentTailCostUsdc: sum of open inventory lot costs
 *  - tailAdjustedPnlLive: total realizedPnl - currentTailCostUsdc
 *  - lastEntryTs / lastExitTs
 *
 * Does NOT publish events — the parent module handles that.
 */

import type {
  FamilyStateRepository,
  PositionRepository,
  InventoryLotRepository,
  FamilyRulesProvider,
  FamilyState,
  FamilyId,
} from "@plankton/domain";
import type { Logger } from "../../logger.js";

export class FamilyExposureCalculator {
  constructor(
    private readonly familyStateRepo: FamilyStateRepository,
    private readonly positionRepo: PositionRepository,
    private readonly lotRepo: InventoryLotRepository,
    private readonly log: Logger,
    private readonly rulesProvider?: FamilyRulesProvider,
  ) {}

  /**
   * Recompute family state from current positions and lots.
   * Returns the updated FamilyState (already persisted).
   */
  recompute(familyId: FamilyId, isBuy: boolean): FamilyState {
    const existing = this.familyStateRepo.get(familyId);
    if (!existing) {
      this.log.warn({ familyId }, "no family state to recompute — skipping");
      // Return baseline state
      return {
        familyId,
        runtimeMode: "active",
        openValueUsdc: 0,
        openPositionCount: 0,
        openDustCount: 0,
        activeMarketCount: 0,
        currentTailCostUsdc: 0,
        tailAdjustedPnlLive: 0,
        lastEntryTs: null,
        lastExitTs: null,
        quarantineReason: null,
        effectiveMode: null,
        derivedModeReason: null,
        firstNegativeTailAt: null,
        updatedAt: new Date().toISOString(),
      };
    }

    const positions = this.positionRepo.findByFamily(familyId);
    const now = new Date().toISOString();

    // Count open and dust positions
    let openPositionCount = 0;
    let openDustCount = 0;
    let openValueUsdc = 0;
    let totalRealizedPnl = 0;
    const activeTokens = new Set<string>();

    for (const pos of positions) {
      totalRealizedPnl += pos.realizedPnl;

      if (pos.status === "open") {
        openPositionCount++;
        openValueUsdc += pos.costBasisUsdc;
        activeTokens.add(String(pos.tokenId));
      } else if (pos.status === "dust") {
        openDustCount++;
        openValueUsdc += pos.costBasisUsdc;
        activeTokens.add(String(pos.tokenId));
      }
    }

    // Compute tail cost from open inventory lots
    let currentTailCostUsdc = 0;
    for (const pos of positions) {
      if (pos.status === "closed") continue;
      const lots = this.lotRepo.findOpen(pos.positionId);
      for (const lot of lots) {
        currentTailCostUsdc += lot.remainingSize * lot.entryPrice;
      }
    }

    const tailAdjustedPnlLive = totalRealizedPnl - currentTailCostUsdc;

    // Compute signal-independent effective mode from current tail health
    let effectiveMode: string | null = existing.effectiveMode ?? null;
    let derivedModeReason: string | null = existing.derivedModeReason ?? null;

    if (this.rulesProvider) {
      const bundle = this.rulesProvider.getRule(familyId);
      if (bundle) {
        const ts = bundle.rules.tailSuppression;

        if (currentTailCostUsdc > ts.tailQuarantineThresholdUsdc) {
          effectiveMode = "reduce-only";
          derivedModeReason = `tail cost $${currentTailCostUsdc.toFixed(2)} > cap $${ts.tailQuarantineThresholdUsdc}`;
        } else if (
          totalRealizedPnl > 0 &&
          currentTailCostUsdc / totalRealizedPnl > ts.tailQuarantineThresholdRatio
        ) {
          effectiveMode = "reduce-only";
          derivedModeReason = `tail/pnl ratio ${(currentTailCostUsdc / totalRealizedPnl).toFixed(2)} > ${ts.tailQuarantineThresholdRatio}`;
        } else if (tailAdjustedPnlLive < 0) {
          effectiveMode = "probe-only";
          derivedModeReason = `tailAdjustedPnl $${tailAdjustedPnlLive.toFixed(2)} < 0`;
        } else {
          effectiveMode = "active";
          derivedModeReason = null;
        }
      }
    }

    const updated: FamilyState = {
      ...existing,
      openValueUsdc,
      openPositionCount,
      openDustCount,
      activeMarketCount: activeTokens.size,
      currentTailCostUsdc,
      tailAdjustedPnlLive,
      effectiveMode,
      derivedModeReason,
      lastEntryTs: isBuy ? now : existing.lastEntryTs,
      lastExitTs: !isBuy ? now : existing.lastExitTs,
      updatedAt: now,
    };

    this.familyStateRepo.save(updated);

    this.log.debug(
      {
        familyId,
        openValueUsdc: openValueUsdc.toFixed(2),
        openPositionCount,
        openDustCount,
        tailCost: currentTailCostUsdc.toFixed(2),
        tailPnl: tailAdjustedPnlLive.toFixed(2),
      },
      "family exposure recomputed",
    );

    return updated;
  }
}
