import type {
  FamilyRuleBundle,
  NormalizedMarket,
  Order,
  OrderBookSnapshot,
  Signal,
} from "@plankton/domain";
import { resolveMakerOnlyPrice, resolveMarketabilityPolicy } from "../strategy/marketability.js";
import {
  isDustLaneEnabled,
  isHotQuoteFamily,
  isQueueJumpCanaryEnabled,
} from "../../family-throughput.js";
import { hasFreshTradeActivity, resolveDustSizeCapUsdc } from "../strategy/book-quality-policy.js";

const EPSILON = 1e-9;
const DEFAULT_DUST_ENTRY_TTL_MS = 15_000;
const DEFAULT_DUST_EXIT_TTL_MS = 20_000;
const DEFAULT_DUST_ENTRY_REPRICE_INTERVAL_MS = 5_000;
const DEFAULT_DUST_EXIT_REPRICE_INTERVAL_MS = 8_000;
const DEFAULT_DUST_REPRICE_SUPPRESS_AFTER = 3;
const DEFAULT_MIN_REPRICE_CANCEL_INTERVAL_MS = 3_000;
const DEFAULT_QUEUE_JUMP_SLIPPAGE_CAP = 0.02;
const DEFAULT_QUEUE_PRESSURE_MULTIPLIER = 3;
const DEFAULT_QUEUE_PRESSURE_ABSOLUTE_SIZE = 25;

export interface HotLanePolicy {
  readonly hotQuoteRefreshIntervalMs: number;
  readonly maxTokensPerCycle: number;
  readonly dustEntryTtlMs: number;
  readonly dustExitTtlMs: number;
  readonly dustEntryRepriceIntervalMs: number;
  readonly dustExitRepriceIntervalMs: number;
  readonly dustRepriceSuppressAfter: number;
  readonly minRepriceCancelIntervalMs: number;
  readonly queueJumpMaxSlippageCents: number;
  readonly queuePressureSizeMultiple: number;
  readonly queuePressureAbsoluteShares: number;
}

export interface PlannedHotLaneAction {
  readonly type: "keep" | "cancel";
  readonly reason?:
    | "entry-reprice-cancel"
    | "entry-ttl-cancel"
    | "entry-suppress-cancel"
    | "exit-reprice-cancel"
    | "exit-ttl-cancel";
  readonly desiredPrice?: number | null;
}

export interface QueueJumpExecutionTerms {
  readonly price: number;
  readonly postOnly?: false;
}

export interface QueueDepthBaseline {
  readonly referencePrice: number | null;
  readonly levelVisibleSize: number | null;
  readonly visibleAheadSize: number | null;
}

export type HotLaneOrderState =
  | "quote-active"
  | "needs-reprice"
  | "cooling"
  | "suppressed"
  | "reactivated";

export const DEFAULT_HOT_LANE_POLICY: HotLanePolicy = {
  hotQuoteRefreshIntervalMs: 1_000,
  maxTokensPerCycle: 80,
  dustEntryTtlMs: DEFAULT_DUST_ENTRY_TTL_MS,
  dustExitTtlMs: DEFAULT_DUST_EXIT_TTL_MS,
  dustEntryRepriceIntervalMs: DEFAULT_DUST_ENTRY_REPRICE_INTERVAL_MS,
  dustExitRepriceIntervalMs: DEFAULT_DUST_EXIT_REPRICE_INTERVAL_MS,
  dustRepriceSuppressAfter: DEFAULT_DUST_REPRICE_SUPPRESS_AFTER,
  minRepriceCancelIntervalMs: DEFAULT_MIN_REPRICE_CANCEL_INTERVAL_MS,
  queueJumpMaxSlippageCents: DEFAULT_QUEUE_JUMP_SLIPPAGE_CAP,
  queuePressureSizeMultiple: DEFAULT_QUEUE_PRESSURE_MULTIPLIER,
  queuePressureAbsoluteShares: DEFAULT_QUEUE_PRESSURE_ABSOLUTE_SIZE,
};

export function shouldUseDustLane(bundle: FamilyRuleBundle | null | undefined): boolean {
  return isDustLaneEnabled(bundle);
}

