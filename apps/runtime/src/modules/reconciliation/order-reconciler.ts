/**
 * Order Reconciler — diffs local open orders against exchange open orders.
 *
 * Detects:
 *  - Working local orders absent from an open-only exchange snapshot
 *  - Unknown exchange orders: orders on the exchange with no local record
 *
 * An open-only snapshot is not terminal proof: a missing working order remains
 * fenced until #137b obtains exact terminal evidence. Unknown exchange orders
 * are logged but not fabricated locally — we only track orders we placed.
 *
 * Hardening (#36): a failed open-orders fetch used to surface as an empty array
 * (`catch { return [] }`), which reconciliation could not tell apart from a
 * genuine "no open orders" snapshot — the root cause of phantom cancellations.
 * The reconciler now consumes {@link ExchangeGateway.getOpenOrdersResult} and
 * skips the pass on an unreliable snapshot or suspiciously empty snapshot, and
 * reports only bounded unresolved evidence after consecutive misses.
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
import type { ExactNullStartupQuarantine } from "../execution/execution-module.js";
import { applyOrderVerdict, resolveOrderStatusVerdict } from "./order-status-resolver.js";

export interface OrderReconcilerDeps {
  gateway: ExchangeGateway;
  orderRepo: OrderRepository;
  /** @deprecated Open-snapshot absence no longer needs fill state. */
  fillRepo?: FillRepository;
  /** @deprecated Open-snapshot absence no longer needs market state. */
  marketRepo?: MarketRepository;
  log: Logger;
  phantomGraceMs?: number; // default: 90_000 (1.5× reconcile interval)
  /**
   * Minimum local-open orders that make an *empty* exchange snapshot
   * "suspicious", causing the pass to skip rather than cancel everything.
   * 0 disables the guard. Default 3.
   */
  suspiciousEmptyThreshold?: number;
  /**
   * Consecutive misses required before a missing local order is reported as
   * unresolved. It is never terminalized from an open-orders snapshot.
   */
  consecutiveMissThreshold?: number;
  /**
   * Persistent miss counter keyed by exchangeOrderId. The caller owns it so the
   * count survives across passes. When omitted, a throwaway map is used and the
   * counter never accumulates beyond a single pass.
   */
  consecutiveMissCounts?: Map<string, number>;
  /** Exchange SELLs whose prior stale-cancel attempt lacks exact terminal proof. */
  unresolvedStaleOrders?: Map<string, ExchangeOrder>;
  bus?: import("@krabs/domain").EventBus;
  /** Relative completion tolerance shared by every exact order verdict. */
  fillCompletionTolerance?: number | undefined;
  exactNullStartupQuarantine?: ExactNullStartupQuarantine;
}

export type ReconcileSkipReason = "unreliable_snapshot" | "suspicious_empty";

export interface OrderReconcileResult {
  exchangeOpenCount: number;
  localOpenCount: number;
  /** Always zero: open-snapshot absence is not terminal proof. */
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
  /** Set when the open snapshot was withheld from downstream consumers. */
  skipReason?: ReconcileSkipReason;
  /** Fetch classification when {@link skipReason} is `unreliable_snapshot`. */
  fetchReason?: FetchReason;
  /** Retry attempts the gateway made before the snapshot failed. */
  fetchAttempts?: number;
  /** Missing orders whose consecutive-miss counter advanced but did not yet mark. */
  consecutiveMissTracked?: number;
  /** Missing working orders that crossed the reporting threshold this pass. */
  unresolvedMissingOnExchange?: number;
  /** Stale exchange orders evaluated by the cancel cascade. */
  cascadeEvaluated?: number;
  /** Stale exchange orders the cascade actually cancelled. */
  cascadeCancelled?: number;
  /** Set to 1 when the cancel cascade was skipped on an unreliable snapshot. */
  cascadeSkipped?: number;
  acknowledgedExternalStateUnknown?: number;
}

