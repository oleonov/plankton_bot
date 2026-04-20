import type { SelectionRuleEngine } from "./selection-rule-engine.js";
import type { HealthFailReason, HealthInput, HealthResult, PreEntryEvaluation } from "./types.js";

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
    };
  }
  if (decision.status === "exclude") {
    return {
      finalStatus: "EXCLUDE",
      selectionStatus: "matched_exclude",
      winningRuleId: decision.winningRuleId,
    };
  }

  if (market.eventMarketCount === 1) {
    return {
      finalStatus: "INCLUDE",
      selectionStatus: "step2_fallback_include",
      winningRuleId: null,
    };
  }
  return {
    finalStatus: "EXCLUDE",
    selectionStatus: "fallback_exclude",
    winningRuleId: null,
  };
}

export function evaluateContinuation(legTradeCount: number, firstTradePrice: number): boolean {
  if (legTradeCount >= 6) return true;
  if (firstTradePrice >= 0.05 && legTradeCount >= 2) return true;
  return false;
}

/**
 * Binary hard-liveness gate: can this market physically accept an order right now?
 *
 * All four fields fail CLOSED on null/false — absent affirmative signal is
 * treated as not live. There is no null-tolerant case.
 *
 * Reasons are pushed in fixed hard order so persisted logs diff cleanly.
 *
 * Soft-quality checks (liquidityClob, competitive, spread thresholds) are
 * intentionally excluded — not part of 06.
 */
export function isAlive(market: HealthInput): HealthResult {
  const reasons: HealthFailReason[] = [];
  if (market.acceptingOrders !== true) reasons.push("not_accepting_orders");
  if (market.enableOrderBook !== true) reasons.push("order_book_disabled");
  if (market.bestBid == null) reasons.push("no_bid");
  return { healthy: reasons.length === 0, reasons };
}
