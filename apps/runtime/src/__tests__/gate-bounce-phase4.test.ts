/**
 * Phase 4 (docs/plans/2026-07-15-gate-bounce-live-experiment.md) tests:
 * real maker SELL placement for the bounce-exit target + enforced GATE
 * micro cap.
 *
 * Covers:
 *  1. GATE BUY notional clamped to gateEntry.microMaxOrderUsdc at sizing
 *     (signal-to-order.ts).
 *  2. BOUNCE_EXIT_TARGET → postOnly maker command at the harvest-target
 *     price, NOT clamped by the generic 1.17x plankton sell-cap (avgEntry
 *     = 0.15 case), confirming resolveActionPrice's override is honoured.
 *  3. BOUNCE_EXIT_TIMEOUT → cancels the resting target order, then submits
 *     the taker exit for the remainder (cancel-before-place sequencing).
 *     Includes regression guards (Codex review, post-Phase-4, two rounds) for
 *     business-logic guards that could otherwise silently drop the guaranteed
 *     4h force-exit: the same-price "acceptable price already open" guard,
 *     the taker-below-margin invariant, and the sell-price-below-signal-floor
 *     guard. None of these may short-circuit BOUNCE_EXIT_TIMEOUT.
 *  4. ExecutionModule: GATE BUY execution-side rejection above the cap,
 *     pass-through at/under the cap, and default-OFF safety (mode!=="micro_live"
 *     never rejects via the GATE path).
 *  5. ExecutionModule: a post-only BOUNCE_EXIT_TARGET that would cross the
 *     bid is skipped (reprice next tick); BOUNCE_EXIT_TIMEOUT bypasses the
 *     generic sell-replacement gating even when a stale resting order is
 *     still visible in orderRepo (still force-exits).
 */

import { describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  BOUNCE_EXIT_TARGET_RULE_ID,
  BOUNCE_EXIT_TIMEOUT_RULE_ID,
  GATE_ENTRY_RULE_ID,
  computeHarvestTarget,
  createBotRunId,
  createCommandId,
  createConditionId,
  createOrderId,
  createTokenId,
  DEFAULT_EXECUTION_POLICY,
} from "@krabs/domain";
import type {
  ClientOrderId,
  ExecutionPolicy,
  FillRepository,
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

// ─── Shared constants ─────────────────────────────────────────────────────

const TOKEN_ID = createTokenId("tok-gate-bounce");
const COND_ID = createConditionId("cond-gate-bounce-1");
const BOT_RUN_ID = createBotRunId("test-run-gate-bounce");
const NOW = Date.parse("2026-07-15T10:00:00.000Z");

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
    slug: "test-gate-bounce-market",
    eventSlug: null,
    question: "Test gate/bounce market?",
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
    signalId: "sig-gate-bounce-1",
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    suggestedPrice: 0.09,
    suggestedSize: 100,
    suggestedSizeUsdc: 9,
    reason: "probe-entry",
    strategyTick: NOW,
    sequenceInTick: 0,
    decisionRuleId: GATE_ENTRY_RULE_ID,
    sizingRuleId: null,
    generatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function makeOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-bounce-target-1"),
    clientOrderId: "plk_bounce_target" as ClientOrderId,
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "sell",
    orderType: "GTC",
    price: 0.19,
    size: 50,
    sizeUsdc: 9.5,
    status: "open",
    exchangeOrderId: "ord-bounce-target-1",
    signalId: null,
    signalReason: "probe-entry",
    entryStyle: "maker",
    decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
    botRunId: BOT_RUN_ID,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  } as Order;
}

