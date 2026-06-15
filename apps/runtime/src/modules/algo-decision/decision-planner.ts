import type {
  AlgoDecisionRule,
  AlgoSizeRule,
  DecisionSignalLog,
  ExecutionPolicy,
  LegState,
  NormalizedMarket,
  Position,
  S1OwnershipSnapshot,
  SellLoopGuardSnapshot,
  SellOrderSizingContext,
  TokenId,
  TradeDecisionAction,
} from "@krabs/domain";
import {
  deriveState,
  evaluateContinuation,
  evaluateD8ProfitRatio,
  evaluateD9LossExit,
  evaluateDecision,
  evaluateMinMarketAge,
  evaluateR23DipTrigger,
  evaluateSize,
  computeSellSizingPlan,
  H5_WIDE_COHORT_GUARD_REASON,
  isAbandoned,
  isAlive,
  matchRule,
  R23_DIP_TRIGGER_RULE_ID,
  R23_NO_DIP_REASON,
  R23_NO_HISTORY_REASON,
  resolveSignalReason,
  shouldRecoverFromPriceMove,
} from "@krabs/domain";
import {
  classifyAddAgeBucket,
  classifyAddPriceChangeBucket,
  classifyExitPnlBucket,
  classifyHoldingTimeBucket,
  classifyNotionalBucket,
  classifySoldBoughtRatioBucket,
  floorToTick,
  planktonAlignedMarkupCap,
  resolveBidAnchoredSellPrice,
  resolveSellCeiling,
  roundToTick,
  SELL_PRICE_CEILING,
} from "../../executable-price.js";
import { SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON } from "../../internal-order-reasons.js";
import { isExecutableOrderSize } from "../../min-order-size.js";
import {
  evaluateQdPreResolutionExit,
  type QdShadowProjection,
  type QdShadowReason,
} from "./qd-pre-resolution-exit.js";

export type { QdShadowProjection, QdShadowReason } from "./qd-pre-resolution-exit.js";

export type TradeCountSource = "market_wide" | "leg_local_fallback" | "leg_local";

export type EntryPriceBucket = "<=0.005" | "0.005-0.05" | "0.05-0.20" | ">0.20";
export type ProfileOwnedLegacyGuard = "d4" | "d8";

export type EmissionFacts = {
  firstTradePrice: number | null;
  firstTradeAt: string | null;
  legTradeCount: number;
  sellCountAtEmit?: number | null;
  cumulativeBuySize?: number | null;
  cumulativeBuyNotional?: number | null;
  cumulativeSellSize?: number | null;
  currentAvgEntryPrice?: number | null;
  continuationStop?: boolean | null;
  continuationTradeCount?: number | null;
  continuationTradeCountSource?: TradeCountSource | null;
  d8ProfitRatio?: number | null;
  d8Threshold?: number | null;
  d8AvgBuyPrice?: number | null;
  d9ProfitRatio?: number | null;
  d9AvgBuyPrice?: number | null;
  d9DaysToResolve?: number | null;
  d9PublicTradeCount24h?: number | null;
  r23DipRatio?: number | null;
  r23MaxMidpoint?: number | null;
  r23WindowMs?: number | null;
};

export type TriggerTelemetry = {
  dropFromLastSeen: number | null;
  entryPriceBucket: EntryPriceBucket;
  dropTriggerStatus: "bypass_probe" | "passed" | "rejected" | "no_drop_data" | "disabled";
  dropTriggerPct: number | null;
};

export type ContinuationFacts = {
  tradeCount: number;
  tradeCountSource: TradeCountSource;
  stop: boolean;
};

export type SuppressionPlan = {
  tokenId: TokenId;
  conditionId: string | null;
  reasonCode: string;
  reasons?: readonly string[];
  side?: "BUY" | "SELL" | "REDEEM" | null;
  decisionRuleId?: string | null;
  state: DecisionSignalLog["state"];
  price: number | null;
  buyCount: number;
  timeSinceLastSeconds: number | null;
  emissionFacts: EmissionFacts;
  timestamp: string;
  tradeCount?: number | null;
  tradeCountSource?: TradeCountSource | null;
  extra?: Record<string, unknown>;
};

export type DecisionPlanSideEffect =
  | {
      kind: "dust_recovered";
      tokenId: TokenId;
      conditionId: string;
      currentPrice: number;
      abandonedAtPrice: number | null;
      timestamp: string;
    }
  | {
      kind: "sell_residual_reject";
      tokenId: TokenId;
      conditionId: string;
      price: number;
      threshold: number;
      timestamp: string;
    }
  | {
      kind: "track_q_shadow";
      tokenId: TokenId;
      conditionId: string;
      timestamp: string;
      evalPrice: number;
      projection: TrackQShadowProjection;
    }
  | {
      kind: "track_q_d";
      tokenId: TokenId;
      conditionId: string;
      timestamp: string;
      projection: QdShadowProjection;
    }
  | {
      kind: "sell_loop_guard_suppressed";
      tokenId: TokenId;
      conditionId: string;
      decisionRuleId: string | null;
      activeCount: number;
      threshold: number;
      timestamp: string;
    }
  | {
      kind: "s1_ownership_blocked_sell";
      tokenId: TokenId;
      conditionId: string;
      decisionRuleId: string | null;
      ladderId: string;
      ownershipReason: S1OwnershipSnapshot["reason"];
      timestamp: string;
    }
  | {
      kind: "d9_suppressed_on_profile_owned";
      tokenId: TokenId;
      conditionId: string | null;
      decisionRuleId: "D9_LOSS_EXIT";
      price: number | null;
      state: DecisionSignalLog["state"];
      emissionFacts: EmissionFacts;
      d9Reason: string | null;
      timestamp: string;
    }
  | {
      kind: "legacy_guard_fired_on_profile_owned";
      guard: ProfileOwnedLegacyGuard;
      tokenId: TokenId;
      conditionId: string | null;
      decisionRuleId: string;
      proposedPrice: number | null;
      avgEntryPrice: number | null;
      state: DecisionSignalLog["state"];
      emissionFacts: EmissionFacts;
      timestamp: string;
    };

export type TrackQShadowReason =
  | "book_not_wide"
  | "avg_entry_unavailable"
  | "cheap_tail_excluded"
  | "f1_already_above_tier"
  | "tier_capped_at_inside_ask"
  | "tier_floor_applied";

/**
 * Track Q shadow projection — observe-only. Records what the unproven P3
 * tier-anchored SELL floor WOULD place on wide books, including books that the
 * classified live spread guard suppresses as below-entry or missing avg-entry,
 * without changing any production price, D8/D9 behavior, or the spread threshold. See
 * research_plankton/track_q_shadow_design_2026-06-11.md.
 */
export type TrackQShadowProjection = {
  p3WouldActivate: boolean;
  reason: TrackQShadowReason;
  spreadMidRatio: number | null;
  bidAskRatio: number | null;
  bidAnchoredPrice: number;
  tierMarkup: number | null;
  tierTarget: number | null;
  insideAsk: number | null;
  p3CandidatePrice: number;
  avgEntry: number | null;
  currentGuardWouldSuppress: boolean;
  proposedGuardWouldSuppress: boolean;
  d8FireAtCurrentPrice: boolean;
  d8FireAtP3Candidate: boolean;
  d8FireWouldChange: boolean;
};

export type DecisionMetricsDelta = {
  evalTotal: number;
  suppressedMarketNotLive: number;
  dropTriggerChecked: number;
  dropTriggerPassed: number;
  r23DipChecked: number;
  r23DipFired: number;
  r23NoHistory: number;
  r23NoDip: number;
  rejectNoDropSignal: number;
  allowNoDropData: number;
  livenessNotAcceptingOrders: number;
  livenessOrderBookDisabled: number;
  livenessBothFlags: number;
  wouldMatchRule: Record<string, number>;
};

