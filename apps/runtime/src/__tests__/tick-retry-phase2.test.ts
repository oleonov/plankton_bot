/**
 * Phase 2 — in-attempt retry on invalid-tick rejection.
 *
 * The `retryAfterInvalidTick` private method is exercised end-to-end via
 * the bus → executePlace path. Hard cap = 1 is verified by having the
 * retry also fail (second invalid-tick) and asserting no third placement.
 *
 * Scenarios (per plan spec):
 *  1. invalid-tick reject → invalidate → re-resolve → re-snap → retry succeeds:
 *       gateway called twice, order persisted as "open" with retry price+tick,
 *       OrderPlaced published with retry price, negRisk intact on retry call.
 *  2. retry cap: retry also rejected → order persisted as "rejected" once
 *       (with retry price), gateway called exactly twice, no third attempt.
 *  3. non-tick rejection (balance) → NOT retried → gateway called once,
 *       original reject path.
 *  4. re-snap-invalid → no retry → gateway called once, original reject path;
 *       tickResolver.invalidate IS called (invalidation happens before resnap).
 *  5. guard blocks on corrected params (post-only-cross) → no retry placement,
 *       gateway called once, original reject path.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// Wrap resnapPriceToTick in a vi.fn so scenario 4 can force invalid=true.
vi.mock("../executable-price.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../executable-price.js")>();
  return {
    ...actual,
    resnapPriceToTick: vi.fn().mockImplementation(actual.resnapPriceToTick),
  };
});

import { createTokenId, createCommandId, createConditionId, createBotRunId } from "@krabs/domain";
import type {
  PlaceOrderCommand,
  ClientOrderId,
  PlaceOrderResult,
  NormalizedMarket,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { resnapPriceToTick } from "../executable-price.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BOT_RUN_ID = createBotRunId("test-phase2-retry");
const TOKEN_ID = createTokenId("tok-yes");
const CONDITION_ID = createConditionId("cond-1");
const FRESH_EDGE_METADATA = {
  entryFreshEdgeAttribution: {
    version: 1,
    originSignalId: "sig-r23",
    originDecisionRuleId: "R23_DIP_TRIGGER",
    entryKind: "first_entry",
    shadowClass: "PLAUSIBLE_DIP",
  },
} as const;

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

/** A PlaceOrderResult that looks like an invalid-tick CLOB rejection. */
const INVALID_TICK_REJECTION: PlaceOrderResult = {
  success: false,
  errorDetails: { responseBody: { error: "invalid tick size" } },
};

/** A PlaceOrderResult that looks like a balance rejection. */
const BALANCE_REJECTION: PlaceOrderResult = {
  success: false,
  errorDetails: { responseBody: { error: "not enough balance / allowance" } },
};

