/**
 * Scenario fixture and result types for deterministic end-to-end validation.
 */

import type { ClobMarket, PriceLevel } from "@plankton/domain";

/** A single market snapshot to feed into the simulation gateway. */
export interface MarketFixture {
  market: ClobMarket;
  orderBooks: Record<string, { bids: PriceLevel[]; asks: PriceLevel[] }>;
}

/** Pre-seeded family state override (applied before scenario starts). */
export interface FamilyStateOverride {
  familyId: string;
  runtimeMode?: string;
  quarantineReason?: string | null;
}

/** An operator command to inject at a specific tick. */
export interface ScheduledCommand {
  atTick: number;
  action: "pause" | "resume" | "family_reduce_only" | "family_quarantine" | "family_activate";
  familyId?: string;
  reason?: string;
}

/** Complete scenario fixture definition. */
export interface ScenarioFixture {
  name: string;
  description: string;
  marketSnapshots: MarketFixture[];
  familyStateOverrides?: FamilyStateOverride[];
  scheduledCommands?: ScheduledCommand[];
  ticks: number;
}

/** Aggregated results collected after a scenario run. */
export interface ScenarioResult {
  signalCount: number;
  approvedCount: number;
  rejectedCount: number;
  placedOrderCount: number;
  cancelledOrderCount: number;
  fillCount: number;
  openPositionCount: number;
  dustPositionCount: number;
  familyStates: Array<{
    familyId: string;
    runtimeMode: string;
    openValueUsdc: number;
    openPositionCount: number;
    tailAdjustedPnlLive: number;
  }>;
  totalRealizedPnl: number;
  totalTailCostUsdc: number;
  reconciliationRan: boolean;
  finalPhase: string;
}