export type DecisionSignalDraft = {
  market: NormalizedMarket;
  side: "buy" | "sell";
  suggestedPrice: number;
  suggestedSize: number;
  suggestedSizeUsdc: number;
  reason: ReturnType<typeof resolveSignalReason>;
  decisionRuleId: string;
  sizingRuleId: string;
  logDraft: Omit<DecisionSignalLog, "signalId" | "tokenId" | "conditionId" | "signalTimestamp">;
  emissionFacts: EmissionFacts;
  triggerTelemetry: TriggerTelemetry;
};

export type DecisionPlanResult =
  | {
      type: "none";
      metrics: DecisionMetricsDelta;
      suppressions: SuppressionPlan[];
      sideEffects: DecisionPlanSideEffect[];
    }
  | {
      type: "signal";
      metrics: DecisionMetricsDelta;
      suppressions: SuppressionPlan[];
      sideEffects: DecisionPlanSideEffect[];
      signal: DecisionSignalDraft;
    };

export type DecisionPlanningInput = {
  tokenId: TokenId;
  now: number;
  selectedForEntry: boolean;
  hasPendingBuyOrder: boolean;
  legState: LegState | null;
  position: Position | null;
  market: NormalizedMarket | null;
  prevMidPrice: number | null;
  decisionRules: readonly AlgoDecisionRule[];
  buySizeRules: readonly AlgoSizeRule[];
  sellSizeRules: readonly AlgoSizeRule[];
  executionPolicy: ExecutionPolicy | null;
  continuationFacts: ContinuationFacts | null;
  continuationMode: TradeCountSource | "market_wide";
  r23MaxMidpoint: number | null;
  dropReferencePrice: number | null;
  postBuyCooldown: { cooldownMs: number; ageMs: number; lastBuyFillAt: number } | null;
  latestSellOrder: SellOrderSizingContext | null;
  hasActiveSellOrderForQd: boolean;
  sellLoopGuard: SellLoopGuardSnapshot | null;
  s1Ownership?: S1OwnershipSnapshot | null;
  profileLadderOwned?: boolean;
};

const SELL_ONLY: ReadonlySet<TradeDecisionAction> = new Set(["SELL"]);
const D6_SUPPRESSED_REASON = "d6-suppressed";
const DECISION_RULE_HOLD_REASON = "decision-rule-hold";
const DUST_ABANDONED_REASON = "dust-abandoned";
const D8_PROFIT_RATIO_RULE_ID = "D8_PROFIT_RATIO";
// Sub-Track Q.A: D8's profit-take trigger is decoupled from the executable sell
// price (it now reads midPrice). This guard mirrors the D9 below-entry guard so
// the decouple never *places* a SELL at an executable bid below avg entry.
export const D8_PROFIT_BELOW_AVG_ENTRY_GUARD_REASON = "d8_profit_below_avg_entry_guard";
export const D9_LOSS_EXIT_BELOW_AVG_ENTRY_GUARD_REASON = "d9_loss_exit_below_avg_entry_guard";
export const D9_LOSS_EXIT_AVG_ENTRY_UNAVAILABLE_BYPASS_REASON =
  "d9_loss_exit_avg_entry_unavailable_guard_bypass";
const POST_BUY_FILL_COOLDOWN_REASON = "post-buy-fill-cooldown";
// Track Q loop guard: token-level SELL circuit breaker. When the guard reports a
// blocked token (>= threshold no-op SELL outcomes in the rolling window) the
// planner suppresses SELL signal generation for the cooldown. See
// research_plankton/loop_guard_spec_2026-06-11.md §4.5.
export const SELL_LOOP_GUARD_REASON = "sell_loop_guard";
const SELL_SPREAD_MAX_RATIO = 0.5;
// Track Q shadow: the design-intent threshold (bid/ask < 0.10 ⟺ spread/mid > 1.636).
// Telemetry-only — the live guard above still uses SELL_SPREAD_MAX_RATIO.
const PROPOSED_SELL_SPREAD_MAX_RATIO = 1.636;
const TRACK_Q_CHEAP_TAIL_MAX_ENTRY = 0.02;
const TRACK_Q_PRICE_EPSILON = 1e-9;
const DEFAULT_EXIT_BID_ANCHOR_TICKS = 4;

type SellExecutablePriceResult = {
  price: number | null;
  reasonCode:
    | "mid-price-unavailable"
    | "sell-best-bid-unavailable"
    | "sell-spread-too-wide-below-avg-entry"
    | "sell-spread-too-wide-avg-entry-unavailable"
    | null;
};

type SellExecutablePriceContext = {
  avgEntryPrice?: number | null;
};

export function createDecisionMetricsDelta(): DecisionMetricsDelta {
  return {
    evalTotal: 0,
    suppressedMarketNotLive: 0,
    dropTriggerChecked: 0,
    dropTriggerPassed: 0,
    r23DipChecked: 0,
    r23DipFired: 0,
    r23NoHistory: 0,
    r23NoDip: 0,
    rejectNoDropSignal: 0,
    allowNoDropData: 0,
    livenessNotAcceptingOrders: 0,
    livenessOrderBookDisabled: 0,
    livenessBothFlags: 0,
    wouldMatchRule: {},
  };
}

export function classifyEntryPriceBucket(price: number): EntryPriceBucket {
  if (price <= 0.005) return "<=0.005";
  if (price <= 0.05) return "0.005-0.05";
  if (price <= 0.2) return "0.05-0.20";
  return ">0.20";
}

function computeMarketSpread(market: NormalizedMarket): number | null {
  if (typeof market.spread === "number" && Number.isFinite(market.spread)) return market.spread;
  const { bestBid, bestAsk } = market;
  if (
    typeof bestBid === "number" &&
    Number.isFinite(bestBid) &&
    typeof bestAsk === "number" &&
    Number.isFinite(bestAsk) &&
    bestAsk > bestBid
  ) {
    return bestAsk - bestBid;
  }
  return null;
}

export function resolveSellExecutablePrice(
  market: NormalizedMarket,
  context: SellExecutablePriceContext = {},
): SellExecutablePriceResult {
  const bestBid = finitePositiveOrNull(market.bestBid);
  if (bestBid === null) {
    return { price: null, reasonCode: "sell-best-bid-unavailable" };
  }

  const spread = computeMarketSpread(market);
  const midpoint =
    typeof market.midPrice === "number" && Number.isFinite(market.midPrice)
      ? market.midPrice
      : null;

  if (
    spread !== null &&
    midpoint !== null &&
    midpoint > 0 &&
    spread / midpoint > SELL_SPREAD_MAX_RATIO
  ) {
    const avgEntryPrice = finitePositiveOrNull(context.avgEntryPrice);
    if (avgEntryPrice !== null && bestBid >= avgEntryPrice) {
      return { price: bestBid, reasonCode: null };
    }
    return {
      price: null,
      reasonCode:
        avgEntryPrice === null
          ? "sell-spread-too-wide-avg-entry-unavailable"
          : "sell-spread-too-wide-below-avg-entry",
    };
  }

  return { price: bestBid, reasonCode: null };
}

function resolveActionPrice(
  action: TradeDecisionAction,
  market: NormalizedMarket,
  context: SellExecutablePriceContext = {},
): SellExecutablePriceResult {
  if (action === "SELL") return resolveSellExecutablePrice(market, context);
  const price = market.midPrice;
  return typeof price === "number" && Number.isFinite(price)
    ? { price, reasonCode: null }
    : { price: null, reasonCode: "mid-price-unavailable" };
}

type TrackQBook = {
  tickSize: number;
  spreadMidRatio: number | null;
  bidAskRatio: number | null;
  currentGuardWouldSuppress: boolean;
  proposedGuardWouldSuppress: boolean;
  insideAsk: number | null;
  bidAnchoredPrice: number;
};

