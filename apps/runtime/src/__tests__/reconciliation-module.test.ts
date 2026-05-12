import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createOrderId, createConditionId, createPositionId } from "@krabs/domain";
import type {
  ExchangeGateway,
  ExchangeOrder,
  Order,
  PlaceOrderParams,
  CancelOrderParams,
  PlaceOrderResult,
  CancelOrderResult,
  ExchangeFill,
  ExchangeBalance,
  OrderRepository,
  FillRepository,
  MarketRepository,
  TokenId,
  ClientOrderId,
  ReconciliationResult,
  SettlementLedgerRepository,
  PositionDriftRepository,
  PositionDrift,
  SettlementRecord,
  RuntimeEventMap,
  Position,
} from "@krabs/domain";
import type { PolymarketPositionReader } from "@krabs/exchange";
import { InProcessEventBus } from "@krabs/event-bus";
import { ReconciliationModule } from "../modules/reconciliation/reconciliation-module.js";
import { reconcileOrders } from "../modules/reconciliation/order-reconciler.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const TOK = createTokenId("tok-yes");

function createMockGateway(): ExchangeGateway {
  return {
    placeOrder: vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValue({ success: true, orderId: "sim-1" }),
    cancelOrder: vi
      .fn<(params: CancelOrderParams) => Promise<CancelOrderResult>>()
      .mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ success: true }),
    getOpenOrders: vi.fn<() => Promise<ExchangeOrder[]>>().mockResolvedValue([]),
    getOpenOrdersForToken: vi
      .fn<(tokenId: TokenId) => Promise<ExchangeOrder[]>>()
      .mockResolvedValue([]),
    getFills: vi.fn<(sinceMs: number) => Promise<ExchangeFill[]>>().mockResolvedValue([]),
    getBalances: vi.fn<() => Promise<ExchangeBalance[]>>().mockResolvedValue([]),
    getPositionBalance: vi.fn<(tokenId: TokenId) => Promise<number>>().mockResolvedValue(0),
    getOutcomeTokenBalance: vi.fn<(tokenId: TokenId) => Promise<bigint>>().mockResolvedValue(0n),
    redeemPositions: vi.fn().mockResolvedValue({
      status: "skipped" as const,
      conditionIds: [],
      txHash: null,
      gasUsed: null,
    }),
    mergePositions: vi
      .fn<(merges: { conditionId: string; amount: number }[]) => Promise<void>>()
      .mockResolvedValue(),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  };
}

function createMockOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

function createMockFillRepo(): FillRepository {
  return {
    save: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    findByOrderId: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    findRecent: vi.fn().mockReturnValue([]),
    findUnreconciled: vi.fn().mockReturnValue([]),
    markReconciled: vi.fn(),
    getLatestTimestamp: vi.fn().mockReturnValue(null),
  };
}