export function shouldUseHotQuoteLane(bundle: FamilyRuleBundle | null | undefined): boolean {
  return isHotQuoteFamily(bundle);
}

export function resolveDustExitSignalIntervalMs(
  bundle: FamilyRuleBundle,
  policy: Pick<HotLanePolicy, "hotQuoteRefreshIntervalMs"> = DEFAULT_HOT_LANE_POLICY,
): number {
  if (bundle.identity.strategyProfile === "event-driven") {
    return Math.max(1_000, policy.hotQuoteRefreshIntervalMs);
  }
  if (
    bundle.identity.cadence === "daily-dated" ||
    bundle.identity.cadence === "intraday-4h" ||
    bundle.rules.tailSuppression.thresholdCleanupRequired
  ) {
    return Math.max(1_500, policy.hotQuoteRefreshIntervalMs);
  }
  return Math.max(2_000, policy.hotQuoteRefreshIntervalMs);
}

export function isDustSignalReason(signalReason: string | null | undefined): boolean {
  return signalReason === "spray-entry";
}

export function isDustOrder(order: Pick<Order, "signalReason">): boolean {
  return isDustSignalReason(order.signalReason);
}

export function isQueueJumpEligible(opts: {
  readonly signal: Pick<Signal, "side" | "reason" | "suggestedSizeUsdc">;
  readonly market: Pick<
    NormalizedMarket,
    "bestBid" | "bestAsk" | "lastTradeAt" | "lastTradePrice" | "tickSize" | "bookSource"
  >;
  readonly bundle: FamilyRuleBundle;
  readonly nowMs: number;
  readonly maxSlippageCents?: number;
  readonly executionMinNotionalUsdc?: number | null;
}): boolean {
  const { signal, market, bundle, nowMs } = opts;
  if (signal.side !== "buy" || signal.reason !== "spray-entry") return false;
  const dustSizeCapUsdc = resolveDustSizeCapUsdc(opts.executionMinNotionalUsdc ?? null);
  if (signal.suggestedSizeUsdc > dustSizeCapUsdc + EPSILON) return false;
  if (!isQueueJumpFamilyEligible(bundle)) return false;
  if (market.bestAsk == null || market.lastTradePrice == null) return false;
  if (market.bookSource === "gamma-fallback") return false;
  if (!hasFreshTradeActivity(market.lastTradeAt, nowMs)) return false;

  const maxSlippageCents = opts.maxSlippageCents ?? DEFAULT_QUEUE_JUMP_SLIPPAGE_CAP;
  return market.bestAsk <= market.lastTradePrice + maxSlippageCents + EPSILON;
}

export function resolveQueueJumpExecutionTerms(opts: {
  readonly signal: Pick<Signal, "side" | "reason" | "suggestedSizeUsdc">;
  readonly market: Pick<
    NormalizedMarket,
    "bestBid" | "bestAsk" | "lastTradeAt" | "lastTradePrice" | "tickSize" | "bookSource"
  >;
  readonly bundle: FamilyRuleBundle;
  readonly nowMs: number;
  readonly maxSlippageCents?: number;
  readonly executionMinNotionalUsdc?: number | null;
}): QueueJumpExecutionTerms | null {
  if (!isQueueJumpEligible(opts)) return null;
  return {
    price: opts.market.bestAsk!,
    postOnly: false,
  };
}

function isQueueJumpFamilyEligible(bundle: FamilyRuleBundle): boolean {
  if (!shouldUseDustLane(bundle)) return false;
  if (!isQueueJumpCanaryEnabled(bundle)) return false;
  if (
    bundle.identity.strategyProfile === "event-driven" &&
    bundle.identity.primaryCategory === "geopolitics"
  ) {
    return true;
  }

  const cadence = bundle.identity.cadence;
  const recurringCadence = cadence === "daily-dated" || cadence === "intraday-4h";
  if (!recurringCadence) return false;

  const evidenceScore = bundle.evidence?.evidenceScore ?? 0;
  const localTradeCount = bundle.evidence?.localTradeCount ?? 0;
  return evidenceScore >= 80 && localTradeCount >= 10;
}

