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
    return { finalStatus: "INCLUDE", selectionStatus: "step2_fallback_include", winningRuleId: null };
  }
  return { finalStatus: "EXCLUDE", selectionStatus: "fallback_exclude", winningRuleId: null };
}

/**
 * Post-Entry Continuation Filter — should the bot keep scaling into this leg?
 * Returns true for CONTINUE, false for STOP.
 */
export function evaluateContinuation(tradeCount: number, firstTradePrice: number): boolean {
  if (tradeCount >= 6) return true;
  if (firstTradePrice >= 0.05 && tradeCount >= 2) return true;
  return false;
}