function resolveTrackQBook(market: NormalizedMarket, anchorTicks: number): TrackQBook | null {
  const bestBid = finitePositiveOrNull(market.bestBid);
  const tickSize = finitePositiveOrNull(market.tickSize);
  if (bestBid === null || tickSize === null) return null;

  const bestAsk =
    typeof market.bestAsk === "number" && Number.isFinite(market.bestAsk) && market.bestAsk > 0
      ? market.bestAsk
      : null;
  const spread = computeMarketSpread(market);
  const midPrice = finitePositiveOrNull(market.midPrice);
  const spreadMidRatio = spread !== null && midPrice !== null ? spread / midPrice : null;
  const ceiling = floorToTick(SELL_PRICE_CEILING, tickSize);
  const bidAnchoredPrice = Math.min(
    resolveBidAnchoredSellPrice(bestBid, bestAsk, tickSize, anchorTicks),
    ceiling,
  );
  return {
    tickSize,
    spreadMidRatio,
    bidAskRatio: bestAsk !== null ? bestBid / bestAsk : null,
    currentGuardWouldSuppress: spreadMidRatio !== null && spreadMidRatio > SELL_SPREAD_MAX_RATIO,
    proposedGuardWouldSuppress:
      spreadMidRatio !== null && spreadMidRatio > PROPOSED_SELL_SPREAD_MAX_RATIO,
    insideAsk: resolveSellCeiling(bestBid, bestAsk, tickSize),
    bidAnchoredPrice,
  };
}

function decideTrackQActivation(
  book: TrackQBook,
  avgEntry: number | null,
  tierTarget: number | null,
): { activate: boolean; reason: TrackQShadowReason; p3CandidatePrice: number } {
  const f1 = book.bidAnchoredPrice;
  if (!book.currentGuardWouldSuppress)
    return { activate: false, reason: "book_not_wide", p3CandidatePrice: f1 };
  if (avgEntry === null || tierTarget === null)
    return { activate: false, reason: "avg_entry_unavailable", p3CandidatePrice: f1 };
  if (avgEntry < TRACK_Q_CHEAP_TAIL_MAX_ENTRY)
    return { activate: false, reason: "cheap_tail_excluded", p3CandidatePrice: f1 };

  const targetCapped = book.insideAsk !== null ? Math.min(tierTarget, book.insideAsk) : tierTarget;
  const p3 = roundToTick(Math.max(f1, targetCapped), book.tickSize);
  if (p3 <= f1 + TRACK_Q_PRICE_EPSILON)
    return { activate: false, reason: "f1_already_above_tier", p3CandidatePrice: f1 };

  const reason: TrackQShadowReason =
    book.insideAsk !== null && tierTarget > book.insideAsk
      ? "tier_capped_at_inside_ask"
      : "tier_floor_applied";
  return { activate: true, reason, p3CandidatePrice: p3 };
}

function projectTrackQD8(
  legState: LegState,
  executionPolicy: ExecutionPolicy | null,
  now: number,
  evalPrice: number,
): { atCurrent: boolean; atP3: boolean } {
  const profitTarget = executionPolicy?.profitTarget;
  if (!profitTarget) return { atCurrent: false, atP3: false };
  const base = {
    state: deriveState(legState),
    sellCount: legState.sellCount ?? 0,
    cumulativeBuySize: legState.cumulativeBuySize ?? 0,
    cumulativeBuyNotional: legState.cumulativeBuyNotional ?? 0,
    holdDurationSeconds: (now - new Date(legState.firstTradeAt).getTime()) / 1000,
  };
  // Sub-Track Q.A: the D8 trigger is decoupled from the P3 candidate price.
  // Both branches evaluate at the live eval price, so `d8FireWouldChange` is 0
  // by construction — the shadow no longer reports a divergence that the live
  // path (which has always used midPrice on wide books) would never produce.
  const fire = evaluateD8ProfitRatio({ ...base, currentPrice: evalPrice }, profitTarget).fire;
  return { atCurrent: fire, atP3: fire };
}

/**
 * Pure Track Q shadow projection (observe-only). Never throws — any unexpected
 * input collapses to `null` so the live SELL path is never affected (risk R5).
 * The caller decides whether to emit a side effect (wide books only).
 */
export function projectTrackQShadow(args: {
  market: NormalizedMarket;
  legState: LegState;
  position: Position | null;
  executionPolicy: ExecutionPolicy | null;
  evalPrice: number;
  now: number;
}): TrackQShadowProjection | null {
  try {
    const anchorTicks = args.executionPolicy?.exitBidAnchorTicks ?? DEFAULT_EXIT_BID_ANCHOR_TICKS;
    const book = resolveTrackQBook(args.market, anchorTicks);
    if (book === null) return null;

    const avgEntry = finitePositiveOrNull(args.position?.avgEntryPrice);
    const tierMarkup = avgEntry !== null ? planktonAlignedMarkupCap(avgEntry) : null;
    const tierTarget =
      avgEntry !== null ? Math.min(avgEntry * tierMarkup!, SELL_PRICE_CEILING) : null;

    const decision = decideTrackQActivation(book, avgEntry, tierTarget);
    const d8 = projectTrackQD8(args.legState, args.executionPolicy, args.now, args.evalPrice);

    return {
      p3WouldActivate: decision.activate,
      reason: decision.reason,
      spreadMidRatio: book.spreadMidRatio,
      bidAskRatio: book.bidAskRatio,
      bidAnchoredPrice: book.bidAnchoredPrice,
      tierMarkup,
      tierTarget,
      insideAsk: book.insideAsk,
      p3CandidatePrice: decision.p3CandidatePrice,
      avgEntry,
      currentGuardWouldSuppress: book.currentGuardWouldSuppress,
      proposedGuardWouldSuppress: book.proposedGuardWouldSuppress,
      d8FireAtCurrentPrice: d8.atCurrent,
      d8FireAtP3Candidate: d8.atP3,
      d8FireWouldChange: d8.atCurrent !== d8.atP3,
    };
  } catch {
    return null;
  }
}

/**
 * Emit a Track Q shadow side effect for SELL-eligible legs on wide books only
 * (the spread-threshold population that can be suppressed before the
 * execution-layer EPO shard can observe it). Observe-only: pushes a side effect
 * and never alters price, suppressions, or the signal.
 */
function recordTrackQShadow(
  input: DecisionPlanningInput,
  market: NormalizedMarket,
  evalPrice: number,
  nowIso: string,
  sideEffects: DecisionPlanSideEffect[],
): void {
  if (!input.legState) return;
  const projection = projectTrackQShadow({
    market,
    legState: input.legState,
    position: input.position,
    executionPolicy: input.executionPolicy,
    evalPrice,
    now: input.now,
  });
  if (projection === null || !projection.currentGuardWouldSuppress) return;
  sideEffects.push({
    kind: "track_q_shadow",
    tokenId: input.tokenId,
    conditionId: market.conditionId,
    timestamp: nowIso,
    evalPrice,
    projection,
  });
}

// Sub-Track Q.D shadow: only legs that clear the structural pre-filters (cheap
// tier + inside the TTC window) are the population of interest. Pre-cohort
// reasons are dropped so the deduped telemetry stays scoped to near-resolution
// cheap longshots rather than every leg on every cycle.
const QD_PRE_COHORT_REASONS: ReadonlySet<QdShadowReason> = new Set([
  "disabled",
  "no_position",
  "wrong_tier",
  "ttc_unavailable",
  "ttc_too_far",
]);

export function isWorkingSellOrderStatus(
  status: SellOrderSizingContext["status"] | null | undefined,
): boolean {
  return status !== "filled" && status !== "rejected" && status !== "cancelled";
}

