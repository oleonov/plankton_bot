import type { FamilyRuleBundle, NormalizedMarket, Order, Signal } from "@plankton/domain";
import { Action, ENTRY_REASONS, PromotionState } from "@plankton/domain";
import {
  resolveFamilySpeedTier,
  resolveFamilyThroughputTierByFamilyKey,
  type FamilySpeedTier,
} from "../../family-throughput.js";

const EPSILON = 1e-9;
const DEFAULT_MAX_BOOK_AGE_MS = 15_000;
const DEFAULT_HARD_MAX_BOOK_AGE_MS = 60_000;

export interface MarketabilityPolicy {
  readonly tier: "core" | "reduced" | "fallback";
  readonly speedTier: FamilySpeedTier;
  readonly maxBookAgeMs: number;
  readonly hardMaxBookAgeMs: number;
  readonly maxEntrySpreadCents: number;
  readonly maxWideEntrySpreadCents: number;
  readonly minWideSpreadVolume24h: number;
  readonly minEntryVolume24h: number;
  readonly maxPriceImprovementCents: number;
  readonly makerImprovementTicks: number;
  readonly maxRestingBuyReservationUsdc: number;
  readonly maxUnfilledOrdersPerToken: number;
  readonly maxUnfilledOrdersPerMarket: number;
  readonly maxUnfilledCancelsBeforeCooldown: number;
  readonly unfilledCancelCooldownMs: number;
  readonly allowOneSidedBooks: boolean;
}

export interface RestingOrderSnapshot {
  readonly buyEntryUsdcByFamily: ReadonlyMap<string, number>;
  readonly buyEntryCountByToken: ReadonlyMap<string, number>;
  readonly buyEntryCountByMarket: ReadonlyMap<string, number>;
}

export interface MarketabilityDecision {
  readonly approved: boolean;
  readonly rejectionReasons: readonly string[];
  readonly checksPassed: readonly string[];
  readonly policy: MarketabilityPolicy;
  readonly diagnostics: Readonly<Record<string, unknown>>;
}

const BASE_POLICY = {
  maxBookAgeMs: DEFAULT_MAX_BOOK_AGE_MS,
  hardMaxBookAgeMs: DEFAULT_HARD_MAX_BOOK_AGE_MS,
  minEntryVolume24h: 5_000,
  allowOneSidedBooks: false,
} as const;

const CORE_POLICY: MarketabilityPolicy = {
  tier: "core",
  speedTier: "standard",
  ...BASE_POLICY,
  maxEntrySpreadCents: 0.02,
  maxWideEntrySpreadCents: 0.05,
  minWideSpreadVolume24h: 50_000,
  maxPriceImprovementCents: 0.02,
  makerImprovementTicks: 2,
  maxRestingBuyReservationUsdc: 25,
  maxUnfilledOrdersPerToken: 2,
  maxUnfilledOrdersPerMarket: 8,
  maxUnfilledCancelsBeforeCooldown: 2,
  unfilledCancelCooldownMs: 5 * 60_000,
};

const CORE_FAST_POLICY: MarketabilityPolicy = {
  ...CORE_POLICY,
  speedTier: "core-fast",
  maxEntrySpreadCents: 0.03,
  maxWideEntrySpreadCents: 0.08,
  minWideSpreadVolume24h: 25_000,
  maxPriceImprovementCents: 0.03,
  makerImprovementTicks: 3,
  maxUnfilledOrdersPerToken: 3,
  maxUnfilledOrdersPerMarket: 10,
  maxUnfilledCancelsBeforeCooldown: 3,
  unfilledCancelCooldownMs: 2 * 60_000,
};

const REDUCED_POLICY: MarketabilityPolicy = {
  tier: "reduced",
  speedTier: "standard",
  ...BASE_POLICY,
  maxEntrySpreadCents: 0.01,
  maxWideEntrySpreadCents: 0.02,
  minWideSpreadVolume24h: 25_000,
  maxPriceImprovementCents: 0.01,
  makerImprovementTicks: 1,
  maxRestingBuyReservationUsdc: 10,
  maxUnfilledOrdersPerToken: 1,
  maxUnfilledOrdersPerMarket: 4,
  maxUnfilledCancelsBeforeCooldown: 2,
  unfilledCancelCooldownMs: 5 * 60_000,
};

const REDUCED_FAST_POLICY: MarketabilityPolicy = {
  ...REDUCED_POLICY,
  speedTier: "reduced-fast",
  maxEntrySpreadCents: 0.015,
  maxWideEntrySpreadCents: 0.03,
  minWideSpreadVolume24h: 15_000,
  maxPriceImprovementCents: 0.015,
  makerImprovementTicks: 2,
  maxUnfilledOrdersPerToken: 2,
  maxUnfilledOrdersPerMarket: 6,
  maxUnfilledCancelsBeforeCooldown: 3,
  unfilledCancelCooldownMs: 3 * 60_000,
};

