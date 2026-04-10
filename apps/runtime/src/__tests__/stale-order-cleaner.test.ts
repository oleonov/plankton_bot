import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createFamilyId, createOrderId } from "@plankton/domain";
import type {
  OrderRepository,
  MarketRepository,
  Market,
  Order,
  ClientOrderId,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  cleanStaleEntryOrders,
  CANCEL_BACKOFF_MS,
  PROBE_LIKE_INTRADAY_TTL_MS,
} from "../modules/reconciliation/stale-order-cleaner.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const TOK = createTokenId("tok-yes");
const FAM = createFamilyId("fam-1");

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

function createMockMarketRepo(): MarketRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(null),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findByFamily: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
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

function makeOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "plk_abc" as ClientOrderId,
    tokenId: TOK,
    familyId: FAM,
    side: "buy",
    orderType: "GTC",
    price: 0.3,
    size: 10,
    sizeUsdc: 3,
    status: "open",
    exchangeOrderId: "ex-1",
    signalId: null,
    signalReason: "probe-entry",
    botRunId: "run-1" as any,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMarket(overrides?: Partial<Market>): Market {
  return {
    tokenId: TOK,
    conditionId: "cond-1",
    slug: "test-market",
    eventSlug: null,
    question: "Test?",
    outcome: "YES",
    familyId: FAM,
    familyKey: "test",
    regime: "threshold",
    horizon: "daily",
    endDate: null,
    active: true,
    tickSize: 0.01,
    negRisk: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("cleanStaleEntryOrders", () => {
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let bus: InProcessEventBus;
  let backoffMap: Map<string, number>;

  beforeEach(() => {
    orderRepo = createMockOrderRepo();
    marketRepo = createMockMarketRepo();
    bus = new InProcessEventBus();
    backoffMap = new Map();
  });

  function run() {
    return cleanStaleEntryOrders({ orderRepo, marketRepo, bus, log: silentLog }, backoffMap);
  }

  // ─── TTL cancellation ──────────────────────────────────────────────

  it("cancels old open buy entry order exceeding TTL", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(1);
    expect(result.staleEndDateCancelled).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_ttl");
    expect(cancelled[0].command.orderId).toBe(order.orderId);
    expect(cancelled[0].command.familyId).toBe(order.familyId);
  });

  it("does not cancel fresh open buy entry order within TTL", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: twoMinutesAgo,
      signalReason: "spray-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(0);
    expect(result.staleEndDateCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("cancels stale intraday probe orders on a short leash", async () => {
    const sixMinutesAgo = new Date(Date.now() - PROBE_LIKE_INTRADAY_TTL_MS - 60_000).toISOString();
    const order = makeOrder({
      createdAt: sixMinutesAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ horizon: "intraday-4h" }));

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_ttl");
  });

  it("does not cancel fresh intraday probe orders before the short TTL", async () => {
    const thirtySecondsAgo = new Date(Date.now() - 30_000).toISOString();
    const order = makeOrder({
      createdAt: thirtySecondsAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ horizon: "intraday-4h" }));

    const result = await run();

    expect(result.staleTtlCancelled).toBe(0);
  });

  it("uses horizon TTL for conviction entries on intraday markets", async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: tenMinutesAgo,
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ horizon: "intraday-4h" }));

    const result = await run();

    expect(result.staleTtlCancelled).toBe(0);
  });

  // ─── Side filtering ────────────────────────────────────────────────

  it("does not cancel open sell orders", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      side: "sell",
      createdAt: sevenHoursAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  // ─── Signal reason filtering ───────────────────────────────────────

  it("does not cancel buy orders with non-entry signal reason", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "repricing-exit",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(0);
  });

  it("does not cancel buy orders with null signal reason", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: null,
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const result = await run();

    expect(result.staleTtlCancelled).toBe(0);
  });

  // ─── endDate proximity ─────────────────────────────────────────────

  it("cancels order near market endDate", async () => {
    const thirtyMinFromNow = new Date(Date.now() + 30 * 60_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: oneHourAgo,
      signalReason: "confirm-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ endDate: thirtyMinFromNow }));

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    expect(result.staleEndDateCancelled).toBe(1);
    expect(result.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_enddate");
  });

  it("does not cancel order when endDate is far away", async () => {
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: oneHourAgo,
      signalReason: "scale-in",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ endDate: twoHoursFromNow }));

    const result = await run();

    expect(result.staleEndDateCancelled).toBe(0);
    expect(result.staleTtlCancelled).toBe(0);
  });

  it("does not cancel order when market has no endDate", async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: oneHourAgo,
      signalReason: "heavy-scale",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ endDate: null }));

    const result = await run();

    expect(result.staleEndDateCancelled).toBe(0);
  });

  // ─── Anti-churn backoff ────────────────────────────────────────────

  it("does not re-cancel within backoff window", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    // First pass — should cancel
    const r1 = await run();
    expect(r1.staleTtlCancelled).toBe(1);

    // Second pass — within backoff, should skip
    const r2 = await run();
    await bus.drain();

    expect(r2.staleTtlCancelled).toBe(0);
    expect(cancelled).toHaveLength(1); // only the first cancel
  });

  it("re-cancels after backoff expires", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);

    // First pass
    await run();

    // Simulate backoff expiry
    const ordKey = String(order.orderId);
    backoffMap.set(ordKey, Date.now() - CANCEL_BACKOFF_MS - 1);

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    // Second pass — backoff expired, should re-cancel
    const r2 = await run();
    await bus.drain();

    expect(r2.staleTtlCancelled).toBe(1);
    expect(cancelled).toHaveLength(1);
  });

  // ─── Backoff map eviction ──────────────────────────────────────────

  it("evicts backoff entries for orders no longer open", async () => {
    const ordKey = String(createOrderId("ord-gone"));
    backoffMap.set(ordKey, Date.now());

    // No open orders — the entry should be evicted
    orderRepo.findOpen = vi.fn().mockReturnValue([]);

    await run();

    expect(backoffMap.has(ordKey)).toBe(false);
  });

  // ─── TTL takes priority over endDate ───────────────────────────────

  it("TTL cancel short-circuits before endDate check", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const thirtyMinFromNow = new Date(Date.now() + 30 * 60_000).toISOString();
    const order = makeOrder({
      createdAt: sevenHoursAgo,
      signalReason: "spray-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([order]);
    marketRepo.findByTokenId = vi.fn().mockReturnValue(makeMarket({ endDate: thirtyMinFromNow }));

    const cancelled: any[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelled.push(p);
    });

    const result = await run();
    await bus.drain();

    // Should be counted as TTL, not endDate
    expect(result.staleTtlCancelled).toBe(1);
    expect(result.staleEndDateCancelled).toBe(0);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0].command.reason).toBe("stale_entry_ttl");
  });

  // ─── Multiple entry reasons ────────────────────────────────────────

  it("handles all entry signal reasons", async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60_000).toISOString();
    const reasons = ["probe-entry", "spray-entry", "confirm-scale", "scale-in", "heavy-scale"];
    const orders = reasons.map((r, i) =>
      makeOrder({
        orderId: createOrderId(`ord-${i}`),
        createdAt: sevenHoursAgo,
        signalReason: r,
      }),
    );
    orderRepo.findOpen = vi.fn().mockReturnValue(orders);

    const result = await run();

    expect(result.staleTtlCancelled).toBe(reasons.length);
  });
});
