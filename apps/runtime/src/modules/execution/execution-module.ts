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
  FamilyRulesProvider,
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
  ConditionId,
  PositionRepository,
} from "@plankton/domain";
import {
  createCommandId,
  createOrderId,
  ExchangeErrorCode,
} from "@plankton/domain";
import { importExchangeFills } from "../reconciliation/fill-reconciler.js";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { ExecutionQueue } from "./execution-queue.js";
import {
  buildReservationSnapshot,
  getReservedSellSize,
  type PendingReservation,
} from "./reservation-utils.js";

export interface ExecutionModuleDeps {
  gateway: ExchangeGateway;
  bus: EventBus;
  marketRepo: MarketRepository;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  positionRepo?: PositionRepository | undefined;
  log: Logger;
  botRunId: BotRunId;
  rulesProvider: FamilyRulesProvider;
  runtimeControl?: RuntimeControl | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
  runtimeMode?: "simulation" | "paper" | "live-lite" | undefined;
  maxConcurrency?: number | undefined;
  controlDb?: {
    prepare(sql: string): { get(...args: unknown[]): unknown };
  };
  activeProfile?: ProfileId | undefined;
}

export class ExecutionModule implements RuntimeModule {
  private static readonly WALLET_BUFFER_RATIO = 0.03;
  private static readonly MIN_WALLET_BUFFER_USDC = 0.25;
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
  } {
    const queue = this.queue?.diagnostics;
    const reservations = this.getReservationSnapshot();
    const walletBalance = this.getWalletBalanceUsdc();
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
      freeUsdcForNewOrders:
        walletBalance != null
          ? Number(
              Math.max(
                0,
                walletBalance -
                  reservations.reservedBuyUsdc -
                  this.getWalletBufferUsdc(walletBalance),
              ).toFixed(6),
            )
          : null,
      reservedSellTokenCount: reservations.reservedSellByToken.size,
      cancelReplacePendingCount: this.sellReplaceLocks.size,
      gatewayRejectsLast10mByCode: this.getGatewayRejectsLast10mByCode(),
      internalReservationRejectsLast10m: this.getInternalReservationRejectsLast10m(),
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
      await this.deps.bus.publish("OrderRejected", {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        reason: "runtime-paused",
        errorCode: "RUNTIME_PAUSED",
        familyId: cmd.familyId,
        signalReason: cmd.signalReason ?? null,
        timestamp: Date.now(),
      });
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
        await this.deps.bus.publish("OrderRejected", {
          commandId: cmd.commandId,
          clientOrderId: cmd.clientOrderId,
          tokenId: cmd.tokenId,
          conditionId: cmd.conditionId,
          reason: "live-lite-order-cap-exceeded",
          errorCode: "LIVE_LITE_ORDER_CAP",
          familyId: cmd.familyId,
          signalReason: cmd.signalReason ?? null,
          timestamp: Date.now(),
        });
        return;
      }
    }

    // Market active check: reject orders on deactivated/resolved markets
    const market = this.deps.marketRepo.findByTokenId(cmd.tokenId);
    if (market && !market.active) {
      this.log.warn(
        { commandId: cmd.commandId, tokenId: cmd.tokenId },
        "order rejected — market inactive",
      );
      await this.deps.bus.publish("OrderRejected", {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        reason: "market-inactive",
        errorCode: "MARKET_INACTIVE",
        familyId: cmd.familyId,
        signalReason: cmd.signalReason ?? null,
        timestamp: Date.now(),
      });
      return;
    }

    const minOrderSizeRejection = this.getMinOrderSizeRejection(cmd);
    if (minOrderSizeRejection) {
      this.log.warn(
        {
          commandId: cmd.commandId,
          tokenId: cmd.tokenId,
          size: cmd.size,
          minOrderSize: minOrderSizeRejection.minOrderSize,
        },
        "order rejected — below exchange minimum size",
      );
      await this.deps.bus.publish("OrderRejected", {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        reason: "exchange-min-order-size-rejected",
        errorCode: ExchangeErrorCode.InvalidSize,
        familyId: cmd.familyId,
        signalReason: cmd.signalReason ?? null,
        timestamp: Date.now(),
      });
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

    const reservationRejection = this.getReservationRejection(cmd, notional);
    if (reservationRejection) {
      this.recordInternalReservationReject();
      this.log.debug(reservationRejection.details, reservationRejection.message);
      await this.rejectOrder(
        cmd,
        reservationRejection.reason,
        ExchangeErrorCode.InsufficientBalance,
      );
      return;
    }

    this.pendingReservations.set(String(cmd.commandId), {
      tokenId: cmd.tokenId,
      side: cmd.side,
      size: cmd.size,
      price: cmd.price,
    });
    this.acceptedCommandAt.set(String(cmd.commandId), Date.now());

    if (this.queue) {
      this.queue.enqueue(cmd);
      return;
    }

    await this.executeCommand(cmd);
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
      this.recordGatewayReject(result.errorCode ?? ExchangeErrorCode.Unknown);
      const reason = this.gatewayRejectReason(result.errorCode, result.errorMessage);
      this.log.warn(
        { commandId: cmd.commandId, errorCode: result.errorCode },
        "order rejected by gateway",
      );

      const rejectedOrder = this.buildOrder(cmd, "rejected", null);
      this.deps.orderRepo.save(rejectedOrder);

      await this.deps.bus.publish("OrderRejected", {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        reason,
        errorCode: result.errorCode ?? "UNKNOWN",
        familyId: cmd.familyId,
        signalReason: cmd.signalReason ?? null,
        timestamp: now,
      });
      return;
    }

    if (!result.orderId || result.orderId.trim().length === 0) {
      this.log.error(
        { commandId: cmd.commandId },
        "gateway reported success without order id -- treating as rejection",
      );

      const rejectedOrder = this.buildOrder(cmd, "rejected", null);
      this.deps.orderRepo.save(rejectedOrder);

      await this.deps.bus.publish("OrderRejected", {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        tokenId: cmd.tokenId,
        conditionId: cmd.conditionId,
        reason: "gateway returned success without order id",
        errorCode: ExchangeErrorCode.Unknown,
        familyId: cmd.familyId,
        signalReason: cmd.signalReason ?? null,
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
      familyId: cmd.familyId,
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
      await this.checkForFills(orderId, cmd);
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

    this.deps.orderRepo.updateStatus(cmd.orderId, "cancelled");

    this.log.info({ commandId: cmd.commandId, orderId: cmd.orderId }, "order cancelled");

    const cancelledOrder = this.deps.orderRepo.findById(cmd.orderId);
    await this.deps.bus.publish("OrderCancelled", {
      commandId: cmd.commandId,
      orderId: cmd.orderId,
      tokenId: cancelledOrder?.tokenId ?? (cmd.orderId as unknown as TokenId),
      conditionId: cancelledOrder?.conditionId ?? ("" as ConditionId),
      reason: cmd.reason,
      familyId: cmd.familyId,
      signalReason: null,
      timestamp: now,
    });

    await this.releasePendingSellReplacement(cmd.orderId);
  }

  // ─── Fill detection ───────────────────────────────────────────────────

  private async checkForFills(orderId: OrderId, _cmd: PlaceOrderCommand): Promise<void> {
    const allFills = await this.deps.gateway.getFills(0);
    const orderFills = allFills.filter((f) => f.orderId === String(orderId));
    if (orderFills.length === 0) return;

    await importExchangeFills(orderFills, {
      fillRepo: this.deps.fillRepo,
      orderRepo: this.deps.orderRepo,
      rulesProvider: this.deps.rulesProvider,
      bus: this.deps.bus,
      log: this.log,
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

  private getReservationRejection(
    cmd: PlaceOrderCommand,
    notional: number,
  ): {
    reason: string;
    message: string;
    details: Record<string, unknown>;
  } | null {
    const reservations = this.getReservationSnapshot();

    if (cmd.side === "buy") {
      const walletBalance = this.getWalletBalanceUsdc();
      if (walletBalance == null) return null;

      const walletBuffer = this.getWalletBufferUsdc(walletBalance);
      const availableBalance = walletBalance - reservations.reservedBuyUsdc - walletBuffer;
      if (availableBalance + 1e-9 >= notional) return null;

      return {
        reason: "reserved-usdc-limit",
        message: "order skipped — insufficient wallet balance after open-order reservations",
        details: {
          wallet: walletBalance,
          reservedBuy: reservations.reservedBuyUsdc,
          walletBuffer,
          available: availableBalance,
          order: notional,
        },
      };
    }

    if (!this.deps.positionRepo) return null;

    const position = this.deps.positionRepo.findByTokenId(cmd.tokenId);
    if (!position || position.status !== "open") {
      return {
        reason: "reserved-token-limit",
        message: "sell order skipped — no open position for token",
        details: { tokenId: cmd.tokenId, orderSize: cmd.size },
      };
    }

    const reservedSell = getReservedSellSize(reservations, cmd.tokenId);
    const availableSize = position.size - reservedSell;
    if (availableSize + 1e-9 >= cmd.size) return null;

    return {
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

  private getWalletBalanceUsdc(): number | null {
    if (!this.deps.controlDb || !this.deps.activeProfile) return null;
    const walletRow = this.deps.controlDb
      .prepare("SELECT wallet_balance_usdc FROM profile_summaries WHERE profile_id = ?")
      .get(this.deps.activeProfile) as { wallet_balance_usdc: number | null } | undefined;
    return walletRow?.wallet_balance_usdc ?? null;
  }

  private getWalletBufferUsdc(walletBalance: number): number {
    return Math.max(
      ExecutionModule.MIN_WALLET_BUFFER_USDC,
      walletBalance * ExecutionModule.WALLET_BUFFER_RATIO,
    );
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
        familyId: existingSell.familyId,
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
    await this.deps.bus.publish("OrderRejected", {
      commandId: cmd.commandId,
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      reason,
      errorCode,
      familyId: cmd.familyId,
      signalReason: cmd.signalReason ?? null,
      timestamp: Date.now(),
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
  ): Order {
    const now = new Date().toISOString();
    return {
      orderId: exchangeOrderId
        ? createOrderId(exchangeOrderId)
        : createOrderId(`rej-${cmd.commandId}`),
      clientOrderId: cmd.clientOrderId,
      tokenId: cmd.tokenId,
      conditionId: cmd.conditionId,
      familyId: cmd.familyId,
      side: cmd.side,
      orderType: cmd.orderType,
      postOnly: cmd.postOnly === true,
      price: cmd.price,
      size: cmd.size,
      sizeUsdc: cmd.size * cmd.price,
      status,
      exchangeOrderId,
      signalId: null,
      signalReason: cmd.signalReason ?? null,
      botRunId: this.deps.botRunId,
      createdAt: now,
      updatedAt: now,
    };
  }
}
