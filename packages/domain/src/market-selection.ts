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
  /**
   * ISO timestamp of market expiry. Required for the strike-pattern short-horizon
   * filter (R64); null/absent disables that filter (no horizon ⇒ don't block).
   */
  readonly endDate?: string | null;
}

export const DEFAULT_MARKET_SELECTION_POLICY: MarketSelectionPolicy = {
  maxMidPrice: 0.5,
  minLiquidity: 100,
};

export const PRE_ENTRY_MAX_MID_PRICE = DEFAULT_MARKET_SELECTION_POLICY.maxMidPrice;
export const PRE_ENTRY_MIN_LIQUIDITY = DEFAULT_MARKET_SELECTION_POLICY.minLiquidity;

// `will-be-between` is intentionally absent from this regex after R64. Plankton's
// profit on the will-be-between strike family is concentrated in horizon=1-3d
// markets that reach multi-buy ladder step >=11. Short-horizon `be-between`
// markets are filtered by `isStrikeShortHorizonMarket` instead (see CHANGE B);
// `will-be-greater-than` / `will-be-less-than` / `<coin>-above-...` stay here
// because R64 showed Plankton is net-negative on those forms.
const ZERO_COVERAGE_CATEGORY_PATTERN =
  /\bo\/u\b|over-under|exact[- ]score|both[- ]teams|match[- ]winner|quadra|penta|inhibitor|baron|dragon|\b(?:eth|btc|sol|bnb|xrp|hype|doge)-up-or-down-5m\b|\b(?:bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|hype|doge)-up-or-down-[a-z0-9-]+-(?:1[0-2]|[1-9])(?:am|pm)-et\b|\bmap[- ]?[0-9]+\b|\bgame[- ]?[0-9]+\b|total kills|\bwill-the-price-of-(?:bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|hype|doge|ada|matic|avax|link|ltc)-be-(?:greater|less)-than-\d+(?:pt\d+)?[kmbt]?-on-[a-z]+-\d+\b|\b(?:ethereum|bitcoin|solana|xrp|hype|doge|bnb|ada|matic|avax|link|ltc)-above-\d+(?:pt\d+)?[kmbt]?-on-[a-z]+-\d+(?:-\d{4}-\d{1,2}(?:am|pm)-et)?\b/i;
const SOCCER_DRAW_PATTERN =
  /\b(?:soccer|football|match|game|teams?|score|winner)\b.{0,80}\bdraw\b|\bdraw\b.{0,80}\b(?:soccer|football|match|game|teams?|score|winner)\b/i;

// Strike-market slug shape detectors. Independent of the zero-coverage regex —
// these are used by the horizon filter below and by observability counters.
// The coin allow-list is intentionally identical to the ZERO_COVERAGE_CATEGORY
// strike alternatives so the two stay symmetric.
const STRIKE_PATTERN_BETWEEN =
  /\bwill-the-price-of-(?:bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|hype|doge|ada|matic|avax|link|ltc)-be-between-\d+(?:pt\d+)?[kmbt]?-\d+(?:pt\d+)?[kmbt]?-on-[a-z]+-\d+\b/i;
const STRIKE_PATTERN_GREATER_OR_LESS_THAN =
  /\bwill-the-price-of-(?:bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|hype|doge|ada|matic|avax|link|ltc)-be-(?:greater|less)-than-\d+(?:pt\d+)?[kmbt]?-on-[a-z]+-\d+\b/i;
const STRIKE_PATTERN_ABOVE =
  /\b(?:ethereum|bitcoin|solana|xrp|hype|doge|bnb|ada|matic|avax|link|ltc)-above-\d+(?:pt\d+)?[kmbt]?-on-[a-z]+-\d+(?:-\d{4}-\d{1,2}(?:am|pm)-et)?\b/i;

export type StrikePatternKind = "between" | "greater_or_less_than" | "above";

/**
 * Minimum horizon in hours below which a strike-pattern market is rejected.
 * R64 sweet-spot: Plankton profit concentrates in horizon=1-3d. Threshold
 * intentionally conservative — do NOT lower without 7-14 days of metrics.
 */
export const STRIKE_MIN_HORIZON_HOURS = 24;

export function matchesStrikePattern(slug: string): StrikePatternKind | null {
  if (STRIKE_PATTERN_BETWEEN.test(slug)) return "between";
  if (STRIKE_PATTERN_GREATER_OR_LESS_THAN.test(slug)) return "greater_or_less_than";
  if (STRIKE_PATTERN_ABOVE.test(slug)) return "above";
  return null;
}