async function runBridge(
  signal: Signal,
  policyOverrides: Partial<ExecutionPolicy>,
  options?: {
    marketOverrides?: Partial<NormalizedMarket>;
    orderRepo?: Pick<OrderRepository, "findByTokenId">;
    positionRepo?: Pick<PositionRepository, "findByTokenId">;
  },
) {
  const bus = new InProcessEventBus();
  const bridge = new SignalToOrderBridge({
    bus,
    log: makeLogger(),
    liveLiteGuard: { getWalletMode: () => "eoa" } as never,
    policy: () => ({ ...DEFAULT_EXECUTION_POLICY, ...policyOverrides }),
    orderRepo: options?.orderRepo as unknown as OrderRepository | undefined,
    positionRepo: options?.positionRepo as unknown as PositionRepository | undefined,
    now: () => NOW,
  });
  bridge.subscribe();

  const placed: PlaceOrderCommand[] = [];
  const cancelled: unknown[] = [];
  const skipped: unknown[] = [];
  bus.subscribe("PlaceOrderRequested", async (p) => {
    placed.push(p.command);
  });
  bus.subscribe("CancelOrderRequested", async (p) => {
    cancelled.push(p.command);
  });
  bus.subscribe("SignalConversionSkipped", async (p) => {
    skipped.push(p);
  });

  await bus.publish("SignalApproved", {
    signal,
    market: makeMarket(options?.marketOverrides),
    approvedAt: NOW,
  });

  return { placed, cancelled, skipped };
}

// ─── 1: GATE BUY micro cap — sizing (signal-to-order.ts) ─────────────────

describe("SignalToOrderBridge — GATE BUY micro cap (sizing)", () => {
  it("clamps GATE BUY notional to gateEntry.microMaxOrderUsdc when suggestedSizeUsdc exceeds it", async () => {
    const gateEntry = { ...DEFAULT_EXECUTION_POLICY.gateEntry, microMaxOrderUsdc: 2 };
    // bestBid=0.09 (edge/bid-anchored default pricing) — suggestedSizeUsdc=100 would
    // otherwise resolve to size = 100/0.09 ≈ 1111 shares (~$100 notional).
    const signal = makeSignal({ suggestedSizeUsdc: 100, suggestedSize: 100 });
    const { placed, skipped } = await runBridge(signal, { gateEntry });

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    const notional = placed[0]!.size * placed[0]!.price;
    expect(notional).toBeLessThanOrEqual(2 + 1e-6);
    expect(notional).toBeCloseTo(2, 5);
  });

  it("does not clamp GATE BUY notional when already under the cap", async () => {
    const gateEntry = { ...DEFAULT_EXECUTION_POLICY.gateEntry, microMaxOrderUsdc: 2 };
    const signal = makeSignal({ suggestedSizeUsdc: 1, suggestedSize: 100 });
    const { placed } = await runBridge(signal, { gateEntry });

    expect(placed).toHaveLength(1);
    // 1 USDC / bestBid(0.09) ≈ 11.11 shares, well under any cap-derived size.
    expect(placed[0]!.size).toBeCloseTo(1 / 0.09, 2);
  });

  it("leaves non-GATE BUY signals uncapped by gateEntry.microMaxOrderUsdc", async () => {
    const gateEntry = { ...DEFAULT_EXECUTION_POLICY.gateEntry, microMaxOrderUsdc: 2 };
    const signal = makeSignal({
      decisionRuleId: "SOME_OTHER_RULE",
      suggestedSizeUsdc: 100,
      suggestedSize: 100,
    });
    const { placed } = await runBridge(signal, { gateEntry });

    expect(placed).toHaveLength(1);
    const notional = placed[0]!.size * placed[0]!.price;
    expect(notional).toBeGreaterThan(2);
  });
});

// ─── 2: BOUNCE_EXIT_TARGET postOnly maker command + sell-cap bypass ──────