export function planHotLaneOrderAction(opts: {
  readonly order: Pick<Order, "signalReason" | "price" | "sizeUsdc" | "createdAt">;
  readonly market: NormalizedMarket | null;
  readonly book?: OrderBookSnapshot | null;
  readonly bundle: FamilyRuleBundle;
  readonly nowMs: number;
  readonly lastMaintenanceAtMs?: number | null;
  readonly quickCancelCount?: number;
  readonly queueBaseline?: QueueDepthBaseline | null;
  readonly policy?: HotLanePolicy;
}): PlannedHotLaneAction {
  const policy = opts.policy ?? DEFAULT_HOT_LANE_POLICY;
  const quickCancelCount = opts.quickCancelCount ?? 0;
  const orderAgeMs = Math.max(0, opts.nowMs - Date.parse(opts.order.createdAt));

  if (opts.order.signalReason === "spray-entry" && shouldUseDustLane(opts.bundle)) {
    if (orderAgeMs >= policy.dustEntryTtlMs) {
      return {
        type: "cancel",
        reason:
          quickCancelCount + 1 >= policy.dustRepriceSuppressAfter
            ? "entry-suppress-cancel"
            : "entry-ttl-cancel",
      };
    }
    if (
      opts.lastMaintenanceAtMs != null &&
      opts.nowMs - opts.lastMaintenanceAtMs < policy.dustEntryRepriceIntervalMs
    ) {
      return { type: "keep" };
    }
    if (!opts.market) return { type: "keep" };
    const desiredPrice = resolveMakerOnlyPrice({
      side: "buy",
      suggestedPrice: opts.market.lastTradePrice ?? opts.market.midPrice ?? opts.order.price,
      suggestedSizeUsdc: opts.order.sizeUsdc,
      signalReason: "spray-entry",
      nowMs: opts.nowMs,
      market: opts.market,
      policy: resolveMarketabilityPolicy(opts.bundle),
    });
    if (
      desiredPrice != null &&
      Math.abs(desiredPrice - opts.order.price) >= opts.market.tickSize - EPSILON
    ) {
      return { type: "cancel", reason: "entry-reprice-cancel", desiredPrice };
    }
    const queueAwarePrice = resolveQueueAwareRepricePrice({
      side: "buy",
      currentPrice: opts.order.price,
      currentSize: opts.order.sizeUsdc / Math.max(opts.order.price, EPSILON),
      market: opts.market,
      book: opts.book ?? null,
      baseline: opts.queueBaseline ?? null,
      policy,
    });
    if (
      queueAwarePrice != null &&
      Math.abs(queueAwarePrice - opts.order.price) >= opts.market.tickSize - EPSILON
    ) {
      return { type: "cancel", reason: "entry-reprice-cancel", desiredPrice: queueAwarePrice };
    }
  }

  if (opts.order.signalReason === "repricing-exit" && shouldUseHotQuoteLane(opts.bundle)) {
    if (orderAgeMs >= policy.dustExitTtlMs) {
      return { type: "cancel", reason: "exit-ttl-cancel" };
    }
    if (
      opts.lastMaintenanceAtMs != null &&
      opts.nowMs - opts.lastMaintenanceAtMs < policy.dustExitRepriceIntervalMs
    ) {
      return { type: "keep" };
    }
    if (!opts.market) return { type: "keep" };
    const desiredPrice = resolveMakerOnlyPrice({
      side: "sell",
      suggestedPrice: opts.market.lastTradePrice ?? opts.market.midPrice ?? opts.order.price,
      signalReason: "repricing-exit",
      nowMs: opts.nowMs,
      market: opts.market,
      policy: resolveMarketabilityPolicy(opts.bundle),
    });
    if (
      desiredPrice != null &&
      Math.abs(desiredPrice - opts.order.price) >= opts.market.tickSize - EPSILON
    ) {
      return { type: "cancel", reason: "exit-reprice-cancel", desiredPrice };
    }
    const queueAwarePrice = resolveQueueAwareRepricePrice({
      side: "sell",
      currentPrice: opts.order.price,
      currentSize: opts.order.sizeUsdc / Math.max(opts.order.price, EPSILON),
      market: opts.market,
      book: opts.book ?? null,
      baseline: opts.queueBaseline ?? null,
      policy,
    });
    if (
      queueAwarePrice != null &&
      Math.abs(queueAwarePrice - opts.order.price) >= opts.market.tickSize - EPSILON
    ) {
      return { type: "cancel", reason: "exit-reprice-cancel", desiredPrice: queueAwarePrice };
    }
  }

  return { type: "keep" };
}

