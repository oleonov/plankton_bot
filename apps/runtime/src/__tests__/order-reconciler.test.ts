import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import {
  createTokenId,
  createOrderId,
  createConditionId,
  createFillId,
  RESOLVED_LOSER_LOCAL_CANCEL_REASON,
} from "@krabs/domain";
import {
  bootstrapLedgerDb,
  SqliteFillRepository,
  SqliteMarketResolutionRepository,
  SqliteOrderRepository,
  SqlitePositionRepository,
  SqliteSettlementLedgerRepository,
} from "@krabs/db";
import { InProcessEventBus } from "@krabs/event-bus";
import type {
  ExchangeGateway,
  ExchangeOrder,
  Order,
  OrderRepository,
  FillRepository,
  MarketRepository,
  FetchResult,
  ClientOrderId,
} from "@krabs/domain";
import {
  reconcileOrders,
  reconcileStaleExchangeOrders,
  type OrderReconcilerDeps,
} from "../modules/reconciliation/order-reconciler.js";
import {
  clearCancelIntent,
  EXCHANGE_ABSENT_CANCEL_REASON,
  registerCancelIntent,
} from "../modules/reconciliation/order-status-resolver.js";
import { readExchangeAbsence } from "../modules/reconciliation/exchange-absence.js";

const TOK = createTokenId("tok-yes");
const OLD = new Date(Date.now() - 300_000).toISOString(); // 5 min ago — beyond any grace

describe("order reconciliation stage attribution", () => {
  it("preserves serial call order and records bounded operation counts", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const calls: string[] = [];
      const gateway = createGateway({ openOrders: [] });
      gateway.getOpenOrdersResult = vi.fn(async () => {
        calls.push("open");
        now += 13;
        return { ok: true as const, data: [] };
      });
      gateway.getOrderResult = vi.fn(async () => {
        calls.push("exact");
        now += 17;
        return { ok: true as const, data: null };
      });
      const orderRepo = createOrderRepo();
      const order = makeLocalOrder();
      vi.mocked(orderRepo.findOpen).mockReturnValue([order]);
      vi.mocked(orderRepo.findById).mockReturnValue(order);
      const stageTimingsMs: Record<string, number> = {};
      const writeCounter = vi.fn();
      await reconcileOrders({
        ...baseDeps(gateway, orderRepo),
        stageTimingsMs,
        runtimeMetrics: { writeCounter },
        consecutiveMissThreshold: 1,
      });
      expect(calls).toEqual(["open", "exact"]);
      expect(stageTimingsMs).toEqual({
        "orders.openFetch": 13,
        "orders.unresolvedPrechecks": 0,
        "orders.quarantineObservation": 0,
        "orders.exactCandidates": 17,
        "orders.staleCascade": 0,
      });
      expect(
        writeCounter.mock.calls.filter(([name]) => name === "reconciliation_orders_operations"),
      ).toEqual([
        ["reconciliation_orders_operations", 1, '{"stage":"openFetch"}'],
        ["reconciliation_orders_operations", 0, '{"stage":"unresolvedPrechecks"}'],
        ["reconciliation_orders_operations", 0, '{"stage":"quarantineObservation"}'],
        ["reconciliation_orders_operations", 1, '{"stage":"exactCandidates"}'],
        ["reconciliation_orders_operations", 0, '{"stage":"staleCascade"}'],
      ]);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();
      expect(gateway.cancelOrder).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it.each([false, true])(
    "records failed fetch timing while isolating metrics exceptions (throws=%s)",
    async (throws) => {
      const gateway = createGateway({
        openOrdersResult: { ok: false, reason: "server", attempts: 1 },
      });
      const failure = new Error("read failed");
      if (throws) vi.mocked(gateway.getOpenOrdersResult!).mockRejectedValue(failure);
      const stageTimingsMs: Record<string, number> = {};
      const writeCounter = vi.fn(() => {
        throw new Error("metrics failed");
      });
      const task = reconcileOrders({
        ...baseDeps(gateway, createOrderRepo()),
        stageTimingsMs,
        runtimeMetrics: { writeCounter },
      });
      if (throws) await expect(task).rejects.toBe(failure);
      else expect((await task).skipReason).toBe("unreliable_snapshot");
      expect(stageTimingsMs["orders.openFetch"]).toBeGreaterThanOrEqual(0);
      expect(writeCounter).toHaveBeenCalledWith(
        "reconciliation_orders_stage_ms",
        expect.any(Number),
        '{"stage":"openFetch"}',
      );
      expect(gateway.cancelOrder).not.toHaveBeenCalled();
    },
  );
});

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
    botRunId: "run-1" as never,
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as never;

function createOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  } as unknown as OrderRepository;
}

function createFillRepo(): FillRepository {
  return {
    save: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    findByOrderId: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    findRecent: vi.fn().mockReturnValue([]),
    findUnreconciled: vi.fn().mockReturnValue([]),
    markReconciled: vi.fn(),
    getLatestTimestamp: vi.fn().mockReturnValue(null),
  } as unknown as FillRepository;
}

function createMarketRepo(): MarketRepository {
  return {
    findByTokenId: vi.fn().mockReturnValue(null),
  } as unknown as MarketRepository;
}

interface GatewayOverrides {
  openOrders?: ExchangeOrder[];
  openOrdersResult?: FetchResult<ExchangeOrder[]>;
  exactResult?: FetchResult<ExchangeOrder | null>;
  cancelSuccess?: boolean;
}

