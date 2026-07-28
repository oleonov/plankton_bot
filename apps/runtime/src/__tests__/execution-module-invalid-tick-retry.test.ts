/**
 * Phase 2 tests — invalid-tick in-attempt retry in ExecutionModule.
 *
 * Verifies:
 *  1. Retry success: first attempt gets rejection_invalid_tick, retry succeeds →
 *     order persisted with corrected price/tick, OrderPlaced published.
 *  2. Retry cap: retry also rejected → exactly one retry (two gateway calls total),
 *     final rejection persisted with the retry price/tick.
 *  3. Non-tick rejection untouched: balance-insufficient rejection → no retry,
 *     gateway called exactly once.
 *  4. No retry when tickResolver is absent → original rejection persisted, one call.
 *  5. Guard blocks retry (near-duplicate BUY) → no second placeOrder call.
 *  6. Exit loss-floor gate blocks the retry itself (docs/plans/2026-07-20-exit-
 *     loss-floor.md §Phase 4, step 3): the retry's own authoritative floor
 *     checkpoint blocks and returns false → no second gateway call, and the
 *     ORIGINAL invalid-tick rejection is persisted exactly once (no 2nd
 *     OrderRejected).
 *  7. R23 Fix #1+TOCTOU (docs/plans/2026-07-23-maker-rails-slice1-4a.md): the
 *     fail-closed maker-BUY validator re-runs at BOTH the main submit boundary
 *     AND the invalid-tick retry submit boundary — a maker cap tightened in the
 *     gap between admission and either submit attempt is caught there, and the
 *     retry rejection publishes exactly ONE OrderRejected (never a duplicate of
 *     the original invalid-tick rejection).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createCommandId,
  createBotRunId,
  createConditionId,
  createPositionId,
  createLotId,
  createFillId,
  ExchangeErrorCode,
  SignalReason,
} from "@krabs/domain";
import type {
  ExchangeGateway,
  PlaceOrderParams,
  PlaceOrderResult,
  CancelOrderParams,
  CancelOrderResult,
  ExchangeOrder,
  ExchangeFill,
  ExchangeBalance,
  OrderRepository,
  FillRepository,
  PositionRepository,
  InventoryLotRepository,
  Position,
  PlaceOrderCommand,
  TokenId,
  ClientOrderId,
  NormalizedMarket,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { DEFAULT_EXECUTION_POLICY } from "../execution-policy.js";
import { AuthoritativeTickResolver } from "../modules/execution/authoritative-tick-resolver.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BOT_RUN_ID = createBotRunId("test-run-p2");

const INVALID_TICK_ERROR_DETAILS = {
  reason: "invalid tick size (0.001), minimum for the market is 0.01",
};

function makePlaceCmd(overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId("cmd-p2"),
    clientOrderId: "plk_p2_abc" as ClientOrderId,
    source: "strategy",
    tokenId: createTokenId("tok-p2"),
    conditionId: createConditionId("cond-p2"),
    side: "buy",
    size: 10,
    price: 0.5,
    orderType: "GTC",
    // cmd carries the stale Gamma tick
    tickSize: 0.001,
    negRisk: false,
    sequenceInTick: 0,
    signalReason: null,
    ...overrides,
  };
}

function createMockGateway(): ExchangeGateway {
  return {
    placeOrder: vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValue({ success: true, orderId: "ord-p2-1" }),
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

function createMockMarketRepo() {
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

function makeNormalizedMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId: createTokenId("tok-p2"),
    conditionId: createConditionId("cond-p2"),
    slug: "test-market-p2",
    eventSlug: null,
    question: "Test market P2?",
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
    bestBid: 0.48,
    bestAsk: 0.52,
    midPrice: 0.5,
    spread: 0.04,
    minOrderSize: null,
    bookSource: "clob",
    gammaCreatedAt: null,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
    ...overrides,
  };
}

/** Minimal stub that always returns the same tick for every resolve() call. */
function createMockTickResolver(resolvedTick: number): AuthoritativeTickResolver {
  return {
    resolve: vi.fn().mockResolvedValue(resolvedTick),
    invalidate: vi.fn(),
  } as unknown as AuthoritativeTickResolver;
}

