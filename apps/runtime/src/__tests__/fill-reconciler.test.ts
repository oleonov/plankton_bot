import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOrderId, createTokenId } from "@krabs/domain";
import type {
  ExchangeFill,
  ExchangeGateway,
  FetchResult,
  FillRepository,
  OrderRepository,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  findLocalOrderForExchangeFill,
  reconcileFills,
  updateOrderStatusFromPersistedFills,
} from "../modules/reconciliation/fill-reconciler.js";

const TOK = createTokenId("tok-1");

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

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as never;

interface FillGatewayOverrides {
  fills?: ExchangeFill[];
  fillsResult?: FetchResult<ExchangeFill[]>;
}

function createGateway(o: FillGatewayOverrides = {}): ExchangeGateway {
  const gw: Record<string, unknown> = {
    getFills: vi.fn().mockResolvedValue(o.fills ?? []),
  };
  if (o.fillsResult !== undefined) {
    gw.getFillsResult = vi.fn().mockResolvedValue(o.fillsResult);
  } else if (o.fills !== undefined) {
    gw.getFillsResult = vi.fn().mockResolvedValue({ ok: true, data: o.fills });
  }
  return gw as unknown as ExchangeGateway;
}

function makeExchangeFill(overrides?: Partial<ExchangeFill>): ExchangeFill {
  return {
    fillId: "fill-1",
    orderId: "ex-ord-1",
    clientOrderId: "co-1",
    tokenId: TOK,
    side: "buy",
    price: 0.5,
    size: 10,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("reconcileFills — Fix 1.5: unreliable fills snapshot skip", () => {
  let fillRepo: FillRepository;
  let orderRepo: OrderRepository;
  let bus: InProcessEventBus;

  beforeEach(() => {
    fillRepo = createFillRepo();
    orderRepo = createOrderRepo();
    bus = new InProcessEventBus();
  });

  function deps(gateway: ExchangeGateway) {
    return { gateway, fillRepo, orderRepo, bus, log: silentLog };
  }

  it("records page attempts and isolates diagnostic errors without importing incomplete history", async () => {
    const gateway = createGateway({ fills: [] });
    gateway.getFillsResult = vi.fn(
      async (_since, onPageRead?: (ms: number, returned: boolean) => void) => {
        onPageRead?.(31, true);
        onPageRead?.(47, false);
        return { ok: false, reason: "server", attempts: 1 } as const;
      },
    );
    const writeCounter = vi.fn();
    const result = await reconcileFills({ ...deps(gateway), runtimeMetrics: { writeCounter } }, 42);
    expect(result.skipReason).toBe("unreliable_fills");
    expect(writeCounter).toHaveBeenCalledWith(
      "reconciliation_fills_page_attempt_ms",
      31,
      '{"outcome":"returned"}',
    );
    expect(writeCounter).toHaveBeenCalledWith(
      "reconciliation_fills_page_attempt_count",
      1,
      '{"outcome":"threw"}',
    );
    writeCounter.mockImplementation(() => {
      throw new Error("metrics unavailable");
    });
    expect(
      (await reconcileFills({ ...deps(gateway), runtimeMetrics: { writeCounter } }, 42)).skipReason,
    ).toBe("unreliable_fills");
    expect(fillRepo.save).not.toHaveBeenCalled();
  });

  it("skips import when getFillsResult is ok:false (no terminal status writes)", async () => {
    const gateway = createGateway({
      fillsResult: { ok: false, reason: "rate_limit", attempts: 4 },
    });

    const result = await reconcileFills(deps(gateway), 0);

    expect(result.skipReason).toBe("unreliable_fills");
    expect(result.fetchReason).toBe("rate_limit");
    expect(result.fetchAttempts).toBe(4);
    expect(result.missingFillsImported).toBe(0);
    expect(fillRepo.save).not.toHaveBeenCalled();
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("treats a successful empty array as ok (not a failure)", async () => {
    const gateway = createGateway({ fills: [] });

    const result = await reconcileFills(deps(gateway), 0);

    expect(result.skipReason).toBeUndefined();
    expect(result.exchangeFillCount).toBe(0);
    expect(result.missingFillsImported).toBe(0);
  });

  it("imports normally on a reliable non-empty snapshot", async () => {
    const localOrder = {
      orderId: createOrderId("ord-1"),
      conditionId: "cond-1",
      signalId: null,
      signalReason: null,
      size: 10,
    };
    orderRepo.findByClientOrderId = vi.fn().mockReturnValue(localOrder);
    orderRepo.findById = vi.fn().mockReturnValue(localOrder);
    fillRepo.findByOrderId = vi.fn().mockReturnValue([{ side: "buy", size: 10, price: 0.5 }]);
    const gateway = createGateway({ fills: [makeExchangeFill({ size: 10 })] });

    const result = await reconcileFills(deps(gateway), 0);

    expect(result.skipReason).toBeUndefined();
    expect(result.exchangeFillCount).toBe(1);
    expect(result.missingFillsImported).toBe(1);
  });

  it("falls back to legacy getFills when the Result method is absent", async () => {
    const gw = { getFills: vi.fn().mockResolvedValue([]) } as unknown as ExchangeGateway;

    const result = await reconcileFills(deps(gw), 0);

    expect(result.skipReason).toBeUndefined();
    expect(gw.getFills).toHaveBeenCalledTimes(1);
  });
});

describe("updateOrderStatusFromPersistedFills — Fix 4: completion tolerance", () => {
  let fillRepo: FillRepository;
  let orderRepo: OrderRepository;

  beforeEach(() => {
    fillRepo = createFillRepo();
    orderRepo = createOrderRepo();
  });

  function setup(orderSize: number, fills: Array<Record<string, unknown>>) {
    const oid = createOrderId("ord-x");
    orderRepo.findById = vi.fn().mockReturnValue({ orderId: oid, size: orderSize });
    fillRepo.findByOrderId = vi.fn().mockReturnValue(fills);
    return oid;
  }

  it("marks filled when maker-buy shares fall 0.04% short (within 0.5% tolerance)", () => {
    const oid = setup(22.7297, [{ side: "buy", liquidityRole: "maker", size: 22.72, price: 0.5 }]);

    updateOrderStatusFromPersistedFills(orderRepo, fillRepo, oid, 0.005);

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(oid, "filled");
  });

  it("marks partially-filled at 50% of size", () => {
    const oid = setup(10, [{ side: "buy", liquidityRole: "maker", size: 5, price: 0.5 }]);

    updateOrderStatusFromPersistedFills(orderRepo, fillRepo, oid, 0.005);

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(oid, "partially-filled");
  });

  it("preserves taker-buy gross-recovery: net 9.95 with sizeUsdc 5 → filled", () => {
    const oid = setup(10, [
      { side: "buy", liquidityRole: "taker", size: 9.95, price: 0.5, sizeUsdc: 5 },
    ]);

    updateOrderStatusFromPersistedFills(orderRepo, fillRepo, oid, 0.005);

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(oid, "filled");
  });

  it("marks partially-filled at the 0.6% gap boundary (tolerance 0.5%)", () => {
    const oid = setup(100, [{ side: "buy", liquidityRole: "maker", size: 99.4, price: 0.5 }]);

    updateOrderStatusFromPersistedFills(orderRepo, fillRepo, oid, 0.005);

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(oid, "partially-filled");
  });

  it("tolerance 0 restores legacy 1e-9 behavior (0.04% short → partially-filled)", () => {
    const oid = setup(22.7297, [{ side: "buy", liquidityRole: "maker", size: 22.72, price: 0.5 }]);

    updateOrderStatusFromPersistedFills(orderRepo, fillRepo, oid, 0);

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(oid, "partially-filled");
  });
});

describe("findLocalOrderForExchangeFill — exact identity", () => {
  it("uses the exact exchange ID before a nullable or conflicting client ID", () => {
    const orderRepo = createOrderRepo();
    const exact = { orderId: createOrderId("exact") };
    const clientMatch = { orderId: createOrderId("client") };
    orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(exact);
    orderRepo.findByClientOrderId = vi.fn().mockReturnValue(clientMatch);

    expect(
      findLocalOrderForExchangeFill(
        orderRepo,
        makeExchangeFill({ clientOrderId: null }),
        silentLog,
      ),
    ).toBe(exact);
    expect(orderRepo.findByClientOrderId).not.toHaveBeenCalled();

    expect(
      findLocalOrderForExchangeFill(
        orderRepo,
        makeExchangeFill({ clientOrderId: "foreign-client" }),
        silentLog,
      ),
    ).toBe(exact);
    expect(orderRepo.findByClientOrderId).not.toHaveBeenCalled();
  });
});
