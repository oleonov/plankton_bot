const SIZE_EPSILON = 1e-9;

export const DEFAULT_SELL_TIMEOUT_MS = 6 * 60 * 60_000;

export type ExpectedTotalSells = 1 | 2 | 3 | 4;

export interface SellSizingPosition {
  readonly size: number;
  readonly avgEntryPrice: number;
  readonly costBasisUsdc: number;
}

export interface SellOrderSizingContext {
  readonly size: number;
  readonly fillProgressShares?: number | null;
  readonly createdAt: string;
  readonly status?: string | null;
  readonly cancelReason?: string | null;
}

export type SellMinOrderClampReason = "intent-below-min" | "orphan-residual" | "position-below-min";

export type SellMinOrderNormalization =
  | {
      readonly kind: "accept";
      readonly size: number;
      readonly reason: null;
    }
  | {
      readonly kind: "clamp";
      readonly size: number;
      readonly reason: Exclude<SellMinOrderClampReason, "position-below-min">;
    }
  | {
      readonly kind: "unsellable";
      readonly size: number;
      readonly reason: "position-below-min";
    };

export interface SellSizingPlan {
  readonly sellNumberInSequence: number;
  readonly baseTotalSells: ExpectedTotalSells;
  readonly expectedTotalSells: ExpectedTotalSells;
  readonly size: number;
  readonly sizeUsdc: number;
  readonly timeoutEscalated: boolean;
  readonly latestSellAgeMs: number | null;
  readonly inferredCurrentTier: ExpectedTotalSells | null;
  readonly clampReason: SellMinOrderClampReason | null;
}

const PLANKTON_FRACTIONS: Record<ExpectedTotalSells, readonly number[]> = {
  1: [],
  2: [0.4358],
  3: [0.2716, 0.3676],
  4: [0.1533, 0.2342, 0.3648],
};

const CHEAP_ENTRY_FIRST_SELL_FRACTION = 0.0703;

const TIMEOUT_ESCALATABLE_CANCEL_REASONS = new Set([
  "stale_exit_ttl",
  "sell_timeout_escalation",
  "sell_replace_reprice",
  "sell_replace_retry",
  "downpriced_reprice",
]);

export function estimateTotalSells(costBasisUsdc: number): ExpectedTotalSells {
  if (!Number.isFinite(costBasisUsdc) || costBasisUsdc < 20) return 1;
  if (costBasisUsdc <= 50) return 2;
  if (costBasisUsdc <= 100) return 3;
  return 4;
}

export function computeSellSize(args: {
  readonly position: SellSizingPosition;
  readonly sellNumberInSequence: number;
  readonly expectedTotalSells: ExpectedTotalSells;
  readonly marketMinOrderSize?: number | null | undefined;
}): number {
  const positionSize = normalizeSize(args.position.size);
  if (positionSize <= SIZE_EPSILON) return 0;

  const sellNumber = normalizeSellNumber(args.sellNumberInSequence);
  if (sellNumber >= args.expectedTotalSells) return positionSize;

  const fraction = sellFraction(args.position, sellNumber, args.expectedTotalSells);
  const desiredSize = Math.min(positionSize, positionSize * fraction);
  const normalized = normalizeSellSizeForMinOrder({
    availableSize: positionSize,
    desiredSize,
    marketMinOrderSize: args.marketMinOrderSize,
  });

  return normalized.kind === "clamp" ? normalized.size : desiredSize;
}

