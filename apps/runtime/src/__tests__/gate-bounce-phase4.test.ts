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
 *  3. BOUNCE_EXIT_BACKSTOP → cancels the resting target order, then submits
 *     the taker exit for the remainder (cancel-before-place sequencing).
 *     Includes regression guards (Codex review, post-Phase-4, two rounds) for
 *     business-logic guards that could otherwise silently drop the guaranteed
 *     backstop force-exit: the same-price "acceptable price already open" guard,
 *     the taker-below-margin invariant, and the sell-price-below-signal-floor
 *     guard. None of these may short-circuit BOUNCE_EXIT_BACKSTOP.
 *  4. ExecutionModule: GATE BUY execution-side rejection above the cap,
 *     pass-through at/under the cap, and default-OFF safety (mode!=="micro_live"
 *     never rejects via the GATE path).
 *  5. ExecutionModule: a post-only BOUNCE_EXIT_TARGET that would cross the
 *     bid is skipped (reprice next tick); BOUNCE_EXIT_BACKSTOP bypasses the
 *     generic sell-replacement gating even when a stale resting order is
 *     still visible in orderRepo (still force-exits).
 */

import { describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  BOUNCE_EXIT_TARGET_RULE_ID,
  BOUNCE_EXIT_BACKSTOP_RULE_ID,
  GATE_ENTRY_RULE_ID,
  computeHarvestTarget,
  createBotRunId,
  createCommandId,
  createConditionId,
  createFillId,
  createLotId,
  createOrderId,
  createPositionId,
  createTokenId,
  DEFAULT_EXECUTION_POLICY,
} from "@krabs/domain";
import type {
  ClientOrderId,
  ExecutionPolicy,
  FillRepository,
  InventoryLotRepository,
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
import { ExchangeStateStore } from "../modules/execution/exchange-state-store.js";
import { LiveLiteGuard } from "../live-lite-guard.js";

// ─── Shared constants ─────────────────────────────────────────────────────

const TOKEN_ID = createTokenId("tok-gate-bounce");
const OTHER_TOKEN_ID = createTokenId("tok-gate-bounce-other");
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

// Exit-loss-floor gate (docs/plans/2026-07-20-exit-loss-floor.md) fails closed
// whenever a SELL's positionRepo/inventoryLotRepo is missing or inconsistent.
// A generous, low-cost-basis default position (well above every command size
// and submitted price used in this file's ExecutionModule describe block)
// keeps normal SELLs comfortably clear of both the FIFO-consistency checks
// and the loss-fraction threshold, without individual tests needing to
// hand-roll a position just to satisfy the gate.
function makeGatePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: createPositionId("pos-gate-bounce-default"),
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    size: 1000,
    avgEntryPrice: 0.05,
    costBasisUsdc: 1000 * 0.05,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    entryStyle: "maker",
    entryLane: "GATE",
    openedAt: new Date(NOW).toISOString(),
    closedAt: null,
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

// Single lot spanning the whole position (remainingSize=size,
// entryPrice=costBasisUsdc/size) satisfies both the FIFO-sufficiency check
// and the cost-consistency check (findOpen ignores its positionId argument,
// so this is safe even for partial/legacy Position literals in this file
// that omit positionId).
function makeInventoryLotRepoForPosition(position: Position): InventoryLotRepository {
  const lot = {
    lotId: createLotId(`lot-${String(position.positionId ?? position.tokenId)}`),
    positionId: position.positionId,
    tokenId: position.tokenId,
    side: position.side ?? "buy",
    size: position.size,
    remainingSize: position.size,
    entryPrice: position.costBasisUsdc / position.size,
    costUsdc: position.costBasisUsdc,
    fillId: createFillId(`fill-${String(position.positionId ?? position.tokenId)}`),
    createdAt: position.openedAt ?? new Date(NOW).toISOString(),
  };
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([lot]),
    findOpen: vi.fn().mockReturnValue([lot]),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
}

async function runBridge(
  signal: Signal,
  policyOverrides: Partial<ExecutionPolicy>,
  options?: {
    marketOverrides?: Partial<NormalizedMarket>;
    orderRepo?: Pick<OrderRepository, "findByTokenId">;
    positionRepo?: Pick<PositionRepository, "findByTokenId">;
    inventoryLotRepo?: InventoryLotRepository;
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
    inventoryLotRepo: options?.inventoryLotRepo,
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
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      {
        marketOverrides: { bestBid: 0.15, bestAsk: 0.3, midPrice: 0.2 },
      },
    );

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.postOnly).toBe(true);
    expect(placed[0]!.entryStyle).toBe("maker");
    expect(placed[0]!.price).toBeCloseTo(targetPrice, 5);
    // above the would-be 1.17x tier cap: floorToTick(0.15 * 1.17, 0.01) = 0.17
    expect(placed[0]!.price).toBeGreaterThan(0.17);
  });
});

// ─── 2b: bounce ladder rung identity guard + rollover-vs-cap (Codex Phase-2 fixes) ──

