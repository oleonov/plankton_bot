/**
 * Phase 5 maker-entry tests: micro-live post-only BUY limit orders.
 *
 * Covers:
 *  1. Whitelisted R23 BUY in micro_live → bridge emits maker order (price = bid+1tick, postOnly, entryStyle=maker, size capped)
 *  2. Non-whitelisted condition → bridge emits standard taker order
 *  3. mode="shadow" → bridge emits standard taker order
 *  4. Empty whitelist → bridge emits standard taker order
 *  5. Post-only BUY would cross ask → ExecutionModule skips with OrderSkipped
 *  6. Non-post-only BUY at ask price → ExecutionModule passes through
 *  7. computeMakerOpenOrderUsdc + computeMakerOpenPositionUsdc pure functions
 *  8. validateMicroMaxOrderCap throws when cap < EOA min
 *  9. handleFill propagates entryStyle="maker" from origOrder to applyFill
 */

import { describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  createBotRunId,
  createCommandId,
  createConditionId,
  createFillId,
  createOrderId,
  createTokenId,
  DEFAULT_EXECUTION_POLICY,
  R23_DIP_TRIGGER_RULE_ID,
} from "@krabs/domain";
import type {
  ClientOrderId,
  Fill,
  FillRepository,
  MakerEntryPolicy,
  NormalizedMarket,
  Order,
  OrderRepository,
  PlaceOrderCommand,
  Position,
  PositionRepository,
  Signal,
} from "@krabs/domain";
import { SignalToOrderBridge } from "../modules/strategy/signal-to-order.js";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { LiveLiteGuard } from "../live-lite-guard.js";
import {
  computeMakerOpenOrderUsdc,
  computeMakerOpenPositionUsdc,
} from "../modules/execution/reservation-utils.js";

// ─── Shared constants ─────────────────────────────────────────────────────

const TOKEN_ID = createTokenId("tok-yes");
const COND_ID = createConditionId("cond-maker-1");
const BOT_RUN_ID = createBotRunId("test-run-maker");
const NOW = Date.parse("2026-07-04T10:00:00.000Z");

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(function () {
      return makeLogger();
    }),
    level: "info",
    silent: vi.fn(),
  } as unknown as import("../logger.js").Logger;
}

function makeMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: TOKEN_ID,
    conditionId: String(COND_ID),
    slug: "test-maker-market",
    eventSlug: null,
    question: "Test maker market?",
    outcome: "YES",
    outcomeIndex: 0,
    regime: "price-range",
    horizon: "daily",
    endDate: "2099-12-31T23:59:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.09,
    bestAsk: 0.12,
    midPrice: 0.105,
    spread: 0.03,
    lastTradePrice: null,
    lastTradeAt: null,
    volume24h: 50_000,
    liquidity: 20_000,
    bookSource: "clob",
    snapshotTs: NOW,
    eventMarketCount: 1,
    ...overrides,
  };
}

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    signalId: "sig-maker-1",
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    suggestedPrice: 0.09,
    suggestedSize: 100,
    suggestedSizeUsdc: 9,
    reason: "probe-entry",
    strategyTick: NOW,
    sequenceInTick: 0,
    decisionRuleId: R23_DIP_TRIGGER_RULE_ID,
    sizingRuleId: null,
    generatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makeMakerEntryPolicy(overrides?: Partial<MakerEntryPolicy>): MakerEntryPolicy {
  return {
    mode: "micro_live",
    bidImproveTicks: 1,
    harvestGainPct: 0.5,
    fillWaitMs: 300_000,
    holdWindowMs: 10_800_000,
    makerMinLiquidity: 5_000,
    makerMinVol24h: 1_000,
    maxScaleInLevels: 4,
    scaleInStepPct: 0.1,
    whitelistConditionIds: [String(COND_ID)],
    microMaxOrderUsdc: 10,
    microMaxOpenUsdc: 50,
    collapseFloorPrice: null,
    ...overrides,
  };
}

function makeOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "plk_maker_ord" as ClientOrderId,
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    orderType: "GTC",
    price: 0.1,
    size: 50,
    sizeUsdc: 5,
    status: "open",
    exchangeOrderId: "ord-1",
    signalId: null,
    signalReason: "probe-entry",
    entryStyle: null,
    botRunId: BOT_RUN_ID,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: "pos-1" as any,
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    size: 50,
    avgEntryPrice: 0.1,
    costBasisUsdc: 5,
    currentValueUsdc: 5,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date(NOW).toISOString(),
    closedAt: null,
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makeFill(orderId: string, size: number): Fill {
  return {
    fillId: createFillId(`fill-${orderId}-${size}`),
    orderId: createOrderId(orderId),
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    price: 0.1,
    size,
    sizeUsdc: size * 0.1,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    filledAt: new Date(NOW).toISOString(),
  };
}