describe("SignalToOrderBridge — BOUNCE_EXIT_TARGET maker command", () => {
  it("places a postOnly maker SELL at the harvest-target price, not clamped by the 1.17x sell cap", async () => {
    const avgEntry = 0.15;
    const targetGainPct = 0.257;
    const tickSize = 0.01;
    const targetPrice = computeHarvestTarget(avgEntry, targetGainPct, tickSize);
    // Sanity: the generic plankton sell-cap tier for avgEntry=0.15 is a 1.17x
    // markup ceiling (floorToTick(0.15 * 1.17, 0.01) = 0.17), strictly below
    // the 0.257 harvest target (0.19) — proves the two are different and a
    // real bypass is required for the assertion below to be meaningful.
    expect(targetPrice).toBeCloseTo(0.19, 5);

    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: targetPrice,
      suggestedSize: 50,
      suggestedSizeUsdc: 50 * targetPrice,
    });
    const bounceExit = { ...DEFAULT_EXECUTION_POLICY.bounceExit, mode: "micro_live" as const };
    const { placed, skipped } = await runBridge(signal, { bounceExit }, {
      marketOverrides: { bestBid: 0.15, bestAsk: 0.3, midPrice: 0.2 },
    });

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.postOnly).toBe(true);
    expect(placed[0]!.entryStyle).toBe("maker");
    expect(placed[0]!.price).toBeCloseTo(targetPrice, 5);
    // above the would-be 1.17x tier cap: floorToTick(0.15 * 1.17, 0.01) = 0.17
    expect(placed[0]!.price).toBeGreaterThan(0.17);
  });
});

// ─── 3: BOUNCE_EXIT_TIMEOUT cancel-then-taker ─────────────────────────────