function createGateway(o: GatewayOverrides = {}): ExchangeGateway {
  const gw: Record<string, unknown> = {
    cancelOrder: vi.fn().mockResolvedValue({ success: o.cancelSuccess ?? true }),
    getOpenOrders: vi.fn().mockResolvedValue(o.openOrders ?? []),
  };
  if (o.openOrdersResult !== undefined) {
    gw.getOpenOrdersResult = vi.fn().mockResolvedValue(o.openOrdersResult);
  } else if (o.openOrders !== undefined) {
    gw.getOpenOrdersResult = vi.fn().mockResolvedValue({ ok: true, data: o.openOrders });
  }
  if (o.exactResult !== undefined) {
    gw.getOrderResult = vi.fn().mockResolvedValue(o.exactResult);
  }
  return gw as unknown as ExchangeGateway;
}

function baseDeps(gateway: ExchangeGateway, orderRepo: OrderRepository) {
  return {
    gateway,
    orderRepo,
    fillRepo: createFillRepo(),
    marketRepo: createMarketRepo(),
    log: silentLog,
    phantomGraceMs: 60_000,
  };
}

describe("reconcileOrders — Fix 1: unreliable snapshot skip", () => {
  let orderRepo: OrderRepository;

  beforeEach(() => {
    orderRepo = createOrderRepo();
    orderRepo.findOpen = vi.fn().mockReturnValue([makeLocalOrder({ exchangeOrderId: "ex-gone" })]);
  });

  it("skips the entire pass when getOpenOrdersResult is ok:false", async () => {
    const gateway = createGateway({
      openOrdersResult: { ok: false, reason: "rate_limit", attempts: 4 },
    });

    const result = await reconcileOrders(baseDeps(gateway, orderRepo));

    expect(result.skipReason).toBe("unreliable_snapshot");
    expect(result.fetchReason).toBe("rate_limit");
    expect(result.fetchAttempts).toBe(4);
    expect(result.phantomsCancelled).toBe(0);
    expect(result.staleCancelled).toBe(0);
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    expect(gateway.cancelOrder).not.toHaveBeenCalled();
  });

  it("does not publish a snapshot on skip (exchangeOpenOrders empty)", async () => {
    const gateway = createGateway({
      openOrdersResult: { ok: false, reason: "server", attempts: 4 },
    });

    const result = await reconcileOrders(baseDeps(gateway, orderRepo));

    expect(result.exchangeOpenOrders).toEqual([]);
    expect(result.skipReason).toBe("unreliable_snapshot");
  });

  it("falls back to legacy getOpenOrders when the Result method is absent", async () => {
    // Gateway with only the legacy method (mirrors existing test mocks).
    const gw = {
      cancelOrder: vi.fn().mockResolvedValue({ success: true }),
      getOpenOrders: vi.fn().mockResolvedValue([]),
    } as unknown as ExchangeGateway;
    orderRepo.findOpen = vi.fn().mockReturnValue([]);

    const result = await reconcileOrders(baseDeps(gw, orderRepo));

    expect(result.skipReason).toBeUndefined();
    expect(gw.getOpenOrders).toHaveBeenCalledTimes(1);
  });
});