export function computeSellSizingPlan(args: {
  readonly position: SellSizingPosition;
  readonly sellCount: number;
  readonly price: number;
  readonly nowMs: number;
  readonly marketMinOrderSize?: number | null | undefined;
  readonly latestSellOrder?: SellOrderSizingContext | null;
  readonly sellTimeoutMs?: number | null | undefined;
}): SellSizingPlan {
  const sellNumberInSequence = normalizeSellNumber(args.sellCount + 1);
  const baseTotalSells = estimateTotalSells(args.position.costBasisUsdc);
  const timeout = normalizeTimeoutMs(args.sellTimeoutMs);
  const timeoutState = resolveTimeoutEscalation({
    position: args.position,
    sellNumberInSequence,
    baseTotalSells,
    marketMinOrderSize: args.marketMinOrderSize,
    latestSellOrder: args.latestSellOrder ?? null,
    nowMs: args.nowMs,
    sellTimeoutMs: timeout,
  });
  const expectedTotalSells = timeoutState.expectedTotalSells;
  const rawSize = computeSellSize({
    position: args.position,
    sellNumberInSequence,
    expectedTotalSells,
    marketMinOrderSize: args.marketMinOrderSize,
  });
  const normalized = normalizeSellSizeForMinOrder({
    availableSize: args.position.size,
    desiredSize: rawSize,
    marketMinOrderSize: args.marketMinOrderSize,
  });
  const size = normalized.kind === "clamp" ? normalized.size : rawSize;
  const price = Number.isFinite(args.price) && args.price > 0 ? args.price : 0;

  return {
    sellNumberInSequence,
    baseTotalSells,
    expectedTotalSells,
    size,
    sizeUsdc: size * price,
    timeoutEscalated: timeoutState.timeoutEscalated,
    latestSellAgeMs: timeoutState.latestSellAgeMs,
    inferredCurrentTier: timeoutState.inferredCurrentTier,
    clampReason: normalized.kind === "accept" ? null : normalized.reason,
  };
}

export function normalizeSellSizeForMinOrder(args: {
  readonly availableSize: number;
  readonly desiredSize: number;
  readonly marketMinOrderSize?: number | null | undefined;
}): SellMinOrderNormalization {
  const availableSize = normalizeSize(args.availableSize);
  const desiredSize = Math.min(availableSize, normalizeSize(args.desiredSize));
  const minOrderSize = normalizeMinOrderSize(args.marketMinOrderSize);

  if (minOrderSize == null) {
    return { kind: "accept", size: desiredSize, reason: null };
  }

  if (availableSize + SIZE_EPSILON < minOrderSize) {
    return { kind: "unsellable", size: desiredSize, reason: "position-below-min" };
  }

  if (desiredSize + SIZE_EPSILON < minOrderSize) {
    return { kind: "clamp", size: availableSize, reason: "intent-below-min" };
  }

  const residualAfter = availableSize - desiredSize;
  if (residualAfter > SIZE_EPSILON && residualAfter + SIZE_EPSILON < minOrderSize) {
    return { kind: "clamp", size: availableSize, reason: "orphan-residual" };
  }

  return { kind: "accept", size: desiredSize, reason: null };
}

export function isPositionDust(
  positionSize: number,
  marketMinOrderSize?: number | null | undefined,
): boolean {
  const minOrderSize = normalizeMinOrderSize(marketMinOrderSize);
  if (minOrderSize == null) return false;
  return normalizeSize(positionSize) + SIZE_EPSILON < minOrderSize;
}

export function isSellTimeoutReplacement(args: {
  readonly existingOrder: SellOrderSizingContext;
  readonly requestedSize: number;
  readonly nowMs: number;
  readonly sellTimeoutMs?: number | null | undefined;
}): boolean {
  if (!isSellOrderTimedOut(args.existingOrder, args.nowMs, args.sellTimeoutMs)) return false;
  const existingRemainingSize = remainingOrderSize(args.existingOrder);
  return Math.abs(existingRemainingSize - args.requestedSize) > SIZE_EPSILON;
}

export function isSellOrderTimedOut(
  order: SellOrderSizingContext,
  nowMs: number,
  sellTimeoutMs?: number | null | undefined,
): boolean {
  if (!canEscalateOrder(order)) return false;
  const ageMs = sellOrderAgeMs(order, nowMs);
  const timeout = normalizeTimeoutMs(sellTimeoutMs);
  return ageMs != null && ageMs >= timeout;
}

export function sellOrderAgeMs(order: SellOrderSizingContext, nowMs: number): number | null {
  const createdMs = Date.parse(order.createdAt);
  if (!Number.isFinite(createdMs)) return null;
  const ageMs = nowMs - createdMs;
  return ageMs >= 0 ? ageMs : null;
}