describe("SignalToOrderBridge — bounce rung duplicate guard scoped to ladderId+rungIndex (FIX 3)", () => {
  it("places rung1 even though its price exactly matches an already-resting, different-rungIndex rung0 order", async () => {
    const ladderId = "tok-gate-bounce:1000";
    const restingRung0 = makeOrder({
      price: 0.15,
      status: "open",
      metadata: { bounceRung: { ladderId, rungIndex: 0, anchorPrice: 0.1, fraction: 0.3 } },
    });
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([restingRung0]) };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: 0.15,
      suggestedSize: 40,
      suggestedSizeUsdc: 40 * 0.15,
      bounceRung: {
        ladderId,
        rungIndex: 1,
        anchorPrice: 0.1,
        fraction: 0.4,
        originalPositionSize: 100,
        remainingPositionSize: 70,
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 100,
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      { marketOverrides: { bestBid: 0.1, bestAsk: 0.2, tickSize: 0.01 }, orderRepo },
    );

    // Pre-fix, the generic same-price guard would have matched rung0's still-
    // open order (identical price) and silently dropped rung1 forever, since
    // its metadata is never persisted for the planner's placedBounceRungIndices
    // lookup to see next cycle.
    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.price).toBeCloseTo(0.15, 5);
    expect((placed[0]!.metadata?.bounceRung as { rungIndex: number } | undefined)?.rungIndex).toBe(
      1,
    );
  });

  it("still treats a resting order for the SAME rungIndex as a true duplicate (no regression)", async () => {
    const ladderId = "tok-gate-bounce:1000";
    const restingRung1 = makeOrder({
      price: 0.15,
      status: "open",
      metadata: { bounceRung: { ladderId, rungIndex: 1, anchorPrice: 0.1, fraction: 0.4 } },
    });
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([restingRung1]) };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: 0.15,
      suggestedSize: 40,
      suggestedSizeUsdc: 40 * 0.15,
      bounceRung: {
        ladderId,
        rungIndex: 1,
        anchorPrice: 0.1,
        fraction: 0.4,
        originalPositionSize: 100,
        remainingPositionSize: 70,
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 100,
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      { marketOverrides: { bestBid: 0.1, bestAsk: 0.2, tickSize: 0.01 }, orderRepo },
    );

    // A true same-rungIndex duplicate (fresh resting order, same size) still
    // falls into the existing "acceptable price already open" skip branch —
    // the identity-scoped guard must not turn into a no-op that re-places
    // every rung on every tick.
    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect((skipped[0] as { reasons: string[] }).reasons).toContain(
      "sell-order-acceptable-price-already-open",
    );
  });

  // Codex C2 fix (docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md):
  // the residual-driven "cleanup" rung deliberately reuses the LAST
  // configured rung's own index, which the ordinary ladder already marks
  // "placed" — the generic ladderId+rungIndex duplicate check must not treat
  // that pre-existing (unrelated) order as a collision, or the cleanup rung
  // would never place.
  it("places a cleanup rung (isCleanupRung) even though its reused rungIndex matches an already-resting ORDINARY rung at that index", async () => {
    const ladderId = "tok-gate-bounce:4000";
    const restingRung2 = makeOrder({
      price: 0.18,
      status: "open",
      metadata: { bounceRung: { ladderId, rungIndex: 2, anchorPrice: 0.1, fraction: 0.3 } },
    });
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([restingRung2]) };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: 0.18,
      suggestedSize: 30,
      suggestedSizeUsdc: 30 * 0.18,
      bounceRung: {
        ladderId,
        rungIndex: 2,
        anchorPrice: 0.1,
        fraction: 0.3,
        originalPositionSize: 100,
        remainingPositionSize: 30,
        uncommittedRemainder: 30,
        isCleanupRung: true,
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 100,
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      { marketOverrides: { bestBid: 0.1, bestAsk: 0.2, tickSize: 0.01 }, orderRepo },
    );

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(
      (placed[0]!.metadata?.bounceRung as { isCleanupRung?: boolean } | undefined)?.isCleanupRung,
    ).toBe(true);
  });

  // A cleanup rung is still a duplicate of ANOTHER already-resting cleanup
  // rung at the same ladder — "only one cleanup rung open at a time" must
  // still be enforced, the C2 fix only exempts the reused-index collision.
  it("still treats an already-resting CLEANUP rung as a true duplicate of a new cleanup rung on the same ladder", async () => {
    const ladderId = "tok-gate-bounce:4001";
    const restingCleanup = makeOrder({
      price: 0.18,
      status: "open",
      metadata: {
        bounceRung: {
          ladderId,
          rungIndex: 2,
          anchorPrice: 0.1,
          fraction: 0.3,
          isCleanupRung: true,
        },
      },
    });
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([restingCleanup]) };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: 0.18,
      suggestedSize: 30,
      suggestedSizeUsdc: 30 * 0.18,
      bounceRung: {
        ladderId,
        rungIndex: 2,
        anchorPrice: 0.1,
        fraction: 0.3,
        originalPositionSize: 100,
        remainingPositionSize: 30,
        uncommittedRemainder: 30,
        isCleanupRung: true,
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 100,
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      { marketOverrides: { bestBid: 0.1, bestAsk: 0.2, tickSize: 0.01 }, orderRepo },
    );

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect((skipped[0] as { reasons: string[] }).reasons).toContain(
      "sell-order-acceptable-price-already-open",
    );
  });

  // Codex r2 fix: a TERMINAL (filled) cleanup rung is NOT a duplicate. The
  // reconciler can mark a cleanup filled with a within-tolerance shortfall,
  // leaving a real >=min residual; a fresh cleanup for that residual must NOT
  // be suppressed as a "duplicate" of the already-filled one (else the residual
  // is stranded forever).
  it("does NOT treat an already-FILLED cleanup rung as a duplicate — a fresh cleanup for the leftover residual places", async () => {
    const ladderId = "tok-gate-bounce:4003";
    const filledCleanup = makeOrder({
      price: 0.18,
      status: "filled", // terminal — reconciler marked it filled within shortfall tolerance
      metadata: {
        bounceRung: {
          ladderId,
          rungIndex: 2,
          anchorPrice: 0.1,
          fraction: 0.3,
          isCleanupRung: true,
        },
      },
    });
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([filledCleanup]) };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: 0.18,
      suggestedSize: 30,
      suggestedSizeUsdc: 30 * 0.18,
      bounceRung: {
        ladderId,
        rungIndex: 2,
        anchorPrice: 0.1,
        fraction: 0.3,
        originalPositionSize: 100,
        remainingPositionSize: 30,
        uncommittedRemainder: 30,
        isCleanupRung: true,
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 100,
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      { marketOverrides: { bestBid: 0.1, bestAsk: 0.2, tickSize: 0.01 }, orderRepo },
    );

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(
      (placed[0]!.metadata?.bounceRung as { isCleanupRung?: boolean } | undefined)?.isCleanupRung,
    ).toBe(true);
  });

  // Codex C2 fix, bridge-side half: the cleanup rung is deliberately sized to
  // clear the ladder's fill-aware residual in one shot — the bridge's own
  // bounceExit.microMaxOrderUsdc soft cap must not fragment it back down.
  it("does not shrink a cleanup rung below its residual size via the bridge's own micro cap", async () => {
    const ladderId = "tok-gate-bounce:4002";
    const price = 0.18;
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: price,
      suggestedSize: 30,
      suggestedSizeUsdc: 30 * price,
      bounceRung: {
        ladderId,
        rungIndex: 2,
        anchorPrice: 0.1,
        fraction: 0.3,
        originalPositionSize: 100,
        remainingPositionSize: 30,
        uncommittedRemainder: 30,
        isCleanupRung: true,
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 2, // 30 * 0.18 = $5.40 notional, far above this cap
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      { marketOverrides: { bestBid: 0.1, bestAsk: 0.2, tickSize: 0.01, minOrderSize: 5 } },
    );

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.size).toBeCloseTo(30, 5);
  });
});