/**
 * Emit a Q.D pre-resolution-exit shadow side effect (observe-only) for cheap
 * longshots inside the TTC window — the cohort that can still be held when the
 * classified spread guard blocks below-entry exits or no qualifying sell is
 * working. Mirrors `recordTrackQShadow`: pushes a side effect and never alters
 * price, suppressions, D8/D9, or the signal. `d8EvalPrice`
 * (midPrice, per Sub-Track Q.A) and `d9EvalPrice` (executable bid) match the
 * live D8/D9 trigger prices so the shadow reports the real D8/D9 → Q.D
 * precedence (T4). See research_plankton/track_q_d_spec_2026-06-12.md.
 */
function recordQdShadow(
  input: DecisionPlanningInput,
  market: NormalizedMarket,
  d8EvalPrice: number,
  d9EvalPrice: number,
  nowIso: string,
  sideEffects: DecisionPlanSideEffect[],
): void {
  if (!input.legState) return;
  const projection = evaluateQdPreResolutionExit({
    market,
    legState: input.legState,
    position: input.position,
    executionPolicy: input.executionPolicy,
    now: input.now,
    d8EvalPrice,
    d9EvalPrice,
    hasActiveSell: input.hasActiveSellOrderForQd,
  });
  if (projection === null || QD_PRE_COHORT_REASONS.has(projection.reason)) return;
  sideEffects.push({
    kind: "track_q_d",
    tokenId: input.tokenId,
    conditionId: market.conditionId,
    timestamp: nowIso,
    projection,
  });
}

