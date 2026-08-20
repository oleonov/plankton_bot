import type {
  ClientOrderId,
  ConditionId,
  FillRepository,
  Order,
  Position,
  TokenId,
} from "@krabs/domain";
import { GATE_ENTRY_RULE_ID } from "@krabs/domain";
import { classifySellCapacitySource } from "../../wallet-buy-budget.js";

const OPEN_ORDER_STATUSES = new Set(["pending", "open", "partially-filled"]);
type ReservationFillLookup = Pick<FillRepository, "findByOrderId" | "findByOrderIds">;

export interface PendingReservation {
  /** Always supplied by Execution; optional only for backward-compatible test/adapter callers. */
  clientOrderId?: ClientOrderId;
  /** Always supplied by Execution; missing external values are counted conservatively as unknown. */
  conditionId?: ConditionId;
  tokenId: TokenId;
  side: "buy" | "sell";
  size: number;
  price: number;
  decisionRuleId?: string | null | undefined;
  signalReason?: string | null | undefined;
  metadata?: Readonly<Record<string, unknown>> | null | undefined;
  entryStyle?: "probe" | "maker" | null | undefined;
}

export interface ReservationSnapshot {
  reservedBuyUsdc: number;
  openBuyOrderCount: number;
  /** Open+in-flight BUY orders whose decisionRuleId is GATE_ENTRY (for the GATE sub-cap). */
  openGateBuyOrderCount: number;
  openSellOrderCount: number;
  openProfileLadderSellOrderCount: number;
  openNonProfileLadderSellOrderCount: number;
  openOrdersTotal: number;
  openBuyOrdersByToken: Map<string, number>;
  openSellOrdersByToken: Map<string, number>;
  reservedSellByToken: Map<string, number>;
}

export function buildReservationSnapshot(
  openOrders: Order[],
  fillRepo: ReservationFillLookup,
  pendingReservations: Iterable<PendingReservation> = [],
): ReservationSnapshot {
  const snapshot: ReservationSnapshot = {
    reservedBuyUsdc: 0,
    openBuyOrderCount: 0,
    openGateBuyOrderCount: 0,
    openSellOrderCount: 0,
    openProfileLadderSellOrderCount: 0,
    openNonProfileLadderSellOrderCount: 0,
    openOrdersTotal: 0,
    openBuyOrdersByToken: new Map(),
    openSellOrdersByToken: new Map(),
    reservedSellByToken: new Map(),
  };
  const activeOpenOrders = openOrders.filter((order) => OPEN_ORDER_STATUSES.has(order.status));
  const filledSizeByOrderId = getFilledSizeByOrderId(activeOpenOrders, fillRepo);

  for (const order of activeOpenOrders) {
    addReservation(snapshot, {
      clientOrderId: order.clientOrderId,
      conditionId: order.conditionId,
      tokenId: order.tokenId,
      side: order.side,
      size: getRemainingOrderSize(order, filledSizeByOrderId),
      price: order.price,
      decisionRuleId: order.decisionRuleId,
      signalReason: order.signalReason,
      metadata: order.metadata,
    });
  }

  for (const pending of pendingReservations) {
    addReservation(snapshot, pending);
  }

  return snapshot;
}

export function getReservedSellSize(snapshot: ReservationSnapshot, tokenId: TokenId): number {
  return snapshot.reservedSellByToken.get(String(tokenId)) ?? 0;
}

export function getOpenOrderCountForToken(
  snapshot: ReservationSnapshot,
  tokenId: TokenId,
  side: "buy" | "sell",
): number {
  const map = side === "buy" ? snapshot.openBuyOrdersByToken : snapshot.openSellOrdersByToken;
  return map.get(String(tokenId)) ?? 0;
}

