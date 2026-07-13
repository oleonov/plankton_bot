/**
 * Focused unit tests for Phase 1 tick-correction + price re-snap behavior in
 * ExecutionModule (plan Phase 1, Fix 1).
 *
 * Three scenarios per spec:
 *  1. Stale tick (0.001) + authTick (0.01) → re-snapped price (BUY floor = 0.15)
 *     used with corrected tick; DB write triggered.
 *  2. Re-snap returns invalid → safe fallback: gateway receives the ORIGINAL
 *     tick/price (not authTick + bad price); no DB write.
 *  3. Legit 0.001 market (authTick === cmd.tickSize) → no re-snap, no DB write,
 *     gateway receives original values unchanged.
 *
 * We mock `resnapPriceToTick` in scenario 2 because the real implementation
 * always returns `valid: true` for finite in-range prices (clampExecutablePrice
 * guarantees a valid grid-aligned result). The mock simulates a defensive edge
 * case the production code guards against.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// vi.mock is hoisted before imports. We wrap the real resnapPriceToTick in a vi.fn()
// so individual tests can override it with mockReturnValueOnce while all other tests
// still exercise the real implementation.
vi.mock("../executable-price.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../executable-price.js")>();
  return {
    ...actual,
    resnapPriceToTick: vi.fn().mockImplementation(actual.resnapPriceToTick),
  };
});

import { createTokenId, createCommandId, createConditionId, createBotRunId } from "@krabs/domain";
import type { PlaceOrderCommand, ClientOrderId } from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { resnapPriceToTick } from "../executable-price.js";

// ─── Shared stubs ────────────────────────────────────────────────────────────

const BOT_RUN_ID = createBotRunId("test-tick-correction");

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

function makeGateway() {
  return {
    placeOrder: vi.fn().mockResolvedValue({ success: true, orderId: "ord-1" }),
    cancelOrder: vi.fn().mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ success: true }),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
    getFills: vi.fn().mockResolvedValue([]),
    getBalances: vi.fn().mockResolvedValue([]),
    getPositionBalance: vi.fn().mockResolvedValue(0),
    getOutcomeTokenBalance: vi.fn().mockResolvedValue(0n),
    redeemPositions: vi
      .fn()
      .mockResolvedValue({ status: "skipped", conditionIds: [], txHash: null, gasUsed: null }),
    mergePositions: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  };
}

function makeMarketRepo() {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue({ active: true }),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    upsertAll: vi.fn(),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    updateScoresBatch: vi.fn(),
    updateTickSize: vi.fn(),
  };
}

function makeOrderRepo() {
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

function makeFillRepo() {
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

function makeTickResolver(tick: number) {
  return { resolve: vi.fn().mockResolvedValue(tick), invalidate: vi.fn() };
}

function makeCmd(overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId("cmd-tc-1"),
    clientOrderId: "plk_tc_test" as ClientOrderId,
    source: "strategy",
    tokenId: createTokenId("tok-yes"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    size: 10,
    price: 0.155,
    orderType: "GTC",
    tickSize: 0.001,
    negRisk: false,
    sequenceInTick: 0,
    signalReason: null,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExecutionModule — proactive tick correction + price re-snap (Phase 1 Fix 1)", () => {
  let gateway: ReturnType<typeof makeGateway>;
  let bus: InProcessEventBus;
  let marketRepo: ReturnType<typeof makeMarketRepo>;
  let orderRepo: ReturnType<typeof makeOrderRepo>;
  let fillRepo: ReturnType<typeof makeFillRepo>;

  beforeEach(() => {
    gateway = makeGateway();
    bus = new InProcessEventBus();
    marketRepo = makeMarketRepo();
    orderRepo = makeOrderRepo();
    fillRepo = makeFillRepo();
    // Clear call counts between tests; the default implementation stays as the real func.
    vi.mocked(resnapPriceToTick).mockClear();
  });

  it("re-snaps price to corrected tick grid (BUY side-aware floor) and calls gateway with valid params", async () => {
    // cmd: tickSize=0.001, price=0.155 (valid on 0.001 grid, off 0.01 grid)
    // authTick=0.01 → BUY floor: floor(0.155 / 0.01) * 0.01 = 0.15
    const tickResolver = makeTickResolver(0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo: orderRepo as any,
      fillRepo: fillRepo as any,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver: tickResolver as any,
    });

    await mod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makeCmd({ price: 0.155, tickSize: 0.001, side: "buy" }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    const params = gateway.placeOrder.mock.calls[0]![0];
    // Price must be on the 0.01 grid and specifically the floor (BUY never overpays).
    expect(params.price).toBeCloseTo(0.15, 10);
    expect(params.tickSize).toBe(0.01);

    // Tick correction must be persisted to the DB.
    expect(marketRepo.updateTickSize).toHaveBeenCalledWith("cond-1", 0.01);

    await mod.stop();
  });

  it("falls back to original tick/price when re-snap returns invalid — no invalid order placed", async () => {
    // Simulate the defensive branch: resnapPriceToTick returns { valid: false } for one call.
    vi.mocked(resnapPriceToTick).mockReturnValueOnce({ price: 0, valid: false });

    const tickResolver = makeTickResolver(0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo: orderRepo as any,
      fillRepo: fillRepo as any,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver: tickResolver as any,
    });

    await mod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makeCmd({ price: 0.155, tickSize: 0.001, side: "buy" }),
      timestamp: Date.now(),
    });

    // The gateway must be called with the ORIGINAL tick/price, not authTick + invalid price=0.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    const params = gateway.placeOrder.mock.calls[0]![0];
    expect(params.price).toBeCloseTo(0.155, 10);
    expect(params.tickSize).toBe(0.001);

    // DB write must NOT happen — correction is only persisted on a successful re-snap.
    expect(marketRepo.updateTickSize).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("does not re-snap or write to DB when authTick equals cmd.tickSize (legit 0.001 market)", async () => {
    // authTick=0.001 matches cmd.tickSize=0.001 → no correction branch entered at all.
    const tickResolver = makeTickResolver(0.001);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo: orderRepo as any,
      fillRepo: fillRepo as any,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver: tickResolver as any,
    });

    await mod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makeCmd({ price: 0.155, tickSize: 0.001, side: "buy" }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    const params = gateway.placeOrder.mock.calls[0]![0];
    // Original values preserved unchanged.
    expect(params.price).toBeCloseTo(0.155, 10);
    expect(params.tickSize).toBe(0.001);

    // No re-snap, no DB write.
    expect(marketRepo.updateTickSize).not.toHaveBeenCalled();
    expect(resnapPriceToTick).not.toHaveBeenCalled();

    await mod.stop();
  });
});
