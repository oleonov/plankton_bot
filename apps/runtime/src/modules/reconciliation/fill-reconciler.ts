/**
 * Fill Reconciler — imports exchange fills missing from local DB.
 *
 * Exchange is source of truth. For each exchange fill not found locally,
 * the fill is persisted and a FillReceived event published on the bus.
 *
 * Shared importExchangeFills() is the core import function used by both
 * FillPollerModule (hot path) and ReconciliationModule (safety net).
 */

import type {
  ExchangeGateway,
  FillRepository,
  OrderRepository,
  EventBus,
  Fill,
  FillId,
  FamilyId,
  ExchangeFill,
  OrderId,
  ClientOrderId,
} from "@plankton/domain";
import { createFillId, createOrderId } from "@plankton/domain";
import type { Logger } from "../../logger.js";

// ─── Shared fill import (DRY) ─────────────────────────────────────────────

export interface ImportFillsDeps {
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  bus: EventBus;
  log: Logger;
}

export interface ImportFillsResult {
  imported: number;
  skipped: number;
  details: string[];
}

/**
 * Import exchange fills into local DB. Updates order status first, then publishes
 * FillReceived for each new fill so that downstream handlers (e.g. in-flight
 * counter) see the terminal order status during the event.
 *
 * Used by both FillPollerModule (hot path) and reconcileFills (safety net).
 */
export async function importExchangeFills(
  fills: ExchangeFill[],
  deps: ImportFillsDeps,
): Promise<ImportFillsResult> {
  const { fillRepo, orderRepo, bus, log } = deps;
  let imported = 0;
  let skipped = 0;
  const details: string[] = [];

  // Track which orders received new fills for status update
  const ordersWithNewFills = new Set<string>();

  // Collect saved fills for deferred FillReceived publish
  const savedFills: Array<{
    ef: ExchangeFill;
    fillId: FillId;
    orderId: OrderId;
    sizeUsdc: number;
    familyId: FamilyId;
  }> = [];

  // Phase 1: Save fills to DB
  for (const ef of fills) {
    const fillId = createFillId(ef.fillId);

    if (fillRepo.exists(fillId)) {
      skipped++;
      continue;
    }

    let localOrder = orderRepo.findByClientOrderId(ef.clientOrderId);
    if (!localOrder && ef.orderId) {
      localOrder = orderRepo.findByExchangeOrderId(ef.orderId);
      if (localOrder) {
        log.info(
          { fillId: ef.fillId, exchangeOrderId: ef.orderId },
          "fill matched via exchangeOrderId fallback",
        );
      }
    }
    if (!localOrder) {
      skipped++;
      const msg = `fill ${ef.fillId} has no matching local order (clientOrderId: ${ef.clientOrderId}, orderId: ${ef.orderId}) — skipped`;
      details.push(msg);
      log.warn({ fillId: ef.fillId }, msg);
      continue;
    }

    const sizeUsdc = ef.size * ef.price;
    const orderId = createOrderId(ef.orderId);

    const fill: Fill = {
      fillId,
      orderId,
      tokenId: ef.tokenId,
      familyId: localOrder.familyId,
      side: ef.side,
      price: ef.price,
      size: ef.size,
      sizeUsdc,
      liquidityRole: ef.liquidityRole,
      fee: ef.fee,
      filledAt: new Date(ef.timestamp).toISOString(),
    };

    fillRepo.save(fill);
    imported++;
    ordersWithNewFills.add(ef.orderId);
    savedFills.push({ ef, fillId, orderId, sizeUsdc, familyId: localOrder.familyId });

    const msg = `fill imported: ${ef.fillId} (order: ${ef.orderId}, side: ${ef.side}, size: ${ef.size})`;
    details.push(msg);
    log.info({ fillId: ef.fillId }, msg);
  }

  // Phase 2: Update order statuses (before publishing events so handlers see terminal status)
  for (const oid of ordersWithNewFills) {
    const orderId = createOrderId(oid);
    const allFills = fillRepo.findByOrderId(orderId);
    const cumulativeFilled = allFills.reduce((sum, f) => sum + f.size, 0);
    const localOrder = orderRepo.findById(orderId);
    if (!localOrder) continue;
    if (cumulativeFilled >= localOrder.size) {
      orderRepo.updateStatus(orderId, "filled");
    } else if (cumulativeFilled > 0) {
      orderRepo.updateStatus(orderId, "partially-filled");
    }
  }

  // Phase 3: Publish FillReceived events (handlers now see correct order status)
  for (const { ef, fillId, orderId, sizeUsdc, familyId } of savedFills) {
    await bus.publish("FillReceived", {
      fillId,
      orderId,
      clientOrderId: ef.clientOrderId as ClientOrderId,
      tokenId: ef.tokenId,
      side: ef.side,
      price: ef.price,
      size: ef.size,
      sizeUsdc,
      liquidityRole: ef.liquidityRole,
      fee: ef.fee,
      familyId,
      timestamp: ef.timestamp,
    });
  }

  return { imported, skipped, details };
}

// ─── Reconciler (uses shared import) ──────────────────────────────────────

export interface FillReconcilerDeps {
  gateway: ExchangeGateway;
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  bus: EventBus;
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
  const { gateway, fillRepo, orderRepo, bus, log } = deps;

  const exchangeFills = await gateway.getFills(sinceMs);
  if (exchangeFills.length === 0) {
    return { exchangeFillCount: 0, missingFillsImported: 0, details: [] };
  }

  const result = await importExchangeFills(exchangeFills, { fillRepo, orderRepo, bus, log });

  return {
    exchangeFillCount: exchangeFills.length,
    missingFillsImported: result.imported,
    details: result.details,
  };
}