describe("SignalToOrderBridge — BOUNCE_EXIT_TIMEOUT cancel-then-taker", () => {
  it("cancels the resting BOUNCE_EXIT_TARGET order, then submits a non-postOnly taker exit", async () => {
    const restingTarget = makeOrder();
    const orderRepo = {
      findByTokenId: vi.fn().mockReturnValue([restingTarget]),
    };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TIMEOUT_RULE_ID,
      suggestedPrice: 0.09,
      suggestedSize: 50,
      suggestedSizeUsdc: 50 * 0.09,
    });
    const { placed, cancelled, skipped } = await runBridge(
      signal,
      {},
      { marketOverrides: { bestBid: 0.09, bestAsk: 0.12 }, orderRepo },
    );

    expect(skipped).toHaveLength(0);
    expect(cancelled).toHaveLength(1);
    expect((cancelled[0] as { orderId: unknown; reason: string }).orderId).toBe(
      restingTarget.orderId,
    );
    expect((cancelled[0] as { reason: string }).reason).toBe("sell_timeout_escalation");

    expect(placed).toHaveLength(1);
    expect(placed[0]!.price).toBeCloseTo(0.09, 5);
    expect(placed[0]!.postOnly).not.toBe(true);
    expect(placed[0]!.entryStyle).not.toBe("maker");
  });

  it("still cancels-and-taker-exits when the resting target price is within the same-price tolerance window of bestBid (Codex review fix)", async () => {
    // Repro: target=0.19, bestBid=0.18, tickSize=0.01 -> |0.19-0.18|=0.01 is
    // inside the default 2-tick (0.02) same-price window that
    // findSamePriceOpenSellOrder uses to detect "acceptable price already
    // open" duplicates. Before the fix, that guard treated the resting
    // BOUNCE_EXIT_TARGET order itself as such a duplicate and returned early,
    // so the cancel-then-taker block below never ran — silently defeating
    // the guaranteed 4h force-exit while the target sat near-but-above the bid.
    const restingTarget = makeOrder({ price: 0.19 });
    const orderRepo = {
      findByTokenId: vi.fn().mockReturnValue([restingTarget]),
    };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TIMEOUT_RULE_ID,
      suggestedPrice: 0.18,
      suggestedSize: 50,
      suggestedSizeUsdc: 50 * 0.18,
    });
    const { placed, cancelled, skipped } = await runBridge(
      signal,
      {},
      { marketOverrides: { bestBid: 0.18, bestAsk: 0.21, tickSize: 0.01 }, orderRepo },
    );

    expect(skipped).toHaveLength(0);
    expect(cancelled).toHaveLength(1);
    expect((cancelled[0] as { orderId: unknown; reason: string }).orderId).toBe(
      restingTarget.orderId,
    );
    expect((cancelled[0] as { reason: string }).reason).toBe("sell_timeout_escalation");

    expect(placed).toHaveLength(1);
    expect(placed[0]!.price).toBeCloseTo(0.18, 5);
    expect(placed[0]!.postOnly).not.toBe(true);
    expect(placed[0]!.entryStyle).not.toBe("maker");
  });

  it("still cancels-and-taker-exits when takerAtProfit is enabled and bestBid is below avgEntry*minGrossExitRatio (Codex round-2 fix)", async () => {
    // Repro: takerAtProfit.enabled=true, avgEntry=0.2, minGrossExitRatio=1.03
    // -> minExit=0.206; bestBid=0.15 is well below that, so
    // resolveTakerBelowMarginBlock would otherwise return "taker-below-margin"
    // and skip this signal, leaving the resting target order in place forever.
    const restingTarget = makeOrder({ price: 0.19 });
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([restingTarget]) };
    const positionRepo = {
      findByTokenId: vi.fn().mockReturnValue({ avgEntryPrice: 0.2, size: 50 } as Position),
    };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TIMEOUT_RULE_ID,
      suggestedPrice: 0.15,
      suggestedSize: 50,
      suggestedSizeUsdc: 50 * 0.15,
    });
    const takerAtProfit = { ...DEFAULT_EXECUTION_POLICY.takerAtProfit, enabled: true };
    const { placed, cancelled, skipped } = await runBridge(
      signal,
      { takerAtProfit },
      { marketOverrides: { bestBid: 0.15, bestAsk: 0.17 }, orderRepo, positionRepo },
    );

    expect(skipped).toHaveLength(0);
    expect(cancelled).toHaveLength(1);
    expect((cancelled[0] as { orderId: unknown; reason: string }).orderId).toBe(
      restingTarget.orderId,
    );
    expect(placed).toHaveLength(1);
    expect(placed[0]!.price).toBeCloseTo(0.15, 5);
  });

  it("still force-exits when bestBid is below signal.suggestedPrice*minExitPriceSignalRatio (Codex round-2 fix)", async () => {
    // Repro: suggestedPrice=0.3, default minExitPriceSignalRatio=0.5 -> floor
    // = 0.15; bestBid=0.1 is below that, so shouldSkipSellBelowSignalFloor
    // would otherwise return true and skip this signal via the
    // "sell-price-below-signal-floor" guard.
    const restingTarget = makeOrder({ price: 0.19 });
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([restingTarget]) };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TIMEOUT_RULE_ID,
      suggestedPrice: 0.3,
      suggestedSize: 50,
      suggestedSizeUsdc: 50 * 0.3,
    });
    const { placed, cancelled, skipped } = await runBridge(
      signal,
      {},
      { marketOverrides: { bestBid: 0.1, bestAsk: 0.12 }, orderRepo },
    );

    expect(skipped).toHaveLength(0);
    expect(cancelled).toHaveLength(1);
    expect((cancelled[0] as { orderId: unknown; reason: string }).orderId).toBe(
      restingTarget.orderId,
    );
    expect(placed).toHaveLength(1);
    expect(placed[0]!.price).toBeCloseTo(0.1, 5);
  });

  it("skips the cancel when no resting target order is open (no regression)", async () => {
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([]) };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TIMEOUT_RULE_ID,
      suggestedPrice: 0.09,
      suggestedSize: 50,
      suggestedSizeUsdc: 50 * 0.09,
    });
    const { placed, cancelled } = await runBridge(
      signal,
      {},
      { marketOverrides: { bestBid: 0.09, bestAsk: 0.12 }, orderRepo },
    );

    expect(cancelled).toHaveLength(0);
    expect(placed).toHaveLength(1);
  });
});

