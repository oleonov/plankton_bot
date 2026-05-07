import type { SelectionRuleEngine } from "./selection-rule-engine.js";
import type {
  HealthFailReason,
  HealthInput,
  HealthResult,
  MarketSelectionPolicy,
  NormalizedMarket,
  PreEntryEvaluation,
} from "./types.js";

export interface PreEntryInput {
  readonly eventSlug: string | null;
  readonly slug: string;
  /** Retained for telemetry/ranking; v5.11 hard admission no longer uses fallback by count. */
  readonly eventMarketCount: number;
  readonly question?: string | null;
  readonly midPrice?: number | null;
  readonly liquidity?: number | null;
}

export const DEFAULT_MARKET_SELECTION_POLICY: MarketSelectionPolicy = {
  maxMidPrice: 0.5,
  minLiquidity: 100,
};

export const PRE_ENTRY_MAX_MID_PRICE = DEFAULT_MARKET_SELECTION_POLICY.maxMidPrice;
export const PRE_ENTRY_MIN_LIQUIDITY = DEFAULT_MARKET_SELECTION_POLICY.minLiquidity;

const ZERO_COVERAGE_CATEGORY_PATTERN =
  /\bo\/u\b|over-under|exact[- ]score|both[- ]teams|match[- ]winner|quadra|penta|inhibitor|baron|dragon|\b(?:eth|btc|sol|bnb|xrp|hype|doge)-up-or-down-5m\b|\bmap[- ]?[0-9]+\b|\bgame[- ]?[0-9]+\b|total kills/i;
const SOCCER_DRAW_PATTERN =
  /\b(?:soccer|football|match|game|teams?|score|winner)\b.{0,80}\bdraw\b|\bdraw\b.{0,80}\b(?:soccer|football|match|game|teams?|score|winner)\b/i;

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isZeroCoverageCategoryMarket(
  market: Pick<PreEntryInput, "eventSlug" | "slug" | "question">,
): boolean {
  const haystack = `${market.eventSlug ?? ""} ${market.slug} ${market.question ?? ""}`;
  return ZERO_COVERAGE_CATEGORY_PATTERN.test(haystack) || SOCCER_DRAW_PATTERN.test(haystack);
}

function passesV511HardFilters(market: PreEntryInput, policy: MarketSelectionPolicy): boolean {
  if (!finiteNumber(market.midPrice) || market.midPrice >= policy.maxMidPrice) return false;
  if (!finiteNumber(market.liquidity) || market.liquidity < policy.minLiquidity) return false;
  if (isZeroCoverageCategoryMarket(market)) return false;
  return true;
}

export function evaluatePreEntry(
  engine: SelectionRuleEngine,
  market: PreEntryInput,
  policy: MarketSelectionPolicy = DEFAULT_MARKET_SELECTION_POLICY,
): PreEntryEvaluation {
  const decision = engine.resolve(market.eventSlug, market.slug);

  if (decision.status === "exclude") {
    return {
      finalStatus: "EXCLUDE",
      selectionStatus: "matched_exclude",
      winningRuleId: decision.winningRuleId,
    };
  }

  if (!passesV511HardFilters(market, policy)) {
    return {
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: decision.status === "include" ? decision.winningRuleId : null,
    };
  }

  return {
    finalStatus: "INCLUDE",
    selectionStatus: "matched_include",
    winningRuleId: decision.status === "include" ? decision.winningRuleId : null,
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
export function canPlaceBuyOrder(market: BuyPlacementInput, nowMs: number): BuyPlacementResult {
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
