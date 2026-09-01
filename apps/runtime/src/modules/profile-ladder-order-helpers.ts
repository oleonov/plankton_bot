import type { Order } from "@krabs/domain";

export const SELL_REPLACEMENT_CANCELLED_ORDER_ID_METADATA_KEY = "sellReplacementCancelledOrderId";

const WORKING_STATUSES = new Set(["pending", "open", "partially-filled"]);

export type ProfileLadderReplacementTargetValidation =
  | { ok: true; target: Order }
  | {
      ok: false;
      reason:
        | "sell-replace-duplicate-live-sell"
        | "sell-replace-required-order-incompatible"
        | "sell-replace-required-order-missing";
    };

export function orderMatchesOrderId(order: Order, orderId: string): boolean {
  return String(order.orderId) === orderId || order.exchangeOrderId === orderId;
}

export function isProfileLadderOrder(order: Order): boolean {
  const metadataSource = order.metadata?.source;
  return (
    order.decisionRuleId === "PROFILE_LADDER" ||
    order.signalReason === "profile-ladder-exit" ||
    metadataSource === "profile_ladder"
  );
}

export function isProfileLadderSellOrder(order: Order): boolean {
  return order.side === "sell" && isProfileLadderOrder(order);
}

export function hasWorkingProfileLadderSell(
  orders: readonly Order[],
  cycle: Pick<Order, "tokenId" | "conditionId" | "positionId">,
): boolean {
  return orders.some(
    (order) =>
      order.tokenId === cycle.tokenId &&
      order.conditionId === cycle.conditionId &&
      order.positionId === cycle.positionId &&
      WORKING_STATUSES.has(order.status) &&
      isProfileLadderSellOrder(order),
  );
}

export function validateProfileLadderReplacementSellTarget(
  oldOrderId: string,
  existingSells: readonly Order[],
): ProfileLadderReplacementTargetValidation {
  if (existingSells.length > 1) {
    return { ok: false, reason: "sell-replace-duplicate-live-sell" };
  }
  const target = existingSells.find((order) => orderMatchesOrderId(order, oldOrderId));
  if (target == null) {
    return { ok: false, reason: "sell-replace-required-order-missing" };
  }
  if (!isProfileLadderSellOrder(target)) {
    return { ok: false, reason: "sell-replace-required-order-incompatible" };
  }
  return { ok: true, target };
}
