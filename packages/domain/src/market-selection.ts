import type { SelectionRuleEngine } from "./selection-rule-engine.js";
import type {
  HealthFailReason,
  HealthInput,
  HealthResult,
  HealthThresholds,
  PreEntryEvaluation,
} from "./types.js";

export interface PreEntryInput {
  readonly eventSlug: string | null;
  readonly slug: string;
  readonly eventMarketCount: number;
}

export function evaluatePreEntry(
  engine: SelectionRuleEngine,
  market: PreEntryInput,
): PreEntryEvaluation {
  const decision = engine.resolve(market.eventSlug, market.slug);

  if (decision.status === "include") {
    return {
      finalStatus: "INCLUDE",
      selectionStatus: "matched_include",
      winningRuleId: decision.winningRuleId,
      healthStatus: "unknown",
      healthReasons: [],
    };
  }
  if (decision.status === "exclude") {
    return {
      finalStatus: "EXCLUDE",
      selectionStatus: "matched_exclude",
      winningRuleId: decision.winningRuleId,
      healthStatus: "unknown",
      healthReasons: [],
    };
  }

  if (market.eventMarketCount === 1) {
    return {
      finalStatus: "INCLUDE",
      selectionStatus: "step2_fallback_include",
      winningRuleId: null,
      healthStatus: "unknown",
      healthReasons: [],
    };
  }
  return {
    finalStatus: "EXCLUDE",
    selectionStatus: "fallback_exclude",
    winningRuleId: null,
    healthStatus: "unknown",
    healthReasons: [],
  };
}

/**
 * Post-Entry Continuation Filter — should the bot keep scaling into this leg?
 *
 * Leg-local semantics (ADR D1 — docs/superpowers/specs/2026-04-18-algo-spec-freeze-adr.md):
 *  - legTradeCount = our own fills on this leg (buyCount + sellCount)
 *  - firstEntryFillPrice = price of the first BUY fill that opened this leg
 *
 * NOT Gamma market-wide activity. Returns true for CONTINUE, false for STOP.
 */
export function evaluateContinuation(legTradeCount: number, firstEntryFillPrice: number): boolean {
  if (legTradeCount >= 6) return true;
  if (firstEntryFillPrice >= 0.05 && legTradeCount >= 2) return true;
  return false;
}

/**
 * Market-health gate for the admission pipeline.
 *
 * Null-tolerance is deliberately asymmetric:
 *   - Hard fields (acceptingOrders, enableOrderBook, bestBid, bestAsk) fail
 *     CLOSED on null — an absent affirmative signal is treated as "not alive".
 *   - Numeric thresholds (liquidityClob, competitive, spread) fail OPEN on
 *     null — absence is common on new or non-CLOB markets and we don't
 *     want to reject them for that reason alone.
 *
 * Returns reasons in a fixed order (hard → soft) so persisted
 * `health_fail_reasons` diffs cleanly across scans.
 *
 * Volume is deliberately NOT consulted here: new CLOB markets can be alive
 * with zero volume. Volume-based gating, if ever needed, belongs in a
 * separate "proven market" filter, not in isAlive.
 *
 * See docs/superpowers/specs/2026-04-18-market-health-gate-design.md §5.
 */
export function isAlive(market: HealthInput, thresholds: HealthThresholds): HealthResult {
  const reasons: HealthFailReason[] = [];

  if (market.acceptingOrders !== true) reasons.push("not_accepting_orders");
  if (market.enableOrderBook !== true) reasons.push("order_book_disabled");
  if (market.bestBid == null) reasons.push("no_bid");
  if (market.bestAsk == null) reasons.push("no_ask");

  // Numeric null-tolerance: `!= null` short-circuits when absent.
  if (market.liquidityClob != null && market.liquidityClob < thresholds.minLiquidityClob) {
    reasons.push("low_liquidity_clob");
  }
  if (market.competitive != null && market.competitive < thresholds.minCompetitive) {
    reasons.push("low_competitive");
  }
  if (market.spread != null && market.spread > thresholds.maxSpread) {
    reasons.push("wide_spread");
  }

  return { healthy: reasons.length === 0, reasons };
}
