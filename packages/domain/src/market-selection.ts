import type { SelectionRuleEngine } from "./selection-rule-engine.js";
import { classifyMarketRegime, type StrikeClassifierInput } from "./strike-classifier.js";
import type {
  BuyGuardShortLifetimePolicy,
  HealthFailReason,
  HealthInput,
  HealthResult,
  MarketSelectionPolicy,
  NormalizedMarket,
  PreEntryEvaluation,
  PreEntryRejectReason,
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
   * ISO timestamp of market expiry. Required for the strike entry filter (D1);
   * null/absent disables it (no horizon ⇒ fail-open, don't block).
   */
  readonly endDate?: string | null;
  /**
   * Optional effective resolution timestamp. For US equity close markets this is
   * the final exchange session close, which can precede Polymarket's nominal endDate.
   */
  readonly effectiveResolutionAt?: string | null;
  readonly effectiveResolutionCalendarMissing?: boolean | null;
  /**
   * Track B strike-signal fields (spec §4). Passed through to
   * `classifyMarketRegime` for the D1 entry filter (§5). group-item is collected
   * but ignored by the classifier (F6, §3.6); `tags` is the secondary signal.
   */
  readonly groupItemTitle?: string | null;
  readonly groupItemThreshold?: string | null;
  readonly tags?: readonly string[] | null;
}

export const DEFAULT_BUY_GUARD_SHORT_LIFETIME_POLICY: BuyGuardShortLifetimePolicy = {
  enabled: false,
  thresholdHours: 1,
};

export const DEFAULT_MARKET_SELECTION_POLICY: MarketSelectionPolicy = {
  maxMidPrice: 0.5,
  minLiquidity: 100,
  shortLifetime: DEFAULT_BUY_GUARD_SHORT_LIFETIME_POLICY,
};

export const PRE_ENTRY_MAX_MID_PRICE = DEFAULT_MARKET_SELECTION_POLICY.maxMidPrice;
export const PRE_ENTRY_MIN_LIQUIDITY = DEFAULT_MARKET_SELECTION_POLICY.minLiquidity;

// `will-be-between` is intentionally absent from this regex after R64. Plankton's
// profit on the will-be-between strike family is concentrated in horizon=1-3d
// markets that reach multi-buy ladder step >=11. Short-horizon `be-between`
// markets are filtered by `evaluateStrikeEntryFilter` instead (Track B D1);
// `will-be-greater-than` / `will-be-less-than` / `<coin>-above-...` stay here
// because R64 showed Plankton is net-negative on those forms.
const ZERO_COVERAGE_CATEGORY_PATTERN =
  /\bo\/u\b|over-under|exact[- ]score|both[- ]teams|match[- ]winner|quadra|penta|inhibitor|baron|dragon|\b(?:eth|btc|sol|bnb|xrp|hype|doge)-up-or-down-5m\b|\b(?:bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|hype|doge)-up-or-down-[a-z0-9-]+-(?:1[0-2]|[1-9])(?:am|pm)-et\b|\bmap[- ]?[0-9]+\b|\bgame[- ]?[0-9]+\b|total kills|\bwill-the-price-of-(?:bitcoin|btc|ethereum|eth|solana|sol|bnb|xrp|hype|doge|ada|matic|avax|link|ltc)-be-(?:greater|less)-than-\d+(?:pt\d+)?[kmbt]?-on-[a-z]+-\d+\b|\b(?:ethereum|bitcoin|solana|xrp|hype|doge|bnb|ada|matic|avax|link|ltc)-above-\d+(?:pt\d+)?[kmbt]?-on-[a-z]+-\d+(?:-\d{4}-\d{1,2}(?:am|pm)-et)?\b/i;
const SOCCER_DRAW_PATTERN =
  /\b(?:soccer|football|match|game|teams?|score|winner)\b.{0,80}\bdraw\b|\bdraw\b.{0,80}\b(?:soccer|football|match|game|teams?|score|winner)\b/i;
const CRYPTO_UPDOWN_GUARD_PATTERN =
  /\b(?:btc|bitcoin|eth|ethereum|sol|solana|bnb|xrp|hype|doge|ada|matic|avax|link|ltc)-(?:updown|up-or-down)(?:-[a-z0-9]+)*\b/i;

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

/** D1 Yes-tail guard thresholds (spec §5.2). */
export const STRIKE_YES_TAIL_MAX_PRICE = 0.05;
export const STRIKE_YES_TAIL_MIN_RUNWAY_HOURS = 168; // 7 days
// STRIKE_MIN_HORIZON_HOURS = 24 is declared above; reused as the D1 horizon floor.

export type StrikeEntryRejectReason =
  | "strike_min_horizon"
  | "strike_yes_tail_short_runway"
  | "effective_resolution_calendar_missing";

export interface StrikeEntryFilterResult {
  readonly blocked: boolean;
  readonly reason: StrikeEntryRejectReason | null;
  readonly horizonHours: number | null;
}

/**
 * D1 strike entry filter (Track B, spec §5). Applies ONLY to strike markets:
 *   pass = (ttc >= 24h) AND (entry_price > $0.05 OR ttc >= 7d)
 * Fail-open: non-strike, or a missing/unparseable `endDate` ⇒ `blocked: false`.
 *
 * `entry_price` at admission is `midPrice` (proxy; spec §5.7 — there is no
 * separate entry_price field on `PreEntryInput`, actual `avg_entry_price` is
 * only known after the first BUY fill). If `midPrice` is null the Yes-tail guard
 * is fail-open, but the 24h horizon floor still applies.
 */
export function evaluateStrikeEntryFilter(
  market: StrikeClassifierInput &
    Pick<
      PreEntryInput,
      "endDate" | "midPrice" | "effectiveResolutionAt" | "effectiveResolutionCalendarMissing"
    >,
  nowMs: number,
): StrikeEntryFilterResult {
  if (classifyMarketRegime(market) !== "strike") {
    return { blocked: false, reason: null, horizonHours: null };
  }
  if (market.effectiveResolutionCalendarMissing === true) {
    return {
      blocked: true,
      reason: "effective_resolution_calendar_missing",
      horizonHours: null,
    };
  }
  const resolutionAt = market.effectiveResolutionAt ?? market.endDate;
  if (resolutionAt == null) return { blocked: false, reason: null, horizonHours: null };
  const endMs = Date.parse(resolutionAt);
  if (!Number.isFinite(endMs)) return { blocked: false, reason: null, horizonHours: null };

  const horizonHours = (endMs - nowMs) / 3_600_000;
  if (horizonHours < STRIKE_MIN_HORIZON_HOURS) {
    return { blocked: true, reason: "strike_min_horizon", horizonHours };
  }

  const mid = market.midPrice;
  if (
    typeof mid === "number" &&
    Number.isFinite(mid) &&
    mid <= STRIKE_YES_TAIL_MAX_PRICE &&
    horizonHours < STRIKE_YES_TAIL_MIN_RUNWAY_HOURS
  ) {
    return { blocked: true, reason: "strike_yes_tail_short_runway", horizonHours };
  }
  return { blocked: false, reason: null, horizonHours };
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

export function isCryptoUpDownGuardMarket(
  market: Pick<PreEntryInput, "eventSlug" | "slug" | "question">,
): boolean {
  const haystack = `${market.eventSlug ?? ""} ${market.slug} ${market.question ?? ""}`;
  return CRYPTO_UPDOWN_GUARD_PATTERN.test(haystack);
}

interface ShortLifetimeGuardResult {
  readonly blocked: boolean;
  readonly reason: PreEntryRejectReason | null;
  readonly horizonHours: number | null;
}

export function evaluateShortLifetimeGuard(
  market: PreEntryInput,
  policy: BuyGuardShortLifetimePolicy = DEFAULT_BUY_GUARD_SHORT_LIFETIME_POLICY,
  nowMs: number = Date.now(),
): ShortLifetimeGuardResult {
  if (!policy.enabled) return { blocked: false, reason: null, horizonHours: null };
  if (!isCryptoUpDownGuardMarket(market))
    return { blocked: false, reason: null, horizonHours: null };
  if (market.endDate == null) return { blocked: false, reason: null, horizonHours: null };
  const endMs = Date.parse(market.endDate);
  if (!Number.isFinite(endMs)) return { blocked: false, reason: null, horizonHours: null };
  const horizonHours = (endMs - nowMs) / 3_600_000;
  if (horizonHours < policy.thresholdHours) {
    return { blocked: true, reason: "buy_guard_short_lifetime", horizonHours };
  }
  return { blocked: false, reason: null, horizonHours };
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

  // D1 strike entry filter (Track B): short-horizon and cheap-short-runway
  // strike markets are unprofitable regardless of liquidity/mid. Run BEFORE the
  // hard filters so metric attribution lines up with the cause. An include_slug
  // rule does NOT override this — Plankton has no signal that recovers a blocked
  // strike entry — so `winningRuleId` is forced to null even if the engine
  // produced an `include` match. `strikePattern` is emitted only for crypto-form
  // slugs (`matchesStrikePattern`) so the existing crypto observability counters
  // keep working; non-crypto strike rejects carry `strikePattern: undefined`.
  const strikeFilter = evaluateStrikeEntryFilter(market, nowMs);
  if (strikeFilter.blocked) {
    const strikePattern = matchesStrikePattern(market.slug);
    return {
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: null,
      rejectReason: strikeFilter.reason!,
      ...(strikePattern != null ? { strikePattern } : {}),
      ...(strikeFilter.horizonHours != null ? { horizonHours: strikeFilter.horizonHours } : {}),
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

  const shortLifetime = evaluateShortLifetimeGuard(
    market,
    policy.shortLifetime ?? DEFAULT_BUY_GUARD_SHORT_LIFETIME_POLICY,
    nowMs,
  );
  if (shortLifetime.blocked) {
    return {
      finalStatus: "EXCLUDE",
      selectionStatus: "fallback_exclude",
      winningRuleId: decision.status === "include" ? decision.winningRuleId : null,
      rejectReason: shortLifetime.reason!,
      ...(shortLifetime.horizonHours != null ? { horizonHours: shortLifetime.horizonHours } : {}),
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
 * GATE-lane liveness override (docs/plans/2026-07-17-gate-isalive-plankton-whitelist.md).
 * Opt-in on `isAlive` / `canPlaceBuyOrder` / `canPlaceBuyOrderForMarket`; threaded from
 * the GATE-whitelist flat-first-entry runtime paths only. Absent = strict default.
 */
export interface GateLivenessOpts {
  readonly gateWhitelistOverride?: boolean;
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
export function isAlive(market: HealthInput, opts?: GateLivenessOpts): HealthResult {
  const reasons: HealthFailReason[] = [];
  if (market.acceptingOrders !== true) reasons.push("not_accepting_orders");
  if (market.enableOrderBook !== true) reasons.push("order_book_disabled");
  if (market.bestBid == null) reasons.push("no_bid");
  // GATE-whitelist liveness override (docs/plans/2026-07-17-gate-isalive-plankton-
  // whitelist.md): thin-book GATE markets carry stale `acceptingOrders`/`enableOrderBook`
  // = false in the runtime even when the CLOB reports them live. When a live `bestBid`
  // is present, drop ONLY those two metadata reasons for the GATE lane — `no_bid` is
  // NEVER dropped (an empty/one-sided book still blocks), and the exchange remains the
  // real accepting-orders gate. Default (no opts) = unchanged behaviour.
  if (opts?.gateWhitelistOverride === true && market.bestBid != null) {
    const filtered = reasons.filter(
      (r) => r !== "not_accepting_orders" && r !== "order_book_disabled",
    );
    return { healthy: filtered.length === 0, reasons: filtered };
  }
  return { healthy: reasons.length === 0, reasons };
}

// Reason codes emitted by `canPlaceBuyOrder` and the BUY-side guards in
// risk-inventory + signal-to-order. Stable strings — both runtime modules
// and dashboards key off them, so changes are breaking.
export type BuyPlacementBlockReason =
  | "market_inactive"
  | "market_not_tradable"
  | "market_ended"
  | "market_not_alive"
  | "effective_resolution_calendar_missing"
  | "effective_resolution_short_runway";

export interface BuyPlacementInput {
  readonly active: boolean;
  readonly tradable: boolean;
  readonly endDate: string | null;
  readonly acceptingOrders?: boolean | null;
  readonly enableOrderBook?: boolean | null;
  readonly bestBid?: number | null;
  readonly bestAsk?: number | null;
  readonly effectiveResolutionAt?: string | null;
  readonly effectiveResolutionCalendarMissing?: boolean | null;
  readonly effectiveResolutionAppliesToBuy?: boolean | null;
  readonly effectiveResolutionMinRunwayHours?: number | null;
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
  opts?: GateLivenessOpts,
): BuyPlacementResult {
  const reasons: BuyPlacementBlockReason[] = [];
  if (market.active !== true) reasons.push("market_inactive");
  if (market.tradable !== true) reasons.push("market_not_tradable");
  const lifecycleEndDate = market.effectiveResolutionAt ?? market.endDate;
  if (lifecycleEndDate != null) {
    const endMs = Date.parse(lifecycleEndDate);
    if (Number.isFinite(endMs) && endMs <= nowMs) reasons.push("market_ended");
  }
  if (market.effectiveResolutionCalendarMissing === true) {
    reasons.push("effective_resolution_calendar_missing");
  } else if (
    market.effectiveResolutionAppliesToBuy === true &&
    market.effectiveResolutionAt != null &&
    typeof market.effectiveResolutionMinRunwayHours === "number"
  ) {
    const endMs = Date.parse(market.effectiveResolutionAt);
    const minRunwayMs = market.effectiveResolutionMinRunwayHours * 3_600_000;
    if (Number.isFinite(endMs) && endMs - nowMs < minRunwayMs) {
      reasons.push("effective_resolution_short_runway");
    }
  }
  const liveness = isAlive(market, opts);
  if (!liveness.healthy) reasons.push("market_not_alive");
  return { allowed: reasons.length === 0, reasons };
}

// Convenience overload for callers that already have a NormalizedMarket
// rather than the unstructured input shape — keeps callsites tidy.
export function canPlaceBuyOrderForMarket(
  market: NormalizedMarket,
  nowMs: number,
  effectiveResolution?: {
    effectiveResolutionAt?: string | null;
    calendarMissing?: boolean | null;
    appliesToBuy?: boolean | null;
    minRunwayHours?: number | null;
  },
  opts?: GateLivenessOpts,
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
      effectiveResolutionAt: effectiveResolution?.effectiveResolutionAt ?? null,
      effectiveResolutionCalendarMissing: effectiveResolution?.calendarMissing ?? false,
      effectiveResolutionAppliesToBuy: effectiveResolution?.appliesToBuy ?? false,
      effectiveResolutionMinRunwayHours: effectiveResolution?.minRunwayHours ?? null,
    },
    nowMs,
    opts,
  );
}