export async function reconcileOrders(deps: OrderReconcilerDeps): Promise<OrderReconcileResult> {
  const { gateway, orderRepo, log } = deps;

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
  const suspiciousEmptyThreshold = deps.suspiciousEmptyThreshold ?? 3;
  const suspiciousEmpty =
    suspiciousEmptyThreshold > 0 &&
    exchangeOrders.length === 0 &&
    localOpenCount >= suspiciousEmptyThreshold;
  if (suspiciousEmpty) {
    log.warn(
      { localOpenCount, threshold: suspiciousEmptyThreshold },
      "suspicious empty snapshot withheld before exact order recovery",
    );
    return skipResult("suspicious_empty", localOpenCount, capturedAtMs);
  }

  const unresolvedStaleOrders = deps.unresolvedStaleOrders ?? new Map<string, ExchangeOrder>();
  const unresolvedPrecheck = await resolveUnresolvedStaleOrders({
    orders: unresolvedStaleOrders,
    gateway,
    orderRepo,
    fillRepo: deps.fillRepo ?? EMPTY_FILL_READER,
    log,
    fillCompletionTolerance: deps.fillCompletionTolerance,
  });
  const exchangeOrderIds = new Set(exchangeOrders.map((o) => o.orderId));
  const localExchangeIds = new Set(
    localOrders.filter((o) => o.exchangeOrderId !== null).map((o) => o.exchangeOrderId!),
  );

  const missMap = deps.consecutiveMissCounts ?? new Map<string, number>();
  pruneMissMap(missMap, localExchangeIds);

  const quarantineOrders = localOrders.filter((order) =>
    deps.exactNullStartupQuarantine?.isExactNullStartupOrderQuarantined(order),
  );
  const quarantineIds = new Set(quarantineOrders.map((order) => String(order.orderId)));
  for (const order of quarantineOrders) {
    const remoteState = exactRemoteState(order, exchangeOrders);
    if (!remoteState) continue;
    await deps.exactNullStartupQuarantine!.observeExactNullStartupRemoteState(order, remoteState);
  }

  const unresolved = reconcileMissingOrders({
    localOrders: localOrders.filter((order) => !quarantineIds.has(String(order.orderId))),
    exchangeOrderIds,
    missMap,
    graceMs: deps.phantomGraceMs ?? 90_000,
    consecutiveMissThreshold: deps.consecutiveMissThreshold ?? 1,
    log,
  });

  const fillRepo = deps.fillRepo ?? EMPTY_FILL_READER;
  await resolveExactCandidates({
    candidates: unresolved.exactCandidates,
    gateway,
    orderRepo,
    fillRepo,
    log,
    fillCompletionTolerance: deps.fillCompletionTolerance,
    ...(deps.bus ? { bus: deps.bus } : {}),
  });

  const cascade = await reconcileStaleExchangeOrders({
    exchangeOrders,
    localExchangeIds,
    orderRepo,
    fillRepo,
    gateway,
    log,
    snapshotReliable: true,
    fillCompletionTolerance: deps.fillCompletionTolerance,
    unresolvedStaleOrders,
    precheckedStaleOrderIds: unresolvedPrecheck.checkedOrderIds,
    preconfirmedTerminalOrderIds: unresolvedPrecheck.terminalOrderIds,
  });

  const survivingExchangeOrders = [...exchangeOrders, ...unresolvedStaleOrders.values()].filter(
    (order, index, orders) =>
      !cascade.terminalStaleOrderIds.has(order.orderId) &&
      orders.findIndex((candidate) => candidate.orderId === order.orderId) === index,
  );

  return {
    exchangeOpenCount: exchangeOrders.length,
    localOpenCount,
    phantomsCancelled: 0,
    unknownExchangeOrders: cascade.unknownExchangeOrders,
    staleCancelled: cascade.staleCancelled,
    staleCancelFailed: cascade.staleCancelFailed,
    phantomsSkippedGrace: unresolved.phantomsSkippedGrace,
    exchangeOpenOrders: survivingExchangeOrders,
    capturedAtMs,
    details: [...unresolved.details, ...cascade.details],
    consecutiveMissTracked: unresolved.consecutiveMissTracked,
    unresolvedMissingOnExchange: unresolved.unresolvedMissingOnExchange,
    cascadeEvaluated: cascade.cascadeEvaluated,
    cascadeCancelled: cascade.cascadeCancelled,
    cascadeSkipped: cascade.cascadeSkipped,
    acknowledgedExternalStateUnknown: quarantineOrders.length,
  };
}

const EMPTY_FILL_READER: Pick<FillRepository, "findByOrderId"> = {
  findByOrderId: () => [],
};

function exactRemoteState(
  local: Order,
  exchange: readonly ExchangeOrder[],
): "absent" | "working" | null {
  const remote = exchange.find((order) => order.orderId === local.exchangeOrderId);
  if (!remote) return "absent";
  return String(remote.tokenId) === String(local.tokenId) && remote.side === local.side
    ? "working"
    : null;
}

async function resolveExactCandidates(deps: {
  candidates: readonly Order[];
  gateway: ExchangeGateway;
  orderRepo: OrderRepository;
  fillRepo: Pick<FillRepository, "findByOrderId">;
  log: Logger;
  bus?: import("@krabs/domain").EventBus;
  fillCompletionTolerance?: number | undefined;
}): Promise<void> {
  if (!deps.gateway.getOrderResult) return;
  for (const local of deps.candidates) {
    const exact = await deps.gateway.getOrderResult(local.exchangeOrderId!);
    if (!exact.ok) continue;
    await applyOrderVerdict({
      orderRepo: deps.orderRepo,
      fillRepo: deps.fillRepo,
      log: deps.log,
      orderId: local.orderId,
      exchange: exact.data,
      publish: true,
      fillCompletionTolerance: deps.fillCompletionTolerance,
      ...(deps.bus ? { bus: deps.bus } : {}),
    });
  }
}