function makeGateway(firstResult: PlaceOrderResult, secondResult?: PlaceOrderResult) {
  const fn = vi.fn<() => Promise<PlaceOrderResult>>().mockResolvedValueOnce(firstResult);
  if (secondResult !== undefined) fn.mockResolvedValueOnce(secondResult);
  return {
    placeOrder: fn,
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

function makePreparedGateway(
  first: import("@krabs/domain").PreparedOrderSubmitResult,
  second: import("@krabs/domain").PreparedOrderSubmitResult,
  beforeSecondSubmit?: () => void,
) {
  const gateway = makeGateway({ success: false });
  let prepared = 0;
  const submitPreparedOrder = vi.fn(async () => {
    if (submitPreparedOrder.mock.calls.length === 2) beforeSecondSubmit?.();
    return submitPreparedOrder.mock.calls.length === 1 ? first : second;
  });
  return Object.assign(gateway, {
    prepareOrder: vi.fn().mockImplementation(async () => ({
      orderId: prepared++ === 0 ? "0xold" : "0xnew",
      __preparedOrderBrand: "PreparedOrder" as const,
    })),
    submitPreparedOrder,
  });
}

function makeMarketRepo() {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue({ active: true, conditionId: CONDITION_ID }),
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

/**
 * A tickResolver mock whose resolve() returns phase1Tick on the first call
 * (used by the proactive Phase 1 correction) and retryTick on subsequent calls
 * (used by the Phase 2 retry after invalidate).
 */
function makeTickResolver(phase1Tick: number, retryTick: number) {
  return {
    resolve: vi
      .fn()
      .mockResolvedValueOnce(phase1Tick) // Phase 1 proactive check
      .mockResolvedValue(retryTick), // Phase 2 retry (and any further calls)
    invalidate: vi.fn(),
  };
}

function makeCmd(overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId("cmd-p2-1"),
    clientOrderId: "plk_p2_test" as ClientOrderId,
    source: "strategy",
    tokenId: TOKEN_ID,
    conditionId: CONDITION_ID,
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

describe("ExecutionModule — Phase 2 in-attempt invalid-tick retry", () => {
  let bus: InProcessEventBus;
  let marketRepo: ReturnType<typeof makeMarketRepo>;
  let orderRepo: ReturnType<typeof makeOrderRepo>;
  let fillRepo: ReturnType<typeof makeFillRepo>;

  beforeEach(() => {
    bus = new InProcessEventBus();
    marketRepo = makeMarketRepo();
    orderRepo = makeOrderRepo();
    fillRepo = makeFillRepo();
    vi.mocked(resnapPriceToTick).mockClear();
  });

  it("retries once with corrected tick when exchange returns invalid-tick; persists open order with retry price", async () => {
    const gateway = makeGateway(INVALID_TICK_REJECTION, {
      success: true,
      orderId: "ord-retry-1",
    });
    // Phase 1 returns same tick as cmd → no Phase 1 correction.
    // Phase 2 (after invalidate) returns 0.01 → correction.
    const tickResolver = makeTickResolver(0.001, 0.01);

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

    const placed: any[] = [];
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });
    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await mod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makeCmd({
        price: 0.155,
        tickSize: 0.001,
        side: "buy",
        negRisk: true,
        metadata: FRESH_EDGE_METADATA,
      }),
      timestamp: Date.now(),
    });

    // Two gateway calls: first (invalid-tick), then retry (success).
    expect(gateway.placeOrder).toHaveBeenCalledTimes(2);

    // Second call must use the corrected tick + re-snapped BUY floor price.
    const retryCall = (gateway.placeOrder as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(retryCall.tickSize).toBe(0.01);
    expect(retryCall.price).toBeCloseTo(0.15, 10); // BUY floor of 0.155 at 0.01
    // negRisk must be preserved on the retry.
    expect(retryCall.negRisk).toBe(true);

    // Order saved as "open" with retry price.
    expect(orderRepo.save).toHaveBeenCalledTimes(1);
    const saved = orderRepo.save.mock.calls[0]![0];
    expect(saved.status).toBe("open");
    expect(saved.price).toBeCloseTo(0.15, 10);
    expect(saved.metadata).toEqual(FRESH_EDGE_METADATA);

    // OrderPlaced published with retry price; no OrderRejected.
    expect(placed).toHaveLength(1);
    expect(placed[0].price).toBeCloseTo(0.15, 10);
    expect(rejected).toHaveLength(0);

    // Cache was invalidated before re-resolve.
    expect(tickResolver.invalidate).toHaveBeenCalledWith(String(CONDITION_ID));
    // applyTickCorrection persists the new tick.
    expect(marketRepo.updateTickSize).toHaveBeenCalledWith(String(CONDITION_ID), 0.01);

    await mod.stop();
  });

  it("retry cap: retry also rejected by exchange — order saved rejected once (retry price), no third call", async () => {
    const gateway = makeGateway(INVALID_TICK_REJECTION, INVALID_TICK_REJECTION);
    const tickResolver = makeTickResolver(0.001, 0.01);

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

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await mod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makeCmd({ price: 0.155, tickSize: 0.001, side: "buy" }),
      timestamp: Date.now(),
    });

    // Exactly two calls — no third attempt.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(2);

    // Order saved once as "rejected" (retry's price, not original).
    expect(orderRepo.save).toHaveBeenCalledTimes(1);
    const saved = orderRepo.save.mock.calls[0]![0];
    expect(saved.status).toBe("rejected");
    expect(saved.price).toBeCloseTo(0.15, 10); // retry price

    // One OrderRejected event (from the retry failure path).
    expect(rejected).toHaveLength(1);

    await mod.stop();
  });

  it("does NOT retry on a balance (non-tick) rejection", async () => {
    const gateway = makeGateway(BALANCE_REJECTION);
    const tickResolver = makeTickResolver(0.001, 0.01);

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

    // Only one gateway call — no retry.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    // Order saved as rejected with original price.
    const saved = orderRepo.save.mock.calls[0]![0];
    expect(saved.status).toBe("rejected");
    expect(saved.price).toBeCloseTo(0.155, 10);

    // No tick correction.
    expect(tickResolver.invalidate).not.toHaveBeenCalled();
    expect(marketRepo.updateTickSize).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("aborts retry when re-snap to corrected tick is invalid — falls through to original reject", async () => {
    // Force resnapPriceToTick to fail for the Phase 2 call (but pass for Phase 1, if any).
    // Phase 1 uses the same function — we'll have Phase 1 return same tick (no-op)
    // so resnapPriceToTick is only called by Phase 2.
    vi.mocked(resnapPriceToTick).mockReturnValueOnce({ price: 0, valid: false });

    const gateway = makeGateway(INVALID_TICK_REJECTION);
    const tickResolver = makeTickResolver(0.001, 0.01);

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

    // No retry: only one gateway call.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    // Order saved as rejected with original price.
    const saved = orderRepo.save.mock.calls[0]![0];
    expect(saved.status).toBe("rejected");
    expect(saved.price).toBeCloseTo(0.155, 10);

    // invalidate IS called (happens before resnap check in retryAfterInvalidTick).
    expect(tickResolver.invalidate).toHaveBeenCalledWith(String(CONDITION_ID));
    // No tick correction persisted.
    expect(marketRepo.updateTickSize).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("guard blocks on corrected params (post-only-cross) — no retry placement, original reject path", async () => {
    const gateway = makeGateway(INVALID_TICK_REJECTION);
    // Phase 1: same tick → no Phase 1 correction.
    // Phase 2: corrects to 0.01 → re-snap BUY floor of 0.005 →
    //   clampExecutablePrice(0.005, 0.01, "buy") → floorToTick(0.005, 0.01) = 0 →
    //   clamped to minPrice (0.01) → retryPrice = 0.01.
    // bestAsk = 0.01 → 0.01 + epsilon >= 0.01 → post-only-cross detected on retry.
    const tickResolver = makeTickResolver(0.001, 0.01);

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

    // Seed market cache with bestAsk=0.01.
    // Pre-submit post-only check: cmd.price(0.005) + epsilon < 0.01 → no cross → passes.
    // Retry post-only check: retryPrice(0.01) + epsilon >= 0.01 → cross → blocks.
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        {
          tokenId: TOKEN_ID,
          conditionId: CONDITION_ID,
          slug: "test-mkt",
          eventSlug: null,
          question: "Test?",
          outcome: "Yes",
          regime: null,
          horizon: null,
          endDate: null,
          active: true,
          tradable: true,
          tickSize: 0.001,
          negRisk: false,
          acceptingOrders: true,
          enableOrderBook: true,
          bestBid: 0.008,
          bestAsk: 0.01,
          midPrice: 0.009,
          spread: 0.002,
          minOrderSize: null,
          bookSource: "clob",
          gammaCreatedAt: null,
          snapshotTs: Date.now(),
          eventMarketCount: 1,
        } as NormalizedMarket,
      ],
      timestamp: Date.now(),
    });

    const rejected: any[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: makeCmd({
        price: 0.005, // valid on 0.001 grid; below bestAsk(0.01) → pre-submit passes
        tickSize: 0.001,
        side: "buy",
        postOnly: true,
      }),
      timestamp: Date.now(),
    });

    // Only one gateway call — retry was blocked by the post-only-cross guard.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    // retryAfterInvalidTick returned false → original reject path runs.
    expect(orderRepo.save).toHaveBeenCalledTimes(1);
    const saved = orderRepo.save.mock.calls[0]![0];
    expect(saved.status).toBe("rejected");
    expect(saved.price).toBeCloseTo(0.005, 10); // original cmd price

    // OrderRejected from the original rejection path.
    expect(rejected).toHaveLength(1);

    // invalidate was called even though the retry was blocked by the guard.
    expect(tickResolver.invalidate).toHaveBeenCalledWith(String(CONDITION_ID));

    await mod.stop();
  });

  it("atomically replaces a rejected prepared hash with the corrected pending hash before retry POST", async () => {
    let row: any = null;
    const gateway = makePreparedGateway(
      {
        kind: "rejected",
        errorCode: "INVALID_PRICE",
        errorMessage: "invalid tick size",
        errorDetails: { responseBody: { error: "invalid tick size" } },
      },
      { kind: "accepted", orderId: "0xnew" },
      () => expect(row).toMatchObject({ orderId: "0xnew", status: "pending" }),
    );
    orderRepo.save.mockImplementation((order: any) => {
      row = order;
    });
    (orderRepo as any).replacePendingIdentity = vi.fn((_old: string, replacement: any) => {
      expect(row).toMatchObject({ orderId: "0xold", status: "rejected" });
      row = replacement;
    });
    orderRepo.updateStatus.mockImplementation((id: string, status: string) => {
      expect(id).toBe("0xnew");
      row = { ...row, status };
    });
    orderRepo.findById.mockImplementation((id: string) => (row?.orderId === id ? row : null));
    orderRepo.findOpen.mockImplementation(() => (row?.status === "pending" ? [row] : []));
    const mod = new ExecutionModule({
      gateway: gateway as any,
      bus,
      marketRepo: marketRepo as any,
      orderRepo: orderRepo as any,
      fillRepo: fillRepo as any,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeMode: "live-lite",
      runtimeControl: { isPaused: () => false },
      tickResolver: makeTickResolver(0.001, 0.01) as any,
    });

    await mod.start();
    await bus.publish("PlaceOrderRequested", {
      command: makeCmd({ metadata: FRESH_EDGE_METADATA }),
      timestamp: Date.now(),
    });

    expect(gateway.prepareOrder).toHaveBeenCalledTimes(2);
    expect(gateway.submitPreparedOrder).toHaveBeenCalledTimes(2);
    expect((orderRepo as any).replacePendingIdentity).toHaveBeenCalledWith(
      "0xold",
      expect.anything(),
    );
    expect(row).toMatchObject({
      orderId: "0xnew",
      status: "open",
      metadata: { ...FRESH_EDGE_METADATA, orderSource: "strategy" },
    });
    await mod.stop();
  });

  it("keeps an ambiguous corrected prepared POST pending and fenced by findOpen", async () => {
    let row: any = null;
    const gateway = makePreparedGateway(
      {
        kind: "rejected",
        errorCode: "INVALID_PRICE",
        errorMessage: "invalid tick size",
        errorDetails: { responseBody: { error: "invalid tick size" } },
      },
      { kind: "unknown", errorMessage: "timeout", errorDetails: null },
    );
    orderRepo.save.mockImplementation((order: any) => {
      row = order;
    });
    (orderRepo as any).replacePendingIdentity = vi.fn((_old: string, replacement: any) => {
      row = replacement;
    });
    orderRepo.findOpen.mockImplementation(() => (row?.status === "pending" ? [row] : []));
    const mod = new ExecutionModule({
      gateway: gateway as any,
      bus,
      marketRepo: marketRepo as any,
      orderRepo: orderRepo as any,
      fillRepo: fillRepo as any,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeMode: "live-lite",
      runtimeControl: { isPaused: () => false },
      tickResolver: makeTickResolver(0.001, 0.01) as any,
    });

    await mod.start();
    await bus.publish("PlaceOrderRequested", { command: makeCmd(), timestamp: Date.now() });

    expect(row).toMatchObject({ orderId: "0xnew", status: "pending" });
    expect(orderRepo.findOpen()).toEqual([row]);
    await mod.stop();
  });
});
