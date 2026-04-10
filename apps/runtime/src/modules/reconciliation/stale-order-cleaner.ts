/**
 * Stale Entry Order Cleaner — cancels open buy entry orders that exceed
 * a TTL or are too close to market endDate.
 *
 * Runs as part of each reconciliation pass. Publishes CancelOrderRequested
 * for each stale order; the execution module handles the actual cancel.
 *
 * Anti-churn: an in-memory backoff map prevents re-cancelling the same
 * order within CANCEL_BACKOFF_MS. Entries are evicted when the order
 * leaves the open set.
 */

import type { OrderRepository, MarketRepository, EventBus, Market, Order } from "@plankton/domain";
import { createCommandId, ENTRY_REASONS } from "@plankton/domain";
import type { Logger } from "../../logger.js";

// Horizon-aware TTLs for conviction-style entry orders.
export const HORIZON_TTL_MS: Record<string, number> = {
  "intraday-4h": 45 * 60_000,
  daily: 6 * 60 * 60_000,
  deadline: 24 * 60 * 60_000,
  "ad-hoc": 8 * 60 * 60_000,
};
export const DEFAULT_TTL_MS = 6 * 60 * 60_000; // 6h fallback
export const PROBE_LIKE_INTRADAY_TTL_MS = 60_000; // 60s
export const PROBE_LIKE_DAILY_TTL_MS = 5 * 60_000; // 5m
export const PROBE_LIKE_AD_HOC_TTL_MS = 10 * 60_000; // 10m
export const EXIT_ORDER_TTL_MS = 60_000; // 60s
export const ENDDATE_SAFETY_WINDOW_MS = 60 * 60_000; // 60 min before endDate
export const CANCEL_BACKOFF_MS = 60_000; // 1 min retry backoff (reduced from 5m)

const EXIT_REASONS = new Set([
  "repricing-exit",
  "medium-hold-exit",
  "tail-prune",
  "stale-prune",
  "reduce-only",
]);

export interface StaleOrderCleanerDeps {
  orderRepo: OrderRepository;
  marketRepo: MarketRepository;
  bus: EventBus;
  log: Logger;
}

export interface StaleCleanResult {
  staleTtlCancelled: number;
  staleEndDateCancelled: number;
  staleExitTtlCancelled: number;
}

/**
 * Scans open buy entry orders and publishes CancelOrderRequested for those
 * that exceed the TTL or are within the endDate safety window.
 *
 * The backoff map is caller-owned so it persists across reconciliation passes
 * within the same ReconciliationModule instance.
 */
export async function cleanStaleEntryOrders(
  deps: StaleOrderCleanerDeps,
  backoffMap: Map<string, number>,
): Promise<StaleCleanResult> {
  const { orderRepo, marketRepo, bus, log } = deps;
  const now = Date.now();

  const openOrders = orderRepo.findOpen();

  // Only BUY orders with an entry signal reason
  const entryBuys = openOrders.filter(
    (o) => o.side === "buy" && o.signalReason != null && ENTRY_REASONS.has(o.signalReason),
  );
  const exitSells = openOrders.filter(
    (o) => o.side === "sell" && o.signalReason != null && EXIT_REASONS.has(o.signalReason),
  );

  // Evict backoff entries for orders no longer open
  const openIds = new Set(openOrders.map((o) => String(o.orderId)));
  for (const key of backoffMap.keys()) {
    if (!openIds.has(key)) backoffMap.delete(key);
  }

  let staleTtlCancelled = 0;
  let staleEndDateCancelled = 0;
  let staleExitTtlCancelled = 0;

  for (const order of entryBuys) {
    const ordKey = String(order.orderId);

    // Anti-churn: skip if cancel was recently attempted
    const lastAttempt = backoffMap.get(ordKey);
    if (lastAttempt != null && now - lastAttempt < CANCEL_BACKOFF_MS) continue;

    const market = marketRepo.findByTokenId(order.tokenId);
    const ageMs = now - new Date(order.createdAt).getTime();
    const ttlMs = resolveOrderTtlMs(order, market);

    // Check TTL
    if (ageMs > ttlMs) {
      await publishCancel(bus, order, "stale_entry_ttl");
      backoffMap.set(ordKey, now);
      staleTtlCancelled++;
      log.info(
        { orderId: ordKey, ageMs, ttlMs, signalReason: order.signalReason },
        "stale entry order — TTL exceeded",
      );
      continue;
    }

    // Check endDate proximity
    if (market?.endDate) {
      const endDateMs = new Date(market.endDate).getTime();
      if (endDateMs - now < ENDDATE_SAFETY_WINDOW_MS) {
        await publishCancel(bus, order, "stale_entry_enddate");
        backoffMap.set(ordKey, now);
        staleEndDateCancelled++;
        log.info(
          {
            orderId: ordKey,
            endDate: market.endDate,
            windowMs: ENDDATE_SAFETY_WINDOW_MS,
            signalReason: order.signalReason,
          },
          "stale entry order — within endDate safety window",
        );
        continue;
      }
    }
  }

  for (const order of exitSells) {
    const ordKey = String(order.orderId);
    const lastAttempt = backoffMap.get(ordKey);
    if (lastAttempt != null && now - lastAttempt < CANCEL_BACKOFF_MS) continue;

    const ageMs = now - new Date(order.createdAt).getTime();
    if (ageMs > EXIT_ORDER_TTL_MS) {
      await publishCancel(bus, order, "stale_exit_ttl");
      backoffMap.set(ordKey, now);
      staleExitTtlCancelled++;
      log.info(
        { orderId: ordKey, ageMs, ttlMs: EXIT_ORDER_TTL_MS, signalReason: order.signalReason },
        "stale exit order — TTL exceeded",
      );
    }
  }

  return { staleTtlCancelled, staleEndDateCancelled, staleExitTtlCancelled };
}

function resolveOrderTtlMs(
  order: Pick<Order, "signalReason">,
  market: Pick<Market, "horizon"> | null,
) {
  const horizon = market?.horizon ?? null;
  const horizonTtlMs =
    horizon != null ? (HORIZON_TTL_MS[horizon] ?? DEFAULT_TTL_MS) : DEFAULT_TTL_MS;

  // Probe/spray orders need a much shorter leash than conviction-style orders.
  if (order.signalReason === "probe-entry" || order.signalReason === "spray-entry") {
    if (horizon === "intraday-4h") return Math.min(horizonTtlMs, PROBE_LIKE_INTRADAY_TTL_MS);
    if (horizon === "daily") return Math.min(horizonTtlMs, PROBE_LIKE_DAILY_TTL_MS);
    if (horizon === "ad-hoc") return Math.min(horizonTtlMs, PROBE_LIKE_AD_HOC_TTL_MS);
    // Generic fallback for probe-like: 10m
    return Math.min(horizonTtlMs, 10 * 60_000);
  }

  return horizonTtlMs;
}

async function publishCancel(
  bus: EventBus,
  order: {
    orderId: import("@plankton/domain").OrderId;
    familyId: import("@plankton/domain").FamilyId;
  },
  reason: "stale_entry_ttl" | "stale_entry_enddate" | "stale_exit_ttl",
): Promise<void> {
  await bus.publish("CancelOrderRequested", {
    command: {
      type: "CancelOrderCommand" as const,
      commandId: createCommandId(`stale-clean-${String(order.orderId)}-${Date.now()}`),
      orderId: order.orderId,
      reason,
      familyId: order.familyId,
    },
    timestamp: Date.now(),
  });
}
