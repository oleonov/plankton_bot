import { describe, expect, it } from "vitest";
import {
  BOUNCE_EXIT_TARGET_RULE_ID,
  BOUNCE_EXIT_BACKSTOP_RULE_ID,
  DEFAULT_EXECUTION_POLICY,
  createPositionId,
  createTokenId,
  type AlgoDecisionRule,
  type AlgoSizeRule,
  type BounceExitPolicy,
  type ConditionId,
  type ExecutionPolicy,
  type LegState,
  type NormalizedMarket,
  type Position,
  type SellLoopGuardSnapshot,
} from "@krabs/domain";
import {
  evaluateDecisionPlan,
  SELL_LOOP_GUARD_REASON,
  type DecisionPlanningInput,
} from "../decision-planner.js";

// Covers docs/plans/2026-07-16-bounce-exit-ladder-redesign.md — Phase 2: the
// laddered resting-maker bounce-exit SELL branch in the ACTIVE decision path.
// Strictly scoped to entryLane==="GATE" open positions; R23-lane/null-lane
// positions must keep flowing through the normal D8/D9 stack untouched.
// Default-OFF: any unmet enabled/mode/whitelist gate must fall through to
// D8/D9 exactly as if bounce-exit didn't exist, never suppress on its own.
// BOUNCE_EXIT_BACKSTOP wiring (Phase 3): decision-planner.ts now computes a
// real `backstopEligible` via `evaluateBounceBackstopEligibility` (the
// GATE-scoped Track Q.D wrapper) instead of the Phase-2 hardcoded `false` —
// see the "bounce-exit BACKSTOP branch" describe block below for its
// coverage. isBounceForceExit's own unit coverage stays in bounce-exit.test.ts.

const tokenId = createTokenId("bounce-exit-planner-token");
const now = Date.parse("2026-06-20T00:00:00.000Z");
const CONDITION_ID = "bounce-exit-condition";
const ONE_MINUTE_MS = 60_000;

const rules: AlgoDecisionRule[] = [
  {
    id: 999,
    priority: 999,
    ruleId: "FALLBACK",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    timeSinceLastOperator: null,
    timeSinceLastSeconds: null,
    buyCountMin: null,
    buyCountMax: null,
    holdDurationOperator: null,
    holdDurationSeconds: null,
    action: "HOLD",
  },
];

const buySizeRules: AlgoSizeRule[] = [
  {
    id: 1,
    actionType: "BUY",
    priority: 1,
    ruleId: "BUY-SIZE",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1,
  },
];

const sellSizeRules: AlgoSizeRule[] = [
  {
    id: 2,
    actionType: "SELL",
    priority: 1,
    ruleId: "SELL-SIZE",
    stateCondition: "ANY",
    priceOperator: null,
    priceValue: null,
    nthBuy: null,
    buyCountMin: null,
    buyCountMax: null,
    sizeUsdc: 1,
  },
];

function market(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId,
    conditionId: CONDITION_ID,
    slug: "bounce-exit-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Bounce exit planner?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: "2026-09-01T00:00:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.09,
    bestAsk: 0.11,
    midPrice: 0.1,
    spread: 0.02,
    liquidity: 500,
    minOrderSize: 5,
    gammaCreatedAt: "2026-05-19T00:00:00.000Z",
    snapshotTs: now,
    ...overrides,
  };
}

function leg(overrides: Partial<LegState> = {}): LegState {
  return {
    tokenId,
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.1,
    // Fresh fill by default (1 minute old).
    firstTradeAt: new Date(now - ONE_MINUTE_MS).toISOString(),
    lastTradeAt: new Date(now - ONE_MINUTE_MS).toISOString(),
    updatedAt: new Date(now - ONE_MINUTE_MS).toISOString(),
    cumulativeBuySize: 100,
    cumulativeBuyNotional: 10,
    cumulativeSellSize: 0,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("bounce-exit-pos"),
    tokenId,
    conditionId: CONDITION_ID as ConditionId,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.1,
    costBasisUsdc: 10,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    entryLane: "GATE",
    openedAt: new Date(now - ONE_MINUTE_MS).toISOString(),
    closedAt: null,
    updatedAt: new Date(now - ONE_MINUTE_MS).toISOString(),
    ...overrides,
  };
}