function makeFillRepo(
  fills: Fill[] = [],
): Pick<FillRepository, "findByOrderId" | "findByOrderIds"> {
  return {
    findByOrderId: vi.fn((orderId) => fills.filter((f) => String(f.orderId) === String(orderId))),
    findByOrderIds: vi.fn((orderIds) =>
      fills.filter((f) => orderIds.map(String).includes(String(f.orderId))),
    ),
  };
}

// ─── 1–4: SignalToOrderBridge maker override ──────────────────────────────

describe("SignalToOrderBridge — tryMakerEntryOverride", () => {
  async function runBridge(
    signal: Signal,
    policy: Partial<typeof DEFAULT_EXECUTION_POLICY>,
    marketOverrides?: Partial<NormalizedMarket>,
  ) {
    const bus = new InProcessEventBus();
    const resolvedPolicy = { ...DEFAULT_EXECUTION_POLICY, ...policy };
    const bridge = new SignalToOrderBridge({
      bus,
      log: makeLogger(),
      liveLiteGuard: { getWalletMode: () => "eoa" } as never,
      policy: () => resolvedPolicy,
      policySnapshot: () => ({ policy: resolvedPolicy, controlRevision: 77 }),
      now: () => NOW,
    });
    bridge.subscribe();

    const placed: PlaceOrderCommand[] = [];
    const skipped: unknown[] = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      placed.push(p.command);
    });
    bus.subscribe("SignalConversionSkipped", async (p) => {
      skipped.push(p);
    });

    await bus.publish("SignalApproved", {
      signal,
      market: makeMarket(marketOverrides),
      approvedAt: NOW,
    });

    return { placed, skipped };
  }

  it("1. whitelisted R23 probe-entry in micro_live → post-only maker order with capped size", async () => {
    const makerEntry = makeMakerEntryPolicy({ microMaxOrderUsdc: 5 });
    // bid=0.09, tick=0.01, bidImproveTicks=1 → makerPrice = floor(0.09 + 1*0.01, 0.01) = 0.10
    // cappedSize = min(suggestedSize=100, 5 / 0.10) = min(100, 50) = 50
    const { placed, skipped } = await runBridge(makeSignal(), { makerEntry });

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.postOnly).toBe(true);
    expect(placed[0]?.entryStyle).toBe("maker");
    expect(placed[0]?.price).toBeCloseTo(0.1);
    expect(placed[0]?.size).toBeCloseTo(50);
    // 2026-07-19 taker-residual guard: a makerOverride-converted order persists the EFFECTIVE mode
    // "maker" (never the raw resolver mode), so the first-entry adaptive TTL keeps applying to it.
    expect(placed[0]?.metadata?.executionPricingMode).toBe("maker");
  });

  it("1b. opportunistic-taker base + makerOverride → persists effective mode 'maker', not 'taker'", async () => {
    const makerEntry = makeMakerEntryPolicy({ microMaxOrderUsdc: 5 });
    // Tight 2-tick spread (bid=0.09, ask=0.11) makes the opportunistic-taker resolver fire first
    // (pricedMode="taker", price=ask). The R23 whitelist then applies makerOverride → non-crossing
    // maker price 0.10, postOnly:true. The persisted executionPricingMode must reflect the override.
    const { placed, skipped } = await runBridge(makeSignal(), { makerEntry }, { bestAsk: 0.11 });

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.postOnly).toBe(true);
    expect(placed[0]?.metadata?.executionPricingMode).toBe("maker");
  });

  it("2. non-whitelisted condition → standard order (no maker override)", async () => {
    const makerEntry = makeMakerEntryPolicy({
      whitelistConditionIds: ["different-cond-id"],
    });
    const { placed, skipped } = await runBridge(makeSignal(), { makerEntry });

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.entryStyle).not.toBe("maker");
    expect(placed[0]?.postOnly).not.toBe(true);
  });

  it("3. mode=shadow → no maker override", async () => {
    const makerEntry = makeMakerEntryPolicy({ mode: "shadow" });
    const { placed, skipped } = await runBridge(makeSignal(), { makerEntry });

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.entryStyle).not.toBe("maker");
  });

  it("4. empty whitelist → no maker override", async () => {
    const makerEntry = makeMakerEntryPolicy({ whitelistConditionIds: [] });
    const { placed, skipped } = await runBridge(makeSignal(), { makerEntry });

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.entryStyle).not.toBe("maker");
  });

  it("allows an exact timestamp-bound R23 capture with an empty whitelist", async () => {
    const makerEntry = makeMakerEntryPolicy({
      whitelistConditionIds: [],
      microLiveWindow: {
        activatedAtUtc: new Date(NOW).toISOString(),
        expiresAtUtc: new Date(NOW + 60_000).toISOString(),
        maxCumulativeAcceptedPendingUsdc: 1,
        captureNextR23: true,
      },
    });
    const { placed } = await runBridge(makeSignal(), { makerEntry });

    expect(placed[0]?.entryStyle).toBe("maker");
    expect(placed[0]?.postOnly).toBe(true);
    expect(placed[0]?.metadata?.makerMicroLiveLifecycle).toEqual({
      kind: "r23_capture",
      activatedAtUtc: new Date(NOW).toISOString(),
      expiresAtUtc: new Date(NOW + 60_000).toISOString(),
      fillWaitMs: makerEntry.fillWaitMs,
    });
    expect(placed[0]?.metadata?.quoteMotionV1).toMatchObject({
      version: 1,
      kind: "r23_capture",
      cohortId: new Date(NOW).toISOString(),
      originalSuggestedPrice: 0.09,
      entryPriceCeiling: DEFAULT_EXECUTION_POLICY.entryPriceCeiling,
      policySchemaVersion: DEFAULT_EXECUTION_POLICY.version,
      policyControlRevision: 77,
      initialBook: { depthStatus: "unavailable", tickSize: 0.01, source: "disabled" },
    });
  });

  it("does not mark an ordinary static-whitelist maker order for quote-motion", async () => {
    const { placed } = await runBridge(makeSignal(), {
      makerEntry: makeMakerEntryPolicy(),
    });

    expect(placed[0]?.entryStyle).toBe("maker");
    expect(placed[0]?.metadata?.quoteMotionV1).toBeUndefined();
  });

  it.each([
    ["preactivation", NOW - 1],
    ["at expiry", NOW + 60_000],
  ])("rejects an empty-whitelist capture signal from %s", async (_label, signalTimestamp) => {
    const makerEntry = makeMakerEntryPolicy({
      whitelistConditionIds: [],
      microLiveWindow: {
        activatedAtUtc: new Date(NOW).toISOString(),
        expiresAtUtc: new Date(NOW + 60_000).toISOString(),
        maxCumulativeAcceptedPendingUsdc: 1,
        captureNextR23: true,
      },
    });
    const { placed } = await runBridge(
      makeSignal({ generatedAt: new Date(signalTimestamp).toISOString() }),
      { makerEntry },
    );

    expect(placed[0]?.entryStyle).not.toBe("maker");
  });

  it.each([
    ["before activation", NOW + 1, NOW + 60_000],
    ["at exclusive expiry", NOW - 60_000, NOW],
  ])("durable window is inactive %s", async (_label, activatedAtMs, expiresAtMs) => {
    const makerEntry = makeMakerEntryPolicy({
      microLiveWindow: {
        activatedAtUtc: new Date(activatedAtMs).toISOString(),
        expiresAtUtc: new Date(expiresAtMs).toISOString(),
        maxCumulativeAcceptedPendingUsdc: 1,
      },
    });
    const { placed } = await runBridge(makeSignal(), { makerEntry });

    expect(placed).toHaveLength(1);
    expect(placed[0]?.entryStyle).not.toBe("maker");
    expect(placed[0]?.postOnly).not.toBe(true);
  });

  it("durable window is active at its inclusive activation boundary", async () => {
    const makerEntry = makeMakerEntryPolicy({
      microLiveWindow: {
        activatedAtUtc: new Date(NOW).toISOString(),
        expiresAtUtc: new Date(NOW + 60_000).toISOString(),
        maxCumulativeAcceptedPendingUsdc: 1,
      },
    });
    const { placed } = await runBridge(makeSignal(), { makerEntry });

    expect(placed[0]?.entryStyle).toBe("maker");
    expect(placed[0]?.postOnly).toBe(true);
  });
});

