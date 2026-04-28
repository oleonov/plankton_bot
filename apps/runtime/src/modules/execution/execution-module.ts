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
  CancelOrderCommand,
  OrderId,
  BotRunId,
  RuntimeControl,
  ProfileId,
  TokenId,
  PositionRepository,
  ExchangeFill,
} from "@plankton/domain";
import { createCommandId, createOrderId, ExchangeErrorCode } from "@plankton/domain";
import { importExchangeFills } from "../reconciliation/fill-reconciler.js";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { calculateTotalExposure, countActiveOpenMarkets } from "../../exposure-calculator.js";
import { validateExecutablePrice } from "../../executable-price.js";
import { hasWalletBuyBudget, resolveWalletBuyBudget } from "../../wallet-buy-budget.js";
import { ExecutionQueue } from "./execution-queue.js";
import {
  buildReservationSnapshot,
  getReservedSellSize,
  type PendingReservation,
} from "./reservation-utils.js";

type OrderFillLookupGateway = ExchangeGateway & {
  getFillsForOrder?: (orderId: string) => Promise<ExchangeFill[]>;
};

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
  walletBufferPct?: number | undefined;
  walletBufferMinUsdc?: number | undefined;
  allowSellSizeClamp?: boolean | undefined;
}

export class ExecutionModule implements RuntimeModule {
  private static readonly SELL_REPLACE_LOCK_TIMEOUT_MS = 2 * 60 * 1000;
  private static readonly SIZE_EPSILON_SHARES = 1e-9;

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
    );
    this.started = true;
    this.log.info("execution module started");
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

    // Idempotency: skip already-processed commandId
    if (this.processedCommandIds.has(cmd.commandId)) {
      this.log.debug({ commandId: cmd.commandId }, "duplicate commandId — skipping");
      return;
    }

    // Semantic dedup: skip only if an open/pending order exists for this clientOrderId
    const existing = this.deps.orderRepo.findByClientOrderId(cmd.clientOrderId);
    if (existing && (existing.status === "open" || existing.status === "pending")) {
      this.log.debug(
        { clientOrderId: cmd.clientOrderId, status: existing.status },
        "open order with same clientOrderId — skipping",
      );
      this.processedCommandIds.add(cmd.commandId);
      return;
    }

    this.processedCommandIds.add(cmd.commandId);
    this.processedCommandOrder.push(String(cmd.commandId));
    this.pruneProcessedCommandIds();

    if (await this.deferSellReplacementIfNeeded(cmd)) {
      return;
    }

    const decision = this.getReservationDecision(cmd, notional);
    if (decision.kind === "reject") {
      this.recordInternalReservationReject();
      this.log.debug(decision.details, decision.message);
      await this.rejectOrder(cmd, decision.reason, ExchangeErrorCode.InsufficientBalance);
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
    const placeParams = {
      clientOrderId: cmd.clientOrderId as string,
      tokenId: cmd.tokenId,
      side: cmd.side,
      size: cmd.size,
      price: cmd.price,
      ...(cmd.postOnly ? { postOnly: true } : {}),
      orderType: cmd.orderType,
      tickSize: cmd.tickSize,
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

      const rejectedOrder = this.buildOrder(cmd, "rejected", null, {
        errorCode,
        errorMessage: result.errorMessage ?? reason,
        errorDetails: result.errorDetails ?? null,
      });
      this.deps.orderRepo.save(rejectedOrder);

      await this.publishOrderRejected(cmd, {
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
      const rejectedOrder = this.buildOrder(cmd, "rejected", null, {
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "gateway returned success without order id",
        errorDetails: exchangeErrorDetails,
      });
      this.deps.orderRepo.save(rejectedOrder);

      await this.publishOrderRejected(cmd, {
        reason: "gateway returned success without order id",
        errorCode: ExchangeErrorCode.Unknown,
        exchangeErrorMessage: "gateway returned success without order id",
        exchangeErrorDetails,
        timestamp: now,
      });
      return;
    }

    // Order accepted
    const orderId = createOrderId(result.orderId);
    const order = this.buildOrder(cmd, "open", result.orderId);
    this.deps.orderRepo.save(order);

    this.log.info({ commandId: cmd.commandId, orderId: result.orderId }, "order placed");

    await this.deps.bus.publish("OrderPlaced", {
      commandId: cmd.commandId,
      clientOrderId: cmd.clientOrderId,
      orderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      side: cmd.side,
      price: cmd.price,
      size: cmd.size,
      orderType: cmd.orderType,
      signalReason: cmd.signalReason ?? null,
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

    this.deps.orderRepo.updateStatus(cmd.orderId, "cancelled", undefined, cmd.reason);

    this.log.info({ commandId: cmd.commandId, orderId: cmd.orderId }, "order cancelled");

    const cancelledOrder = this.deps.orderRepo.findById(cmd.orderId);
    if (!cancelledOrder) {
      this.log.warn(
        { commandId: cmd.commandId, orderId: cmd.orderId },
        "cancel succeeded but local order not found — skipping OrderCancelled event",
      );
    } else {
      await this.deps.bus.publish("OrderCancelled", {
        commandId: cmd.commandId,
        orderId: cmd.orderId,
        tokenId: cancelledOrder.tokenId,
        conditionId: cancelledOrder.conditionId,
        reason: cmd.reason,
        signalReason: cancelledOrder.signalReason,
        timestamp: now,
      });
    }

    await this.releasePendingSellReplacement(cmd.orderId);
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

  private getReservationDecision(
    cmd: PlaceOrderCommand,
    notional: number,
  ):
    | { kind: "accept" }
    | {
        kind: "reject";
        reason: string;
        message: string;
        details: Record<string, unknown>;
      }
    | {
        kind: "clamp";
        newSize: number;
        details: Record<string, unknown>;
      } {
    const reservations = this.getReservationSnapshot();

    if (cmd.side === "buy") {
      const walletBudget = resolveWalletBuyBudget(
        {
          controlDb: this.deps.controlDb,
          activeProfile: this.deps.activeProfile,
          walletBufferPct: this.deps.walletBufferPct,
          walletBufferMinUsdc: this.deps.walletBufferMinUsdc,
        },
        reservations.reservedBuyUsdc,
      );
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

    if (!this.deps.positionRepo) return { kind: "accept" };

    const position = this.deps.positionRepo.findByTokenId(cmd.tokenId);
    if (!position || position.status !== "open") {
      return {
        kind: "reject",
        reason: "reserved-token-limit",
        message: "sell order skipped — no open position for token",
        details: { tokenId: cmd.tokenId, orderSize: cmd.size },
      };
    }

    const reservedSell = getReservedSellSize(reservations, cmd.tokenId);
    const availableSize = position.size - reservedSell;
    if (availableSize + 1e-9 >= cmd.size) return { kind: "accept" };

    const clampEnabled = this.deps.allowSellSizeClamp !== false;
    if (clampEnabled && availableSize > ExecutionModule.SIZE_EPSILON_SHARES) {
      return {
        kind: "clamp",
        newSize: availableSize,
        details: {
          tokenId: cmd.tokenId,
          positionSize: position.size,
          reservedSell,
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
        reservedSell,
        availableSize,
        orderSize: cmd.size,
      },
    };
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
    const metadata = cmd.metadata;
    if (!metadata || typeof metadata !== "object") return null;
    const marketData = (metadata as Record<string, unknown>).marketData;
    if (!marketData || typeof marketData !== "object") return null;
    const rawMinOrderSize = (marketData as Record<string, unknown>).minOrderSize;
    return typeof rawMinOrderSize === "number" && Number.isFinite(rawMinOrderSize)
      ? rawMinOrderSize
      : null;
  }

  private async deferSellReplacementIfNeeded(cmd: PlaceOrderCommand): Promise<boolean> {
    if (cmd.side !== "sell") return false;

    const existingSell = this.findOpenSellOrderForToken(cmd.tokenId);
    const key = String(cmd.tokenId);
    if (!existingSell) {
      this.sellReplaceLocks.delete(key);
      return false;
    }

    if (Math.abs(existingSell.price - cmd.price) < cmd.tickSize - 1e-9) {
      await this.rejectOrder(cmd, "sell-order-already-open", ExchangeErrorCode.LivePolicyBlocked);
      return true;
    }

    const now = Date.now();
    const existingLock = this.sellReplaceLocks.get(key);
    if (
      existingLock &&
      now - existingLock.createdAt < ExecutionModule.SELL_REPLACE_LOCK_TIMEOUT_MS
    ) {
      await this.rejectOrder(cmd, "sell-replace-lock-active", ExchangeErrorCode.LivePolicyBlocked);
      return true;
    }

    this.sellReplaceLocks.set(key, { orderId: existingSell.orderId, command: cmd, createdAt: now });
    await this.deps.bus.publish("CancelOrderRequested", {
      command: {
        type: "CancelOrderCommand",
        commandId: createCommandId(`sell-replace-${String(existingSell.orderId)}-${now}`),
        orderId: existingSell.orderId,
        reason: existingLock ? "sell_replace_retry" : "sell_replace_reprice",
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

  private findOpenSellOrderForToken(tokenId: TokenId): Order | null {
    const openOrders = this.deps.orderRepo
      .findByTokenId(tokenId)
      .filter(
        (order) =>
          order.side === "sell" &&
          (order.status === "pending" ||
            order.status === "open" ||
            order.status === "partially-filled"),
      );
    return openOrders[0] ?? null;
  }

  private async releasePendingSellReplacement(cancelledOrderId: OrderId): Promise<void> {
    for (const [tokenKey, lock] of this.sellReplaceLocks) {
      if (lock.orderId !== cancelledOrderId) continue;
      this.sellReplaceLocks.delete(tokenKey);
      const replacement: PlaceOrderCommand = {
        ...lock.command,
        commandId: createCommandId(`sell-replace-submit-${String(cancelledOrderId)}-${Date.now()}`),
      };
      await this.deps.bus.publish("PlaceOrderRequested", {
        command: replacement,
        timestamp: Date.now(),
      });
      return;
    }
  }

  private async rejectOrder(
    cmd: PlaceOrderCommand,
    reason: string,
    errorCode: ExchangeErrorCode,
  ): Promise<void> {
    await this.publishOrderRejected(cmd, { reason, errorCode, timestamp: Date.now() });
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
      exchangeErrorCode: exchangeError?.errorCode ?? null,
      exchangeErrorMessage: exchangeError?.errorMessage ?? null,
      exchangeErrorPayload: stringifyExchangeErrorPayload(exchangeError?.errorDetails ?? null),
      botRunId: this.deps.botRunId,
      createdAt: now,
      updatedAt: now,
    };
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