// ─── 4: ExecutionModule — GATE BUY micro cap (execution-side) ────────────

describe("ExecutionModule — GATE BUY micro cap", () => {
  function makeExecModule(executionPolicy?: () => ExecutionPolicy) {
    const bus = new InProcessEventBus();
    const gateway = {
      placeOrder: vi.fn().mockResolvedValue({ success: true, orderId: "sim-ord-1" }),
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
      executionPolicy,
    });

    return { bus, gateway, mod, orderRepo };
  }

  function makeGateBuyCmd(overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
    return {
      type: "PlaceOrderCommand",
      commandId: createCommandId("cmd-gate-buy"),
      clientOrderId: "plk_gate_buy" as ClientOrderId,
      source: "strategy",
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      size: 20,
      price: 0.1, // notional = 2.0 at default size
      orderType: "GTC",
      tickSize: 0.01,
      negRisk: false,
      sequenceInTick: 0,
      signalReason: "probe-entry",
      decisionRuleId: GATE_ENTRY_RULE_ID,
      ...overrides,
    } satisfies PlaceOrderCommand;
  }

  it("rejects a GATE BUY above microMaxOrderUsdc when mode=micro_live", async () => {
    const { bus, gateway, mod } = makeExecModule(() => ({
      ...DEFAULT_EXECUTION_POLICY,
      gateEntry: { ...DEFAULT_EXECUTION_POLICY.gateEntry, mode: "micro_live", microMaxOrderUsdc: 2 },
    }));
    await mod.start();

    const rejected: unknown[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    // size=50 * price=0.1 = $5 notional, above the $2 cap.
    await bus.publish("PlaceOrderRequested", {
      command: makeGateBuyCmd({ size: 50 }),
      timestamp: NOW,
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { reason: string }).reason).toBe("gate-micro-order-cap-exceeded");

    await mod.stop();
  });

  it("passes a GATE BUY at/under microMaxOrderUsdc through to the gateway", async () => {
    const { bus, gateway, mod } = makeExecModule(() => ({
      ...DEFAULT_EXECUTION_POLICY,
      gateEntry: { ...DEFAULT_EXECUTION_POLICY.gateEntry, mode: "micro_live", microMaxOrderUsdc: 2 },
    }));
    await mod.start();

    const rejected: unknown[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    // size=20 * price=0.1 = $2 notional, at the cap.
    await bus.publish("PlaceOrderRequested", {
      command: makeGateBuyCmd({ size: 20 }),
      timestamp: NOW,
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("does not enforce the GATE cap when gateEntry.mode is not micro_live (default-OFF safety)", async () => {
    const { bus, gateway, mod } = makeExecModule(() => ({
      ...DEFAULT_EXECUTION_POLICY,
      gateEntry: { ...DEFAULT_EXECUTION_POLICY.gateEntry, mode: "off", microMaxOrderUsdc: 2 },
    }));
    await mod.start();

    const rejected: unknown[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    // size=50 * price=0.1 = $5 notional, above the $2 cap, but mode=off.
    await bus.publish("PlaceOrderRequested", {
      command: makeGateBuyCmd({ size: 50 }),
      timestamp: NOW,
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    await mod.stop();
  });
});

// ─── 5: ExecutionModule — post-only cross skip + timeout force-exit ──────

describe("ExecutionModule — BOUNCE_EXIT_TARGET / BOUNCE_EXIT_TIMEOUT execution behavior", () => {
  function makeExecModule(
    orderRepoOverrides?: Partial<OrderRepository>,
    positionRepo?: Pick<PositionRepository, "findByTokenId">,
  ) {
    const bus = new InProcessEventBus();
    const gateway = {
      placeOrder: vi.fn().mockResolvedValue({ success: true, orderId: "sim-ord-1" }),
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
      ...orderRepoOverrides,
    } as OrderRepository;
    const fillRepo = {
      save: vi.fn(),
      exists: vi.fn().mockReturnValue(false),
      findByOrderId: vi.fn().mockReturnValue([]),
      findByOrderIds: vi.fn().mockReturnValue([]),
      findByTokenId: vi.fn().mockReturnValue([]),
      findRecent: vi.fn().mockReturnValue([]),
      findUnreconciled: vi.fn().mockReturnValue([]),
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
      positionRepo: positionRepo as unknown as PositionRepository | undefined,
      log: makeLogger(),
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "simulation",
    });

    return { bus, gateway, mod, orderRepo };
  }

  it("skips a postOnly BOUNCE_EXIT_TARGET command that would cross the live bestBid (reprice next tick)", async () => {
    const { bus, gateway, mod } = makeExecModule();
    await mod.start();

    // A resting SELL crosses the book when its price is at/below the current
    // best bid (it would immediately match a resting BUY), not the ask side.
    await bus.publish("NormalizedMarketUpdated", {
      markets: [makeMarket({ bestBid: 0.19, bestAsk: 0.2 })],
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
        commandId: createCommandId("cmd-bounce-target-cross"),
        clientOrderId: "plk_bounce_target_cross" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50,
        price: 0.19, // equals bestBid -> would cross
        postOnly: true,
        entryStyle: "maker",
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(skipped).toHaveLength(1);
    expect(placed).toHaveLength(0);

    await mod.stop();
  });

  it("still force-exits a BOUNCE_EXIT_TIMEOUT taker command even when a stale resting sell order is still visible locally", async () => {
    // Simulates the race the M6 bypass is designed for: signal-to-order.ts
    // published the cancel for the resting target, but orderRepo hasn't
    // caught up yet — this order is still returned as "open". Without the
    // bypass, deferSellReplacementIfNeeded's generic reprice-threshold/lock
    // path would hold this taker command back; the bypass must let it
    // through unconditionally for BOUNCE_EXIT_TIMEOUT_RULE_ID.
    const staleRestingOrder = makeOrder();
    const { bus, gateway, mod } = makeExecModule({
      findByTokenId: vi.fn().mockReturnValue([staleRestingOrder]),
    });
    await mod.start();

    const placed: unknown[] = [];
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-timeout-taker"),
        clientOrderId: "plk_bounce_timeout_taker" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50,
        price: 0.09,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: BOUNCE_EXIT_TIMEOUT_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  it("does not reject a BOUNCE_EXIT_TIMEOUT full-position taker SELL as reserved-token-limit while its own resting BOUNCE_EXIT_TARGET is still visible in orderRepo", async () => {
    // Reproduces the FIX A race: signal-to-order.ts publishes CancelOrderRequested
    // for the resting target, then immediately publishes the timeout taker
    // PlaceOrderRequested. The cancel is processed asynchronously, so orderRepo
    // still returns the target as "open" when this reservation check runs.
    // Unlike the "stale resting order" test above (no positionRepo configured,
    // which short-circuits the whole reservation check), this test wires a real
    // GATE position + orderRepo.findOpen() so the reserved-token-limit math is
    // actually exercised — the resting target's size must NOT double-count
    // against the timeout's own full-position SELL.
    const gatePosition = {
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      status: "open",
      size: 50,
      avgEntryPrice: 0.15,
      entryLane: "GATE",
    } as Position;
    const restingTargetOrder = makeOrder({ size: 50, status: "open" });
    const { bus, gateway, mod } = makeExecModule(
      { findOpen: vi.fn().mockReturnValue([restingTargetOrder]) },
      { findByTokenId: vi.fn().mockReturnValue(gatePosition) },
    );
    await mod.start();

    const placed: unknown[] = [];
    const rejected: unknown[] = [];
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-timeout-taker-reserved"),
        clientOrderId: "plk_bounce_timeout_taker_reserved" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50,
        price: 0.09,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: BOUNCE_EXIT_TIMEOUT_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });
});