function resolveTimeoutEscalation(args: {
  readonly position: SellSizingPosition;
  readonly sellNumberInSequence: number;
  readonly baseTotalSells: ExpectedTotalSells;
  readonly marketMinOrderSize?: number | null | undefined;
  readonly latestSellOrder: SellOrderSizingContext | null;
  readonly nowMs: number;
  readonly sellTimeoutMs: number;
}): {
  readonly expectedTotalSells: ExpectedTotalSells;
  readonly timeoutEscalated: boolean;
  readonly latestSellAgeMs: number | null;
  readonly inferredCurrentTier: ExpectedTotalSells | null;
} {
  const latestSellAgeMs = args.latestSellOrder
    ? sellOrderAgeMs(args.latestSellOrder, args.nowMs)
    : null;
  if (
    !args.latestSellOrder ||
    !isSellOrderTimedOut(args.latestSellOrder, args.nowMs, args.sellTimeoutMs)
  ) {
    return {
      expectedTotalSells: args.baseTotalSells,
      timeoutEscalated: false,
      latestSellAgeMs,
      inferredCurrentTier: null,
    };
  }

  const inferredCurrentTier = inferExpectedTotalFromOrderSize({
    position: args.position,
    sellNumberInSequence: args.sellNumberInSequence,
    baseTotalSells: args.baseTotalSells,
    marketMinOrderSize: args.marketMinOrderSize,
    orderSize: remainingOrderSize(args.latestSellOrder),
  });
  const expectedTotalSells = clampExpectedTotalSells(
    Math.max(args.baseTotalSells, inferredCurrentTier + 1),
  );

  return {
    expectedTotalSells,
    timeoutEscalated: expectedTotalSells > args.baseTotalSells,
    latestSellAgeMs,
    inferredCurrentTier,
  };
}

function inferExpectedTotalFromOrderSize(args: {
  readonly position: SellSizingPosition;
  readonly sellNumberInSequence: number;
  readonly baseTotalSells: ExpectedTotalSells;
  readonly marketMinOrderSize?: number | null | undefined;
  readonly orderSize: number;
}): ExpectedTotalSells {
  const orderSize = normalizeSize(args.orderSize);
  if (orderSize <= SIZE_EPSILON) return args.baseTotalSells;

  let bestTier: ExpectedTotalSells = args.baseTotalSells;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (const tier of [1, 2, 3, 4] as const) {
    const candidateSize = computeSellSize({
      position: args.position,
      sellNumberInSequence: args.sellNumberInSequence,
      expectedTotalSells: tier,
      marketMinOrderSize: args.marketMinOrderSize,
    });
    const diff = Math.abs(candidateSize - orderSize);
    if (
      diff + SIZE_EPSILON < bestDiff ||
      (Math.abs(diff - bestDiff) <= SIZE_EPSILON && tier > bestTier)
    ) {
      bestDiff = diff;
      bestTier = tier;
    }
  }

  return bestTier;
}

function sellFraction(
  position: SellSizingPosition,
  sellNumberInSequence: number,
  expectedTotalSells: ExpectedTotalSells,
): number {
  if (
    expectedTotalSells > 1 &&
    sellNumberInSequence === 1 &&
    Number.isFinite(position.avgEntryPrice) &&
    position.avgEntryPrice < 0.05
  ) {
    return CHEAP_ENTRY_FIRST_SELL_FRACTION;
  }
  return PLANKTON_FRACTIONS[expectedTotalSells][sellNumberInSequence - 1] ?? 0.3;
}

function canEscalateOrder(order: SellOrderSizingContext): boolean {
  const status = order.status ?? null;
  if (status === "filled" || status === "rejected") return false;
  if (status === "cancelled") {
    return order.cancelReason == null || TIMEOUT_ESCALATABLE_CANCEL_REASONS.has(order.cancelReason);
  }
  return true;
}

function remainingOrderSize(order: SellOrderSizingContext): number {
  return Math.max(0, order.size - normalizeSize(order.fillProgressShares ?? 0));
}

function normalizeSellNumber(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function normalizeSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function normalizeMinOrderSize(value?: number | null): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function normalizeTimeoutMs(value?: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SELL_TIMEOUT_MS;
  }
  return value;
}

function clampExpectedTotalSells(value: number): ExpectedTotalSells {
  if (value <= 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  return 4;
}
