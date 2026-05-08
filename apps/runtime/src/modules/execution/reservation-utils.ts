import type { FillRepository, Order, TokenId } from "@plankton/domain";

const OPEN_ORDER_STATUSES = new Set(["pending", "open", "partially-filled"]);
type ReservationFillLookup = Pick<FillRepository, "findByOrderId" | "findByOrderIds">;

export interface PendingReservation {
  tokenId: TokenId;
  side: "buy" | "sell";
  size: number;
  price: number;
}

export interface ReservationSnapshot {
  reservedBuyUsdc: number;
  openBuyOrderCount: number;
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
    reservedSellByToken: new Map(),
  };
  const activeOpenOrders = openOrders.filter((order) => OPEN_ORDER_STATUSES.has(order.status));
  const filledSizeByOrderId = getFilledSizeByOrderId(activeOpenOrders, fillRepo);

  for (const order of activeOpenOrders) {
    addReservation(snapshot, {
      tokenId: order.tokenId,
      side: order.side,
      size: getRemainingOrderSize(order, filledSizeByOrderId),
      price: order.price,
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
  if (reservation.side === "buy") {
    snapshot.reservedBuyUsdc += reservation.size * reservation.price;
    snapshot.openBuyOrderCount += 1;
    return;
  }
  const key = String(reservation.tokenId);
  snapshot.reservedSellByToken.set(
    key,
    (snapshot.reservedSellByToken.get(key) ?? 0) + reservation.size,
  );
}
