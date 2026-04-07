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
  Order,
  FamilyRulesProvider,
} from "@plankton/domain";
import { createFillId, createOrderId } from "@plankton/domain";
import type { Logger } from "../../logger.js";

const loggedOrphanFillIds = new Set<string>();

const CATEGORY_RATES: Record<string, number> = {
  crypto: 0.072,
  sports: 0.03,
  finance: 0.04,
  politics: 0.04,
  geopolitics: 0,
};

// ─── Shared fill import (DRY) ─────────────────────────────────────────────

export interface ImportFillsDeps {
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  rulesProvider: FamilyRulesProvider;
  bus: EventBus;
  log: Logger;
}

export interface ImportFillsResult {
  imported: number;
  skipped: number;
  details: string[];
}

export function findLocalOrderForExchangeFill(
  orderRepo: Pick<OrderRepository, "findByClientOrderId" | "findByExchangeOrderId">,
  fill: ExchangeFill,
  log: Logger,
): Order | null {
  let localOrder = orderRepo.findByClientOrderId(fill.clientOrderId);
  if (!localOrder && fill.orderId) {
    localOrder = orderRepo.findByExchangeOrderId(fill.orderId);
    if (localOrder) {
      log.info(
        { fillId: fill.fillId, exchangeOrderId: fill.orderId },
        "fill matched via exchangeOrderId fallback",
      );
    }
  }
  return localOrder;
}

export function buildLocalFillFromExchangeFill(
  fill: ExchangeFill,
  localOrder: Pick<Order, "orderId" | "familyId" | "signalReason">,
  primaryCategory?: string,
): {
  fill: Fill;
  fillId: FillId;
  orderId: OrderId;
  sizeUsdc: number;
  familyId: FamilyId;
  signalReason: string | null;
} {
  const fillId = createFillId(fill.fillId);
  const sizeUsdc = fill.size * fill.price;

  // Use category-based rate if available, otherwise fallback to the rate from the exchange
  const category = primaryCategory?.toLowerCase();
  const rate =
    category && CATEGORY_RATES[category] !== undefined
      ? CATEGORY_RATES[category]
      : (fill.feeRateBps ?? 0) / 10_000;

  const fee = fill.liquidityRole === "maker" ? 0 : fill.size * rate * fill.price * (1 - fill.price);

  return {
    fill: {
      fillId,
      orderId: localOrder.orderId,
      tokenId: fill.tokenId,
      familyId: localOrder.familyId,
      side: fill.side,
      price: fill.price,
      size: fill.size,
      sizeUsdc,
      liquidityRole: fill.liquidityRole,
      fee,
      feeRateBps: fill.feeRateBps,
      filledAt: new Date(fill.timestamp).toISOString(),
    },
    fillId,
    orderId: localOrder.orderId,
    sizeUsdc,
    familyId: localOrder.familyId,
    signalReason: localOrder.signalReason ?? null,
  };
}

export function updateOrderStatusFromPersistedFills(
  orderRepo: Pick<OrderRepository, "findById" | "updateStatus">,
  fillRepo: Pick<FillRepository, "findByOrderId">,
  orderId: OrderId,
): void {
  const allFills = fillRepo.findByOrderId(orderId);
  const cumulativeFilled = allFills.reduce((sum, fill) => sum + fill.size, 0);
  const localOrder = orderRepo.findById(orderId);
  if (!localOrder) return;

  if (cumulativeFilled >= localOrder.size) {
    orderRepo.updateStatus(orderId, "filled");
  } else if (cumulativeFilled > 0) {
    orderRepo.updateStatus(orderId, "partially-filled");
  }
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
  const { fillRepo, orderRepo, rulesProvider, bus, log } = deps;
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
    signalReason: string | null;
  }> = [];

  // Phase 1: Save fills to DB
  for (const ef of fills) {
    const fillId = createFillId(ef.fillId);

    if (fillRepo.exists(fillId)) {
      skipped++;
      continue;
    }

    const localOrder = findLocalOrderForExchangeFill(orderRepo, ef, log);
    if (!localOrder) {
      skipped++;
      const msg = `fill ${ef.fillId} has no matching local order (clientOrderId: ${ef.clientOrderId}, orderId: ${ef.orderId}) — skipped`;
      details.push(msg);
      if (!loggedOrphanFillIds.has(ef.fillId)) {
        loggedOrphanFillIds.add(ef.fillId);
        log.warn({ fillId: ef.fillId }, msg);
      } else {
        log.debug({ fillId: ef.fillId }, "orphan fill already logged — suppressing repeat warning");
      }
      continue;
    }

    const rule = rulesProvider.getRule(localOrder.familyId);
    const resolved = buildLocalFillFromExchangeFill(ef, localOrder, rule?.identity.primaryCategory);

    fillRepo.save(resolved.fill);
    imported++;
    ordersWithNewFills.add(String(resolved.orderId));
    savedFills.push({
      ef,
      fillId: resolved.fillId,
      orderId: resolved.orderId,
      sizeUsdc: resolved.sizeUsdc,
      familyId: resolved.familyId,
      signalReason: resolved.signalReason,
    });

    const msg = `fill imported: ${ef.fillId} (order: ${ef.orderId}, side: ${ef.side}, size: ${ef.size}, role: ${ef.liquidityRole}, fee: ${resolved.fill.fee.toFixed(6)})`;
    details.push(msg);
    log.info({ fillId: ef.fillId }, msg);
  }

  // Phase 2: Update order statuses (before publishing events so handlers see terminal status)
  for (const oid of ordersWithNewFills) {
    updateOrderStatusFromPersistedFills(orderRepo, fillRepo, createOrderId(oid));
  }

  // Phase 3: Publish FillReceived events (handlers now see correct order status)
  for (const { ef, fillId, orderId, sizeUsdc, familyId, signalReason } of savedFills) {
    const rule = rulesProvider.getRule(familyId);
    const resolved = buildLocalFillFromExchangeFill(
      ef,
      { orderId, familyId, signalReason },
      rule?.identity.primaryCategory,
    );

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
      fee: resolved.fill.fee,
      feeRateBps: ef.feeRateBps,
      familyId,
      signalReason,
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
  rulesProvider: FamilyRulesProvider;
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
  const { gateway, fillRepo, orderRepo, rulesProvider, bus, log } = deps;

  const exchangeFills = await gateway.getFills(sinceMs);
  if (exchangeFills.length === 0) {
    return { exchangeFillCount: 0, missingFillsImported: 0, details: [] };
  }

  const result = await importExchangeFills(exchangeFills, {
    fillRepo,
    orderRepo,
    rulesProvider,
    bus,
    log,
  });

  return {
    exchangeFillCount: exchangeFills.length,
    missingFillsImported: result.imported,
    details: result.details,
  };
}