const FALLBACK_POLICY: MarketabilityPolicy = {
  tier: "fallback",
  speedTier: "standard",
  ...BASE_POLICY,
  maxEntrySpreadCents: 0.005,
  maxWideEntrySpreadCents: 0.01,
  minWideSpreadVolume24h: 25_000,
  maxPriceImprovementCents: 0.005,
  makerImprovementTicks: 1,
  maxRestingBuyReservationUsdc: 5,
  maxUnfilledOrdersPerToken: 1,
  maxUnfilledOrdersPerMarket: 2,
  maxUnfilledCancelsBeforeCooldown: 1,
  unfilledCancelCooldownMs: 10 * 60_000,
};

export function resolveMarketabilityPolicy(bundle: FamilyRuleBundle): MarketabilityPolicy {
  const speedTier = resolveFamilySpeedTier(bundle);
  const tier = resolveFamilyThroughputTierByFamilyKey(bundle.identity.familyKey);

  if (tier === "core") return speedTier === "core-fast" ? CORE_FAST_POLICY : CORE_POLICY;
  if (tier === "reduced") {
    return speedTier === "reduced-fast" ? REDUCED_FAST_POLICY : REDUCED_POLICY;
  }
  return FALLBACK_POLICY;
}

export function buildRestingOrderSnapshot(
  orders: readonly Order[],
  marketsByToken: ReadonlyMap<string, Pick<NormalizedMarket, "conditionId">>,
): RestingOrderSnapshot {
  const buyEntryUsdcByFamily = new Map<string, number>();
  const buyEntryCountByToken = new Map<string, number>();
  const buyEntryCountByMarket = new Map<string, number>();

  for (const order of orders) {
    if (!isOpenBuyEntryOrder(order)) continue;

    const familyKey = String(order.familyId);
    const tokenKey = String(order.tokenId);
    const conditionId = marketsByToken.get(tokenKey)?.conditionId ?? `token:${tokenKey}`;
    const marketKey = `${familyKey}|${conditionId}`;

    buyEntryUsdcByFamily.set(
      familyKey,
      (buyEntryUsdcByFamily.get(familyKey) ?? 0) + order.sizeUsdc,
    );
    buyEntryCountByToken.set(tokenKey, (buyEntryCountByToken.get(tokenKey) ?? 0) + 1);
    buyEntryCountByMarket.set(marketKey, (buyEntryCountByMarket.get(marketKey) ?? 0) + 1);
  }

  return { buyEntryUsdcByFamily, buyEntryCountByToken, buyEntryCountByMarket };
}

export function evaluateMarketability(opts: {
  readonly signal: Signal;
  readonly market: NormalizedMarket;
  readonly bundle: FamilyRuleBundle;
  readonly nowMs: number;
  readonly restingSnapshot?: RestingOrderSnapshot | null;
  readonly cooldownUntilMs?: number | null;
}): MarketabilityDecision {
  const policy = resolveMarketabilityPolicy(opts.bundle);
  const diagnostics = buildDiagnostics(opts.market, opts.nowMs, policy);
  const rejectionReasons: string[] = [];
  const checksPassed: string[] = [];

  if (!isEntrySignal(opts.signal)) {
    return {
      approved: true,
      rejectionReasons,
      checksPassed: ["non-entry-signal"],
      policy,
      diagnostics,
    };
  }

  applyFamilyActionChecks(opts.bundle, rejectionReasons, checksPassed);
  applyBookChecks(opts.market, opts.nowMs, policy, rejectionReasons, checksPassed);
  applySpreadChecks(opts.market, policy, rejectionReasons, checksPassed);
  applyRestingOrderChecks(opts, policy, rejectionReasons, checksPassed);

  return {
    approved: rejectionReasons.length === 0,
    rejectionReasons,
    checksPassed,
    policy,
    diagnostics,
  };
}