export function captureQueueDepthBaseline(
  side: "buy" | "sell",
  book: OrderBookSnapshot | null | undefined,
  orderPrice?: number | null,
): QueueDepthBaseline | null {
  if (!book) return null;
  const levels = side === "buy" ? book.bids : book.asks;
  const referencePrice =
    orderPrice != null
      ? (levels.find((level) => Math.abs(level.price - orderPrice) < EPSILON)?.price ?? null)
      : (levels[0]?.price ?? null);
  if (referencePrice == null) return null;
  const level = levels.find((entry) => Math.abs(entry.price - referencePrice) < EPSILON) ?? null;
  if (!level) return null;
  return {
    referencePrice,
    levelVisibleSize: level.size,
    visibleAheadSize: resolveVisibleAheadSize(side, levels, referencePrice),
  };
}

function resolveQueueAwareRepricePrice(opts: {
  readonly side: "buy" | "sell";
  readonly currentPrice: number;
  readonly currentSize: number;
  readonly market: Pick<NormalizedMarket, "bestBid" | "bestAsk" | "tickSize">;
  readonly book: OrderBookSnapshot | null;
  readonly baseline: QueueDepthBaseline | null;
  readonly policy: HotLanePolicy;
}): number | null {
  const { side, currentPrice, currentSize, market, book, baseline, policy } = opts;
  if (!book || !baseline) return null;
  const levels = side === "buy" ? book.bids : book.asks;
  const baselineSize = baseline.visibleAheadSize;
  if (baselineSize == null || !Number.isFinite(baselineSize) || baselineSize <= 0) return null;
  const currentVisibleAhead = resolveVisibleAheadSize(side, levels, currentPrice);
  if (currentVisibleAhead == null) return null;
  const queueSizeThreshold = Math.max(
    baselineSize * policy.queuePressureSizeMultiple,
    baselineSize +
      Math.max(policy.queuePressureAbsoluteShares, currentSize * policy.queuePressureSizeMultiple),
  );
  if (currentVisibleAhead + EPSILON < queueSizeThreshold) return null;

  if (side === "buy") {
    if (market.bestAsk == null) return null;
    const improved = roundDownToTick(currentPrice + market.tickSize, market.tickSize);
    return improved < market.bestAsk - EPSILON ? improved : null;
  }

  if (market.bestBid == null) return null;
  const improved = roundUpToTick(currentPrice - market.tickSize, market.tickSize);
  return improved > market.bestBid + EPSILON ? improved : null;
}

function resolveVisibleAheadSize(
  side: "buy" | "sell",
  levels: ReadonlyArray<OrderBookSnapshot["bids"][number]>,
  referencePrice: number,
): number | null {
  let total = 0;
  let matchedLevel = false;
  for (const level of levels) {
    if (side === "buy") {
      if (level.price > referencePrice + EPSILON) {
        total += level.size;
        continue;
      }
      if (Math.abs(level.price - referencePrice) < EPSILON) {
        total += level.size;
        matchedLevel = true;
      }
      continue;
    }

    if (level.price < referencePrice - EPSILON) {
      total += level.size;
      continue;
    }
    if (Math.abs(level.price - referencePrice) < EPSILON) {
      total += level.size;
      matchedLevel = true;
    }
  }
  return matchedLevel ? total : null;
}

function roundDownToTick(value: number, tickSize: number): number {
  return Math.floor(value / tickSize) * tickSize;
}

function roundUpToTick(value: number, tickSize: number): number {
  return Math.ceil(value / tickSize) * tickSize;
}