function getFilledSizeByOrderId(
  orders: Order[],
  fillRepo: ReservationFillLookup,
): Map<string, number> {
  if (orders.length === 0) return new Map();

  const fills =
    fillRepo.findByOrderIds?.(orders.map((order) => order.orderId)) ??
    orders.flatMap((order) => fillRepo.findByOrderId(order.orderId));
  const filledSizeByOrderId = new Map<string, number>();
  for (const fill of fills) {
    const key = String(fill.orderId);
    filledSizeByOrderId.set(key, (filledSizeByOrderId.get(key) ?? 0) + fill.size);
  }
  return filledSizeByOrderId;
}

function getRemainingOrderSize(order: Order, filledSizeByOrderId: Map<string, number>): number {
  const filled = filledSizeByOrderId.get(String(order.orderId)) ?? 0;
  return Math.max(0, order.size - filled);
}

function addReservation(snapshot: ReservationSnapshot, reservation: PendingReservation): void {
  if (reservation.size <= 0 || reservation.price <= 0) return;
  snapshot.openOrdersTotal += 1;
  if (reservation.side === "buy") {
    snapshot.reservedBuyUsdc += reservation.size * reservation.price;
    snapshot.openBuyOrderCount += 1;
    if (reservation.decisionRuleId === GATE_ENTRY_RULE_ID) {
      snapshot.openGateBuyOrderCount += 1;
    }
    increment(snapshot.openBuyOrdersByToken, reservation.tokenId);
    return;
  }
  snapshot.openSellOrderCount += 1;
  const source = classifySellCapacitySource(reservation);
  if (source === "profile_ladder") {
    snapshot.openProfileLadderSellOrderCount += 1;
  } else {
    snapshot.openNonProfileLadderSellOrderCount += 1;
  }
  increment(snapshot.openSellOrdersByToken, reservation.tokenId);
  const key = String(reservation.tokenId);
  snapshot.reservedSellByToken.set(
    key,
    (snapshot.reservedSellByToken.get(key) ?? 0) + reservation.size,
  );
}

function increment(map: Map<string, number>, tokenId: TokenId): void {
  const key = String(tokenId);
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Compute the total open-order USDC exposure from maker BUY orders (remaining size × price).
 * Used by the micro-live cap enforcement in the execution module.
 */
export function computeMakerOpenOrderUsdc(
  openOrders: Order[],
  fillRepo: ReservationFillLookup,
): number {
  const makerBuyOrders = openOrders.filter(
    (o) => o.entryStyle === "maker" && o.side === "buy" && OPEN_ORDER_STATUSES.has(o.status),
  );
  if (makerBuyOrders.length === 0) return 0;
  const filledSizeByOrderId = getFilledSizeByOrderId(makerBuyOrders, fillRepo);
  return makerBuyOrders.reduce((sum, o) => {
    const remaining = getRemainingOrderSize(o, filledSizeByOrderId);
    return sum + remaining * o.price;
  }, 0);
}

/**
 * Compute the total USDC cost basis from open maker positions.
 * Used alongside computeMakerOpenOrderUsdc for the microMaxOpenUsdc cap.
 */
export function computeMakerOpenPositionUsdc(
  openPositions: Pick<Position, "entryStyle" | "costBasisUsdc">[],
): number {
  return openPositions
    .filter((p) => p.entryStyle === "maker")
    .reduce((sum, p) => sum + p.costBasisUsdc, 0);
}

/**
 * Compute the total USDC notional of pending (in-flight, not yet persisted)
 * maker BUY reservations. Used alongside computeMakerOpenOrderUsdc for the
 * microMaxOpenUsdc cap to prevent concurrent queued maker BUYs from breaching
 * the cap before their orders are written to the DB.
 */
export function computeMakerPendingReservationUsdc(
  pendingReservations: Iterable<PendingReservation>,
): number {
  let total = 0;
  for (const r of pendingReservations) {
    if (r.side === "buy" && r.entryStyle === "maker" && r.size > 0 && r.price > 0) {
      total += r.size * r.price;
    }
  }
  return total;
}
