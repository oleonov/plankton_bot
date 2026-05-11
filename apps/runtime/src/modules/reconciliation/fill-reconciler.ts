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
  ConditionId,
  ExchangeFill,
  MarketFeeInfo,
  OrderId,
  ClientOrderId,
  Order,
} from "@krabs/domain";
import {
  createFillId,
  createOrderId,
  computePolymarketTakerFeeUsdc,
  resolvePolymarketTakerFeeRate,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";

// Bounded FIFO cache that dedupes orphan-fill log warnings. Without a cap
// the Set grew unbounded over uptime (prod crash loop exposed this). 5000
// entries ≈ tens of KB; beyond that we accept the rare duplicate warning.
const ORPHAN_LOG_MAX = 5000;
const loggedOrphanFillIds = new Set<string>();

function rememberOrphanFillId(fillId: string): boolean {
  if (loggedOrphanFillIds.has(fillId)) return false;
  if (loggedOrphanFillIds.size >= ORPHAN_LOG_MAX) {
    const oldest = loggedOrphanFillIds.values().next().value;
    if (oldest !== undefined) loggedOrphanFillIds.delete(oldest);
  }
  loggedOrphanFillIds.add(fillId);
  return true;
}

function isDuplicateFillConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const maybe = error as { code?: unknown; message?: unknown };
  return (
    maybe.code === "SQLITE_CONSTRAINT_PRIMARYKEY" &&
    typeof maybe.message === "string" &&
    maybe.message.includes("fills.fill_id")
  );
}

// ─── Shared fill import (DRY) ─────────────────────────────────────────────

export interface ImportFillsDeps {
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  bus: EventBus;
  log: Logger;
  /**
   * Optional V2 fee-metadata gateway. When present, the reconciler resolves
   * per-condition `MarketFeeInfo` once per import batch and feeds it into
   * the fee math, so the V1 category-fallback table is only used when the
   * exchange has no fee metadata.
   */
  gateway?: Pick<ExchangeGateway, "getMarketFeeInfo">;
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
  localOrder: Pick<
    Order,
    "orderId" | "conditionId" | "signalId" | "signalReason" | "decisionRuleId" | "signalTimestamp"
  >,
  primaryCategory?: string,
  feeInfo?: MarketFeeInfo | null,
): {
  fill: Fill;
  fillId: FillId;
  orderId: OrderId;
  conditionId: ConditionId;
  sizeUsdc: number;
  signalReason: string | null;
} {
  const fillId = createFillId(fill.fillId);

  const { rate, exponent } = resolvePolymarketTakerFeeRate({
    feeRateBps: fill.feeRateBps ?? 0,
    category: primaryCategory,
    feeInfo,
  });

  const grossSize: number =
    Number.isFinite(fill.grossSize) && (fill.grossSize ?? 0) > 0
      ? (fill.grossSize as number)
      : fill.size;
  const size = grossSize;

  const sizeUsdc = fill.sizeUsdc ?? grossSize * fill.price;

  const recomputedFeeUsdc =
    feeInfo && fill.liquidityRole !== "maker"
      ? computePolymarketTakerFeeUsdc({ grossSize, price: fill.price, rate, exponent })
      : null;
  const fee =
    fill.liquidityRole === "maker"
      ? 0
      : (recomputedFeeUsdc ?? (fill.fee || grossSize * rate * fill.price * (1 - fill.price)));

  return {
    fill: {
      fillId,
      orderId: localOrder.orderId,
      tokenId: fill.tokenId,
      conditionId: localOrder.conditionId,
      side: fill.side,
      price: fill.price,
      size,
      sizeUsdc,
      liquidityRole: fill.liquidityRole,
      fee,
      feeRateBps: fill.feeRateBps,
      signalId: localOrder.signalId ?? null,
      decisionRuleId: localOrder.decisionRuleId ?? null,
      signalTimestamp: localOrder.signalTimestamp ?? null,
      filledAt: new Date(fill.timestamp).toISOString(),
    },
    fillId,
    orderId: localOrder.orderId,
    conditionId: localOrder.conditionId,
    sizeUsdc,
    signalReason: localOrder.signalReason ?? null,
  };
}

// Sub-share rounding tolerance when comparing cumulative filled against
// `order.size`. Polymarket prices come at tick=0.01 / 0.001 / 0.0001 and the
// share-fee model multiplies through tiny rates, so direct equality on
// JS doubles can leave us ~1e-12 short of the gross target on a perfectly
// filled BUY. 1e-9 shares is well below the per-fill min and avoids spurious
// `partially-filled`.
const FILL_GROSS_EPSILON = 1e-9;

/**
 * Recover gross shares from legacy taker-BUY fill rows that were persisted
 * before 2026-05-11 with the fee deducted from `fill.size`. New rows store
 * exchange/wallet shares directly, so this path becomes a harmless no-op.
 *
 * Without this, `cumulativeFilled >= localOrder.size` is never true for a
 * fully-executed taker BUY: the order stays `partially-filled` forever, and
 * `OrderRepository.sumOpenBuyNotional()` keeps reserving its full notional
 * — silently strangling new BUY budget over uptime.
 */
