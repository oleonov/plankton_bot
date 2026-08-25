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
  ExitTtlByLiquidityPolicyConfig,
  PositionRepository,
  RepriceThresholdDecision,
  ExitActionDecision,
  StaleVerdict,
} from "@krabs/domain";
import {
  classifyMarketRegime,
  computeRepriceThreshold,
  createCommandId,
  decideExitAction,
  DEFAULT_EXECUTION_POLICY,
  ENTRY_REASONS,
  EXIT_REASONS,
  S1_LADDER_RULE_ID,
  isAlive,
  isLiveBook,
  isStaleSell,
  resolveDynamicChainCapDetails,
  resolveExitTtlByMarket,
  shouldBlockRepriceChain,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import {
  resolveEntryBuyOrderTtlMs,
  resolveMakerMicroLiveFillDeadlineMs,
} from "../../buy-order-lifecycle.js";
import { parseQuoteMotionOrigin } from "../../quote-motion-shadow.js";
import { resolveMidpointAnchoredSellPrice } from "../strategy/signal-to-order.js";
import type { ExitOrderLifetimeDecision } from "../order-lifetime/order-lifetime-ttl.js";
import {
  isRecoveryChildCleanerProtected,
  type RecoveryTtlCoverageDeps,
} from "../execution/reservation-utils.js";
import {
  buildBookContext,
  buildExitDecisionContext,
  buildRepriceContext,
  buildStaleSellContext,
  type TrackCSubtype,
} from "./context-builders/track-c-context-builders.js";

export {
  CONFIRM_SCALE_TTL_MS,
  DEFAULT_TTL_MS,
  HORIZON_TTL_MS,
  PROBE_LIKE_AD_HOC_TTL_MS,
  PROBE_LIKE_DAILY_TTL_MS,
  PROBE_LIKE_INTRADAY_TTL_MS,
  SCALE_IN_DEFAULT_TTL_MS,
} from "../../buy-order-lifecycle.js";
// EXIT-FIX-2.5: Plankton ask visibility median is 4.1h, so flat SELL TTL
// defaults to 4h; thin/medium markets can extend this via exitTtlByLiquidity.
export const EXIT_ORDER_TTL_MS = 4 * 60 * 60_000; // 4h
export const ENDDATE_SAFETY_WINDOW_MS = 60 * 60_000; // 60 min before endDate
export const CANCEL_BACKOFF_MS = 60_000; // 1 min retry backoff
const PRICE_EPSILON = 1e-9;
const DOWNPRICE_RECOVERY_RESET_TICKS = 3;
const DOWNPRICE_CANCEL_PENDING_RETRY_MS = 5 * 60_000;
const STUCK_SELL_WARNING_INTERVAL_MS = 60 * 60_000;
const FLAT_EXIT_TTL_BY_LIQUIDITY_DISABLED: ExitTtlByLiquidityPolicyConfig = {
  enabled: false,
  thinMs: EXIT_ORDER_TTL_MS,
  mediumMs: EXIT_ORDER_TTL_MS,
};

export interface TrackCBookSignals {
  readonly bidPersistenceS?: number | null;
  readonly bidMovement30m?: number | null;
  readonly publicTradeCount1h?: number | null;
  readonly depthTop3?: number | null;
}

export interface TrackCHoldResolutionWriter {
  insertActive(input: {
    readonly tokenId: TokenId;
    readonly conditionId?: import("@krabs/domain").ConditionId | null;
    readonly positionId?: import("@krabs/domain").PositionId | null;
    readonly sourceOrderId?: import("@krabs/domain").OrderId | null;
    readonly sourceSignalId?: string | null;
    readonly markerCreatedAt: string;
    readonly expectedResolutionAt?: string | null;
    readonly attemptCountForRedeem?: number;
    readonly exitPnlPct?: number | null;
    readonly staleReason: string;
    readonly livenessVerdict: string;
    readonly metadata?: Record<string, unknown> | null;
  }): unknown;
  findActiveByTokenId?: (tokenId: TokenId) => { readonly status?: string } | null;
}

export interface TrackCFloorIntentWriter {
  insertActive(input: {
    readonly tokenId: TokenId;
    readonly conditionId?: import("@krabs/domain").ConditionId | null;
    readonly positionId?: import("@krabs/domain").PositionId | null;
    readonly sourceOrderId?: import("@krabs/domain").OrderId | null;
    readonly sourceSignalId?: string | null;
    readonly targetPrice: number;
    readonly attemptCount?: number;
    readonly createdAt: string;
    readonly metadata?: Record<string, unknown> | null;
  }): unknown;
  findActiveByTokenId?: (tokenId: TokenId) => { readonly attemptCount?: number } | null;
}

export interface TrackCExitCleanerDeps {
  positionRepo: Pick<PositionRepository, "findByTokenId">;
  legStateRepo: Pick<LegStateRepository, "get">;
  holdResolutionRepo: TrackCHoldResolutionWriter;
  floorIntentRepo?: TrackCFloorIntentWriter | undefined;
  getBookSignals?: (tokenId: TokenId, anchor: number) => TrackCBookSignals | null;
  floorCloseRatioThreshold?: () => number | null;
}

export interface SellDownpriceRepriceState {
  repriceCount: number;
  lastBestBid: number | null;
  pendingOrderId: string | null;
  pendingSinceMs: number | null;
  lastWarningAtMs: number | null;
}

export type SellDownpriceRepriceStateMap = Map<string, SellDownpriceRepriceState>;

export type ExitRepriceMarket = Pick<
  NormalizedMarket,
  | "bestBid"
  | "bestAsk"
  | "bestAskSize"
  | "askDepthExcludingOurs"
  | "tickSize"
  | "publicTradeCount24h"
> &
  Partial<Pick<NormalizedMarket, "acceptingOrders" | "enableOrderBook">>;

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
  exitTtlByLiquidity?: ExitTtlByLiquidityPolicyConfig;
  metrics?: {
    writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
  };
  entryRepriceOnOutbid?: {
    policy: () => RepriceOnOutbidPolicy;
    getRepriceCount: (signalId: string | null) => number;
    getMarket: (tokenId: TokenId) => Pick<NormalizedMarket, "bestBid" | "tickSize"> | null;
  };
  exitRepriceOnDownprice?: {
    /** ONE atomic snapshot of the live nested policy + the top-level `exitMidpointAnchorTicks`,
     *  read from a SINGLE execution-policy read. Track L Stage 1 (predictor + threshold) and Stage 2
     *  (thin gate) both consume this one snapshot so a hot config PATCH cannot tear the read mid-order
     *  — the predictor must use the SAME anchor the real replacement pricing uses. */
    snapshot: () => { policy: ExitRepriceOnDownpricePolicy; anchorTicks: number };
    getMarket: (tokenId: TokenId) => ExitRepriceMarket | null;
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
  trackCExit?: TrackCExitCleanerDeps;
  recoveryTtlCoverage?: RecoveryTtlCoverageDeps;
}

export interface StaleCleanResult {
  staleTtlCancelled: number;
  staleEndDateCancelled: number;
  staleExitTtlCancelled: number;
  outbidRepriceCancelled: number;
  downpriceRepriceCancelled: number;
  downpriceRepriceHeld: number;
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
    (o) =>
      o.side === "sell" &&
      o.decisionRuleId !== S1_LADDER_RULE_ID &&
      o.signalReason != null &&
      EXIT_REASONS.has(o.signalReason),
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
  let downpriceRepriceHeld = 0;
  let stuckSellWarnings = 0;
  let repriceChainCapBlocked = 0;

  for (const order of entryBuys) {
    const ordKey = String(order.orderId);
    const market = marketRepo.findByTokenId(order.tokenId);
    const ageMs = now - new Date(order.createdAt).getTime();
    const backoffMs = CANCEL_BACKOFF_MS;
    const lastAttempt = backoffMap.get(ordKey);
    if (lastAttempt != null && now - lastAttempt < backoffMs) continue;
    const captureDeadlineMs = resolveMakerMicroLiveFillDeadlineMs(order);
    const ttlMs =
      captureDeadlineMs == null
        ? resolveOrderTtlMs(order, market)
        : captureDeadlineMs - Date.parse(order.createdAt);

    if (captureDeadlineMs != null ? now >= captureDeadlineMs : ageMs > ttlMs) {
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

    if (order.entryStyle === "maker") continue;
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

  let trackCConsecutiveFailures = 0;
  let trackCCircuitOpen = false;
  for (const order of exitSells) {
    const ordKey = String(order.orderId);
    const lastAttempt = backoffMap.get(ordKey);
    if (lastAttempt != null && now - lastAttempt < CANCEL_BACKOFF_MS) continue;
    if (orderRepo.isOrderManagedByNonterminalBounceAskCaptureIntent?.(order.orderId)) continue;
    if (
      deps.recoveryTtlCoverage &&
      isRecoveryChildCleanerProtected(order, orderRepo, deps.recoveryTtlCoverage)
    ) {
      continue;
    }

    const market = marketRepo.findByTokenId(order.tokenId);
    const ageMs = now - new Date(order.createdAt).getTime();
    const repriceMarket = withAskDepthExcludingOurOpenSells(
      deps.exitRepriceOnDownprice?.getMarket(order.tokenId) ?? null,
      order.tokenId,
      openSells,
    );
    const trackCOutcome = trackCCircuitOpen
      ? { trackC: null, failed: false }
      : safeEvaluateTrackCExit(order, market, repriceMarket, deps, now, trackCConsecutiveFailures);
    const trackC = trackCOutcome.trackC;
    if (trackCOutcome.failed) {
      trackCConsecutiveFailures++;
      if (trackCConsecutiveFailures >= 3 && !trackCCircuitOpen) {
        trackCCircuitOpen = true;
        deps.repriceChainGate?.metrics?.writeCounter?.(
          "track_c_circuit_open_total",
          1,
          JSON.stringify({ source: "stale_order_cleaner" }),
        );
        log.error(
          { consecutiveFailures: trackCConsecutiveFailures },
          "track_c_exit_circuit_opened",
        );
      }
    } else {
      trackCConsecutiveFailures = 0;
    }

    const repriceKey = String(order.tokenId);
    // Capture the live nested policy + top-level anchor in ONE snapshot per order so a hot config
    // PATCH cannot tear the read across stuck-warn, shouldRepriceDownprice, Stage 1 and Stage 2.
    const downpriceSnapshot = deps.exitRepriceOnDownprice?.snapshot();
    const downpriceProvider = downpriceSnapshot
      ? { policy: () => downpriceSnapshot.policy }
      : undefined;
    const stuckSell = shouldWarnStuckSell(
      order,
      repriceMarket,
      downpriceProvider,
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

    const replacementUnavailableReasons = resolveReplacementUnavailableReasons(
      deps.exitRepriceOnDownprice,
      repriceMarket,
    );
    if (replacementUnavailableReasons) {
      log.info(
        {
          orderId: ordKey,
          tokenId: String(order.tokenId),
          reasons: replacementUnavailableReasons,
        },
        "stale exit order held — replacement market unavailable",
      );
      continue;
    }

    const repriceDecision = shouldRepriceDownprice(
      order,
      repriceMarket,
      downpriceProvider,
      sellDownpriceRepriceMap,
      now,
      trackC?.repriceThreshold ?? null,
    );
    if (repriceDecision.shouldReprice) {
      const downpricePolicy =
        downpriceSnapshot?.policy ?? DEFAULT_EXECUTION_POLICY.exitRepriceOnDownprice;
      const anchorTicks =
        downpriceSnapshot?.anchorTicks ?? DEFAULT_EXECUTION_POLICY.exitMidpointAnchorTicks;
      const noOpGuard = evaluateTrackLNoopDownpriceGuard(
        order,
        repriceMarket,
        anchorTicks,
        downpricePolicy.minReplacementImprovementTicks,
      );
      if (noOpGuard.blocked) {
        downpriceRepriceHeld++;
        deps.metrics?.writeCounter?.(
          "track_l_noop_guard_total",
          1,
          JSON.stringify({ mode: noOpGuard.mode }),
        );
        deps.metrics?.writeCounter?.(
          "exit_downprice_reprice_held_total",
          1,
          JSON.stringify({ reason: "noop" }),
        );
        log.info(
          {
            token_id: String(order.tokenId),
            current_price: order.price,
            predicted_price: noOpGuard.predictedPrice,
            bid: repriceMarket?.bestBid ?? null,
            ask: repriceMarket?.bestAsk ?? null,
            midpoint: noOpGuard.midpoint,
            tickSize: repriceMarket?.tickSize ?? null,
          },
          "Track L no-op downprice reprice blocked",
        );
        continue;
      }
      // Resolve the dynamic-cap liveness ONCE — the SAME resolution feeds the Stage-2 thin gate
      // AND the chain-cap block below (single source, no duplicate read). resolveDynamicChainCapDetails
      // normalizes publicTradeCount24h to null when the dynamic cap is DISABLED or the count is
      // UNAVAILABLE, so an absent/stale count can never make a market look thin (plan-review: unknown
      // or disabled → NOT thin → reprice as before). No repriceChainGate → no liveness source at all.
      const chainPolicy = deps.repriceChainGate?.policy() ?? null;
      const capDetails = chainPolicy
        ? resolveDynamicChainCapDetails(repriceMarket, chainPolicy)
        : null;

      // Track L Stage 2 (2026-07-21, docs/plans/2026-07-21-exit-downprice-reprice-
      // stage2.md): thin-market HOLD gate. On a dead/thin market the downprice-chase
      // does not raise fill probability (prod: one token 65 sells, −33%, 0 fills) —
      // hold the ladder target like plankton, do NOT cancel / repost / advance the
      // 24h reprice chain. Thin ONLY when the NORMALIZED publicTradeCount24h is finite,
      // ≥0, and ≤ the threshold. Default-OFF.
      if (downpricePolicy.skipDownpriceWhenThin && capDetails && chainPolicy) {
        const tradeCount = capDetails.publicTradeCount24h;
        const thinThreshold =
          downpricePolicy.thinTradeCountThreshold ??
          chainPolicy.dynamicChainCap.tradeCountThinThreshold;
        if (
          tradeCount != null &&
          Number.isFinite(tradeCount) &&
          tradeCount >= 0 &&
          thinThreshold != null &&
          Number.isFinite(thinThreshold) &&
          tradeCount <= thinThreshold
        ) {
          downpriceRepriceHeld++;
          deps.metrics?.writeCounter?.(
            "exit_downprice_reprice_held_total",
            1,
            JSON.stringify({ reason: "thin" }),
          );
          // Durable survivorship event (deduped by MIN(created_at) per orderId at
          // ANALYSIS time — the cleaner re-scans each pass and has no persistent
          // per-order dedup; best-effort, never blocks the hold decision).
          try {
            deps.repriceChainGate?.riskEventRepo?.insert({
              eventType: "exit_downprice_reprice_held",
              payload: {
                tokenId: String(order.tokenId),
                orderId: String(order.orderId),
                orderPrice: order.price,
                bestBid: repriceMarket?.bestBid ?? null,
                bestAsk: repriceMarket?.bestAsk ?? null,
                publicTradeCount24h: tradeCount,
                thresholdUsed: thinThreshold,
                heldAt: new Date(now).toISOString(),
              },
            });
          } catch {
            /* best-effort telemetry — never break the hold */
          }
          log.info(
            {
              token_id: String(order.tokenId),
              current_price: order.price,
              bid: repriceMarket?.bestBid ?? null,
              public_trade_count_24h: tradeCount,
              thin_threshold: thinThreshold,
            },
            "Track L Stage 2 thin-market downprice reprice held",
          );
          continue;
        }
      }
      // CHANGE C — R65 p90 = 13 reprice events per token per 24h cap. Block
      // before publishing the cancel so a runaway loop cannot exceed the
      // historical ceiling. Cap applies across BOTH sources (downpriced and
      // sell_replace) — counter is shared via leg_states columns.
      if (deps.repriceChainGate) {
        const legState = deps.repriceChainGate.legStateRepo.get(order.tokenId);
        // Reuse the single resolution taken above (chainPolicy/capDetails are non-null here because
        // repriceChainGate exists); the `??` only satisfies the type-narrowing, never re-resolves.
        const policy = chainPolicy ?? deps.repriceChainGate.policy();
        const cap = capDetails ?? resolveDynamicChainCapDetails(repriceMarket, policy);
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

    const resolvedExitTtl = resolveExitTtlByMarket(repriceMarket, {
      exitOrderTtlMs: exitTtlMs,
      exitTtlByLiquidity: deps.exitTtlByLiquidity ?? FLAT_EXIT_TTL_BY_LIQUIDITY_DISABLED,
    });
    deps.metrics?.writeCounter?.(
      "exit_ttl_resolved_total",
      1,
      JSON.stringify({ tier: resolvedExitTtl.tier }),
    );
    const lifetime = deps.exitOrderLifetime?.resolveExitOrder(
      order,
      market,
      resolvedExitTtl.ttlMs,
      now,
    );
    const enforceLifetime = lifetime?.enabled === true && lifetime.enforcement === "enforce";
    const shouldCancel = enforceLifetime
      ? lifetime.wouldCancelUnderMode
      : ageMs > resolvedExitTtl.ttlMs;
    const ttlMs = enforceLifetime
      ? (lifetime?.effectiveTtlMs ?? resolvedExitTtl.ttlMs)
      : resolvedExitTtl.ttlMs;
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
    downpriceRepriceHeld,
    stuckSellWarnings,
    repriceChainCapBlocked,
  };
}

function resolveReplacementUnavailableReasons(
  provider: StaleOrderCleanerDeps["exitRepriceOnDownprice"],
  market: ExitRepriceMarket | null,
): readonly string[] | null {
  if (!provider) return null;
  if (!market) return ["market-cache-miss"];
  if (market.acceptingOrders === undefined || market.enableOrderBook === undefined) return null;
  const liveness = isAlive(market);
  return liveness.healthy ? null : liveness.reasons;
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

function safeEvaluateTrackCExit(
  order: Pick<Order, "orderId" | "tokenId" | "conditionId" | "price" | "createdAt" | "signalId">,
  market: Market | null,
  pricing:
    | (Pick<
        NormalizedMarket,
        | "bestBid"
        | "bestAsk"
        | "bestAskSize"
        | "askDepthExcludingOurs"
        | "tickSize"
        | "publicTradeCount24h"
      > &
        Partial<Pick<NormalizedMarket, "midPrice" | "spread" | "snapshotTs">>)
    | null,
  deps: Pick<StaleOrderCleanerDeps, "trackCExit" | "log" | "repriceChainGate">,
  nowMs: number,
  consecutiveFailures: number,
): {
  readonly trackC: {
    readonly repriceThreshold: RepriceThresholdDecision | null;
    readonly exitDecision: ExitActionDecision | null;
    readonly staleVerdict: StaleVerdict | null;
  } | null;
  readonly failed: boolean;
} {
  try {
    return { trackC: evaluateTrackCExit(order, market, pricing, deps, nowMs), failed: false };
  } catch (err) {
    deps.log.error(
      {
        err,
        tokenId: String(order.tokenId),
        orderId: String(order.orderId),
        consecutiveFailures: consecutiveFailures + 1,
      },
      "track_c_exit_evaluation_failed",
    );
    deps.repriceChainGate?.metrics?.writeCounter?.(
      "track_c_pipeline_failed_total",
      1,
      JSON.stringify({ source: "stale_order_cleaner" }),
    );
    return { trackC: null, failed: true };
  }
}

function evaluateTrackCExit(
  order: Pick<Order, "orderId" | "tokenId" | "conditionId" | "price" | "createdAt" | "signalId">,
  market: Market | null,
  pricing:
    | (Pick<NormalizedMarket, "bestBid" | "bestAsk" | "tickSize" | "publicTradeCount24h"> &
        Partial<Pick<NormalizedMarket, "midPrice" | "spread" | "snapshotTs">>)
    | null,
  deps: Pick<StaleOrderCleanerDeps, "trackCExit" | "log" | "repriceChainGate">,
  nowMs: number,
): {
  readonly repriceThreshold: RepriceThresholdDecision | null;
  readonly exitDecision: ExitActionDecision | null;
  readonly staleVerdict: StaleVerdict | null;
} | null {
  const trackC = deps.trackCExit;
  if (!trackC) return null;

  const subtype = resolveTrackCSubtype(market);
  if (subtype !== "strike") return null;

  const signals = trackC.getBookSignals?.(order.tokenId, nowMs) ?? null;
  const bookContext = buildBookContext({
    tokenId: order.tokenId,
    market: pricing,
    bidPersistenceS: signals?.bidPersistenceS ?? null,
    bidMovement30m: signals?.bidMovement30m ?? null,
    publicTradeCount1h: signals?.publicTradeCount1h ?? null,
    ts: nowMs,
  });
  const liveness = isLiveBook(bookContext);
  const computedRepriceThreshold = computeRepriceThreshold(
    buildRepriceContext({
      tokenId: order.tokenId,
      subtype,
      market: pricing,
      livenessVerdict: liveness.verdict,
      ts: nowMs,
    }),
  );
  const repriceThreshold = liveness.verdict === "unknown" ? null : computedRepriceThreshold;

  const legState = trackC.legStateRepo.get(order.tokenId);
  const position = trackC.positionRepo.findByTokenId(order.tokenId);
  const staleVerdict = isStaleSell(
    buildStaleSellContext({
      order,
      market: pricing,
      legState,
      position,
      livenessVerdict: liveness.verdict,
      ts: nowMs,
    }),
  );
  const holdState = trackC.holdResolutionRepo.findActiveByTokenId?.(order.tokenId) ?? null;
  const floorIntent = trackC.floorIntentRepo?.findActiveByTokenId?.(order.tokenId) ?? null;
  const exitDecision = decideExitAction(
    buildExitDecisionContext({
      order,
      market,
      position,
      livenessVerdict: liveness.verdict,
      staleVerdict,
      subtype,
      floorCloseRatioThreshold: trackC.floorCloseRatioThreshold?.() ?? null,
      holdResolutionState: holdState ? { active: true } : undefined,
      floorIntentState: floorIntent
        ? { active: true, attemptCount: floorIntent.attemptCount ?? 0 }
        : undefined,
      ts: nowMs,
    }),
  );

  emitTrackCDecisionMetrics(deps, liveness.verdict, staleVerdict.reason, exitDecision.action);

  try {
    persistTrackCAction(order, market, trackC, exitDecision, staleVerdict, liveness.verdict, nowMs);
  } catch (err) {
    deps.log.error(
      {
        err,
        tokenId: String(order.tokenId),
        orderId: String(order.orderId),
        action: exitDecision.action,
        reason: exitDecision.reason,
      },
      "track_c_action_persist_failed",
    );
    deps.repriceChainGate?.metrics?.writeCounter?.(
      "track_c_action_persist_failed_total",
      1,
      JSON.stringify({ action: exitDecision.action, reason: exitDecision.reason }),
    );
  }

  deps.log.debug(
    {
      tokenId: String(order.tokenId),
      slug: market?.slug ?? null,
      livenessVerdict: liveness.verdict,
      livenessReason: liveness.reason,
      staleReason: staleVerdict.reason,
      exitAction: exitDecision.action,
      exitReason: exitDecision.reason,
      repriceReason: repriceThreshold?.reason ?? "unknown_pass_through",
      repriceTickThreshold: repriceThreshold?.tickThreshold ?? null,
    },
    "track_c_exit_evaluated",
  );

  return { repriceThreshold, exitDecision, staleVerdict };
}

function emitTrackCDecisionMetrics(
  deps: Pick<StaleOrderCleanerDeps, "repriceChainGate">,
  livenessVerdict: string,
  staleReason: string,
  action: string,
): void {
  const metrics = deps.repriceChainGate?.metrics;
  if (!metrics?.writeCounter) return;
  // RuntimeMetricWriter.writeCounter uses instance state; invoke through the owner
  // object so `this.counterBuffer` remains bound in production.
  metrics.writeCounter(`track_c.verdict.${livenessVerdict}`);
  metrics.writeCounter(`track_c.stale_branch.${staleReason}`);
  metrics.writeCounter(`track_c.action.${action}`);
}

function persistTrackCAction(
  order: Pick<Order, "orderId" | "tokenId" | "conditionId" | "signalId">,
  market: Market | null,
  trackC: NonNullable<StaleOrderCleanerDeps["trackCExit"]>,
  decision: ExitActionDecision,
  staleVerdict: StaleVerdict,
  livenessVerdict: string,
  nowMs: number,
): void {
  const nowIso = new Date(nowMs).toISOString();
  if (decision.action === "hold_resolution") {
    if (decision.reason === "hold_resolution_active") return;
    trackC.holdResolutionRepo.insertActive({
      tokenId: order.tokenId,
      conditionId: order.conditionId,
      sourceOrderId: order.orderId,
      sourceSignalId: order.signalId ?? null,
      markerCreatedAt: nowIso,
      expectedResolutionAt:
        decision.holdResolutionRequest?.expectedResolutionAt == null
          ? null
          : new Date(decision.holdResolutionRequest.expectedResolutionAt).toISOString(),
      exitPnlPct: numberEvidence(decision.evidence.exitPnlPct),
      staleReason: staleVerdict.reason,
      livenessVerdict,
      metadata: {
        exitActionReason: decision.reason,
        slug: market?.slug ?? null,
      },
    });
    return;
  }

  if (decision.action !== "floor_close" || decision.executionParams?.targetPrice == null) return;
  trackC.floorIntentRepo?.insertActive({
    tokenId: order.tokenId,
    conditionId: order.conditionId,
    sourceOrderId: order.orderId,
    sourceSignalId: order.signalId ?? null,
    targetPrice: decision.executionParams.targetPrice,
    createdAt: nowIso,
    metadata: {
      exitActionReason: decision.reason,
      slug: market?.slug ?? null,
    },
  });
}

function resolveTrackCSubtype(market: Market | null): TrackCSubtype {
  if (!market) return "non-strike";
  return classifyMarketRegime({ slug: market.slug, tags: market.tags ?? null }) === "strike"
    ? "strike"
    : "non-strike";
}

function numberEvidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  trackCThreshold: RepriceThresholdDecision | null = null,
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
  if (trackCThreshold && !trackCThreshold.shouldReprice) {
    return {
      shouldReprice: false,
      gapTicks: null,
      maxRepricesPerOrder: policy.maxRepricesPerOrder,
      nextState: existing,
      stateChanged: false,
    };
  }
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
  const thresholdTicks = trackCThreshold?.tickThreshold ?? policy.thresholdTicks;
  if (gapTicks < thresholdTicks - PRICE_EPSILON) {
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

function evaluateTrackLNoopDownpriceGuard(
  order: Order,
  market: Pick<NormalizedMarket, "bestBid" | "bestAsk" | "tickSize"> | null,
  // Live snapshot (2026-07-21): the predictor MUST use the same anchor the real
  // replacement pricing uses (signal-to-order.ts) instead of the default, and the
  // block threshold is now the configurable `minReplacementImprovementTicks`.
  anchorTicks: number,
  minImprovementTicks: number,
): {
  blocked: boolean;
  mode: "bounce-exit-target" | "midpoint-anchored";
  predictedPrice: number | null;
  midpoint: number | null;
} {
  const bounceOrigin = parseQuoteMotionOrigin(order);
  const canonicalBounceTarget =
    bounceOrigin?.kind === "bounce_exit_target" ? bounceOrigin.originalTargetPrice : null;
  const mode = canonicalBounceTarget == null ? "midpoint-anchored" : "bounce-exit-target";
  if (!market || !Number.isFinite(market.tickSize) || market.tickSize <= 0) {
    return { blocked: false, mode, predictedPrice: null, midpoint: null };
  }

  const predictedPrice =
    canonicalBounceTarget ??
    resolveMidpointAnchoredSellPrice(market.bestBid, market.bestAsk, market.tickSize, anchorTicks);
  const midpoint =
    market.bestBid != null &&
    market.bestAsk != null &&
    Number.isFinite(market.bestBid) &&
    Number.isFinite(market.bestAsk)
      ? (market.bestBid + market.bestAsk) / 2
      : null;
  if (predictedPrice == null || !Number.isFinite(predictedPrice)) {
    return { blocked: false, mode, predictedPrice, midpoint };
  }

  // TODO(2026-06-04): T+3d hypothesis check on 2026-06-07.
  // Guard prevents no-op cancel+repost at same price.
  //
  // Hypothesis to verify:
  // - If guarded orders eventually fill -> guard correct, passive sit was right strategy
  // - If guarded orders resolve outcome 0 -> guard too conservative, need conditional
  //   downprice toward bid (Plankton-style -- see
  //   plankton_reprice_behavior_investigation_2026-06-04.md, 29.5% of Plankton
  //   wide-spread positions downprice)
  // - Decision deferred to data-driven analysis on T+3d
  //
  // Track L Stage 1 (this commit): block no-op churn
  // Track L Stage 2 (potential, 2026-06-07+): conditional downprice logic if data warrants
  const expectedImprovement = order.price - predictedPrice;
  return {
    blocked: expectedImprovement < minImprovementTicks * market.tickSize - PRICE_EPSILON,
    mode,
    predictedPrice,
    midpoint,
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
  order: Pick<Order, "signalReason" | "decisionRuleId" | "metadata">,
  market: Pick<Market, "horizon"> | null,
): number {
  // tradeCount3h intentionally omitted — the cleaner is not the live eviction path. Orders that
  // qualify for the adaptive first-entry TTL (usesAdaptiveFirstEntryTtl) therefore get the 12h cap
  // here instead of a shorter TTL and are not cancelled prematurely; every order the predicate rejects
  // keeps its existing horizon / probe / scale-in TTL.
  return resolveEntryBuyOrderTtlMs(order, market);
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