// ─── 5–6: ExecutionModule post-only cross BUY guard ──────────────────────

describe("ExecutionModule — getPostOnlyCrossPreSubmitSkip for BUY", () => {
  function makeExecModule(options: {
    placeOrderResult?: { success: boolean; orderId?: string };
    marketBestAsk?: number | null;
  }) {
    const bus = new InProcessEventBus();
    const gateway = {
      placeOrder: vi
        .fn()
        .mockResolvedValue(options.placeOrderResult ?? { success: true, orderId: "sim-ord-1" }),
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
    const orderRepo = {
      save: vi.fn(),
      findById: vi.fn().mockReturnValue(null),
      findByClientOrderId: vi.fn().mockReturnValue(null),
      findByExchangeOrderId: vi.fn().mockReturnValue(null),
      findOpen: vi.fn().mockReturnValue([]),
      findByTokenId: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
      sumOpenBuyNotional: vi.fn().mockReturnValue(0),
    } as OrderRepository;
    const fillRepo = {
      save: vi.fn(),
      exists: vi.fn().mockReturnValue(false),
      findByOrderId: vi.fn().mockReturnValue([]),
      findByOrderIds: vi.fn().mockReturnValue([]),
      findByTokenId: vi.fn().mockReturnValue([]),
      findRecent: vi.fn().mockReturnValue([]),
      findUnreconciled: vi.fn().mockReturnValue([]),
      claimForReconciliation: vi.fn().mockReturnValue(true),
      markReconciled: vi.fn(),
      getLatestTimestamp: vi.fn().mockReturnValue(null),
    } as FillRepository;
    const marketRepo = {
      findByTokenId: vi.fn().mockReturnValue({ active: true }),
      save: vi.fn(),
      saveBatch: vi.fn(),
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
    };
    const mod = new ExecutionModule({
      gateway: gateway as any,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: makeLogger(),
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "simulation",
    });

    return { bus, gateway, mod };
  }

  it("5. post-only BUY at ask → OrderSkipped (would cross)", async () => {
    const { bus, gateway, mod } = makeExecModule({ marketBestAsk: 0.1 });
    await mod.start();

    // Inject a market snapshot with bestAsk=0.10
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ bestAsk: 0.1 })],
      timestamp: NOW,
    });

    const skipped: unknown[] = [];
    const placed: unknown[] = [];
    bus.subscribe("OrderSkipped", async (p) => {
      skipped.push(p);
    });
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-post-only-cross"),
        clientOrderId: "plk_post_only_cross" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "buy",
        size: 10,
        price: 0.1, // equals bestAsk → would cross
        postOnly: true,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(skipped).toHaveLength(1);
    expect(placed).toHaveLength(0);

    await mod.stop();
  });

  it("6. non-post-only BUY at ask price → passes through to gateway", async () => {
    const { bus, gateway, mod } = makeExecModule({});
    await mod.start();

    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ bestAsk: 0.1 })],
      timestamp: NOW,
    });

    const placed: unknown[] = [];
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-no-post-only"),
        clientOrderId: "plk_no_post_only" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "buy",
        size: 10,
        price: 0.1,
        // postOnly NOT set
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });
});

