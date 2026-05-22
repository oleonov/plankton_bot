/**
 * Stale Order Cleaner — cancels open entry BUY and exit SELL orders that exceed
 * lifecycle limits or need a price refresh.
 *
 * Runs as part of each reconciliation pass. Publishes CancelOrderRequested
 * for each stale order; the execution module handles the actual cancel.
 *
 * Anti-churn: an in-memory backoff map prevents re-cancelling the same
 * order within CANCEL_BACKOFF_MS. Entries are evicted when the order
 * leaves the open set.
 */

import type {
  OrderRepository,
  MarketRepository,
  EventBus,
  Market,
  NormalizedMarket,
  Order,
  RepriceOnOutbidPolicy,
  ExitRepriceOnDownpricePolicy,
  CancelOrderReason,
  TokenId,
  LegStateRepository,
  RepriceChainPolicyConfig,
  RiskEventRepository,
} from "@krabs/domain";
import {
  createCommandId,
  ENTRY_REASONS,
  EXIT_REASONS,
  resolveDynamicChainCapDetails,
  shouldBlockRepriceChain,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import type { ExitOrderLifetimeDecision } from "../order-lifetime/order-lifetime-ttl.js";

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
// ADR-013 bumped 60s to 300s; CHANGE C bumps 300s to 1800s (30m) based on R82:
// Plankton mid-bucket SELL median time-from-BUY = 65min, p25 = 8min.
export const EXIT_ORDER_TTL_MS = 1_800_000; // 30m
export const ENDDATE_SAFETY_WINDOW_MS = 60 * 60_000; // 60 min before endDate
export const CANCEL_BACKOFF_MS = 60_000; // 1 min retry backoff
const PRICE_EPSILON = 1e-9;
const DOWNPRICE_RECOVERY_RESET_TICKS = 3;
const DOWNPRICE_CANCEL_PENDING_RETRY_MS = 5 * 60_000;
const STUCK_SELL_WARNING_INTERVAL_MS = 60 * 60_000;

export interface SellDownpriceRepriceState {
  repriceCount: number;
  lastBestBid: number | null;
  pendingOrderId: string | null;
  pendingSinceMs: number | null;
  lastWarningAtMs: number | null;
}

export type SellDownpriceRepriceStateMap = Map<string, SellDownpriceRepriceState>;

export interface StaleOrderCleanerDeps {
  orderRepo: OrderRepository;
  marketRepo: MarketRepository;
  bus: EventBus;
  log: Logger;
  /**
   * ADR-015: exit-order TTL is read per-call so operator edits to
   * `execution_policy_json.exitOrderTtlMs` take effect without runtime
   * restart. Falls back to the ADR-013 constant `EXIT_ORDER_TTL_MS`
   * when the caller doesn't thread a policy source in (scripts, tests).
   */
  exitOrderTtlMs?: number;
  exitOrderLifetime?: {
    resolveExitOrder: (
      order: Pick<Order, "createdAt" | "orderId" | "tokenId" | "side">,
      market: Pick<Market, "endDate"> | null,
      flatTtlMs: number,
      nowMs: number,
    ) => ExitOrderLifetimeDecision;
  };
  entryRepriceOnOutbid?: {
    policy: () => RepriceOnOutbidPolicy;
    getRepriceCount: (signalId: string | null) => number;
    getMarket: (tokenId: TokenId) => Pick<NormalizedMarket, "bestBid" | "tickSize"> | null;
  };
  exitRepriceOnDownprice?: {
    policy: () => ExitRepriceOnDownpricePolicy;
    getMarket: (
      tokenId: TokenId,
    ) => Pick<
      NormalizedMarket,
      | "bestBid"
      | "bestAsk"
      | "bestAskSize"
      | "askDepthExcludingOurs"
      | "tickSize"
      | "publicTradeCount24h"
    > | null;
  };
  /**
   * CHANGE C — R65 p90 = 13 reprice events per token per 24h cap. Gates the
   * `downpriced_reprice` cancel branch so a runaway sell-side reprice loop
   * cannot exceed the historical reprice ceiling. Optional — when omitted
   * the gate is skipped entirely (legacy / unit tests without legStateRepo).
   */
  repriceChainGate?: {
    policy: () => RepriceChainPolicyConfig;
    legStateRepo: Pick<LegStateRepository, "get">;
    riskEventRepo?: RiskEventRepository | undefined;
    metrics?:
      | {
          writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
        }
      | undefined;
  };
}

export interface StaleCleanResult {
  staleTtlCancelled: number;
  staleEndDateCancelled: number;
  staleExitTtlCancelled: number;
  outbidRepriceCancelled: number;
  downpriceRepriceCancelled: number;
  stuckSellWarnings: number;
  repriceChainCapBlocked: number;
}

/**
 * Scans open entry BUY and exit SELL orders and publishes CancelOrderRequested
 * for those that exceed lifecycle limits or need a price refresh.
 */
export async function cleanStaleEntryOrders(
  deps: StaleOrderCleanerDeps,
  backoffMap: Map<string, number>,
  sellDownpriceRepriceMap: SellDownpriceRepriceStateMap = new Map(),
): Promise<StaleCleanResult> {
  const { orderRepo, marketRepo, bus, log } = deps;
  const exitTtlMs = deps.exitOrderTtlMs ?? EXIT_ORDER_TTL_MS;
  const now = Date.now();

  const openOrders = orderRepo.findOpen();

  const entryBuys = openOrders.filter(
    (o) => o.side === "buy" && o.signalReason != null && ENTRY_REASONS.has(o.signalReason),
  );
  const openSells = openOrders.filter((o) => o.side === "sell");
  const exitSells = openSells.filter(
    (o) => o.side === "sell" && o.signalReason != null && EXIT_REASONS.has(o.signalReason),
  );

  // Evict backoff entries for orders no longer open
  const openIds = new Set(openOrders.map((o) => String(o.orderId)));
  for (const key of backoffMap.keys()) {
    if (!openIds.has(key)) backoffMap.delete(key);
  }
  const openSellTokenIds = new Set(exitSells.map((o) => String(o.tokenId)));
  for (const key of sellDownpriceRepriceMap.keys()) {
    if (!openSellTokenIds.has(key)) sellDownpriceRepriceMap.delete(key);
  }

  let staleTtlCancelled = 0;
  let staleEndDateCancelled = 0;
  let staleExitTtlCancelled = 0;
  let outbidRepriceCancelled = 0;
  let downpriceRepriceCancelled = 0;
  let stuckSellWarnings = 0;
  let repriceChainCapBlocked = 0;

  for (const order of entryBuys) {
    const ordKey = String(order.orderId);
    const market = marketRepo.findByTokenId(order.tokenId);
    const ageMs = now - new Date(order.createdAt).getTime();
    const backoffMs = CANCEL_BACKOFF_MS;
    const lastAttempt = backoffMap.get(ordKey);
    if (lastAttempt != null && now - lastAttempt < backoffMs) continue;
    const ttlMs = resolveOrderTtlMs(order, market);

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

    const repriceMarket = deps.entryRepriceOnOutbid?.getMarket(order.tokenId) ?? null;
    const repriceDecision = shouldRepriceOutbid(order, repriceMarket, deps.entryRepriceOnOutbid);

    if (repriceDecision.shouldReprice) {
      await publishCancel(bus, order, "outbid_repriced");
      backoffMap.set(ordKey, now);
      outbidRepriceCancelled++;
      log.info(
        {
          orderId: ordKey,
          orderPrice: order.price,
          currentBestBid: repriceMarket?.bestBid ?? null,
          tickSize: repriceMarket?.tickSize ?? null,
          repriceCount: repriceDecision.repriceCount,
          maxRepriceCount: repriceDecision.maxRepriceCount,
        },
        "stale entry order — outbid, requesting reprice",
      );
      continue;
    }
  }

  for (const order of exitSells) {
    const ordKey = String(order.orderId);
    const lastAttempt = backoffMap.get(ordKey);
    if (lastAttempt != null && now - lastAttempt < CANCEL_BACKOFF_MS) continue;

    const market = marketRepo.findByTokenId(order.tokenId);
    const ageMs = now - new Date(order.createdAt).getTime();
    const repriceMarket = withAskDepthExcludingOurOpenSells(
      deps.exitRepriceOnDownprice?.getMarket(order.tokenId) ?? null,
      order.tokenId,
      openSells,
    );

    const repriceKey = String(order.tokenId);
    const stuckSell = shouldWarnStuckSell(
      order,
      repriceMarket,
      deps.exitRepriceOnDownprice,
      ageMs,
      now,
      sellDownpriceRepriceMap,
    );
    if (stuckSell.shouldWarn) {
      stuckSellWarnings++;
      log.warn(
        {
          orderId: ordKey,
          tokenId: String(order.tokenId),
          slug: market?.slug ?? null,
          ageMs,
          ageHours: ageMs / 60 / 60_000,
          gapPct: stuckSell.gapPct,
          orderPrice: order.price,
          currentBestBid: repriceMarket?.bestBid ?? null,
        },
        "stuck_sell_detected",
      );
    }

    const repriceDecision = shouldRepriceDownprice(
      order,
      repriceMarket,
      deps.exitRepriceOnDownprice,
      sellDownpriceRepriceMap,
      now,
    );
    if (repriceDecision.shouldReprice) {
      // CHANGE C — R65 p90 = 13 reprice events per token per 24h cap. Block
      // before publishing the cancel so a runaway loop cannot exceed the
      // historical ceiling. Cap applies across BOTH sources (downpriced and
      // sell_replace) — counter is shared via leg_states columns.
      if (deps.repriceChainGate) {
        const legState = deps.repriceChainGate.legStateRepo.get(order.tokenId);
        const policy = deps.repriceChainGate.policy();
        const cap = resolveDynamicChainCapDetails(repriceMarket, policy);
        const effectivePolicy = { ...policy, maxChainCount: cap.maxChainCount };
        deps.repriceChainGate.metrics?.writeCounter?.(
          "exit_chain_cap_resolved_total",
          1,
          JSON.stringify({ bucket: cap.bucket, source: "downpriced_reprice" }),
        );
        if (shouldBlockRepriceChain(legState, now, effectivePolicy)) {
          repriceChainCapBlocked++;
          backoffMap.set(ordKey, now);
          try {
            deps.repriceChainGate.riskEventRepo?.insert({
              eventType: "signal_suppressed",
              payload: {
                tokenId: String(order.tokenId),
                orderId: ordKey,
                reasonCode: "reprice-chain-cap",
                source: "downpriced_reprice",
                count24h: legState?.repriceChainCount24h ?? 0,
                maxChainCount: effectivePolicy.maxChainCount,
                dynamicCapBucket: cap.bucket,
                publicTradeCount24h: cap.publicTradeCount24h,
                signalTimestamp: new Date(now).toISOString(),
              },
            });
          } catch (err) {
            log.warn(
              { err, orderId: ordKey, tokenId: String(order.tokenId) },
              "failed to persist reprice-chain-cap risk event",
            );
          }
          log.info(
            {
              orderId: ordKey,
              tokenId: String(order.tokenId),
              count24h: legState?.repriceChainCount24h ?? 0,
              maxChainCount: effectivePolicy.maxChainCount,
              dynamicCapBucket: cap.bucket,
            },
            "downpriced reprice blocked — 24h chain cap reached",
          );
          continue;
        }
      }
      await publishCancel(bus, order, "downpriced_reprice");
      backoffMap.set(ordKey, now);
      sellDownpriceRepriceMap.set(repriceKey, repriceDecision.nextState);
      downpriceRepriceCancelled++;
      log.info(
        {
          orderId: ordKey,
          orderPrice: order.price,
          currentBestBid: repriceMarket?.bestBid ?? null,
          tickSize: repriceMarket?.tickSize ?? null,
          gapTicks: repriceDecision.gapTicks,
          repriceCount: repriceDecision.nextState.repriceCount,
          maxRepricesPerOrder: repriceDecision.maxRepricesPerOrder,
        },
        "stale exit order — downpriced, requesting reprice",
      );
      continue;
    }
    if (repriceDecision.stateChanged) {
      sellDownpriceRepriceMap.set(repriceKey, repriceDecision.nextState);
    }

    const lifetime = deps.exitOrderLifetime?.resolveExitOrder(order, market, exitTtlMs, now);
    const enforceLifetime = lifetime?.enabled === true && lifetime.enforcement === "enforce";
    const shouldCancel = enforceLifetime ? lifetime.wouldCancelUnderMode : ageMs > exitTtlMs;
    const ttlMs = enforceLifetime ? (lifetime?.effectiveTtlMs ?? exitTtlMs) : exitTtlMs;
    if (shouldCancel) {
      await publishCancel(bus, order, "stale_exit_ttl");
      backoffMap.set(ordKey, now);
      staleExitTtlCancelled++;
      log.info(
        {
          orderId: ordKey,
          ageMs,
          ttlMs,
          signalReason: order.signalReason,
          orderLifetimeMode: lifetime?.mode,
          orderLifetimeReason: lifetime?.cancelReason,
        },
        "stale exit order — TTL exceeded",
      );
    }
  }

  return {
    staleTtlCancelled,
    staleEndDateCancelled,
    staleExitTtlCancelled,
    outbidRepriceCancelled,
    downpriceRepriceCancelled,
    stuckSellWarnings,
    repriceChainCapBlocked,
  };
}

export function recordSellDownpriceCancelSucceeded(
  stateMap: SellDownpriceRepriceStateMap,
  tokenId: TokenId,
  orderId: import("@krabs/domain").OrderId,
): void {
  const key = String(tokenId);
  const state = stateMap.get(key);
  if (!state || state.pendingOrderId !== String(orderId)) return;
  stateMap.set(key, {
    ...state,
    repriceCount: state.repriceCount + 1,
    pendingOrderId: null,
    pendingSinceMs: null,
  });
}

function shouldRepriceOutbid(
  order: Pick<Order, "price" | "signalId">,
  market: Pick<NormalizedMarket, "bestBid" | "tickSize"> | null,
  reprice:
    | {
        policy: () => RepriceOnOutbidPolicy;
        getRepriceCount: (signalId: string | null) => number;
      }
    | undefined,
): { shouldReprice: boolean; repriceCount: number; maxRepriceCount: number } {
  if (!reprice || !market) return { shouldReprice: false, repriceCount: 0, maxRepriceCount: 0 };
  const policy = reprice.policy();
  if (!policy.enabled || policy.maxRepriceCount <= 0) {
    return { shouldReprice: false, repriceCount: 0, maxRepriceCount: policy.maxRepriceCount };
  }
  const bestBid = market.bestBid;
  const tickSize = market.tickSize;
  if (bestBid == null || !Number.isFinite(bestBid) || !Number.isFinite(tickSize) || tickSize <= 0) {
    return { shouldReprice: false, repriceCount: 0, maxRepriceCount: policy.maxRepriceCount };
  }
  const repriceCount = reprice.getRepriceCount(order.signalId ?? null);
  const outbid = bestBid > order.price + tickSize - PRICE_EPSILON;
  return {
    shouldReprice: outbid && repriceCount < policy.maxRepriceCount,
    repriceCount,
    maxRepriceCount: policy.maxRepriceCount,
  };
}

function shouldRepriceDownprice(
  order: Pick<Order, "orderId" | "tokenId" | "price" | "size" | "fillProgressShares">,
  market: Pick<
    NormalizedMarket,
    "bestBid" | "bestAsk" | "bestAskSize" | "askDepthExcludingOurs" | "tickSize"
  > | null,
  reprice:
    | {
        policy: () => ExitRepriceOnDownpricePolicy;
      }
    | undefined,
  stateMap: SellDownpriceRepriceStateMap,
  nowMs: number,
): {
  shouldReprice: boolean;
  gapTicks: number | null;
  maxRepricesPerOrder: number;
  nextState: SellDownpriceRepriceState;
  stateChanged: boolean;
} {
  const existing = stateMap.get(String(order.tokenId)) ?? {
    repriceCount: 0,
    lastBestBid: null,
    pendingOrderId: null,
    pendingSinceMs: null,
    lastWarningAtMs: null,
  };
  if (!reprice || !market) {
    return {
      shouldReprice: false,
      gapTicks: null,
      maxRepricesPerOrder: 0,
      nextState: existing,
      stateChanged: false,
    };
  }

  const policy = reprice.policy();
  const bestBid = market.bestBid;
  const tickSize = market.tickSize;
  if (
    !policy.enabled ||
    policy.maxRepricesPerOrder <= 0 ||
    bestBid == null ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(tickSize) ||
    tickSize <= 0
  ) {
    return {
      shouldReprice: false,
      gapTicks: null,
      maxRepricesPerOrder: policy.maxRepricesPerOrder,
      nextState: existing,
      stateChanged: false,
    };
  }

  let nextState = existing;
  let stateChanged = false;
  if (
    existing.lastBestBid != null &&
    bestBid >= existing.lastBestBid + DOWNPRICE_RECOVERY_RESET_TICKS * tickSize - PRICE_EPSILON
  ) {
    nextState = {
      ...existing,
      repriceCount: 0,
      lastBestBid: bestBid,
      pendingOrderId: null,
      pendingSinceMs: null,
    };
    stateChanged = true;
  }

  const gapTicks = (order.price - bestBid) / tickSize;
  if (isOnlyVisibleAskFromThisOrder(order, market)) {
    return {
      shouldReprice: false,
      gapTicks,
      maxRepricesPerOrder: policy.maxRepricesPerOrder,
      nextState,
      stateChanged,
    };
  }
  if (gapTicks < policy.thresholdTicks - PRICE_EPSILON) {
    return {
      shouldReprice: false,
      gapTicks,
      maxRepricesPerOrder: policy.maxRepricesPerOrder,
      nextState,
      stateChanged,
    };
  }

  if (nextState.repriceCount >= policy.maxRepricesPerOrder) {
    return {
      shouldReprice: false,
      gapTicks,
      maxRepricesPerOrder: policy.maxRepricesPerOrder,
      nextState,
      stateChanged,
    };
  }

  if (
    nextState.pendingOrderId != null &&
    nextState.pendingSinceMs != null &&
    nowMs - nextState.pendingSinceMs < DOWNPRICE_CANCEL_PENDING_RETRY_MS
  ) {
    return {
      shouldReprice: false,
      gapTicks,
      maxRepricesPerOrder: policy.maxRepricesPerOrder,
      nextState,
      stateChanged,
    };
  }

  return {
    shouldReprice: true,
    gapTicks,
    maxRepricesPerOrder: policy.maxRepricesPerOrder,
    nextState: {
      ...nextState,
      lastBestBid: bestBid,
      pendingOrderId: String(order.orderId),
      pendingSinceMs: nowMs,
    },
    stateChanged: true,
  };
}

function withAskDepthExcludingOurOpenSells<
  T extends Pick<NormalizedMarket, "bestAsk" | "bestAskSize" | "askDepthExcludingOurs">,
>(market: T | null, tokenId: TokenId, openSells: readonly Order[]): T | null {
  if (
    !market ||
    market.bestAsk == null ||
    !Number.isFinite(market.bestAsk) ||
    market.bestAskSize == null ||
    !Number.isFinite(market.bestAskSize)
  ) {
    return market;
  }
  const ownSizeAtBestAsk = openSells.reduce((sum, order) => {
    if (String(order.tokenId) !== String(tokenId)) return sum;
    if (Math.abs(order.price - market.bestAsk!) > PRICE_EPSILON) return sum;
    return sum + remainingOrderShares(order);
  }, 0);
  if (ownSizeAtBestAsk <= PRICE_EPSILON) return market;
  return {
    ...market,
    askDepthExcludingOurs: Math.max(0, market.bestAskSize - ownSizeAtBestAsk),
  };
}

function isOnlyVisibleAskFromThisOrder(
  order: Pick<Order, "price" | "size" | "fillProgressShares">,
  market: Pick<NormalizedMarket, "bestAsk" | "bestAskSize" | "askDepthExcludingOurs">,
): boolean {
  if (
    market.bestAsk == null ||
    !Number.isFinite(market.bestAsk) ||
    Math.abs(order.price - market.bestAsk) > PRICE_EPSILON
  ) {
    return false;
  }
  if (market.askDepthExcludingOurs != null && Number.isFinite(market.askDepthExcludingOurs)) {
    return market.askDepthExcludingOurs <= PRICE_EPSILON;
  }
  if (market.bestAskSize == null || !Number.isFinite(market.bestAskSize)) return false;
  return market.bestAskSize <= remainingOrderShares(order) + PRICE_EPSILON;
}

function remainingOrderShares(order: Pick<Order, "size" | "fillProgressShares">): number {
  const filled = order.fillProgressShares;
  if (filled == null || !Number.isFinite(filled) || filled <= 0) return order.size;
  return Math.max(0, order.size - filled);
}

function shouldWarnStuckSell(
  order: Pick<Order, "tokenId" | "price">,
  market: Pick<NormalizedMarket, "bestBid"> | null,
  reprice:
    | {
        policy: () => ExitRepriceOnDownpricePolicy;
      }
    | undefined,
  ageMs: number,
  nowMs: number,
  stateMap: SellDownpriceRepriceStateMap,
): { shouldWarn: boolean; gapPct: number | null } {
  if (!reprice || !market) return { shouldWarn: false, gapPct: null };
  const policy = reprice.policy();
  const bestBid = market.bestBid;
  if (
    !policy.stuckWarningEnabled ||
    bestBid == null ||
    !Number.isFinite(bestBid) ||
    !Number.isFinite(order.price) ||
    order.price <= 0 ||
    ageMs < policy.stuckWarningAgeMs
  ) {
    return { shouldWarn: false, gapPct: null };
  }
  const gapPct = (order.price - bestBid) / order.price;
  if (gapPct <= policy.stuckWarningGapPct) return { shouldWarn: false, gapPct };

  const key = String(order.tokenId);
  const state = stateMap.get(key) ?? {
    repriceCount: 0,
    lastBestBid: null,
    pendingOrderId: null,
    pendingSinceMs: null,
    lastWarningAtMs: null,
  };
  if (
    state.lastWarningAtMs != null &&
    nowMs - state.lastWarningAtMs < STUCK_SELL_WARNING_INTERVAL_MS
  ) {
    return { shouldWarn: false, gapPct };
  }
  stateMap.set(key, { ...state, lastWarningAtMs: nowMs });
  return { shouldWarn: true, gapPct };
}

function resolveOrderTtlMs(
  order: Pick<Order, "signalReason">,
  market: Pick<Market, "horizon"> | null,
): number {
  const horizon = market?.horizon ?? null;
  const horizonTtlMs =
    horizon != null ? (HORIZON_TTL_MS[horizon] ?? DEFAULT_TTL_MS) : DEFAULT_TTL_MS;

  if (order.signalReason === "probe-entry") {
    if (horizon === "intraday-4h") return Math.min(horizonTtlMs, PROBE_LIKE_INTRADAY_TTL_MS);
    if (horizon === "daily") return Math.min(horizonTtlMs, PROBE_LIKE_DAILY_TTL_MS);
    if (horizon === "ad-hoc") return Math.min(horizonTtlMs, PROBE_LIKE_AD_HOC_TTL_MS);
    return Math.min(horizonTtlMs, 10 * 60_000);
  }

  return horizonTtlMs;
}

async function publishCancel(
  bus: EventBus,
  order: { orderId: import("@krabs/domain").OrderId },
  reason: Extract<
    CancelOrderReason,
    | "stale_entry_ttl"
    | "stale_entry_enddate"
    | "stale_exit_ttl"
    | "outbid_repriced"
    | "downpriced_reprice"
  >,
): Promise<void> {
  await bus.publish("CancelOrderRequested", {
    command: {
      type: "CancelOrderCommand" as const,
      commandId: createCommandId(`stale-clean-${String(order.orderId)}-${Date.now()}`),
      orderId: order.orderId,
      reason,
    },
    timestamp: Date.now(),
  });
}
