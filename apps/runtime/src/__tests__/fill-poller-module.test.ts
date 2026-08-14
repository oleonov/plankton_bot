import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FillPollerModule } from "../modules/fill-poller/fill-poller-module.js";
import { InProcessEventBus } from "@krabs/event-bus";
import { createConditionId, createOrderId, createTokenId } from "@krabs/domain";
import type {
  ExchangeGateway,
  ExchangeFill,
  FillRepository,
  OrderRepository,
  TokenId,
  ExchangeOrder,
  ExchangeBalance,
  PlaceOrderParams,
  CancelOrderParams,
  PlaceOrderResult,
  CancelOrderResult,
} from "@krabs/domain";

function createMockGateway(): ExchangeGateway {
  return {
    placeOrder: vi
      .fn<(p: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValue({ success: true }),
    cancelOrder: vi
      .fn<(p: CancelOrderParams) => Promise<CancelOrderResult>>()
      .mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ success: true }),
    getOpenOrders: vi.fn<() => Promise<ExchangeOrder[]>>().mockResolvedValue([]),
    getOpenOrdersForToken: vi.fn<(t: TokenId) => Promise<ExchangeOrder[]>>().mockResolvedValue([]),
    getFills: vi.fn<(sinceMs: number) => Promise<ExchangeFill[]>>().mockResolvedValue([]),
    getBalances: vi.fn<() => Promise<ExchangeBalance[]>>().mockResolvedValue([]),
    getPositionBalance: vi.fn<(t: TokenId) => Promise<number>>().mockResolvedValue(0),
    getOutcomeTokenBalance: vi.fn<(t: TokenId) => Promise<bigint>>().mockResolvedValue(0n),
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

function createMockOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue({ orderId: createOrderId("ord-1"), size: 10 }),
    findByClientOrderId: vi.fn().mockReturnValue({
      orderId: createOrderId("ord-1"),
      size: 10,
    }),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
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

describe("FillPollerModule", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let fillRepo: ReturnType<typeof createMockFillRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let bus: InProcessEventBus;
  let mod: FillPollerModule;

  beforeEach(() => {
    vi.useFakeTimers();
    gateway = createMockGateway();
    fillRepo = createMockFillRepo();
    orderRepo = createMockOrderRepo();
    bus = new InProcessEventBus();
    mod = new FillPollerModule({
      gateway,
      fillRepo,
      orderRepo,
      bus,
      log: silentLog,
      pollIntervalMs: 5000,
      overlapMs: 5000,
    });
  });

  afterEach(async () => {
    await mod.stop();
    vi.useRealTimers();
  });

  it("seeds watermark from latest fill timestamp on start", async () => {
    (fillRepo.getLatestTimestamp as any).mockReturnValue(1710000000000);
    await mod.start();
    // First poll should use watermark - overlap
    await vi.advanceTimersByTimeAsync(5000);
    expect(gateway.getFills).toHaveBeenCalledWith(1710000000000 - 5000);
  });

  it("falls back to Date.now() when no fills exist", async () => {
    const now = Date.now();
    await mod.start();
    await vi.advanceTimersByTimeAsync(5000);
    const calledWith = (gateway.getFills as any).mock.calls[0][0];
    // Should be roughly now - overlap (± a few ms)
    expect(calledWith).toBeGreaterThanOrEqual(now - 5000 - 100);
    expect(calledWith).toBeLessThanOrEqual(now);
  });

  it("imports fills and advances watermark", async () => {
    const fillTs = Date.now() + 10000;
    const fill: ExchangeFill = {
      fillId: "fill-new",
      orderId: "ord-1",
      clientOrderId: "co-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      price: 0.5,
      size: 10,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      timestamp: fillTs,
    };
    (gateway.getFills as any).mockResolvedValue([fill]);
    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 10 }]);

    const received: any[] = [];
    bus.subscribe("FillReceived", async (p) => {
      received.push(p);
    });

    await mod.start();
    await mod.poll();

    expect(received).toHaveLength(1);
    expect(fillRepo.save).toHaveBeenCalledTimes(1);
  });

  it("retries a deferred exact pending fill after OrderPlaced makes the row open", async () => {
    const fillTs = Date.now() + 10_000;
    const fill: ExchangeFill = {
      fillId: "fill-pre-ack",
      orderId: "exchange-1",
      clientOrderId: "co-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      price: 0.5,
      size: 10,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      timestamp: fillTs,
    };
    let localOrder: any = {
      orderId: createOrderId("ord-1"),
      exchangeOrderId: "exchange-1",
      status: "pending",
      conditionId: createConditionId("cond-1"),
      signalId: null,
      signalReason: null,
      decisionRuleId: null,
      signalTimestamp: null,
      size: 10,
    };
    (orderRepo.findByClientOrderId as any).mockImplementation(() => localOrder);
    (orderRepo.findById as any).mockImplementation(() => localOrder);
    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 10 }]);
    (gateway.getFills as any).mockResolvedValue([fill]);
    const received: unknown[] = [];
    bus.subscribe("FillReceived", async (event) => {
      received.push(event);
    });

    await mod.start();
    await mod.poll();

    expect(fillRepo.save).not.toHaveBeenCalled();
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    expect(received).toEqual([]);

    localOrder = { ...localOrder, status: "open" };
    await mod.poll();

    expect(gateway.getFills).toHaveBeenLastCalledWith(fillTs - 5000);
    expect(fillRepo.save).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
  });

  it("reports imported fill counts to the optional observer", async () => {
    const onImportObserved = vi.fn();
    mod = new FillPollerModule({
      gateway,
      fillRepo,
      orderRepo,
      bus,
      log: silentLog,
      pollIntervalMs: 5000,
      overlapMs: 5000,
      onImportObserved,
    });

    const fill: ExchangeFill = {
      fillId: "fill-observed",
      orderId: "ord-1",
      clientOrderId: "co-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      price: 0.5,
      size: 10,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      timestamp: Date.now(),
    };
    (gateway.getFills as any).mockResolvedValue([fill]);
    (fillRepo.findByOrderId as any).mockReturnValue([{ size: 10 }]);

    await mod.start();
    await mod.poll();

    expect(onImportObserved).toHaveBeenCalledWith(
      expect.objectContaining({
        imported: 1,
        skipped: 0,
      }),
    );
  });

  it("skips poll when already polling (re-entrancy guard)", async () => {
    // Make getFills hang
    let resolveGetFills: () => void;
    (gateway.getFills as any).mockReturnValue(
      new Promise<ExchangeFill[]>((r) => {
        resolveGetFills = () => r([]);
      }),
    );

    await mod.start();
    const poll1 = mod.poll();
    const poll2 = mod.poll(); // Should skip

    resolveGetFills!();
    await poll1;
    await poll2;

    expect(gateway.getFills).toHaveBeenCalledTimes(1);
  });

  it("healthCheck reports ok after start", async () => {
    await mod.start();
    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
  });

  // ─── Fill-completion tolerance propagation (#36) ───────────────────────

  function nearCompleteFill(): ExchangeFill {
    return {
      fillId: "fill-near-complete",
      orderId: "ord-1",
      clientOrderId: "co-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      price: 0.5,
      size: 9.97,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      timestamp: Date.now(),
    };
  }

  // 9.97 of 10 shares is 0.3% short — inside the default 0.5% band (→ filled)
  // but outside the 1e-9 floor that env=0 collapses to (→ partially-filled).
  it("forwards fillCompletionTolerance=0 → near-complete fill stays partially-filled", async () => {
    mod = new FillPollerModule({
      gateway,
      fillRepo,
      orderRepo,
      bus,
      log: silentLog,
      pollIntervalMs: 5000,
      overlapMs: 5000,
      fillCompletionTolerance: 0,
    });
    (gateway.getFills as any).mockResolvedValue([nearCompleteFill()]);
    (orderRepo.findById as any).mockReturnValue({ orderId: createOrderId("ord-1"), size: 10 });
    (fillRepo.findByOrderId as any).mockReturnValue([
      { side: "buy", price: 0.5, size: 9.97, liquidityRole: "unknown" },
    ]);

    await mod.start();
    await mod.poll();

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("ord-1"), "partially-filled");
  });

  it("defaults to 0.5% tolerance when none supplied → near-complete fill is filled", async () => {
    (gateway.getFills as any).mockResolvedValue([nearCompleteFill()]);
    (orderRepo.findById as any).mockReturnValue({ orderId: createOrderId("ord-1"), size: 10 });
    (fillRepo.findByOrderId as any).mockReturnValue([
      { side: "buy", price: 0.5, size: 9.97, liquidityRole: "unknown" },
    ]);

    await mod.start();
    await mod.poll();

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(createOrderId("ord-1"), "filled");
  });
});