async function resolveUnresolvedStaleOrders(deps: {
  orders: Map<string, ExchangeOrder>;
  gateway: ExchangeGateway;
  orderRepo: OrderRepository;
  fillRepo: Pick<FillRepository, "findByOrderId">;
  log: Logger;
  fillCompletionTolerance?: number | undefined;
}): Promise<{ checkedOrderIds: Set<string>; terminalOrderIds: Set<string> }> {
  const checkedOrderIds = new Set<string>();
  const terminalOrderIds = new Set<string>();
  for (const [exchangeOrderId, exchangeOrder] of deps.orders) {
    const localOrder = deps.orderRepo.findByExchangeOrderId(exchangeOrderId);
    if (!localOrder) continue;
    checkedOrderIds.add(exchangeOrderId);
    if (
      await confirmStaleTerminal({
        exchangeOrder,
        localOrder,
        gateway: deps.gateway,
        orderRepo: deps.orderRepo,
        fillRepo: deps.fillRepo,
        log: deps.log,
        fillCompletionTolerance: deps.fillCompletionTolerance,
      })
    ) {
      terminalOrderIds.add(exchangeOrderId);
      deps.orders.delete(exchangeOrderId);
    }
  }
  return { checkedOrderIds, terminalOrderIds };
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

const MAX_UNRESOLVED_DETAILS = 10;

interface MissingOrderDeps {
  localOrders: readonly Order[];
  exchangeOrderIds: Set<string>;
  missMap: Map<string, number>;
  graceMs: number;
  consecutiveMissThreshold: number;
  log: Logger;
}

interface MissingOrderResult {
  phantomsSkippedGrace: number;
  consecutiveMissTracked: number;
  unresolvedMissingOnExchange: number;
  details: string[];
  exactCandidates: Order[];
}

function reconcileMissingOrders(deps: MissingOrderDeps): MissingOrderResult {
  const { localOrders, exchangeOrderIds, missMap, graceMs, consecutiveMissThreshold, log } = deps;
  const details: string[] = [];
  let phantomsSkippedGrace = 0;
  let consecutiveMissTracked = 0;
  let unresolvedMissingOnExchange = 0;
  const exactCandidates: Order[] = [];

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
      log.debug({ orderId: local.orderId, ageMs, graceMs }, "missing order skipped — grace");
      continue;
    }

    const misses = (missMap.get(exId) ?? 0) + 1;
    if (misses < consecutiveMissThreshold) {
      missMap.set(exId, misses);
      consecutiveMissTracked++;
      log.debug(
        { orderId: local.orderId, misses, threshold: consecutiveMissThreshold },
        "missing order — consecutive miss tracked",
      );
      continue;
    }

    if (misses >= consecutiveMissThreshold) {
      exactCandidates.push(local);
      unresolvedMissingOnExchange++;
      if (details.length < MAX_UNRESOLVED_DETAILS) {
        details.push(`unresolved missing order: ${local.orderId} (exchange: ${exId})`);
      }
      log.warn(
        { orderId: local.orderId, exchangeOrderId: exId, misses },
        "working order absent from open snapshot — retained pending #137b terminal proof",
      );
    }
    missMap.set(exId, misses);
  }

  return {
    phantomsSkippedGrace,
    consecutiveMissTracked,
    unresolvedMissingOnExchange,
    details,
    exactCandidates,
  };
}

export interface ReconcileStaleDeps {
  exchangeOrders: readonly ExchangeOrder[];
  localExchangeIds: Set<string>;
  orderRepo: OrderRepository;
  fillRepo?: Pick<FillRepository, "findByOrderId">;
  gateway: ExchangeGateway;
  log: Logger;
  /**
   * Defense-in-depth guard: only cancel stale exchange orders when the snapshot
   * is trustworthy. `reconcileOrders` already bails on `ok: false`, so this is
   * never `false` in the assembled flow — but the standalone helper enforces it
   * regardless, so a future caller cannot mass-cancel off a bad snapshot.
   */
  snapshotReliable: boolean;
  fillCompletionTolerance?: number | undefined;
  unresolvedStaleOrders?: Map<string, ExchangeOrder>;
  precheckedStaleOrderIds?: ReadonlySet<string>;
  preconfirmedTerminalOrderIds?: ReadonlySet<string>;
}

export interface ReconcileStaleResult {
  unknownExchangeOrders: number;
  staleCancelled: number;
  staleCancelFailed: number;
  cascadeEvaluated: number;
  cascadeCancelled: number;
  cascadeSkipped: number;
  terminalStaleOrderIds: Set<string>;
  details: string[];
}

