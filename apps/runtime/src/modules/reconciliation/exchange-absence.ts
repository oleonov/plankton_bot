/**
 * Exchange-absence quarantine — the single owner of the rule that lets a working
 * order the exchange no longer knows ("zombie") be terminalized locally.
 *
 * A single exact not-found read is not terminal proof (#36 transient nulls,
 * late-indexed `/data/trades` fills, other observers holding live evidence), so
 * a durable metadata marker records when exact not-found started. The order may
 * close only after a day of uninterrupted absence AND a week without any
 * activity, both far above every known transient. Every writer runs inside the
 * order's lifecycle lane; this module never enters it itself, so it can be
 * called from code that already holds the lane.
 */

import type { Fill, FillRepository, Order, OrderRepository } from "@krabs/domain";
import { EXCHANGE_ABSENCE_MARKER_KEY as MARKER_KEY } from "@krabs/domain";
import type { Logger } from "../../logger.js";

export const EXCHANGE_ABSENCE_OBSERVE_MS = 24 * 60 * 60 * 1000;
export const EXCHANGE_ABSENCE_QUIET_MS = 7 * 24 * 60 * 60 * 1000;

type MetadataRepo = Pick<OrderRepository, "findById" | "updateMetadataIfUnchanged">;
type FillTimes = readonly Pick<Fill, "filledAt">[];

export function readExchangeAbsence(order: Order): { firstNullAtMs: number } | null {
  const marker = order.metadata?.[MARKER_KEY] as { firstNullAt?: unknown } | null | undefined;
  const firstNullAt = marker?.firstNullAt;
  const firstNullAtMs = typeof firstNullAt === "string" ? Date.parse(firstNullAt) : NaN;
  return Number.isFinite(firstNullAtMs) ? { firstNullAtMs } : null;
}

export function lastActivityMs(order: Order, fills: FillTimes): number {
  return fills.reduce(
    (latest, fill) => Math.max(latest, Date.parse(fill.filledAt)),
    Date.parse(order.createdAt),
  );
}

/** `null` without a marker or when a fill since the marker proves the order alive. */
export function exchangeAbsenceCloseAtMs(order: Order, fills: FillTimes): number | null {
  const marker = readExchangeAbsence(order);
  if (!marker || hasFillSince(fills, marker.firstNullAtMs)) return null;
  return Math.max(
    marker.firstNullAtMs + EXCHANGE_ABSENCE_OBSERVE_MS,
    lastActivityMs(order, fills) + EXCHANGE_ABSENCE_QUIET_MS,
  );
}

export function isExchangeAbsenceDue(order: Order, fills: FillTimes, nowMs: number): boolean {
  const closeAtMs = exchangeAbsenceCloseAtMs(order, fills);
  return closeAtMs !== null && nowMs >= closeAtMs;
}

/** Keeps an existing valid marker so the observation window never restarts on repeat nulls. */
export function markExchangeAbsent(
  orderRepo: MetadataRepo,
  orderId: Order["orderId"],
  nowMs: number,
  log: Logger,
): void {
  const written = rewriteMetadata(orderRepo, orderId, (order) =>
    readExchangeAbsence(order)
      ? null
      : { ...order.metadata, [MARKER_KEY]: { firstNullAt: new Date(nowMs).toISOString() } },
  );
  if (!written) log.debug({ orderId }, "exchange-absence marker write lost CAS — retry next pass");
}

export function clearExchangeAbsence(
  orderRepo: MetadataRepo,
  orderId: Order["orderId"],
  log: Logger,
): void {
  const cleared = rewriteMetadata(orderRepo, orderId, (order) => {
    if (order.metadata?.[MARKER_KEY] === undefined) return null;
    const { [MARKER_KEY]: _marker, ...rest } = order.metadata;
    return rest;
  });
  // A stuck marker cannot close a live order: the 7-day quiet rule and the
  // fill-since-marker check still apply at decision time.
  if (!cleared) log.warn({ orderId }, "exchange-absence marker clear lost CAS twice");
}

/**
 * Exact-null bookkeeping for a snapshot-absent order; the caller holds its
 * lifecycle lane. Starts the marker, or drops one a later fill disproved (the
 * next exact null restarts the window). Returns whether the rule is due now.
 */
export function recordExactNullAbsence(
  orderRepo: MetadataRepo,
  fillRepo: Pick<FillRepository, "findByOrderId">,
  orderId: Order["orderId"],
  nowMs: number,
  log: Logger,
): boolean {
  const order = orderRepo.findById(orderId);
  if (!order) return false;
  if (!readExchangeAbsence(order)) {
    markExchangeAbsent(orderRepo, orderId, nowMs, log);
    return false;
  }
  const fills = fillRepo.findByOrderId(orderId);
  if (exchangeAbsenceCloseAtMs(order, fills) === null) {
    clearExchangeAbsence(orderRepo, orderId, log);
    return false;
  }
  return isExchangeAbsenceDue(order, fills, nowMs);
}

function hasFillSince(fills: FillTimes, sinceMs: number): boolean {
  return fills.some((fill) => Date.parse(fill.filledAt) >= sinceMs);
}

/** CAS with one retry; `next` returning null means nothing to write. */
function rewriteMetadata(
  orderRepo: MetadataRepo,
  orderId: Order["orderId"],
  next: (order: Order) => Readonly<Record<string, unknown>> | null,
): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    const order = orderRepo.findById(orderId);
    if (!order) return true;
    const metadata = next(order);
    if (metadata === null) return true;
    if (orderRepo.updateMetadataIfUnchanged?.(orderId, order.metadata ?? null, metadata)) {
      return true;
    }
  }
  return false;
}
