import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FillPollerModule } from "../modules/fill-poller/fill-poller-module.js";
import { InProcessEventBus } from "@plankton/event-bus";
import { createOrderId, createTokenId, createFamilyId } from "@plankton/domain";
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
} from "@plankton/domain";

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
      familyId: createFamilyId("fam-1"),
      size: 10,
    }),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
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
});