/**
 * Staged resolver: Phase 1 resolve() returns `firstTick` (so the proactive
 * correction block is a no-op when firstTick === cmd.tickSize). After
 * invalidation the Phase 2 retry resolve() returns `retryTick`.
 *
 * Use this when the test is specifically exercising the retry path: Phase 1
 * does nothing, the stale tick goes to the exchange, gets rejected, then
 * Phase 2 fetches the real tick and retries once.
 */
function createStagedMockTickResolver(
  firstTick: number,
  retryTick: number,
): AuthoritativeTickResolver {
  return {
    resolve: vi.fn().mockResolvedValueOnce(firstTick).mockResolvedValueOnce(retryTick),
    invalidate: vi.fn(),
  } as unknown as AuthoritativeTickResolver;
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

function getExecutePlaceCaller(mod: ExecutionModule): {
  executePlace(cmd: PlaceOrderCommand): Promise<void>;
} {
  return mod as unknown as {
    executePlace(cmd: PlaceOrderCommand): Promise<void>;
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ExecutionModule — invalid-tick in-attempt retry (Phase 2)", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let bus: InProcessEventBus;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let fillRepo: ReturnType<typeof createMockFillRepo>;

  beforeEach(() => {
    gateway = createMockGateway();
    bus = new InProcessEventBus();
    marketRepo = createMockMarketRepo();
    orderRepo = createMockOrderRepo();
    fillRepo = createMockFillRepo();
  });

  it("retries once on invalid-tick rejection and persists success with corrected price/tick", async () => {
    // Phase 1 resolver returns the same stale tick (0.001) as in cmd, so no
    // proactive correction happens and the stale tick goes to the exchange.
    // The exchange rejects it; Phase 2 then invalidates the cache, re-resolves
    // to 0.01, and retries — the second call succeeds.
    (gateway.placeOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: false,
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "invalid tick size (0.001), minimum for the market is 0.01",
        errorDetails: INVALID_TICK_ERROR_DETAILS,
      })
      .mockResolvedValueOnce({ success: true, orderId: "ord-retry-ok" });

    // Phase 1 sees no tick mismatch (0.001 === cmd.tickSize); retry gets 0.01.
    const tickResolver = createStagedMockTickResolver(/* phase1 */ 0.001, /* retry */ 0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver,
    });
    await mod.start();

    const cmd = makePlaceCmd({ price: 0.5, tickSize: 0.001 });
    const caller = getExecutePlaceCaller(mod);

    const placedEvents: unknown[] = [];
    bus.subscribe("OrderPlaced", async (e) => {
      placedEvents.push(e);
    });

    await caller.executePlace(cmd);

    // Gateway called twice: first attempt + retry.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(2);

    // Resolver invalidated and re-resolved after the rejection.
    expect(tickResolver.invalidate).toHaveBeenCalledWith(String(cmd.conditionId));
    expect(tickResolver.resolve).toHaveBeenCalledTimes(2); // once proactive (Phase 1) + once retry

    // The retry call uses the corrected tick and price.
    const retryCall = (gateway.placeOrder as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(retryCall.tickSize).toBe(0.01);
    expect(retryCall.price).toBe(0.5); // 0.5 is already on 0.01 grid

    // Order persisted as open with the retry price.
    expect(orderRepo.save).toHaveBeenCalledTimes(1);
    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedOrder.status).toBe("open");
    expect(savedOrder.price).toBe(0.5);

    // OrderPlaced published.
    expect(placedEvents).toHaveLength(1);

    await mod.stop();
  });

  it("hard cap: retry also rejected → persists retry rejection; gateway called exactly twice", async () => {
    // Same staged setup: Phase 1 sees no mismatch (0.001), stale tick goes to
    // exchange, gets rejected; Phase 2 resolves to 0.01 and retries once —
    // but the retry also fails. The hard cap means no third attempt.
    (gateway.placeOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: false,
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "invalid tick size (0.001), minimum for the market is 0.01",
        errorDetails: INVALID_TICK_ERROR_DETAILS,
      })
      .mockResolvedValueOnce({
        success: false,
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "still failing",
        errorDetails: { reason: "still failing" },
      });

    const tickResolver = createStagedMockTickResolver(/* phase1 */ 0.001, /* retry */ 0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver,
    });
    await mod.start();

    const cmd = makePlaceCmd({ price: 0.5, tickSize: 0.001 });
    await getExecutePlaceCaller(mod).executePlace(cmd);

    // Exactly two gateway calls; no third attempt.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(2);

    // Rejection persisted once with the retry's corrected price.
    expect(orderRepo.save).toHaveBeenCalledTimes(1);
    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedOrder.status).toBe("rejected");
    // Retry price: 0.5 snapped to 0.01 tick → still 0.5.
    expect(savedOrder.price).toBe(0.5);

    await mod.stop();
  });

  it("non-tick rejection leaves gateway called exactly once and no retry", async () => {
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      errorCode: ExchangeErrorCode.Unknown,
      errorMessage: "not enough balance",
      errorDetails: { reason: "not enough balance" },
    });

    const tickResolver = createMockTickResolver(0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver,
    });
    await mod.start();

    await getExecutePlaceCaller(mod).executePlace(makePlaceCmd({ price: 0.5, tickSize: 0.001 }));

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    // invalidate must NOT have been called.
    expect(tickResolver.invalidate).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("skips retry when no tickResolver is configured; original rejection persisted with one gateway call", async () => {
    // Without a tickResolver dep there is nothing to re-resolve from, so
    // retryAfterInvalidTick returns false immediately and the original
    // rejection is persisted on the first (and only) gateway call.
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      errorCode: ExchangeErrorCode.Unknown,
      errorMessage: "invalid tick size (0.001), minimum for the market is 0.01",
      errorDetails: INVALID_TICK_ERROR_DETAILS,
    });

    // No tickResolver in deps.
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      // tickResolver intentionally omitted
    });
    await mod.start();

    await getExecutePlaceCaller(mod).executePlace(makePlaceCmd({ price: 0.5, tickSize: 0.001 }));

    // No retry — gateway called only once.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    // Original rejection persisted.
    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedOrder.status).toBe("rejected");

    await mod.stop();
  });

  it("skips retry when near-duplicate BUY guard fires; original rejection persisted", async () => {
    // First attempt → invalid-tick rejection.
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      errorCode: ExchangeErrorCode.Unknown,
      errorMessage: "invalid tick size (0.001), minimum for the market is 0.01",
      errorDetails: INVALID_TICK_ERROR_DETAILS,
    });

    // Phase 1 sees no mismatch → no proactive correction → M3 never fires.
    // Phase 2 retry resolves 0.01 (different from 0.001) but is blocked by the
    // near-duplicate guard inside retryAfterInvalidTick.
    const tickResolver = createStagedMockTickResolver(/* phase1 */ 0.001, /* retry */ 0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver,
    });

    // Inject a near-duplicate open BUY so the guard fires.
    // findNearDuplicateOpenBuy requires matching tokenId, isSameBuyFamily
    // (same signalReason + non-null decisionRuleId), and isNearPrice (within 1 tick).
    const SHARED_RULE_ID = "rule-p2-dup";
    const existingBuyOrder = {
      orderId: "existing-buy-1",
      clientOrderId: "plk_existing_buy" as ClientOrderId,
      tokenId: createTokenId("tok-p2"),
      conditionId: createConditionId("cond-p2"),
      side: "buy" as const,
      orderType: "GTC",
      postOnly: false,
      price: 0.5, // same price as retry → near-duplicate
      size: 10,
      sizeUsdc: 5,
      status: "open" as const,
      exchangeOrderId: "existing-buy-1",
      signalId: null,
      signalReason: SignalReason.ProbeEntry,
      decisionRuleId: SHARED_RULE_ID,
      signalTimestamp: null,
      entryStyle: null,
      exchangeErrorCode: null,
      exchangeErrorMessage: null,
      exchangeErrorPayload: null,
      exchangeRejectionReason: null,
      metadata: null,
      botRunId: BOT_RUN_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    (orderRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([existingBuyOrder]);

    await mod.start();

    // Cmd must have the same signalReason + decisionRuleId so isSameBuyFamily returns true.
    const cmd = makePlaceCmd({
      price: 0.5,
      tickSize: 0.001,
      signalReason: SignalReason.ProbeEntry,
      decisionRuleId: SHARED_RULE_ID,
    });
    await getExecutePlaceCaller(mod).executePlace(cmd);

    // Guard should block retry — only one gateway call.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    // Original rejection (first attempt) persisted.
    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedOrder.status).toBe("rejected");
    // Price is from original cmd (0.5).
    expect(savedOrder.price).toBe(0.5);

    await mod.stop();
  });

  it("exit loss-floor gate blocks the retry itself — no 2nd OrderRejected (docs/plans/2026-07-20-exit-loss-floor.md)", async () => {
    // Same staged invalid-tick setup as the "hard cap" test above, but cmd is
    // a SELL. The retry price is unchanged from the first attempt (0.10 is
    // already on both the 0.001 and 0.01 grids), so the only way for the
    // RETRY's own floor checkpoint (~:3281) to diverge from the first
    // attempt's checkpoint (~:1416) is for the position/lots the gate reads
    // to change in between — e.g. a concurrent scale-in/fill landing between
    // the first submit attempt and the retry, exactly the race the plan's
    // "re-evaluate fresh on every checkpoint" design defends against. The
    // mocked positionRepo/inventoryLotRepo below switch from a cheap (safe)
    // position to an expensive (>85%-loss) one the instant the first gateway
    // call has happened, so the first checkpoint sees "safe" (reaches the
    // gateway, gets the mocked invalid-tick rejection) and the retry
    // checkpoint sees "unsafe" (blocks). Per the plan, the retry must return
    // false so executePlace falls through to persist the ORIGINAL invalid-
    // tick rejection exactly once — never a second OrderRejected for the
    // retry attempt.
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      errorCode: ExchangeErrorCode.Unknown,
      errorMessage: "invalid tick size (0.001), minimum for the market is 0.01",
      errorDetails: INVALID_TICK_ERROR_DETAILS,
    });

    const positionId = createPositionId("pos-p2-floor-retry");
    const tokenId = createTokenId("tok-p2");
    const conditionId = createConditionId("cond-p2");
    const safePosition: Position = {
      positionId,
      tokenId,
      conditionId,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.1,
      costBasisUsdc: 1.0,
      currentValueUsdc: 1.0,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    // Same 10-share lot, entry price raised from 0.10 to 0.90 — cost basis
    // moves from 1.0 to 9.0. Selling at 0.10 (net ~0.0937 after taker fee) is
    // a ~6% loss against the cheap lot but a ~90% loss against the expensive
    // one — comfortably on either side of the default 50% floor.
    const unsafePosition: Position = {
      ...safePosition,
      avgEntryPrice: 0.9,
      costBasisUsdc: 9.0,
      currentValueUsdc: 9.0,
    };
    const safeLot = {
      lotId: createLotId("lot-p2-floor-safe"),
      positionId,
      tokenId,
      side: "buy" as const,
      size: 10,
      remainingSize: 10,
      entryPrice: 0.1,
      costUsdc: 1.0,
      fillId: createFillId("fill-p2-floor-safe"),
      createdAt: new Date().toISOString(),
    };
    const unsafeLot = { ...safeLot, entryPrice: 0.9, costUsdc: 9.0 };

    // The floor gate re-fetches position/lots fresh at every checkpoint
    // (evaluateSellExitLossFloor). Switch the instant the first gateway
    // attempt has happened, so the pre-submit checkpoint sees the cheap
    // position and the retry checkpoint sees the expensive one.
    const hasSubmittedFirstAttempt = () =>
      (gateway.placeOrder as ReturnType<typeof vi.fn>).mock.calls.length > 0;
    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findById: vi.fn().mockReturnValue(null),
      findActiveByTokenId: vi.fn(() => []),
      findByTokenId: vi.fn(() => (hasSubmittedFirstAttempt() ? unsafePosition : safePosition)),
      findByConditionId: vi.fn().mockReturnValue([]),
      findAllOpen: vi.fn(() => [hasSubmittedFirstAttempt() ? unsafePosition : safePosition]),
      updateSize: vi.fn(),
      close: vi.fn(),
    } as unknown as PositionRepository;
    const inventoryLotRepo: InventoryLotRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn(() => [hasSubmittedFirstAttempt() ? unsafeLot : safeLot]),
      findOpen: vi.fn(() => [hasSubmittedFirstAttempt() ? unsafeLot : safeLot]),
      consumeFifo: vi.fn().mockReturnValue([]),
      settleAll: vi.fn(),
    };

    const tickResolver = createStagedMockTickResolver(/* phase1 */ 0.001, /* retry */ 0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver,
    });
    await mod.start();

    const rejectedEvents: Array<{ reason: string }> = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejectedEvents.push({ reason: p.reason });
    });
    const skippedEvents: Array<{ reasonCode: string; details?: Record<string, unknown> }> = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skippedEvents.push({
        reasonCode: p.reasonCode,
        details: p.details as Record<string, unknown>,
      });
    });

    const cmd = makePlaceCmd({
      side: "sell",
      price: 0.1,
      size: 10,
      tickSize: 0.001,
      tokenId,
      conditionId,
    });
    await getExecutePlaceCaller(mod).executePlace(cmd);

    // Retry never reached the gateway a second time — the floor blocked it first.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    // The floor block surfaces as an OrderSkipped for the retry attempt...
    expect(skippedEvents).toHaveLength(1);
    expect(skippedEvents[0]!.reasonCode).toBe("exit_loss_floor_blocked");
    expect(skippedEvents[0]!.details).toMatchObject({
      exitLossFloorReason: "exit_loss_floor_blocked",
      phase: "invalid-tick-retry",
    });

    // ...but persistence/publish for the command itself still reflects only
    // the ORIGINAL invalid-tick rejection — exactly one OrderRejected, not two.
    expect(rejectedEvents).toHaveLength(1);
    expect(orderRepo.save).toHaveBeenCalledTimes(1);
    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedOrder.status).toBe("rejected");
    expect(savedOrder.exchangeRejectionReason).toBe("rejection_invalid_tick");
    expect(savedOrder.price).toBe(0.1);

    await mod.stop();
  });
});

