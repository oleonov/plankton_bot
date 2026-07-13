/**
 * Execution Module — the sole exchange-facing order actor.
 *
 * Responsibilities:
 *  - Subscribe to PlaceOrderRequested / CancelOrderRequested events
 *  - Dedup by commandId (idempotency) and clientOrderId (semantic dedup)
 *  - Call ExchangeGateway.placeOrder / cancelOrder
 *  - Persist Order and Fill rows via repositories
 *  - Publish OrderPlaced / OrderRejected / OrderCancelled / FillReceived events
 *
 * Does NOT contain strategy, risk, or reconciliation logic.
 */

import type {
  RuntimeModule,
  EventBus,
  ExchangeGateway,
  MarketRepository,
  OrderRepository,
  FillRepository,
  Order,
  PlaceOrderCommand,
  PlaceOrderParams,
  CancelOrderCommand,
  OrderId,
  BotRunId,
  RuntimeControl,
  ProfileId,
  TokenId,
  PositionRepository,
  ExchangeFill,
  ExecutionPolicy,
  LegStateRepository,
  RepriceChainPolicyConfig,
  RiskEventRepository,
  NormalizedMarket,
  RuntimeEventMap,
} from "@krabs/domain";
import {
  createCommandId,
  createOrderId,
  DEFAULT_EXECUTION_POLICY,
  ExchangeErrorCode,
  isPositionDust,
  isSellTimeoutReplacement,
  normalizeSellSizeForMinOrder,
  resolveDynamicChainCapDetails,
  shouldBlockRepriceChain,
  S1_LADDER_RULE_ID,
} from "@krabs/domain";
import { classifyExchangeRejectionReason, getExchangeRejectionPayloadText } from "@krabs/exchange";
import { importExchangeFills } from "../reconciliation/fill-reconciler.js";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { calculateTotalExposure, countActiveOpenMarkets } from "../../exposure-calculator.js";
import { resnapPriceToTick, validateExecutablePrice } from "../../executable-price.js";
import {
  evaluateWalletBuyCapacity,
  evaluatePerTokenOrderCapacity,
  evaluateTotalOrdersCapacity,
  evaluateWalletSellCapacity,
  classifySellCapacitySource,
  hasWalletBuyBudget,
  normalizeBuyCapacityPolicy,
  normalizeOrderCapacityPolicy,
  normalizeSellCapacityPolicy,
  PER_TOKEN_BUY_LIMIT_REASON,
  PER_TOKEN_SELL_LIMIT_REASON,
  TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
  type OrderCapacityMetricsSample,
  type WalletSellCapacityDecision,
  resolveWalletBuyBudget,
  WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
  WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
} from "../../wallet-buy-budget.js";
import {
  DEFAULT_FALLBACK_MIN_ORDER_SIZE,
  evaluateSellPreSubmitGuard,
} from "../../min-order-size.js";
import {
  SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
  SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON,
} from "../../internal-order-reasons.js";
import {
  BUY_CAP_FULL_TARGETED_REPLACEMENT_REASON,
  BUY_DUPLICATE_DEDUPED_REASON,
  findDuplicateOpenBuyPair,
  findNearDuplicateOpenBuy,
  findOldestStaleOpenBuy,
} from "../../buy-order-lifecycle.js";
import { ExecutionQueue } from "./execution-queue.js";
import { AuthoritativeTickResolver } from "./authoritative-tick-resolver.js";
import {
  buildReservationSnapshot,
  computeMakerOpenOrderUsdc,
  computeMakerOpenPositionUsdc,
  computeMakerPendingReservationUsdc,
  getOpenOrderCountForToken,
  getReservedSellSize,
  type PendingReservation,
  type ReservationSnapshot,
} from "./reservation-utils.js";
import {
  computeSellUpperBound,
  ExchangeStateStore,
  isExchangeBalanceRejection,
} from "./exchange-state-store.js";
import { buildCancelTelemetry } from "../reconciliation/cancel-telemetry.js";
import {
  orderMatchesOrderId,
  validateProfileLadderReplacementSellTarget,
} from "../profile-ladder-order-helpers.js";
import type { PositionConcentrationService } from "../../position-concentration-service.js";

type OrderFillLookupGateway = ExchangeGateway & {
  getFillsForOrder?: (orderId: string) => Promise<ExchangeFill[]>;
};

type PostOnlyCrossPreSubmitSkip = {
  bestBid: number;
  bestAsk: number | null;
  bookSource: string | null;
  snapshotTs: number | null;
};

function resolvePriceFromCmd(cmd: PlaceOrderCommand): number {
  return cmd.price;
}

function boundedMetricLabel(value: string | null | undefined): string {
  if (value == null || value.trim().length === 0) return "unknown";
  return value.length <= 64 ? value : "other";
}

function resolveSellRepriceThreshold(
  lastPlacedAnchor: number,
  tickSize: number,
  policy: ExecutionPolicy | undefined,
): { thresholdAbs: number } | null {
  if (
    !Number.isFinite(lastPlacedAnchor) ||
    !Number.isFinite(tickSize) ||
    lastPlacedAnchor <= 0 ||
    tickSize <= 0
  ) {
    return null;
  }
  const thresholdPct = policy?.exitRepriceThresholdPct ?? 0.3;
  const thresholdTicks = policy?.exitRepriceThresholdTicks ?? 10;
  if (
    !Number.isFinite(thresholdPct) ||
    !Number.isFinite(thresholdTicks) ||
    thresholdPct <= 0 ||
    thresholdTicks <= 0
  ) {
    return null;
  }
  return {
    thresholdAbs: Math.min(lastPlacedAnchor * thresholdPct, tickSize * thresholdTicks),
  };
}

export interface ExecutionModuleDeps {
  gateway: ExchangeGateway;
  bus: EventBus;
  marketRepo: MarketRepository;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  positionRepo?: PositionRepository | undefined;
  log: Logger;
  botRunId: BotRunId;
  runtimeControl?: RuntimeControl | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
  runtimeMode?: "simulation" | "paper" | "live-lite" | undefined;
  maxConcurrency?: number | undefined;
  controlDb?: {
    prepare(sql: string): { get(...args: unknown[]): unknown };
  };
  activeProfile?: ProfileId | undefined;
  /** Relative fill-completion tolerance forwarded to importExchangeFills (#36). */
  fillCompletionTolerance?: number | undefined;
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
  executionPolicy?: (() => ExecutionPolicy) | undefined;
  allowSellSizeClamp?: boolean | undefined;
  capacityMetricsSink?: ((sample: OrderCapacityMetricsSample) => void) | undefined;
  profileOwnedOpenPositionCount?: (() => number) | undefined;
  /**
   * Shared store of exchange-side SELL state (open orders + wallet balance)
   * updated by the reconciliation module. When provided, the SELL clamp
   * branch additionally caps `availableSize` against the wallet snapshot and
   * the reservedSell sum honours exchange-side orders that survived a restart.
   */
  exchangeStateStore?: ExchangeStateStore | undefined;
  /**
   * CHANGE A — block new SELLs for `balanceRejectBlockMs` after the exchange
   * returns "balance is not enough / allowance" on placement. Default true.
   */
  sellBalanceRejectBlockEnabled?: boolean | undefined;
  /**
   * CHANGE C — when true, reservedSell = max(localOpenSellSum, exchangeOpenSellSum).
   * Default true; reverts to local-only sum when false.
   */
  sellExchangeReservedEnabled?: boolean | undefined;
  /**
   * Optional metrics sink for per-event counters (balance-reject hits,
   * pending-wallet-sync rejects). Reuses the RuntimeMetricWriter shape.
   */
  runtimeMetrics?:
    | {
        writeEvent: (
          metricName: string,
          value?: number,
          labels?: string | null,
          capturedAt?: string,
        ) => void;
        writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
      }
    | undefined;
  /**
   * Trigger a fresh reconciliation pass when an exchange balance reject is
   * observed. Wired from the reconciliation module; absent in unit tests.
   */
  reconciliationTrigger?: (() => void) | undefined;
  /**
   * CHANGE C — leg-state repo + reprice-chain policy. Gates the
   * `sell_replace_reprice` cancel branch so a runaway SELL-replace loop
   * cannot exceed the R65 p90 = 13 events / 24h ceiling. Skipped when
   * either field is omitted (legacy unit tests).
   */
  legStateRepo?: LegStateRepository | undefined;
  repriceChainPolicy?: (() => RepriceChainPolicyConfig) | undefined;
  riskEventRepo?: RiskEventRepository | undefined;
  positionConcentration?: Pick<PositionConcentrationService, "evaluateBuy"> | undefined;
  /**
   * Lazy resolver that fetches the authoritative CLOB minimum_tick_size at the
   * order boundary (Phase 1 of the tick-size rejection fix). Optional — when
   * absent the existing cmd.tickSize is used unchanged (legacy / test default).
   */
  tickResolver?: AuthoritativeTickResolver | undefined;
}

export class ExecutionModule implements RuntimeModule {
  private static readonly SELL_REPLACE_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
  private static readonly SIZE_EPSILON_SHARES = 1e-9;
  private static readonly PRICE_EPSILON = 1e-9;
  private static readonly SELL_REPLACEMENT_CANCELLED_ORDER_ID = "sellReplacementCancelledOrderId";

  private readonly log: Logger;
  private readonly processedCommandIds = new Set<string>();
  private readonly processedCommandOrder: string[] = [];
  private readonly pendingReservations = new Map<string, PendingReservation>();
  private readonly sellReplaceLocks = new Map<
    string,
    { orderId: OrderId; command: PlaceOrderCommand; createdAt: number }
  >();
  private readonly gatewayRejects: Array<{ ts: number; code: string }> = [];
  private readonly internalReservationRejects: number[] = [];
  private sellSizeClamps = 0;
  private readonly queue: ExecutionQueue | null;
  private readonly acceptedCommandAt = new Map<string, number>();
  private readonly marketCache = new Map<string, NormalizedMarket>();
  private placeCompleted = 0;
  private cancelCompleted = 0;
  private placeLatencyTotalMs = 0;
  private cancelLatencyTotalMs = 0;
  private unsubs: Array<() => void> = [];
  private started = false;