describe("reconcileOrders — Fix 2: suspicious empty snapshot", () => {
  function localOrders(n: number): Order[] {
    return Array.from({ length: n }, (_, i) =>
      makeLocalOrder({ orderId: createOrderId(`ord-${i}`), exchangeOrderId: `ex-${i}` }),
    );
  }

  it("skips when snapshot empty and local open >= threshold (3)", async () => {
    const orderRepo = createOrderRepo();
    orderRepo.findOpen = vi.fn().mockReturnValue(localOrders(3));
    const gateway = createGateway({ openOrders: [] });

    const result = await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      suspiciousEmptyThreshold: 3,
    });

    expect(result.skipReason).toBe("suspicious_empty");
    expect(result.phantomsCancelled).toBe(0);
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("withholds suspicious-empty before exact resolution or quarantine acknowledgement", async () => {
    const orderRepo = createOrderRepo();
    const orders = localOrders(3).map((order) => ({ ...order, status: "pending" as const }));
    orderRepo.findOpen = vi.fn().mockReturnValue(orders);
    orderRepo.findById = vi
      .fn()
      .mockImplementation((orderId) => orders.find((order) => order.orderId === orderId) ?? null);
    const gateway = createGateway({ openOrders: [] });
    gateway.getOrderResult = vi.fn().mockImplementation(async (exchangeOrderId: string) => ({
      ok: true,
      data: makeExchangeOrder({ orderId: exchangeOrderId, status: "OPEN" }),
    }));

    const exactNullStartupQuarantine = {
      isExactNullStartupOrderQuarantined: vi.fn().mockReturnValue(true),
      observeExactNullStartupRemoteState: vi.fn(),
      getExactNullStartupQuarantineCount: vi.fn().mockReturnValue(1),
    };
    const result = await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      exactNullStartupQuarantine,
    });

    expect(result.skipReason).toBe("suspicious_empty");
    expect(result.exchangeOpenOrders).toEqual([]);
    expect(result.unresolvedMissingOnExchange ?? 0).toBe(0);
    expect(gateway.getOrderResult).not.toHaveBeenCalled();
    expect(exactNullStartupQuarantine.isExactNullStartupOrderQuarantined).not.toHaveBeenCalled();
    expect(exactNullStartupQuarantine.observeExactNullStartupRemoteState).not.toHaveBeenCalled();
  });

  it("reports unresolved orders when local open is below the suspicious-empty threshold", async () => {
    const orderRepo = createOrderRepo();
    orderRepo.findOpen = vi.fn().mockReturnValue(localOrders(2));
    const gateway = createGateway({ openOrders: [] });

    const result = await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      suspiciousEmptyThreshold: 3,
      consecutiveMissThreshold: 1,
    });

    expect(result.skipReason).toBeUndefined();
    expect(result.phantomsCancelled).toBe(0);
    expect(result.unresolvedMissingOnExchange).toBe(2);
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("does NOT skip on an empty snapshot with zero local open", async () => {
    const orderRepo = createOrderRepo();
    orderRepo.findOpen = vi.fn().mockReturnValue([]);
    const gateway = createGateway({ openOrders: [] });

    const result = await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      suspiciousEmptyThreshold: 3,
    });

    expect(result.skipReason).toBeUndefined();
    expect(result.phantomsCancelled).toBe(0);
  });

  it("threshold 0 disables the guard but retains every missing local order", async () => {
    const orderRepo = createOrderRepo();
    orderRepo.findOpen = vi.fn().mockReturnValue(localOrders(5));
    const gateway = createGateway({ openOrders: [] });

    const result = await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      suspiciousEmptyThreshold: 0,
      consecutiveMissThreshold: 1,
    });

    expect(result.skipReason).toBeUndefined();
    expect(result.phantomsCancelled).toBe(0);
    expect(result.unresolvedMissingOnExchange).toBe(5);
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("bounds unresolved details while retaining every missing order", async () => {
    const orderRepo = createOrderRepo();
    orderRepo.findOpen = vi.fn().mockReturnValue(localOrders(12));

    const result = await reconcileOrders({
      ...baseDeps(createGateway({ openOrders: [] }), orderRepo),
      suspiciousEmptyThreshold: 0,
      consecutiveMissThreshold: 1,
    });

    expect(result.unresolvedMissingOnExchange).toBe(12);
    expect(result.details).toHaveLength(10);
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });
});