export function evaluateDecisionPlan(input: DecisionPlanningInput): DecisionPlanResult {
  const metrics = createDecisionMetricsDelta();
  const suppressions: SuppressionPlan[] = [];
  const sideEffects: DecisionPlanSideEffect[] = [];
  const nowIso = new Date(input.now).toISOString();
  const legState = input.legState;

  if (!legState && !input.selectedForEntry && !input.position) {
    return none(metrics, suppressions, sideEffects);
  }
  metrics.evalTotal++;

  const state = deriveState(legState);
  const buyCount = legState?.buyCount ?? 0;
  const emissionFacts = createEmissionFacts(legState, input.position);
  const timeSinceLastSeconds = legState
    ? (input.now - new Date(legState.lastTradeAt).getTime()) / 1000
    : null;

  if (!input.market) {
    suppressions.push({
      tokenId: input.tokenId,
      conditionId: null,
      reasonCode: "market-cache-miss",
      state,
      price: null,
      buyCount,
      timeSinceLastSeconds,
      emissionFacts,
      timestamp: nowIso,
    });
    return none(metrics, suppressions, sideEffects);
  }

  const market = input.market;
  const midPrice = market.midPrice;
  if (midPrice === null || midPrice === undefined) {
    suppressions.push({
      tokenId: input.tokenId,
      conditionId: market.conditionId,
      reasonCode: "mid-price-unavailable",
      state,
      price: null,
      buyCount,
      timeSinceLastSeconds,
      emissionFacts,
      timestamp: nowIso,
    });
    return none(metrics, suppressions, sideEffects);
  }
  const sellPriceContext = { avgEntryPrice: input.position?.avgEntryPrice ?? null };
  const sellPrice = resolveSellExecutablePrice(market, sellPriceContext);
  const price = legState ? (sellPrice.price ?? midPrice) : midPrice;
  // Sub-Track Q.F: on wide non-loss books, sellPrice.price is bestBid instead
  // of the prior midPrice fallback; D9, dust recovery, telemetry, and pricing
  // intentionally see that executable bid-aligned price.
  // Sub-Track Q.A: the D8 profit-take *trigger* reads midPrice directly,
  // decoupled from the executable sell price (`price`, which still feeds D9,
  // dust recovery, telemetry, and pricing). `midPrice` is a guaranteed-present
  // number here (the null/undefined short-circuit above), though not >0 — a 0
  // mid is inert for D8 (ratio 0 < threshold).
  const d8EvalPrice = midPrice;
  recordTrackQShadow(input, market, price, nowIso, sideEffects);
  recordQdShadow(input, market, d8EvalPrice, price, nowIso, sideEffects);

  if (legState && isAbandoned(legState) && input.executionPolicy?.dustAbandonment.enabled) {
    const dustPolicy = input.executionPolicy.dustAbandonment;
    if (shouldRecoverFromPriceMove(legState, price, dustPolicy)) {
      sideEffects.push({
        kind: "dust_recovered",
        tokenId: input.tokenId,
        conditionId: market.conditionId,
        currentPrice: price,
        abandonedAtPrice: legState.abandonedAtPrice ?? null,
        timestamp: nowIso,
      });
    } else {
      suppressions.push({
        tokenId: input.tokenId,
        conditionId: market.conditionId,
        reasonCode: DUST_ABANDONED_REASON,
        side: null,
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: nowIso,
      });
      return none(metrics, suppressions, sideEffects);
    }
  }

  const triggerTelemetry = createTriggerTelemetry(price, input.prevMidPrice);

  if (!legState && input.hasPendingBuyOrder) {
    suppressions.push({
      tokenId: input.tokenId,
      conditionId: market.conditionId,
      reasonCode: "pending-buy-order",
      side: "BUY",
      state,
      price,
      buyCount,
      timeSinceLastSeconds,
      emissionFacts,
      timestamp: nowIso,
    });
    return none(metrics, suppressions, sideEffects);
  }

  const holdDurationSeconds = legState
    ? (input.now - new Date(legState.firstTradeAt).getTime()) / 1000
    : null;
  const ctx = { state, price, timeSinceLastSeconds, buyCount, holdDurationSeconds };
  const liveness = isAlive(market);
  if (!liveness.healthy) {
    recordLivenessMetric(metrics, liveness.reasons, ctx, input.decisionRules);
    suppressions.push({
      tokenId: input.tokenId,
      conditionId: market.conditionId,
      reasonCode: "market-not-live",
      reasons: liveness.reasons,
      state,
      price,
      buyCount,
      timeSinceLastSeconds,
      emissionFacts,
      timestamp: nowIso,
    });
    return none(metrics, suppressions, sideEffects);
  }

  if (!legState && input.executionPolicy) {
    const ageResult = evaluateMinMarketAge({
      gammaCreatedAt: market.gammaCreatedAt ?? null,
      thresholdSeconds: input.executionPolicy.entryMinMarketAgeSeconds,
      nowMs: input.now,
    });
    if (!ageResult.ok) {
      suppressions.push({
        tokenId: input.tokenId,
        conditionId: market.conditionId,
        reasonCode: ageResult.reasonCode,
        side: "BUY",
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: nowIso,
      });
      return none(metrics, suppressions, sideEffects);
    }
  }

  if (legState && input.executionPolicy) {
    const d8 = evaluateD8ProfitRatio(
      {
        state,
        sellCount: legState.sellCount ?? 0,
        currentPrice: d8EvalPrice,
        cumulativeBuySize: legState.cumulativeBuySize ?? 0,
        cumulativeBuyNotional: legState.cumulativeBuyNotional ?? 0,
        holdDurationSeconds,
      },
      input.executionPolicy.profitTarget,
    );
    if (d8.fire) {
      const d8EmissionFacts: EmissionFacts = {
        ...emissionFacts,
        d8ProfitRatio: d8.profitRatio,
        d8Threshold: d8.threshold,
        d8AvgBuyPrice: d8.avgBuyPrice,
      };
      // Sub-Track Q.A below-entry guard (mirrors the D9 guard below): D8 may
      // fire on the decoupled mid, but never place a SELL at an executable bid
      // that sits below avg entry. Wide books without a profitable executable
      // bid, or without avg entry, are suppressed downstream with classified
      // spread reason codes.
      const d8AvgEntryPrice = finitePositiveOrNull(input.position?.avgEntryPrice ?? null);
      if (sellPrice.price != null && d8AvgEntryPrice != null && sellPrice.price < d8AvgEntryPrice) {
        pushLegacyGuardFiredOnProfileOwned({
          input,
          market,
          decisionRuleId: D8_PROFIT_RATIO_RULE_ID,
          proposedPrice: sellPrice.price,
          avgEntryPrice: d8AvgEntryPrice,
          state,
          emissionFacts: d8EmissionFacts,
          sideEffects,
          timestamp: nowIso,
        });
        suppressions.push({
          tokenId: market.tokenId,
          conditionId: market.conditionId,
          reasonCode: D8_PROFIT_BELOW_AVG_ENTRY_GUARD_REASON,
          side: "SELL",
          decisionRuleId: D8_PROFIT_RATIO_RULE_ID,
          state,
          price: sellPrice.price,
          buyCount,
          timeSinceLastSeconds,
          emissionFacts: d8EmissionFacts,
          timestamp: nowIso,
          extra: {
            avgEntryPrice: d8AvgEntryPrice,
            proposedExitPrice: sellPrice.price,
            exitToAvgEntryRatio: sellPrice.price / d8AvgEntryPrice,
            d8EvalPrice,
            suppressionReason: D8_PROFIT_BELOW_AVG_ENTRY_GUARD_REASON,
          },
        });
        return none(metrics, suppressions, sideEffects);
      }
      return buildSignalOrSuppression({
        input,
        market,
        decision: { action: "SELL", ruleId: D8_PROFIT_RATIO_RULE_ID },
        buyCount,
        emissionFacts: d8EmissionFacts,
        triggerTelemetry,
        suppressions,
        sideEffects,
        metrics,
        nowIso,
      });
    }
  }

  if (legState && input.executionPolicy?.lossExit?.enabled) {
    const d9DaysToResolve = resolveDaysToResolve(market.endDate, input.now);
    const d9 = evaluateD9LossExit(
      {
        state,
        currentPrice: price,
        cumulativeBuySize: legState.cumulativeBuySize ?? 0,
        cumulativeBuyNotional: legState.cumulativeBuyNotional ?? 0,
        publicTradeCount24h: market.publicTradeCount24h ?? null,
        daysToResolve: d9DaysToResolve,
      },
      input.executionPolicy.lossExit,
    );
    const d9EmissionFacts: EmissionFacts = {
      ...emissionFacts,
      d9ProfitRatio: d9.profitRatio,
      d9AvgBuyPrice: d9.avgBuyPrice,
      d9DaysToResolve: d9.daysToResolve,
      d9PublicTradeCount24h: d9.publicTradeCount24h,
    };
    if (d9.reason === H5_WIDE_COHORT_GUARD_REASON) {
      suppressions.push({
        tokenId: market.tokenId,
        conditionId: market.conditionId,
        reasonCode: H5_WIDE_COHORT_GUARD_REASON,
        side: "SELL",
        decisionRuleId: "D9_LOSS_EXIT",
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts: d9EmissionFacts,
        timestamp: nowIso,
      });
    }
    if (d9.fire) {
      if (input.profileLadderOwned) {
        sideEffects.push({
          kind: "d9_suppressed_on_profile_owned",
          tokenId: market.tokenId,
          conditionId: market.conditionId,
          decisionRuleId: "D9_LOSS_EXIT",
          price: sellPrice.price,
          state,
          emissionFacts: d9EmissionFacts,
          d9Reason: d9.reason,
          timestamp: nowIso,
        });
        return none(metrics, suppressions, sideEffects);
      }
      const positionAvgEntryPrice = finitePositiveOrNull(input.position?.avgEntryPrice ?? null);
      if (sellPrice.price != null && positionAvgEntryPrice == null) {
        suppressions.push({
          tokenId: market.tokenId,
          conditionId: market.conditionId,
          reasonCode: D9_LOSS_EXIT_AVG_ENTRY_UNAVAILABLE_BYPASS_REASON,
          side: "SELL",
          decisionRuleId: "D9_LOSS_EXIT",
          state,
          price: sellPrice.price,
          buyCount,
          timeSinceLastSeconds,
          emissionFacts: d9EmissionFacts,
          timestamp: nowIso,
          extra: {
            proposedExitPrice: sellPrice.price,
            originalD9Reason: d9.reason,
            suppressionReason: D9_LOSS_EXIT_AVG_ENTRY_UNAVAILABLE_BYPASS_REASON,
            guardMode: "fail_open",
            avgEntrySource: input.position == null ? "missing_position" : "invalid_avg_entry",
          },
        });
      }
      if (sellPrice.price != null && positionAvgEntryPrice != null) {
        const exitToAvgEntryRatio = sellPrice.price / positionAvgEntryPrice;
        if (sellPrice.price < positionAvgEntryPrice) {
          suppressions.push({
            tokenId: market.tokenId,
            conditionId: market.conditionId,
            reasonCode: D9_LOSS_EXIT_BELOW_AVG_ENTRY_GUARD_REASON,
            side: "SELL",
            decisionRuleId: "D9_LOSS_EXIT",
            state,
            price: sellPrice.price,
            buyCount,
            timeSinceLastSeconds,
            emissionFacts: d9EmissionFacts,
            timestamp: nowIso,
            extra: {
              avgEntryPrice: positionAvgEntryPrice,
              proposedExitPrice: sellPrice.price,
              exitToAvgEntryRatio,
              originalD9Reason: d9.reason,
              suppressionReason: D9_LOSS_EXIT_BELOW_AVG_ENTRY_GUARD_REASON,
              d9ProfitRatio: d9.profitRatio,
              d9AvgBuyPrice: d9.avgBuyPrice,
              d9PublicTradeCount24h: d9.publicTradeCount24h,
              d9DaysToResolve: d9.daysToResolve,
            },
          });
          return none(metrics, suppressions, sideEffects);
        }
      }
      return buildSignalOrSuppression({
        input,
        market,
        decision: { action: "SELL", ruleId: "D9_LOSS_EXIT" },
        buyCount,
        emissionFacts: d9EmissionFacts,
        triggerTelemetry,
        suppressions,
        sideEffects,
        metrics,
        nowIso,
      });
    }
  }

  const preservedOnly = legState !== null && !market.tradable;
  if (legState) {
    const continuationFacts =
      input.continuationFacts ??
      ({
        tradeCount: emissionFacts.legTradeCount,
        tradeCountSource: "leg_local",
        stop: !evaluateContinuation(emissionFacts.legTradeCount, legState.firstTradePrice),
      } satisfies ContinuationFacts);
    if (continuationFacts.stop) {
      const sellMatch = matchRule(ctx, input.decisionRules, SELL_ONLY);
      if (sellMatch) {
        return buildSignalOrSuppression({
          input,
          market,
          decision: sellMatch,
          buyCount,
          emissionFacts: {
            ...emissionFacts,
            continuationStop: true,
            continuationTradeCount: continuationFacts.tradeCount,
            continuationTradeCountSource: continuationFacts.tradeCountSource,
          },
          triggerTelemetry,
          suppressions,
          sideEffects,
          metrics,
          nowIso,
        });
      }
      suppressions.push({
        tokenId: input.tokenId,
        conditionId: market.conditionId,
        reasonCode: "continuation-stop",
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: nowIso,
        tradeCount: continuationFacts.tradeCount,
        tradeCountSource: continuationFacts.tradeCountSource,
      });
      return none(metrics, suppressions, sideEffects);
    }
    if (preservedOnly) {
      const sellMatch = matchRule(ctx, input.decisionRules, SELL_ONLY);
      if (!sellMatch) {
        suppressions.push({
          tokenId: input.tokenId,
          conditionId: market.conditionId,
          reasonCode: "preserved-only-no-sell-rule",
          side: "SELL",
          state,
          price,
          buyCount,
          timeSinceLastSeconds,
          emissionFacts,
          timestamp: nowIso,
          tradeCount: continuationFacts.tradeCount,
          tradeCountSource: continuationFacts.tradeCountSource,
        });
        return none(metrics, suppressions, sideEffects);
      }
      return buildSignalOrSuppression({
        input,
        market,
        decision: sellMatch,
        buyCount,
        emissionFacts,
        triggerTelemetry,
        suppressions,
        sideEffects,
        metrics,
        nowIso,
      });
    }
  }

  if (!legState && input.executionPolicy?.r23DipTrigger?.enabled) {
    const r23Policy = input.executionPolicy.r23DipTrigger;
    metrics.r23DipChecked++;
    const r23 = evaluateR23DipTrigger(
      {
        state,
        currentMidpoint: price,
        maxMidpointInWindow: input.r23MaxMidpoint,
      },
      r23Policy,
    );
    const r23EmissionFacts: EmissionFacts = {
      ...emissionFacts,
      r23DipRatio: r23.ratio,
      r23MaxMidpoint: r23.maxMidpoint,
      r23WindowMs: r23Policy.windowMs,
    };
    if (r23.reason === R23_NO_HISTORY_REASON) metrics.r23NoHistory++;
    if (r23.reason === R23_NO_DIP_REASON) metrics.r23NoDip++;
    if (r23.fire) {
      metrics.r23DipFired++;
      return buildSignalOrSuppression({
        input,
        market,
        decision: { action: "BUY", ruleId: R23_DIP_TRIGGER_RULE_ID },
        buyCount,
        emissionFacts: r23EmissionFacts,
        triggerTelemetry,
        suppressions,
        sideEffects,
        metrics,
        nowIso,
      });
    }
    suppressions.push({
      tokenId: input.tokenId,
      conditionId: market.conditionId,
      reasonCode: r23.reason,
      side: "BUY",
      decisionRuleId: R23_DIP_TRIGGER_RULE_ID,
      state,
      price,
      buyCount,
      timeSinceLastSeconds,
      emissionFacts: r23EmissionFacts,
      timestamp: nowIso,
    });
  }

  const decision = evaluateDecision(ctx, input.decisionRules);
  if (decision.action === "HOLD") {
    suppressions.push({
      tokenId: input.tokenId,
      conditionId: market.conditionId,
      reasonCode: decision.ruleId === "D6" ? D6_SUPPRESSED_REASON : DECISION_RULE_HOLD_REASON,
      side: decision.ruleId === "D6" ? "BUY" : null,
      decisionRuleId: decision.ruleId,
      state,
      price,
      buyCount,
      timeSinceLastSeconds,
      emissionFacts,
      timestamp: nowIso,
      tradeCount: input.continuationFacts?.tradeCount ?? null,
      tradeCountSource: input.continuationFacts?.tradeCountSource ?? null,
    });
    return none(metrics, suppressions, sideEffects);
  }

  return buildSignalOrSuppression({
    input,
    market,
    decision: decision as { action: TradeDecisionAction; ruleId: string },
    buyCount,
    emissionFacts,
    triggerTelemetry,
    suppressions,
    sideEffects,
    metrics,
    nowIso,
  });
}