export function resolveMakerOnlyPrice(opts: {
  readonly side: "buy" | "sell";
  readonly suggestedPrice: number;
  readonly market: Pick<NormalizedMarket, "bestBid" | "bestAsk" | "tickSize" | "spread">;
  readonly policy?: MarketabilityPolicy;
}): number | null {
  const { side, suggestedPrice, market } = opts;
  const { bestBid, bestAsk, tickSize } = market;
  const policy = opts.policy ?? fallbackPricePolicy();
  const spread = market.spread ?? (bestBid != null && bestAsk != null ? bestAsk - bestBid : null);

  if (side === "buy") {
    if (bestAsk == null) return null;
    const target = resolveBuyMakerTarget({ bestBid, bestAsk, tickSize, spread, policy });
    if (target == null) return null;

    const price = roundDownToTick(Math.min(suggestedPrice, target), tickSize);
    if ((bestBid != null && price + EPSILON < bestBid) || price >= bestAsk - EPSILON) return null;
    if (
      bestBid != null &&
      spread != null &&
      spread > tickSize + EPSILON &&
      price <= bestBid + EPSILON
    ) {
      return null;
    }
    return isValidLimitPrice(price, tickSize) ? price : null;
  }

  if (bestBid == null) return null;
  const target = resolveSellMakerTarget({ bestBid, bestAsk, tickSize, spread, policy });
  if (target == null) return null;

  const price = roundUpToTick(Math.max(suggestedPrice, target), tickSize);
  if ((bestAsk != null && price - EPSILON > bestAsk) || price <= bestBid + EPSILON) return null;
  return isValidLimitPrice(price, tickSize) ? price : null;
}

function applyFamilyActionChecks(
  bundle: FamilyRuleBundle,
  rejectionReasons: string[],
  checksPassed: string[],
): void {
  if (bundle.rules.universe.action === Action.Trade) {
    checksPassed.push("family-tradable");
  } else {
    rejectionReasons.push(`family-${bundle.rules.universe.action}`);
  }

  const promotionState = bundle.evidence?.promotionState ?? null;
  if (
    promotionState === PromotionState.ReduceOnly ||
    promotionState === PromotionState.Quarantine
  ) {
    rejectionReasons.push(`family-${promotionState}`);
  }
}

function applyBookChecks(
  market: NormalizedMarket,
  nowMs: number,
  policy: MarketabilityPolicy,
  rejectionReasons: string[],
  checksPassed: string[],
): void {
  const bookAgeMs = Math.max(0, nowMs - market.snapshotTs);

  if (!market.active) {
    rejectionReasons.push("market-inactive");
  } else {
    checksPassed.push("market-active");
  }

  if (!policy.allowOneSidedBooks && market.bestBid == null && market.bestAsk == null) {
    rejectionReasons.push("book-missing");
  } else if (!policy.allowOneSidedBooks && (market.bestBid == null || market.bestAsk == null)) {
    rejectionReasons.push("book-one-sided");
  } else {
    checksPassed.push("book-two-sided");
  }

  if (bookAgeMs > policy.hardMaxBookAgeMs) {
    rejectionReasons.push("book-stale-hard");
  } else if (bookAgeMs > policy.maxBookAgeMs) {
    rejectionReasons.push("book-stale");
  } else {
    checksPassed.push("book-fresh");
  }
}

function applySpreadChecks(
  market: NormalizedMarket,
  policy: MarketabilityPolicy,
  rejectionReasons: string[],
  checksPassed: string[],
): void {
  const spread =
    market.spread ??
    (market.bestBid != null && market.bestAsk != null ? market.bestAsk - market.bestBid : null);
  if (spread == null || !Number.isFinite(spread) || spread <= 0) {
    rejectionReasons.push(
      market.bookSource === "gamma-fallback" ? "gamma-fallback-no-real-book" : "spread-unavailable",
    );
    return;
  }

  if (spread <= policy.maxEntrySpreadCents + EPSILON) {
    checksPassed.push("spread-tight");
    return;
  }

  const volume24h = market.volume24h ?? 0;
  if (
    spread <= policy.maxWideEntrySpreadCents + EPSILON &&
    volume24h >= policy.minWideSpreadVolume24h
  ) {
    checksPassed.push("spread-wide-volume-qualified");
    return;
  }

  rejectionReasons.push("spread-too-wide");
}

