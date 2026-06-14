/**
 * Order Reconciler — diffs local open orders against exchange open orders.
 *
 * Detects:
 *  - Phantom orders: local orders marked open that no longer exist on the exchange
 *  - Unknown exchange orders: orders on the exchange with no local record
 *
 * Exchange is source of truth. Phantom local orders are marked cancelled.
 * Unknown exchange orders are logged but not fabricated locally — we only
 * track orders we placed.
 *
 * Hardening (#36): a failed open-orders fetch used to surface as an empty array
 * (`catch { return [] }`), which reconciliation could not tell apart from a
 * genuine "no open orders" snapshot — the root cause of phantom cancellations.
 * The reconciler now consumes {@link ExchangeGateway.getOpenOrdersResult} and
 * skips the pass on an unreliable snapshot, on a suspiciously empty snapshot,
 * and requires several consecutive misses before treating an order as phantom.
 */

import type {
  ExchangeGateway,
  ExchangeOrder,
  FetchReason,
  FetchResult,
  FillRepository,
  MarketRepository,
  Order,
  OrderRepository,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import { buildCancelTelemetry } from "./cancel-telemetry.js";

export interface OrderReconcilerDeps {
  gateway: ExchangeGateway;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  marketRepo: MarketRepository;
  log: Logger;
  phantomGraceMs?: number; // default: 90_000 (1.5× reconcile interval)
  /**
   * Minimum local-open orders that make an *empty* exchange snapshot
   * "suspicious", causing the pass to skip rather than cancel everything.
   * 0 disables the guard. Default 3.
   */
  suspiciousEmptyThreshold?: number;
  /**
   * Consecutive misses required before a missing local order is treated as a
   * phantom. Default 1 (mark on the first miss — legacy behavior).
   */
  consecutiveMissThreshold?: number;
  /**
   * Persistent miss counter keyed by exchangeOrderId. The caller owns it so the
   * count survives across passes. When omitted, a throwaway map is used and the
   * counter never accumulates beyond a single pass.
   */
  consecutiveMissCounts?: Map<string, number>;
}

export type ReconcileSkipReason = "unreliable_snapshot" | "suspicious_empty";

export interface OrderReconcileResult {
  exchangeOpenCount: number;
  localOpenCount: number;
  phantomsCancelled: number;
  unknownExchangeOrders: number;
  staleCancelled: number;
  staleCancelFailed: number;
  phantomsSkippedGrace: number;
  /** Snapshot of the exchange's open orders captured at the start of the pass. */
  exchangeOpenOrders: readonly ExchangeOrder[];
  /** Epoch ms when the exchange snapshot was captured. */
  capturedAtMs: number;
  details: string[];
  /** Set when the pass bailed out before mutating any order. */
  skipReason?: ReconcileSkipReason;
  /** Fetch classification when {@link skipReason} is `unreliable_snapshot`. */
  fetchReason?: FetchReason;
  /** Retry attempts the gateway made before the snapshot failed. */
  fetchAttempts?: number;
  /** Missing orders whose consecutive-miss counter advanced but did not yet mark. */
  consecutiveMissTracked?: number;
  /** Stale exchange orders evaluated by the cancel cascade. */
  cascadeEvaluated?: number;
  /** Stale exchange orders the cascade actually cancelled. */
  cascadeCancelled?: number;
  /** Set to 1 when the cancel cascade was skipped on an unreliable snapshot. */
  cascadeSkipped?: number;
}

export async function reconcileOrders(deps: OrderReconcilerDeps): Promise<OrderReconcileResult> {
  const { gateway, orderRepo, fillRepo, marketRepo, log } = deps;

  const snapshot = await resolveSnapshot(gateway);
  const capturedAtMs = Date.now();
  const localOrders = orderRepo.findOpen();
  const localOpenCount = localOrders.length;

  if (!snapshot.ok) {
    log.warn(
      { reason: snapshot.reason, attempts: snapshot.attempts },
      "reconcile skipped — unreliable open-orders snapshot",
    );
    return skipResult("unreliable_snapshot", localOpenCount, capturedAtMs, {
      fetchReason: snapshot.reason,
      fetchAttempts: snapshot.attempts,
    });
  }

  const exchangeOrders = snapshot.data;
  const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.orderId));
  const localExchangeIds = new Set(
    localOrders.filter((o) => o.exchangeOrderId !== null).map((o) => o.exchangeOrderId!),
  );

  const missMap = deps.consecutiveMissCounts ?? new Map<string, number>();
  pruneMissMap(missMap, localExchangeIds);

  const suspiciousEmptyThreshold = deps.suspiciousEmptyThreshold ?? 3;
  if (
    suspiciousEmptyThreshold > 0 &&
    exchangeOrders.length === 0 &&
    localOpenCount >= suspiciousEmptyThreshold
  ) {
    log.warn(
      { localOpenCount, threshold: suspiciousEmptyThreshold },
      "reconcile skipped — suspicious empty snapshot",
    );
    return skipResult("suspicious_empty", localOpenCount, capturedAtMs);
  }

  const phantom = reconcilePhantomOrders({
    localOrders,
    exchangeOrderIds,
    missMap,
    graceMs: deps.phantomGraceMs ?? 90_000,
    consecutiveMissThreshold: deps.consecutiveMissThreshold ?? 1,
    orderRepo,
    fillRepo,
    marketRepo,
    log,
  });

  const cascade = await reconcileStaleExchangeOrders({
    exchangeOrders,
    localExchangeIds,
    orderRepo,
    gateway,
    log,
    snapshotReliable: true,
  });

  const survivingExchangeOrders =
    cascade.cancelledStaleOrderIds.size === 0
      ? exchangeOrders
      : exchangeOrders.filter((o) => !cascade.cancelledStaleOrderIds.has(o.orderId));

  return {
    exchangeOpenCount: exchangeOrders.length,
    localOpenCount,
    phantomsCancelled: phantom.phantomsCancelled,
    unknownExchangeOrders: cascade.unknownExchangeOrders,
    staleCancelled: cascade.staleCancelled,
    staleCancelFailed: cascade.staleCancelFailed,
    phantomsSkippedGrace: phantom.phantomsSkippedGrace,
    exchangeOpenOrders: survivingExchangeOrders,
    capturedAtMs,
    details: [...phantom.details, ...cascade.details],
    consecutiveMissTracked: phantom.consecutiveMissTracked,
    cascadeEvaluated: cascade.cascadeEvaluated,
    cascadeCancelled: cascade.cascadeCancelled,
    cascadeSkipped: cascade.cascadeSkipped,
  };
}