// ─── M4 / M5 regression tests (Codex review bugs) ────────────────────────────

describe("ExecutionModule — M4: same-tick guard in retryAfterInvalidTick", () => {
  it("skips retry when resolver returns the same tick as first attempt", async () => {
    // Scenario: all CLOB lookups failed, resolver fell back to the persisted
    // stale tick (0.001) — same as firstAttemptTick. Retrying with the same
    // tick guarantees a second rejection, so we should bail out immediately.
    const bus = new InProcessEventBus();
    const gateway = createMockGateway();
    const orderRepo = createMockOrderRepo();
    const marketRepo = createMockMarketRepo();
    const fillRepo = createMockFillRepo();

    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      errorCode: ExchangeErrorCode.Unknown,
      errorMessage: "invalid tick size (0.001), minimum for the market is 0.01",
      errorDetails: INVALID_TICK_ERROR_DETAILS,
    });

    // Resolver always returns the same stale tick: no improvement available.
    const tickResolver = createMockTickResolver(0.001);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver,
    });
    await mod.start();

    const cmd = makePlaceCmd({ price: 0.5, tickSize: 0.001 });
    await getExecutePlaceCaller(mod).executePlace(cmd);

    // M4 guard: only one gateway call (no retry placed).
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    // Original rejection was persisted after the guard short-circuited.
    const savedOrder = (orderRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(savedOrder.status).toBe("rejected");

    await mod.stop();
  });
});