function none(
  metrics: DecisionMetricsDelta,
  suppressions: SuppressionPlan[],
  sideEffects: DecisionPlanSideEffect[],
): DecisionPlanResult {
  return { type: "none", metrics, suppressions, sideEffects };
}

function buildSignalOrSuppression(args: {
  input: DecisionPlanningInput;
  market: NormalizedMarket;
  decision: { action: TradeDecisionAction; ruleId: string };
  buyCount: number;
  emissionFacts: EmissionFacts;
  triggerTelemetry: TriggerTelemetry;
  suppressions: SuppressionPlan[];
  sideEffects: DecisionPlanSideEffect[];
  metrics: DecisionMetricsDelta;
  nowIso: string;
}): DecisionPlanResult {
  const { input, market, decision, buyCount, emissionFacts, triggerTelemetry } = args;
  const state = deriveState(input.legState);
  const timeSinceLastSeconds = input.legState
    ? (input.now - new Date(input.legState.lastTradeAt).getTime()) / 1000
    : null;
  const actionPrice = resolveActionPrice(decision.action, market, {
    avgEntryPrice: input.position?.avgEntryPrice ?? null,
  });
  if (actionPrice.price == null) {
    args.suppressions.push({
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      reasonCode: actionPrice.reasonCode ?? "signal-price-unavailable",
      side: decision.action === "SELL" ? "SELL" : "BUY",
      decisionRuleId: decision.ruleId,
      state,
      price: null,
      buyCount,
      timeSinceLastSeconds,
      emissionFacts,
      timestamp: args.nowIso,
    });
    return none(args.metrics, args.suppressions, args.sideEffects);
  }
  const price = actionPrice.price;
  const ctx = {
    state,
    price,
    timeSinceLastSeconds,
    buyCount,
    holdDurationSeconds: input.legState
      ? (input.now - new Date(input.legState.firstTradeAt).getTime()) / 1000
      : null,
  };

  pushLegacyGuardFiredOnProfileOwned({
    input,
    market,
    decisionRuleId: decision.ruleId,
    proposedPrice: price,
    avgEntryPrice: finitePositiveOrNull(input.position?.avgEntryPrice ?? null),
    state: ctx.state,
    emissionFacts,
    sideEffects: args.sideEffects,
    timestamp: args.nowIso,
  });

  if (decision.action === "SELL" && input.s1Ownership?.owned) {
    const ownership = input.s1Ownership;
    args.sideEffects.push({
      kind: "s1_ownership_blocked_sell",
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      decisionRuleId: decision.ruleId,
      ladderId: ownership.ladderId,
      ownershipReason: ownership.reason,
      timestamp: args.nowIso,
    });
    args.suppressions.push({
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      reasonCode: "s1_owned_token",
      side: "SELL",
      decisionRuleId: decision.ruleId,
      state: ctx.state,
      price: ctx.price,
      buyCount,
      timeSinceLastSeconds: ctx.timeSinceLastSeconds,
      emissionFacts,
      timestamp: args.nowIso,
      extra: {
        ladderId: ownership.ladderId,
        assumedAt: new Date(ownership.assumedAtMs).toISOString(),
        ownershipReason: ownership.reason,
      },
    });
    return none(args.metrics, args.suppressions, args.sideEffects);
  }

  // Track Q loop guard: a blocked token suppresses SELL signal generation for the
  // cooldown, regardless of which rule produced the SELL. BUY is never gated here.
  if (decision.action === "SELL" && input.sellLoopGuard?.blocked) {
    const guard = input.sellLoopGuard;
    args.sideEffects.push({
      kind: "sell_loop_guard_suppressed",
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      decisionRuleId: decision.ruleId,
      activeCount: guard.activeCount,
      threshold: guard.threshold,
      timestamp: args.nowIso,
    });
    args.suppressions.push({
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      reasonCode: SELL_LOOP_GUARD_REASON,
      side: "SELL",
      decisionRuleId: decision.ruleId,
      state: ctx.state,
      price: ctx.price,
      buyCount,
      timeSinceLastSeconds: ctx.timeSinceLastSeconds,
      emissionFacts,
      timestamp: args.nowIso,
      extra: {
        activeCount: guard.activeCount,
        threshold: guard.threshold,
        windowMs: guard.windowMs,
        blockedUntil:
          guard.blockedUntilMs != null ? new Date(guard.blockedUntilMs).toISOString() : null,
        lastOutcome: guard.lastOutcome,
      },
    });
    return none(args.metrics, args.suppressions, args.sideEffects);
  }

  if (shouldSuppressSellResidualBelowMinSize(decision, market, input.position)) {
    if (input.executionPolicy?.dustAbandonment.enabled) {
      args.sideEffects.push({
        kind: "sell_residual_reject",
        tokenId: market.tokenId,
        conditionId: market.conditionId,
        price: ctx.price,
        threshold: input.executionPolicy.dustAbandonment.maxConsecutiveRejects,
        timestamp: args.nowIso,
      });
    }
    args.suppressions.push({
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      reasonCode: SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
      side: "SELL",
      decisionRuleId: decision.ruleId,
      state: ctx.state,
      price: ctx.price,
      buyCount,
      timeSinceLastSeconds: ctx.timeSinceLastSeconds,
      emissionFacts,
      timestamp: args.nowIso,
    });
    return none(args.metrics, args.suppressions, args.sideEffects);
  }

  const signalDraft = buildSignalDraft({
    input,
    market,
    decision,
    buyCount,
    emissionFacts,
    triggerTelemetry,
    metrics: args.metrics,
    suppressions: args.suppressions,
    nowIso: args.nowIso,
  });
  if (!signalDraft) return none(args.metrics, args.suppressions, args.sideEffects);
  return {
    type: "signal",
    metrics: args.metrics,
    suppressions: args.suppressions,
    sideEffects: args.sideEffects,
    signal: signalDraft,
  };
}

