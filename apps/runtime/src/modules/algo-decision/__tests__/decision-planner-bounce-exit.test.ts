import { describe, expect, it } from "vitest";
import {
  BOUNCE_EXIT_TARGET_RULE_ID,
  BOUNCE_EXIT_TIMEOUT_RULE_ID,
  DEFAULT_EXECUTION_POLICY,
  computeHarvestTarget,
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

// Covers docs/plans/2026-07-15-gate-bounce-live-experiment.md — Phase 3: the
// bounce-exit SELL branch in the ACTIVE decision path. Strictly scoped to
// entryLane==="GATE" open positions; R23-lane/null-lane positions must keep
// flowing through the normal D8/D9 stack untouched. Default-OFF: any unmet
// enabled/mode/whitelist gate must fall through to D8/D9 exactly as if
// bounce-exit didn't exist, never suppress on its own.

const tokenId = createTokenId("bounce-exit-planner-token");
const now = Date.parse("2026-06-20T00:00:00.000Z");
const CONDITION_ID = "bounce-exit-condition";
const ONE_MINUTE_MS = 60_000;
const FOUR_HOURS_MS = 14_400_000; // matches DEFAULT_BOUNCE_EXIT.timeoutMs

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
    // Fresh fill by default (1 minute old) — well below the 4h timeout;
    // individual tests override this to reach the timeout boundary.
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

// Fully eligible bounce-exit policy: enabled + micro_live + whitelisted +
// research-fixed params (matches DEFAULT_BOUNCE_EXIT's targetGainPct/timeoutMs).
const ENABLED_BOUNCE_EXIT: BounceExitPolicy = {
  enabled: true,
  mode: "micro_live",
  targetGainPct: 0.257,
  timeoutMs: FOUR_HOURS_MS,
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
    hasActiveBounceTargetOrder: false,
    sellLoopGuard: null,
    ...overrides,
  };
}

describe("bounce-exit SELL branch (decision-planner) — GATE lane", () => {
  it("emits a SELL draft with BOUNCE_EXIT_TARGET_RULE_ID for a fresh GATE fill", () => {
    const result = evaluateDecisionPlan(input());
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    expect(result.signal.side).toBe("sell");
  });

  it("SUPPRESSES (no duplicate) while a bounce target is already resting", () => {
    const result = evaluateDecisionPlan(input({ hasActiveBounceTargetOrder: true }));
    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "bounce-exit-target-resting",
    );
  });

  it("emits a SELL draft with BOUNCE_EXIT_TIMEOUT_RULE_ID once holdSeconds reaches the 4h timeout", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ firstTradeAt: new Date(now - FOUR_HOURS_MS).toISOString() }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TIMEOUT_RULE_ID);
  });

  it("times out even when a bounce target is resting — timeout dominates the duplicate check", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ firstTradeAt: new Date(now - FOUR_HOURS_MS).toISOString() }),
        hasActiveBounceTargetOrder: true,
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TIMEOUT_RULE_ID);
  });

  // Review fix: the generic post-buy-fill cooldown (decision-planner.ts's
  // buildSignalDraft) is a BUY-throttle concept — it exists to stop a fresh
  // BUY fill from immediately triggering a reactive SELL elsewhere. A
  // bounce-exit SELL is an exit on our OWN just-filled GATE position, not
  // that, so both rule IDs must be exempt: the target has to post the moment
  // the fill lands, and the timeout must never be delayed by an unrelated
  // recent buy.
  it("still emits BOUNCE_EXIT_TARGET despite a non-null postBuyCooldown", () => {
    const result = evaluateDecisionPlan(
      input({ postBuyCooldown: { cooldownMs: 5_000, ageMs: 1_000, lastBuyFillAt: now - 1_000 } }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
  });

  it("still emits BOUNCE_EXIT_TIMEOUT despite a non-null postBuyCooldown", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ firstTradeAt: new Date(now - FOUR_HOURS_MS).toISOString() }),
        postBuyCooldown: { cooldownMs: 5_000, ageMs: 1_000, lastBuyFillAt: now - 1_000 },
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TIMEOUT_RULE_ID);
  });

  // Phase 4 (Codex M3): the resting target's price must be the harvest target
  // computed from avgEntryPrice/targetGainPct/tickSize — not whatever
  // resolveActionPrice would otherwise derive from best-bid/spread guards
  // (bestBid 0.09 here, well below the 0.13 target — proves it wasn't
  // silently overridden).
  it("BOUNCE_EXIT_TARGET suggestedPrice is the harvest target, not the best-bid-derived sell price", () => {
    const result = evaluateDecisionPlan(input());
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    const expectedTarget = computeHarvestTarget(0.1, 0.257, 0.01);
    expect(expectedTarget).toBeCloseTo(0.13, 10);
    expect(result.signal.suggestedPrice).toBeCloseTo(expectedTarget, 10);
    expect(result.signal.suggestedPrice).not.toBeCloseTo(0.09, 2);
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

  // Phase 4 (Codex R3-M3): the resting target still respects the sell-loop
  // guard — only the 4h force-exit gets a carve-out.
  it("BOUNCE_EXIT_TARGET is suppressed by a blocked sellLoopGuard", () => {
    const result = evaluateDecisionPlan(input({ sellLoopGuard: guardSnapshot() }));
    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(SELL_LOOP_GUARD_REASON);
  });

  // Phase 4 (Codex R3-M3): BOUNCE_EXIT_TIMEOUT is a dedicated force-exit and
  // must bypass the sell-loop guard entirely.
  it("BOUNCE_EXIT_TIMEOUT bypasses a blocked sellLoopGuard", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ firstTradeAt: new Date(now - FOUR_HOURS_MS).toISOString() }),
        sellLoopGuard: guardSnapshot(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TIMEOUT_RULE_ID);
  });
});

describe("bounce-exit SELL branch (decision-planner) — non-GATE lanes untouched", () => {
  // Same profitable-leg fixture as decision-planner.test.ts's "fires D8 SELL
  // before static rules for profitable existing legs" (avgBuyPrice 0.05,
  // midPrice 0.085 → profitRatio 1.7, well above the applicable R66 threshold),
  // reused here to prove entryLane gates bounce-exit strictly: D8 must own the
  // SELL regardless of bounceExit being enabled and whitelisted.
  function profitableLegInput(overrides: Partial<DecisionPlanningInput> = {}): DecisionPlanningInput {
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
      profitableLegInput({ position: position({ avgEntryPrice: 0.05, size: 100, entryLane: "R23" }) }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
    expect(result.signal.decisionRuleId).not.toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    expect(result.signal.decisionRuleId).not.toBe(BOUNCE_EXIT_TIMEOUT_RULE_ID);
  });

  it("does not touch a null-lane (legacy) position at +25.7%+ gain — D8 owns it", () => {
    const result = evaluateDecisionPlan(
      profitableLegInput({ position: position({ avgEntryPrice: 0.05, size: 100, entryLane: null }) }),
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
