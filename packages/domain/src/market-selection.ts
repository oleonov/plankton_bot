import type { SelectionRuleEngine } from "./selection-rule-engine.js";
import type {
  HealthFailReason,
  HealthInput,
  HealthResult,
  NormalizedMarket,
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

// Reason codes emitted by `canPlaceBuyOrder` and the BUY-side guards in
// risk-inventory + signal-to-order. Stable strings — both runtime modules
// and dashboards key off them, so changes are breaking.
export type BuyPlacementBlockReason =
  | "market_inactive"
  | "market_not_tradable"
  | "market_ended"
  | "market_not_alive";

export interface BuyPlacementInput {
  readonly active: boolean;
  readonly tradable: boolean;
  readonly endDate: string | null;
  readonly acceptingOrders?: boolean | null;
  readonly enableOrderBook?: boolean | null;
  readonly bestBid?: number | null;
  readonly bestAsk?: number | null;
}

export interface BuyPlacementResult {
  readonly allowed: boolean;
  readonly reasons: readonly BuyPlacementBlockReason[];
}

/**
 * BUY-side admission gate: blocks NEW BUY placements (probe-entry, scale-in,
 * heavy-scale) on markets that have already ended, gone inactive, lost
 * tradability, or aren't physically capable of accepting an order. SELL and
 * REDEEM paths must NOT call this — they have their own (often inverted)
 * lifecycle requirements.
 *
 * Resolved-market blocking is handled separately by `MarketResolutionTracker`
 * because resolution arrives as an event, not a NormalizedMarket field.
 */
export function canPlaceBuyOrder(
  market: BuyPlacementInput,
  nowMs: number,
): BuyPlacementResult {
  const reasons: BuyPlacementBlockReason[] = [];
  if (market.active !== true) reasons.push("market_inactive");
  if (market.tradable !== true) reasons.push("market_not_tradable");
  if (market.endDate != null) {
    const endMs = Date.parse(market.endDate);
    if (Number.isFinite(endMs) && endMs <= nowMs) reasons.push("market_ended");
  }
  const liveness = isAlive(market);
  if (!liveness.healthy) reasons.push("market_not_alive");
  return { allowed: reasons.length === 0, reasons };
}

// Convenience overload for callers that already have a NormalizedMarket
// rather than the unstructured input shape — keeps callsites tidy.
export function canPlaceBuyOrderForMarket(
  market: NormalizedMarket,
  nowMs: number,
): BuyPlacementResult {
  return canPlaceBuyOrder(
    {
      active: market.active,
      tradable: market.tradable,
      endDate: market.endDate,
      acceptingOrders: market.acceptingOrders,
      enableOrderBook: market.enableOrderBook,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
    },
    nowMs,
  );
}