export interface StrikeShortHorizonResult {
  readonly blocked: boolean;
  readonly pattern: StrikePatternKind | null;
  readonly horizonHours: number | null;
}

/**
 * R64 selective filter: blocks strike-pattern markets whose remaining horizon
 * is below {@link STRIKE_MIN_HORIZON_HOURS}. Non-strike slugs short-circuit to
 * `{ blocked: false, pattern: null, horizonHours: null }`. Unknown/invalid
 * `endDate` is treated as "horizon unknown" and DOES NOT block — same fail-open
 * policy used elsewhere in the admission path.
 */
export function isStrikeShortHorizonMarket(
  market: Pick<PreEntryInput, "slug" | "endDate">,
  nowMs: number,
): StrikeShortHorizonResult {
  const pattern = matchesStrikePattern(market.slug);
  if (pattern == null) return { blocked: false, pattern: null, horizonHours: null };
  if (market.endDate == null) return { blocked: false, pattern, horizonHours: null };
  const endMs = Date.parse(market.endDate);
  if (!Number.isFinite(endMs)) {
    return { blocked: false, pattern, horizonHours: null };
  }
  const horizonHours = (endMs - nowMs) / 3_600_000;
  return { blocked: horizonHours < STRIKE_MIN_HORIZON_HOURS, pattern, horizonHours };
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isZeroCoverageCategoryMarket(
  market: Pick<PreEntryInput, "eventSlug" | "slug" | "question">,
): boolean {
  const haystack = `${market.eventSlug ?? ""} ${market.slug} ${market.question ?? ""}`;
  return ZERO_COVERAGE_CATEGORY_PATTERN.test(haystack) || SOCCER_DRAW_PATTERN.test(haystack);
}

type HardFilterFailure =
  | { ok: true }
  | { ok: false; reason: "mid_price_too_high" | "liquidity_too_low" | "zero_coverage_category" };

function checkV511HardFilters(
  market: PreEntryInput,
  policy: MarketSelectionPolicy,
): HardFilterFailure {
  if (!finiteNumber(market.midPrice) || market.midPrice >= policy.maxMidPrice) {
    return { ok: false, reason: "mid_price_too_high" };
  }
  if (!finiteNumber(market.liquidity) || market.liquidity < policy.minLiquidity) {
    return { ok: false, reason: "liquidity_too_low" };
  }
  if (isZeroCoverageCategoryMarket(market)) {
    return { ok: false, reason: "zero_coverage_category" };
  }
  return { ok: true };
}

export function evaluatePreEntry(
  engine: SelectionRuleEngine,
  market: PreEntryInput,
  policy: MarketSelectionPolicy = DEFAULT_MARKET_SELECTION_POLICY,
  nowMs: number = Date.now(),
): PreEntryEvaluation {
  const decision = engine.resolve(market.eventSlug, market.slug);

  if (decision.status === "exclude") {
    return {
      finalStatus: "EXCLUDE",
      selectionStatus: "matched_exclude",
      winningRuleId: decision.winningRuleId,
      rejectReason: "rule_exclude",
    };
  }

  // R64 selective filter: short-horizon strike markets are unprofitable
  // regardless of liquidity/mid. Run BEFORE the hard filters so metric
  // attribution lines up with the cause. An include_slug rule does NOT
  // override this — Plankton has no signal that recovers a sub-24h strike
  // entry — so `winningRuleId` is forced to null even if the engine
  // produced an `include` match. `horizonHours` is always finite here:
  // `isStrikeShortHorizonMarket` only sets `blocked=true` after parsing a
  // finite `endMs`.
  const strikeHorizon = isStrikeShortHorizonMarket(market, nowMs);
  if (
    strikeHorizon.blocked &&
    strikeHorizon.pattern != null &&
    strikeHorizon.horizonHours != null
  ) {
    return {
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
      rejectReason: "strike_short_horizon",
      strikePattern: strikeHorizon.pattern,
      horizonHours: strikeHorizon.horizonHours,
    };
  }

  const hardCheck = checkV511HardFilters(market, policy);
  if (!hardCheck.ok) {
    return {
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: decision.status === "include" ? decision.winningRuleId : null,
      rejectReason: hardCheck.reason,
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
