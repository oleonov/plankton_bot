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
} from "@plankton/domain";
import { createOrderId } from "@plankton/domain";
import { importExchangeFills } from "../reconciliation/fill-reconciler.js";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";
import { ExecutionQueue } from "./execution-queue.js";

export interface ExecutionModuleDeps {
  gateway: ExchangeGateway;
  bus: EventBus;
  marketRepo: MarketRepository;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  log: Logger;
  botRunId: BotRunId;
  runtimeControl?: RuntimeControl | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
  runtimeMode?: "simulation" | "paper" | "live-lite" | undefined;
  maxConcurrency?: number | undefined;
}

export class ExecutionModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly processedCommandIds = new Set<string>();
  private readonly processedCommandOrder: string[] = [];
  private readonly queue: ExecutionQueue | null;
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
            return order?.tokenId ?? (cmd.orderId as any);
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
        reason: "runtime-paused",
        errorCode: "RUNTIME_PAUSED",
        familyId: cmd.familyId,
        timestamp: Date.now(),
      });
      return;
    }

    // Live-lite allowlist check (Layer 4)
    if (
      this.deps.liveLiteGuard?.isActive &&
      !this.deps.liveLiteGuard.isFamilyAllowed(String(cmd.familyId))
    ) {
      this.log.warn(
        { commandId: cmd.commandId, familyId: cmd.familyId },
        "order rejected — family not in live-lite allowlist",
      );
      await this.deps.bus.publish("OrderRejected", {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        reason: "live-lite-allowlist-rejected",
        errorCode: "LIVE_LITE_ALLOWLIST",
        familyId: cmd.familyId,
        timestamp: Date.now(),
      });
      return;
    }

    // Live-lite order cap check (Layer 5)
    if (this.deps.liveLiteGuard?.isActive) {
      const notional = cmd.price * cmd.size;
      if (!this.deps.liveLiteGuard.isOrderWithinCap(notional)) {
        this.log.warn(
          { commandId: cmd.commandId, notional },
          "order rejected — exceeds live-lite order cap",
        );
        await this.deps.bus.publish("OrderRejected", {
          commandId: cmd.commandId,
          clientOrderId: cmd.clientOrderId,
          reason: "live-lite-order-cap-exceeded",
          errorCode: "LIVE_LITE_ORDER_CAP",
          familyId: cmd.familyId,
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
        reason: "market-inactive",
        errorCode: "MARKET_INACTIVE",
        familyId: cmd.familyId,
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

    if (this.queue) {
      this.queue.enqueue(cmd);
      return;
    }

    await this.executePlace(cmd);
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

    if (this.queue) {
      this.queue.enqueue(cmd);
      return;
    }

    await this.executeCancel(cmd);
  }

  // ─── Command dispatcher ───────────────────────────────────────────────

  private async executeCommand(cmd: PlaceOrderCommand | CancelOrderCommand): Promise<void> {
    if (cmd.type === "PlaceOrderCommand") {
      await this.executePlace(cmd);
    } else {
      await this.executeCancel(cmd);
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
      orderType: cmd.orderType,
      tickSize: cmd.tickSize,
      negRisk: cmd.negRisk,
      ...(cmd.expiration !== undefined ? { expiration: cmd.expiration } : {}),
    };
    const result = await this.deps.gateway.placeOrder(placeParams);

    const now = Date.now();

    if (!result.success) {
      this.log.warn(
        { commandId: cmd.commandId, errorCode: result.errorCode },
        "order rejected by gateway",
      );

      const rejectedOrder = this.buildOrder(cmd, "rejected", null);
      this.deps.orderRepo.save(rejectedOrder);

      await this.deps.bus.publish("OrderRejected", {
        commandId: cmd.commandId,
        clientOrderId: cmd.clientOrderId,
        reason: result.errorMessage ?? "unknown",
        errorCode: result.errorCode ?? "UNKNOWN",
        familyId: cmd.familyId,
        timestamp: now,
      });
      return;
    }

    // Order accepted
    const orderId = createOrderId(result.orderId!);
    const order = this.buildOrder(cmd, "open", result.orderId!);
    this.deps.orderRepo.save(order);

    this.log.info({ commandId: cmd.commandId, orderId: result.orderId }, "order placed");

    await this.deps.bus.publish("OrderPlaced", {
      commandId: cmd.commandId,
      clientOrderId: cmd.clientOrderId,
      orderId,
      tokenId: cmd.tokenId,
      side: cmd.side,
      price: cmd.price,
      size: cmd.size,
      orderType: cmd.orderType,
      familyId: cmd.familyId,
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

    await this.deps.bus.publish("OrderCancelled", {
      commandId: cmd.commandId,
      orderId: cmd.orderId,
      reason: cmd.reason,
      familyId: cmd.familyId,
      timestamp: now,
    });
  }

  // ─── Fill detection ───────────────────────────────────────────────────

  private async checkForFills(orderId: OrderId, _cmd: PlaceOrderCommand): Promise<void> {
    const allFills = await this.deps.gateway.getFills(0);
    const orderFills = allFills.filter((f) => f.orderId === String(orderId));
    if (orderFills.length === 0) return;

    await importExchangeFills(orderFills, {
      fillRepo: this.deps.fillRepo,
      orderRepo: this.deps.orderRepo,
      bus: this.deps.bus,
      log: this.log,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

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
      familyId: cmd.familyId,
      side: cmd.side,
      orderType: cmd.orderType,
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
