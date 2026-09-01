import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createOrderId,
  createConditionId,
  createPositionId,
  createCommandId,
} from "@krabs/domain";
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
  MarketResolutionRepository,
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
import { ExchangeStateStore } from "../modules/execution/exchange-state-store.js";
import { RedeemSweepModule } from "../modules/redeem-sweep/redeem-sweep-module.js";
import { DEFAULT_EXECUTION_POLICY } from "../execution-policy.js";

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
    claimForReconciliation: vi.fn().mockReturnValue(true),
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
    updateTickSize: vi.fn(),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // Builds a module sharing the per-test deps, with optional dependency overrides.
  function buildModule(
    overrides: Partial<ConstructorParameters<typeof ReconciliationModule>[0]> = {},
  ): ReconciliationModule {
    return new ReconciliationModule({
      gateway,
      bus,
      orderRepo,
      fillRepo,
      marketRepo,
      log: silentLog,
      reconcileIntervalMs: 60_000,
      ...overrides,
    });
  }

  function mockExactCancelled(exchangeOrderId: string): void {
    gateway.getOrderResult = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: makeExchangeOrder({ orderId: exchangeOrderId, status: "OPEN" }),
      })
      .mockResolvedValue({
        ok: true,
        data: makeExchangeOrder({
          orderId: exchangeOrderId,
          status: "CANCELLED",
          sizeFilled: 0,
        }),
      });
  }

  it("marks a pass non-clean when Track A requests a resting-add cancel", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-28T12:00:00.000Z");
    vi.setSystemTime(now);
    const firstTradeAt = new Date(now - 104 * 60_000).toISOString();
    vi.mocked(orderRepo.findOpen).mockReturnValue([
      makeLocalOrder({
        signalReason: "confirm-scale",
        createdAt: new Date(now - 103 * 60_000).toISOString(),
      }),
    ]);
    vi.mocked(gateway.getOpenOrders).mockResolvedValue([makeExchangeOrder()]);
    const trackAModule = buildModule({
      legStateRepo: {
        get: () => ({
          tokenId: TOK,
          buyCount: 1,
          sellCount: 0,
          lastAction: "BUY",
          firstTradePrice: 0.5,
          firstTradeAt,
          lastTradeAt: firstTradeAt,
          updatedAt: firstTradeAt,
        }),
      } as never,
      trackAAddThrottlePolicy: () => ({ enforce: true }),
    });

    const result = await trackAModule.runReconciliation();

    expect(result.clean).toBe(false);
    expect(result.details).toContain("Track A resting add cancel requests: 1");
    vi.useRealTimers();
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

    it("keeps reconciliation healthy when the quote-motion shadow read fails", async () => {
      const shadow = {
        orderRepo: {
          findOpen: () => {
            throw new Error("shadow read failed");
          },
        },
        fillRepo,
        positionRepo: { findById: vi.fn() },
        inventoryLotRepo: { findOpen: vi.fn() },
        riskEventRepo: { insert: vi.fn() },
        getFreshBooks: vi.fn(),
        maxBookAgeMs: 3_000,
      } as ConstructorParameters<typeof ReconciliationModule>[0]["quoteMotionShadow"];
      const isolated = buildModule({ quoteMotionShadow: shadow! });

      await expect(isolated.runReconciliation()).resolves.toMatchObject({ clean: true });
      expect(silentLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "quote-motion shadow pass failed",
      );
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

    it("does not wait for async redeem-sweep work while publishing exchange state", async () => {
      const pendingSweepRead = deferred<any[] | null>();
      const walletPositions = [
        {
          tokenId: "tok-redeem",
          conditionId: "cond-redeem",
          size: 10,
          currentValueUsdc: 1,
          initialValueUsdc: 1,
          redeemable: true,
          slug: "redeem-market",
          marketSlug: "redeem-market",
          outcome: "Yes",
          raw: {},
        },
      ];
      const redeemReader = {
        read: vi.fn().mockResolvedValueOnce([]).mockReturnValueOnce(pendingSweepRead.promise),
      };
      const redeemModule = new RedeemSweepModule({
        bus,
        gateway,
        positionReader: redeemReader as any,
        positionRepo: { findByTokenId: vi.fn(), save: vi.fn() } as any,
        lotRepo: { settleAll: vi.fn() } as any,
        marketRepo: { findByConditionId: vi.fn(() => []) } as any,
        marketResolutionRepo: { findByConditionId: vi.fn(() => null) } as any,
        settler: { settle: vi.fn(() => []) } as any,
        orderRepo: { findOpen: vi.fn(() => []) } as any,
        redeemLogRepo: {
          insert: vi.fn(),
          updateLatestActiveAttempt: vi.fn(() => false),
          findRecentActiveAttempts: vi.fn(() => []),
          hasRecentActiveAttempt: vi.fn(() => false),
          findLatestAttemptTs: vi.fn(() => null),
          markOrphanedActiveAttempts: vi.fn(() => []),
        } as any,
        redeemQuarantineRepo: {
          findByConditionIds: vi.fn(() => new Map()),
          recordStateFailed: vi.fn(),
          clearAfterSuccess: vi.fn(),
          clearExpired: vi.fn(() => ({
            conditionId: "cond-redeem",
            changedRows: 0,
            previousConsecutiveStateFailedCount: 0,
            previousRedeemQuarantineUntilTs: null,
            reset: false,
          })),
        } as any,
        policy: () => ({
          ...DEFAULT_EXECUTION_POLICY.redeemSweep,
          enabled: true,
          intervalMs: 60_000,
        }),
        depositActivationPolicy: () => ({ enabled: false, minAmountUsdcCents: 100 }),
        log: silentLog,
        runtimeMetrics: { writeEvent: vi.fn(), writeLatest: vi.fn() } as any,
        now: () => Date.now(),
      });
      const publishMod = new ReconciliationModule({
        gateway,
        bus,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        reconcileIntervalMs: 60_000,
        exchangeStateStore: new ExchangeStateStore(),
        walletPositionReader: { read: vi.fn().mockResolvedValue(walletPositions) },
      });

      await redeemModule.start();
      let resolved = false;
      const resultPromise = publishMod.runReconciliation().then(() => {
        resolved = true;
      });
      await vi.waitFor(() => expect(resolved).toBe(true), { timeout: 200 });

      expect(redeemReader.read).toHaveBeenCalledTimes(2);

      pendingSweepRead.resolve([]);
      await resultPromise;
      await redeemModule.stop();
    });

    it("shares one wallet data-api read between sentinel and exchange-state publication", async () => {
      const walletPositions = [
        {
          tokenId: String(TOK),
          conditionId: "cond-1",
          size: 10,
          currentValueUsdc: 2,
          initialValueUsdc: 2,
          redeemable: false,
          slug: "market-1",
          marketSlug: "market-1",
          outcome: "Yes",
          raw: {},
        },
      ];
      const reader = { read: vi.fn().mockResolvedValue(walletPositions) };
      const store = new ExchangeStateStore();
      const sharedReadMod = new ReconciliationModule({
        gateway,
        bus,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        reconcileIntervalMs: 60_000,
        exchangeStateStore: store,
        walletPositionReader: reader,
        walletPositionSentinel: {
          reader: reader as PolymarketPositionReader,
          positionRepo: {
            findAll: vi.fn().mockReturnValue([]),
            save: vi.fn(),
          } as any,
          fillRepo,
          marketRepo,
          log: silentLog,
          bus,
        },
      });

      await sharedReadMod.runReconciliation();

      expect(reader.read).toHaveBeenCalledTimes(1);
    });

    it("uses a soft timeout so wallet data-api read cannot block reconciliation", async () => {
      const pendingRead = deferred<readonly any[] | null>();
      const timedMod = new ReconciliationModule({
        gateway,
        bus,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        reconcileIntervalMs: 60_000,
        exchangeStateStore: new ExchangeStateStore(),
        walletPositionReader: { read: vi.fn(() => pendingRead.promise) },
        walletPositionReadTimeoutMs: 5,
      } as any);

      const run = timedMod.runReconciliation().then(() => "completed" as const);

      await expect(Promise.race([run, delay(50).then(() => "blocked" as const)])).resolves.toBe(
        "completed",
      );

      pendingRead.resolve([]);
      await run;
      expect(silentLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: 5 }),
        "walletPositionReader.read() timed out — skipping wallet snapshot for this pass",
      );
    });
  });

  // ─── Order reconciliation ─────────────────────────────────────────

  describe("order reconciliation", () => {
    it("retains local orders absent from an open-only exchange snapshot", async () => {
      const threeMinAgo = new Date(Date.now() - 180_000).toISOString();
      const local = makeLocalOrder({
        exchangeOrderId: "ex-gone",
        createdAt: threeMinAgo,
        updatedAt: threeMinAgo,
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      // An empty open snapshot is not terminal proof.
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      // threshold=1 → a single confirmed miss emits unresolved evidence.
      mod = buildModule({ consecutiveMissThreshold: 1 });
      const result = await mod.runReconciliation();

      expect(result.phantomOrders).toBe(0);
      expect(result.clean).toBe(false);
      expect(result.details).toContain(
        `unresolved missing order: ${local.orderId} (exchange: ex-gone)`,
      );
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();
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

    it("imports fills before it reads the open-orders snapshot", async () => {
      const fill = makeExchangeFill({ fillId: "fills-first" });
      gateway.getFills = vi.fn().mockResolvedValue([fill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(makeLocalOrder());
      gateway.getOpenOrders = vi.fn().mockImplementation(async () => {
        expect(fillRepo.save).toHaveBeenCalledWith(
          expect.objectContaining({ fillId: "fills-first" }),
        );
        return [];
      });

      await mod.runReconciliation();
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

    it("old order beyond grace period remains open and is reported unresolved", async () => {
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

      expect(result.phantomsCancelled).toBe(0);
      expect(result.unresolvedMissingOnExchange).toBe(1);
      expect(result.phantomsSkippedGrace).toBe(0);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();
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
      orderRepo.findById = vi.fn().mockReturnValue(cancelledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });
      mockExactCancelled("ex-stale-regression");

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

    it("retains an old missing order after the grace period", async () => {
      const twoMinAgo = new Date(Date.now() - 120_000).toISOString();
      const old = makeLocalOrder({
        exchangeOrderId: "ex-phantom-old",
        createdAt: twoMinAgo,
        updatedAt: twoMinAgo,
      });

      // Pass 1: absent from exchange, beyond grace → unresolved.
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

      expect(result.phantomsCancelled).toBe(0);
      expect(result.unresolvedMissingOnExchange).toBe(1);
      expect(result.phantomsSkippedGrace).toBe(0);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();
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

    it("order at 3 min age is retained under module-level grace (150s)", async () => {
      // 180s > 150s → unresolved evidence, never a terminal transition.
      const threeMinAgo = new Date(Date.now() - 180_000).toISOString();
      const local = makeLocalOrder({
        exchangeOrderId: "ex-old-module",
        createdAt: threeMinAgo,
        updatedAt: threeMinAgo,
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      // threshold=1 → grace is the only gate under test here.
      mod = buildModule({ consecutiveMissThreshold: 1 });
      const result = await mod.runReconciliation();

      expect(result.phantomOrders).toBe(0);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();
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
      orderRepo.findById = vi.fn().mockReturnValue(cancelledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });
      mockExactCancelled("ex-stale-1");

      const result = await mod.runReconciliation();

      expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "ex-stale-1" });
      expect(
        result.details.some((d) => d.includes("stale exchange order terminal confirmed")),
      ).toBe(true);
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
      orderRepo.findById = vi.fn().mockReturnValue(filledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });
      mockExactCancelled("ex-stale-filled");

      const result = await mod.runReconciliation();

      expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "ex-stale-filled" });
      expect(
        result.details.some((d) => d.includes("stale exchange order terminal confirmed")),
      ).toBe(true);
      expect(result.clean).toBe(false);
    });

    it("keeps a two-pass exact-terminal SELL ghost clean and out of the reservation store", async () => {
      const local = makeLocalOrder({
        exchangeOrderId: "ex-terminal-ghost",
        status: "cancelled",
        side: "sell",
      });
      const ghost = makeExchangeOrder({
        orderId: "ex-terminal-ghost",
        side: "sell",
        sizeRemaining: 10,
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(local);
      orderRepo.findById = vi.fn().mockReturnValue(local);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([ghost]);
      gateway.getOrderResult = vi.fn().mockResolvedValue({
        ok: true,
        data: { ...ghost, status: "CANCELLED" },
      });
      const writeEvent = vi.fn();
      const store = new ExchangeStateStore();
      const drifts: unknown[] = [];
      bus.subscribe("ReconciliationDriftDetected", async (event) => {
        drifts.push(event);
      });
      mod = buildModule({ exchangeStateStore: store, runtimeMetrics: { writeEvent } as any });

      const first = await mod.runReconciliation();
      const second = await mod.runReconciliation();

      expect(first.clean).toBe(true);
      expect(second.clean).toBe(true);
      expect(first.details).toEqual([]);
      expect(second.details).toEqual([]);
      expect(gateway.cancelOrder).not.toHaveBeenCalled();
      expect(gateway.getOrderResult).toHaveBeenCalledTimes(2);
      expect(store.getOpenSellSizeForToken(TOK)).toBeNull();
      expect(drifts).toEqual([]);
      expect(writeEvent.mock.calls.filter(([name]) => String(name).includes("cascade"))).toEqual(
        [],
      );
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
      orderRepo.findById = vi.fn().mockReturnValue(cancelledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });
      mockExactCancelled("ex-stale-2pass");

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
      orderRepo.findById = vi.fn().mockReturnValue(cancelledLocal);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });
      mockExactCancelled("ex-stale-detail");

      const result = await mod.runReconciliation();

      expect(result.details).toEqual(
        expect.arrayContaining([
          expect.stringContaining("stale exchange order terminal confirmed: ex-stale-detail"),
          expect.stringContaining("local: cancelled"),
        ]),
      );
    });

    it("keeps an ACK+OPEN stale SELL reserved and reports the pass dirty", async () => {
      const cancelledLocal = makeLocalOrder({
        exchangeOrderId: "ex-stale-open",
        status: "cancelled",
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([
        makeExchangeOrder({
          orderId: "ex-stale-open",
          side: "sell",
          sizeRemaining: 10,
        }),
      ]);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: true });
      gateway.getOrderResult = vi.fn().mockResolvedValue({
        ok: true,
        data: makeExchangeOrder({ orderId: "ex-stale-open", status: "OPEN" }),
      });
      const store = new ExchangeStateStore();
      mod = buildModule({ exchangeStateStore: store });

      const result = await mod.runReconciliation();

      expect(result.clean).toBe(false);
      expect(result.details).toContain(
        "stale exchange order cancel acknowledged but unconfirmed: ex-stale-open (local: cancelled)",
      );
      expect(store.getOpenSellSizeForToken(TOK)).toBe(10);
    });

    it("retains an unresolved stale SELL reservation across snapshot omission until exact proof", async () => {
      const cancelledLocal = makeLocalOrder({
        exchangeOrderId: "ex-stale-retained",
        status: "cancelled",
      });
      const staleSell = makeExchangeOrder({
        orderId: "ex-stale-retained",
        side: "sell",
        sizeRemaining: 10,
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
      orderRepo.findById = vi.fn().mockReturnValue(cancelledLocal);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValueOnce([staleSell])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      gateway.cancelOrder = vi.fn().mockResolvedValue({ success: false, errorCode: "server" });
      gateway.getOrderResult = vi.fn().mockResolvedValue({
        ok: true,
        data: makeExchangeOrder({ orderId: "ex-stale-retained", status: "OPEN" }),
      });
      const store = new ExchangeStateStore();
      mod = buildModule({ exchangeStateStore: store });

      await mod.runReconciliation();
      expect(store.getOpenSellSizeForToken(TOK)).toBe(10);
      await mod.runReconciliation();
      expect(store.getOpenSellSizeForToken(TOK)).toBe(10);
      (gateway.getOrderResult as any).mockResolvedValue({
        ok: true,
        data: makeExchangeOrder({
          orderId: "ex-stale-retained",
          status: "CANCELLED",
          sizeFilled: 0,
        }),
      });
      await mod.runReconciliation();
      expect(store.getOpenSellSizeForToken(TOK)).toBeNull();
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

    it("falls back to clientOrderId when exact exchangeOrderId misses", async () => {
      const exFill = makeExchangeFill({
        fillId: "fill-fallback",
        orderId: "ex-ord-1",
      });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);

      const local = makeLocalOrder();
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(null);
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(local);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(1);
      expect(fillRepo.save).toHaveBeenCalledTimes(1);
      expect(orderRepo.findByExchangeOrderId).toHaveBeenCalledWith("ex-ord-1");
      expect(orderRepo.findByClientOrderId).toHaveBeenCalledWith("plk_abc");
    });

    it("matches a fill by exact exchangeOrderId before clientOrderId", async () => {
      const exFill = makeExchangeFill({ fillId: "fill-primary" });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);

      const local = makeLocalOrder();
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(local);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(1);
      expect(orderRepo.findByExchangeOrderId).toHaveBeenCalledWith("ex-ord-1");
      expect(orderRepo.findByClientOrderId).not.toHaveBeenCalled();
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

  // ─── Reconciliation hardening (#36) ─────────────────────────────────

  describe("reconciliation hardening (#36)", () => {
    const rateLimitSkip = { ok: false as const, reason: "rate_limit" as const, attempts: 3 };

    // 5 min old → beyond the module grace (2×60s + 30s = 150s).
    function oldMissingOrder(exchangeOrderId: string): Order {
      const old = new Date(Date.now() - 300_000).toISOString();
      return makeLocalOrder({ exchangeOrderId, createdAt: old, updatedAt: old });
    }

    // ─── Fix 3: consecutive-miss gate (default 3) ───────────────────

    describe("Fix 3 — consecutive-miss gate (default 3)", () => {
      it("reports a genuinely-missing order on the 3rd consecutive miss without cancelling it", async () => {
        const order = oldMissingOrder("ex-disappeared");
        orderRepo.findOpen = vi.fn().mockReturnValue([order]);
        gateway.getOpenOrders = vi.fn().mockResolvedValue([]); // reliably empty across passes

        // Shared `mod` keeps the consecutive-miss Map across passes; default threshold = 3.
        const r1 = await mod.runReconciliation();
        const r2 = await mod.runReconciliation();
        expect(r1.phantomOrders).toBe(0);
        expect(r2.phantomOrders).toBe(0);
        expect(orderRepo.updateStatus).not.toHaveBeenCalled();

        const r3 = await mod.runReconciliation();
        expect(r3.phantomOrders).toBe(0);
        expect(orderRepo.updateStatus).not.toHaveBeenCalled();
      });

      it("resets the miss streak when the order reappears before the threshold", async () => {
        const order = oldMissingOrder("ex-flapping");
        orderRepo.findOpen = vi.fn().mockReturnValue([order]);
        // miss, miss, reappear (reset), miss, miss → max 2 consecutive < 3 → never cancelled.
        gateway.getOpenOrders = vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([makeExchangeOrder({ orderId: "ex-flapping" })])
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([]);

        for (let i = 0; i < 5; i++) await mod.runReconciliation();

        expect(orderRepo.updateStatus).not.toHaveBeenCalled();
      });
    });

    // ─── Fix 1: unreliable open-orders snapshot ─────────────────────

    describe("Fix 1 — unreliable open-orders snapshot", () => {
      it("skips the order pass and cancels nothing on ok:false (even at threshold=1)", async () => {
        const order = oldMissingOrder("ex-skip");
        orderRepo.findOpen = vi.fn().mockReturnValue([order]);
        gateway.getOpenOrdersResult = vi.fn().mockResolvedValue(rateLimitSkip);

        mod = buildModule({ consecutiveMissThreshold: 1 });
        const result = await mod.runReconciliation();

        expect(result.phantomOrders).toBe(0);
        expect(orderRepo.updateStatus).not.toHaveBeenCalled();
      });

      it("does not report missing orders until an open snapshot becomes reliable", async () => {
        const order = oldMissingOrder("ex-massdc");
        orderRepo.findOpen = vi.fn().mockReturnValue([order]);
        gateway.getOpenOrdersResult = vi
          .fn()
          .mockResolvedValueOnce(rateLimitSkip)
          .mockResolvedValueOnce(rateLimitSkip)
          .mockResolvedValueOnce(rateLimitSkip)
          .mockResolvedValue({ ok: true, data: [] }); // recovery: order genuinely gone

        mod = buildModule({ consecutiveMissThreshold: 1 });
        const r1 = await mod.runReconciliation();
        const r2 = await mod.runReconciliation();
        const r3 = await mod.runReconciliation();
        expect(orderRepo.updateStatus).not.toHaveBeenCalled();
        expect([r1, r2, r3].every((r) => r.phantomOrders === 0)).toBe(true);

        // First reliable snapshot post-recovery: threshold=1 → unresolved evidence.
        const r4 = await mod.runReconciliation();
        expect(r4.phantomOrders).toBe(0);
        expect(orderRepo.updateStatus).not.toHaveBeenCalled();
      });
    });

    // ─── Fix 2: suspicious empty snapshot ───────────────────────────

    describe("Fix 2 — suspicious empty snapshot", () => {
      it("skips when >= 3 local orders vanish from the exchange at once", async () => {
        orderRepo.findOpen = vi
          .fn()
          .mockReturnValue([
            oldMissingOrder("ex-a"),
            oldMissingOrder("ex-b"),
            oldMissingOrder("ex-c"),
          ]);
        gateway.getOpenOrders = vi.fn().mockResolvedValue([]); // reliable but suspicious

        const store = new ExchangeStateStore();
        store.updateExchangeSellOrders(
          [{ orderId: "ex-prior", tokenId: TOK, sizeRemaining: 7 }],
          Date.now(),
        );
        mod = buildModule({ consecutiveMissThreshold: 1, exchangeStateStore: store });
        const result = await mod.runReconciliation();

        expect(result.phantomOrders).toBe(0);
        expect(orderRepo.updateStatus).not.toHaveBeenCalled();
        expect(store.getOpenSellSizeForToken(TOK)).toBe(7);
      });
    });

    it("does not republish 3 confirmed stale exits from its own 25-cancel pass", async () => {
      const store = new ExchangeStateStore();
      mod = buildModule({ exchangeStateStore: store });
      const conditionId = createConditionId("cond-recovery");
      const oldCreatedAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
      const recoveryOrders = [9.555, 12.74, 9.555].map((size, index) =>
        makeLocalOrder({
          orderId: createOrderId(`recovery-rung-${index}`),
          exchangeOrderId: `recovery-rung-${index}`,
          tokenId: TOK,
          conditionId,
          side: "sell",
          size,
          signalReason: "reduce-only",
          createdAt: oldCreatedAt,
        }),
      );
      const entryOrders = Array.from({ length: 22 }, (_, index) =>
        makeLocalOrder({
          orderId: createOrderId(`stale-entry-${index}`),
          exchangeOrderId: `stale-entry-${index}`,
          tokenId: createTokenId(`stale-entry-token-${index}`),
          conditionId: createConditionId(`stale-entry-condition-${index}`),
          side: "buy",
          signalReason: "probe-entry",
          createdAt: oldCreatedAt,
        }),
      );
      const localOrders = [...recoveryOrders, ...entryOrders];
      const byId = new Map(localOrders.map((order) => [String(order.orderId), order]));
      orderRepo.findOpen = vi.fn(() => localOrders.filter((order) => order.status === "open"));
      orderRepo.findById = vi.fn((orderId) => byId.get(String(orderId)) ?? null);
      orderRepo.findByExchangeOrderId = vi.fn((orderId) => byId.get(String(orderId)) ?? null);
      gateway.getOpenOrders = vi.fn().mockResolvedValue(
        localOrders.map((order) =>
          makeExchangeOrder({
            orderId: String(order.orderId),
            clientOrderId: String(order.clientOrderId),
            tokenId: order.tokenId,
            side: order.side,
            price: order.price,
            sizeTotal: order.size,
            sizeRemaining: order.size,
          }),
        ),
      );
      const cancelReasons: string[] = [];
      const reservedAfterCancel: Array<number | null> = [];
      bus.subscribe("CancelOrderRequested", async ({ command }) => {
        const order = byId.get(String(command.orderId))!;
        order.status = "cancelled";
        cancelReasons.push(command.reason);
        await bus.publish("OrderCancelled", {
          commandId: createCommandId(`confirmed-${String(command.orderId)}`),
          orderId: order.orderId,
          tokenId: order.tokenId,
          conditionId: order.conditionId,
          reason: command.reason,
          signalReason: order.signalReason,
          timestamp: Date.now(),
        });
        reservedAfterCancel.push(store.getOpenSellSizeForToken(TOK));
      });

      await mod.start();

      expect(cancelReasons).toHaveLength(25);
      expect(cancelReasons.filter((reason) => reason === "stale_exit_ttl")).toHaveLength(3);
      expect(reservedAfterCancel.slice(-3)).toEqual([22.295, 9.555, null]);
      expect(store.getOpenSellSizeForToken(TOK)).toBeNull();
      await mod.stop();
    });

    it("removes a non-TTL exact-identity cancelled SELL reservation", async () => {
      const store = new ExchangeStateStore();
      const local = makeLocalOrder({ status: "cancelled", side: "sell" });
      orderRepo.findById = vi.fn().mockReturnValue(local);
      mod = buildModule({ exchangeStateStore: store });
      await mod.start();
      store.updateExchangeSellOrders(
        [{ orderId: local.exchangeOrderId!, tokenId: local.tokenId, sizeRemaining: local.size }],
        Date.now(),
      );

      await bus.publish("OrderCancelled", {
        commandId: createCommandId("confirmed-non-ttl"),
        orderId: local.orderId,
        tokenId: local.tokenId,
        conditionId: local.conditionId,
        reason: "sell_replace_reprice",
        signalReason: local.signalReason,
        timestamp: Date.now(),
      });

      expect(store.getOpenSellSizeForToken(local.tokenId)).toBeNull();
      await mod.stop();
    });

    it("retains cancelled SELL reservations when an OrderCancelled identity fence fails", async () => {
      const store = new ExchangeStateStore();
      const matching = makeLocalOrder({ status: "cancelled", side: "sell" });
      let local: Order | null = matching;
      orderRepo.findById = vi.fn(() => local);
      mod = buildModule({ exchangeStateStore: store });
      await mod.start();

      for (const mismatch of [
        null,
        { ...matching, status: "open" as const },
        { ...matching, side: "buy" as const },
        { ...matching, tokenId: createTokenId("other-token") },
        { ...matching, conditionId: createConditionId("other-condition") },
        { ...matching, exchangeOrderId: null },
      ]) {
        local = mismatch;
        store.updateExchangeSellOrders(
          [{ orderId: matching.exchangeOrderId!, tokenId: matching.tokenId, sizeRemaining: 10 }],
          Date.now(),
        );
        await bus.publish("OrderCancelled", {
          commandId: createCommandId(`mismatch-${String(mismatch?.status ?? "missing")}`),
          orderId: matching.orderId,
          tokenId: matching.tokenId,
          conditionId: matching.conditionId,
          reason: "sell_replace_reprice",
          signalReason: matching.signalReason,
          timestamp: Date.now(),
        });
        expect(store.getOpenSellSizeForToken(matching.tokenId)).toBe(10);
      }

      await mod.stop();
    });

    // ─── Fix 1.5: unreliable fills snapshot ─────────────────────────

    describe("Fix 1.5 — unreliable fills snapshot", () => {
      it("skips fill import and publishes no FillReceived on ok:false", async () => {
        gateway.getFillsResult = vi
          .fn()
          .mockResolvedValue({ ok: false, reason: "timeout", attempts: 3 });
        const fills: unknown[] = [];
        bus.subscribe("FillReceived", async (p) => {
          fills.push(p);
        });

        const result = await mod.runReconciliation();
        await bus.drain();

        expect(result.missingFills).toBe(0);
        expect(fills).toHaveLength(0);
        expect(fillRepo.save).not.toHaveBeenCalled();
      });
    });

    // ─── Counters ───────────────────────────────────────────────────

    describe("counters", () => {
      it("does not warn on clean reconciliation with only remote-only redeemable wallet drift", async () => {
        const writeEvent = vi.fn();
        const localLog = { ...silentLog, warn: vi.fn(), child: () => localLog };
        const store = new ExchangeStateStore();
        mod = new ReconciliationModule({
          gateway,
          bus,
          orderRepo,
          fillRepo,
          marketRepo,
          log: localLog,
          reconcileIntervalMs: 60_000,
          exchangeStateStore: store,
          walletPositionReader: {
            read: vi.fn().mockResolvedValue([
              {
                tokenId: "tok-redeemable",
                conditionId: "cond-redeemable",
                size: 10,
                currentValueUsdc: 0,
                initialValueUsdc: 1,
                redeemable: true,
                slug: "resolved-market",
                marketSlug: "resolved-market",
                outcome: "Yes",
                raw: {},
              },
            ]),
          },
          runtimeMetrics: { writeEvent },
        });

        const result = await mod.runReconciliation();

        expect(result.clean).toBe(true);
        expect(writeEvent).toHaveBeenCalledWith(
          "wallet_position_drift_abs",
          10,
          JSON.stringify({ source: "reconciliation" }),
          expect.any(String),
        );
        expect(writeEvent).toHaveBeenCalledWith(
          "wallet_position_actionable_drift_abs",
          0,
          JSON.stringify({ source: "reconciliation" }),
          expect.any(String),
        );
        expect(writeEvent).toHaveBeenCalledWith(
          "wallet_position_remote_only_redeemable_abs",
          10,
          JSON.stringify({ source: "reconciliation" }),
          expect.any(String),
        );
        expect(localLog.warn).not.toHaveBeenCalledWith(
          expect.anything(),
          "wallet actionable position drift threshold exceeded (>=5 shares)",
        );
        expect(localLog.warn).not.toHaveBeenCalledWith(
          expect.anything(),
          "wallet position drift threshold exceeded (>=5 shares)",
        );
      });

      it("does not clear the wallet store when the wallet reader skips a snapshot", async () => {
        const store = new ExchangeStateStore();
        store.replaceWalletPositionsBatch([{ tokenId: "tok-existing", size: 7 }], Date.now());
        mod = buildModule({
          exchangeStateStore: store,
          walletPositionReader: { read: vi.fn().mockResolvedValue(null) },
        });

        await mod.runReconciliation();

        expect(store.getWalletPositionSize("tok-existing")).toBe(7);
      });

      it("emits actionable wallet drift warning once for repeated identical confirmed drift", async () => {
        const tokenId = createTokenId("tok-local-active");
        const oldIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const position: Position = {
          positionId: createPositionId("pos-local-active"),
          tokenId,
          conditionId: createConditionId("cond-local-active"),
          side: "buy",
          size: 12,
          avgEntryPrice: 0.1,
          costBasisUsdc: 1.2,
          currentValueUsdc: 1,
          realizedPnl: 0,
          status: "open",
          entryStyle: "probe",
          openedAt: oldIso,
          closedAt: null,
          updatedAt: oldIso,
        };
        const localLog = { ...silentLog, warn: vi.fn(), child: () => localLog };
        const positionRepo = {
          findAll: vi.fn().mockReturnValue([position]),
          save: vi.fn(),
        };
        marketRepo.findByTokenId = vi.fn().mockReturnValue({
          tokenId,
          conditionId: "cond-local-active",
          slug: "active-missing-remote",
          endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });
        gateway.getPositionBalance = vi.fn().mockResolvedValue(0);
        mod = new ReconciliationModule({
          gateway,
          bus,
          orderRepo,
          fillRepo,
          marketRepo,
          log: localLog,
          reconcileIntervalMs: 60_000,
          exchangeStateStore: new ExchangeStateStore(),
          walletPositionSentinel: {
            reader: { read: vi.fn().mockResolvedValue([]) },
            positionRepo: positionRepo as any,
            fillRepo,
            marketRepo,
            log: localLog,
          },
          runtimeMetrics: { writeEvent: vi.fn() },
        });

        await mod.runReconciliation();
        await mod.runReconciliation();

        const actionableWarns = localLog.warn.mock.calls.filter(
          (call: unknown[]) =>
            call[1] === "wallet actionable position drift threshold exceeded (>=5 shares)",
        );
        expect(actionableWarns).toHaveLength(1);
        expect(actionableWarns[0]![0]).toMatchObject({ walletPositionActionableDriftAbs: 12 });
      });

      it("emits fetch-failed + skipped-unreliable + retried on an unreliable open-orders snapshot", async () => {
        gateway.getOpenOrdersResult = vi.fn().mockResolvedValue(rateLimitSkip);
        const writeEvent = vi.fn();
        mod = buildModule({ runtimeMetrics: { writeEvent } });

        await mod.runReconciliation();

        const names = writeEvent.mock.calls.map((c) => c[0]);
        expect(names).toContain("reconciliation_fetch_failed");
        expect(names).toContain("reconciliation_skipped_unreliable");
        expect(names).toContain("reconciliation_fetch_retried");

        const failed = writeEvent.mock.calls.find((c) => c[0] === "reconciliation_fetch_failed")!;
        expect(JSON.parse(failed[2])).toMatchObject({
          reason: "rate_limit",
          source: "open_orders",
        });
        const retried = writeEvent.mock.calls.find((c) => c[0] === "reconciliation_fetch_retried")!;
        expect(retried[1]).toBe(2); // attempts(3) - 1
      });

      it("emits consecutive-miss-tracked while a real disappearance is below threshold", async () => {
        orderRepo.findOpen = vi.fn().mockReturnValue([oldMissingOrder("ex-tracked")]);
        gateway.getOpenOrders = vi.fn().mockResolvedValue([]);
        const writeEvent = vi.fn();
        mod = buildModule({ runtimeMetrics: { writeEvent } }); // default threshold 3

        await mod.runReconciliation(); // miss 1 — tracked, not cancelled

        const tracked = writeEvent.mock.calls.find(
          (c) => c[0] === "reconciliation_consecutive_miss_tracked",
        );
        expect(tracked).toBeDefined();
        expect(tracked![1]).toBe(1);
        // Zero-valued counters are suppressed.
        const skipped = writeEvent.mock.calls.find(
          (c) => c[0] === "reconciliation_skipped_unreliable",
        );
        expect(skipped).toBeUndefined();
      });

      it("emits fills-skipped-unreliable on an unreliable fills snapshot", async () => {
        gateway.getFillsResult = vi
          .fn()
          .mockResolvedValue({ ok: false, reason: "server", attempts: 1 });
        const writeEvent = vi.fn();
        mod = buildModule({ runtimeMetrics: { writeEvent } });

        await mod.runReconciliation();

        const names = writeEvent.mock.calls.map((c) => c[0]);
        expect(names).toContain("reconciliation_fills_skipped_unreliable");
        const fillsFailed = writeEvent.mock.calls.find(
          (c) => c[0] === "reconciliation_fetch_failed" && JSON.parse(c[2]).source === "fills",
        );
        expect(fillsFailed).toBeDefined();
      });
    });

    // ─── Stage independence ─────────────────────────────────────────

    describe("stage independence", () => {
      it("imports fills even when the order snapshot is unreliable", async () => {
        gateway.getOpenOrdersResult = vi.fn().mockResolvedValue(rateLimitSkip);
        const exFill = makeExchangeFill({ fillId: "fill-during-skip" });
        gateway.getFills = vi.fn().mockResolvedValue([exFill]);
        fillRepo.exists = vi.fn().mockReturnValue(false);
        orderRepo.findByClientOrderId = vi.fn().mockReturnValue(makeLocalOrder());

        const result = await mod.runReconciliation();

        expect(result.phantomOrders).toBe(0); // order stage skipped
        expect(result.missingFills).toBe(1); // fill stage still ran
        expect(fillRepo.save).toHaveBeenCalledTimes(1);
      });
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

    it("publishes ReconciliationDriftDetected with severity=warn for unresolved missing orders", async () => {
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

      // threshold=1 → single confirmed miss produces a warn-level unresolved drift.
      mod = buildModule({ consecutiveMissThreshold: 1 });
      await mod.runReconciliation();
      await bus.drain();

      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.severity).toBe("warn");
    });

    it("warns twice before publishing critical drift for confirmed wallet sentinel mismatches", async () => {
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
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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

    it("suppresses an exact settled zero-value loser without an on-chain balance read", async () => {
      const futureEndDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const closedPosition: Position = {
        positionId: createPositionId("pos-settled-loser"),
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
            conditionId: "cond-1",
            size: 10,
            currentValueUsdc: 0,
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
        slug: "settled-loser",
        outcome: " Yes ",
        endDate: futureEndDate,
      });
      const marketResolutionRepo = {
        findByConditionId: vi.fn().mockReturnValue({
          conditionId: "cond-1",
          resolution: " no ",
          resolvedAt: new Date().toISOString(),
          detectedAt: new Date().toISOString(),
          source: "gamma-api",
          rawResponse: null,
          status: "settled",
        }),
      } as unknown as MarketResolutionRepository;
      gateway.getPositionBalance = vi.fn().mockResolvedValue(10);

      const result = await new ReconciliationModule({
        gateway,
        bus,
        orderRepo,
        fillRepo,
        marketRepo,
        marketResolutionRepo,
        log: silentLog,
        reconcileIntervalMs: 60_000,
        walletPositionSentinel: {
          reader: walletReader,
          positionRepo: {
            findAll: vi.fn().mockReturnValue([closedPosition]),
          } as unknown as import("@krabs/domain").PositionRepository,
          marketRepo,
          log: silentLog,
        },
      }).runReconciliation();

      expect(result.clean).toBe(true);
      expect(result.positionDriftCount).toBe(0);
      expect(gateway.getPositionBalance).not.toHaveBeenCalled();
    });

    it.each([
      ["winning outcome", 0, "settled", "Yes", "cond-1", "cond-1"],
      ["detected resolution", 0, "detected", "No", "cond-1", "cond-1"],
      ["positive remote value", 0.01, "settled", "No", "cond-1", "cond-1"],
      ["condition mismatch", 0, "settled", "No", "other-condition", "cond-1"],
      ["unknown resolution", 0, "settled", "unknown", "cond-1", "cond-1"],
      ["trimmed condition alias", 0, "settled", "No", "cond-1", " cond-1 "],
    ] as const)(
      "keeps %s on the existing on-chain drift check",
      async (_, value, status, outcome, resolvedConditionId, marketConditionId) => {
        const closedPosition = {
          positionId: createPositionId("pos-settled-boundary"),
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
        } as Position;
        marketRepo.findByTokenId = vi.fn().mockReturnValue({
          tokenId: TOK,
          conditionId: marketConditionId,
          slug: "settled-boundary",
          outcome: "Yes",
          endDate: new Date(Date.now() + 60_000).toISOString(),
        });
        const marketResolutionRepo = {
          findByConditionId: vi.fn().mockReturnValue({
            conditionId: resolvedConditionId,
            resolution: outcome,
            status,
          }),
        } as unknown as MarketResolutionRepository;
        gateway.getPositionBalance = vi.fn().mockResolvedValue(10);

        const result = await new ReconciliationModule({
          gateway,
          bus,
          orderRepo,
          fillRepo,
          marketRepo,
          marketResolutionRepo,
          log: silentLog,
          reconcileIntervalMs: 60_000,
          walletPositionSentinel: {
            reader: {
              read: vi
                .fn()
                .mockResolvedValue([
                  { tokenId: String(TOK), size: 10, currentValueUsdc: value, outcome: "Yes" },
                ]),
            } as unknown as PolymarketPositionReader,
            positionRepo: {
              findAll: vi.fn().mockReturnValue([closedPosition]),
            } as unknown as import("@krabs/domain").PositionRepository,
            marketRepo,
            log: silentLog,
          },
        }).runReconciliation();

        expect(result.clean).toBe(false);
        expect(result.positionDriftCount).toBe(1);
        expect(gateway.getPositionBalance).toHaveBeenCalledOnce();
      },
    );

    it("confirms wallet sentinel balance drifts in parallel instead of K serial RPCs", async () => {
      const tokenIds = [
        createTokenId("tok-drift-1"),
        createTokenId("tok-drift-2"),
        createTokenId("tok-drift-3"),
      ];
      const futureEndDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const closedPositions: Position[] = tokenIds.map((tokenId, idx) => ({
        positionId: createPositionId(`pos-wallet-drift-${idx + 1}`),
        tokenId,
        conditionId: createConditionId(`cond-${idx + 1}`),
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
      }));
      const walletReader: PolymarketPositionReader = {
        read: vi.fn().mockResolvedValue(
          tokenIds.map((tokenId, idx) => ({
            tokenId: String(tokenId),
            size: 10 + idx,
            currentValueUsdc: 2,
            initialValueUsdc: 1,
            slug: `wallet-drift-${idx + 1}`,
            marketSlug: `wallet-drift-${idx + 1}`,
            outcome: "Yes",
            raw: {},
          })),
        ),
      };
      marketRepo.findByTokenId = vi.fn(
        (tokenId: TokenId) =>
          ({
            tokenId,
            conditionId: `cond-${String(tokenId).slice(-1)}`,
            slug: `wallet-drift-${String(tokenId).slice(-1)}`,
            endDate: futureEndDate,
          }) as any,
      );
      const balanceReads = new Map<string, ReturnType<typeof deferred<number>>>();
      const started: string[] = [];
      for (const tokenId of tokenIds) {
        balanceReads.set(String(tokenId), deferred<number>());
      }
      gateway.getPositionBalance = vi.fn((tokenId: TokenId) => {
        started.push(String(tokenId));
        return balanceReads.get(String(tokenId))!.promise;
      });
      const driftMod = new ReconciliationModule({
        gateway,
        bus,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        reconcileIntervalMs: 60_000,
        walletPositionSentinel: {
          reader: walletReader,
          positionRepo: {
            findAll: vi.fn().mockReturnValue(closedPositions),
          } as unknown as import("@krabs/domain").PositionRepository,
          marketRepo,
          log: silentLog,
        },
      });

      const run = driftMod.runReconciliation();
      await delay(25);

      expect(started).toEqual(tokenIds.map(String));

      for (const tokenId of tokenIds) {
        balanceReads.get(String(tokenId))!.resolve(10);
      }
      const result = await run;

      expect(result.positionDriftCount).toBe(3);
    });
  });

  // ─── Wallet sentinel accounting fence ───────────────────────────

  describe("wallet sentinel missing-remote accounting fence", () => {
    const futureEndDate = () => new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    function makeOpenPosition(overrides: Partial<Position> = {}): Position {
      return {
        positionId: createPositionId("pos-missing-remote"),
        tokenId: TOK,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        size: 50,
        avgEntryPrice: 0.1,
        costBasisUsdc: 5,
        currentValueUsdc: 4.5,
        realizedPnl: 0,
        status: "open",
        entryStyle: "probe",
        openedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        closedAt: null,
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        ...overrides,
      };
    }

    function emptyWalletReader(): PolymarketPositionReader {
      return { read: vi.fn().mockResolvedValue([]) };
    }

    function wireSentinel(
      saveSpy: ReturnType<typeof vi.fn>,
      positions: Position[],
      reader: PolymarketPositionReader = emptyWalletReader(),
    ) {
      marketRepo.findByTokenId = vi.fn().mockReturnValue({
        tokenId: TOK,
        conditionId: "cond-1",
        slug: "missing-remote-market",
        endDate: futureEndDate(),
      });
      return new ReconciliationModule({
        gateway,
        bus,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        reconcileIntervalMs: 60_000,
        walletPositionSentinel: {
          reader,
          positionRepo: {
            findAll: vi.fn().mockReturnValue(positions),
            save: saveSpy,
          } as unknown as import("@krabs/domain").PositionRepository,
          marketRepo,
          log: silentLog,
        },
      });
    }

    it("keeps a confirmed missing-remote position visible without closing it", async () => {
      gateway.getPositionBalance = vi.fn().mockResolvedValue(0);
      const saveSpy = vi.fn();
      const drifts: Array<{ details: string }> = [];
      bus.subscribe("ReconciliationDriftDetected", async (p) => {
        drifts.push({ details: p.details });
      });

      const driftMod = wireSentinel(saveSpy, [makeOpenPosition()]);
      const result = await driftMod.runReconciliation();
      await bus.drain();

      expect(saveSpy).not.toHaveBeenCalled();
      expect(result.positionDriftCount).toBe(1);
      expect(drifts.at(-1)!.details).toContain("wallet-local-position-missing-remote");
      expect(drifts.at(-1)!.details).not.toContain("wallet-local-position-auto-closed");
    });

    it("never bypasses settlement accounting after repeated on-chain zero confirmation", async () => {
      gateway.getPositionBalance = vi.fn().mockResolvedValue(0);
      const saveSpy = vi.fn();
      const localLog = {
        ...silentLog,
        warn: vi.fn(),
        child: () => localLog,
      };
      marketRepo.findByTokenId = vi.fn().mockReturnValue({
        tokenId: TOK,
        conditionId: "cond-1",
        slug: "missing-remote-market",
        endDate: futureEndDate(),
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
          reader: emptyWalletReader(),
          positionRepo: {
            findAll: vi.fn().mockReturnValue([makeOpenPosition()]),
            save: saveSpy,
          } as unknown as import("@krabs/domain").PositionRepository,
          marketRepo,
          log: localLog,
        },
      });

      const drifts: Array<{ details: string }> = [];
      bus.subscribe("ReconciliationDriftDetected", async (p) => {
        drifts.push({ details: p.details });
      });

      await driftMod.runReconciliation();
      const second = await driftMod.runReconciliation();
      await bus.drain();

      expect(saveSpy).not.toHaveBeenCalled();
      expect(second.positionDriftCount).toBe(1);
      expect(second.details.some((d) => d.includes("wallet-local-position-missing-remote"))).toBe(
        true,
      );
      expect(second.details.some((d) => d.includes("wallet-local-position-auto-closed"))).toBe(
        false,
      );
    });

    it("treats a positive on-chain balance as transient data-api lag", async () => {
      gateway.getPositionBalance = vi.fn().mockResolvedValue(12);
      const saveSpy = vi.fn();
      const driftMod = wireSentinel(saveSpy, [makeOpenPosition()]);

      const result = await driftMod.runReconciliation();

      expect(saveSpy).not.toHaveBeenCalled();
      expect(result.positionDriftCount).toBe(0);
    });

    it("remains report-only across wallet disappearance and recovery", async () => {
      gateway.getPositionBalance = vi.fn().mockResolvedValue(0);
      const saveSpy = vi.fn();
      const firstReader = emptyWalletReader();
      marketRepo.findByTokenId = vi.fn().mockReturnValue({
        tokenId: TOK,
        conditionId: "cond-1",
        slug: "missing-remote-market",
        endDate: futureEndDate(),
      });
      const driftMod = new ReconciliationModule({
        gateway,
        bus,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        reconcileIntervalMs: 60_000,
        walletPositionSentinel: {
          reader: firstReader,
          positionRepo: {
            findAll: vi.fn().mockReturnValue([makeOpenPosition()]),
            save: saveSpy,
          } as unknown as import("@krabs/domain").PositionRepository,
          marketRepo,
          log: silentLog,
        },
      });

      // Empty wallet: preserve the local inventory and surface the drift.
      await driftMod.runReconciliation();
      expect(saveSpy).not.toHaveBeenCalled();

      // The token returns with real size; a normal mark update is allowed.
      firstReader.read = vi.fn().mockResolvedValue([
        {
          tokenId: String(TOK),
          conditionId: "cond-1",
          size: 50,
          currentValueUsdc: 4.5,
          initialValueUsdc: 5,
          redeemable: false,
          slug: null,
          marketSlug: null,
          outcome: "Yes",
          raw: {},
        },
      ]);
      await driftMod.runReconciliation();
      expect(saveSpy).not.toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));

      // If it disappears again, reconciliation still must not close it.
      firstReader.read = vi.fn().mockResolvedValue([]);
      await driftMod.runReconciliation();
      expect(saveSpy).not.toHaveBeenCalledWith(expect.objectContaining({ status: "closed" }));
    });

    it("falls back to report-only when wallet sentinel deps are unwired", async () => {
      const cleanMod = new ReconciliationModule({
        gateway,
        bus,
        orderRepo,
        fillRepo,
        marketRepo,
        log: silentLog,
        reconcileIntervalMs: 60_000,
      });

      const result = await cleanMod.runReconciliation();
      // No sentinel wiring → no positions inspected at all. Sanity check that
      // the absence of the walletPositionSentinel dep is non-fatal and never
      // tries to close anything.
      expect(result.clean).toBe(true);
    });

    it("does not silently discard dust inventory either", async () => {
      gateway.getPositionBalance = vi.fn().mockResolvedValue(0);
      const saveSpy = vi.fn();
      const driftMod = wireSentinel(saveSpy, [
        makeOpenPosition({ status: "dust", size: 0.5, currentValueUsdc: 0.05 }),
      ]);

      await driftMod.runReconciliation();
      await driftMod.runReconciliation();

      expect(saveSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Re-entrancy guard ────────────────────────────────────────────

  describe("re-entrancy", () => {
    it("prevents overlapping reconciliation runs", async () => {
      let resolveGateway: (() => void) | null = null;
      gateway.getFills = vi.fn().mockImplementation(
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
      expect(gateway.getFills).toHaveBeenCalledTimes(1);
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

    it("does not advance the recovery cursor after an unreliable fills snapshot", async () => {
      gateway.getFillsResult = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: "parse", attempts: 1 })
        .mockResolvedValue({ ok: true, data: [] });

      await mod.runReconciliation();
      await mod.runReconciliation();
      await mod.runReconciliation();

      expect(gateway.getFillsResult).toHaveBeenNthCalledWith(1, 0);
      expect(gateway.getFillsResult).toHaveBeenNthCalledWith(2, 0);
      expect((gateway.getFillsResult as any).mock.calls[2][0]).toBeGreaterThan(0);
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