describe("ExecutionModule — M5: applyTickCorrection refreshes sibling token", () => {
  it("updates both YES and NO tokens in marketCache when correcting tick on retry success", async () => {
    // Two tokens share the same conditionId — a YES and a NO outcome.
    // After a successful retry, applyTickCorrection must refresh BOTH so
    // subsequent commands for the sibling token don't get a stale tick.
    const bus = new InProcessEventBus();
    const gateway = createMockGateway();
    const orderRepo = createMockOrderRepo();
    const marketRepo = createMockMarketRepo();
    const fillRepo = createMockFillRepo();

    const COND_ID = createConditionId("cond-m5");
    const YES_TOKEN = createTokenId("tok-m5-yes");
    const NO_TOKEN = createTokenId("tok-m5-no");

    // Phase 1 sees no mismatch (resolver returns 0.001 = cmd.tickSize) →
    // no proactive correction. The stale tick goes to the exchange and is
    // rejected. Phase 2 retry resolves 0.01, places a second call that
    // succeeds, and applyTickCorrection should update BOTH cached tokens.
    (gateway.placeOrder as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        success: false,
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "invalid tick size (0.001), minimum for the market is 0.01",
        errorDetails: INVALID_TICK_ERROR_DETAILS,
      })
      .mockResolvedValueOnce({ success: true, orderId: "ord-m5-ok" });

    const tickResolver = createStagedMockTickResolver(/* phase1 */ 0.001, /* retry */ 0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver,
    });
    await mod.start();

    // Pre-populate marketCache with both tokens via NormalizedMarketUpdated.
    await bus.publish("NormalizedMarketUpdated", {
      markets: [
        makeNormalizedMarket({ tokenId: YES_TOKEN, conditionId: COND_ID, tickSize: 0.001 }),
        makeNormalizedMarket({ tokenId: NO_TOKEN, conditionId: COND_ID, tickSize: 0.001 }),
      ],
      timestamp: Date.now(),
    });

    // Track NormalizedMarketUpdated events after mod.start() so we catch the
    // applyTickCorrection publish (the initial inject above fires before subscribe).
    const updateEvents: ReadonlyArray<NormalizedMarket>[] = [];
    bus.subscribe("NormalizedMarketUpdated", async (e) => {
      updateEvents.push(e.markets);
    });

    const cmd = makePlaceCmd({ tokenId: YES_TOKEN, conditionId: COND_ID, tickSize: 0.001 });
    await getExecutePlaceCaller(mod).executePlace(cmd);

    // Retry must have succeeded.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(2);

    // NormalizedMarketUpdated from applyTickCorrection should include BOTH tokens.
    const allUpdatedTokenIds = updateEvents.flat().map((m) => String(m.tokenId));
    expect(allUpdatedTokenIds).toContain(String(YES_TOKEN));
    expect(allUpdatedTokenIds).toContain(String(NO_TOKEN));

    // Both entries should carry the corrected tick.
    for (const m of updateEvents.flat()) {
      if (m.conditionId === COND_ID) {
        expect(m.tickSize).toBe(0.01);
      }
    }

    await mod.stop();
  });
});