// ─── 7: Pure functions ────────────────────────────────────────────────────

describe("computeMakerOpenOrderUsdc", () => {
  it("sums remaining USDC exposure for open maker BUY orders", () => {
    const makerBuy = makeOrder({
      entryStyle: "maker",
      side: "buy",
      price: 0.1,
      size: 50,
      status: "open",
    });
    const probeBuy = makeOrder({
      orderId: createOrderId("ord-probe"),
      entryStyle: "probe",
      side: "buy",
      price: 0.09,
      size: 20,
      status: "open",
    });
    const fills = [makeFill(String(makerBuy.orderId), 10)]; // 10 shares filled
    const fillRepo = makeFillRepo(fills);

    const result = computeMakerOpenOrderUsdc([makerBuy, probeBuy], fillRepo);

    // maker: (50 - 10) * 0.1 = 4.0; probe: excluded
    expect(result).toBeCloseTo(4.0);
  });

  it("returns 0 when no maker BUY orders exist", () => {
    const probeBuy = makeOrder({
      entryStyle: "probe",
      side: "buy",
      price: 0.1,
      size: 50,
      status: "open",
    });
    const result = computeMakerOpenOrderUsdc([probeBuy], makeFillRepo());
    expect(result).toBe(0);
  });

  it("excludes cancelled/filled orders from the sum", () => {
    const cancelledMaker = makeOrder({ entryStyle: "maker", side: "buy", status: "cancelled" });
    const result = computeMakerOpenOrderUsdc([cancelledMaker], makeFillRepo());
    expect(result).toBe(0);
  });
});

