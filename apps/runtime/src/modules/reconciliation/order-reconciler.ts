/**
 * Order Reconciler — diffs local open orders against exchange open orders.
 *
 * Detects:
 *  - Phantom orders: local orders marked open that no longer exist on the exchange
 *  - Unknown exchange orders: orders on the exchange with no local record
 *
 * Exchange is source of truth. Phantom local orders are marked cancelled.
 * Unknown exchange orders are logged but not fabricated locally (we lack familyId).
 */

import type { ExchangeGateway, OrderRepository } from "@plankton/domain";
import type { Logger } from "../../logger.js";

export interface OrderReconcilerDeps {
  gateway: ExchangeGateway;
  orderRepo: OrderRepository;
  log: Logger;
}

export interface OrderReconcileResult {
  exchangeOpenCount: number;
  localOpenCount: number;
  phantomsCancelled: number;
  unknownExchangeOrders: number;
  details: string[];
}

export async function reconcileOrders(deps: OrderReconcilerDeps): Promise<OrderReconcileResult> {
  const { gateway, orderRepo, log } = deps;
  const details: string[] = [];

  const exchangeOrders = await gateway.getOpenOrders();
  const localOrders = orderRepo.findOpen();

  const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.orderId));
  const localExchangeIds = new Set(
    localOrders.filter((o) => o.exchangeOrderId !== null).map((o) => o.exchangeOrderId!),
  );

  // Phantom orders: local open orders not on exchange
  let phantomsCancelled = 0;
  for (const local of localOrders) {
    if (local.exchangeOrderId !== null && !exchangeOrderIds.has(local.exchangeOrderId)) {
      orderRepo.updateStatus(local.orderId, "cancelled");
      phantomsCancelled++;
      const msg = `phantom order cancelled: ${local.orderId} (exchange: ${local.exchangeOrderId})`;
      details.push(msg);
      log.warn({ orderId: local.orderId }, msg);
    }
  }

  // Unknown exchange orders: on exchange but not local
  let unknownExchangeOrders = 0;
  for (const ex of exchangeOrders) {
    if (!localExchangeIds.has(ex.orderId)) {
      unknownExchangeOrders++;
      const msg = `unknown exchange order: ${ex.orderId} (token: ${ex.tokenId}, side: ${ex.side})`;
      details.push(msg);
      log.warn({ exchangeOrderId: ex.orderId }, msg);
    }
  }

  return {
    exchangeOpenCount: exchangeOrders.length,
    localOpenCount: localOrders.length,
    phantomsCancelled,
    unknownExchangeOrders,
    details,
  };
}