// Fully eligible bounce-exit policy: enabled + micro_live + whitelisted.
// targetTiers/ladderFractions/ladderStepPct are carried over from
// DEFAULT_EXECUTION_POLICY.bounceExit unchanged (research-fixed params) — for
// firstEntryPrice 0.1 the tier lookup resolves to gainPct 0.15 (0.08 < 0.1 <=
// 0.15), so with ladderFractions [0.3, 0.4, 0.3] and ladderStepPct 0.22:
//   rung0 px = 0.12 (fraction 0.3)
//   rung1 px = 0.15 (fraction 0.4)
//   rung2 px = 0.18 (fraction 0.3)
// (hand-verified against tick-math.ts's ceilQuantize — see bounce-exit.test.ts).
const ENABLED_BOUNCE_EXIT: BounceExitPolicy = {
  ...DEFAULT_EXECUTION_POLICY.bounceExit,
  enabled: true,
  mode: "micro_live",
  whitelistConditionIds: [CONDITION_ID],
  microMaxOrderUsdc: 2,
};

function executionPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    entryMinMarketAgeSeconds: 0,
    r23DipTrigger: { enabled: false, dropThresholdRatio: 0.683, windowMs: 86_400_000 },
    bounceExit: ENABLED_BOUNCE_EXIT,
    ...overrides,
  };
}

function input(overrides: Partial<DecisionPlanningInput> = {}): DecisionPlanningInput {
  return {
    tokenId,
    now,
    selectedForEntry: false,
    hasPendingBuyOrder: false,
    legState: leg(),
    position: position(),
    market: market(),
    prevMidPrice: null,
    decisionRules: rules,
    buySizeRules,
    sellSizeRules,
    executionPolicy: executionPolicy(),
    continuationFacts: null,
    continuationMode: "leg_local",
    r23MaxMidpoint: 0.2,
    dropReferencePrice: null,
    postBuyCooldown: null,
    latestSellOrder: null,
    hasActiveSellOrderForQd: false,
    hasActiveSellOrderForBounceBackstop: false,
    placedBounceRungIndices: [],
    sellLoopGuard: null,
    ...overrides,
  };
}