describe("SignalToOrderBridge — bounce ladder rollover re-checked against the micro cap (FIX 4)", () => {
  it("skips a min-order rollover merge whose notional still exceeds bounceExit.microMaxOrderUsdc", async () => {
    const ladderId = "tok-gate-bounce:2000";
    const price = 0.15;
    // rung0 alone: fraction 0.3 * original(100) = 30 shares. The pre-rollover
    // $2 cap (microMaxOrderUsdc=2) clamps that down to 2/0.15 ≈ 13.33 shares,
    // which is below market.minOrderSize=50 -> rollover triggers. Merging
    // rung0+rung1 (cumulative fraction 0.7) yields 70 shares, which clears the
    // 50-share exchange floor, but at $0.15/share that is $10.50 notional —
    // far above the $2 cap. Pre-fix, this over-cap merged order would have
    // been placed anyway (the cap was only checked pre-rollover).
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: price,
      suggestedSize: 30,
      suggestedSizeUsdc: 30 * price,
      bounceRung: {
        ladderId,
        rungIndex: 0,
        anchorPrice: 0.1,
        fraction: 0.3,
        originalPositionSize: 100,
        remainingPositionSize: 100,
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 2,
      ladderFractions: [0.3, 0.4, 0.3],
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      {
        marketOverrides: {
          bestBid: 0.1,
          bestAsk: 0.2,
          tickSize: 0.01,
          minOrderSize: 50,
        },
      },
    );

    expect(placed).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect((skipped[0] as { reasons: string[] }).reasons).toContain(
      "bounce-rollover-exceeds-micro-cap",
    );
  });

  it("still places the merge when the rolled-over notional clears the min-order floor within the cap", async () => {
    const ladderId = "tok-gate-bounce:2001";
    const price = 0.15;
    // Same rollover mechanics as above, but with a cap generous enough
    // ($20) that the merged 70-share / $10.50 order clears both the
    // exchange minimum and the micro cap — proves FIX 4 only skips
    // over-cap merges, not every rollover.
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: price,
      suggestedSize: 30,
      suggestedSizeUsdc: 30 * price,
      bounceRung: {
        ladderId,
        rungIndex: 0,
        anchorPrice: 0.1,
        fraction: 0.3,
        originalPositionSize: 100,
        remainingPositionSize: 100,
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 20,
      ladderFractions: [0.3, 0.4, 0.3],
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      {
        marketOverrides: {
          bestBid: 0.1,
          bestAsk: 0.2,
          tickSize: 0.01,
          minOrderSize: 50,
        },
      },
    );

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.size).toBeCloseTo(70, 5);
    expect(
      (placed[0]!.metadata?.bounceRung as { rungIndicesCovered?: number[] } | undefined)
        ?.rungIndicesCovered,
    ).toEqual([0, 1]);
  });

  // Codex H4 fix: decision-planner.ts carries the fill-aware
  // uncommittedRemainder on the rung metadata only when sellableFlow is on —
  // the rollover must prefer it over the leg-level remainingPositionSize so a
  // merge never expands past what is genuinely still uncommitted.
  it("caps a rollover merge to the fill-aware uncommittedRemainder, not the leg-level remainingPositionSize", async () => {
    const ladderId = "tok-gate-bounce:2002";
    const price = 0.15;
    // Same rollover mechanics as the tests above (fraction 0.3 alone is below
    // minOrderSize=50, so rung0+rung1 merge to cumulative fraction 0.7 = 70
    // shares against the leg-level remainingPositionSize=100), but here
    // uncommittedRemainder=60 (fill-aware, smaller) is also present. Pre-fix,
    // the rollover read remainingPositionSize (100) and would have merged to
    // 70 shares uncapped by the smaller fill-aware ceiling; the fix must cap
    // the merge to 60 instead.
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: price,
      suggestedSize: 30,
      suggestedSizeUsdc: 30 * price,
      bounceRung: {
        ladderId,
        rungIndex: 0,
        anchorPrice: 0.1,
        fraction: 0.3,
        originalPositionSize: 100,
        remainingPositionSize: 100,
        uncommittedRemainder: 60,
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 20,
      ladderFractions: [0.3, 0.4, 0.3],
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      {
        marketOverrides: {
          bestBid: 0.1,
          bestAsk: 0.2,
          tickSize: 0.01,
          minOrderSize: 50,
        },
      },
    );

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    // 70 (leg-level cap) would be the pre-H4-fix result — must be 60 (fill-aware).
    expect(placed[0]!.size).toBeCloseTo(60, 5);
    expect(
      (placed[0]!.metadata?.bounceRung as { rungIndicesCovered?: number[] } | undefined)
        ?.rungIndicesCovered,
    ).toEqual([0, 1]);
  });

  // Flag-off byte-identity companion: without uncommittedRemainder on the
  // metadata (the shape when sellableFlow is off — Codex H4 fix), the
  // rollover must fall back to the ORIGINAL leg-level remainingPositionSize
  // basis exactly as before, merging to 70 shares.
  it("falls back to the leg-level remainingPositionSize when uncommittedRemainder is absent from the metadata (sellableFlow off)", async () => {
    const ladderId = "tok-gate-bounce:2003";
    const price = 0.15;
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      suggestedPrice: price,
      suggestedSize: 30,
      suggestedSizeUsdc: 30 * price,
      bounceRung: {
        ladderId,
        rungIndex: 0,
        anchorPrice: 0.1,
        fraction: 0.3,
        originalPositionSize: 100,
        remainingPositionSize: 100,
        // uncommittedRemainder intentionally absent.
      },
    });
    const bounceExit = {
      ...DEFAULT_EXECUTION_POLICY.bounceExit,
      mode: "micro_live" as const,
      microMaxOrderUsdc: 20,
      ladderFractions: [0.3, 0.4, 0.3],
    };
    const { placed, skipped } = await runBridge(
      signal,
      { bounceExit },
      {
        marketOverrides: {
          bestBid: 0.1,
          bestAsk: 0.2,
          tickSize: 0.01,
          minOrderSize: 50,
        },
      },
    );

    expect(skipped).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.size).toBeCloseTo(70, 5);
  });
});

// ─── 3: BOUNCE_EXIT_BACKSTOP cancel-then-taker ────────────────────────────

