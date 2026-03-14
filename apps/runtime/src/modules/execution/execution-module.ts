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
  OrderRepository,
  FillRepository,
  Order,
  Fill,
  PlaceOrderCommand,
  CancelOrderCommand,
  OrderId,
  FillId,
  BotRunId,
  RuntimeControl,
} from "@plankton/domain";
import { createOrderId, createFillId, createBotRunId } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import type { LiveLiteGuard } from "../../live-lite-guard.js";

export interface ExecutionModuleDeps {
  gateway: ExchangeGateway;
  bus: EventBus;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  log: Logger;
  botRunId: BotRunId;
  runtimeControl?: RuntimeControl | undefined;
  liveLiteGuard?: LiveLiteGuard | undefined;
}

export class ExecutionModule implements RuntimeModule {
  private readonly log: Logger;
  private readonly processedCommandIds = new Set<string>();
  private unsubs: Array<() => void> = [];
  private started = false;

  constructor(private readonly deps: ExecutionModuleDeps) {
    this.log = deps.log.child({ module: "execution" });
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("PlaceOrderRequested", (p) =>
        this.handlePlace(p.command),
      ),
      this.deps.bus.subscribe("CancelOrderRequested", (p) =>
        this.handleCancel(p.command),
      ),
    );
    this.started = true;
    this.log.info("execution module started");
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
    this.log.info("execution module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) {
      return { ok: false, detail: "not started" };
    }
    const gw = await this.deps.gateway.healthCheck();
    return {
      ok: gw.ok,
      detail: gw.ok
        ? `gateway ok (${gw.latencyMs}ms)`
        : "gateway unreachable",
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
    if (this.deps.liveLiteGuard?.isActive && !this.deps.liveLiteGuard.isFamilyAllowed(String(cmd.familyId))) {
      this.log.warn({ commandId: cmd.commandId, familyId: cmd.familyId }, "order rejected — family not in live-lite allowlist");
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
        this.log.warn({ commandId: cmd.commandId, notional }, "order rejected — exceeds live-lite order cap");
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

    this.log.info(
      { commandId: cmd.commandId, orderId: result.orderId },
      "order placed",
    );

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

    // Check for immediate fills (simulation mode)
    await this.checkForFills(orderId, cmd);
  }

  // ─── Cancel order handler ─────────────────────────────────────────────

  private async handleCancel(cmd: CancelOrderCommand): Promise<void> {
    if (this.processedCommandIds.has(cmd.commandId)) {
      this.log.debug({ commandId: cmd.commandId }, "duplicate cancel commandId — skipping");
      return;
    }
    this.processedCommandIds.add(cmd.commandId);

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

  private async checkForFills(
    orderId: OrderId,
    cmd: PlaceOrderCommand,
  ): Promise<void> {
    const fills = await this.deps.gateway.getFills(0);
    const orderFills = fills.filter((f) => f.orderId === String(orderId));
    if (orderFills.length === 0) return;

    let cumulativeFilled = 0;

    for (const ef of orderFills) {
      const fillId = createFillId(ef.fillId);

      // Skip fills already persisted (idempotent on restart)
      if (this.deps.fillRepo.exists(fillId)) {
        cumulativeFilled += ef.size;
        continue;
      }

      const sizeUsdc = ef.size * ef.price;

      const fill: Fill = {
        fillId,
        orderId,
        tokenId: cmd.tokenId,
        familyId: cmd.familyId,
        side: cmd.side,
        price: ef.price,
        size: ef.size,
        sizeUsdc,
        fee: ef.fee,
        filledAt: new Date(ef.timestamp).toISOString(),
      };
      this.deps.fillRepo.save(fill);

      cumulativeFilled += ef.size;

      await this.deps.bus.publish("FillReceived", {
        fillId,
        orderId,
        clientOrderId: cmd.clientOrderId,
        tokenId: cmd.tokenId,
        side: cmd.side,
        price: ef.price,
        size: ef.size,
        sizeUsdc,
        fee: ef.fee,
        familyId: cmd.familyId,
        timestamp: ef.timestamp,
      });
    }

    const status = cumulativeFilled >= cmd.size ? "filled" : "partially-filled";
    this.deps.orderRepo.updateStatus(orderId, status);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

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
      botRunId: this.deps.botRunId,
      createdAt: now,
      updatedAt: now,
    };
  }
}