describe("bounce-exit SELL branch (decision-planner) — GATE lane", () => {
  it("emits rung0 at firstEntryPrice x (1+tierGain), sized by ladderFractions[0], for a fresh GATE fill", () => {
    const result = evaluateDecisionPlan(input());
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    expect(result.signal.side).toBe("sell");
    expect(result.signal.suggestedPrice).toBeCloseTo(0.12, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(30, 10);
    expect(result.signal.bounceRung).toEqual({
      ladderId: `${tokenId}:${leg().firstTradeAt}`,
      rungIndex: 0,
      anchorPrice: 0.1,
      fraction: 0.3,
      originalPositionSize: 100,
      remainingPositionSize: 100,
    });
  });

  it("advances to rung1 (compounded ladder step, sized 0.4) once rung0 is already placed", () => {
    const result = evaluateDecisionPlan(input({ placedBounceRungIndices: [0] }));
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    expect(result.signal.suggestedPrice).toBeCloseTo(0.15, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(40, 10);
    expect(result.signal.bounceRung?.rungIndex).toBe(1);
  });

  it("advances to rung2 (sized 0.3) once rung0 and rung1 are both placed", () => {
    const result = evaluateDecisionPlan(input({ placedBounceRungIndices: [0, 1] }));
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    expect(result.signal.suggestedPrice).toBeCloseTo(0.18, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(30, 10);
    expect(result.signal.bounceRung?.rungIndex).toBe(2);
  });

  // Codex Phase-2 fix: rung sizing must anchor to the ORIGINAL position
  // (cumulativeBuySize), not the shrinking residual (cumulativeBuySize -
  // cumulativeSellSize). Simulates rung0 (30 shares) having already filled —
  // cumulativeSellSize:30 means the residual is now 70, not 100 — and proves
  // rung1 still sizes to 0.4 x 100 = 40, NOT 0.4 x 70 = 28 (the pre-fix bug,
  // which would leave an unmanaged tail once the ladder "completed").
  it("sizes rung1 from the ORIGINAL position basis, not the shrunken residual, once rung0 has already filled", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ cumulativeSellSize: 30 }),
        placedBounceRungIndices: [0],
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedSize).toBeCloseTo(40, 10);
    expect(result.signal.bounceRung).toEqual({
      ladderId: `${tokenId}:${leg().firstTradeAt}`,
      rungIndex: 1,
      anchorPrice: 0.1,
      fraction: 0.4,
      originalPositionSize: 100,
      remainingPositionSize: 70,
    });
  });

  // Phase 4 add-invariance fix: an ADD (2nd BUY fill) on the same leg grows
  // legState.cumulativeBuySize/avgEntryPrice — simulated here via
  // leg({ cumulativeBuySize: 150 }) (was 100) and position({ avgEntryPrice
  // moved off 0.1 too, mirroring a real VWAP shift). GATE is a first-entry
  // lane and Track A blocks down-adds, but the exit must stay add-invariant
  // defensively: rung1 must still size off the ORIGINAL 100-share basis
  // (pinned via originalLadderPositionSize, recovered from rung0's own
  // already-placed metadata) and rung1's price must still anchor to the
  // FIRST-entry price (0.1 via legState.firstTradePrice, which an add never
  // mutates) — NOT the new inflated 150-share basis or the drifted avgEntry.
  it("stays add-invariant: rung1 still sizes off the ORIGINAL (pinned) basis and prices off firstTradePrice after a 2nd BUY (add) grows cumulativeBuySize", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ cumulativeBuySize: 150, buyCount: 2 }),
        position: position({ avgEntryPrice: 0.14, size: 150, costBasisUsdc: 18 }),
        placedBounceRungIndices: [0],
        originalLadderPositionSize: 100,
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    // Price stays anchored to firstEntryPrice (0.1) — rung1 px is 0.15,
    // exactly as in the no-add case, not re-derived from the new avgEntry.
    expect(result.signal.suggestedPrice).toBeCloseTo(0.15, 10);
    // Size stays pinned to fraction(0.4) x ORIGINAL(100) = 40, not
    // fraction(0.4) x the post-add 150 = 60.
    expect(result.signal.suggestedSize).toBeCloseTo(40, 10);
    expect(result.signal.bounceRung).toEqual({
      ladderId: `${tokenId}:${leg().firstTradeAt}`,
      rungIndex: 1,
      anchorPrice: 0.1,
      fraction: 0.4,
      originalPositionSize: 100,
      remainingPositionSize: 150,
    });
  });

  // Same scenario but with no rung placed yet (originalLadderPositionSize
  // undefined) — there is nothing to pin to yet, so the live
  // cumulativeBuySize is correctly used as-is for rung0. This is the expected
  // (safe) behavior only for the very first rung of a ladder; it is Phase 4's
  // pinning mechanism engaging from rung1 onward that prevents any further
  // drift once the ladder has actually started.
  it("uses the live cumulativeBuySize for rung0 when no rung has been placed yet (nothing to pin to)", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ cumulativeBuySize: 150, buyCount: 2 }),
        position: position({ avgEntryPrice: 0.14, size: 150, costBasisUsdc: 18 }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedSize).toBeCloseTo(45, 10); // 0.3 x 150
    expect(result.signal.bounceRung?.originalPositionSize).toBe(150);
  });

  // Residual-capping half of the fix: if the residual has shrunk below what
  // this rung's own fraction of the ORIGINAL basis would imply (e.g. an
  // externally-reduced position), the rung must still never oversell beyond
  // what is actually left.
  it("caps a rung's size to the available residual when the residual is smaller than fraction x original", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ cumulativeSellSize: 85 }),
        placedBounceRungIndices: [0],
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    // fraction(0.4) x original(100) = 40, but only 15 remains — capped to 15.
    expect(result.signal.suggestedSize).toBeCloseTo(15, 10);
    expect(result.signal.bounceRung?.remainingPositionSize).toBeCloseTo(15, 10);
  });

  it("SUPPRESSES (no re-emission) once every rung is placed — ladder complete, no backstop yet", () => {
    const result = evaluateDecisionPlan(input({ placedBounceRungIndices: [0, 1, 2] }));
    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "bounce-exit-ladder-complete",
    );
  });

  it("anchors every rung to legState.firstTradePrice, not the position's (mutable) avgEntryPrice", () => {
    // avgEntryPrice drifts away from firstTradePrice (e.g. after a scale-in);
    // the ladder must still price off the fixed first-fill anchor.
    const result = evaluateDecisionPlan(input({ position: position({ avgEntryPrice: 0.2 }) }));
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedPrice).toBeCloseTo(0.12, 10);
    expect(result.signal.suggestedPrice).not.toBeCloseTo(0.2, 2);
    expect(result.signal.bounceRung?.anchorPrice).toBeCloseTo(0.1, 10);
  });

  // Review fix carried over from Phase 3: the generic post-buy-fill cooldown
  // (decision-planner.ts's buildSignalDraft) is a BUY-throttle concept — it
  // exists to stop a fresh BUY fill from immediately triggering a reactive
  // SELL elsewhere. A bounce-exit rung is an exit on our OWN just-filled GATE
  // position, not that, so it must post the moment the fill lands regardless.
  it("still emits the rung despite a non-null postBuyCooldown", () => {
    const result = evaluateDecisionPlan(
      input({ postBuyCooldown: { cooldownMs: 5_000, ageMs: 1_000, lastBuyFillAt: now - 1_000 } }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
  });

  function guardSnapshot(overrides: Partial<SellLoopGuardSnapshot> = {}): SellLoopGuardSnapshot {
    return {
      blocked: true,
      reasonCode: "sell_loop_guard",
      activeCount: 12,
      threshold: 10,
      windowMs: 6 * 60 * 60_000,
      blockedUntilMs: now + 6 * 60 * 60_000,
      lastOutcome: "post_only_cross_pre_submit",
      firstEventAtMs: now - 300_000,
      lastEventAtMs: now - 1_000,
      ...overrides,
    };
  }

  // A resting BOUNCE_EXIT_TARGET rung still respects the sell-loop guard —
  // only a BOUNCE_EXIT_BACKSTOP force-exit gets a carve-out (unreachable in
  // this phase; see isBounceForceExit's own coverage in bounce-exit.test.ts).
  it("is suppressed by a blocked sellLoopGuard", () => {
    const result = evaluateDecisionPlan(input({ sellLoopGuard: guardSnapshot() }));
    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(SELL_LOOP_GUARD_REASON);
  });
});

