/**
 * Fill Reconciler — imports exchange fills missing from local DB.
 *
 * Exchange is source of truth. For each exchange fill not found locally,
 * the fill is persisted and applied through InventoryHandler exactly once.
 *
 * Dedup: builds a Set of known local fill IDs from fillRepo.findByOrderId()
 * for each relevant order, avoiding duplicate imports.
 */

import type {
  ExchangeGateway,
  FillRepository,
  OrderRepository,
  Fill,
  FillId,
  ExchangeFill,
} from "@plankton/domain";
import {
  createFillId,
  createOrderId,
  createTokenId,
  createFamilyId,
} from "@plankton/domain";
import type { InventoryHandler } from "../risk-inventory/inventory-handler.js";
import type { Logger } from "../../logger.js";

export interface FillReconcilerDeps {
  gateway: ExchangeGateway;
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  inventoryHandler: InventoryHandler;
  log: Logger;
}

export interface FillReconcileResult {
  exchangeFillCount: number;
  missingFillsImported: number;
  details: string[];
}

export async function reconcileFills(
  deps: FillReconcilerDeps,
  sinceMs: number,
): Promise<FillReconcileResult> {
  const { gateway, fillRepo, orderRepo, inventoryHandler, log } = deps;
  const details: string[] = [];

  const exchangeFills = await gateway.getFills(sinceMs);
  if (exchangeFills.length === 0) {
    return { exchangeFillCount: 0, missingFillsImported: 0, details };
  }

  // Build set of known local fill IDs by querying per-order
  const queriedOrders = new Set<string>();
  const knownFillIds = new Set<string>();

  for (const ef of exchangeFills) {
    if (!queriedOrders.has(ef.orderId)) {
      queriedOrders.add(ef.orderId);
      const localFills = fillRepo.findByOrderId(createOrderId(ef.orderId));
      for (const lf of localFills) {
        knownFillIds.add(String(lf.fillId));
      }
    }
  }

  let missingFillsImported = 0;

  for (const ef of exchangeFills) {
    if (knownFillIds.has(ef.fillId)) continue;

    // Look up the local order to get familyId
    const localOrder = orderRepo.findByClientOrderId(ef.clientOrderId);
    if (!localOrder) {
      const msg = `missing fill ${ef.fillId} has no matching local order (clientOrderId: ${ef.clientOrderId}) — skipped`;
      details.push(msg);
      log.warn({ fillId: ef.fillId }, msg);
      continue;
    }

    const fillId = createFillId(ef.fillId);
    const sizeUsdc = ef.size * ef.price;

    const fill: Fill = {
      fillId,
      orderId: createOrderId(ef.orderId),
      tokenId: ef.tokenId,
      familyId: localOrder.familyId,
      side: ef.side,
      price: ef.price,
      size: ef.size,
      sizeUsdc,
      fee: ef.fee,
      filledAt: new Date(ef.timestamp).toISOString(),
    };

    fillRepo.save(fill);

    // Apply through inventory handler
    try {
      inventoryHandler.applyFill({
        fillId,
        tokenId: ef.tokenId,
        familyId: localOrder.familyId,
        side: ef.side,
        price: ef.price,
        size: ef.size,
        sizeUsdc,
        fee: ef.fee,
        timestamp: ef.timestamp,
      });
    } catch (err) {
      const msg = `fill ${ef.fillId} imported but inventory apply failed: ${err}`;
      details.push(msg);
      log.error({ err, fillId: ef.fillId }, msg);
    }

    knownFillIds.add(ef.fillId);
    missingFillsImported++;

    const msg = `missing fill imported: ${ef.fillId} (order: ${ef.orderId}, side: ${ef.side}, size: ${ef.size})`;
    details.push(msg);
    log.info({ fillId: ef.fillId }, msg);
  }

  return {
    exchangeFillCount: exchangeFills.length,
    missingFillsImported,
    details,
  };
}