/**
 * Prefer the reliable {@link ExchangeGateway.getOpenOrdersResult}; fall back to
 * the legacy array method (wrapped as `ok: true`) for gateways/mocks that have
 * not adopted the Result variant yet.
 */
async function resolveSnapshot(gateway: ExchangeGateway): Promise<FetchResult<ExchangeOrder[]>> {
  if (gateway.getOpenOrdersResult) {
    return gateway.getOpenOrdersResult();
  }
  return { ok: true, data: await gateway.getOpenOrders() };
}

function skipResult(
  skipReason: ReconcileSkipReason,
  localOpenCount: number,
  capturedAtMs: number,
  extra: Partial<OrderReconcileResult> = {},
): OrderReconcileResult {
  return {
    exchangeOpenCount: 0,
    localOpenCount,
    phantomsCancelled: 0,
    unknownExchangeOrders: 0,
    staleCancelled: 0,
    staleCancelFailed: 0,
    phantomsSkippedGrace: 0,
    exchangeOpenOrders: [],
    capturedAtMs,
    details: [],
    skipReason,
    ...extra,
  };
}

/** Drop counters for orders that are no longer in the local open set (no leak). */
function pruneMissMap(missMap: Map<string, number>, localExchangeIds: Set<string>): void {
  for (const key of missMap.keys()) {
    if (!localExchangeIds.has(key)) missMap.delete(key);
  }
}

interface PhantomDeps {
  localOrders: readonly Order[];
  exchangeOrderIds: Set<string>;
  missMap: Map<string, number>;
  graceMs: number;
  consecutiveMissThreshold: number;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  marketRepo: MarketRepository;
  log: Logger;
}

interface PhantomResult {
  phantomsCancelled: number;
  phantomsSkippedGrace: number;
  consecutiveMissTracked: number;
  details: string[];
}

function reconcilePhantomOrders(deps: PhantomDeps): PhantomResult {
  const { localOrders, exchangeOrderIds, missMap, graceMs, consecutiveMissThreshold, log } = deps;
  const details: string[] = [];
  let phantomsCancelled = 0;
  let phantomsSkippedGrace = 0;
  let consecutiveMissTracked = 0;

  for (const local of localOrders) {
    const exId = local.exchangeOrderId;
    if (exId === null) continue;

    if (exchangeOrderIds.has(exId)) {
      missMap.delete(exId); // reappeared — reset the consecutive-miss streak
      continue;
    }

    const ageMs = Date.now() - new Date(local.createdAt).getTime();
    if (ageMs < graceMs) {
      phantomsSkippedGrace++;
      log.debug({ orderId: local.orderId, ageMs, graceMs }, "phantom candidate skipped — grace");
      continue;
    }

    const misses = (missMap.get(exId) ?? 0) + 1;
    if (misses < consecutiveMissThreshold) {
      missMap.set(exId, misses);
      consecutiveMissTracked++;
      log.debug(
        { orderId: local.orderId, misses, threshold: consecutiveMissThreshold },
        "phantom candidate — consecutive miss tracked",
      );
      continue;
    }

    missMap.delete(exId);
    details.push(markPhantom(local, deps));
    phantomsCancelled++;
  }

  return { phantomsCancelled, phantomsSkippedGrace, consecutiveMissTracked, details };
}