describe("bounce-exit BACKSTOP branch (decision-planner) — Phase 3 GATE-scoped wrapper", () => {
  // Near-resolution (1h to close, well inside the default 24h backstopTtcHours)
  // + bestBid at avgEntry (Q.D Mode A) — the shape the GATE-scoped wrapper
  // reuses from Track Q.D, see qd-pre-resolution-exit.ts.
  function nearResolutionMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
    return market({
      endDate: new Date(now + 3_600_000).toISOString(),
      bestBid: 0.1,
      bestAsk: 0.11,
      midPrice: 0.105,
      ...overrides,
    });
  }

  it("emits BOUNCE_EXIT_BACKSTOP near resolution with a qualifying bid, even with unplaced rungs remaining", () => {
    const result = evaluateDecisionPlan(
      input({ market: nearResolutionMarket(), placedBounceRungIndices: [] }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_BACKSTOP_RULE_ID);
    expect(result.signal.side).toBe("sell");
  });

  it("rescues an otherwise-suppressed ladder-complete position (all rungs placed) via the backstop", () => {
    const result = evaluateDecisionPlan(
      input({ market: nearResolutionMarket(), placedBounceRungIndices: [0, 1, 2] }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_BACKSTOP_RULE_ID);
  });

  // GATE entries can price up to gateEntry.maxPrice (0.15 default) — well
  // above Q.D's own 0.05 tier ceiling. The backstop must cover this whole
  // band, not just Q.D's cheapest-longshot tier.
  it("still backstops a GATE entry priced above Q.D's own 0.05 tier ceiling (proves the tier-ceiling override)", () => {
    const result = evaluateDecisionPlan(
      input({
        position: position({ avgEntryPrice: 0.12 }),
        market: nearResolutionMarket({ bestBid: 0.12, bestAsk: 0.13, midPrice: 0.125 }),
        placedBounceRungIndices: [],
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_BACKSTOP_RULE_ID);
  });

  it("does not backstop once avgEntryPrice clears the GATE band ceiling (tier override still enforced)", () => {
    const result = evaluateDecisionPlan(
      input({
        position: position({ avgEntryPrice: 0.12 }),
        market: nearResolutionMarket({ bestBid: 0.12, bestAsk: 0.13, midPrice: 0.125 }),
        executionPolicy: executionPolicy({
          gateEntry: { ...DEFAULT_EXECUTION_POLICY.gateEntry, maxPrice: 0.1 },
        }),
        placedBounceRungIndices: [],
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    // Falls back to normal rung placement — the ladder isn't complete yet.
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
  });

  it("does not backstop while a (non-bounce) active SELL is already resting, falling back to rung emission", () => {
    const result = evaluateDecisionPlan(
      input({
        market: nearResolutionMarket(),
        hasActiveSellOrderForBounceBackstop: true,
        placedBounceRungIndices: [],
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
  });

  it("never backstops when bounceExit is disabled, even with near-resolution Mode-A conditions met (default-OFF no-op)", () => {
    const result = evaluateDecisionPlan(
      input({
        market: nearResolutionMarket(),
        executionPolicy: executionPolicy({
          bounceExit: { ...ENABLED_BOUNCE_EXIT, enabled: false },
        }),
        placedBounceRungIndices: [],
      }),
    );
    // No bounce-exit branch at all when disabled — falls through to the
    // generic stack, which (fresh, non-profitable leg, ratio 1.0) has nothing
    // to fire; whatever the outcome, it must never be the backstop.
    if (result.type === "signal") {
      expect(result.signal.decisionRuleId).not.toBe(BOUNCE_EXIT_BACKSTOP_RULE_ID);
    }
  });
});

describe("bounce-exit SELL branch (decision-planner) — non-GATE lanes untouched", () => {
  // Same profitable-leg fixture as decision-planner.test.ts's "fires D8 SELL
  // before static rules for profitable existing legs" (avgBuyPrice 0.05,
  // midPrice 0.085 → profitRatio 1.7, well above the applicable R66 threshold),
  // reused here to prove entryLane gates bounce-exit strictly: D8 must own the
  // SELL regardless of bounceExit being enabled and whitelisted.
  function profitableLegInput(
    overrides: Partial<DecisionPlanningInput> = {},
  ): DecisionPlanningInput {
    return input({
      legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 5 }),
      position: position({ avgEntryPrice: 0.05, size: 100 }),
      market: market({ bestBid: 0.08, bestAsk: 0.09, midPrice: 0.085, spread: 0.01 }),
      executionPolicy: executionPolicy({
        profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, holdSecondsMin: 0 },
      }),
      ...overrides,
    });
  }

  it("does not touch an R23-lane position at +25.7%+ gain — D8 owns it", () => {
    const result = evaluateDecisionPlan(
      profitableLegInput({
        position: position({ avgEntryPrice: 0.05, size: 100, entryLane: "R23" }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
    expect(result.signal.decisionRuleId).not.toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    expect(result.signal.decisionRuleId).not.toBe(BOUNCE_EXIT_BACKSTOP_RULE_ID);
  });

  it("does not touch a null-lane (legacy) position at +25.7%+ gain — D8 owns it", () => {
    const result = evaluateDecisionPlan(
      profitableLegInput({
        position: position({ avgEntryPrice: 0.05, size: 100, entryLane: null }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
  });

  it("falls through to D8 (no-op) when bounceExit.enabled is false on a GATE-lane position", () => {
    const result = evaluateDecisionPlan(
      profitableLegInput({
        executionPolicy: executionPolicy({
          bounceExit: { ...ENABLED_BOUNCE_EXIT, enabled: false },
          profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, holdSecondsMin: 0 },
        }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
  });

  it("falls through to D8 (no-op) when bounceExit.mode is 'off' on a GATE-lane position", () => {
    const result = evaluateDecisionPlan(
      profitableLegInput({
        executionPolicy: executionPolicy({
          bounceExit: { ...ENABLED_BOUNCE_EXIT, mode: "off" },
          profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, holdSecondsMin: 0 },
        }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
  });

  it("falls through to D8 (no-op) when the conditionId is off the bounce-exit whitelist", () => {
    const result = evaluateDecisionPlan(
      profitableLegInput({
        executionPolicy: executionPolicy({
          bounceExit: { ...ENABLED_BOUNCE_EXIT, whitelistConditionIds: ["some-other-condition"] },
          profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, holdSecondsMin: 0 },
        }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
  });
});
