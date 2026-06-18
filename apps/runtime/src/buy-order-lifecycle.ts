import { SignalReason, type Market, type Order, type PlaceOrderCommand } from "@krabs/domain";

export const BUY_DUPLICATE_DEDUPED_REASON = "buy_duplicate_deduped";
export const BUY_CAP_FULL_TARGETED_REPLACEMENT_REASON = "buy_cap_full_targeted_replacement";

export const HORIZON_TTL_MS: Record<string, number> = {
  "intraday-4h": 45 * 60_000,
  daily: 6 * 60 * 60_000,
  deadline: 24 * 60 * 60_000,
  "ad-hoc": 8 * 60 * 60_000,
};
export const DEFAULT_TTL_MS = 6 * 60 * 60_000;
export const PROBE_LIKE_INTRADAY_TTL_MS = 60_000;
export const PROBE_LIKE_DAILY_TTL_MS = 5 * 60_000;
export const PROBE_LIKE_AD_HOC_TTL_MS = 10 * 60_000;
export const CONFIRM_SCALE_TTL_MS = 3 * 60 * 60_000;
export const SCALE_IN_DEFAULT_TTL_MS = 3 * 60 * 60_000;

const PRICE_EPSILON = 1e-9;
const ADD_BUY_REASONS = new Set<string>([
  SignalReason.ConfirmScale,
  SignalReason.ScaleIn,
  SignalReason.HeavyScale,
]);

interface BuyCandidate {
  readonly tokenId: PlaceOrderCommand["tokenId"];
  readonly price: number;
  readonly decisionRuleId?: string | null;
  readonly signalReason?: string | null;
  readonly reason?: string | null;
  readonly source?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

type BuyOrderCandidate = Pick<
  Order,
  | "orderId"
  | "tokenId"
  | "side"
  | "status"
  | "price"
  | "signalReason"
  | "decisionRuleId"
  | "metadata"
>;

export function resolveEntryBuyOrderTtlMs(
  order: Pick<Order, "signalReason">,
  market: Pick<Market, "horizon"> | null,
): number {
  const horizon = market?.horizon ?? null;
  const horizonTtlMs =
    horizon != null ? (HORIZON_TTL_MS[horizon] ?? DEFAULT_TTL_MS) : DEFAULT_TTL_MS;

  if (order.signalReason === SignalReason.ProbeEntry) {
    if (horizon === "intraday-4h") return Math.min(horizonTtlMs, PROBE_LIKE_INTRADAY_TTL_MS);
    if (horizon === "daily") return Math.min(horizonTtlMs, PROBE_LIKE_DAILY_TTL_MS);
    if (horizon === "ad-hoc") return Math.min(horizonTtlMs, PROBE_LIKE_AD_HOC_TTL_MS);
    return Math.min(horizonTtlMs, PROBE_LIKE_AD_HOC_TTL_MS);
  }

  if (order.signalReason === SignalReason.ConfirmScale) {
    return Math.min(horizonTtlMs, CONFIRM_SCALE_TTL_MS);
  }

  if (
    order.signalReason === SignalReason.ScaleIn ||
    order.signalReason === SignalReason.HeavyScale
  ) {
    return Math.min(horizonTtlMs, SCALE_IN_DEFAULT_TTL_MS);
  }

  return horizonTtlMs;
}

export function findNearDuplicateOpenBuy(
  orders: readonly BuyOrderCandidate[],
  candidate: BuyCandidate,
  tickSize: number | null | undefined,
): BuyOrderCandidate | null {
  return (
    orders.find(
      (order) =>
        order.side === "buy" &&
        isOpenOrderStatus(order.status) &&
        order.tokenId === candidate.tokenId &&
        isSameBuyFamily(order, candidate) &&
        isNearPrice(order.price, candidate.price, tickSize),
    ) ?? null
  );
}

export function findDuplicateOpenBuyPair(
  orders: readonly Order[],
): { keep: Order; cancel: Order } | null {
  const openBuys = orders
    .filter((order) => order.side === "buy" && isOpenOrderStatus(order.status))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (let i = 0; i < openBuys.length; i += 1) {
    const first = openBuys[i]!;
    for (let j = i + 1; j < openBuys.length; j += 1) {
      const second = openBuys[j]!;
      if (first.tokenId !== second.tokenId) continue;
      if (!isSameBuyFamily(first, second)) continue;
      if (!isNearPrice(first.price, second.price, null)) continue;
      return { keep: first, cancel: second };
    }
  }
  return null;
}

export function findOldestStaleOpenBuy(
  orders: readonly Order[],
  marketForOrder: (order: Order) => Pick<Market, "horizon"> | null,
  nowMs: number,
): Order | null {
  let oldest: Order | null = null;
  let oldestAgeMs = -1;
  for (const order of orders) {
    if (order.side !== "buy" || !isOpenOrderStatus(order.status)) continue;
    const createdAtMs = Date.parse(order.createdAt);
    if (!Number.isFinite(createdAtMs)) continue;
    const ageMs = nowMs - createdAtMs;
    if (ageMs < resolveEntryBuyOrderTtlMs(order, marketForOrder(order))) continue;
    if (ageMs > oldestAgeMs) {
      oldest = order;
      oldestAgeMs = ageMs;
    }
  }
  return oldest;
}

export function isAddBuyReason(reason: string | null | undefined): boolean {
  return reason != null && ADD_BUY_REASONS.has(reason);
}

function isOpenOrderStatus(status: string): boolean {
  return status === "pending" || status === "open" || status === "partially-filled";
}

function isNearPrice(a: number, b: number, tickSize: number | null | undefined): boolean {
  const tolerance =
    typeof tickSize === "number" && Number.isFinite(tickSize) && tickSize > 0
      ? tickSize + PRICE_EPSILON
      : PRICE_EPSILON;
  return Math.abs(a - b) <= tolerance;
}

function isSameBuyFamily(existing: BuyOrderCandidate, candidate: BuyCandidate): boolean {
  if (normalizeReason(existing.signalReason) !== normalizeReason(candidateReason(candidate))) {
    return false;
  }
  const existingRule = normalizeOptional(existing.decisionRuleId);
  const candidateRule = normalizeOptional(candidate.decisionRuleId);
  if (!existingRule || !candidateRule || existingRule !== candidateRule) return false;

  const existingSource = normalizeOptional(sourceFromMetadata(existing.metadata));
  const candidateSource = normalizeOptional(
    sourceFromMetadata(candidate.metadata) ?? candidate.source ?? null,
  );
  return !existingSource || !candidateSource || existingSource === candidateSource;
}

function candidateReason(candidate: BuyCandidate): string | null | undefined {
  return candidate.signalReason ?? candidate.reason ?? null;
}

function normalizeReason(reason: string | null | undefined): string | null {
  return normalizeOptional(reason);
}

function normalizeOptional(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function sourceFromMetadata(metadata: Readonly<Record<string, unknown>> | null | undefined) {
  const value = metadata?.source;
  return typeof value === "string" ? value : null;
}
