import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createOrderId, createConditionId } from "@krabs/domain";
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
} from "../modules/reconciliation/order-reconciler.js";

const TOK = createTokenId("tok-yes");
const OLD = new Date(Date.now() - 300_000).toISOString(); // 5 min ago — beyond any grace

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
  it("reports unresolved evidence only after the consecutive-miss threshold", async () => {
    const orderRepo = createOrderRepo();
    const order = makeLocalOrder({ exchangeOrderId: "ex-miss" });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    const gateway = createGateway({ openOrders: [] });
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

    const r3 = await reconcileOrders(deps);
    expect(r3.phantomsCancelled).toBe(0);
    expect(r3.unresolvedMissingOnExchange).toBe(1);
    expect(missMap.get("ex-miss")).toBe(3);
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
    const gateway = createGateway({ cancelSuccess: true });
    return { orderRepo, gateway, candidate: makeExchangeOrder({ orderId: "ex-stale" }) };
  }

  it("executes a real cancel on a reliable snapshot", async () => {
    const { orderRepo, gateway, candidate } = staleSetup();

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