describe("ExecutionModule — R23 Fix #1+TOCTOU: maker-cap re-validated at submit boundaries", () => {
  it("maker BUY whose cap was lowered after admission is rejected at the MAIN submit boundary, before reaching the exchange", async () => {
    const bus = new InProcessEventBus();
    const gateway = createMockGateway();
    const orderRepo = createMockOrderRepo();
    const marketRepo = createMockMarketRepo();
    const fillRepo = createMockFillRepo();

    // Models "the cap was fine at admission time, but by the time executePlace
    // reaches the submit boundary the policy has been tightened" by invoking
    // executePlace directly (bypassing handlePlace's admission entirely) with
    // the ALREADY-tightened policy in effect — the submit-boundary re-check
    // (Fix #1+TOCTOU) is the only thing that can still catch it.
    const policy = {
      ...DEFAULT_EXECUTION_POLICY,
      makerEntry: {
        ...DEFAULT_EXECUTION_POLICY.makerEntry,
        mode: "micro_live" as const,
        whitelistConditionIds: ["cond-p2"],
        microMaxOrderUsdc: 1, // cmd notional = 10 * 0.5 = 5, well over this
        microMaxOpenUsdc: 100,
      },
    };
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => policy,
    });
    await mod.start();

    const rejected: Array<{ reason: string }> = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push({ reason: p.reason });
    });

    const cmd = makePlaceCmd({
      entryStyle: "maker",
      side: "buy",
      price: 0.5,
      size: 10,
      tickSize: 0.01,
    });
    await getExecutePlaceCaller(mod).executePlace(cmd);

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("maker-micro-order-cap-exceeded");
    expect(orderRepo.save).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("maker BUY cap lowered before the invalid-tick retry submit is rejected there — exactly one OrderRejected, no double reject", async () => {
    const bus = new InProcessEventBus();
    const gateway = createMockGateway();
    const orderRepo = createMockOrderRepo();
    const marketRepo = createMockMarketRepo();
    const fillRepo = createMockFillRepo();

    // First attempt: invalid-tick rejection from the exchange, forcing the retry path.
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      errorCode: ExchangeErrorCode.Unknown,
      errorMessage: "invalid tick size (0.001), minimum for the market is 0.01",
      errorDetails: INVALID_TICK_ERROR_DETAILS,
    });

    const generousPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      makerEntry: {
        ...DEFAULT_EXECUTION_POLICY.makerEntry,
        mode: "micro_live" as const,
        whitelistConditionIds: ["cond-p2"],
        microMaxOrderUsdc: 100,
        microMaxOpenUsdc: 100,
      },
    };
    const tightenedPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      makerEntry: {
        ...DEFAULT_EXECUTION_POLICY.makerEntry,
        mode: "micro_live" as const,
        whitelistConditionIds: ["cond-p2"],
        microMaxOrderUsdc: 1, // cmd notional (10 * 0.5 = 5) now over cap
        microMaxOpenUsdc: 100,
      },
    };
    // Fix #1+TOCTOU calls makerBuyLiveRejection exactly twice for this command
    // when executePlace is invoked directly (admission bypassed): once at the
    // main submit boundary (passes under the generous cap, so the first
    // gateway attempt happens and gets the mocked invalid-tick rejection), once
    // at the retry submit boundary (this call sees the tightened cap — an
    // operator change that landed in the gap between the two submit attempts).
    let policyCallCount = 0;
    const executionPolicy = () => {
      policyCallCount += 1;
      return policyCallCount === 1 ? generousPolicy : tightenedPolicy;
    };

    const tickResolver = createStagedMockTickResolver(/* phase1 */ 0.001, /* retry */ 0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver,
      executionPolicy,
    });
    await mod.start();

    const rejected: Array<{ reason: string }> = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push({ reason: p.reason });
    });

    const cmd = makePlaceCmd({
      entryStyle: "maker",
      side: "buy",
      price: 0.5,
      size: 10,
      tickSize: 0.001,
    });
    await getExecutePlaceCaller(mod).executePlace(cmd);

    // Only the FIRST gateway attempt happens — the retry is intercepted by the
    // fail-closed maker-cap check before it ever reaches the exchange again.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    // Exactly one OrderRejected — the maker-cap rejection, not a second copy of
    // the original invalid-tick rejection (Fix #1+TOCTOU's retryRej branch
    // returns `true`, short-circuiting the caller's own invalid-tick reject path).
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("maker-micro-order-cap-exceeded");
    expect(orderRepo.save).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("maker BUY whose price re-snaps UP before the retry submit is counted at the FINAL retry notional (aggregate cap, no bypass)", async () => {
    const bus = new InProcessEventBus();
    const gateway = createMockGateway();
    const orderRepo = createMockOrderRepo();
    const marketRepo = createMockMarketRepo();
    const fillRepo = createMockFillRepo();

    // First attempt (at 0.005) gets an invalid-tick rejection, forcing the retry.
    (gateway.placeOrder as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      errorCode: ExchangeErrorCode.Unknown,
      errorMessage: "invalid tick size (0.005), minimum for the market is 0.01",
      errorDetails: INVALID_TICK_ERROR_DETAILS,
    });

    // Constant small aggregate cap. Main submit at 0.005 (notional 0.55) passes;
    // the retry re-snaps the price UP to 0.01 (notional 1.10) which exceeds the
    // aggregate cap. The retry validator must count the LIVE 1.10 (Fix #1's
    // exclude-own-reservation + current-notional), not a stale 0.55, and reject.
    const policy = {
      ...DEFAULT_EXECUTION_POLICY,
      makerEntry: {
        ...DEFAULT_EXECUTION_POLICY.makerEntry,
        mode: "micro_live" as const,
        whitelistConditionIds: ["cond-p2"],
        microMaxOrderUsdc: 100,
        microMaxOpenUsdc: 1,
      },
    };

    // phase1 = 0.005 (no proactive resnap on the main path); retry = 0.01.
    const tickResolver = createStagedMockTickResolver(/* phase1 */ 0.005, /* retry */ 0.01);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      tickResolver,
      executionPolicy: () => policy,
    });
    await mod.start();

    const rejected: Array<{ reason: string }> = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push({ reason: p.reason });
    });

    const cmd = makePlaceCmd({
      entryStyle: "maker",
      side: "buy",
      price: 0.005,
      size: 110,
      tickSize: 0.005,
    });
    await getExecutePlaceCaller(mod).executePlace(cmd);

    // First (0.005) attempt reached the exchange; the resnapped-up retry (1.10)
    // is rejected by the aggregate-cap check before a second gateway call.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("maker-micro-open-cap-exceeded");

    await mod.stop();
  });
});
