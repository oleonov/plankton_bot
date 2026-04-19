/**
 * Scenario fixture and result types for deterministic end-to-end validation.
 */

import type { ClobMarket, PriceLevel } from "@plankton/domain";

/** A single market snapshot to feed into the simulation gateway. */
export interface MarketFixture {
  market: ClobMarket;
  orderBooks: Record<string, { bids: PriceLevel[]; asks: PriceLevel[] }>;
}

/** An operator command to inject at a specific tick. */
export interface ScheduledCommand {
  atTick: number;
  action: "pause" | "resume" | "family_enable" | "family_disable";
  /** @deprecated use targetId */
  familyId?: string;
  targetId?: string;
  reason?: string;
}

/** Complete scenario fixture definition. */
export interface ScenarioFixture {
  name: string;
  description: string;
  marketSnapshots: MarketFixture[];
  scheduledCommands?: ScheduledCommand[];
  ticks: number;
  /** Optional setup callback, called after DB bootstrap + seeding, before modules start. */
  setup?: (ctx: { db: any; exchangeGateway: any; repos: any }) => void | Promise<void>;
  /** Optional DB path — when provided, use instead of creating temp directory. Caller manages lifecycle. */
  dbPath?: string;
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
    openValueUsdc: number;
    openPositionCount: number;
    tailAdjustedPnlLive: number;
  }>;
  totalRealizedPnl: number;
  totalTailCostUsdc: number;
  reconciliationRan: boolean;
  finalPhase: string;
  placeOrderRequestedCount: number;
  conversionSkippedCount: number;
  skippedConversions: Array<{
    stage: string;
    reasons: readonly string[];
    diagnostics: Readonly<Record<string, unknown>> | undefined;
  }>;
}