function pushLegacyGuardFiredOnProfileOwned(args: {
  input: DecisionPlanningInput;
  market: NormalizedMarket;
  decisionRuleId: string;
  proposedPrice: number | null;
  avgEntryPrice: number | null;
  state: DecisionSignalLog["state"];
  emissionFacts: EmissionFacts;
  sideEffects: DecisionPlanSideEffect[];
  timestamp: string;
}): void {
  if (!args.input.profileLadderOwned) return;
  const guard = legacyGuardForDecisionRule(args.decisionRuleId);
  if (guard == null) return;
  args.sideEffects.push({
    kind: "legacy_guard_fired_on_profile_owned",
    guard,
    tokenId: args.market.tokenId,
    conditionId: args.market.conditionId,
    decisionRuleId: args.decisionRuleId,
    proposedPrice: args.proposedPrice,
    avgEntryPrice: args.avgEntryPrice,
    state: args.state,
    emissionFacts: args.emissionFacts,
    timestamp: args.timestamp,
  });
}

function legacyGuardForDecisionRule(ruleId: string): ProfileOwnedLegacyGuard | null {
  if (ruleId === "D4") return "d4";
  if (ruleId === D8_PROFIT_RATIO_RULE_ID) return "d8";
  return null;
}

function buildSignalDraft(args: {
  input: DecisionPlanningInput;
  market: NormalizedMarket;
  decision: { action: TradeDecisionAction; ruleId: string };
  buyCount: number;
  emissionFacts: EmissionFacts;
  triggerTelemetry: TriggerTelemetry;
  metrics: DecisionMetricsDelta;
  suppressions: SuppressionPlan[];
  nowIso: string;
}): DecisionSignalDraft | null {
  const { input, market, decision, buyCount, emissionFacts, triggerTelemetry } = args;
  const state = deriveState(input.legState);
  const timeSinceLastSeconds = input.legState
    ? (input.now - new Date(input.legState.lastTradeAt).getTime()) / 1000
    : null;
  const side = decision.action === "BUY" ? "buy" : ("sell" as const);
  const actionPrice = resolveActionPrice(decision.action, market, {
    avgEntryPrice: input.position?.avgEntryPrice ?? null,
  });
  if (actionPrice.price == null) return null;
  const price = actionPrice.price;
  const reason = resolveSignalReason(side, buyCount);

  if (side === "sell" && input.postBuyCooldown) {
    args.suppressions.push({
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      reasonCode: POST_BUY_FILL_COOLDOWN_REASON,
      side: "SELL",
      decisionRuleId: decision.ruleId,
      state,
      price,
      buyCount,
      timeSinceLastSeconds,
      emissionFacts,
      timestamp: args.nowIso,
    });
    return null;
  }

  if (side === "buy") {
    const dropGate = evaluateDropGate(input, price, reason, args.metrics);
    triggerTelemetry.dropTriggerStatus = dropGate.status;
    triggerTelemetry.dropTriggerPct = dropGate.priceDropPct;
    if (!dropGate.allowed) {
      args.suppressions.push({
        tokenId: market.tokenId,
        conditionId: market.conditionId,
        reasonCode: dropGate.status === "no_drop_data" ? "no_drop_data" : "no_drop_signal",
        side: "BUY",
        decisionRuleId: decision.ruleId,
        state,
        price,
        buyCount,
        timeSinceLastSeconds,
        emissionFacts,
        timestamp: args.nowIso,
      });
      return null;
    }
  }

  const sizeRules = decision.action === "BUY" ? input.buySizeRules : input.sellSizeRules;
  const nthBuy = buyCount + 1;
  const sizeResult = evaluateSize(decision.action, { state, price, nthBuy, buyCount }, sizeRules);
  const sellPlan =
    side === "sell" && input.position
      ? computeSellSizingPlan({
          position: input.position,
          sellCount: input.legState?.sellCount ?? 0,
          price,
          nowMs: input.now,
          marketMinOrderSize: market.minOrderSize,
          latestSellOrder: input.latestSellOrder,
          sellTimeoutMs: input.executionPolicy?.sellTimeoutMs,
        })
      : null;
  const suggestedSizeUsdc = sellPlan?.sizeUsdc ?? sizeResult.sizeUsdc;
  const suggestedSize = sellPlan?.size ?? (price > 0 ? suggestedSizeUsdc / price : 0);
  const sizeForExecutability =
    side === "buy"
      ? computeBuyOrderSizeForFilter(suggestedSizeUsdc, market, price)
      : Math.max(
          suggestedSize,
          Math.max(
            0,
            (emissionFacts.cumulativeBuySize ?? 0) - (emissionFacts.cumulativeSellSize ?? 0),
          ),
        );
  if (!isExecutableOrderSize(sizeForExecutability, market.minOrderSize)) {
    args.suppressions.push({
      tokenId: market.tokenId,
      conditionId: market.conditionId,
      reasonCode: "order-size-below-minimum",
      side: side === "buy" ? "BUY" : "SELL",
      decisionRuleId: decision.ruleId,
      state,
      price,
      buyCount,
      timeSinceLastSeconds,
      emissionFacts,
      timestamp: args.nowIso,
    });
    return null;
  }

  const isAdd: 0 | 1 = side === "buy" && buyCount >= 1 ? 1 : 0;
  const firstTradeAtMs = emissionFacts.firstTradeAt
    ? new Date(emissionFacts.firstTradeAt).getTime()
    : null;
  const rawAddAgeMs =
    isAdd === 1 && firstTradeAtMs != null && Number.isFinite(firstTradeAtMs)
      ? input.now - firstTradeAtMs
      : null;
  const addAgeMs = rawAddAgeMs != null && rawAddAgeMs >= 0 ? rawAddAgeMs : null;
  const firstPrice = emissionFacts.firstTradePrice;
  const addPriceChangePct =
    isAdd === 1 && firstPrice != null && firstPrice > 0 ? (price - firstPrice) / firstPrice : null;
  const exitTelemetry = computeExitTelemetry(side, price, input.now, emissionFacts);

  return {
    market,
    side,
    suggestedPrice: price,
    suggestedSize,
    suggestedSizeUsdc,
    reason,
    decisionRuleId: decision.ruleId,
    sizingRuleId: sizeResult.ruleId,
    logDraft: {
      side: side === "buy" ? "BUY" : "SELL",
      decisionRuleId: decision.ruleId,
      sizingRuleId: sizeResult.ruleId,
      notionalBucket: classifyNotionalBucket(suggestedSizeUsdc),
      state,
      price,
      buyCount,
      timeSinceLastSeconds,
      isAdd: side === "buy" ? isAdd : null,
      addAgeMs,
      addAgeBucket: classifyAddAgeBucket(addAgeMs),
      addPriceChangePct,
      addPriceChangeBucket: classifyAddPriceChangeBucket(addPriceChangePct),
      nthBuyAtEmit: side === "buy" ? nthBuy : null,
      ...exitTelemetry,
    },
    emissionFacts,
    triggerTelemetry,
  };
}