export async function reconcileStaleExchangeOrders(
  deps: ReconcileStaleDeps,
): Promise<ReconcileStaleResult> {
  const { exchangeOrders, localExchangeIds, orderRepo, gateway, log, snapshotReliable } = deps;
  const fillRepo = deps.fillRepo ?? EMPTY_FILL_READER;
  const terminalStaleOrderIds = new Set(deps.preconfirmedTerminalOrderIds ?? []);
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
    if (terminalStaleOrderIds.has(ex.orderId)) continue;

    const localOrder = orderRepo.findByExchangeOrderId(ex.orderId);
    if (!localOrder) {
      unknownExchangeOrders++;
      const msg = `unknown exchange order: ${ex.orderId} (token: ${ex.tokenId}, side: ${ex.side})`;
      details.push(msg);
      log.warn({ exchangeOrderId: ex.orderId }, msg);
      continue;
    }

    if (
      !deps.precheckedStaleOrderIds?.has(ex.orderId) &&
      (await confirmStaleTerminal({
        exchangeOrder: ex,
        localOrder,
        gateway,
        orderRepo,
        fillRepo,
        log,
        fillCompletionTolerance: deps.fillCompletionTolerance,
      }))
    ) {
      deps.unresolvedStaleOrders?.delete(ex.orderId);
      terminalStaleOrderIds.add(ex.orderId);
      continue;
    }

    // Locally cancelled/filled and still exactly working — request cancellation.
    const result = await gateway.cancelOrder({ orderId: ex.orderId });
    const terminalConfirmed = await confirmStaleTerminal({
      exchangeOrder: ex,
      localOrder,
      gateway,
      orderRepo,
      fillRepo,
      log,
      fillCompletionTolerance: deps.fillCompletionTolerance,
    });
    if (terminalConfirmed) {
      deps.unresolvedStaleOrders?.delete(ex.orderId);
      terminalStaleOrderIds.add(ex.orderId);
      if (result.success) {
        cascadeEvaluated++;
        cascadeCancelled++;
        staleCancelled++;
        const msg = `stale exchange order terminal confirmed: ${ex.orderId} (local: ${localOrder.status})`;
        details.push(msg);
        log.info({ exchangeOrderId: ex.orderId, localStatus: localOrder.status }, msg);
      }
      continue;
    }

    deps.unresolvedStaleOrders?.set(ex.orderId, ex);
    cascadeEvaluated++;
    if (result.success) {
      const msg = `stale exchange order cancel acknowledged but unconfirmed: ${ex.orderId} (local: ${localOrder.status})`;
      details.push(msg);
      log.warn({ exchangeOrderId: ex.orderId, localStatus: localOrder.status }, msg);
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
    terminalStaleOrderIds,
    details,
  };
}

async function confirmStaleTerminal(deps: {
  exchangeOrder: ExchangeOrder;
  localOrder: Order;
  gateway: ExchangeGateway;
  orderRepo: OrderRepository;
  fillRepo: Pick<FillRepository, "findByOrderId">;
  log: Logger;
  fillCompletionTolerance?: number | undefined;
}): Promise<boolean> {
  if (!deps.gateway.getOrderResult) return false;
  const exact = await deps.gateway.getOrderResult(deps.exchangeOrder.orderId);
  if (!exact.ok || exact.data === null) return false;
  if (exact.data.orderId !== deps.exchangeOrder.orderId) return false;
  if (!isTerminalExchangeStatus(exact.data.status)) return false;

  const verdict = await applyOrderVerdict({
    orderRepo: deps.orderRepo,
    fillRepo: deps.fillRepo,
    log: deps.log,
    orderId: deps.localOrder.orderId,
    exchange: exact.data,
    fillCompletionTolerance: deps.fillCompletionTolerance,
  });
  return isTerminalVerdict(verdict.status);
}

function isTerminalExchangeStatus(status: ExchangeOrder["status"]): boolean {
  return (
    status === "FILLED" || status === "CANCELLED" || status === "EXPIRED" || status === "REJECTED"
  );
}

function isTerminalVerdict(
  status: ReturnType<typeof resolveOrderStatusVerdict>["status"],
): boolean {
  return status === "filled" || status === "cancelled" || status === "rejected";
}

function emptyStaleResult(overrides: Partial<ReconcileStaleResult> = {}): ReconcileStaleResult {
  return {
    unknownExchangeOrders: 0,
    staleCancelled: 0,
    staleCancelFailed: 0,
    cascadeEvaluated: 0,
    cascadeCancelled: 0,
    cascadeSkipped: 0,
    terminalStaleOrderIds: new Set<string>(),
    details: [],
    ...overrides,
  };
}
