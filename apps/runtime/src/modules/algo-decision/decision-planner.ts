import type {
  AlgoDecisionRule,
  AlgoSizeRule,
  DecisionSignalLog,
  ExecutionPolicy,
  LegState,
  NormalizedMarket,
  Position,
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
} from "../../executable-price.js";
import { SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON } from "../../internal-order-reasons.js";
import { isExecutableOrderSize } from "../../min-order-size.js";

export type TradeCountSource = "market_wide" | "leg_local_fallback" | "leg_local";

export type EntryPriceBucket = "<=0.005" | "0.005-0.05" | "0.05-0.20" | ">0.20";

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
};

const SELL_ONLY: ReadonlySet<TradeDecisionAction> = new Set(["SELL"]);
const D6_SUPPRESSED_REASON = "d6-suppressed";
const DECISION_RULE_HOLD_REASON = "decision-rule-hold";
const DUST_ABANDONED_REASON = "dust-abandoned";
const D8_PROFIT_RATIO_RULE_ID = "D8_PROFIT_RATIO";
export const D9_LOSS_EXIT_BELOW_AVG_ENTRY_GUARD_REASON = "d9_loss_exit_below_avg_entry_guard";
export const D9_LOSS_EXIT_AVG_ENTRY_UNAVAILABLE_BYPASS_REASON =
  "d9_loss_exit_avg_entry_unavailable_guard_bypass";
const POST_BUY_FILL_COOLDOWN_REASON = "post-buy-fill-cooldown";
const SELL_SPREAD_MAX_RATIO = 0.5;

type SellExecutablePriceResult = {
  price: number | null;
  reasonCode: "mid-price-unavailable" | "sell-best-bid-unavailable" | "sell-spread-too-wide" | null;
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

export function resolveSellExecutablePrice(market: NormalizedMarket): SellExecutablePriceResult {
  if (
    typeof market.bestBid !== "number" ||
    !Number.isFinite(market.bestBid) ||
    market.bestBid <= 0
  ) {
    return { price: null, reasonCode: "sell-best-bid-unavailable" };
  }

  const spread =
    typeof market.spread === "number" && Number.isFinite(market.spread)
      ? market.spread
      : typeof market.bestAsk === "number" &&
          Number.isFinite(market.bestAsk) &&
          market.bestAsk > market.bestBid
        ? market.bestAsk - market.bestBid
        : null;
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
    return { price: null, reasonCode: "sell-spread-too-wide" };
  }

  return { price: market.bestBid, reasonCode: null };
}

function resolveActionPrice(
  action: TradeDecisionAction,
  market: NormalizedMarket,
): SellExecutablePriceResult {
  if (action === "SELL") return resolveSellExecutablePrice(market);
  const price = market.midPrice;
  return typeof price === "number" && Number.isFinite(price)
    ? { price, reasonCode: null }
    : { price: null, reasonCode: "mid-price-unavailable" };
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
  const sellPrice = resolveSellExecutablePrice(market);
  const price = legState ? (sellPrice.price ?? midPrice) : midPrice;

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
        currentPrice: price,
        cumulativeBuySize: legState.cumulativeBuySize ?? 0,
        cumulativeBuyNotional: legState.cumulativeBuyNotional ?? 0,
        holdDurationSeconds,
      },
      input.executionPolicy.profitTarget,
    );
    if (d8.fire) {
      return buildSignalOrSuppression({
        input,
        market,
        decision: { action: "SELL", ruleId: D8_PROFIT_RATIO_RULE_ID },
        buyCount,
        emissionFacts: {
          ...emissionFacts,
          d8ProfitRatio: d8.profitRatio,
          d8Threshold: d8.threshold,
          d8AvgBuyPrice: d8.avgBuyPrice,
        },
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
  const actionPrice = resolveActionPrice(decision.action, market);
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
  const actionPrice = resolveActionPrice(decision.action, market);
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