function grossFillSize(fill: {
  readonly side: "buy" | "sell";
  readonly size: number;
  readonly price: number;
  readonly sizeUsdc?: number;
  readonly liquidityRole?: string;
}): number {
  if (
    fill.side === "buy" &&
    fill.liquidityRole === "taker" &&
    typeof fill.sizeUsdc === "number" &&
    fill.sizeUsdc > 0 &&
    fill.price > 0
  ) {
    return fill.sizeUsdc / fill.price;
  }
  return fill.size;
}

export function updateOrderStatusFromPersistedFills(
  orderRepo: Pick<OrderRepository, "findById" | "updateStatus">,
  fillRepo: Pick<FillRepository, "findByOrderId">,
  orderId: OrderId,
): void {
  const allFills = fillRepo.findByOrderId(orderId);
  const cumulativeFilled = allFills.reduce((sum, fill) => sum + grossFillSize(fill), 0);
  const localOrder = orderRepo.findById(orderId);
  if (!localOrder) return;

  if (cumulativeFilled + FILL_GROSS_EPSILON >= localOrder.size) {
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
  const { fillRepo, orderRepo, bus, log, gateway } = deps;
  let imported = 0;
  let skipped = 0;
  const details: string[] = [];

  const feeInfoByCondition = new Map<string, MarketFeeInfo | null>();
  async function resolveFeeInfo(conditionId: string): Promise<MarketFeeInfo | null> {
    if (!gateway?.getMarketFeeInfo) return null;
    if (feeInfoByCondition.has(conditionId)) return feeInfoByCondition.get(conditionId) ?? null;
    const info = await gateway.getMarketFeeInfo(conditionId);
    feeInfoByCondition.set(conditionId, info);
    return info;
  }

  // Track which orders received new fills for status update
  const ordersWithNewFills = new Set<string>();

  // Collect saved fills for deferred FillReceived publish
  const savedFills: Array<{
    ef: ExchangeFill;
    fillId: FillId;
    orderId: OrderId;
    conditionId: ConditionId;
    sizeUsdc: number;
    signalReason: string | null;
    signalId: string | null;
    decisionRuleId: string | null;
    signalTimestamp: string | null;
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
      if (rememberOrphanFillId(ef.fillId)) {
        log.warn({ fillId: ef.fillId }, msg);
      } else {
        log.debug({ fillId: ef.fillId }, "orphan fill already logged — suppressing repeat warning");
      }
      continue;
    }

    const feeInfo = await resolveFeeInfo(localOrder.conditionId);
    const resolved = buildLocalFillFromExchangeFill(ef, localOrder, undefined, feeInfo);

    if (fillRepo.exists(fillId)) {
      skipped++;
      continue;
    }

    try {
      fillRepo.save(resolved.fill);
    } catch (error) {
      if (isDuplicateFillConstraintError(error)) {
        skipped++;
        log.debug({ fillId: ef.fillId }, "duplicate fill observed during import — skipped");
        continue;
      }
      throw error;
    }
    imported++;
    ordersWithNewFills.add(String(resolved.orderId));
    savedFills.push({
      ef,
      fillId: resolved.fillId,
      orderId: resolved.orderId,
      conditionId: localOrder.conditionId,
      sizeUsdc: resolved.sizeUsdc,
      signalReason: resolved.signalReason,
      signalId: localOrder.signalId ?? null,
      decisionRuleId: localOrder.decisionRuleId ?? null,
      signalTimestamp: localOrder.signalTimestamp ?? null,
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
  for (const saved of savedFills) {
    const { ef, fillId, orderId, conditionId, sizeUsdc, signalReason } = saved;
    const feeInfo = feeInfoByCondition.get(String(conditionId)) ?? null;
    const resolved = buildLocalFillFromExchangeFill(ef, saved, undefined, feeInfo);

    await bus.publish("FillReceived", {
      fillId,
      orderId,
      clientOrderId: ef.clientOrderId as ClientOrderId,
      tokenId: ef.tokenId,
      conditionId,
      side: ef.side,
      price: ef.price,
      size: resolved.fill.size,
      sizeUsdc,
      liquidityRole: ef.liquidityRole,
      fee: resolved.fill.fee,
      feeRateBps: ef.feeRateBps,
      signalReason,
      signalId: saved.signalId,
      decisionRuleId: saved.decisionRuleId,
      signalTimestamp: saved.signalTimestamp,
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

  const result = await importExchangeFills(exchangeFills, {
    fillRepo,
    orderRepo,
    bus,
    log,
    gateway,
  });

  return {
    exchangeFillCount: exchangeFills.length,
    missingFillsImported: result.imported,
    details: result.details,
  };
}