  constructor(private readonly deps: ExecutionModuleDeps) {
    this.log = deps.log.child({ module: "execution" });
    this.queue = deps.maxConcurrency
      ? new ExecutionQueue({
          maxConcurrency: deps.maxConcurrency,
          shutdownTimeoutMs: 10_000,
          execute: (cmd) => this.executeCommand(cmd),
          resolveTokenId: (cmd) => {
            if (cmd.type === "PlaceOrderCommand") return cmd.tokenId;
            const order = this.deps.orderRepo.findById(cmd.orderId);
            return order?.tokenId ?? (cmd.orderId as unknown as TokenId);
          },
          log: this.log,
        })
      : null;
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("PlaceOrderRequested", (p) => this.handlePlace(p.command)),
      this.deps.bus.subscribe("CancelOrderRequested", (p) => this.handleCancel(p.command)),
      this.deps.bus.subscribe("NormalizedMarketUpdated", (p) => this.handleMarketUpdate(p)),
      this.deps.bus.subscribe("TrackedMarketsChanged", (p) => this.handleTrackedMarketsChanged(p)),
    );
    this.started = true;
    this.log.info("execution module started");
  }

  private async handleMarketUpdate(
    payload: RuntimeEventMap["NormalizedMarketUpdated"],
  ): Promise<void> {
    for (const market of payload.markets) {
      this.marketCache.set(String(market.tokenId), market);
    }
  }

  private async handleTrackedMarketsChanged(
    payload: RuntimeEventMap["TrackedMarketsChanged"],
  ): Promise<void> {
    for (const tokenId of payload.removedTokenIds) {
      this.marketCache.delete(String(tokenId));
    }
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    if (this.queue) await this.queue.shutdown();
    this.started = false;
    this.log.info("execution module stopped");
  }

  /** Number of queued + in-flight execution tasks. Zero = fully drained. */
  get pendingCount(): number {
    return this.queue?.pendingCount ?? 0;
  }

  getDiagnostics(): {
    pendingCount: number;
    queueDepth: number;
    activeCount: number;
    maxConcurrency: number | null;
    placeCompleted: number;
    cancelCompleted: number;
    avgPlaceLatencyMs: number | null;
    avgCancelLatencyMs: number | null;
    reservedBuyUsdc: number;
    freeUsdcForNewOrders: number | null;
    buyCapacity?: {
      enabled: boolean;
      minNewEntryWalletHeadroomUsdc: number;
      minAddWalletHeadroomUsdc: number;
      maxOpenBuyOrders: number;
      maxOpenBuyOrdersPerToken: number;
      openBuyOrderCount: number;
      newEntryCapacityUsdc: number | null;
      addCapacityUsdc: number | null;
      entriesBlocked: boolean;
      addsBlocked: boolean;
    };
    sellCapacity?: {
      enabled: boolean;
      mode: ExecutionPolicy["sellCapacity"]["mode"];
      maxOpenSellOrders: number;
      maxOpenSellOrdersPerToken: number;
      openSellOrderCount: number;
      openProfileLadderSellOrderCount: number;
      openNonProfileLadderSellOrderCount: number;
      profileOwnedOpenPositionCount: number | null;
      profileLadderCapRaw: number | null;
      effectiveProfileLadderCap: number | null;
      nonLadderReserve: number | null;
      dynamicGlobalCap: number | null;
      hardMaxOpenSellOrders: number | null;
      blocked: boolean;
    };
    orderCapacity?: {
      enabled: boolean;
      maxOpenOrdersTotal: number;
      openOrdersTotal: number;
      blocked: boolean;
    };
    reservedSellTokenCount: number;
    cancelReplacePendingCount: number;
    gatewayRejectsLast10mByCode: Record<string, number>;
    internalReservationRejectsLast10m: number;
    sellSizeClamps: number;
  } {
    const queue = this.queue?.diagnostics;
    const reservations = this.getReservationSnapshot();
    const walletBudget = resolveWalletBuyBudget(
      {
        controlDb: this.deps.controlDb,
        activeProfile: this.deps.activeProfile,
        walletBufferPct: this.deps.walletBufferPct,
        walletBufferMinUsdc: this.deps.walletBufferMinUsdc,
      },
      reservations.reservedBuyUsdc,
    );
    const buyCapacity = normalizeBuyCapacityPolicy(this.currentBuyCapacityPolicy());
    const sellCapacity = normalizeSellCapacityPolicy(this.currentSellCapacityPolicy());
    const orderCapacity = normalizeOrderCapacityPolicy(this.currentOrderCapacityPolicy());
    const profileOwnedOpenPositionCount = this.currentProfileOwnedOpenPositionCount();
    const sellCapacityDiagnostic = evaluateWalletSellCapacity({
      policy: sellCapacity,
      source: "other",
      openSellOrderCount: reservations.openSellOrderCount,
      openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
      openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
      profileOwnedOpenPositionCount,
    });
    const newEntryDecision = evaluateWalletBuyCapacity({
      policy: buyCapacity,
      snapshot: walletBudget,
      requiredNotionalUsdc: 0,
      signalReason: "probe-entry",
      openBuyOrderCount: reservations.openBuyOrderCount,
    });
    const addDecision = evaluateWalletBuyCapacity({
      policy: buyCapacity,
      snapshot: walletBudget,
      requiredNotionalUsdc: 0,
      signalReason: "scale-in",
      openBuyOrderCount: reservations.openBuyOrderCount,
    });
    return {
      pendingCount: this.pendingCount,
      queueDepth: queue?.queueDepth ?? 0,
      activeCount: queue?.activeCount ?? 0,
      maxConcurrency: queue?.maxConcurrency ?? null,
      placeCompleted: this.placeCompleted,
      cancelCompleted: this.cancelCompleted,
      avgPlaceLatencyMs:
        this.placeCompleted > 0 ? Math.round(this.placeLatencyTotalMs / this.placeCompleted) : null,
      avgCancelLatencyMs:
        this.cancelCompleted > 0
          ? Math.round(this.cancelLatencyTotalMs / this.cancelCompleted)
          : null,
      reservedBuyUsdc: Number(reservations.reservedBuyUsdc.toFixed(6)),
      freeUsdcForNewOrders: walletBudget
        ? Number(Math.max(0, walletBudget.freeUsdcForNewOrders).toFixed(6))
        : null,
      buyCapacity: {
        enabled: buyCapacity.enabled,
        minNewEntryWalletHeadroomUsdc: buyCapacity.minNewEntryWalletHeadroomUsdc,
        minAddWalletHeadroomUsdc: buyCapacity.minAddWalletHeadroomUsdc,
        maxOpenBuyOrders: buyCapacity.maxOpenBuyOrders,
        maxOpenBuyOrdersPerToken: buyCapacity.maxOpenBuyOrdersPerToken,
        openBuyOrderCount: reservations.openBuyOrderCount,
        newEntryCapacityUsdc:
          newEntryDecision.availableAfterOrderUsdc == null
            ? null
            : Number(
                Math.max(
                  0,
                  newEntryDecision.availableAfterOrderUsdc -
                    buyCapacity.minNewEntryWalletHeadroomUsdc,
                ).toFixed(6),
              ),
        addCapacityUsdc:
          addDecision.availableAfterOrderUsdc == null
            ? null
            : Number(
                Math.max(
                  0,
                  addDecision.availableAfterOrderUsdc - buyCapacity.minAddWalletHeadroomUsdc,
                ).toFixed(6),
              ),
        entriesBlocked: !newEntryDecision.allowed,
        addsBlocked: !addDecision.allowed,
      },
      sellCapacity: {
        enabled: sellCapacity.enabled,
        mode: sellCapacity.mode,
        maxOpenSellOrders: sellCapacityDiagnostic.maxOpenSellOrders,
        maxOpenSellOrdersPerToken: sellCapacity.maxOpenSellOrdersPerToken,
        openSellOrderCount: reservations.openSellOrderCount,
        openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
        openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
        profileOwnedOpenPositionCount:
          sellCapacityDiagnostic.dynamic?.profileOwnedOpenPositionCount ?? null,
        profileLadderCapRaw: sellCapacityDiagnostic.dynamic?.profileLadderCapRaw ?? null,
        effectiveProfileLadderCap:
          sellCapacityDiagnostic.dynamic?.effectiveProfileLadderCap ?? null,
        nonLadderReserve: sellCapacityDiagnostic.dynamic?.nonLadderReserve ?? null,
        dynamicGlobalCap: sellCapacityDiagnostic.dynamic?.dynamicGlobalCap ?? null,
        hardMaxOpenSellOrders:
          sellCapacity.mode === "source_aware_dynamic" ? sellCapacity.hardMaxOpenSellOrders : null,
        blocked: !sellCapacityDiagnostic.allowed,
      },
      orderCapacity: {
        enabled: orderCapacity.enabled,
        maxOpenOrdersTotal: orderCapacity.maxOpenOrdersTotal,
        openOrdersTotal: reservations.openOrdersTotal,
        blocked:
          orderCapacity.enabled &&
          orderCapacity.maxOpenOrdersTotal > 0 &&
          reservations.openOrdersTotal >= orderCapacity.maxOpenOrdersTotal,
      },
      reservedSellTokenCount: reservations.reservedSellByToken.size,
      cancelReplacePendingCount: this.sellReplaceLocks.size,
      gatewayRejectsLast10mByCode: this.getGatewayRejectsLast10mByCode(),
      internalReservationRejectsLast10m: this.getInternalReservationRejectsLast10m(),
      sellSizeClamps: this.sellSizeClamps,
    };
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) {
      return { ok: false, detail: "not started" };
    }
    const gw = await this.deps.gateway.healthCheck();
    return {
      ok: gw.ok,
      detail: gw.ok ? `gateway ok (${gw.latencyMs}ms)` : "gateway unreachable",
    };
  }

  // ─── Place order handler ──────────────────────────────────────────────

  private async handlePlace(cmd: PlaceOrderCommand): Promise<void> {
    if (this.deps.runtimeControl?.isPaused()) {
      this.log.warn({ commandId: cmd.commandId }, "order rejected — runtime paused");
      await this.rejectOrder(cmd, "runtime-paused", ExchangeErrorCode.RuntimePaused);
      return;
    }

    // Market active check: reject orders on deactivated/resolved markets
    const market = this.deps.marketRepo.findByTokenId(cmd.tokenId);
    if (market && !market.active) {
      this.log.warn(
        { commandId: cmd.commandId, tokenId: cmd.tokenId },
        "order rejected — market inactive",
      );
      await this.rejectOrder(cmd, "market-inactive", ExchangeErrorCode.MarketInactive);
      return;
    }

    const invalidPriceRejection = this.getInvalidPriceRejection(cmd);
    if (invalidPriceRejection) {
      this.log.warn(
        {
          commandId: cmd.commandId,
          tokenId: cmd.tokenId,
          side: cmd.side,
          price: cmd.price,
          tickSize: invalidPriceRejection.tickSize,
          minPrice: invalidPriceRejection.minPrice,
          maxPrice: invalidPriceRejection.maxPrice,
          validationReason: invalidPriceRejection.reason,
        },
        "order rejected — invalid execution price",
      );
      await this.rejectOrder(cmd, "invalid-order-price", ExchangeErrorCode.InvalidPrice);
      return;
    }

    const notional = cmd.price * cmd.size;

    if (cmd.side === "buy" && this.deps.positionConcentration) {
      const executionPolicy = this.deps.executionPolicy?.() ?? DEFAULT_EXECUTION_POLICY;
      const concentrationDecision = this.deps.positionConcentration.evaluateBuy({
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        candidateNotionalUsdc: notional,
        minExecutableNotionalUsdc: (this.resolveCommandMinOrderSize(cmd) ?? 0) * cmd.price,
        policy: executionPolicy.positionConcentration,
        stage: "execution",
        signalReason: cmd.signalReason,
        decisionRuleId: cmd.decisionRuleId ?? null,
      });
      if (concentrationDecision.action !== "allow") {
        this.log.warn(
          {
            commandId: cmd.commandId,
            tokenId: cmd.tokenId,
            reason: concentrationDecision.reason,
            action: concentrationDecision.action,
            notional,
            effectiveNotionalUsdc: concentrationDecision.effectiveNotionalUsdc,
            keyType: concentrationDecision.keyType,
          },
          "order rejected — position concentration cap exceeded",
        );
        await this.rejectOrder(
          cmd,
          `position-concentration-${concentrationDecision.reason}`,
          ExchangeErrorCode.LivePolicyBlocked,
        );
        return;
      }
    }

    // Live-lite order cap check (Layer 4)
    if (this.deps.liveLiteGuard?.isActive) {
      if (!this.deps.liveLiteGuard.isOrderWithinCap(notional)) {
        this.log.warn(
          { commandId: cmd.commandId, notional },
          "order rejected — exceeds live-lite order cap",
        );
        await this.rejectOrder(
          cmd,
          "live-lite-order-cap-exceeded",
          ExchangeErrorCode.LiveLiteOrderCap,
        );
        return;
      }

      // Live-lite steady-state caps (ADR-009): runtime enforcement of the
      // same open-value + active-markets envelope that preflight checks at
      // startup. Only applied to BUY — SELL reduces exposure.
      if (cmd.side === "buy" && this.deps.positionRepo) {
        const totalExposureAfter = calculateTotalExposure(
          this.deps.positionRepo,
          this.deps.orderRepo,
          notional,
        );
        if (this.deps.liveLiteGuard.wouldExceedOpenValueCap(totalExposureAfter, 0)) {
          this.log.warn(
            { commandId: cmd.commandId, totalExposureAfter },
            "order rejected — exceeds live-lite open-value cap",
          );
          await this.rejectOrder(
            cmd,
            "live-lite-open-value-cap-exceeded",
            ExchangeErrorCode.LivePolicyBlocked,
          );
          return;
        }

        const openMarkets = countActiveOpenMarkets(this.deps.positionRepo);
        const wouldBeNewMarket = !openMarkets.has(String(cmd.tokenId));
        if (
          wouldBeNewMarket &&
          this.deps.liveLiteGuard.wouldExceedActiveMarketsCap(openMarkets.size, 1)
        ) {
          this.log.warn(
            { commandId: cmd.commandId, activeMarkets: openMarkets.size },
            "order rejected — exceeds live-lite active-markets cap",
          );
          await this.rejectOrder(
            cmd,
            "live-lite-active-markets-cap-exceeded",
            ExchangeErrorCode.LivePolicyBlocked,
          );
          return;
        }
      }
    }

    // Micro-live maker BUY cap: defense-in-depth cap
    if (cmd.entryStyle === "maker" && cmd.side === "buy") {
      const makerPolicy = this.deps.executionPolicy?.()?.makerEntry;
      if (makerPolicy && makerPolicy.mode === "micro_live") {
        // (a) Per-order notional cap
        if (makerPolicy.microMaxOrderUsdc > 0 && notional > makerPolicy.microMaxOrderUsdc) {
          this.log.warn(
            {
              commandId: cmd.commandId,
              notional,
              microMaxOrderUsdc: makerPolicy.microMaxOrderUsdc,
            },
            "maker BUY rejected — exceeds microMaxOrderUsdc per-order cap",
          );
          await this.rejectOrder(
            cmd,
            "maker-micro-order-cap-exceeded",
            ExchangeErrorCode.LivePolicyBlocked,
          );
          return;
        }
        // (b) Open exposure cap (orders + positions + pending in-flight + this order)
        if (makerPolicy.microMaxOpenUsdc > 0) {
          const openOrders = this.deps.orderRepo.findOpen();
          const openPositionUsdc = this.deps.positionRepo
            ? computeMakerOpenPositionUsdc(this.deps.positionRepo.findOpenByEntryStyle("maker"))
            : 0;
          const pendingUsdc = computeMakerPendingReservationUsdc(this.pendingReservations.values());
          const makerOpenUsdc =
            computeMakerOpenOrderUsdc(openOrders, this.deps.fillRepo) +
            openPositionUsdc +
            pendingUsdc +
            notional;
          if (makerOpenUsdc > makerPolicy.microMaxOpenUsdc) {
            this.log.warn(
              {
                commandId: cmd.commandId,
                makerOpenUsdc,
                microMaxOpenUsdc: makerPolicy.microMaxOpenUsdc,
              },
              "maker BUY rejected — microMaxOpenUsdc cap exceeded",
            );
            await this.rejectOrder(
              cmd,
              "maker-micro-open-cap-exceeded",
              ExchangeErrorCode.LivePolicyBlocked,
            );
            return;
          }
        }
      }
    }

    if (cmd.side !== "sell") {
      const minOrderSizeRejection = this.getMinOrderSizeRejection(cmd);
      if (minOrderSizeRejection) {
        this.log.warn(
          {
            commandId: cmd.commandId,
            tokenId: cmd.tokenId,
            side: cmd.side,
            originalSize: cmd.size,
            clampedSize: null,
            minOrderSize: minOrderSizeRejection.minOrderSize,
            positionSize: this.deps.positionRepo?.findByTokenId(cmd.tokenId)?.size ?? null,
            tickSize: cmd.tickSize,
            reason: "below_min_size",
            phase: "pre-clamp",
          },
          "order rejected — below exchange minimum size",
        );
        await this.rejectOrder(
          cmd,
          "exchange-min-order-size-rejected",
          ExchangeErrorCode.InvalidSize,
        );
        return;
      }
    }

    // Idempotency: skip already-processed commandId
    if (this.processedCommandIds.has(cmd.commandId)) {
      this.log.debug({ commandId: cmd.commandId }, "duplicate commandId — skipping");
      return;
    }

    // Deterministic clientOrderId reuse is unsafe even after terminal local rows:
    // CLOB may accept the resend while SQLite rejects the duplicate client ID.
    const existing = this.deps.orderRepo.findByClientOrderId(cmd.clientOrderId);
    if (existing) {
      await this.skipDuplicateClientOrderIdPreSubmit(cmd, existing);
      this.processedCommandIds.add(cmd.commandId);
      return;
    }

    this.processedCommandIds.add(cmd.commandId);
    this.processedCommandOrder.push(String(cmd.commandId));
    this.pruneProcessedCommandIds();

    // Balance-block check must run BEFORE sell replacement so a blocked token
    // does not get its existing exit SELL cancelled into a void: replacement
    // would cancel the live order then the new SELL would itself be rejected
    // by the same block, leaving no exit order on the book.
    if (cmd.side === "sell" && this.isBalanceBlocked(cmd)) {
      this.recordInternalReservationReject();
      this.recordExecutionCapacityReject(cmd, "pending-wallet-sync");
      await this.rejectOrder(cmd, "pending-wallet-sync", ExchangeErrorCode.InsufficientBalance);
      return;
    }

    const postOnlyCross = this.getPostOnlyCrossPreSubmitSkip(cmd);
    if (postOnlyCross) {
      await this.skipPostOnlyCrossPreSubmit(cmd, postOnlyCross);
      return;
    }

    if (await this.skipDuplicateBuyPreSubmitIfNeeded(cmd)) {
      return;
    }

    if (await this.deferBuyForTargetedCapacityReplacementIfNeeded(cmd)) {
      return;
    }

    if (await this.deferSellReplacementIfNeeded(cmd)) {
      return;
    }

    const decision = this.getReservationDecision(cmd, notional);
    if (decision.kind === "reject") {
      this.recordInternalReservationReject();
      if (!decision.capacitySampleRecorded) {
        this.recordExecutionCapacityReject(cmd, decision.reason);
      }
      this.log.debug(decision.details, decision.message);
      await this.rejectOrder(
        cmd,
        decision.reason,
        decision.errorCode ?? ExchangeErrorCode.InsufficientBalance,
      );
      return;
    }

    let effectiveCmd = cmd;
    if (decision.kind === "clamp") {
      const clampedCmd: PlaceOrderCommand = { ...cmd, size: decision.newSize };
      const postClampMinCheck = this.getMinOrderSizeRejection(clampedCmd);
      if (postClampMinCheck) {
        this.recordInternalReservationReject();
        this.log.warn(
          {
            commandId: cmd.commandId,
            tokenId: cmd.tokenId,
            side: cmd.side,
            originalSize: cmd.size,
            clampedSize: decision.newSize,
            minOrderSize: postClampMinCheck.minOrderSize,
            positionSize: this.deps.positionRepo?.findByTokenId(cmd.tokenId)?.size ?? null,
            tickSize: cmd.tickSize,
            reason: "below_min_size",
            phase: "post-clamp",
          },
          "sell order rejected — clamped size below exchange minimum",
        );
        await this.rejectOrder(cmd, "clamped-below-min-order-size", ExchangeErrorCode.InvalidSize);
        return;
      }
      this.sellSizeClamps++;
      this.log.info(
        { commandId: cmd.commandId, ...decision.details },
        "sell order size clamped to available position (ADR-008)",
      );
      effectiveCmd = clampedCmd;
    }

    this.pendingReservations.set(String(effectiveCmd.commandId), {
      tokenId: effectiveCmd.tokenId,
      side: effectiveCmd.side,
      size: effectiveCmd.size,
      price: effectiveCmd.price,
      decisionRuleId: effectiveCmd.decisionRuleId,
      signalReason: effectiveCmd.signalReason,
      metadata: effectiveCmd.metadata,
      entryStyle: effectiveCmd.entryStyle ?? null,
    });
    this.acceptedCommandAt.set(String(effectiveCmd.commandId), Date.now());

    if (this.queue) {
      this.queue.enqueue(effectiveCmd);
      return;
    }

    await this.executeCommand(effectiveCmd);
  }

  // ─── Cancel order handler ─────────────────────────────────────────────

  private async handleCancel(cmd: CancelOrderCommand): Promise<void> {
    if (this.processedCommandIds.has(cmd.commandId)) {
      this.log.debug({ commandId: cmd.commandId }, "duplicate cancel commandId — skipping");
      return;
    }
    this.processedCommandIds.add(cmd.commandId);
    this.processedCommandOrder.push(String(cmd.commandId));
    this.pruneProcessedCommandIds();
    this.acceptedCommandAt.set(String(cmd.commandId), Date.now());

    if (this.queue) {
      this.queue.enqueue(cmd);
      return;
    }

    await this.executeCommand(cmd);
  }

  // ─── Command dispatcher ───────────────────────────────────────────────

  private async executeCommand(cmd: PlaceOrderCommand | CancelOrderCommand): Promise<void> {
    try {
      if (cmd.type === "PlaceOrderCommand") {
        await this.executePlace(cmd);
      } else {
        await this.executeCancel(cmd);
      }
    } finally {
      if (cmd.type === "PlaceOrderCommand") {
        this.pendingReservations.delete(String(cmd.commandId));
      }
      this.recordExecutionLatency(cmd);
    }
  }

  private recordExecutionLatency(cmd: PlaceOrderCommand | CancelOrderCommand): void {
    const key = String(cmd.commandId);
    const startedAt = this.acceptedCommandAt.get(key);
    if (startedAt == null) return;
    this.acceptedCommandAt.delete(key);

    const latencyMs = Date.now() - startedAt;
    if (cmd.type === "PlaceOrderCommand") {
      this.placeCompleted++;
      this.placeLatencyTotalMs += latencyMs;
    } else {
      this.cancelCompleted++;
      this.cancelLatencyTotalMs += latencyMs;
    }
  }

  // ─── Place execution (gateway call) ──────────────────────────────────

  private async executePlace(cmd: PlaceOrderCommand): Promise<void> {
    const sellMinOrderBlock = this.getSellPreSubmitMinOrderBlock(cmd);
    if (sellMinOrderBlock) {
      this.recordInternalReservationReject();
      this.recordExecutionCapacityReject(cmd, sellMinOrderBlock.reason);
      this.log.warn(
        {
          commandId: cmd.commandId,
          tokenId: cmd.tokenId,
          conditionId: cmd.conditionId,
          side: cmd.side,
          size: cmd.size,
          price: cmd.price,
          minOrderSize: sellMinOrderBlock.minOrderSize,
          reason: sellMinOrderBlock.reason,
          phase: "pre-submit",
        },
        "sell order blocked before CLOB submit — residual below or missing exchange minimum",
      );
      await this.rejectOrder(cmd, sellMinOrderBlock.reason, ExchangeErrorCode.InvalidSize);
      return;
    }

    // Phase 3: suppress placement when the market is explicitly not accepting
    // orders (fail-open: unknown / absent from cache → proceed).
    // NEVER calls marketRepo.deactivate() — active=1 must be preserved for
    // open-position pricing regardless of transient liveness state.
    if (this.getNotAcceptingOrdersSkip(cmd)) {
      await this.skipNotAcceptingOrders(cmd);
      return;
    }

    const postOnlyCross = this.getPostOnlyCrossPreSubmitSkip(cmd);
    if (postOnlyCross) {
      await this.skipPostOnlyCrossPreSubmit(cmd, postOnlyCross);
      return;
    }

    // Phase 1: resolve authoritative CLOB tick at the order boundary (cached,
    // lazy). Falls back to cmd.tickSize on any lookup failure — never blocks.
    // tokenId is passed for the /tick-size last-resort fallback (step 3).
    const authTick = this.deps.tickResolver
      ? await this.deps.tickResolver.resolve(cmd.conditionId, cmd.tickSize, cmd.tokenId)
      : cmd.tickSize;

    let effectiveTick = cmd.tickSize;
    let effectivePrice = cmd.price;

    if (authTick !== cmd.tickSize) {
      // Re-snap the price to the corrected tick grid (side-aware) before validating.
      // If re-snap fails we fall back to the original cmd tick/price — the order
      // may still get an exchange reject, but we never place a knowingly invalid one.
      const resnap = resnapPriceToTick(cmd.price, cmd.side, authTick);
      if (resnap.valid) {
        effectiveTick = authTick;
        effectivePrice = resnap.price;
        this.log.info(
          {
            commandId: cmd.commandId,
            conditionId: cmd.conditionId,
            staleTick: cmd.tickSize,
            authTick,
            originalPrice: cmd.price,
            snappedPrice: resnap.price,
          },
          "authoritative CLOB tick differs — price re-snapped and tick corrected before submit",
        );
        await this.applyTickCorrection(cmd.conditionId, cmd.tokenId, authTick);
      } else {
        this.log.warn(
          {
            commandId: cmd.commandId,
            conditionId: cmd.conditionId,
            staleTick: cmd.tickSize,
            authTick,
            originalPrice: cmd.price,
          },
          "authoritative tick mismatch but re-snap invalid — keeping original tick/price",
        );
      }
    }

    // C1: effectiveCmd carries the final price/tick so DB rows and events
    // always reflect exactly what was submitted to the exchange.
    const effectiveCmd: PlaceOrderCommand =
      effectiveTick === cmd.tickSize && effectivePrice === cmd.price
        ? cmd
        : ({ ...cmd, price: effectivePrice, tickSize: effectiveTick } as PlaceOrderCommand);

    // M3: if a proactive correction changed price/tick, re-run the guards
    // that depend on those values before the first submit — the corrected
    // price might now cross the book or match an open near-duplicate BUY.
    if (effectiveCmd !== cmd) {
      const reCross = this.getPostOnlyCrossPreSubmitSkip(effectiveCmd);
      if (reCross) {
        await this.skipPostOnlyCrossPreSubmit(effectiveCmd, reCross);
        return;
      }
      if (effectiveCmd.side === "buy") {
        const reDuplicate = findNearDuplicateOpenBuy(
          this.deps.orderRepo.findOpen(),
          effectiveCmd,
          effectiveTick,
        );
        if (reDuplicate) {
          this.log.warn(
            {
              commandId: cmd.commandId,
              conditionId: cmd.conditionId,
              effectivePrice,
              effectiveTick,
            },
            "proactive tick correction produced near-duplicate BUY — skipping",
          );
          await this.publishOrderSkipped(effectiveCmd, "tick-corrected-near-duplicate-buy", {
            effectiveTick,
            effectivePrice,
          });
          return;
        }
      }
      const priceCheck = validateExecutablePrice(effectivePrice, effectiveTick);
      if (!priceCheck.ok) {
        this.log.warn(
          {
            commandId: cmd.commandId,
            conditionId: cmd.conditionId,
            effectivePrice,
            effectiveTick,
            reason: priceCheck.reason,
          },
          "proactive tick correction produced invalid price — skipping",
        );
        await this.publishOrderSkipped(effectiveCmd, "tick-corrected-invalid-price", {
          effectiveTick,
          effectivePrice,
          reason: priceCheck.reason,
        });
        return;
      }
    }

    const placeParams = {
      clientOrderId: cmd.clientOrderId as string,
      tokenId: cmd.tokenId,
      side: cmd.side,
      size: cmd.size,
      price: effectivePrice,
      ...(cmd.postOnly !== undefined ? { postOnly: cmd.postOnly } : {}),
      orderType: cmd.orderType,
      tickSize: effectiveTick,
      negRisk: cmd.negRisk,
      ...(cmd.expiration !== undefined ? { expiration: cmd.expiration } : {}),
    };
    const result = await this.deps.gateway.placeOrder(placeParams);

    const now = Date.now();

    if (!result.success) {
      const errorCode = result.errorCode ?? ExchangeErrorCode.Unknown;
      this.recordGatewayReject(errorCode);
      const reason = this.gatewayRejectReason(result.errorCode, result.errorMessage);
      this.log.warn(
        { commandId: cmd.commandId, errorCode, exchangeErrorDetails: result.errorDetails ?? null },
        "order rejected by gateway",
      );

      this.handleExchangeBalanceRejection(cmd, {
        errorCode: result.errorCode ?? null,
        errorMessage: result.errorMessage ?? null,
        errorDetails: result.errorDetails ?? null,
      });

      if (cmd.side === "sell") {
        const isMinSizeRejection =
          result.errorCode === "INVALID_SIZE" ||
          ExecutionModule.looksLikeMinSizeError(result.errorMessage, result.errorDetails);
        if (isMinSizeRejection) {
          this.maybeIncrementDustCounterForExecutionReject(
            cmd,
            SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
          );
        }
      }

      const exchangeErrorDetails = result.errorDetails ?? null;
      const exchangeRejectionReason = this.classifyExchangeRejection(
        exchangeErrorDetails,
        cmd.commandId,
      );

      // Phase 2: before persisting the first-attempt rejection, try once more
      // with a corrected tick/price if the CLOB told us the tick was wrong.
      // Hard cap = 1: retryAfterInvalidTick handles both success and failure
      // persistence paths and returns true so we exit immediately.
      if (exchangeRejectionReason === "rejection_invalid_tick") {
        if (await this.retryAfterInvalidTick(cmd, effectiveTick, placeParams, now)) {
          return;
        }
      }

      // C1: use effectiveCmd so the persisted row reflects the price/tick
      // that was actually sent to the exchange (not the stale original).
      const rejectedOrder = this.buildOrder(effectiveCmd, "rejected", null, {
        errorCode,
        errorMessage: result.errorMessage ?? reason,
        errorDetails: exchangeErrorDetails,
        rejectionReason: exchangeRejectionReason,
      });
      this.deps.orderRepo.save(rejectedOrder);

      await this.publishOrderRejected(effectiveCmd, {
        reason,
        errorCode,
        exchangeErrorMessage: result.errorMessage ?? null,
        exchangeErrorDetails: result.errorDetails ?? null,
        timestamp: now,
      });
      return;
    }

    if (!result.orderId || result.orderId.trim().length === 0) {
      this.log.error(
        { commandId: cmd.commandId },
        "gateway reported success without order id -- treating as rejection",
      );

      const exchangeErrorDetails = { responseBody: null, reason: "missing-order-id" };
      const exchangeRejectionReason = this.classifyExchangeRejection(
        exchangeErrorDetails,
        cmd.commandId,
      );
      // C1: use effectiveCmd here too.
      const rejectedOrder = this.buildOrder(effectiveCmd, "rejected", null, {
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "gateway returned success without order id",
        errorDetails: exchangeErrorDetails,
        rejectionReason: exchangeRejectionReason,
      });
      this.deps.orderRepo.save(rejectedOrder);

      await this.publishOrderRejected(effectiveCmd, {
        reason: "gateway returned success without order id",
        errorCode: ExchangeErrorCode.Unknown,
        exchangeErrorMessage: "gateway returned success without order id",
        exchangeErrorDetails,
        timestamp: now,
      });
      return;
    }

    // Order accepted — use effectiveCmd (C1) so DB row and event carry the
    // price/tick that the exchange actually accepted, not the stale original.
    const orderId = createOrderId(result.orderId);
    const order = this.buildOrder(effectiveCmd, "open", result.orderId);
    this.persistAcceptedOrderOrThrow(effectiveCmd, order, result.orderId);

    this.log.info({ commandId: effectiveCmd.commandId, orderId: result.orderId }, "order placed");

    await this.deps.bus.publish("OrderPlaced", {
      commandId: effectiveCmd.commandId,
      clientOrderId: effectiveCmd.clientOrderId,
      orderId,
      tokenId: effectiveCmd.tokenId,
      conditionId: effectiveCmd.conditionId,
      side: effectiveCmd.side,
      price: effectiveCmd.price,
      size: effectiveCmd.size,
      orderType: effectiveCmd.orderType,
      signalReason: effectiveCmd.signalReason ?? null,
      timestamp: now,
    });

    // Check for immediate fills (simulation and paper modes use SimulationExchangeGateway
    // which fills orders immediately in memory — must import fills inline, not via recon)
    if (
      !this.deps.runtimeMode ||
      this.deps.runtimeMode === "simulation" ||
      this.deps.runtimeMode === "paper"
    ) {
      await this.checkForFills(orderId);
    }
  }

  // ─── Cancel execution (gateway call) ─────────────────────────────────

  private async executeCancel(cmd: CancelOrderCommand): Promise<void> {
    const result = await this.deps.gateway.cancelOrder({
      orderId: String(cmd.orderId),
    });

    const now = Date.now();

    if (!result.success) {
      this.log.warn(
        { commandId: cmd.commandId, orderId: cmd.orderId, errorCode: result.errorCode },
        "cancel rejected by gateway",
      );
      return;
    }

    const orderForTelemetry = this.deps.orderRepo.findById(cmd.orderId);
    const telemetry = orderForTelemetry
      ? buildCancelTelemetry({
          order: orderForTelemetry,
          nowMs: now,
          fillRepo: this.deps.fillRepo,
          marketRepo: this.deps.marketRepo,
        })
      : undefined;

    this.deps.orderRepo.updateStatus(cmd.orderId, "cancelled", undefined, cmd.reason, telemetry);

    this.log.info({ commandId: cmd.commandId, orderId: cmd.orderId }, "order cancelled");

    if (!orderForTelemetry) {
      this.log.warn(
        { commandId: cmd.commandId, orderId: cmd.orderId },
        "cancel succeeded but local order not found — skipping OrderCancelled event",
      );
    } else {
      await this.deps.bus.publish("OrderCancelled", {
        commandId: cmd.commandId,
        orderId: cmd.orderId,
        tokenId: orderForTelemetry.tokenId,
        conditionId: orderForTelemetry.conditionId,
        reason: cmd.reason,
        signalReason: orderForTelemetry.signalReason,
        timestamp: now,
      });
      await this.releasePendingSellReplacement(cmd.orderId);
    }
  }

  // ─── Fill detection ───────────────────────────────────────────────────

  private async checkForFills(orderId: OrderId): Promise<void> {
    const orderIdStr = String(orderId);
    const gateway = this.deps.gateway as OrderFillLookupGateway;
    const orderFills = gateway.getFillsForOrder
      ? await gateway.getFillsForOrder(orderIdStr)
      : (await gateway.getFills(0)).filter((f) => f.orderId === orderIdStr);
    if (orderFills.length === 0) return;

    await importExchangeFills(orderFills, {
      fillRepo: this.deps.fillRepo,
      orderRepo: this.deps.orderRepo,
      bus: this.deps.bus,
      log: this.log,
      gateway: this.deps.gateway,
      fillCompletionTolerance: this.deps.fillCompletionTolerance,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private getReservationSnapshot() {
    return buildReservationSnapshot(
      this.deps.orderRepo.findOpen(),
      this.deps.fillRepo,
      this.pendingReservations.values(),
    );
  }

  private recordExecutionCapacityReject(cmd: PlaceOrderCommand, reason: string): void {
    const reservations = this.getReservationSnapshot();
    this.deps.capacityMetricsSink?.({
      source: "execution",
      side: cmd.side,
      approved: false,
      rejectionReason: reason,
      sellCapacitySource: cmd.side === "sell" ? classifySellCapacitySource(cmd) : undefined,
      openBuyOrderCount: reservations.openBuyOrderCount,
      openSellOrderCount: reservations.openSellOrderCount,
      openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
      openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
      openOrdersTotal: reservations.openOrdersTotal,
      perTokenOpenBuyOrderCount: getOpenOrderCountForToken(reservations, cmd.tokenId, "buy"),
      perTokenOpenSellOrderCount: getOpenOrderCountForToken(reservations, cmd.tokenId, "sell"),
    });
  }

  private recordExecutionSellCapacitySample(
    cmd: PlaceOrderCommand,
    approved: boolean,
    rejectionReason: string | null,
    sellCapacity: WalletSellCapacityDecision,
    reservations: ReservationSnapshot,
  ): void {
    this.deps.capacityMetricsSink?.({
      source: "execution",
      side: "sell",
      approved,
      rejectionReason,
      sellCapacitySource: sellCapacity.source,
      sellCapacityRejectReason: sellCapacity.rejectionDetail,
      sellCapacityMode: sellCapacity.mode,
      profileOwnedOpenPositionCount: sellCapacity.dynamic?.profileOwnedOpenPositionCount,
      profileLadderCapRaw: sellCapacity.dynamic?.profileLadderCapRaw,
      effectiveProfileLadderCap: sellCapacity.dynamic?.effectiveProfileLadderCap,
      nonLadderReserve: sellCapacity.dynamic?.nonLadderReserve,
      dynamicGlobalCap: sellCapacity.dynamic?.dynamicGlobalCap,
      openBuyOrderCount: reservations.openBuyOrderCount,
      openSellOrderCount: reservations.openSellOrderCount,
      openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
      openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
      openOrdersTotal: reservations.openOrdersTotal,
      perTokenOpenBuyOrderCount: getOpenOrderCountForToken(reservations, cmd.tokenId, "buy"),
      perTokenOpenSellOrderCount: getOpenOrderCountForToken(reservations, cmd.tokenId, "sell"),
    });
  }

  private currentProfileOwnedOpenPositionCount(): number {
    const count = this.deps.profileOwnedOpenPositionCount?.() ?? 0;
    return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  }

  private currentBuyCapacityPolicy(): ExecutionPolicy["buyCapacity"] | undefined {
    return this.deps.executionPolicy?.().buyCapacity;
  }

  private currentSellCapacityPolicy(): ExecutionPolicy["sellCapacity"] | undefined {
    return this.deps.executionPolicy?.().sellCapacity;
  }

  private currentTrackS1Policy(): ExecutionPolicy["trackS1"] | undefined {
    return this.deps.executionPolicy?.().trackS1;
  }

  private currentOrderCapacityPolicy(): ExecutionPolicy["orderCapacity"] | undefined {
    return this.deps.executionPolicy?.().orderCapacity;
  }

  private getReservationDecision(
    cmd: PlaceOrderCommand,
    notional: number,
  ):
    | { kind: "accept" }
    | {
        kind: "reject";
        reason: string;
        errorCode?: ExchangeErrorCode;
        message: string;
        details: Record<string, unknown>;
        capacitySampleRecorded?: boolean;
      }
    | {
        kind: "clamp";
        newSize: number;
        details: Record<string, unknown>;
      } {
    const reservations = this.getReservationSnapshot();
    const orderCapacity = evaluateTotalOrdersCapacity({
      policy: this.currentOrderCapacityPolicy(),
      openOrdersTotal: reservations.openOrdersTotal,
    });

    if (cmd.side === "buy") {
      const buyPolicy = normalizeBuyCapacityPolicy(this.currentBuyCapacityPolicy());
      const perTokenBuy = evaluatePerTokenOrderCapacity({
        side: "buy",
        maxOpenOrdersPerToken: buyPolicy.maxOpenBuyOrdersPerToken,
        openOrdersForToken: getOpenOrderCountForToken(reservations, cmd.tokenId, "buy"),
        enabled: buyPolicy.enabled,
      });
      if (!perTokenBuy.allowed) {
        return {
          kind: "reject",
          reason: PER_TOKEN_BUY_LIMIT_REASON,
          message: "order skipped — per-token BUY order capacity exhausted",
          details: {
            tokenId: String(cmd.tokenId),
            openBuyOrdersForToken: perTokenBuy.openOrdersForToken,
            maxOpenBuyOrdersPerToken: perTokenBuy.maxOpenOrdersPerToken,
          },
        };
      }

      const walletBudget = resolveWalletBuyBudget(
        {
          controlDb: this.deps.controlDb,
          activeProfile: this.deps.activeProfile,
          walletBufferPct: this.deps.walletBufferPct,
          walletBufferMinUsdc: this.deps.walletBufferMinUsdc,
        },
        reservations.reservedBuyUsdc,
      );
      const buyCapacity = evaluateWalletBuyCapacity({
        policy: buyPolicy,
        snapshot: walletBudget,
        requiredNotionalUsdc: notional,
        signalReason: cmd.signalReason,
        openBuyOrderCount: reservations.openBuyOrderCount,
      });
      if (!buyCapacity.allowed) {
        return {
          kind: "reject",
          reason: WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
          message: "order skipped — wallet buy capacity exhausted",
          details: {
            wallet: walletBudget?.walletBalanceUsdc ?? null,
            reservedBuy: reservations.reservedBuyUsdc,
            openBuyOrders: reservations.openBuyOrderCount,
            order: notional,
            capacityKind: buyCapacity.kind,
            requiredHeadroomUsdc: buyCapacity.requiredHeadroomUsdc,
            availableAfterOrderUsdc: buyCapacity.availableAfterOrderUsdc,
            maxOpenBuyOrders: buyCapacity.maxOpenBuyOrders,
          },
        };
      }
      if (!orderCapacity.allowed) {
        return {
          kind: "reject",
          reason: TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
          message: "order skipped — total open order capacity exhausted",
          details: {
            openOrdersTotal: orderCapacity.openOrdersTotal,
            maxOpenOrdersTotal: orderCapacity.maxOpenOrdersTotal,
          },
        };
      }
      if (hasWalletBuyBudget(walletBudget, notional)) return { kind: "accept" };

      return {
        kind: "reject",
        reason: "reserved-usdc-limit",
        message: "order skipped — insufficient wallet balance after open-order reservations",
        details: {
          wallet: walletBudget?.walletBalanceUsdc ?? null,
          reservedBuy: reservations.reservedBuyUsdc,
          walletBuffer: walletBudget?.walletBufferUsdc ?? null,
          available: walletBudget?.freeUsdcForNewOrders ?? null,
          order: notional,
        },
      };
    }

    const sellPolicy = normalizeSellCapacityPolicy(this.currentSellCapacityPolicy());
    const sellCapacitySource = classifySellCapacitySource(cmd);
    const sellCapacity = evaluateWalletSellCapacity({
      policy: sellPolicy,
      source: sellCapacitySource,
      openSellOrderCount: reservations.openSellOrderCount,
      openProfileLadderSellOrderCount: reservations.openProfileLadderSellOrderCount,
      openNonProfileLadderSellOrderCount: reservations.openNonProfileLadderSellOrderCount,
      profileOwnedOpenPositionCount: this.currentProfileOwnedOpenPositionCount(),
    });
    if (!sellCapacity.allowed) {
      this.recordExecutionSellCapacitySample(
        cmd,
        false,
        WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
        sellCapacity,
        reservations,
      );
      return {
        kind: "reject",
        reason: WALLET_SELL_CAPACITY_EXHAUSTED_REASON,
        message: "order skipped — wallet sell capacity exhausted",
        capacitySampleRecorded: true,
        details: {
          openSellOrders: sellCapacity.openSellOrderCount,
          openProfileLadderSellOrders: sellCapacity.openProfileLadderSellOrderCount,
          openNonProfileLadderSellOrders: sellCapacity.openNonProfileLadderSellOrderCount,
          maxOpenSellOrders: sellCapacity.maxOpenSellOrders,
          sellCapacitySource: sellCapacity.source,
          sellCapacityMode: sellCapacity.mode,
          sellCapacityRejectReason: sellCapacity.rejectionDetail,
          dynamic: sellCapacity.dynamic,
        },
      };
    }
    const perTokenSell = evaluatePerTokenOrderCapacity({
      side: "sell",
      maxOpenOrdersPerToken: this.resolveMaxOpenSellOrdersPerToken(cmd, sellPolicy),
      openOrdersForToken: getOpenOrderCountForToken(reservations, cmd.tokenId, "sell"),
      enabled: sellPolicy.enabled,
    });
    if (!perTokenSell.allowed) {
      return {
        kind: "reject",
        reason: PER_TOKEN_SELL_LIMIT_REASON,
        message: "order skipped — per-token SELL order capacity exhausted",
        details: {
          tokenId: String(cmd.tokenId),
          openSellOrdersForToken: perTokenSell.openOrdersForToken,
          maxOpenSellOrdersPerToken: perTokenSell.maxOpenOrdersPerToken,
        },
      };
    }

    if (!orderCapacity.allowed) {
      return {
        kind: "reject",
        reason: TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
        message: "order skipped — total open order capacity exhausted",
        details: {
          openOrdersTotal: orderCapacity.openOrdersTotal,
          maxOpenOrdersTotal: orderCapacity.maxOpenOrdersTotal,
        },
      };
    }

    if (!this.deps.positionRepo) {
      this.recordExecutionSellCapacitySample(cmd, true, null, sellCapacity, reservations);
      return { kind: "accept" };
    }

    const position = this.deps.positionRepo.findByTokenId(cmd.tokenId);
    if (!position || position.status === "closed") {
      return {
        kind: "reject",
        reason: "reserved-token-limit",
        message: "sell order skipped — no open position for token",
        details: { tokenId: cmd.tokenId, orderSize: cmd.size },
      };
    }

    const localReservedSell = getReservedSellSize(reservations, cmd.tokenId);
    const reservedSell = this.effectiveReservedSell(cmd.tokenId, localReservedSell);
    const upperBound = this.computeSellUpperBound(cmd.tokenId, position.size);
    const availableSize = upperBound - reservedSell;
    if (availableSize + ExecutionModule.SIZE_EPSILON_SHARES >= cmd.size) {
      if (cmd.side === "sell") {
        const minOrderSize = this.resolveCommandExplicitMinOrderSize(cmd);
        const normalized = normalizeSellSizeForMinOrder({
          availableSize,
          desiredSize: cmd.size,
          marketMinOrderSize: minOrderSize,
        });
        if (normalized.kind === "unsellable") {
          return {
            kind: "reject",
            reason: SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
            errorCode: ExchangeErrorCode.InvalidSize,
            message: "sell order skipped — residual below exchange minimum",
            details: {
              tokenId: cmd.tokenId,
              positionSize: position.size,
              upperBound,
              reservedSell,
              localReservedSell,
              availableSize,
              orderSize: cmd.size,
              minOrderSize,
            },
          };
        }
        if (normalized.kind === "clamp") {
          const reason =
            normalized.reason === "intent-below-min"
              ? "intent-below-min-residual-above-min"
              : "orphan-residual-below-min";
          this.recordExecutionSellCapacitySample(cmd, true, null, sellCapacity, reservations);
          return {
            kind: "clamp",
            newSize: normalized.size,
            details: {
              tokenId: cmd.tokenId,
              positionSize: position.size,
              upperBound,
              reservedSell,
              localReservedSell,
              availableSize,
              intentSize: cmd.size,
              minOrderSize,
              clampDirection: "up-to-available",
              reason,
            },
          };
        }
      }
      this.recordExecutionSellCapacitySample(cmd, true, null, sellCapacity, reservations);
      return { kind: "accept" };
    }

    const clampEnabled = this.deps.allowSellSizeClamp !== false;
    if (clampEnabled && availableSize > ExecutionModule.SIZE_EPSILON_SHARES) {
      const minOrderSize = this.resolveCommandExplicitMinOrderSize(cmd);
      if (
        minOrderSize != null &&
        Number.isFinite(minOrderSize) &&
        minOrderSize > 0 &&
        availableSize + ExecutionModule.SIZE_EPSILON_SHARES < minOrderSize
      ) {
        return {
          kind: "reject",
          reason: SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON,
          errorCode: ExchangeErrorCode.InvalidSize,
          message: "sell order skipped — available residual below exchange minimum",
          details: {
            tokenId: cmd.tokenId,
            positionSize: position.size,
            upperBound,
            reservedSell,
            localReservedSell,
            availableSize,
            orderSize: cmd.size,
            minOrderSize,
          },
        };
      }
      this.recordExecutionSellCapacitySample(cmd, true, null, sellCapacity, reservations);
      return {
        kind: "clamp",
        newSize: availableSize,
        details: {
          tokenId: cmd.tokenId,
          positionSize: position.size,
          upperBound,
          reservedSell,
          localReservedSell,
          availableSize,
          intentSize: cmd.size,
        },
      };
    }

    return {
      kind: "reject",
      reason: "reserved-token-limit",
      message: "sell order skipped — token balance already reserved by open sell orders",
      details: {
        tokenId: cmd.tokenId,
        positionSize: position.size,
        upperBound,
        reservedSell,
        localReservedSell,
        availableSize,
        orderSize: cmd.size,
      },
    };
  }

  private resolveMaxOpenSellOrdersPerToken(
    cmd: PlaceOrderCommand,
    sellPolicy: ReturnType<typeof normalizeSellCapacityPolicy>,
  ): number {
    if (cmd.decisionRuleId === S1_LADDER_RULE_ID) {
      return (
        this.currentTrackS1Policy()?.s1MaxOrdersPerToken ?? sellPolicy.maxOpenSellOrdersPerToken
      );
    }
    return sellPolicy.maxOpenSellOrdersPerToken;
  }

  /** CHANGE B — wallet/local upper-bound for SELL clamp. */
  private computeSellUpperBound(tokenId: TokenId, localPositionSize: number): number {
    if (!this.deps.exchangeStateStore) return localPositionSize;
    const walletSize = this.deps.exchangeStateStore.getWalletPositionSize(tokenId);
    const walletCapturedAt = this.deps.exchangeStateStore.getWalletPositionCapturedAt(tokenId);
    const latestFillMs = this.getLatestFillMs(tokenId);
    return computeSellUpperBound({
      localPositionSize,
      walletPositionSize: walletSize,
      walletCapturedAtMs: walletCapturedAt,
      latestFillMs,
    });
  }

  /**
   * CHANGE C — `localReservedSell + sum(exchange SELL orders unknown to local)`
   * when the flag is on. The conservative union avoids the undercount when
   * local and exchange order sets are not subsets (e.g. an in-flight local
   * SELL not yet visible to the exchange + a phantom exchange order with no
   * local record). Falls back to local-only when no fresh snapshot exists.
   */
  private effectiveReservedSell(tokenId: TokenId, localReservedSell: number): number {
    if (this.deps.sellExchangeReservedEnabled === false) return localReservedSell;
    const store = this.deps.exchangeStateStore;
    if (!store) return localReservedSell;
    const known = this.collectKnownLocalExchangeOrderIds(tokenId);
    const exchangeOnly = store.getOpenSellSizeUnknownToLocal(tokenId, known);
    if (exchangeOnly === null) return localReservedSell;
    return localReservedSell + exchangeOnly;
  }

  private collectKnownLocalExchangeOrderIds(tokenId: TokenId): Set<string> {
    const known = new Set<string>();
    for (const order of this.deps.orderRepo.findOpen()) {
      if (order.side !== "sell") continue;
      if (String(order.tokenId) !== String(tokenId)) continue;
      if (order.exchangeOrderId) known.add(order.exchangeOrderId);
    }
    return known;
  }

  /** CHANGE A — true when the token is in a balance-reject cooldown. */
  private isBalanceBlocked(cmd: PlaceOrderCommand): boolean {
    if (this.deps.sellBalanceRejectBlockEnabled === false) return false;
    if (!this.deps.exchangeStateStore) return false;
    return this.deps.exchangeStateStore.isBalanceBlocked(cmd.tokenId);
  }

  private getLatestFillMs(tokenId: TokenId): number | null {
    const recent = this.deps.fillRepo.findRecentByTokenId?.(tokenId, 1);
    if (recent && recent.length > 0) {
      const ts = Date.parse(recent[0]!.filledAt);
      return Number.isFinite(ts) ? ts : null;
    }
    let latest: number | null = null;
    for (const fill of this.deps.fillRepo.findByTokenId(tokenId)) {
      const ts = Date.parse(fill.filledAt);
      if (!Number.isFinite(ts)) continue;
      if (latest === null || ts > latest) latest = ts;
    }
    return latest;
  }

  private getMinOrderSizeRejection(cmd: PlaceOrderCommand): { minOrderSize: number } | null {
    const minOrderSize = this.resolveCommandMinOrderSize(cmd);
    if (
      minOrderSize == null ||
      !Number.isFinite(minOrderSize) ||
      minOrderSize <= 0 ||
      cmd.size + ExecutionModule.SIZE_EPSILON_SHARES >= minOrderSize
    ) {
      return null;
    }
    return { minOrderSize };
  }

  private getSellPreSubmitMinOrderBlock(
    cmd: PlaceOrderCommand,
  ): { reason: string; minOrderSize: number | null } | null {
    if (cmd.side !== "sell") return null;
    const guard = evaluateSellPreSubmitGuard(
      cmd.size,
      this.resolveCommandExplicitMinOrderSize(cmd),
    );
    if (guard.proceed) return null;
    if (
      guard.reason === SELL_RESIDUAL_UNKNOWN_MIN_ORDER_SIZE_REASON &&
      this.deps.runtimeMode !== "live-lite"
    ) {
      return null;
    }
    return { reason: guard.reason, minOrderSize: guard.minOrderSize };
  }

  private getPostOnlyCrossPreSubmitSkip(cmd: PlaceOrderCommand): PostOnlyCrossPreSubmitSkip | null {
    if (cmd.postOnly !== true) return null;
    const market = this.marketCache.get(String(cmd.tokenId));

    if (cmd.side === "sell") {
      const bestBid = market?.bestBid ?? null;
      const bestAsk = market?.bestAsk ?? null;
      if (bestBid == null || !Number.isFinite(bestBid) || bestBid <= 0) return null;
      if (cmd.price > bestBid + ExecutionModule.PRICE_EPSILON) return null;
      return {
        bestBid,
        bestAsk,
        bookSource: market?.bookSource ?? null,
        snapshotTs: market?.snapshotTs ?? null,
      };
    }

    if (cmd.side === "buy") {
      const bestAsk = market?.bestAsk ?? null;
      if (bestAsk === null || !Number.isFinite(bestAsk)) return null;
      if (cmd.price + ExecutionModule.PRICE_EPSILON < bestAsk) return null;
      return {
        bestBid: market?.bestBid ?? 0,
        bestAsk,
        bookSource: market?.bookSource ?? null,
        snapshotTs: market?.snapshotTs ?? null,
      };
    }

    return null;
  }

  /**
   * Phase 3: returns true only when the in-memory marketCache EXPLICITLY says
   * acceptingOrders === false. Absent from cache (unknown liveness) → returns
   * false so the order proceeds (fail-open). Never calls deactivate().
   */
  private getNotAcceptingOrdersSkip(cmd: PlaceOrderCommand): boolean {
    const market = this.marketCache.get(String(cmd.tokenId));
    return market !== undefined && market.acceptingOrders === false;
  }

  private async skipNotAcceptingOrders(cmd: PlaceOrderCommand): Promise<void> {
    this.log.warn(
      {
        commandId: cmd.commandId,
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        side: cmd.side,
        price: cmd.price,
      },
      "order suppressed — market not accepting orders",
    );
    await this.publishOrderSkipped(cmd, "not_accepting_orders", {
      conditionId: String(cmd.conditionId),
    });
  }

  private async skipDuplicateBuyPreSubmitIfNeeded(cmd: PlaceOrderCommand): Promise<boolean> {
    if (cmd.side !== "buy") return false;
    const duplicate = findNearDuplicateOpenBuy(this.deps.orderRepo.findOpen(), cmd, cmd.tickSize);
    if (!duplicate) return false;

    const details = {
      existingOrderId: String(duplicate.orderId),
      existingPrice: duplicate.price,
      requestedPrice: cmd.price,
      tickSize: cmd.tickSize,
      signalReason: cmd.signalReason ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
    };
    this.log.debug(
      { commandId: cmd.commandId, tokenId: String(cmd.tokenId), ...details },
      "buy order skipped — duplicate open BUY already resting",
    );
    this.recordBuyCounter("buy_duplicate_deduped", cmd);
    await this.publishOrderSkipped(cmd, BUY_DUPLICATE_DEDUPED_REASON, details);
    return true;
  }

  private async deferBuyForTargetedCapacityReplacementIfNeeded(
    cmd: PlaceOrderCommand,
  ): Promise<boolean> {
    if (cmd.side !== "buy") return false;
    const buyPolicy = normalizeBuyCapacityPolicy(this.currentBuyCapacityPolicy());
    if (!buyPolicy.enabled || buyPolicy.maxOpenBuyOrders <= 0) return false;

    const openOrders = this.deps.orderRepo.findOpen();
    const openBuyCount = openOrders.filter(
      (order) =>
        order.side === "buy" &&
        (order.status === "pending" ||
          order.status === "open" ||
          order.status === "partially-filled"),
    ).length;
    if (openBuyCount < buyPolicy.maxOpenBuyOrders) return false;

    const duplicatePair = findDuplicateOpenBuyPair(openOrders);
    const now = Date.now();
    const blocker =
      duplicatePair?.cancel ??
      findOldestStaleOpenBuy(
        openOrders,
        (order) => this.deps.marketRepo.findByTokenId(order.tokenId),
        now,
      );
    if (!blocker) return false;

    const replacementKind = duplicatePair?.cancel === blocker ? "duplicate" : "stale";
    const cancelReason =
      replacementKind === "duplicate" ? "buy_duplicate_replacement" : "stale_entry_ttl";
    await this.deps.bus.publish("CancelOrderRequested", {
      command: {
        type: "CancelOrderCommand",
        commandId: createCommandId(
          `buy-cap-replace-${String(blocker.orderId)}-${String(cmd.commandId)}-${now}`,
        ),
        orderId: blocker.orderId,
        reason: cancelReason,
      },
      timestamp: now,
    });

    const details = {
      replacementKind,
      cancelledOrderId: String(blocker.orderId),
      cancelReason,
      openBuyOrders: openBuyCount,
      maxOpenBuyOrders: buyPolicy.maxOpenBuyOrders,
      signalReason: cmd.signalReason ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
    };
    this.recordBuyCounter("buy_cap_full_targeted_replacement", cmd, {
      replacementKind,
      cancelReason,
    });
    await this.publishOrderSkipped(cmd, BUY_CAP_FULL_TARGETED_REPLACEMENT_REASON, details);
    return true;
  }

  private async skipPostOnlyCrossPreSubmit(
    cmd: PlaceOrderCommand,
    postOnlyCross: PostOnlyCrossPreSubmitSkip,
  ): Promise<void> {
    const msg =
      cmd.side === "buy"
        ? "buy order skipped — post-only price would cross current ask"
        : "sell order skipped — post-only price would cross current bid";
    this.log.warn(
      {
        commandId: cmd.commandId,
        tokenId: cmd.tokenId,
        side: cmd.side,
        price: cmd.price,
        currentBestBid: postOnlyCross.bestBid,
        currentBestAsk: postOnlyCross.bestAsk,
        bookSource: postOnlyCross.bookSource,
      },
      msg,
    );
    const details = {
      price: cmd.price,
      currentBestBid: postOnlyCross.bestBid,
      currentBestAsk: postOnlyCross.bestAsk,
      bookSource: postOnlyCross.bookSource,
      snapshotTs: postOnlyCross.snapshotTs,
    };
    this.recordOrderSkipped(cmd, "post-only-cross-pre-submit", details);
    // Live no-op signal for the loop guard — published before any working order
    // exists, so it counts independently of deduplicated risk_events.
    await this.deps.bus.publish("OrderSkipped", {
      commandId: cmd.commandId,
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      reasonCode: "post-only-cross-pre-submit",
      side: cmd.side,
      price: cmd.price,
      size: cmd.size,
      signalReason: cmd.signalReason ?? null,
      signalId: cmd.signalId ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
      signalTimestamp: cmd.signalTimestamp ?? null,
      details,
      timestamp: Date.now(),
    });
  }

  private async skipDuplicateClientOrderIdPreSubmit(
    cmd: PlaceOrderCommand,
    existing: Order,
  ): Promise<void> {
    const details = {
      existingOrderId: String(existing.orderId),
      existingStatus: existing.status,
      existingExchangeOrderId: existing.exchangeOrderId ?? null,
      source: boundedMetricLabel(cmd.source),
    };
    this.log.warn(
      {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        tokenId: cmd.tokenId,
        side: cmd.side,
        existingOrderId: details.existingOrderId,
        existingStatus: details.existingStatus,
        existingExchangeOrderId: details.existingExchangeOrderId,
      },
      "order skipped before exchange submit — duplicate clientOrderId exists locally",
    );
    this.deps.runtimeMetrics?.writeCounter?.(
      "order_duplicate_client_order_id_pre_submit",
      1,
      JSON.stringify({
        side: cmd.side,
        source: boundedMetricLabel(cmd.source),
        signalReason: boundedMetricLabel(cmd.signalReason),
        decisionRuleId: boundedMetricLabel(cmd.decisionRuleId),
        existingStatus: boundedMetricLabel(existing.status),
      }),
    );
    await this.publishOrderSkipped(cmd, "duplicate_client_order_id_pre_submit", details);
  }

  private async publishOrderSkipped(
    cmd: PlaceOrderCommand,
    reasonCode: string,
    details: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.recordOrderSkipped(cmd, reasonCode, details);
    await this.deps.bus.publish("OrderSkipped", {
      commandId: cmd.commandId,
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      reasonCode,
      side: cmd.side,
      price: cmd.price,
      size: cmd.size,
      signalReason: cmd.signalReason ?? null,
      signalId: cmd.signalId ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
      signalTimestamp: cmd.signalTimestamp ?? null,
      details,
      timestamp: Date.now(),
    });
  }

  private persistAcceptedOrderOrThrow(
    cmd: PlaceOrderCommand,
    order: Order,
    exchangeOrderId: string,
  ): void {
    try {
      this.deps.orderRepo.save(order);
    } catch (err) {
      const persistenceError = errorToLogMessage(err);
      const payload = {
        commandId: String(cmd.commandId),
        exchangeOrderId,
        clientOrderId: String(cmd.clientOrderId),
        tokenId: String(cmd.tokenId),
        conditionId: String(cmd.conditionId),
        side: cmd.side,
        price: cmd.price,
        size: cmd.size,
        signalReason: cmd.signalReason ?? null,
        signalId: cmd.signalId ?? null,
        decisionRuleId: cmd.decisionRuleId ?? null,
        signalTimestamp: cmd.signalTimestamp ?? null,
        persistenceError,
        occurredAt: new Date().toISOString(),
      };
      this.log.fatal(
        payload,
        "order persistence failed after exchange accept — exchange-live orphan risk",
      );
      try {
        this.deps.riskEventRepo?.insert({
          eventType: "order_persist_failed_after_exchange_accept",
          payload,
        });
      } catch (riskErr) {
        this.log.error(
          {
            err: riskErr,
            commandId: cmd.commandId,
            exchangeOrderId,
            clientOrderId: cmd.clientOrderId,
          },
          "failed to persist order_persist_failed_after_exchange_accept risk event",
        );
      }
      throw err;
    }
  }

  /** Write corrected tick to DB + refresh all in-memory caches. Fire-and-
   *  forget from the bus perspective — NormalizedMarketUpdated is awaited so
   *  the signal-to-order cache is updated before the next sweep.
   *
   *  M5: iterates the entire marketCache to update BOTH tokens of the binary
   *  market (YES and NO share the same conditionId but each has its own cache
   *  key). The tokenId param is kept for call-site compatibility but is unused
   *  — the conditionId is the authoritative key for the DB write. */
  private async applyTickCorrection(
    conditionId: string,
    _tokenId: TokenId,
    authTick: number,
  ): Promise<void> {
    // Narrow DB write: only tick_size + updated_at (no saveBatch clobber risk).
    this.deps.marketRepo.updateTickSize(conditionId, authTick);

    // Refresh every cached token that belongs to this condition (typically 2:
    // the YES and NO outcomes). Collect into an array for a single bus publish.
    const correctedMarkets: NormalizedMarket[] = [];
    for (const [key, market] of this.marketCache) {
      if (market.conditionId === conditionId) {
        const corrected: NormalizedMarket = { ...market, tickSize: authTick };
        this.marketCache.set(key, corrected);
        correctedMarkets.push(corrected);
      }
    }

    if (correctedMarkets.length > 0) {
      // Propagate to all EventBus subscribers (signal-to-order, etc.).
      await this.deps.bus.publish("NormalizedMarketUpdated", {
        markets: correctedMarkets,
        timestamp: Date.now(),
      });
    }
  }

  private getInvalidPriceRejection(cmd: PlaceOrderCommand): {
    reason: string;
    tickSize: number;
    minPrice: number;
    maxPrice: number;
  } | null {
    const validation = validateExecutablePrice(cmd.price, cmd.tickSize);
    if (validation.ok) return null;
    return {
      reason: validation.reason,
      tickSize: validation.tickSize,
      minPrice: validation.minPrice,
      maxPrice: validation.maxPrice,
    };
  }

  private resolveCommandMinOrderSize(cmd: PlaceOrderCommand): number | null {
    const explicitMinOrderSize = this.resolveCommandExplicitMinOrderSize(cmd);
    if (explicitMinOrderSize != null) return explicitMinOrderSize;

    return this.deps.runtimeMode === "live-lite" ? DEFAULT_FALLBACK_MIN_ORDER_SIZE : null;
  }

  private resolveCommandExplicitMinOrderSize(cmd: PlaceOrderCommand): number | null {
    const cachedMinOrderSize = this.resolveCachedMinOrderSize(cmd.tokenId);
    if (cachedMinOrderSize != null) return cachedMinOrderSize;

    const metadata = cmd.metadata;
    if (!metadata || typeof metadata !== "object") return null;
    const marketData = (metadata as Record<string, unknown>).marketData;
    if (!marketData || typeof marketData !== "object") return null;
    const rawMarketData = marketData as Record<string, unknown>;
    const value = rawMarketData.minOrderSize;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    return null;
  }

  private resolveCachedMinOrderSize(tokenId: TokenId): number | null {
    const value = this.marketCache.get(String(tokenId))?.minOrderSize;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  }

  private recordOrderSkipped(
    cmd: PlaceOrderCommand,
    reasonCode: string,
    details: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.deps.riskEventRepo?.insert({
        eventType: "order_skipped",
        payload: {
          commandId: String(cmd.commandId),
          clientOrderId: String(cmd.clientOrderId),
          tokenId: String(cmd.tokenId),
          conditionId: String(cmd.conditionId),
          reasonCode,
          side: cmd.side,
          price: cmd.price,
          size: cmd.size,
          signalReason: cmd.signalReason ?? null,
          signalId: cmd.signalId ?? null,
          decisionRuleId: cmd.decisionRuleId ?? null,
          signalTimestamp: cmd.signalTimestamp ?? null,
          ...details,
          skippedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      this.log.warn(
        { err, commandId: String(cmd.commandId), reasonCode },
        "failed to persist order_skipped risk event",
      );
    }
  }

  private recordBuyCounter(
    metricName: "buy_duplicate_deduped" | "buy_cap_full_targeted_replacement",
    cmd: PlaceOrderCommand,
    extraLabels: Readonly<Record<string, string>> = {},
  ): void {
    this.deps.runtimeMetrics?.writeCounter?.(
      metricName,
      1,
      JSON.stringify({
        signalReason: boundedMetricLabel(cmd.signalReason),
        decisionRuleId: boundedMetricLabel(cmd.decisionRuleId),
        ...extraLabels,
      }),
    );
  }

  private static looksLikeMinSizeError(
    message: string | null | undefined,
    details: unknown,
  ): boolean {
    const parts: string[] = [];
    if (typeof message === "string") parts.push(message);
    if (details != null) {
      try {
        parts.push(JSON.stringify(details));
      } catch {
        /* ignore */
      }
    }
    const lower = parts.join(" ").toLowerCase();
    return (
      lower.includes("lower than the minimum") ||
      lower.includes("invalid size") ||
      lower.includes("min order size") ||
      lower.includes("size must")
    );
  }

  private async deferSellReplacementIfNeeded(cmd: PlaceOrderCommand): Promise<boolean> {
    if (cmd.side !== "sell") return false;
    if (this.isSellReplacementSubmit(cmd)) return false;

    // Normal exit management keeps one live price per token and replaces it
    // when strategy moves. The per-token SELL cap is a race/legacy-state
    // ceiling, not permission to stack multiple independent exit prices.
    const existingSells = this.findOpenSellOrdersForToken(cmd.tokenId);
    const key = String(cmd.tokenId);
    const profileLadderOldOrderId = this.getProfileLadderReplacementOldOrderId(cmd);
    if (profileLadderOldOrderId != null) {
      const validation = this.validateProfileLadderReplacementTarget(
        profileLadderOldOrderId,
        existingSells,
      );
      if (!validation.ok) {
        await this.rejectOrder(cmd, validation.reason, ExchangeErrorCode.LivePolicyBlocked);
        return true;
      }
    }
    if (existingSells.length === 0) {
      this.sellReplaceLocks.delete(key);
      return false;
    }

    const existingSell =
      profileLadderOldOrderId == null
        ? existingSells[0]!
        : existingSells.find((order) => orderMatchesOrderId(order, profileLadderOldOrderId))!;
    const policy = this.deps.executionPolicy?.();
    const now = Date.now();
    const repriceThreshold = resolveSellRepriceThreshold(existingSell.price, cmd.tickSize, policy);
    if (repriceThreshold === null) {
      this.log.warn(
        {
          tokenId: String(cmd.tokenId),
          existingOrderId: String(existingSell.orderId),
          existingPrice: existingSell.price,
          requestedPrice: cmd.price,
          tickSize: cmd.tickSize,
        },
        "sell replacement suppressed — invalid reprice threshold inputs",
      );
      await this.rejectOrder(
        cmd,
        "sell-replace-invalid-threshold",
        ExchangeErrorCode.LivePolicyBlocked,
      );
      return true;
    }
    const anchorDelta = Math.abs(existingSell.price - cmd.price);
    const timeoutSizeReplacement = isSellTimeoutReplacement({
      existingOrder: existingSell,
      requestedSize: cmd.size,
      nowMs: now,
      sellTimeoutMs: policy?.sellTimeoutMs,
    });
    if (anchorDelta <= repriceThreshold.thresholdAbs && !timeoutSizeReplacement) {
      this.deps.runtimeMetrics?.writeCounter?.(
        "exit_reprice_suppressed_threshold_total",
        1,
        JSON.stringify({ source: "sell_replace" }),
      );
      await this.rejectOrder(
        cmd,
        "sell-order-acceptable-price-already-open",
        ExchangeErrorCode.LivePolicyBlocked,
      );
      return true;
    }

    const existingLock = this.sellReplaceLocks.get(key);
    if (
      existingLock &&
      now - existingLock.createdAt < ExecutionModule.SELL_REPLACE_LOCK_TIMEOUT_MS
    ) {
      await this.rejectOrder(cmd, "sell-replace-lock-active", ExchangeErrorCode.LivePolicyBlocked);
      return true;
    }

    // CHANGE C — R65 p90 = 13 reprice events / 24h cap. Enforce on both the
    // initial sell_replace_reprice publish and on sell_replace_retry, so a
    // long-running lock cannot extend the chain past the ceiling.
    if (this.deps.legStateRepo && this.deps.repriceChainPolicy) {
      const policy = this.deps.repriceChainPolicy();
      const market = this.marketCache.get(key) ?? null;
      const cap = resolveDynamicChainCapDetails(market, policy);
      const effectivePolicy = { ...policy, maxChainCount: cap.maxChainCount };
      this.recordExitChainCapResolved(
        cap.bucket,
        existingLock
          ? "sell_replace_retry"
          : timeoutSizeReplacement
            ? "sell_timeout"
            : "sell_replace",
      );
      const legState = this.deps.legStateRepo.get(cmd.tokenId);
      if (shouldBlockRepriceChain(legState, now, effectivePolicy)) {
        try {
          this.deps.riskEventRepo?.insert({
            eventType: "signal_suppressed",
            payload: {
              tokenId: String(cmd.tokenId),
              orderId: String(existingSell.orderId),
              reasonCode: "sell-replace-chain-cap",
              source: existingLock
                ? "sell_replace_retry"
                : timeoutSizeReplacement
                  ? "sell_timeout_escalation"
                  : "sell_replace_reprice",
              count24h: legState?.repriceChainCount24h ?? 0,
              maxChainCount: effectivePolicy.maxChainCount,
              dynamicCapBucket: cap.bucket,
              publicTradeCount24h: cap.publicTradeCount24h,
              signalTimestamp: new Date(now).toISOString(),
            },
          });
        } catch (err) {
          this.log.warn(
            { err, tokenId: String(cmd.tokenId) },
            "failed to persist sell-replace-chain-cap risk event",
          );
        }
        await this.rejectOrder(cmd, "sell-replace-chain-cap", ExchangeErrorCode.LivePolicyBlocked);
        return true;
      }
    }

    this.sellReplaceLocks.set(key, { orderId: existingSell.orderId, command: cmd, createdAt: now });
    await this.deps.bus.publish("CancelOrderRequested", {
      command: {
        type: "CancelOrderCommand",
        commandId: createCommandId(`sell-replace-${String(existingSell.orderId)}-${now}`),
        orderId: existingSell.orderId,
        reason: existingLock
          ? "sell_replace_retry"
          : timeoutSizeReplacement
            ? "sell_timeout_escalation"
            : "sell_replace_reprice",
      },
      timestamp: now,
    });
    await this.rejectOrder(
      cmd,
      existingLock ? "sell-replace-lock-retry" : "sell-replace-pending",
      ExchangeErrorCode.LivePolicyBlocked,
    );
    return true;
  }

  private findOpenSellOrdersForToken(tokenId: TokenId): Order[] {
    return this.deps.orderRepo
      .findByTokenId(tokenId)
      .filter(
        (order) =>
          order.side === "sell" &&
          (order.status === "pending" ||
            order.status === "open" ||
            order.status === "partially-filled"),
      );
  }

  private isSellReplacementSubmit(cmd: PlaceOrderCommand): boolean {
    return (
      cmd.side === "sell" &&
      typeof cmd.metadata?.[ExecutionModule.SELL_REPLACEMENT_CANCELLED_ORDER_ID] === "string"
    );
  }

  private getProfileLadderReplacementOldOrderId(cmd: PlaceOrderCommand): string | null {
    const metadata = cmd.metadata;
    if (metadata == null || typeof metadata !== "object") return null;
    const replacement = metadata.profileLadderReplacement;
    if (replacement == null || typeof replacement !== "object") return null;
    const oldOrderId = (replacement as Readonly<Record<string, unknown>>).oldOrderId;
    return typeof oldOrderId === "string" && oldOrderId.length > 0 ? oldOrderId : null;
  }

  private validateProfileLadderReplacementTarget(
    oldOrderId: string,
    existingSells: readonly Order[],
  ): { ok: true } | { ok: false; reason: string } {
    return validateProfileLadderReplacementSellTarget(oldOrderId, existingSells);
  }

  private async releasePendingSellReplacement(cancelledOrderId: OrderId): Promise<void> {
    for (const [tokenKey, lock] of this.sellReplaceLocks) {
      if (lock.orderId !== cancelledOrderId) continue;
      this.sellReplaceLocks.delete(tokenKey);
      const replacement: PlaceOrderCommand = {
        ...lock.command,
        commandId: createCommandId(`sell-replace-submit-${String(cancelledOrderId)}-${Date.now()}`),
        metadata: {
          ...(lock.command.metadata ?? {}),
          [ExecutionModule.SELL_REPLACEMENT_CANCELLED_ORDER_ID]: String(cancelledOrderId),
        },
      };
      await this.deps.bus.publish("PlaceOrderRequested", {
        command: replacement,
        timestamp: Date.now(),
      });
      return;
    }
  }

  private recordExitChainCapResolved(bucket: string, source: string): void {
    this.deps.runtimeMetrics?.writeCounter?.(
      "exit_chain_cap_resolved_total",
      1,
      JSON.stringify({ bucket, source }),
    );
  }

  private async rejectOrder(
    cmd: PlaceOrderCommand,
    reason: string,
    errorCode: ExchangeErrorCode,
  ): Promise<void> {
    await this.publishOrderRejected(cmd, { reason, errorCode, timestamp: Date.now() });
    this.maybeIncrementDustCounterForExecutionReject(cmd, reason);
  }

  private maybeIncrementDustCounterForExecutionReject(
    cmd: PlaceOrderCommand,
    reason: string,
  ): void {
    if (cmd.side !== "sell") return;
    if (reason !== SELL_RESIDUAL_BELOW_MIN_ORDER_SIZE_REASON) return;
    const position = this.deps.positionRepo?.findByTokenId(cmd.tokenId);
    const minOrderSize = this.resolveCommandMinOrderSize(cmd);
    if (!position || !isPositionDust(position.size, minOrderSize)) return;
    const legStateRepo = this.deps.legStateRepo;
    const executionPolicy = this.deps.executionPolicy;
    if (!legStateRepo || !executionPolicy) return;
    const dustPolicy = executionPolicy().dustAbandonment;
    if (!dustPolicy.enabled) return;
    const nowIso = new Date().toISOString();
    const price = resolvePriceFromCmd(cmd);
    try {
      legStateRepo.incrementSellResidualReject(cmd.tokenId, nowIso, {
        threshold: dustPolicy.maxConsecutiveRejects,
        price,
      });
    } catch (err) {
      this.log.warn(
        { err, tokenId: cmd.tokenId, reason },
        "execution-level dust counter increment failed",
      );
    }
  }

  private async publishOrderRejected(
    cmd: PlaceOrderCommand,
    params: {
      reason: string;
      errorCode: ExchangeErrorCode;
      timestamp: number;
      exchangeErrorMessage?: string | null;
      exchangeErrorDetails?: Readonly<Record<string, unknown>> | null;
    },
  ): Promise<void> {
    await this.deps.bus.publish("OrderRejected", {
      commandId: cmd.commandId,
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      reason: params.reason,
      errorCode: params.errorCode,
      signalReason: cmd.signalReason ?? null,
      side: cmd.side,
      signalId: cmd.signalId ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
      signalTimestamp: cmd.signalTimestamp ?? null,
      exchangeErrorMessage: params.exchangeErrorMessage ?? null,
      exchangeErrorDetails: params.exchangeErrorDetails ?? null,
      timestamp: params.timestamp,
    });
  }

  private recordGatewayReject(errorCode: string): void {
    this.gatewayRejects.push({ ts: Date.now(), code: errorCode });
    this.pruneDiagnosticsWindows();
  }

  private handleExchangeBalanceRejection(
    cmd: PlaceOrderCommand,
    payload: {
      errorCode: ExchangeErrorCode | null;
      errorMessage: string | null;
      errorDetails: Readonly<Record<string, unknown>> | null;
    },
  ): void {
    if (cmd.side !== "sell") return;
    const isInsufficient =
      payload.errorCode === ExchangeErrorCode.InsufficientBalance ||
      isExchangeBalanceRejection(payload);
    if (!isInsufficient) return;
    const enabled = this.deps.sellBalanceRejectBlockEnabled !== false;
    const store = this.deps.exchangeStateStore;
    const block = enabled && store ? store.markBalanceReject(cmd.tokenId) : null;
    this.deps.runtimeMetrics?.writeEvent(
      "exchange_balance_reject_count",
      1,
      JSON.stringify({ tokenId: String(cmd.tokenId), side: cmd.side }),
      new Date().toISOString(),
    );
    this.log.warn(
      {
        tokenId: String(cmd.tokenId),
        commandId: cmd.commandId,
        blockedUntilMs: block?.blockedUntilMs ?? null,
        rejectCount: block?.count ?? null,
      },
      "exchange rejected SELL for balance/allowance — token put in cool-down",
    );
    // Trigger an immediate reconcile so the next SELL evaluates against the
    // refreshed wallet/exchange snapshot rather than waiting for the next tick.
    try {
      this.deps.reconciliationTrigger?.();
    } catch (err) {
      this.log.debug({ err }, "reconciliation trigger threw — ignoring");
    }
  }

  private gatewayRejectReason(
    errorCode: ExchangeErrorCode | undefined,
    message: string | undefined,
  ): string {
    const lower = (message ?? "").toLowerCase();
    if (
      errorCode === ExchangeErrorCode.InsufficientBalance &&
      lower.includes("balance") &&
      lower.includes("allowance")
    ) {
      return "exchange-insufficient-balance-or-allowance";
    }
    return message ?? "unknown";
  }

  private recordInternalReservationReject(): void {
    this.internalReservationRejects.push(Date.now());
    this.pruneDiagnosticsWindows();
  }

  private getGatewayRejectsLast10mByCode(): Record<string, number> {
    this.pruneDiagnosticsWindows();
    const counts: Record<string, number> = {};
    for (const reject of this.gatewayRejects) {
      counts[reject.code] = (counts[reject.code] ?? 0) + 1;
    }
    return counts;
  }

  private getInternalReservationRejectsLast10m(): number {
    this.pruneDiagnosticsWindows();
    return this.internalReservationRejects.length;
  }

  private pruneDiagnosticsWindows(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    while (this.gatewayRejects.length > 0 && this.gatewayRejects[0]!.ts < cutoff) {
      this.gatewayRejects.shift();
    }
    while (
      this.internalReservationRejects.length > 0 &&
      this.internalReservationRejects[0]! < cutoff
    ) {
      this.internalReservationRejects.shift();
    }
  }

  private pruneProcessedCommandIds(): void {
    if (this.processedCommandIds.size > 10_000) {
      const toRemove = this.processedCommandOrder.splice(0, 1000);
      for (const id of toRemove) {
        this.processedCommandIds.delete(id);
      }
    }
  }

  private buildOrder(
    cmd: PlaceOrderCommand,
    status: "open" | "rejected",
    exchangeOrderId: string | null,
    exchangeError?: {
      errorCode: string;
      errorMessage: string | null;
      errorDetails: Readonly<Record<string, unknown>> | null;
      rejectionReason?: string | null;
    },
  ): Order {
    const now = new Date().toISOString();
    return {
      orderId: exchangeOrderId
        ? createOrderId(exchangeOrderId)
        : createOrderId(`rej-${cmd.commandId}`),
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      side: cmd.side,
      orderType: cmd.orderType,
      postOnly: cmd.postOnly === true,
      price: cmd.price,
      size: cmd.size,
      sizeUsdc: cmd.size * cmd.price,
      status,
      exchangeOrderId,
      signalId: cmd.signalId ?? null,
      signalReason: cmd.signalReason ?? null,
      decisionRuleId: cmd.decisionRuleId ?? null,
      signalTimestamp: cmd.signalTimestamp ?? null,
      entryStyle: cmd.entryStyle ?? null,
      exchangeErrorCode: exchangeError?.errorCode ?? null,
      exchangeErrorMessage: exchangeError?.errorMessage ?? null,
      exchangeErrorPayload: stringifyExchangeErrorPayload(exchangeError?.errorDetails ?? null),
      exchangeRejectionReason: exchangeError?.rejectionReason ?? null,
      metadata: cmd.metadata ?? null,
      botRunId: this.deps.botRunId,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Phase 2: one-shot retry for rejection_invalid_tick, called from the rejection
   * branch BEFORE orderRepo.save(). Hard cap = 1 (the caller returns immediately on
   * `true`; it cannot be called again for the same executePlace invocation).
   * Returns true when a retry was attempted so the caller can return; false when a
   * pre-submit guard blocks the retry (caller falls through to persist the original
   * rejection normally).
   */
  private async retryAfterInvalidTick(
    cmd: PlaceOrderCommand,
    firstAttemptTick: number,
    firstPlaceParams: PlaceOrderParams,
    nowMs: number,
  ): Promise<boolean> {
    if (!this.deps.tickResolver) return false;

    // Evict the stale cache entry — the CLOB just confirmed the tick was wrong.
    this.deps.tickResolver.invalidate(cmd.conditionId);
    const retryTick = await this.deps.tickResolver.resolve(
      cmd.conditionId,
      cmd.tickSize,
      cmd.tokenId,
    );

    // M4: if the resolver returned the same tick as the first attempt (e.g.
    // all CLOB lookups failed and it fell back to the persisted value) there
    // is nothing to improve — skip the retry to avoid a guaranteed second rejection.
    if (retryTick === firstAttemptTick) {
      this.log.warn(
        { commandId: cmd.commandId, conditionId: cmd.conditionId, retryTick },
        "invalid-tick rejection — resolved retry tick matches first attempt, skipping retry",
      );
      return false;
    }

    const retryResnap = resnapPriceToTick(cmd.price, cmd.side, retryTick);
    if (!retryResnap.valid) {
      this.log.warn(
        { commandId: cmd.commandId, conditionId: cmd.conditionId, retryTick },
        "invalid-tick rejection — re-snap invalid for retry tick, skipping retry",
      );
      return false;
    }

    // Re-run all price/tick-dependent pre-submit guards on the corrected values.
    const retryCmd = { ...cmd, price: retryResnap.price, tickSize: retryTick } as PlaceOrderCommand;
    const retryPostOnlyCross = this.getPostOnlyCrossPreSubmitSkip(retryCmd);
    const retryDuplicate =
      cmd.side === "buy"
        ? findNearDuplicateOpenBuy(this.deps.orderRepo.findOpen(), retryCmd, retryTick)
        : null;
    const retryPriceValidation = validateExecutablePrice(retryResnap.price, retryTick);

    if (retryPostOnlyCross || retryDuplicate || !retryPriceValidation.ok) {
      this.log.warn(
        {
          commandId: cmd.commandId,
          conditionId: cmd.conditionId,
          retryTick,
          retryPrice: retryResnap.price,
          blockedByPostOnlyCross: !!retryPostOnlyCross,
          blockedByDuplicate: !!retryDuplicate,
          priceValid: retryPriceValidation.ok,
        },
        "invalid-tick rejection — retry blocked by pre-submit guard",
      );
      return false;
    }

    const retryParams: PlaceOrderParams = {
      ...firstPlaceParams,
      price: retryResnap.price,
      tickSize: retryTick,
    };
    this.log.info(
      {
        commandId: cmd.commandId,
        conditionId: cmd.conditionId,
        firstAttemptTick,
        retryTick,
        retryPrice: retryResnap.price,
      },
      "invalid-tick rejection — retrying once with corrected tick/price",
    );

    const retryResult = await this.deps.gateway.placeOrder(retryParams);

    if (retryResult.success) {
      await this.applyTickCorrection(cmd.conditionId, cmd.tokenId, retryTick);

      if (!retryResult.orderId || retryResult.orderId.trim().length === 0) {
        // Success with no orderId — same treatment as the main path (lines ~1028+).
        const exchangeErrorDetails = { responseBody: null, reason: "missing-order-id" };
        const exchangeRejectionReason = this.classifyExchangeRejection(
          exchangeErrorDetails,
          cmd.commandId,
        );
        const rejectedOrder = this.buildOrder(retryCmd, "rejected", null, {
          errorCode: ExchangeErrorCode.Unknown,
          errorMessage: "gateway returned success without order id",
          errorDetails: exchangeErrorDetails,
          rejectionReason: exchangeRejectionReason,
        });
        this.deps.orderRepo.save(rejectedOrder);
        await this.publishOrderRejected(cmd, {
          reason: "gateway returned success without order id",
          errorCode: ExchangeErrorCode.Unknown,
          exchangeErrorMessage: "gateway returned success without order id",
          exchangeErrorDetails,
          timestamp: nowMs,
        });
        return true;
      }

      const orderId = createOrderId(retryResult.orderId);
      const order = this.buildOrder(retryCmd, "open", retryResult.orderId);
      this.persistAcceptedOrderOrThrow(retryCmd, order, retryResult.orderId);
      this.log.info(
        { commandId: cmd.commandId, orderId: retryResult.orderId },
        "order placed (invalid-tick retry)",
      );
      await this.deps.bus.publish("OrderPlaced", {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        orderId,
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        side: cmd.side,
        price: retryCmd.price,
        size: cmd.size,
        orderType: cmd.orderType,
        signalReason: cmd.signalReason ?? null,
        timestamp: nowMs,
      });
      if (
        !this.deps.runtimeMode ||
        this.deps.runtimeMode === "simulation" ||
        this.deps.runtimeMode === "paper"
      ) {
        await this.checkForFills(orderId);
      }
      return true;
    }

    // Retry also failed — persist using the retry's (final) price and tick.
    const retryErrorCode = retryResult.errorCode ?? ExchangeErrorCode.Unknown;
    this.recordGatewayReject(retryErrorCode);
    const retryErrorDetails = retryResult.errorDetails ?? null;
    const retryRejectionReason = this.classifyExchangeRejection(retryErrorDetails, cmd.commandId);
    const rejectedOrder = this.buildOrder(retryCmd, "rejected", null, {
      errorCode: retryErrorCode,
      errorMessage:
        retryResult.errorMessage ??
        this.gatewayRejectReason(retryResult.errorCode, retryResult.errorMessage),
      errorDetails: retryErrorDetails,
      rejectionReason: retryRejectionReason,
    });
    this.deps.orderRepo.save(rejectedOrder);
    await this.publishOrderRejected(cmd, {
      reason: this.gatewayRejectReason(retryResult.errorCode, retryResult.errorMessage),
      errorCode: retryErrorCode,
      exchangeErrorMessage: retryResult.errorMessage ?? null,
      exchangeErrorDetails: retryErrorDetails,
      timestamp: nowMs,
    });
    return true;
  }

  private classifyExchangeRejection(
    payload: Readonly<Record<string, unknown>> | null,
    commandId: string,
  ): string {
    const reason = classifyExchangeRejectionReason(payload);
    if (reason === "rejection_unknown" && getExchangeRejectionPayloadText(payload) != null) {
      this.log.warn(
        { commandId, exchangeErrorDetails: payload },
        "unknown exchange rejection reason -- classifier needs a new pattern",
      );
    }
    return reason;
  }
}

function stringifyExchangeErrorPayload(
  payload: Readonly<Record<string, unknown>> | null,
): string | null {
  if (!payload) return null;
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

function errorToLogMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "unknown persistence error";
  }
}
