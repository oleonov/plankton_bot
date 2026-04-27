/**
 * Scenario fixture and result types for deterministic end-to-end validation.
 */

import type { ClobMarket, MarketTradeCountProvider, PriceLevel } from "@plankton/domain";
import type Database from "better-sqlite3";

/** A single market snapshot to feed into the simulation gateway. */
export interface MarketFixture {
  market: ClobMarket;
  orderBooks: Record<string, { bids: PriceLevel[]; asks: PriceLevel[] }>;
}

/** An operator command to inject at a specific tick. */
export interface ScheduledCommand {
  atTick: number;
  action: "pause" | "resume";
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
  setup?: (ctx: {
    db: any;
    exchangeGateway: any;
    marketDataGateway: any;
    repos: any;
  }) => void | Promise<void>;
  /** Optional DB path — when provided, use instead of creating temp directory. Caller manages lifecycle. */
  dbPath?: string;
  /** Optional per-tick timing hook; called with the wall-clock duration of the tick in ms. */
  onTick?: (tick: number, durationMs: number) => void;
  /**
   * Optional wall-clock cap. When set, the tick loop exits as soon as
   * (Date.now() - loopStart) ≥ maxDurationMs, even if `ticks` iterations
   * have not completed. Use with a large `ticks` value when running a
   * duration-bounded soak.
   */
  maxDurationMs?: number;
  /**
   * Optional sleep (ms) inserted between ticks AFTER the tick body runs.
   * Enables wall-clock-paced soaks (e.g. 60s between ticks to emulate
   * production poll cadence). Default: 0 (back-to-back, burst mode).
   */
  tickDelayMs?: number;
  /**
   * ADR-016: optional control-DB handle wired into AlgoDecisionModule. When
   * provided, the module reads `continuation_mode` and the version from this
   * DB on every sweep, exactly as in production. Caller bootstraps and seeds
   * it (typical usage: in-memory DB with `control.sql` schema applied).
   */
  controlDb?: Database.Database;
  /**
   * ADR-016: optional `MarketTradeCountProvider` injected into
   * AlgoDecisionModule. Required when the scenario runs under
   * `continuation_mode = 'market_wide'`; ignored otherwise.
   */
  tradeCountProvider?: MarketTradeCountProvider;
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
