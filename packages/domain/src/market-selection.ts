import type { SelectionRuleEngine } from "./selection-rule-engine.js";
import type { PreEntryEvaluation } from "./types.js";

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