describe("reconcileOrders — missing-order evidence", () => {
  it("exact-reads an ownerless startup-quarantined order and observes reliable remote state", async () => {
    const orderRepo = createOrderRepo();
    const quarantined = makeLocalOrder({ exchangeOrderId: "ex-quarantine" });
    const ordinary = makeLocalOrder({
      orderId: createOrderId("ordinary"),
      exchangeOrderId: "ex-ordinary",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([quarantined, ordinary]);
    const gateway = createGateway({ openOrders: [] });
    gateway.getOrderResult = vi.fn().mockResolvedValue({ ok: true, data: null });
    const exactNullStartupQuarantine = {
      isExactNullStartupOrderQuarantined: vi.fn(
        (order: Order) => order.orderId === quarantined.orderId,
      ),
      observeExactNullStartupRemoteState: vi.fn(),
      getExactNullStartupQuarantineCount: vi.fn().mockReturnValue(1),
    };

    const result = await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      suspiciousEmptyThreshold: 0,
      consecutiveMissThreshold: 1,
      exactNullStartupQuarantine,
    });

    expect(result.acknowledgedExternalStateUnknown).toBe(1);
    // Without a recovery owner it takes the ordinary path toward the exchange-absence rule.
    expect(result.unresolvedMissingOnExchange).toBe(2);
    expect(vi.mocked(gateway.getOrderResult).mock.calls.map(([id]) => id)).toEqual([
      "ex-quarantine",
      "ex-ordinary",
    ]);
    expect(exactNullStartupQuarantine.observeExactNullStartupRemoteState).toHaveBeenCalledWith(
      quarantined,
      "absent",
    );
  });

  it("exact-resolves a mature missing order but leaves null, errors, and coverage gaps fenced", async () => {
    const orderRepo = createOrderRepo();
    const order = makeLocalOrder({ exchangeOrderId: "ex-mature" });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    orderRepo.findById = vi.fn().mockReturnValue(order);
    const fillRepo = createFillRepo();

    for (const exactResult of [
      { ok: true as const, data: null },
      { ok: false as const, reason: "server" as const, attempts: 1 },
      {
        ok: true as const,
        data: makeExchangeOrder({ orderId: "ex-mature", status: "CANCELLED", sizeFilled: 1 }),
      },
    ]) {
      const gateway = createGateway({ openOrders: [], exactResult });
      await reconcileOrders({
        ...baseDeps(gateway, orderRepo),
        fillRepo,
        suspiciousEmptyThreshold: 0,
        consecutiveMissThreshold: 1,
      });
    }
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("promotes a mature missing order from exact working evidence", async () => {
    const orderRepo = createOrderRepo();
    const order = makeLocalOrder({ exchangeOrderId: "ex-mature", status: "pending" });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    orderRepo.findById = vi.fn().mockReturnValue(order);
    const gateway = createGateway({
      openOrders: [],
      exactResult: { ok: true, data: makeExchangeOrder({ orderId: "ex-mature", status: "OPEN" }) },
    });

    await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      suspiciousEmptyThreshold: 0,
      consecutiveMissThreshold: 1,
    });

    expect(gateway.getOrderResult).toHaveBeenCalledWith("ex-mature");
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(order.orderId, "open");
  });

  it("CANCEL_ANCHOR samples first-write time and forwards fillCompletionTolerance=0", async () => {
    const orderRepo = createOrderRepo();
    const order = makeLocalOrder({ exchangeOrderId: "ex-mature", status: "open" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(order.createdAt) + 100_000);
    onTestFinished(() => clock.mockRestore());
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    orderRepo.findById = vi.fn().mockReturnValue(order);
    const fillRepo = createFillRepo();
    fillRepo.findByOrderId = vi
      .fn()
      .mockReturnValue([{ side: "buy", price: 0.5, size: 9.97, liquidityRole: "maker" }]);
    const gateway = createGateway({
      openOrders: [],
      exactResult: {
        ok: true,
        data: makeExchangeOrder({
          orderId: "ex-mature",
          status: "CANCELLED",
          sizeFilled: 9.97,
        }),
      },
    });

    await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      fillRepo,
      suspiciousEmptyThreshold: 0,
      consecutiveMissThreshold: 1,
      fillCompletionTolerance: 0,
    });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      order.orderId,
      "cancelled",
      undefined,
      "exchange-exact-cancelled",
      {
        cancelAgeMs: 100_000,
        cancelAgeBucket: "1-10min",
        fillProgressShares: 9.97,
        marketHorizon: null,
      },
    );
  });

  it("reports unresolved evidence only after the consecutive-miss threshold", async () => {
    const orderRepo = createOrderRepo();
    const order = makeLocalOrder({ exchangeOrderId: "ex-miss" });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    const gateway = createGateway({ openOrders: [], exactResult: { ok: true, data: null } });
    const missMap = new Map<string, number>();

    const deps = {
      ...baseDeps(gateway, orderRepo),
      consecutiveMissThreshold: 3,
      consecutiveMissCounts: missMap,
    };

    const r1 = await reconcileOrders(deps);
    expect(r1.phantomsCancelled).toBe(0);
    expect(r1.consecutiveMissTracked).toBe(1);
    expect(missMap.get("ex-miss")).toBe(1);

    const r2 = await reconcileOrders(deps);
    expect(r2.phantomsCancelled).toBe(0);
    expect(missMap.get("ex-miss")).toBe(2);
    expect(gateway.getOrderResult).not.toHaveBeenCalled();

    const r3 = await reconcileOrders(deps);
    expect(r3.phantomsCancelled).toBe(0);
    expect(r3.unresolvedMissingOnExchange).toBe(1);
    expect(missMap.get("ex-miss")).toBe(3);
    expect(gateway.getOrderResult).toHaveBeenCalledExactlyOnceWith("ex-miss");
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();

    const r4 = await reconcileOrders(deps);
    expect(r4.phantomsCancelled).toBe(0);
    expect(r4.unresolvedMissingOnExchange).toBe(1);
    expect(missMap.get("ex-miss")).toBe(4);
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("resets the counter when the order reappears in the snapshot", async () => {
    const orderRepo = createOrderRepo();
    const order = makeLocalOrder({ exchangeOrderId: "ex-flap" });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    const missMap = new Map<string, number>();
    const deps = {
      ...baseDeps(createGateway({ openOrders: [] }), orderRepo),
      consecutiveMissThreshold: 3,
      consecutiveMissCounts: missMap,
    };

    // miss
    await reconcileOrders({ ...deps, gateway: createGateway({ openOrders: [] }) });
    expect(missMap.get("ex-flap")).toBe(1);

    // present → reset
    await reconcileOrders({
      ...deps,
      gateway: createGateway({ openOrders: [makeExchangeOrder({ orderId: "ex-flap" })] }),
    });
    expect(missMap.has("ex-flap")).toBe(false);

    // miss again → back to 1, not 2
    await reconcileOrders({ ...deps, gateway: createGateway({ openOrders: [] }) });
    expect(missMap.get("ex-flap")).toBe(1);
  });

  it("tracks multiple orders independently", async () => {
    const orderRepo = createOrderRepo();
    orderRepo.findOpen = vi
      .fn()
      .mockReturnValue([
        makeLocalOrder({ orderId: createOrderId("a"), exchangeOrderId: "ex-a" }),
        makeLocalOrder({ orderId: createOrderId("b"), exchangeOrderId: "ex-b" }),
      ]);
    const missMap = new Map<string, number>();
    const deps = {
      ...baseDeps(createGateway({ openOrders: [] }), orderRepo),
      consecutiveMissThreshold: 3,
      consecutiveMissCounts: missMap,
    };

    await reconcileOrders(deps);
    expect(missMap.get("ex-a")).toBe(1);
    expect(missMap.get("ex-b")).toBe(1);
  });

  it("garbage-collects map keys for orders no longer open (no leak)", async () => {
    const orderRepo = createOrderRepo();
    const missMap = new Map<string, number>([["ex-stale-key", 2]]);
    orderRepo.findOpen = vi.fn().mockReturnValue([]); // ex-stale-key gone from open set
    const gateway = createGateway({ openOrders: [] });

    await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      consecutiveMissThreshold: 3,
      consecutiveMissCounts: missMap,
    });

    expect(missMap.has("ex-stale-key")).toBe(false);
  });

  it("threshold 1 reports unresolved evidence on the first miss without terminalizing", async () => {
    const orderRepo = createOrderRepo();
    orderRepo.findOpen = vi.fn().mockReturnValue([makeLocalOrder({ exchangeOrderId: "ex-1pass" })]);
    const gateway = createGateway({ openOrders: [] });

    const result = await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      consecutiveMissThreshold: 1,
      consecutiveMissCounts: new Map(),
    });

    expect(result.phantomsCancelled).toBe(0);
    expect(result.unresolvedMissingOnExchange).toBe(1);
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });
});