function createEmissionFacts(legState: LegState | null, position: Position | null): EmissionFacts {
  return {
    firstTradePrice: legState?.firstTradePrice ?? null,
    firstTradeAt: legState?.firstTradeAt ?? null,
    legTradeCount: (legState?.buyCount ?? 0) + (legState?.sellCount ?? 0),
    sellCountAtEmit: legState?.sellCount ?? null,
    cumulativeBuySize: legState?.cumulativeBuySize ?? null,
    cumulativeBuyNotional: legState?.cumulativeBuyNotional ?? null,
    cumulativeSellSize: legState?.cumulativeSellSize ?? null,
    currentAvgEntryPrice: position?.avgEntryPrice ?? null,
  };
}

function createTriggerTelemetry(price: number, prevMidPrice: number | null): TriggerTelemetry {
  const dropFromLastSeen =
    prevMidPrice != null && prevMidPrice > 0 ? (price - prevMidPrice) / prevMidPrice : null;
  return {
    dropFromLastSeen,
    entryPriceBucket: classifyEntryPriceBucket(price),
    dropTriggerStatus: "disabled",
    dropTriggerPct: null,
  };
}

function recordLivenessMetric(
  metrics: DecisionMetricsDelta,
  reasons: readonly string[],
  ctx: Parameters<typeof evaluateDecision>[0],
  decisionRules: readonly AlgoDecisionRule[],
): void {
  metrics.suppressedMarketNotLive++;
  const notAcceptingOrders = reasons.includes("not_accepting_orders");
  const orderBookDisabled = reasons.includes("order_book_disabled");
  if (notAcceptingOrders) metrics.livenessNotAcceptingOrders++;
  if (orderBookDisabled) metrics.livenessOrderBookDisabled++;
  if (notAcceptingOrders && orderBookDisabled) metrics.livenessBothFlags++;

  const wouldMatch = evaluateDecision(ctx, decisionRules);
  metrics.wouldMatchRule[wouldMatch.ruleId] = (metrics.wouldMatchRule[wouldMatch.ruleId] ?? 0) + 1;
}

function evaluateDropGate(
  input: DecisionPlanningInput,
  currentPrice: number,
  signalReason: string,
  metrics: DecisionMetricsDelta,
): {
  allowed: boolean;
  status: TriggerTelemetry["dropTriggerStatus"];
  priceDropPct: number | null;
} {
  const policy = input.executionPolicy?.dropTrigger;
  if (!policy?.enabled) return { allowed: true, status: "disabled", priceDropPct: null };
  if (signalReason === "probe-entry") {
    return { allowed: true, status: "bypass_probe", priceDropPct: null };
  }
  metrics.dropTriggerChecked++;
  const referencePrice = input.dropReferencePrice;
  if (referencePrice == null || referencePrice <= 0 || !Number.isFinite(referencePrice)) {
    metrics.allowNoDropData++;
    return {
      allowed: policy.failOpenOnNoData,
      status: "no_drop_data",
      priceDropPct: null,
    };
  }
  const priceDropPct = (currentPrice - referencePrice) / referencePrice;
  if (priceDropPct > policy.thresholdPct) {
    metrics.rejectNoDropSignal++;
    return { allowed: false, status: "rejected", priceDropPct };
  }
  metrics.dropTriggerPassed++;
  return { allowed: true, status: "passed", priceDropPct };
}

function shouldSuppressSellResidualBelowMinSize(
  decision: { action: TradeDecisionAction; ruleId: string },
  market: NormalizedMarket,
  position: Position | null,
): boolean {
  if (decision.action !== "SELL") return false;
  const minOrderSize = market.minOrderSize;
  const positionSize = position?.size;
  return (
    typeof minOrderSize === "number" &&
    Number.isFinite(minOrderSize) &&
    minOrderSize > 0 &&
    typeof positionSize === "number" &&
    Number.isFinite(positionSize) &&
    positionSize + 1e-9 < minOrderSize
  );
}

function finitePositiveOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function computeBuyOrderSizeForFilter(
  suggestedSizeUsdc: number,
  market: NormalizedMarket,
  fallbackPrice: number,
): number {
  const bestBid = market.bestBid;
  const price =
    typeof bestBid === "number" && Number.isFinite(bestBid) && bestBid > 0
      ? bestBid
      : fallbackPrice;
  return price > 0 ? suggestedSizeUsdc / price : 0;
}

type ExitTelemetry = Pick<
  DecisionSignalLog,
  | "isExit"
  | "isFirstSell"
  | "holdingTimeMs"
  | "holdingTimeBucket"
  | "exitPnlPct"
  | "exitPnlBucket"
  | "soldBoughtRatio"
  | "soldBoughtRatioBucket"
>;

const NON_SELL_EXIT_TELEMETRY: ExitTelemetry = {
  isExit: 0,
  isFirstSell: null,
  holdingTimeMs: null,
  holdingTimeBucket: null,
  exitPnlPct: null,
  exitPnlBucket: null,
  soldBoughtRatio: null,
  soldBoughtRatioBucket: null,
};

function computeExitTelemetry(
  side: "buy" | "sell",
  price: number,
  nowMs: number,
  emissionFacts: EmissionFacts,
): ExitTelemetry {
  if (side !== "sell") return NON_SELL_EXIT_TELEMETRY;

  const cumulativeBuySize = emissionFacts.cumulativeBuySize ?? 0;
  const cumulativeBuyNotional = emissionFacts.cumulativeBuyNotional ?? 0;
  const cumulativeSellSize = emissionFacts.cumulativeSellSize ?? 0;
  const sellCount = emissionFacts.sellCountAtEmit ?? 0;
  const firstTradeAtMs = emissionFacts.firstTradeAt
    ? new Date(emissionFacts.firstTradeAt).getTime()
    : null;
  const rawHoldingMs =
    firstTradeAtMs != null && Number.isFinite(firstTradeAtMs) ? nowMs - firstTradeAtMs : null;
  const holdingTimeMs = rawHoldingMs != null && rawHoldingMs >= 0 ? rawHoldingMs : null;
  const fallbackBasis = cumulativeBuySize > 0 ? cumulativeBuyNotional / cumulativeBuySize : null;
  const rollingBasis = emissionFacts.currentAvgEntryPrice ?? null;
  const costBasis =
    rollingBasis != null && rollingBasis > 0 && Number.isFinite(rollingBasis)
      ? rollingBasis
      : fallbackBasis;
  const exitPnlPct = costBasis != null && costBasis > 0 ? (price - costBasis) / costBasis : null;
  const soldBoughtRatio = cumulativeBuySize > 0 ? cumulativeSellSize / cumulativeBuySize : null;

  return {
    isExit: 1,
    isFirstSell: sellCount === 0 ? 1 : 0,
    holdingTimeMs,
    holdingTimeBucket: classifyHoldingTimeBucket(holdingTimeMs),
    exitPnlPct,
    exitPnlBucket: classifyExitPnlBucket(exitPnlPct),
    soldBoughtRatio,
    soldBoughtRatioBucket: classifySoldBoughtRatioBucket(soldBoughtRatio),
  };
}

function resolveDaysToResolve(endDate: string | null, nowMs: number): number | null {
  if (endDate == null || endDate.trim() === "") return null;
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return null;
  const daysToResolve = (endMs - nowMs) / 86_400_000;
  return Number.isFinite(daysToResolve) ? daysToResolve : null;
}