function createMockMarketRepo(): MarketRepository {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findTrackedForPricingTiered: vi.fn().mockReturnValue({
      executionCritical: [],
      entryCandidates: [],
      discoveryOnly: [],
    }),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    updateScoresBatch: vi.fn(),
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

function makeExchangeOrder(overrides?: Partial<ExchangeOrder>): ExchangeOrder {
  return {
    orderId: "ex-ord-1",
    clientOrderId: "plk_abc",
    tokenId: TOK,
    side: "buy",
    price: 0.5,
    sizeTotal: 10,
    sizeFilled: 0,
    sizeRemaining: 10,
    status: "OPEN",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeLocalOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "plk_abc" as ClientOrderId,
    tokenId: TOK,
    conditionId: createConditionId("cond-1"),
    side: "buy",
    orderType: "GTC",
    price: 0.5,
    size: 10,
    sizeUsdc: 5,
    status: "open",
    exchangeOrderId: "ex-ord-1",
    signalId: null,
    signalReason: null,
    botRunId: "run-1" as any,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeExchangeFill(overrides?: Partial<ExchangeFill>): ExchangeFill {
  return {
    fillId: "fill-ex-1",
    orderId: "ex-ord-1",
    clientOrderId: "plk_abc",
    tokenId: TOK,
    side: "buy",
    price: 0.5,
    size: 10,
    liquidityRole: "unknown",
    fee: 0.01,
    feeRateBps: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ReconciliationModule", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let bus: InProcessEventBus;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let fillRepo: ReturnType<typeof createMockFillRepo>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let mod: ReconciliationModule;

  beforeEach(() => {
    gateway = createMockGateway();
    bus = new InProcessEventBus();
    orderRepo = createMockOrderRepo();
    fillRepo = createMockFillRepo();
    marketRepo = createMockMarketRepo();
    mod = new ReconciliationModule({
      gateway,
      bus,
      orderRepo,
      fillRepo,
      marketRepo,
      log: silentLog,
      reconcileIntervalMs: 60_000,
    });
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("healthCheck returns not started before start", async () => {
      const hc = await mod.healthCheck();
      expect(hc.ok).toBe(false);
      expect(hc.detail).toContain("not started");
    });

    it("start runs startup reconciliation and marks started", async () => {
      await mod.start();
      const hc = await mod.healthCheck();
      expect(hc.ok).toBe(true);
      expect(hc.detail).toContain("runs=1");
      await mod.stop();
    });

    it("stop clears interval and marks stopped", async () => {
      await mod.start();
      await mod.stop();
      const hc = await mod.healthCheck();
      expect(hc.ok).toBe(false);
    });

    it("skips overlapping reconciliation passes when the 15s timer fires during a slow pass", async () => {
      let releaseOpenOrders!: () => void;
      const openOrdersStarted = new Promise<void>((resolve) => {
        gateway.getOpenOrders = vi.fn(
          () =>
            new Promise<ExchangeOrder[]>((resolveOpenOrders) => {
              resolve();
              releaseOpenOrders = () => resolveOpenOrders([]);
            }),
        );
      });

      const first = mod.runReconciliation();
      await openOrdersStarted;
      const second = await mod.runReconciliation();

      expect(gateway.getOpenOrders).toHaveBeenCalledTimes(1);
      expect(second.clean).toBe(true);

      releaseOpenOrders();
      await first;
    });
  });

  // ─── Clean reconciliation ──────────────────────────────────────────

  describe("clean reconciliation", () => {
    it("publishes ReconciliationComplete with clean=true when no drift", async () => {
      const events: ReconciliationResult[] = [];
      bus.subscribe("ReconciliationComplete", async (p) => {
        events.push(p.result);
      });

      await mod.start();
      await bus.drain();
      await mod.stop();

      expect(events).toHaveLength(1);
      expect(events[0]!.clean).toBe(true);
      expect(events[0]!.phantomOrders).toBe(0);
      expect(events[0]!.missingFills).toBe(0);
    });

    it("does not publish ReconciliationDriftDetected when clean", async () => {
      const drifts: unknown[] = [];
      bus.subscribe("ReconciliationDriftDetected", async (p) => {
        drifts.push(p);
      });

      await mod.start();
      await bus.drain();
      await mod.stop();

      expect(drifts).toHaveLength(0);
    });
  });

  // ─── Order reconciliation ─────────────────────────────────────────

  describe("order reconciliation", () => {
    it("cancels phantom local orders not on exchange", async () => {
      const threeMinAgo = new Date(Date.now() - 180_000).toISOString();
      const local = makeLocalOrder({
        exchangeOrderId: "ex-gone",
        createdAt: threeMinAgo,
        updatedAt: threeMinAgo,
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      // exchange returns empty — order is gone
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const result = await mod.runReconciliation();

      expect(result.phantomOrders).toBe(1);
      expect(result.clean).toBe(false);
      expect(orderRepo.updateStatus).toHaveBeenCalledWith(
        local.orderId,
        "cancelled",
        undefined,
        "phantom_missing_on_exchange",
        expect.objectContaining({
          cancelAgeMs: expect.any(Number),
          cancelAgeBucket: expect.any(String),
          fillProgressShares: 0,
          marketHorizon: null,
        }),
      );
    });

    it("does not cancel local orders that exist on exchange", async () => {
      const local = makeLocalOrder({ exchangeOrderId: "ex-ord-1" });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-ord-1" })]);

      const result = await mod.runReconciliation();

      expect(result.phantomOrders).toBe(0);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    });

    it("detects unknown exchange orders without local match", async () => {
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-mystery" })]);

      const result = await mod.runReconciliation();

      expect(result.clean).toBe(false);
      expect(result.details.some((d) => d.includes("unknown exchange order"))).toBe(true);
    });

    it("counts exchange and local open orders", async () => {
      const local = makeLocalOrder();
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-ord-1" })]);

      const result = await mod.runReconciliation();

      expect(result.openOrdersExchange).toBe(1);
      expect(result.openOrdersLocal).toBe(1);
    });
  });

  // ─── Phantom grace period ──────────────────────────────────────────

  describe("phantom grace period", () => {
    it("fresh order within grace period is not cancelled", async () => {
      const fresh = makeLocalOrder({
        exchangeOrderId: "ex-fresh",
        createdAt: new Date().toISOString(),
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([fresh]);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const result = await reconcileOrders({
        gateway,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        phantomGraceMs: 90_000,
      });

      expect(result.phantomsCancelled).toBe(0);
      expect(result.phantomsSkippedGrace).toBe(1);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    });

    it("old order beyond grace period is cancelled as phantom", async () => {
      const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
      const old = makeLocalOrder({
        exchangeOrderId: "ex-old",
        createdAt: twoMinAgo,
        updatedAt: twoMinAgo,
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([old]);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const result = await reconcileOrders({
        gateway,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        phantomGraceMs: 90_000,
      });

      expect(result.phantomsCancelled).toBe(1);
      expect(result.phantomsSkippedGrace).toBe(0);
      expect(orderRepo.updateStatus).toHaveBeenCalledWith(
        old.orderId,
        "cancelled",
        undefined,
        "phantom_missing_on_exchange",
        expect.objectContaining({
          cancelAgeMs: expect.any(Number),
          cancelAgeBucket: expect.any(String),
          fillProgressShares: 0,
          marketHorizon: null,
        }),
      );
    });

    it("stale exchange order is still auto-cancelled (regression)", async () => {
      const cancelledLocal = makeLocalOrder({
        exchangeOrderId: "ex-stale-regression",
        status: "cancelled",
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-stale-regression" })]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });

      const result = await reconcileOrders({
        gateway,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        phantomGraceMs: 90_000,
      });

      expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "ex-stale-regression" });
      expect(result.staleCancelled).toBe(1);
    });

    it("two-pass: fresh order survives, then appears on exchange", async () => {
      const fresh = makeLocalOrder({
        exchangeOrderId: "ex-delayed",
        createdAt: new Date().toISOString(),
      });

      // Pass 1: exchange empty, fresh order survives grace
      orderRepo.findOpen = vi.fn().mockReturnValue([fresh]);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const result1 = await reconcileOrders({
        gateway,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        phantomGraceMs: 90_000,
      });

      expect(result1.phantomsCancelled).toBe(0);
      expect(result1.phantomsSkippedGrace).toBe(1);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();

      // Pass 2: exchange now returns the order — clean
      orderRepo.findOpen = vi.fn().mockReturnValue([fresh]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-delayed" })]);

      const result2 = await reconcileOrders({
        gateway,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        phantomGraceMs: 90_000,
      });

      expect(result2.phantomsCancelled).toBe(0);
      expect(result2.phantomsSkippedGrace).toBe(0);
    });

    it("two-pass: old phantom absent from exchange is cancelled", async () => {
      const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
      const old = makeLocalOrder({
        exchangeOrderId: "ex-phantom-old",
        createdAt: twoMinAgo,
        updatedAt: twoMinAgo,
      });

      // Pass 1: absent from exchange, beyond grace → cancelled
      orderRepo.findOpen = vi.fn().mockReturnValue([old]);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const result = await reconcileOrders({
        gateway,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        phantomGraceMs: 90_000,
      });

      expect(result.phantomsCancelled).toBe(1);
      expect(result.phantomsSkippedGrace).toBe(0);
      expect(orderRepo.updateStatus).toHaveBeenCalledWith(
        old.orderId,
        "cancelled",
        undefined,
        "phantom_missing_on_exchange",
        expect.objectContaining({
          cancelAgeMs: expect.any(Number),
          cancelAgeBucket: expect.any(String),
          fillProgressShares: 0,
          marketHorizon: null,
        }),
      );
    });
  });

  // ─── Module-level grace period (computed from reconcileIntervalMs) ──

  describe("module-level computed grace (2x interval + 30s)", () => {
    it("order at 2 min age survives module-level grace (150s for 60s interval)", async () => {
      // reconcileIntervalMs=60_000 → grace=150_000. Order at 120s < 150s → survives.
      const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
      const local = makeLocalOrder({
        exchangeOrderId: "ex-fresh-module",
        createdAt: twoMinAgo,
        updatedAt: twoMinAgo,
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const result = await mod.runReconciliation();

      expect(result.phantomOrders).toBe(0);
      expect(orderRepo.updateStatus).not.toHaveBeenCalledWith(local.orderId, "cancelled");
    });

    it("order at 3 min age is phantom-cancelled under module-level grace (150s)", async () => {
      // 180s > 150s → phantom cancel
      const threeMinAgo = new Date(Date.now() - 180_000).toISOString();
      const local = makeLocalOrder({
        exchangeOrderId: "ex-old-module",
        createdAt: threeMinAgo,
        updatedAt: threeMinAgo,
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const result = await mod.runReconciliation();

      expect(result.phantomOrders).toBe(1);
      expect(orderRepo.updateStatus).toHaveBeenCalledWith(
        local.orderId,
        "cancelled",
        undefined,
        "phantom_missing_on_exchange",
        expect.objectContaining({
          cancelAgeMs: expect.any(Number),
          cancelAgeBucket: expect.any(String),
          fillProgressShares: 0,
          marketHorizon: null,
        }),
      );
    });
  });

  // ─── Stale exchange order detection ────────────────────────────────

  describe("stale exchange order detection", () => {
    it("locally-open order on exchange is not cancelled or reported unknown", async () => {
      const local = makeLocalOrder({ exchangeOrderId: "ex-ord-1" });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-ord-1" })]);

      const result = await mod.runReconciliation();

      expect(gateway.cancelOrder).not.toHaveBeenCalled();
      expect(result.details.some((d) => d.includes("unknown"))).toBe(false);
      expect(result.details.some((d) => d.includes("stale"))).toBe(false);
      expect(result.clean).toBe(true);
    });

    it("locally-cancelled order on exchange is cancelled as stale", async () => {
      const cancelledLocal = makeLocalOrder({
        exchangeOrderId: "ex-stale-1",
        status: "cancelled",
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-stale-1" })]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });

      const result = await mod.runReconciliation();

      expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "ex-stale-1" });
      expect(result.details.some((d) => d.includes("stale exchange order cancelled"))).toBe(true);
      expect(result.details.some((d) => d.includes("unknown"))).toBe(false);
      expect(result.clean).toBe(false);
    });

    it("truly unknown order (no local record) is reported as unknown", async () => {
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-mystery" })]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(null);

      const result = await mod.runReconciliation();

      expect(gateway.cancelOrder).not.toHaveBeenCalled();
      expect(result.details.some((d) => d.includes("unknown exchange order"))).toBe(true);
      expect(result.clean).toBe(false);
    });

    it("cancel failure increments staleCancelFailed and marks dirty", async () => {
      const cancelledLocal = makeLocalOrder({
        exchangeOrderId: "ex-stale-fail",
        status: "cancelled",
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-stale-fail" })]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
      gateway.cancelOrder = vi
        .fn()
        .mockResolvedValue({ success: false, errorCode: "ORDER_NOT_FOUND" });

      const result = await mod.runReconciliation();

      expect(result.clean).toBe(false);
      expect(result.details.some((d) => d.includes("stale exchange order cancel failed"))).toBe(
        true,
      );
    });

    it("locally-filled order on exchange is cancelled as stale", async () => {
      const filledLocal = makeLocalOrder({
        exchangeOrderId: "ex-stale-filled",
        status: "filled",
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-stale-filled" })]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(filledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });

      const result = await mod.runReconciliation();

      expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "ex-stale-filled" });
      expect(result.details.some((d) => d.includes("stale exchange order cancelled"))).toBe(true);
      expect(result.clean).toBe(false);
    });

    it("two-pass: stale found → dirty, then order gone → clean", async () => {
      const cancelledLocal = makeLocalOrder({
        exchangeOrderId: "ex-stale-2pass",
        status: "cancelled",
      });

      // Pass 1: exchange still has the stale order
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-stale-2pass" })]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });

      const result1 = await mod.runReconciliation();
      expect(result1.clean).toBe(false);

      // Pass 2: exchange no longer has the order
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const result2 = await mod.runReconciliation();
      expect(result2.clean).toBe(true);
    });

    it("details include stale order messages with local status", async () => {
      const cancelledLocal = makeLocalOrder({
        exchangeOrderId: "ex-stale-detail",
        status: "cancelled",
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-stale-detail" })]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });

      const result = await mod.runReconciliation();

      expect(result.details).toEqual(
        expect.arrayContaining([
          expect.stringContaining("stale exchange order cancelled: ex-stale-detail"),
          expect.stringContaining("local: cancelled"),
        ]),
      );
    });
  });

  // ─── Fill reconciliation ──────────────────────────────────────────

  describe("fill reconciliation", () => {
    it("imports missing fills from exchange and publishes FillReceived", async () => {
      const exFill = makeExchangeFill({ fillId: "fill-new" });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);

      // Need local order for familyId lookup
      const local = makeLocalOrder();
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(local);

      const fillEvents: any[] = [];
      bus.subscribe("FillReceived", async (p) => {
        fillEvents.push(p);
      });

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(1);
      expect(result.clean).toBe(false);
      expect(fillRepo.save).toHaveBeenCalledTimes(1);
      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].fillId).toBe("fill-new");
    });

    it("skips fills already known locally", async () => {
      const exFill = makeExchangeFill({ fillId: "fill-known" });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(true);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(0);
      expect(fillRepo.save).not.toHaveBeenCalled();
    });

    it("skips fills with no matching local order", async () => {
      const exFill = makeExchangeFill({
        fillId: "fill-orphan",
        clientOrderId: "unknown-client",
      });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(null);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(null);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(0);
      expect(result.details.some((d) => d.includes("no matching local order"))).toBe(true);
    });

    it("matches fill via exchangeOrderId fallback when clientOrderId misses", async () => {
      const exFill = makeExchangeFill({
        fillId: "fill-fallback",
        clientOrderId: "",
        orderId: "ex-ord-1",
      });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);

      const local = makeLocalOrder();
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(null);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(local);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(1);
      expect(fillRepo.save).toHaveBeenCalledTimes(1);
      expect(orderRepo.findByExchangeOrderId).toHaveBeenCalledWith("ex-ord-1");
    });

    it("uses primary clientOrderId path when it matches (regression)", async () => {
      const exFill = makeExchangeFill({ fillId: "fill-primary" });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);

      const local = makeLocalOrder();
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(local);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(1);
      expect(orderRepo.findByExchangeOrderId).not.toHaveBeenCalled();
    });

    it("skips fill when both clientOrderId and exchangeOrderId miss", async () => {
      const exFill = makeExchangeFill({
        fillId: "fill-double-miss",
        clientOrderId: "",
        orderId: "ex-unknown",
      });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(null);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(null);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(0);
      expect(result.details.some((d) => d.includes("no matching local order"))).toBe(true);
    });
  });

  // ─── Events ───────────────────────────────────────────────────────

  describe("events", () => {
    it("publishes ReconciliationDriftDetected with severity=critical for missing fills", async () => {
      const exFill = makeExchangeFill({ fillId: "fill-drift" });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(makeLocalOrder());

      const drifts: Array<{ severity: string; details: string }> = [];
      bus.subscribe("ReconciliationDriftDetected", async (p) => {
        drifts.push({ severity: p.severity, details: p.details });
      });

      await mod.runReconciliation();
      await bus.drain();

      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.severity).toBe("critical");
    });

    it("publishes ReconciliationDriftDetected with severity=warn for phantom orders only", async () => {
      const threeMinAgo = new Date(Date.now() - 180_000).toISOString();
      const local = makeLocalOrder({
        exchangeOrderId: "ex-gone",
        createdAt: threeMinAgo,
        updatedAt: threeMinAgo,
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const drifts: Array<{ severity: string }> = [];
      bus.subscribe("ReconciliationDriftDetected", async (p) => {
        drifts.push({ severity: p.severity });
      });

      await mod.runReconciliation();
      await bus.drain();

      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.severity).toBe("warn");
    });

    it("warns twice before publishing critical drift for confirmed wallet sentinel mismatches", async () => {
      const futureEndDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const closedPosition: Position = {
        positionId: createPositionId("pos-wallet-drift"),
        tokenId: TOK,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        size: 0,
        avgEntryPrice: 0.1,
        costBasisUsdc: 0,
        currentValueUsdc: 0,
        realizedPnl: -1,
        status: "closed",
        entryStyle: "probe",
        openedAt: new Date(Date.now() - 60_000).toISOString(),
        closedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const walletReader: PolymarketPositionReader = {
        read: vi.fn().mockResolvedValue([
          {
            tokenId: String(TOK),
            size: 10,
            currentValueUsdc: 2,
            initialValueUsdc: 1,
            slug: null,
            marketSlug: null,
            outcome: "Yes",
            raw: {},
          },
        ]),
      };
      marketRepo.findByTokenId = vi.fn().mockReturnValue({
        tokenId: TOK,
        conditionId: "cond-1",
        slug: "wallet-drift-market",
        endDate: futureEndDate,
      });
      const localLog = {
        ...silentLog,
        warn: vi.fn(),
        error: vi.fn(),
        child: () => localLog,
      };
      gateway.getPositionBalance = vi.fn().mockResolvedValue(10);
      const drifts: Array<{ severity: string; details: string }> = [];
      bus.subscribe("ReconciliationDriftDetected", async (p) => {
        drifts.push({ severity: p.severity, details: p.details });
      });

      const driftMod = new ReconciliationModule({
        gateway,
        bus,
        orderRepo,
        fillRepo,
        marketRepo,
        log: localLog,
        reconcileIntervalMs: 60_000,
        walletPositionSentinel: {
          reader: walletReader,
          positionRepo: {
            findAll: vi.fn().mockReturnValue([closedPosition]),
          } as unknown as import("@krabs/domain").PositionRepository,
          marketRepo,
          log: localLog,
        },
      });

      const first = await driftMod.runReconciliation();
      const second = await driftMod.runReconciliation();
      const result = await driftMod.runReconciliation();
      await bus.drain();

      expect(first.clean).toBe(false);
      expect(second.clean).toBe(false);
      expect(result.clean).toBe(false);
      expect(result.positionDriftCount).toBe(1);
      expect(drifts.map((drift) => drift.severity)).toEqual(["warn", "warn", "critical"]);
      expect(drifts.at(-1)!.details).toContain("wallet-live-position-closed-locally");
      expect(gateway.getPositionBalance).toHaveBeenCalledTimes(3);
      expect(localLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          closedLive: expect.arrayContaining([
            expect.objectContaining({ positionId: "pos-wallet-drift" }),
          ]),
          severity: "warn",
        }),
        "wallet position sentinel detected drift",
      );
      expect(localLog.error).toHaveBeenCalledWith(
        expect.objectContaining({
          closedLive: expect.arrayContaining([
            expect.objectContaining({ positionId: "pos-wallet-drift" }),
          ]),
          severity: "critical",
        }),
        "wallet position sentinel detected drift",
      );
    });
  });

  // ─── Re-entrancy guard ────────────────────────────────────────────

  describe("re-entrancy", () => {
    it("prevents overlapping reconciliation runs", async () => {
      let resolveGateway: (() => void) | null = null;
      gateway.getOpenOrders = vi.fn().mockImplementation(
        () =>
          new Promise<ExchangeOrder[]>((resolve) => {
            resolveGateway = () => resolve([]);
          }),
      );

      const p1 = mod.runReconciliation();
      const p2 = mod.runReconciliation(); // should return immediately

      // p2 resolves immediately with the empty/last result
      const r2 = await p2;
      expect(r2.clean).toBe(true);

      // Now resolve p1
      resolveGateway!();
      await p1;

      // Only one call to gateway
      expect(gateway.getOpenOrders).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Periodic sinceMs ─────────────────────────────────────────────

  describe("periodic fill lookback", () => {
    it("uses sinceMs=0 on first run, then last run timestamp", async () => {
      await mod.runReconciliation();
      const firstCallSince = (gateway.getFills as any).mock.calls[0][0];
      expect(firstCallSince).toBe(0);

      await mod.runReconciliation();
      const secondCallSince = (gateway.getFills as any).mock.calls[1][0];
      expect(secondCallSince).toBeGreaterThan(0);
    });
  });
});

// ─── Phase 3.A: Position drift detection ───────────────────────────────────

describe("ReconciliationModule — position drift detection (Phase 3.A)", () => {
  function createMockSettlementLedgerRepo(
    rows: SettlementRecord[] = [],
  ): SettlementLedgerRepository {
    return {
      save: vi.fn(),
      findAlgoRedeemSettlementsSince: vi.fn().mockReturnValue(rows),
    };
  }

  function createMockDriftRepo(): PositionDriftRepository & {
    upsertCalls: PositionDrift[];
    resolvedIds: string[];
  } {
    const upsertCalls: PositionDrift[] = [];
    const resolvedIds: string[] = [];
    return {
      upsertCalls,
      resolvedIds,
      upsert: vi.fn((drift: PositionDrift) => {
        upsertCalls.push(drift);
      }),
      findOpen: vi.fn().mockReturnValue([]),
      markResolved: vi.fn((id: string) => {
        resolvedIds.push(id);
      }),
    };
  }

  function makeAlgoRedeemRow(overrides?: Partial<SettlementRecord>): SettlementRecord {
    return {
      settlementId: "algo-redeem-cond-A-tok-1",
      conditionId: "cond-A",
      positionId: "pos-1",
      tokenId: "tok-1",
      resolution: "algo-redeem",
      settlementPrice: 0,
      size: 10,
      delta: -5,
      settledAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("publishes PositionDriftDetected when on-chain balance is non-zero", async () => {
    const row = makeAlgoRedeemRow();
    const ledgerRepo = createMockSettlementLedgerRepo([row]);
    const driftRepo = createMockDriftRepo();
    const gateway = {
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
      getFills: vi.fn().mockResolvedValue([]),
      getBalances: vi.fn().mockResolvedValue([]),
      getPositionBalance: vi.fn().mockResolvedValue(0),
      getOutcomeTokenBalance: vi.fn().mockResolvedValue(12345n),
      redeemPositions: vi.fn().mockResolvedValue(undefined),
      mergePositions: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    } as unknown as ExchangeGateway;
    const bus = new InProcessEventBus();
    const events: RuntimeEventMap["PositionDriftDetected"][] = [];
    const retries: RuntimeEventMap["RedeemRequested"][] = [];
    bus.subscribe("PositionDriftDetected", async (e) => {
      events.push(e);
    });
    bus.subscribe("RedeemRequested", async (e) => {
      retries.push(e);
    });

    const mod = new ReconciliationModule({
      gateway,
      bus,
      orderRepo: {
        save: vi.fn(),
        findById: vi.fn(),
        findByClientOrderId: vi.fn(),
        findByExchangeOrderId: vi.fn(),
        findOpen: vi.fn().mockReturnValue([]),
        findByTokenId: vi.fn(),
        updateStatus: vi.fn(),
        sumOpenBuyNotional: vi.fn().mockReturnValue(0),
      } as unknown as OrderRepository,
      fillRepo: {} as FillRepository,
      marketRepo: createMockMarketRepo(),
      log: silentLog,
      reconcileIntervalMs: 60_000,
      settlementLedgerRepo: ledgerRepo,
      driftRepo,
    });

    const count = await mod.runDriftCheck();

    expect(count).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.settlementId).toBe(row.settlementId);
    expect(events[0]!.onChainBalance).toBe("12345");
    expect(String(events[0]!.tokenId)).toBe("tok-1");
    expect(String(events[0]!.conditionId)).toBe("cond-A");
    expect(driftRepo.upsertCalls).toHaveLength(1);
    expect(driftRepo.upsertCalls[0]!.status).toBe("open");
    expect(driftRepo.upsertCalls[0]!.onChainBalance).toBe("12345");
    expect(retries).toEqual([{ conditionIds: ["cond-A"], timestamp: expect.any(Number) }]);
  });

  it("emits nothing when on-chain balance is zero and marks prior drift resolved", async () => {
    const row = makeAlgoRedeemRow();
    const ledgerRepo = createMockSettlementLedgerRepo([row]);
    const driftRepo = createMockDriftRepo();
    const gateway = {
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
      getFills: vi.fn().mockResolvedValue([]),
      getBalances: vi.fn().mockResolvedValue([]),
      getPositionBalance: vi.fn().mockResolvedValue(0),
      getOutcomeTokenBalance: vi.fn().mockResolvedValue(0n),
      redeemPositions: vi.fn(),
      mergePositions: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    } as unknown as ExchangeGateway;
    const bus = new InProcessEventBus();
    const events: RuntimeEventMap["PositionDriftDetected"][] = [];
    const retries: RuntimeEventMap["RedeemRequested"][] = [];
    bus.subscribe("PositionDriftDetected", async (e) => {
      events.push(e);
    });
    bus.subscribe("RedeemRequested", async (e) => {
      retries.push(e);
    });

    const mod = new ReconciliationModule({
      gateway,
      bus,
      orderRepo: {} as OrderRepository,
      fillRepo: {} as FillRepository,
      marketRepo: createMockMarketRepo(),
      log: silentLog,
      reconcileIntervalMs: 60_000,
      settlementLedgerRepo: ledgerRepo,
      driftRepo,
    });

    const count = await mod.runDriftCheck();

    expect(count).toBe(0);
    expect(events).toHaveLength(0);
    expect(retries).toHaveLength(0);
    expect(driftRepo.upsertCalls).toHaveLength(0);
    expect(driftRepo.resolvedIds).toEqual([row.settlementId]);
  });

  it("ignores non-algo-redeem rows — ledger accessor filters them out", async () => {
    // findAlgoRedeemSettlementsSince is the sole query path; repository
    // guarantees only resolution = 'algo-redeem' rows are returned.
    const ledgerRepo = createMockSettlementLedgerRepo([]);
    const driftRepo = createMockDriftRepo();
    const gateway = {
      getOutcomeTokenBalance: vi.fn().mockResolvedValue(99n),
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getOpenOrders: vi.fn(),
      getOpenOrdersForToken: vi.fn(),
      getFills: vi.fn(),
      getBalances: vi.fn(),
      getPositionBalance: vi.fn(),
      redeemPositions: vi.fn(),
      mergePositions: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as ExchangeGateway;
    const bus = new InProcessEventBus();
    const events: RuntimeEventMap["PositionDriftDetected"][] = [];
    const retries: RuntimeEventMap["RedeemRequested"][] = [];
    bus.subscribe("PositionDriftDetected", async (e) => {
      events.push(e);
    });
    bus.subscribe("RedeemRequested", async (e) => {
      retries.push(e);
    });

    const mod = new ReconciliationModule({
      gateway,
      bus,
      orderRepo: {} as OrderRepository,
      fillRepo: {} as FillRepository,
      marketRepo: createMockMarketRepo(),
      log: silentLog,
      reconcileIntervalMs: 60_000,
      settlementLedgerRepo: ledgerRepo,
      driftRepo,
    });

    const count = await mod.runDriftCheck();

    expect(count).toBe(0);
    expect(events).toHaveLength(0);
    expect(gateway.getOutcomeTokenBalance).not.toHaveBeenCalled();
  });

  it("skips drift tracking entirely when deps are not wired", async () => {
    const gateway = {
      getOutcomeTokenBalance: vi.fn().mockResolvedValue(100n),
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getOpenOrders: vi.fn(),
      getOpenOrdersForToken: vi.fn(),
      getFills: vi.fn(),
      getBalances: vi.fn(),
      getPositionBalance: vi.fn(),
      redeemPositions: vi.fn(),
      mergePositions: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as ExchangeGateway;

    const mod = new ReconciliationModule({
      gateway,
      bus: new InProcessEventBus(),
      orderRepo: {} as OrderRepository,
      fillRepo: {} as FillRepository,
      marketRepo: createMockMarketRepo(),
      log: silentLog,
      reconcileIntervalMs: 60_000,
    });

    const count = await mod.runDriftCheck();
    expect(count).toBe(0);
    expect(gateway.getOutcomeTokenBalance).not.toHaveBeenCalled();
  });

  it("re-checks still-open drifts whose ledger row has aged out of the 24h lookback", async () => {
    // Ledger reports nothing in the window — the open drift was opened >24h
    // ago — but driftRepo.findOpen() still has the stale `open` row. The
    // sweep must re-check the on-chain balance and close the drift if it has
    // since cleared; otherwise any old drift stays open forever.
    const stale: PositionDrift = {
      settlementId: "algo-redeem-cond-old-tok-old",
      tokenId: "tok-old",
      conditionId: "cond-old",
      detectedAt: "2025-01-01T00:00:00.000Z",
      onChainBalance: "500",
      lastCheckedAt: "2025-01-01T00:00:00.000Z",
      status: "open",
    };
    const ledgerRepo = createMockSettlementLedgerRepo([]);
    const driftRepo = createMockDriftRepo();
    (driftRepo.findOpen as any).mockReturnValue([stale]);
    const gateway = {
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
      getFills: vi.fn().mockResolvedValue([]),
      getBalances: vi.fn().mockResolvedValue([]),
      getPositionBalance: vi.fn().mockResolvedValue(0),
      getOutcomeTokenBalance: vi.fn().mockResolvedValue(0n),
      redeemPositions: vi.fn(),
      mergePositions: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    } as unknown as ExchangeGateway;

    const mod = new ReconciliationModule({
      gateway,
      bus: new InProcessEventBus(),
      orderRepo: {} as OrderRepository,
      fillRepo: {} as FillRepository,
      marketRepo: createMockMarketRepo(),
      log: silentLog,
      reconcileIntervalMs: 60_000,
      settlementLedgerRepo: ledgerRepo,
      driftRepo,
    });

    await mod.runDriftCheck();

    expect(gateway.getOutcomeTokenBalance).toHaveBeenCalledTimes(1);
    expect(driftRepo.resolvedIds).toEqual([stale.settlementId]);
  });

  it("refreshes an aged-out open drift that still has non-zero balance without double-counting it", async () => {
    // Same settlementId is returned from both ledger lookback and findOpen;
    // the sweep must not run the balance check twice or re-emit the event.
    const row = makeAlgoRedeemRow();
    const existingOpen: PositionDrift = {
      settlementId: row.settlementId,
      tokenId: row.tokenId,
      conditionId: row.conditionId,
      detectedAt: "2026-04-20T00:00:00.000Z",
      onChainBalance: "200",
      lastCheckedAt: "2026-04-20T00:00:00.000Z",
      status: "open",
    };
    const ledgerRepo = createMockSettlementLedgerRepo([row]);
    const driftRepo = createMockDriftRepo();
    (driftRepo.findOpen as any).mockReturnValue([existingOpen]);
    const gateway = {
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
      getFills: vi.fn().mockResolvedValue([]),
      getBalances: vi.fn().mockResolvedValue([]),
      getPositionBalance: vi.fn().mockResolvedValue(0),
      getOutcomeTokenBalance: vi.fn().mockResolvedValue(77n),
      redeemPositions: vi.fn(),
      mergePositions: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    } as unknown as ExchangeGateway;
    const bus = new InProcessEventBus();
    const events: RuntimeEventMap["PositionDriftDetected"][] = [];
    const retries: RuntimeEventMap["RedeemRequested"][] = [];
    bus.subscribe("PositionDriftDetected", async (e) => {
      events.push(e);
    });
    bus.subscribe("RedeemRequested", async (e) => {
      retries.push(e);
    });

    const mod = new ReconciliationModule({
      gateway,
      bus,
      orderRepo: {} as OrderRepository,
      fillRepo: {} as FillRepository,
      marketRepo: createMockMarketRepo(),
      log: silentLog,
      reconcileIntervalMs: 60_000,
      settlementLedgerRepo: ledgerRepo,
      driftRepo,
    });

    await mod.runDriftCheck();

    // Balance fetched once, not twice — the sweep de-dupes on settlementId.
    expect(gateway.getOutcomeTokenBalance).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(retries).toEqual([{ conditionIds: [row.conditionId], timestamp: expect.any(Number) }]);
    expect(driftRepo.upsertCalls).toHaveLength(1);
  });

  it("re-queues on-chain redeem at most once per conditionId per drift pass", async () => {
    const rows = [
      makeAlgoRedeemRow({
        settlementId: "algo-redeem-cond-A-tok-1",
        tokenId: "tok-1",
        conditionId: "cond-A",
      }),
      makeAlgoRedeemRow({
        settlementId: "algo-redeem-cond-A-tok-2",
        tokenId: "tok-2",
        conditionId: "cond-A",
      }),
    ];
    const ledgerRepo = createMockSettlementLedgerRepo(rows);
    const driftRepo = createMockDriftRepo();
    const gateway = {
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
      getFills: vi.fn().mockResolvedValue([]),
      getBalances: vi.fn().mockResolvedValue([]),
      getPositionBalance: vi.fn().mockResolvedValue(0),
      getOutcomeTokenBalance: vi.fn().mockResolvedValue(55n),
      redeemPositions: vi.fn(),
      mergePositions: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    } as unknown as ExchangeGateway;
    const bus = new InProcessEventBus();
    const retries: RuntimeEventMap["RedeemRequested"][] = [];
    bus.subscribe("RedeemRequested", async (e) => {
      retries.push(e);
    });

    const mod = new ReconciliationModule({
      gateway,
      bus,
      orderRepo: {} as OrderRepository,
      fillRepo: {} as FillRepository,
      marketRepo: createMockMarketRepo(),
      log: silentLog,
      reconcileIntervalMs: 60_000,
      settlementLedgerRepo: ledgerRepo,
      driftRepo,
    });

    await mod.runDriftCheck();

    expect(retries).toEqual([{ conditionIds: ["cond-A"], timestamp: expect.any(Number) }]);
    expect(driftRepo.upsertCalls).toHaveLength(2);
  });

  it("resolves (not-a-drift) non-zero balance against a still-live market (endDate > now)", async () => {
    // An algo-redeem ledger row with non-zero on-chain balance would normally
    // be a drift — but if the market's endDate is in the future, the position
    // is simply still live (e.g. user re-entered the token after a prior
    // local settle). Do NOT publish PositionDriftDetected, do NOT requeue
    // RedeemRequested, and resolve the stale drift row so the open sweep
    // stops refreshing it forever.
    const row = makeAlgoRedeemRow();
    const ledgerRepo = createMockSettlementLedgerRepo([row]);
    const driftRepo = createMockDriftRepo();
    const gateway = {
      placeOrder: vi.fn(),
      cancelOrder: vi.fn(),
      cancelAllOrders: vi.fn(),
      getOpenOrders: vi.fn().mockResolvedValue([]),
      getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
      getFills: vi.fn().mockResolvedValue([]),
      getBalances: vi.fn().mockResolvedValue([]),
      getPositionBalance: vi.fn().mockResolvedValue(0),
      getOutcomeTokenBalance: vi.fn().mockResolvedValue(12345n),
      redeemPositions: vi.fn(),
      mergePositions: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
    } as unknown as ExchangeGateway;
    const bus = new InProcessEventBus();
    const driftEvents: RuntimeEventMap["PositionDriftDetected"][] = [];
    const retries: RuntimeEventMap["RedeemRequested"][] = [];
    bus.subscribe("PositionDriftDetected", async (e) => {
      driftEvents.push(e);
    });
    bus.subscribe("RedeemRequested", async (e) => {
      retries.push(e);
    });

    const liveMarketRepo = createMockMarketRepo();
    (liveMarketRepo.findByConditionId as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        tokenId: createTokenId("tok-1"),
        conditionId: "cond-A",
        slug: "live-market",
        eventSlug: null,
        question: "Live?",
        outcome: "YES",
        regime: null,
        horizon: null,
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        active: true,
        tradable: true,
        tickSize: 0.01,
        negRisk: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);

    const mod = new ReconciliationModule({
      gateway,
      bus,
      orderRepo: {} as OrderRepository,
      fillRepo: {} as FillRepository,
      marketRepo: liveMarketRepo,
      log: silentLog,
      reconcileIntervalMs: 60_000,
      settlementLedgerRepo: ledgerRepo,
      driftRepo,
    });

    const count = await mod.runDriftCheck();

    expect(count).toBe(0);
    expect(driftEvents).toHaveLength(0);
    expect(retries).toHaveLength(0);
    expect(driftRepo.upsertCalls).toHaveLength(0);
    expect(driftRepo.resolvedIds).toEqual([row.settlementId]);
  });
});