describe("reconcileStaleExchangeOrders — Fix 5: cascade guard", () => {
  function staleSetup() {
    const orderRepo = createOrderRepo();
    const cancelledLocal = makeLocalOrder({ exchangeOrderId: "ex-stale", status: "cancelled" });
    orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
    orderRepo.findById = vi.fn().mockReturnValue(cancelledLocal);
    const gateway = createGateway({
      cancelSuccess: true,
      exactResult: {
        ok: true,
        data: makeExchangeOrder({
          orderId: "ex-stale",
          status: "CANCELLED",
          sizeFilled: 0,
        }),
      },
    });
    return { orderRepo, gateway, candidate: makeExchangeOrder({ orderId: "ex-stale" }) };
  }

  it("counts a reliable cancel only after exact covered terminal proof", async () => {
    const { orderRepo, gateway, candidate } = staleSetup();
    vi.mocked(gateway.getOrderResult!).mockReset();
    vi.mocked(gateway.getOrderResult!)
      .mockResolvedValueOnce({
        ok: true,
        data: makeExchangeOrder({ orderId: "ex-stale", status: "OPEN" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        data: makeExchangeOrder({ orderId: "ex-stale", status: "CANCELLED", sizeFilled: 0 }),
      });

    const result = await reconcileStaleExchangeOrders({
      exchangeOrders: [candidate],
      localExchangeIds: new Set(),
      orderRepo,
      gateway,
      log: silentLog,
      snapshotReliable: true,
    });

    expect(result.cascadeEvaluated).toBe(1);
    expect(result.cascadeCancelled).toBe(1);
    expect(result.staleCancelled).toBe(1);
    expect(gateway.cancelOrder).toHaveBeenCalledWith({ orderId: "ex-stale" });
    expect(gateway.getOrderResult).toHaveBeenCalledTimes(2);
  });

  it("retains cancel-acknowledged stale rows without exact covered terminal proof", async () => {
    const cases: Array<{
      label: string;
      exactResult: FetchResult<ExchangeOrder | null>;
    }> = [
      {
        label: "still open",
        exactResult: {
          ok: true,
          data: makeExchangeOrder({ orderId: "ex-stale", status: "OPEN" }),
        },
      },
      { label: "not found", exactResult: { ok: true, data: null } },
      {
        label: "unreliable",
        exactResult: { ok: false, reason: "server", attempts: 4 },
      },
      {
        label: "fill coverage gap",
        exactResult: {
          ok: true,
          data: makeExchangeOrder({
            orderId: "ex-stale",
            status: "CANCELLED",
            sizeFilled: 1,
          }),
        },
      },
    ];

    for (const { label, exactResult } of cases) {
      const orderRepo = createOrderRepo();
      const cancelledLocal = makeLocalOrder({
        exchangeOrderId: "ex-stale",
        status: "cancelled",
      });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
      orderRepo.findById = vi.fn().mockReturnValue(cancelledLocal);
      const candidate = makeExchangeOrder({ orderId: "ex-stale", side: "sell" });
      const gateway = createGateway({
        openOrders: [candidate],
        cancelSuccess: true,
        exactResult,
      });

      const result = await reconcileOrders(baseDeps(gateway, orderRepo));

      expect(result.exchangeOpenOrders, label).toEqual([candidate]);
      expect(result.staleCancelled, label).toBe(0);
      expect(result.cascadeCancelled, label).toBe(0);
      expect(gateway.cancelOrder, label).toHaveBeenCalledWith({ orderId: "ex-stale" });
      expect(gateway.getOrderResult, label).toHaveBeenCalledWith("ex-stale");
    }
  });

  it.each([
    { localStatus: "cancelled" as const, exactStatus: "CANCELLED" as const, fillSize: 0 },
    { localStatus: "filled" as const, exactStatus: "FILLED" as const, fillSize: 10 },
  ])(
    "excludes a local $localStatus ghost before cancel when exact status is $exactStatus",
    async ({ localStatus, exactStatus, fillSize }) => {
      const orderRepo = createOrderRepo();
      const local = makeLocalOrder({ exchangeOrderId: "ex-stale", status: localStatus });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(local);
      orderRepo.findById = vi.fn().mockReturnValue(local);
      const fillRepo = createFillRepo();
      const warn = vi.fn();
      const log = { ...(silentLog as unknown as object), warn } as never;
      fillRepo.findByOrderId = vi.fn().mockReturnValue(
        fillSize === 0
          ? []
          : [
              {
                fillId: createFillId("fill-stale-covered"),
                orderId: local.orderId,
                tokenId: local.tokenId,
                conditionId: local.conditionId,
                side: "buy",
                price: 0.5,
                size: fillSize,
                sizeUsdc: fillSize * 0.5,
                liquidityRole: "maker",
                fee: 0,
                feeRateBps: 0,
                filledAt: OLD,
              },
            ],
      );
      const gateway = createGateway({
        openOrders: [makeExchangeOrder({ orderId: "ex-stale", side: "sell" })],
        cancelSuccess: true,
        exactResult: {
          ok: true,
          data: makeExchangeOrder({
            orderId: "ex-stale",
            status: exactStatus,
            sizeFilled: fillSize,
          }),
        },
      });

      const first = await reconcileOrders({ ...baseDeps(gateway, orderRepo), fillRepo, log });
      const second = await reconcileOrders({ ...baseDeps(gateway, orderRepo), fillRepo, log });

      for (const result of [first, second]) {
        expect(result.exchangeOpenOrders).toEqual([]);
        expect(result.staleCancelled).toBe(0);
        expect(result.staleCancelFailed).toBe(0);
        expect(result.cascadeEvaluated).toBe(0);
        expect(result.cascadeCancelled).toBe(0);
      }
      expect(gateway.cancelOrder).not.toHaveBeenCalled();
      expect(gateway.getOrderResult).toHaveBeenCalledTimes(2);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("does not exact-check or cancel again after the unresolved pre-pass confirms terminal", async () => {
    const orderRepo = createOrderRepo();
    const local = makeLocalOrder({ exchangeOrderId: "ex-preconfirmed", status: "cancelled" });
    const candidate = makeExchangeOrder({ orderId: "ex-preconfirmed", side: "sell" });
    orderRepo.findOpen = vi.fn().mockReturnValue([]);
    orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(local);
    orderRepo.findById = vi.fn().mockReturnValue(local);
    const unresolved = new Map([[candidate.orderId, candidate]]);
    const gateway = createGateway({
      openOrders: [candidate],
      exactResult: {
        ok: true,
        data: makeExchangeOrder({ orderId: candidate.orderId, status: "CANCELLED" }),
      },
    });

    const result = await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      unresolvedStaleOrders: unresolved,
    });

    expect(result.exchangeOpenOrders).toEqual([]);
    expect(result.cascadeEvaluated).toBe(0);
    expect(gateway.getOrderResult).toHaveBeenCalledTimes(1);
    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(unresolved).toEqual(new Map());
  });

  it.each([
    [
      "OPEN",
      { ok: true as const, data: makeExchangeOrder({ orderId: "ex-failed", status: "OPEN" }) },
    ],
    ["null", { ok: true as const, data: null }],
    ["unreliable", { ok: false as const, reason: "server" as const, attempts: 4 }],
  ])(
    "retains and warns after failed cancel with %s exact evidence",
    async (_label, exactResult) => {
      const orderRepo = createOrderRepo();
      const local = makeLocalOrder({ exchangeOrderId: "ex-failed", status: "cancelled" });
      const candidate = makeExchangeOrder({ orderId: "ex-failed", side: "sell" });
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(local);
      orderRepo.findById = vi.fn().mockReturnValue(local);
      const unresolved = new Map<string, ExchangeOrder>();
      const warn = vi.fn();
      const log = { ...(silentLog as unknown as object), warn } as never;
      const gateway = createGateway({ openOrders: [candidate], cancelSuccess: false, exactResult });

      const result = await reconcileOrders({
        ...baseDeps(gateway, orderRepo),
        log,
        unresolvedStaleOrders: unresolved,
      });

      expect(result.exchangeOpenOrders).toEqual([candidate]);
      expect(result.staleCancelFailed).toBe(1);
      expect(result.cascadeEvaluated).toBe(1);
      expect(result.cascadeCancelled).toBe(0);
      expect(unresolved.get(candidate.orderId)).toBe(candidate);
      expect(gateway.getOrderResult).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining("cancel failed"),
      );
    },
  );

  it("excludes a stale row when exact terminal evidence wins a failed-cancel race", async () => {
    const orderRepo = createOrderRepo();
    const local = makeLocalOrder({ exchangeOrderId: "ex-race", status: "cancelled" });
    const candidate = makeExchangeOrder({ orderId: "ex-race", side: "sell" });
    orderRepo.findOpen = vi.fn().mockReturnValue([]);
    orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(local);
    orderRepo.findById = vi.fn().mockReturnValue(local);
    const warn = vi.fn();
    const log = { ...(silentLog as unknown as object), warn } as never;
    const gateway = createGateway({ openOrders: [candidate], cancelSuccess: false });
    gateway.getOrderResult = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { ...candidate, status: "OPEN" } })
      .mockResolvedValueOnce({ ok: true, data: { ...candidate, status: "CANCELLED" } });

    const result = await reconcileOrders({ ...baseDeps(gateway, orderRepo), log });

    expect(result.exchangeOpenOrders).toEqual([]);
    expect(result.staleCancelFailed).toBe(0);
    expect(result.cascadeEvaluated).toBe(result.cascadeCancelled);
    expect(warn).not.toHaveBeenCalled();
  });

  it("forwards fillCompletionTolerance=0 through stale exact coverage checks", async () => {
    const orderRepo = createOrderRepo();
    const cancelledLocal = makeLocalOrder({ exchangeOrderId: "ex-stale", status: "cancelled" });
    orderRepo.findOpen = vi.fn().mockReturnValue([]);
    orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(cancelledLocal);
    orderRepo.findById = vi.fn().mockReturnValue(cancelledLocal);
    const fillRepo = createFillRepo();
    fillRepo.findByOrderId = vi
      .fn()
      .mockReturnValue([{ side: "buy", price: 0.5, size: 9.97, liquidityRole: "maker" }]);
    const candidate = makeExchangeOrder({ orderId: "ex-stale", side: "sell" });
    const gateway = createGateway({
      openOrders: [candidate],
      cancelSuccess: true,
      exactResult: {
        ok: true,
        data: makeExchangeOrder({ orderId: "ex-stale", status: "FILLED", sizeFilled: 10 }),
      },
    });

    const result = await reconcileOrders({
      ...baseDeps(gateway, orderRepo),
      fillRepo,
      fillCompletionTolerance: 0,
    });

    expect(result.exchangeOpenOrders).toEqual([candidate]);
    expect(result.staleCancelled).toBe(0);
    expect(result.cascadeCancelled).toBe(0);
  });

  it("skips the cascade and does NOT cancel on an unreliable snapshot", async () => {
    const { orderRepo, gateway, candidate } = staleSetup();

    const result = await reconcileStaleExchangeOrders({
      exchangeOrders: [candidate],
      localExchangeIds: new Set(),
      orderRepo,
      gateway,
      log: silentLog,
      snapshotReliable: false,
    });

    expect(result.cascadeSkipped).toBe(1);
    expect(result.cascadeCancelled).toBe(0);
    expect(gateway.cancelOrder).not.toHaveBeenCalled();
  });
});

