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
  FetchReason,
  FetchResult,
  MarketFeeInfo,
  OrderId,
  Order,
} from "@krabs/domain";
import {
  createFillId,
  createOrderId,
  computePolymarketTakerFeeUsdc,
  resolvePolymarketTakerFeeRate,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import type { SubmitUnknownRecoveryContext } from "../execution/execution-module.js";
import {
  applyOrderVerdict,
  DEFAULT_FILL_COMPLETION_TOLERANCE,
  hasLocalFullCoverage,
  persistedGrossShares,
} from "./order-status-resolver.js";

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
  runtimeMetrics?:
    | { writeCounter?: (name: string, value?: number, labels?: string | null) => void }
    | undefined;
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
  /**
   * Relative completion tolerance for `filled` vs `partially-filled`. Default
   * {@link DEFAULT_FILL_COMPLETION_TOLERANCE}. `number | undefined` so hot-path
   * callers can forward their (possibly absent) operator config directly under
   * `exactOptionalPropertyTypes` without a conditional spread.
   */
  fillCompletionTolerance?: number | undefined;
  /** Hold exact-hash fills while an active live submission still awaits acknowledgement. */
  deferPendingExactFills?: boolean | undefined;
  recoveryContexts?: readonly SubmitUnknownRecoveryContext[] | undefined;
}

export interface ImportFillsResult {
  imported: number;
  skipped: number;
  deferred: number;
  deferredFillIds: string[];
  /** Orders with a deferred fill: their history is incomplete for the absence rule. */
  deferredOrderIds: string[];
  details: string[];
}

function isPendingExactOrderForExchangeFill(order: Order, fill: ExchangeFill): boolean {
  return order.status === "pending" && order.exchangeOrderId === fill.orderId;
}