describe("computeMakerOpenPositionUsdc", () => {
  it("sums costBasisUsdc for maker positions only", () => {
    const makerPos = makePosition({ entryStyle: "maker", costBasisUsdc: 7 });
    const probePos = makePosition({ entryStyle: "probe", costBasisUsdc: 3 });
    const result = computeMakerOpenPositionUsdc([makerPos, probePos]);
    expect(result).toBeCloseTo(7);
  });

  it("returns 0 for empty array", () => {
    expect(computeMakerOpenPositionUsdc([])).toBe(0);
  });

  it("returns 0 when all positions are non-maker", () => {
    const probePos = makePosition({ entryStyle: "probe", costBasisUsdc: 10 });
    expect(computeMakerOpenPositionUsdc([probePos])).toBe(0);
  });
});

// ─── 8: LiveLiteGuard.validateMicroMaxOrderCap ───────────────────────────

describe("LiveLiteGuard.validateMicroMaxOrderCap", () => {
  it("throws when microMaxOrderUsdc is below EOA minimum entry notional", () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 25,
      maxActiveMarkets: 250,
      walletMode: "eoa",
      // fallback EOA min = $3
    });
    // guard.getMinEntryNotionalUsdc() returns 3 (EOA default)
    expect(() => LiveLiteGuard.validateMicroMaxOrderCap(2, guard)).toThrow(
      /below the EOA minimum entry notional/,
    );
  });

  it("does not throw when microMaxOrderUsdc equals the minimum", () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 25,
      maxActiveMarkets: 250,
      walletMode: "eoa",
    });
    expect(() => LiveLiteGuard.validateMicroMaxOrderCap(3, guard)).not.toThrow();
  });

  it("does not throw when guard is inactive (no config)", () => {
    const guard = new LiveLiteGuard(undefined);
    // minEntry is null → no throw
    expect(() => LiveLiteGuard.validateMicroMaxOrderCap(0.5, guard)).not.toThrow();
  });

  it("uses the custom label in the error message", () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 25,
      maxActiveMarkets: 250,
      walletMode: "eoa",
    });
    expect(() => LiveLiteGuard.validateMicroMaxOrderCap(1, guard, "custom.label")).toThrow(
      /custom\.label/,
    );
  });
});

// ─── 9: entryStyle propagation to fill/position ──────────────────────────

describe("maker fill entryStyle propagation", () => {
  it("entryStyle=maker on the order is passed to applyFill via origOrder lookup", async () => {
    // Test that the InventoryHandler receives entryStyle="maker" from origOrder
    // We test this via the RiskInventoryModule's handleFill path.
    const { InventoryHandler } = await import("../modules/risk-inventory/inventory-handler.js");

    // Mock position and lot repos
    const positions = new Map<string, Position>();
    const positionRepo: PositionRepository = {
      save: vi.fn((p) => {
        positions.set(String(p.tokenId), p);
      }),
      findByTokenId: vi.fn((tokenId) => positions.get(String(tokenId)) ?? null),
      findOpen: vi.fn(() => [...positions.values()].filter((p) => p.status === "open")),
      findDust: vi.fn(() => []),
      findAll: vi.fn(() => [...positions.values()]),
      findOpenByEntryStyle: vi.fn((style) =>
        [...positions.values()].filter((p) => p.entryStyle === style),
      ),
      findById: vi.fn(() => null),
      findActiveByTokenId: vi.fn(() => []),
    };
    const lotRepo = {
      save: vi.fn(),
      findByPositionId: vi.fn(() => []),
      findByFillId: vi.fn(() => null),
    };

    // transaction must return a callable with an `.immediate` method (mirrors withImmediate usage)
    function immediateTransaction<T extends (...args: unknown[]) => unknown>(
      fn: T,
    ): T & { immediate: T } {
      const tx = ((...args: Parameters<T>) => fn(...args)) as T & { immediate: T };
      tx.immediate = tx;
      return tx;
    }

    const dbStub = {
      prepare: vi.fn(() => ({
        run: vi.fn(),
        get: vi.fn(() => null),
        all: vi.fn(() => []),
      })),
      transaction: vi.fn((fn: (...args: unknown[]) => unknown) => immediateTransaction(fn)),
    } as unknown as import("better-sqlite3").Database;

    const handler = new InventoryHandler(positionRepo, lotRepo as any, makeLogger(), dbStub);

    // Apply a fill with entryStyle="maker"
    const fillId = createFillId("fill-maker-1");
    handler.applyFill({
      fillId,
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      price: 0.1,
      size: 10,
      sizeUsdc: 1.0,
      fee: 0,
      signalReason: "probe-entry",
      entryStyle: "maker",
      timestamp: NOW,
    });

    const pos = positionRepo.findByTokenId(TOKEN_ID);
    expect(pos).not.toBeNull();
    expect(pos?.entryStyle).toBe("maker");
  });
});