describe("exchange-absence quarantine (real ledger)", () => {
  const DAY = 24 * 60 * 60_000;
  const NOW = Date.parse("2026-09-24T00:00:00.000Z");
  const ZOMBIE = createOrderId("zombie");
  const iso = (ms: number) => new Date(ms).toISOString();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
  let conn: ReturnType<typeof bootstrapLedgerDb>;
  let orders: SqliteOrderRepository;
  let fills: SqliteFillRepository;
  let bus: InProcessEventBus;
  let cancelled: { orderId: string; reason: string }[];
  let gateway: ExchangeGateway;

  const zombie = () => orders.findById(ZOMBIE)!;
  const marker = () => readExchangeAbsence(zombie())?.firstNullAtMs ?? null;
  const seedMarker = (ms: number) =>
    orders.updateMetadata(ZOMBIE, { exchangeAbsenceV1: { firstNullAt: iso(ms) } });
  const seedFill = (id: string, ms: number) =>
    fills.save({
      fillId: createFillId(id),
      orderId: ZOMBIE,
      tokenId: TOK,
      conditionId: createConditionId("cond-1"),
      side: "sell",
      price: 0.4,
      size: 2,
      sizeUsdc: 0.8,
      liquidityRole: "maker",
      fee: 0,
      feeRateBps: 0,
      filledAt: iso(ms),
    });
  const run = (extra: Partial<OrderReconcilerDeps> = {}) =>
    reconcileOrders({
      gateway,
      orderRepo: orders,
      fillRepo: fills,
      bus,
      log,
      suspiciousEmptyThreshold: 0,
      consecutiveMissThreshold: 1,
      ...extra,
    });
  const backfilled = { historyBackfilledOrderIds: new Set([String(ZOMBIE)]) };
  const absentWarned = () =>
    log.warn.mock.calls.some(([, msg]: [unknown, string]) => msg.includes("working order absent"));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    conn = bootstrapLedgerDb(":memory:");
    orders = new SqliteOrderRepository(conn.db);
    fills = new SqliteFillRepository(conn.db);
    orders.save(
      makeLocalOrder({
        orderId: ZOMBIE,
        side: "sell",
        status: "partially-filled",
        exchangeOrderId: "zx",
        createdAt: iso(NOW - 30 * DAY),
      }),
    );
    seedFill("old-fill", NOW - 29 * DAY);
    bus = new InProcessEventBus();
    cancelled = [];
    bus.subscribe("OrderCancelled", async (event) => {
      cancelled.push({ orderId: String(event.orderId), reason: event.reason });
    });
    gateway = createGateway({ openOrders: [] });
    gateway.getOpenOrdersResult = vi.fn(async () => ({ ok: true as const, data: [] }));
    gateway.getOrderResult = vi.fn(async () => ({ ok: true as const, data: null }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearCancelIntent(String(ZOMBIE));
    conn.close();
  });

  it("starts the marker on a threshold-eligible exact null and moves the order out of drift", async () => {
    const result = await run();
    expect(marker()).toBe(NOW);
    expect(zombie().status).toBe("partially-filled");
    expect(result.unresolvedMissingOnExchange).toBe(0);
    expect(result.details).toEqual([]);
    expect(result.exchangeAbsentQuarantinedOrderIds).toEqual([String(ZOMBIE)]);
    expect(result.exchangeAbsentNextCloseAtMs).toBe(NOW + DAY);
    expect(absentWarned()).toBe(true);
  });

  it("keeps an unreliable exact read out of the marker and in drift", async () => {
    vi.mocked(gateway.getOrderResult!).mockResolvedValue({ ok: false, reason: "server" } as never);
    const result = await run();
    expect(marker()).toBeNull();
    expect(result.unresolvedMissingOnExchange).toBe(1);
    seedMarker(NOW - DAY / 2);
    await run();
    expect(marker()).toBe(NOW - DAY / 2);
  });

  it("clears the marker when the order reappears in the open snapshot", async () => {
    seedMarker(NOW - 2 * DAY);
    vi.mocked(gateway.getOpenOrdersResult!).mockResolvedValue({
      ok: true,
      data: [makeExchangeOrder({ orderId: "zx", side: "sell" })],
    });
    await run();
    expect(marker()).toBeNull();
    expect(gateway.getOrderResult).not.toHaveBeenCalled();
  });

  it("clears the marker on an exact non-null answer", async () => {
    seedMarker(NOW - 2 * DAY);
    vi.mocked(gateway.getOrderResult!).mockResolvedValue({
      ok: true,
      data: makeExchangeOrder({ orderId: "zx", side: "sell", status: "PARTIALLY_FILLED" }),
    });
    const result = await run(backfilled);
    expect(marker()).toBeNull();
    expect(zombie().status).toBe("partially-filled");
    expect(result.unresolvedMissingOnExchange).toBe(1);
  });

  it("drops a marker disproved by a fill since it started and does not terminalize", async () => {
    seedMarker(NOW - 9 * DAY);
    seedFill("late-fill", NOW - 8 * DAY);
    const result = await run(backfilled);
    expect(marker()).toBeNull();
    expect(zombie().status).toBe("partially-filled");
    expect(result.unresolvedMissingOnExchange).toBe(1);
  });

  it("waits out the 24h observation window", async () => {
    seedMarker(NOW - DAY + 1);
    const result = await run(backfilled);
    expect(zombie().status).toBe("partially-filled");
    expect(result.exchangeAbsentNextCloseAtMs).toBe(NOW + 1);
    expect(absentWarned()).toBe(false);
  });

  it("waits out 7 days without activity", async () => {
    seedMarker(NOW - 2 * DAY);
    seedFill("recent-fill", NOW - 3 * DAY);
    const result = await run(backfilled);
    expect(zombie().status).toBe("partially-filled");
    expect(result.exchangeAbsentNextCloseAtMs).toBe(NOW + 4 * DAY);
  });

  it("never terminalizes without a same-pass history backfill (catch-up path)", async () => {
    seedMarker(NOW - 2 * DAY);
    const result = await run();
    expect(zombie().status).toBe("partially-filled");
    expect(marker()).toBe(NOW - 2 * DAY);
    expect(result.exchangeAbsentQuarantinedOrderIds).toEqual([String(ZOMBIE)]);
  });

  it("cancels with the absence reason over a leftover cancel intent once every condition holds", async () => {
    seedMarker(NOW - 2 * DAY);
    registerCancelIntent(String(ZOMBIE), "stale_exit_ttl");
    const result = await run(backfilled);
    expect(zombie()).toMatchObject({
      status: "cancelled",
      cancelReason: EXCHANGE_ABSENT_CANCEL_REASON,
    });
    expect(cancelled).toEqual([{ orderId: String(ZOMBIE), reason: EXCHANGE_ABSENT_CANCEL_REASON }]);
    expect(result.exchangeAbsentQuarantinedOrderIds).toEqual([]);
  });

  it("does not start the marker for an early local-closure candidate below the miss threshold", async () => {
    conn.db
      .prepare(
        `INSERT INTO positions (position_id,token_id,condition_id,side,size,status,opened_at,closed_at)
         VALUES ('position','loser','condition','buy',0,'closed','2026-08-01T00:00:00.000Z',
         '2026-08-02T00:00:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT INTO orders (order_id,client_order_id,exchange_order_id,token_id,condition_id,
         position_id,side,order_type,price,size,size_usdc,status,bot_run_id,created_at)
         VALUES ('sell','client','exchange','loser','condition','position','sell','GTC',0.2,10,2,
         'open','run','2026-08-01T00:00:10.500Z')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT INTO market_resolutions (condition_id,resolution,resolved_at,detected_at,source,
         raw_response,status)
         VALUES ('condition','Yes','2026-08-02T00:00:00.000Z','2026-08-02T00:00:00.000Z',
         'clob-api',?,'settled')`,
      )
      .run(
        JSON.stringify({
          conditionId: "condition",
          closed: true,
          acceptingOrders: false,
          enableOrderBook: false,
          tokens: [
            { tokenId: "loser", outcome: "No", winner: false },
            { tokenId: "winner", outcome: "Yes", winner: true },
          ],
        }),
      );
    conn.db
      .prepare(
        `INSERT INTO settlement_ledger (settlement_id,condition_id,position_id,token_id,resolution,
         settlement_price,size,delta,settled_at,created_at)
         VALUES ('settlement','condition','position','loser','Yes',0,8,-0.8,
         '2026-08-02T00:00:00.000Z','2026-08-02 00:00:05')`,
      )
      .run();
    gateway.getFillsResult = vi.fn(async () => ({ ok: true as const, data: [] }));
    await run({
      consecutiveMissThreshold: 3,
      positionRepo: new SqlitePositionRepository(conn.db),
      settlementLedgerRepo: new SqliteSettlementLedgerRepository(conn.db),
      marketResolutionRepo: new SqliteMarketResolutionRepository(conn.db),
    });
    const early = orders.findById(createOrderId("sell"))!;
    expect(gateway.getOrderResult).toHaveBeenCalledWith("exchange");
    expect(early.cancelReason).toBe(RESOLVED_LOSER_LOCAL_CANCEL_REASON);
    expect(readExchangeAbsence(early)).toBeNull();
    expect(marker()).toBeNull();
  });
});