export function findLocalOrderForExchangeFill(
  orderRepo: Pick<OrderRepository, "findByClientOrderId" | "findByExchangeOrderId">,
  fill: ExchangeFill,
  log: Logger,
): Order | null {
  if (fill.orderId) {
    const localOrder = orderRepo.findByExchangeOrderId(fill.orderId);
    if (localOrder) return localOrder;
  }
  if (fill.clientOrderId) {
    const localOrder = orderRepo.findByClientOrderId(fill.clientOrderId);
    if (localOrder) {
      log.info(
        { fillId: fill.fillId, clientOrderId: fill.clientOrderId },
        "fill matched via clientOrderId fallback",
      );
      return localOrder;
    }
  }
  return null;
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

export { DEFAULT_FILL_COMPLETION_TOLERANCE } from "./order-status-resolver.js";

export function updateOrderStatusFromPersistedFills(
  orderRepo: Pick<OrderRepository, "findById" | "updateStatus">,
  fillRepo: Pick<FillRepository, "findByOrderId">,
  orderId: OrderId,
  completionTolerance = DEFAULT_FILL_COMPLETION_TOLERANCE,
): void {
  const localOrder = orderRepo.findById(orderId);
  if (!localOrder) return;
  const cumulativeFilled = persistedGrossShares(fillRepo, localOrder);

  if (hasLocalFullCoverage(localOrder, cumulativeFilled, completionTolerance)) {
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
  const importStartedAt = Date.now();
  let imported = 0;
  let skipped = 0;
  let deferred = 0;
  const deferredFillIds: string[] = [];
  const deferredOrderIds = new Set<string>();
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
  const ordersWithNewFills = new Map<string, (() => boolean) | undefined>();

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
    clientOrderId: Order["clientOrderId"];
    isCurrent: (() => boolean) | undefined;
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

    const recovery = deps.recoveryContexts?.find(
      (context) => context.order.orderId === localOrder.orderId,
    );
    const recoveryAllowed = () =>
      Boolean(
        recovery?.isCurrent() &&
        recovery.order.exchangeOrderId === ef.orderId &&
        recovery.order.tokenId === ef.tokenId &&
        recovery.order.side === ef.side,
      );
    if (
      (recovery && !recoveryAllowed()) ||
      (deps.deferPendingExactFills &&
        isPendingExactOrderForExchangeFill(localOrder, ef) &&
        !recoveryAllowed())
    ) {
      deferred++;
      deferredFillIds.push(ef.fillId);
      deferredOrderIds.add(String(localOrder.orderId));
      const msg = `fill ${ef.fillId} exactly matches pending local order ${localOrder.orderId} — deferred until OrderPlaced`;
      details.push(msg);
      log.info({ fillId: ef.fillId, orderId: localOrder.orderId }, msg);
      continue;
    }

    const feeInfo = await resolveFeeInfo(localOrder.conditionId);
    if (recovery && !recoveryAllowed()) {
      deferred++;
      deferredFillIds.push(ef.fillId);
      deferredOrderIds.add(String(localOrder.orderId));
      continue;
    }
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
    ordersWithNewFills.set(String(resolved.orderId), recovery?.isCurrent);
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
      clientOrderId: localOrder.clientOrderId,
      isCurrent: recovery?.isCurrent,
    });

    const msg = `fill imported: ${ef.fillId} (order: ${ef.orderId}, side: ${ef.side}, size: ${ef.size}, role: ${ef.liquidityRole}, fee: ${resolved.fill.fee.toFixed(6)})`;
    details.push(msg);
    log.info({ fillId: ef.fillId }, msg);
  }

  // Phase 2: Update order statuses (before publishing events so handlers see terminal status)
  for (const [oid, isCurrent] of ordersWithNewFills) {
    await applyOrderVerdict({
      orderRepo,
      fillRepo,
      log,
      orderId: createOrderId(oid),
      exchange: null,
      fillCompletionTolerance: deps.fillCompletionTolerance,
      isCurrent,
    });
  }

  // Phase 3: Publish FillReceived events (handlers now see correct order status)
  recordFillTiming(deps, "import", Date.now() - importStartedAt);
  const eventsStartedAt = Date.now();
  for (const saved of savedFills) {
    // Saved authentic fills remain available to current inventory replay if this worker expires.
    if (saved.isCurrent && !saved.isCurrent()) continue;
    const { ef, fillId, orderId, conditionId, sizeUsdc, signalReason, clientOrderId } = saved;
    const feeInfo = feeInfoByCondition.get(String(conditionId)) ?? null;
    const resolved = buildLocalFillFromExchangeFill(ef, saved, undefined, feeInfo);

    await bus.publish("FillReceived", {
      fillId,
      orderId,
      clientOrderId,
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

  recordFillTiming(deps, "events", Date.now() - eventsStartedAt);
  return {
    imported,
    skipped,
    deferred,
    deferredFillIds,
    deferredOrderIds: [...deferredOrderIds],
    details,
  };
}

function recordFillTiming(
  deps: Pick<ImportFillsDeps, "runtimeMetrics">,
  stage: "fetch" | "import" | "events",
  ms: number,
): void {
  try {
    deps.runtimeMetrics?.writeCounter?.(
      "reconciliation_fills_stage_ms",
      ms,
      JSON.stringify({ stage }),
    );
    deps.runtimeMetrics?.writeCounter?.(
      "reconciliation_fills_stage_count",
      1,
      JSON.stringify({ stage }),
    );
  } catch {
    /* Diagnostic storage cannot interrupt fill persistence. */
  }
}

// ─── Reconciler (uses shared import) ──────────────────────────────────────

export interface FillReconcilerDeps {
  runtimeMetrics?: ImportFillsDeps["runtimeMetrics"];
  gateway: ExchangeGateway;
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  bus: EventBus;
  log: Logger;
  /** Relative completion tolerance forwarded to the import (Fix 4). Default {@link DEFAULT_FILL_COMPLETION_TOLERANCE}. */
  fillCompletionTolerance?: number | undefined;
  recoveryContexts?: readonly SubmitUnknownRecoveryContext[] | undefined;
}

export interface FillReconcileResult {
  exchangeFillCount: number;
  missingFillsImported: number;
  details: string[];
  /** See {@link ImportFillsResult.deferredOrderIds}. */
  deferredOrderIds?: string[];
  /** Set when the pass bailed out before importing any fill. */
  skipReason?: "unreliable_fills";
  /** Fetch classification when {@link skipReason} is set. */
  fetchReason?: FetchReason;
  /** Retry attempts the gateway made before the fills snapshot failed. */
  fetchAttempts?: number;
}

/**
 * Prefer the reliable {@link ExchangeGateway.getFillsResult}; fall back to the
 * legacy array method (wrapped as `ok: true`) for gateways/mocks without it.
 */
async function resolveFillsSnapshot(
  gateway: ExchangeGateway & {
    getFillsResult?: (
      sinceMs: number,
      onPageRead?: (ms: number, returned: boolean) => void,
    ) => Promise<FetchResult<ExchangeFill[]>>;
  },
  sinceMs: number,
  runtimeMetrics: ImportFillsDeps["runtimeMetrics"],
): Promise<FetchResult<ExchangeFill[]>> {
  if (gateway.getFillsResult) {
    if (!runtimeMetrics?.writeCounter) return gateway.getFillsResult(sinceMs);
    return gateway.getFillsResult(sinceMs, (ms, returned) => {
      try {
        const labels = JSON.stringify({ outcome: returned ? "returned" : "threw" });
        runtimeMetrics?.writeCounter?.("reconciliation_fills_page_attempt_ms", ms, labels);
        runtimeMetrics?.writeCounter?.("reconciliation_fills_page_attempt_count", 1, labels);
      } catch {
        /* Diagnostics never establish history completeness or interrupt importing. */
      }
    });
  }
  return { ok: true, data: await gateway.getFills(sinceMs) };
}

export async function reconcileFills(
  deps: FillReconcilerDeps,
  sinceMs: number,
): Promise<FillReconcileResult> {
  const { gateway, fillRepo, orderRepo, bus, log } = deps;

  const fetchStartedAt = Date.now();
  const recoverySinceMs = (deps.recoveryContexts ?? []).reduce(
    (since, context) =>
      context.isCurrent() ? Math.min(since, Date.parse(context.order.createdAt)) : since,
    sinceMs,
  );
  let snapshot: FetchResult<ExchangeFill[]>;
  try {
    snapshot = await resolveFillsSnapshot(gateway, recoverySinceMs, deps.runtimeMetrics);
  } finally {
    recordFillTiming(deps, "fetch", Date.now() - fetchStartedAt);
  }
  if (!snapshot.ok) {
    // A failed fills fetch is NOT "no executions" — skip the import so we never
    // leave orders in a stale status from incomplete data (#36, Fix 1.5).
    log.warn(
      { reason: snapshot.reason, attempts: snapshot.attempts },
      "fill reconcile skipped — unreliable fills snapshot",
    );
    return {
      exchangeFillCount: 0,
      missingFillsImported: 0,
      details: [],
      skipReason: "unreliable_fills",
      fetchReason: snapshot.reason,
      fetchAttempts: snapshot.attempts,
    };
  }

  const exchangeFills = snapshot.data;
  if (exchangeFills.length === 0) {
    return { exchangeFillCount: 0, missingFillsImported: 0, details: [] };
  }

  const result = await importExchangeFills(exchangeFills, {
    fillRepo,
    orderRepo,
    bus,
    log,
    gateway,
    fillCompletionTolerance: deps.fillCompletionTolerance,
    deferPendingExactFills: true,
    runtimeMetrics: deps.runtimeMetrics,
    recoveryContexts: deps.recoveryContexts,
  });

  return {
    exchangeFillCount: exchangeFills.length,
    missingFillsImported: result.imported,
    details: result.details,
    deferredOrderIds: result.deferredOrderIds,
  };
}