function markPhantom(local: Order, deps: PhantomDeps): string {
  const { orderRepo, fillRepo, marketRepo, log } = deps;
  const telemetry = buildCancelTelemetry({ order: local, nowMs: Date.now(), fillRepo, marketRepo });
  orderRepo.updateStatus(
    local.orderId,
    "cancelled",
    undefined,
    "phantom_missing_on_exchange",
    telemetry,
  );
  const msg = `phantom order cancelled: ${local.orderId} (exchange: ${local.exchangeOrderId})`;
  log.warn({ orderId: local.orderId }, msg);
  return msg;
}

export interface ReconcileStaleDeps {
  exchangeOrders: readonly ExchangeOrder[];
  localExchangeIds: Set<string>;
  orderRepo: OrderRepository;
  gateway: ExchangeGateway;
  log: Logger;
  /**
   * Defense-in-depth guard: only cancel stale exchange orders when the snapshot
   * is trustworthy. `reconcileOrders` already bails on `ok: false`, so this is
   * never `false` in the assembled flow — but the standalone helper enforces it
   * regardless, so a future caller cannot mass-cancel off a bad snapshot.
   */
  snapshotReliable: boolean;
}

export interface ReconcileStaleResult {
  unknownExchangeOrders: number;
  staleCancelled: number;
  staleCancelFailed: number;
  cascadeEvaluated: number;
  cascadeCancelled: number;
  cascadeSkipped: number;
  cancelledStaleOrderIds: Set<string>;
  details: string[];
}

export async function reconcileStaleExchangeOrders(
  deps: ReconcileStaleDeps,
): Promise<ReconcileStaleResult> {
  const { exchangeOrders, localExchangeIds, orderRepo, gateway, log, snapshotReliable } = deps;
  const cancelledStaleOrderIds = new Set<string>();
  const details: string[] = [];

  if (!snapshotReliable) {
    log.warn({}, "stale-order cascade skipped — unreliable snapshot (belt-and-suspenders)");
    return emptyStaleResult({ cascadeSkipped: 1 });
  }

  let unknownExchangeOrders = 0;
  let staleCancelled = 0;
  let staleCancelFailed = 0;
  let cascadeEvaluated = 0;
  let cascadeCancelled = 0;

  for (const ex of exchangeOrders) {
    if (localExchangeIds.has(ex.orderId)) continue; // locally open — normal

    const localOrder = orderRepo.findByExchangeOrderId(ex.orderId);
    if (!localOrder) {
      unknownExchangeOrders++;
      const msg = `unknown exchange order: ${ex.orderId} (token: ${ex.tokenId}, side: ${ex.side})`;
      details.push(msg);
      log.warn({ exchangeOrderId: ex.orderId }, msg);
      continue;
    }

    // Locally cancelled/filled but still on exchange — stale. Cancel it.
    cascadeEvaluated++;
    const result = await gateway.cancelOrder({ orderId: ex.orderId });
    if (result.success) {
      staleCancelled++;
      cascadeCancelled++;
      cancelledStaleOrderIds.add(ex.orderId);
      const msg = `stale exchange order cancelled: ${ex.orderId} (local: ${localOrder.status})`;
      details.push(msg);
      log.info({ exchangeOrderId: ex.orderId, localStatus: localOrder.status }, msg);
    } else {
      staleCancelFailed++;
      const msg = `stale exchange order cancel failed: ${ex.orderId} (${result.errorCode})`;
      details.push(msg);
      log.warn(
        {
          exchangeOrderId: ex.orderId,
          localStatus: localOrder.status,
          errorCode: result.errorCode,
        },
        msg,
      );
    }
  }

  return {
    unknownExchangeOrders,
    staleCancelled,
    staleCancelFailed,
    cascadeEvaluated,
    cascadeCancelled,
    cascadeSkipped: 0,
    cancelledStaleOrderIds,
    details,
  };
}

function emptyStaleResult(overrides: Partial<ReconcileStaleResult> = {}): ReconcileStaleResult {
  return {
    unknownExchangeOrders: 0,
    staleCancelled: 0,
    staleCancelFailed: 0,
    cascadeEvaluated: 0,
    cascadeCancelled: 0,
    cascadeSkipped: 0,
    cancelledStaleOrderIds: new Set<string>(),
    details: [],
    ...overrides,
  };
}