function applyRestingOrderChecks(
  opts: {
    readonly signal: Signal;
    readonly market: NormalizedMarket;
    readonly bundle: FamilyRuleBundle;
    readonly nowMs: number;
    readonly restingSnapshot?: RestingOrderSnapshot | null;
    readonly cooldownUntilMs?: number | null;
  },
  policy: MarketabilityPolicy,
  rejectionReasons: string[],
  checksPassed: string[],
): void {
  const cooldownUntilMs = opts.cooldownUntilMs ?? 0;
  if (cooldownUntilMs > opts.nowMs) {
    rejectionReasons.push("unfilled-cancel-cooldown");
  } else {
    checksPassed.push("unfilled-cancel-cooldown-clear");
  }

  const snapshot = opts.restingSnapshot;
  if (!snapshot) {
    checksPassed.push("resting-snapshot-unavailable");
    return;
  }

  const familyKey = String(opts.signal.familyId);
  const tokenKey = String(opts.signal.tokenId);
  const marketKey = `${familyKey}|${opts.market.conditionId}`;
  const familyBuyUsdc = snapshot.buyEntryUsdcByFamily.get(familyKey) ?? 0;
  const nextFamilyBuyUsdc = familyBuyUsdc + opts.signal.suggestedSizeUsdc;
  const tokenOrderCount = snapshot.buyEntryCountByToken.get(tokenKey) ?? 0;
  const marketOrderCount = snapshot.buyEntryCountByMarket.get(marketKey) ?? 0;

  if (nextFamilyBuyUsdc > policy.maxRestingBuyReservationUsdc + EPSILON) {
    rejectionReasons.push("resting-family-reservation-cap");
  } else {
    checksPassed.push("resting-family-reservation-ok");
  }

  if (tokenOrderCount >= policy.maxUnfilledOrdersPerToken) {
    rejectionReasons.push("resting-token-order-cap");
  } else {
    checksPassed.push("resting-token-order-ok");
  }

  if (marketOrderCount >= policy.maxUnfilledOrdersPerMarket) {
    rejectionReasons.push("resting-market-order-cap");
  } else {
    checksPassed.push("resting-market-order-ok");
  }
}

function resolveBuyMakerTarget(opts: {
  readonly bestBid: number | null;
  readonly bestAsk: number;
  readonly tickSize: number;
  readonly spread: number | null;
  readonly policy: MarketabilityPolicy;
}): number | null {
  const { bestBid, bestAsk, tickSize, spread, policy } = opts;
  const ceiling = bestAsk - tickSize;
  if (!isValidLimitPrice(ceiling, tickSize)) return null;
  if (bestBid == null || spread == null || spread <= tickSize + EPSILON) return ceiling;

  const desired =
    spread <= 0.005 + EPSILON
      ? ceiling
      : bestBid + Math.max(1, policy.makerImprovementTicks) * tickSize;
  const improvementCap = bestBid + policy.maxPriceImprovementCents;
  return Math.min(desired, improvementCap, ceiling);
}

function resolveSellMakerTarget(opts: {
  readonly bestBid: number;
  readonly bestAsk: number | null;
  readonly tickSize: number;
  readonly spread: number | null;
  readonly policy: MarketabilityPolicy;
}): number | null {
  const { bestBid, bestAsk, tickSize, spread, policy } = opts;
  const floor = bestBid + tickSize;
  if (!isValidLimitPrice(floor, tickSize)) return null;
  if (bestAsk == null || spread == null || spread <= tickSize + EPSILON) return floor;

  const desired =
    spread <= 0.005 + EPSILON
      ? floor
      : bestAsk - Math.max(1, policy.makerImprovementTicks) * tickSize;
  const improvementFloor = bestAsk - policy.maxPriceImprovementCents;
  return Math.max(desired, improvementFloor, floor);
}

function buildDiagnostics(
  market: NormalizedMarket,
  nowMs: number,
  policy: MarketabilityPolicy,
): Readonly<Record<string, unknown>> {
  const spread =
    market.spread ??
    (market.bestBid != null && market.bestAsk != null ? market.bestAsk - market.bestBid : null);
  return {
    tier: policy.tier,
    speedTier: policy.speedTier,
    bookSource: market.bookSource ?? "unknown",
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    spread,
    volume24h: market.volume24h ?? null,
    liquidity: market.liquidity ?? null,
    snapshotTs: market.snapshotTs,
    bookAgeMs: Math.max(0, nowMs - market.snapshotTs),
  };
}

function fallbackPricePolicy(): MarketabilityPolicy {
  return FALLBACK_POLICY;
}

function isEntrySignal(signal: Pick<Signal, "side" | "reason">): boolean {
  return signal.side === "buy" && ENTRY_REASONS.has(signal.reason);
}

function isOpenBuyEntryOrder(order: Order): boolean {
  return (
    order.side === "buy" && order.signalReason != null && ENTRY_REASONS.has(order.signalReason)
  );
}

function roundDownToTick(value: number, tickSize: number): number {
  const precision = getTickPrecision(tickSize);
  const units = Math.floor((value + EPSILON) / tickSize);
  return Number((units * tickSize).toFixed(precision));
}

function roundUpToTick(value: number, tickSize: number): number {
  const precision = getTickPrecision(tickSize);
  const units = Math.ceil((value - EPSILON) / tickSize);
  return Number((units * tickSize).toFixed(precision));
}

function getTickPrecision(tickSize: number): number {
  const [, decimals = ""] = tickSize.toString().split(".");
  return decimals.length;
}

function isValidLimitPrice(price: number, tickSize: number): boolean {
  return price >= tickSize - EPSILON && price <= 1 - tickSize + EPSILON;
}