describe("SignalToOrderBridge — BOUNCE_EXIT_BACKSTOP cancel-then-taker", () => {
  it("cancels the resting BOUNCE_EXIT_TARGET order, then submits a non-postOnly taker exit", async () => {
    const restingTarget = makeOrder();
    const orderRepo = {
      findByTokenId: vi.fn().mockReturnValue([restingTarget]),
    };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
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
    // Release A P7: the bridge no longer cancels rungs — the executor owns the
    // cancel+confirm transition. The bridge just publishes the backstop taker,
    // unblocked by the short-circuit guards.
    expect(cancelled).toHaveLength(0);

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
      decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
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
    // Release A P7: the bridge no longer cancels rungs — the executor owns the
    // cancel+confirm transition. The bridge just publishes the backstop taker,
    // unblocked by the short-circuit guards.
    expect(cancelled).toHaveLength(0);

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
      decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
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
    // Release A P7: cancel moved to the executor; the bridge only publishes the taker.
    expect(cancelled).toHaveLength(0);
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
      decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
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
    // Release A P7: cancel moved to the executor; the bridge only publishes the taker.
    expect(cancelled).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.price).toBeCloseTo(0.1, 5);
  });

  it("skips the cancel when no resting target order is open (no regression)", async () => {
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([]) };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
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

  it("cancels EVERY resting BOUNCE_EXIT_TARGET rung, not just the first, when the ladder has multiple simultaneously open (Phase 3 multi-rung)", async () => {
    const ladderId = "tok-gate-bounce:3000";
    const rung0 = makeOrder({
      orderId: createOrderId("ord-bounce-rung-0"),
      price: 0.15,
      metadata: { bounceRung: { ladderId, rungIndex: 0, anchorPrice: 0.1, fraction: 0.3 } },
    });
    const rung1 = makeOrder({
      orderId: createOrderId("ord-bounce-rung-1"),
      price: 0.18,
      metadata: { bounceRung: { ladderId, rungIndex: 1, anchorPrice: 0.1, fraction: 0.4 } },
    });
    const rung2 = makeOrder({
      orderId: createOrderId("ord-bounce-rung-2"),
      price: 0.21,
      metadata: { bounceRung: { ladderId, rungIndex: 2, anchorPrice: 0.1, fraction: 0.3 } },
    });
    const orderRepo = { findByTokenId: vi.fn().mockReturnValue([rung0, rung1, rung2]) };
    const signal = makeSignal({
      side: "sell",
      decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      suggestedPrice: 0.09,
      suggestedSize: 100,
      suggestedSizeUsdc: 100 * 0.09,
    });
    const { placed, cancelled, skipped } = await runBridge(
      signal,
      {},
      { marketOverrides: { bestBid: 0.09, bestAsk: 0.12 }, orderRepo },
    );

    // Release A P7: the bridge no longer cancels rungs on the same tick as the
    // taker — the executor's transition barrier cancels EVERY resting rung and
    // CONFIRMS them before the taker places (see the executor multi-rung test
    // below). The bridge only publishes the taker command.
    expect(skipped).toHaveLength(0);
    expect(cancelled).toHaveLength(0);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.postOnly).not.toBe(true);
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
      getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
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
      gateEntry: {
        ...DEFAULT_EXECUTION_POLICY.gateEntry,
        mode: "micro_live",
        microMaxOrderUsdc: 2,
      },
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
      gateEntry: {
        ...DEFAULT_EXECUTION_POLICY.gateEntry,
        mode: "micro_live",
        microMaxOrderUsdc: 2,
      },
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

// ─── 5: ExecutionModule — post-only cross skip + backstop force-exit ─────

describe("ExecutionModule — BOUNCE_EXIT_TARGET / BOUNCE_EXIT_BACKSTOP execution behavior", () => {
  function makeExecModule(
    orderRepoOverrides?: Partial<OrderRepository>,
    positionRepo?: Pick<PositionRepository, "findByTokenId">,
    executionPolicy?: () => ExecutionPolicy,
    exchangeStateStore?: ExchangeStateStore,
    liveLiteGuard?: LiveLiteGuard,
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
      getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
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
    // Exit-loss-floor gate (docs/plans/2026-07-20-exit-loss-floor.md) fails
    // closed without a position + consistent FIFO lots. Default to a generous
    // gate position when the test doesn't wire its own, and derive the
    // inventoryLotRepo from whatever positionRepo ends up in play so every
    // SELL fixture below gets consistent lots automatically.
    const resolvedPositionRepo: Pick<
      PositionRepository,
      "findByTokenId" | "findById" | "findActiveByTokenId"
    > = {
      findById: vi.fn(() => null),
      findActiveByTokenId: vi.fn(() => []),
      ...(positionRepo ?? { findByTokenId: vi.fn().mockReturnValue(makeGatePosition()) }),
    };
    const resolvedPosition = resolvedPositionRepo.findByTokenId(TOKEN_ID);
    const inventoryLotRepo = resolvedPosition
      ? makeInventoryLotRepoForPosition(resolvedPosition)
      : undefined;

    const mod = new ExecutionModule({
      gateway: gateway as any,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo: resolvedPositionRepo as unknown as PositionRepository,
      inventoryLotRepo,
      log: makeLogger(),
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      runtimeMode: "simulation",
      executionPolicy,
      exchangeStateStore,
      liveLiteGuard,
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

  it("defers a BOUNCE_EXIT_BACKSTOP taker and cancels the resting rung first when a cycle rung is still open (P7 confirm-then-place)", async () => {
    // Release A P7 rework (durable executor-owned B1): the backstop no longer
    // places on the SAME tick as a still-resting BOUNCE_EXIT_TARGET rung (that
    // race could leave dual orders on a failed cancel). The executor opens the P6
    // transition to cancel + CONFIRM the rung, records a durable deferred-intent
    // (`pendingBackstops`), and DEFERS this taker — the EXECUTOR ITSELF (not a
    // planner re-emission) places it once the token barrier reaches quiescent
    // (see the "confirms the rung then places the deferred backstop" test below
    // for the full confirm-then-place flow). So the rung is cancelled and the
    // taker does NOT place on this tick.
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
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    // Deferred, not placed: the transition cancels the rung; the taker holds.
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(placed).toHaveLength(0);
    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("confirms the drained rung then places the DEFERRED bounce backstop, resized from the authoritative wallet balance (P7 rework finding 2)", async () => {
    // Release A P7 rework (finding 2): once the P6 barrier confirms the rung
    // exchange-cancelled and closes, the EXECUTOR ITSELF — not a planner
    // re-emission — fires the durably-deferred backstop. It must be resized
    // from `getPositionBalance` (the authoritative remote residual), NOT the
    // stale local size (50) the original deferred command carried.
    const restingOrderId = createOrderId("ord-rung-confirm-1");
    let status: Order["status"] = "open";
    const restingOrder = (): Order => makeOrder({ orderId: restingOrderId, status });

    const { bus, gateway, mod } = makeExecModule({
      findById: vi.fn((id) => (String(id) === String(restingOrderId) ? restingOrder() : null)),
      findByTokenId: vi.fn(() => (status === "open" ? [restingOrder()] : [])),
      updateStatus: vi.fn((_id, newStatus) => {
        status = newStatus as Order["status"];
      }),
    });
    gateway.getPositionBalance.mockResolvedValue(37);
    await mod.start();

    const placed: unknown[] = [];
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-defer-confirm"),
        clientOrderId: "plk_bounce_defer_confirm" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50, // stale local residual — must NOT be what actually places
        price: 0.09,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    // The rung's cancel fires first; the barrier then closes once the cancel
    // is exchange-confirmed, and the executor's own deferred-intent hook
    // (placeDeferredBackstop) fires the resized taker. With this stateful
    // mock the whole chain (confirm → barrier close → reconcile → resubmit)
    // resolves within the same microtask chain the initial publish awaits —
    // `vi.waitFor` still guards against that timing being an implementation
    // detail rather than a contract.
    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(gateway.placeOrder).toHaveBeenCalledTimes(1));

    expect(gateway.getPositionBalance).toHaveBeenCalledWith(TOKEN_ID);
    expect(gateway.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: TOKEN_ID, side: "sell", size: 37 }),
    );
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  it("places the DEFERRED bounce backstop under a FRESH clientOrderId, never reusing the stale deferred command id (P7 round-4 anti-poisoning)", async () => {
    // Release A P7 (round-4 finding 1): a deferred retry must NOT reuse the
    // original command's stable clientOrderId — a prior REJECTED order with that
    // same id would poison every retry via the duplicate-clientOrderId gate,
    // leaving the drained position naked. Each deferred submit gets a fresh id
    // (buildClientOrderId with a `bounce-backstop:<token>:<uuid>` provenance), so
    // the re-emitted command's clientOrderId must differ from the deferred one.
    const restingOrderId = createOrderId("ord-rung-freshid-1");
    let status: Order["status"] = "open";
    const restingOrder = (): Order => makeOrder({ orderId: restingOrderId, status });

    const { bus, gateway, mod } = makeExecModule({
      findById: vi.fn((id) => (String(id) === String(restingOrderId) ? restingOrder() : null)),
      findByTokenId: vi.fn(() => (status === "open" ? [restingOrder()] : [])),
      updateStatus: vi.fn((_id, newStatus) => {
        status = newStatus as Order["status"];
      }),
    });
    gateway.getPositionBalance.mockResolvedValue(37);
    await mod.start();

    const STALE_DEFERRED_COID = "plk_bounce_defer_freshid" as ClientOrderId;
    const reEmitted: PlaceOrderCommand[] = [];
    bus.subscribe("PlaceOrderRequested", async (p) => {
      reEmitted.push(p.command as PlaceOrderCommand);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-defer-freshid"),
        clientOrderId: STALE_DEFERRED_COID,
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
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    await vi.waitFor(() => expect(gateway.placeOrder).toHaveBeenCalledTimes(1));

    // The executor's own deferred re-emission (the reconciled taker) must carry a
    // FRESH clientOrderId — never the stale deferred one, and never the original
    // command id either.
    const deferredReemit = reEmitted.find(
      (c) => c.decisionRuleId === BOUNCE_EXIT_BACKSTOP_RULE_ID && c.size === 37,
    );
    expect(deferredReemit).toBeDefined();
    expect(String(deferredReemit?.clientOrderId)).not.toBe(String(STALE_DEFERRED_COID));
    expect(String(deferredReemit?.commandId)).not.toBe("cmd-bounce-defer-freshid");
    // …and it is what actually reached the gateway.
    const gatewayArg = gateway.placeOrder.mock.calls[0]?.[0] as { clientOrderId?: unknown };
    expect(String(gatewayArg?.clientOrderId)).toBe(String(deferredReemit?.clientOrderId));

    await mod.stop();
  });

  it("HOLDS the deferred bounce backstop (no second taker) when a SELL already rests remotely, retaining the intent (P7 round-5 finding 4 — no double-exit on an UNKNOWN-landed order)", async () => {
    // Release A P7 (round-5 finding 4): a prior deferred submit may have landed on
    // the exchange with an UNKNOWN outcome (the live gateway never echoes
    // clientOrderId, so there is no exchange-side dedup). Before placing again the
    // executor reconciles open orders: if a SELL is already working remotely for the
    // token, it must HOLD — NOT fire a second full-residual taker (that would
    // double-exit) — and RETAIN the intent so it completes once that SELL fills
    // (→ residual gone) or persists locally (→ completion signal 1).
    const restingOrderId = createOrderId("ord-rung-remote-sell-1");
    let status: Order["status"] = "open";
    const restingOrder = (): Order => makeOrder({ orderId: restingOrderId, status });

    const { bus, gateway, mod } = makeExecModule({
      findById: vi.fn((id) => (String(id) === String(restingOrderId) ? restingOrder() : null)),
      findByTokenId: vi.fn(() => (status === "open" ? [restingOrder()] : [])),
      updateStatus: vi.fn((_id, newStatus) => {
        status = newStatus as Order["status"];
      }),
    });
    gateway.getPositionBalance.mockResolvedValue(37); // executable residual still remote
    // A SELL is already working remotely for this token (an UNKNOWN-landed prior taker).
    gateway.getOpenOrdersResult.mockResolvedValue({
      ok: true,
      data: [{ tokenId: TOKEN_ID, side: "sell", status: "OPEN" }],
    });
    await mod.start();

    const placed: unknown[] = [];
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-defer-remote-sell"),
        clientOrderId: "plk_bounce_defer_remote_sell" as ClientOrderId,
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
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);
    // The executor gets far enough to reconcile the wallet + open orders…
    await vi.waitFor(() => expect(gateway.getOpenOrdersResult).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // …then HOLDS: no second taker placed (the remote SELL covers the residual).
    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(placed).toHaveLength(0);

    await mod.stop();
  });

  it("DROPS the deferred bounce backstop when the authoritative wallet balance shows the rung already filled during drain (P7 rework finding 2 — no double-exit)", async () => {
    // Release A P7 rework (finding 2): a confirmed cancel does not guarantee
    // the rung was still outstanding — it may have filled moments before (or
    // raced) the cancel. The deferred backstop must reconcile against the
    // AUTHORITATIVE wallet balance before placing; if that residual is (near)
    // zero, the position is already fully closed, so the backstop must be
    // DROPPED — never re-armed, never placed — or it would double-exit.
    const restingOrderId = createOrderId("ord-rung-filled-during-drain");
    let status: Order["status"] = "open";
    const restingOrder = (): Order => makeOrder({ orderId: restingOrderId, status });

    const { bus, gateway, mod } = makeExecModule({
      findById: vi.fn((id) => (String(id) === String(restingOrderId) ? restingOrder() : null)),
      findByTokenId: vi.fn(() => (status === "open" ? [restingOrder()] : [])),
      updateStatus: vi.fn((_id, newStatus) => {
        status = newStatus as Order["status"];
      }),
    });
    gateway.getPositionBalance.mockResolvedValue(0); // rung already filled — nothing left to backstop
    await mod.start();

    const placed: unknown[] = [];
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-defer-drop"),
        clientOrderId: "plk_bounce_defer_drop" as ClientOrderId,
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
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.cancelOrder).toHaveBeenCalledTimes(1);

    // Wait for the deferred hook to actually reconcile against the wallet —
    // the drop decision follows synchronously right after, with no further
    // await, so once this resolves the drop has already happened.
    await vi.waitFor(() => expect(gateway.getPositionBalance).toHaveBeenCalledWith(TOKEN_ID));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(placed).toHaveLength(0);

    await mod.stop();
  });

  it("refuses a BOUNCE_EXIT_BACKSTOP at the submit boundary when a bounce rung is still in-flight — admitted and dispatched but not yet persisted (P7 rework finding 3)", async () => {
    // Release A P7 rework (finding 3): the rung check must also run at the
    // token-serialized SUBMIT boundary and cover a rung that has been ADMITTED
    // (accepted for dispatch) but hasn't reached orderRepo yet — a persisted-
    // orders-only check (as at admission) would miss it and let the backstop
    // place alongside the still-resting rung (dual order).
    const { bus, gateway, mod } = makeExecModule();
    await mod.start();

    const rejected: { reason?: string }[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p as { reason?: string });
    });

    let resolveRungPlace!: (value: { success: true; orderId: string }) => void;
    gateway.placeOrder.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRungPlace = resolve;
        }),
    );

    const rungCommandPromise = bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-rung-in-flight"),
        clientOrderId: "plk_bounce_rung_in_flight" as ClientOrderId,
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
        decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    // Wait until the rung has actually reached the exchange call — proves it
    // is admitted-and-dispatched (tracked in-flight) while its own placement
    // is still pending (not yet a persisted Order row).
    await vi.waitFor(() => expect(gateway.placeOrder).toHaveBeenCalledTimes(1));

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-backstop-vs-inflight-rung"),
        clientOrderId: "plk_bounce_backstop_vs_inflight_rung" as ClientOrderId,
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
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    // Only the rung ever reached the exchange; the backstop was refused at
    // the submit boundary — no second (dual) gateway.placeOrder call.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(rejected.some((r) => r.reason === "bounce-backstop-draining-rungs")).toBe(true);

    resolveRungPlace({ success: true, orderId: "sim-ord-rung-in-flight" });
    await rungCommandPromise;

    await mod.stop();
  });

  it("HOLDS a below-floor BOUNCE_EXIT_BACKSTOP taker WITHOUT cancelling the resting rung (P7 preflight)", async () => {
    // Release A P7: preflight the loss floor BEFORE cancelling protection. A taker
    // that would breach the floor (here avgEntry 0.5, taker 0.09 = ~82% loss) must
    // NOT cause the resting rung to be cancelled — cancelling it would strand the
    // position with no live exit. The position simply HOLDS (rung preserved, no place).
    const belowFloorPosition = makeGatePosition({
      size: 50,
      avgEntryPrice: 0.5,
      costBasisUsdc: 25,
    });
    const restingRung = makeOrder({ size: 50, status: "open" });
    const { bus, gateway, mod } = makeExecModule(
      { findByTokenId: vi.fn().mockReturnValue([restingRung]) },
      { findByTokenId: vi.fn().mockReturnValue(belowFloorPosition) },
    );
    await mod.start();

    const placed: unknown[] = [];
    const rejected: { reason?: string }[] = [];
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p as { reason?: string });
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-below-floor-hold"),
        clientOrderId: "plk_bounce_below_floor_hold" as ClientOrderId,
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
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled(); // held
    expect(gateway.cancelOrder).not.toHaveBeenCalled(); // rung preserved (protection kept)
    expect(placed).toHaveLength(0);
    expect(rejected.some((r) => r.reason === "bounce-backstop-below-floor-hold")).toBe(true);

    await mod.stop();
  });

  it("does not reject a BOUNCE_EXIT_BACKSTOP full-position taker SELL as reserved-token-limit while its own resting BOUNCE_EXIT_TARGET is still visible in orderRepo", async () => {
    // Reproduces the FIX A race: signal-to-order.ts publishes CancelOrderRequested
    // for the resting target, then immediately publishes the backstop taker
    // PlaceOrderRequested. The cancel is processed asynchronously, so orderRepo
    // still returns the target as "open" when this reservation check runs.
    // Unlike the "stale resting order" test above (no positionRepo configured,
    // which short-circuits the whole reservation check), this test wires a real
    // GATE position + orderRepo.findOpen() so the reserved-token-limit math is
    // actually exercised — the resting target's size must NOT double-count
    // against the backstop's own full-position SELL.
    const gatePosition = {
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      status: "open",
      size: 50,
      avgEntryPrice: 0.15,
      // Exit-loss-floor gate needs a cost basis consistent with avgEntryPrice*size
      // (7.5); the 0.09 submit price below is a real, above-floor profit exit.
      costBasisUsdc: 50 * 0.15,
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
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  it("still force-exits a BOUNCE_EXIT_BACKSTOP taker SELL even when the token is balance-blocked (pending-wallet-sync) — Phase 3 Codex FIX 1", async () => {
    // Reproduces the CRITICAL orphan-residual race: signal-to-order.ts cancels
    // every resting BOUNCE_EXIT_TARGET rung THEN publishes the backstop taker.
    // If the balance-block gate rejected the backstop too, the rungs would
    // already be gone with no replacement exit ever placed — the residual
    // position would be orphaned with zero live exit orders on the book.
    const exchangeStateStore = new ExchangeStateStore();
    exchangeStateStore.markBalanceReject(TOKEN_ID);
    expect(exchangeStateStore.isBalanceBlocked(TOKEN_ID)).toBe(true);

    const { bus, gateway, mod } = makeExecModule(
      undefined,
      undefined,
      undefined,
      exchangeStateStore,
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
        commandId: createCommandId("cmd-bounce-backstop-balance-blocked"),
        clientOrderId: "plk_bounce_backstop_balance_blocked" as ClientOrderId,
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
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  it("still rejects a non-bounce SELL as pending-wallet-sync while the token is balance-blocked (balance-block bypass is bounce-only)", async () => {
    // Guards the FIX 1 bypass from over-widening: a generic/non-bounce SELL
    // (e.g. a Track D8 exit) for the SAME balance-blocked token must still be
    // rejected — only the bounce-exit backstop force-exit is exempt.
    const exchangeStateStore = new ExchangeStateStore();
    exchangeStateStore.markBalanceReject(TOKEN_ID);

    const { bus, gateway, mod } = makeExecModule(
      undefined,
      undefined,
      undefined,
      exchangeStateStore,
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
        commandId: createCommandId("cmd-d8-balance-blocked"),
        clientOrderId: "plk_d8_balance_blocked" as ClientOrderId,
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
        decisionRuleId: "D8",
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(placed).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { reason: string }).reason).toBe("pending-wallet-sync");

    await mod.stop();
  });

  it("rejects an over-cap BOUNCE_EXIT_TARGET rung at execution (bounce-micro-order-cap-exceeded) — Phase 3 Codex FIX 2", async () => {
    // signal-to-order.ts already clamps rung notional to
    // bounceExit.microMaxOrderUsdc at sizing, but this is the independent
    // execution-side enforcement so a malformed/direct PlaceOrderRequested
    // can't place an over-cap rung.
    const { bus, gateway, mod } = makeExecModule(undefined, undefined, () => ({
      ...DEFAULT_EXECUTION_POLICY,
      bounceExit: { ...DEFAULT_EXECUTION_POLICY.bounceExit, microMaxOrderUsdc: 2 },
    }));
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
        commandId: createCommandId("cmd-bounce-rung-over-cap"),
        clientOrderId: "plk_rung_over_cap" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50,
        price: 0.2, // notional = 50 * 0.2 = $10 > $2 microMaxOrderUsdc
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
    expect(placed).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { reason: string }).reason).toBe("bounce-micro-order-cap-exceeded");

    await mod.stop();
  });

  it("does NOT cap a BOUNCE_EXIT_BACKSTOP taker at the same over-microMaxOrderUsdc notional — the backstop is exempt from the bounce micro cap", async () => {
    const { bus, gateway, mod } = makeExecModule(undefined, undefined, () => ({
      ...DEFAULT_EXECUTION_POLICY,
      bounceExit: { ...DEFAULT_EXECUTION_POLICY.bounceExit, microMaxOrderUsdc: 2 },
    }));
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
        commandId: createCommandId("cmd-bounce-backstop-over-cap"),
        clientOrderId: "plk_backstop_over_cap" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50,
        price: 0.2, // same over-cap notional ($10) — backstop must still proceed
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  // Codex C2 fix (docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md):
  // the residual-driven "cleanup" rung is deliberately sized to clear the
  // ladder's fill-aware uncommitted residual in one shot — the execution-side
  // microMaxOrderUsdc cap must exempt it the same way it already exempts the
  // BOUNCE_EXIT_BACKSTOP taker, or the cleanup rung would be rejected right
  // back into the very residual it exists to clear.
  it("does NOT cap a cleanup rung (isCleanupRung) at the same over-microMaxOrderUsdc notional — the cleanup rung is exempt from the bounce micro cap", async () => {
    const { bus, gateway, mod } = makeExecModule(undefined, undefined, () => ({
      ...DEFAULT_EXECUTION_POLICY,
      bounceExit: { ...DEFAULT_EXECUTION_POLICY.bounceExit, microMaxOrderUsdc: 2 },
    }));
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
        commandId: createCommandId("cmd-bounce-cleanup-over-cap"),
        clientOrderId: "plk_cleanup_over_cap" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50,
        price: 0.2, // same over-cap notional ($10) — cleanup rung must still proceed
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
        metadata: { bounceRung: { isCleanupRung: true } },
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  it("carves out per-token SELL execution capacity for the bounce ladder — a 3rd resting rung is accepted when ladderFractions has 3 entries", async () => {
    const existingRungs = [
      makeOrder({
        orderId: createOrderId("ord-rung-0"),
        clientOrderId: "plk_rung_0" as ClientOrderId,
        price: 0.15,
      }),
      makeOrder({
        orderId: createOrderId("ord-rung-1"),
        clientOrderId: "plk_rung_1" as ClientOrderId,
        price: 0.18,
      }),
    ];
    const { bus, gateway, mod } = makeExecModule(
      {
        findOpen: vi.fn().mockReturnValue(existingRungs),
        findByTokenId: vi.fn().mockReturnValue(existingRungs),
      },
      undefined,
      // microMaxOrderUsdc raised well above these rungs' notional (~$5-10):
      // this test is about per-token SELL capacity counting, not the FIX 2
      // micro cap, which is covered by its own dedicated tests above.
      () => ({
        ...DEFAULT_EXECUTION_POLICY,
        bounceExit: {
          ...DEFAULT_EXECUTION_POLICY.bounceExit,
          ladderFractions: [0.3, 0.4, 0.3],
          microMaxOrderUsdc: 1000,
        },
      }),
    );
    await mod.start();

    const rejected: unknown[] = [];
    const placed: unknown[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-rung-2"),
        clientOrderId: "plk_rung_2" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 30,
        price: 0.21,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    // Generic per-token SELL cap defaults to 2 (DEFAULT_SELL_CAPACITY_POLICY);
    // without the ladder carve-out, this 3rd resting rung would trip
    // per_token_sell_limit even though the ladder is explicitly configured
    // for 3 concurrent rungs.
    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  it("rejects a 4th resting bounce rung once the ladder's own rung-count ceiling (3) is reached (per_token_sell_limit)", async () => {
    const existingRungs = [0, 1, 2].map((index) =>
      makeOrder({
        orderId: createOrderId(`ord-rung-${index}`),
        clientOrderId: `plk_rung_${index}` as ClientOrderId,
        price: 0.15 + index * 0.03,
      }),
    );
    const { bus, gateway, mod } = makeExecModule(
      {
        findOpen: vi.fn().mockReturnValue(existingRungs),
        findByTokenId: vi.fn().mockReturnValue(existingRungs),
      },
      undefined,
      // microMaxOrderUsdc raised well above these rungs' notional (~$5-10):
      // this test is about per-token SELL capacity counting, not the FIX 2
      // micro cap, which is covered by its own dedicated tests above.
      () => ({
        ...DEFAULT_EXECUTION_POLICY,
        bounceExit: {
          ...DEFAULT_EXECUTION_POLICY.bounceExit,
          ladderFractions: [0.3, 0.4, 0.3],
          microMaxOrderUsdc: 1000,
        },
      }),
    );
    await mod.start();

    const rejected: unknown[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-rung-3"),
        clientOrderId: "plk_rung_3" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 30,
        price: 0.24,
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
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { reason: string }).reason).toBe("per_token_sell_limit");

    await mod.stop();
  });

  it("does not cancel an earlier resting rung when a new bounce-ladder rung is submitted (deferSellReplacementIfNeeded bypass fix)", async () => {
    const earlierRung = makeOrder({
      orderId: createOrderId("ord-rung-0"),
      clientOrderId: "plk_rung_0" as ClientOrderId,
      price: 0.15,
      status: "open",
    });
    const { bus, gateway, mod } = makeExecModule(
      {
        findOpen: vi.fn().mockReturnValue([earlierRung]),
        findByTokenId: vi.fn().mockReturnValue([earlierRung]),
      },
      undefined,
      // microMaxOrderUsdc raised well above these rungs' notional (~$5-10):
      // this test is about per-token SELL capacity counting, not the FIX 2
      // micro cap, which is covered by its own dedicated tests above.
      () => ({
        ...DEFAULT_EXECUTION_POLICY,
        bounceExit: {
          ...DEFAULT_EXECUTION_POLICY.bounceExit,
          ladderFractions: [0.3, 0.4, 0.3],
          microMaxOrderUsdc: 1000,
        },
      }),
    );
    await mod.start();

    const rejected: unknown[] = [];
    const placed: unknown[] = [];
    bus.subscribe("OrderRejected", async (p) => {
      rejected.push(p);
    });
    bus.subscribe("OrderPlaced", async (p) => {
      placed.push(p);
    });

    // A brand-new rung (rung1) at a different price, while rung0 is still
    // resting. Pre-fix, deferSellReplacementIfNeeded's generic "keep one live
    // price per token" model treated rung0 as the thing being replaced and
    // would cancel it (or defer/reject this command) before the multi-rung
    // capacity carve-out above ever got a chance to run — defeating N-rung
    // coexistence entirely.
    await bus.publish("PlaceOrderRequested", {
      command: {
        type: "PlaceOrderCommand",
        commandId: createCommandId("cmd-bounce-rung-1"),
        clientOrderId: "plk_rung_1" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 40,
        price: 0.18,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.cancelOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  // ─── Final Codex fix: backstop bypasses bot-bookkeeping capacity/caps ────
  //
  // docs/plans/2026-07-16-bounce-exit-ladder-redesign.md — the backstop taker
  // must clear wallet sell capacity, per-token sell capacity, total order
  // capacity, and the live-lite per-order cap unconditionally (bot-
  // bookkeeping), while a normal SELL under the exact same exhausted
  // conditions is still rejected.

  function makeSaturatedSellCapacityPolicy(): () => ExecutionPolicy {
    return () => ({
      ...DEFAULT_EXECUTION_POLICY,
      sellCapacity: {
        ...DEFAULT_EXECUTION_POLICY.sellCapacity,
        maxOpenSellOrders: 1,
        maxOpenSellOrdersPerToken: 1,
      },
      orderCapacity: {
        ...DEFAULT_EXECUTION_POLICY.orderCapacity,
        maxOpenOrdersTotal: 1,
      },
    });
  }

  function makeSaturatingRestingSells(): Order[] {
    // 4 resting non-bounce SELLs on TOKEN_ID: exceeds not just the tiny
    // policy caps above but also the pre-existing bounce ladder-count
    // carve-out (max(policy, ladderFractions.length=3) = 3), so only the
    // NEW unconditional bypass — not the older per-token carve-out — can
    // admit the backstop below.
    return [0, 1, 2, 3].map((index) =>
      makeOrder({
        orderId: createOrderId(`ord-saturate-${index}`),
        clientOrderId: `plk_saturate_${index}` as ClientOrderId,
        decisionRuleId: "D8",
        price: 0.15 + index * 0.01,
      }),
    );
  }

  it("admits a BOUNCE_EXIT_BACKSTOP taker SELL even when wallet/per-token/total sell capacity are already exhausted", async () => {
    const restingSells = makeSaturatingRestingSells();
    const { bus, gateway, mod } = makeExecModule(
      { findOpen: vi.fn().mockReturnValue(restingSells) },
      undefined,
      makeSaturatedSellCapacityPolicy(),
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
        commandId: createCommandId("cmd-backstop-capacity-exhausted"),
        clientOrderId: "plk_backstop_capacity_exhausted" as ClientOrderId,
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
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  it("still rejects a normal SELL under the same exhausted wallet/total sell capacity (bypass is bounce-backstop-only)", async () => {
    // Uses a different token than the saturating resting SELLs so the
    // generic sell-replacement gate (deferSellReplacementIfNeeded — already
    // covered by its own dedicated tests above) never engages, isolating the
    // wallet/total capacity checks this test targets: openSellOrderCount
    // (global, counts every token) is 4, already above maxOpenSellOrders=1.
    const restingSells = makeSaturatingRestingSells();
    const { bus, gateway, mod } = makeExecModule(
      { findOpen: vi.fn().mockReturnValue(restingSells) },
      undefined,
      makeSaturatedSellCapacityPolicy(),
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
        commandId: createCommandId("cmd-d8-capacity-exhausted"),
        clientOrderId: "plk_d8_capacity_exhausted" as ClientOrderId,
        source: "strategy",
        tokenId: OTHER_TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50,
        price: 0.09,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: "D8",
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(placed).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { reason: string }).reason).toBe("wallet_sell_capacity_exhausted");

    await mod.stop();
  });

  it("does not cap a BOUNCE_EXIT_BACKSTOP taker at the live-lite per-order cap — it must sell the whole residual above the $2 cap", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 2,
      maxActiveMarkets: 10,
    });
    const { bus, gateway, mod } = makeExecModule(undefined, undefined, undefined, undefined, guard);
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
        commandId: createCommandId("cmd-backstop-live-lite-cap"),
        clientOrderId: "plk_backstop_live_lite_cap" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50,
        price: 0.5, // notional = $25, far above the $2 live-lite order cap
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID,
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(rejected).toHaveLength(0);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(placed).toHaveLength(1);

    await mod.stop();
  });

  it("still rejects a normal SELL above the live-lite per-order cap (bypass is bounce-backstop-only)", async () => {
    const guard = new LiveLiteGuard({
      maxOpenValueUsdc: 1000,
      maxOrderUsdc: 2,
      maxActiveMarkets: 10,
    });
    const { bus, gateway, mod } = makeExecModule(undefined, undefined, undefined, undefined, guard);
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
        commandId: createCommandId("cmd-d8-live-lite-cap"),
        clientOrderId: "plk_d8_live_lite_cap" as ClientOrderId,
        source: "strategy",
        tokenId: TOKEN_ID,
        conditionId: COND_ID,
        side: "sell",
        size: 50,
        price: 0.5, // same over-cap notional
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: "probe-entry",
        decisionRuleId: "D8",
      } satisfies PlaceOrderCommand,
      timestamp: NOW,
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(placed).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as { reason: string }).reason).toBe("live-lite-order-cap-exceeded");

    await mod.stop();
  });
});
