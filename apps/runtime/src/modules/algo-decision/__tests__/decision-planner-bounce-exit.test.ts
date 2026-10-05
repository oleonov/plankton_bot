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

// Codex C1 fix (docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md): the
// fill-aware sizing/completion path is new Phase-3 behavior gated behind
// sellableFlow.enabled — GATE eligibility itself never consults appliesFromMs,
// so any cutoff value is fine here; used only by tests that deliberately
// exercise the flag-ON fill-aware path.
function sellableFlowOnPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return executionPolicy({
    sellableFlow: {
      enabled: true,
      buffer: 1.2,
      maxEntryUsdc: 5,
      appliesFromMs: now - ONE_MINUTE_MS,
    },
    ...overrides,
  });
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

function derekInput(overrides: Partial<DecisionPlanningInput> = {}): DecisionPlanningInput {
  return input({
    legState: leg({
      firstTradePrice: 0.013,
      cumulativeBuySize: 39.13,
      cumulativeBuyNotional: 39.13 * 0.013,
    }),
    position: position({ size: 39.13, avgEntryPrice: 0.013 }),
    market: market({ tickSize: 0.001, minOrderSize: 5 }),
    placedBounceRungIndices: [1, 2],
    originalLadderPositionSize: 25.18,
    bounceLadderOpenCommitment: 32.626,
    hasWorkingBounceCleanup: true,
    minOrderSizeHydrationAvailable: true,
    executionPolicy: sellableFlowOnPolicy(),
    ...overrides,
  });
}

describe("MINFIX SELL supplemental hydration", () => {
  it.each([null, undefined, 0, -1, NaN, Infinity])(
    "suppresses unknown minimum %s without dust or cancellation",
    (minOrderSize) => {
      const result = evaluateDecisionPlan(
        derekInput({
          market: market({ minOrderSize } as Partial<NormalizedMarket>),
        }),
      );
      expect(result.type).toBe("none");
      expect(result.suppressions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ reasonCode: "sell-residual-unknown-min", side: "SELL" }),
        ]),
      );
      expect(result.sideEffects).toEqual([]);
    },
  );

  it.each([1, 5, 6.504, 7])("uses observed minimum %s without adding shares", (minOrderSize) => {
    const result = evaluateDecisionPlan(
      derekInput({ market: market({ tickSize: 0.001, minOrderSize }) }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedPrice).toBeCloseTo(0.018, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(6.504, 10);
    expect(result.signal.bounceRung?.rungIndex).toBe(0);
  });

  it.each([false, undefined])("retains fallback when hydration capability is %s", (available) => {
    const candidate = derekInput({ market: market({ minOrderSize: null }) });
    if (available === undefined) delete candidate.minOrderSizeHydrationAvailable;
    else candidate.minOrderSizeHydrationAvailable = available;
    const result = evaluateDecisionPlan(candidate);
    expect(result.type).toBe("signal");
  });
});

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
  // what is actually left. Phase 3 (docs/plans/2026-07-19-sellable-sizing-
  // bounce-for-all.md) moved this cap's BASIS from the leg-level
  // cumulativeBuySize/cumulativeSellSize delta to fill-aware
  // bounceLadderSoldShares/bounceLadderOpenCommitment (requires
  // sellableFlow.enabled — Codex C1 fix) — cumulativeSellSize:85 is set here
  // too only so the (unrelated, still leg-level) remainingPositionSize
  // metadata field keeps reading a realistic value.
  it("caps a rung's size to the fill-aware uncommitted remainder when it is smaller than fraction x original (sellableFlow on)", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ cumulativeSellSize: 85 }),
        placedBounceRungIndices: [0],
        bounceLadderSoldShares: 85,
        executionPolicy: sellableFlowOnPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    // fraction(0.4) x original(100) = 40, but only 15 remains uncommitted — capped to 15.
    expect(result.signal.suggestedSize).toBeCloseTo(15, 10);
    // remainingPositionSize is the separate, unchanged leg-level metric (still
    // consumed by signal-to-order.ts's min-order rollover) — 100 - 85 = 15
    // here too, but derived independently of the fill-aware cap above.
    expect(result.signal.bounceRung?.remainingPositionSize).toBeCloseTo(15, 10);
  });

  // Proves the invariant is actually fill-aware, not leg-level: cumulativeSellSize
  // (leg-level) says nothing has sold, but bounceLadderSoldShares (actual fills)
  // says 85 have — the cap must follow the fill-aware figure. Requires
  // sellableFlow.enabled (Codex C1 fix) — see the flag-off byte-identity
  // block below for the same scenario with the flag off.
  it("caps by bounceLadderSoldShares even when legState.cumulativeSellSize disagrees (sellableFlow on)", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ cumulativeSellSize: 0 }),
        placedBounceRungIndices: [0],
        bounceLadderSoldShares: 85,
        executionPolicy: sellableFlowOnPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedSize).toBeCloseTo(15, 10);
    // remainingPositionSize stays the (unrelated) leg-level 100 - 0 = 100.
    expect(result.signal.bounceRung?.remainingPositionSize).toBeCloseTo(100, 10);
  });

  it("caps by cumulativeSellSize when bounce sold-fill accounting is stale (sellableFlow on)", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({ cumulativeSellSize: 85 }),
        placedBounceRungIndices: [0],
        bounceLadderSoldShares: 0,
        executionPolicy: sellableFlowOnPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedSize).toBeCloseTo(15, 10);
    expect(result.signal.bounceRung?.uncommittedRemainder).toBeCloseTo(15, 10);
  });

  it("caps by the active position size when both fill counters overstate sellable shares (sellableFlow on)", () => {
    const result = evaluateDecisionPlan(
      input({
        position: position({ size: 15, costBasisUsdc: 1.5 }),
        placedBounceRungIndices: [0],
        bounceLadderSoldShares: 0,
        executionPolicy: sellableFlowOnPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedSize).toBeCloseTo(15, 10);
    expect(result.signal.bounceRung?.uncommittedRemainder).toBeCloseTo(15, 10);
  });

  // A resting (not-yet-filled) rung counts against the residual too, via
  // bounceLadderOpenCommitment — otherwise the next cycle could double-place
  // it. Requires sellableFlow.enabled (Codex C1 fix).
  it("caps a rung's size by bounceLadderOpenCommitment (a still-resting earlier rung, sellableFlow on)", () => {
    const result = evaluateDecisionPlan(
      input({
        placedBounceRungIndices: [0],
        bounceLadderOpenCommitment: 70,
        executionPolicy: sellableFlowOnPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    // fraction(0.4) x original(100) = 40, but only 30 is uncommitted — capped to 30.
    expect(result.signal.suggestedSize).toBeCloseTo(30, 10);
  });

  // docs/plans/2026-09-30-bounce-rung-sell-capacity-storm.md — the "phantom
  // rung" storm emitter: execution's normalizeSellSizeForMinOrder absorbs a
  // sub-minimum leftover into an earlier rung without marking that rung's
  // index covered, so the next missing rung's own uncommittedRemainder is 0
  // (every share is already committed to the earlier, enlarged order) and it
  // would otherwise be explicitly sized to 0 and re-emitted on every update.
  it("suppresses a maker_rung with zero uncommitted remainder instead of emitting a 0-share SELL (sellableFlow on)", () => {
    const result = evaluateDecisionPlan(
      input({
        placedBounceRungIndices: [0],
        bounceLadderOpenCommitment: 100, // the entire sellable balance is already resting
        executionPolicy: sellableFlowOnPolicy(),
      }),
    );
    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "bounce-rung-no-uncommitted-remainder",
    );
  });

  // The guard is gated on sellableFlowOn — GATE-lane flag-off byte-identity
  // must be preserved: sizing keeps using the leg-level remainingPositionSize
  // (100 here), which is > 0, so the identical inputs still emit normally.
  it("does NOT suppress the same zero-fill-aware-remainder scenario when sellableFlow is off (flag-off byte-identity)", () => {
    const result = evaluateDecisionPlan(
      input({
        placedBounceRungIndices: [0],
        bounceLadderOpenCommitment: 100,
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedSize).toBeCloseTo(40, 10);
  });

  it("normalizes the Mario supplemental rung before Risk without changing its target", () => {
    const result = evaluateDecisionPlan(
      input({
        legState: leg({
          firstTradePrice: 0.044,
          cumulativeBuySize: 132.975,
          cumulativeBuyNotional: 132.975 * 0.044,
        }),
        position: position({ size: 132.975 }),
        market: market({ tickSize: 0.001, minOrderSize: 5 }),
        originalLadderPositionSize: 10,
        bounceLadderOpenCommitment: 122.975,
        hasWorkingBounceCleanup: true,
        executionPolicy: sellableFlowOnPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedPrice).toBeCloseTo(0.053, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(10, 10);
    expect(result.signal.bounceRung).toMatchObject({
      rungIndex: 0,
      fraction: 0.7,
      rungIndicesCovered: [0, 1],
      originalPositionSize: 10,
      remainingPositionSize: 132.975,
      uncommittedRemainder: 10,
    });
  });

  it("keeps the Derek supplemental at the first missing rung and exact free residual", () => {
    const result = evaluateDecisionPlan(derekInput());
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedSize).toBeCloseTo(6.504, 10);
    expect(result.signal.suggestedPrice).toBeCloseTo(0.018, 10);
    expect(result.signal.bounceRung).toMatchObject({
      rungIndex: 0,
      fraction: 0.3,
      rungIndicesCovered: [0],
      originalPositionSize: 25.18,
      remainingPositionSize: 39.13,
    });
    expect(result.signal.bounceRung?.uncommittedRemainder).toBeCloseTo(6.504, 10);
  });

  it("SUPPRESSES (no re-emission) once every rung is placed AND fully committed — ladder complete, no backstop yet", () => {
    const result = evaluateDecisionPlan(
      input({ placedBounceRungIndices: [0, 1, 2], bounceLadderSoldShares: 100 }),
    );
    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "bounce-exit-ladder-complete",
    );
  });

  // Phase 3 residual-driven completion: every configured rung is placed, but
  // the fill-aware residual (100 - 70 = 30) still clears market().minOrderSize
  // (5) — must NOT complete/suppress; instead sell the residual via a
  // cap-exempt "cleanup" rung at the LAST configured rung's own target price.
  // Requires sellableFlow.enabled (Codex C1 fix) — see the flag-off
  // byte-identity block below for the same scenario with the flag off.
  it("emits a cap-exempt cleanup rung sized to the uncommitted remainder once every rung is placed but the residual still clears the exchange minimum (sellableFlow on)", () => {
    const result = evaluateDecisionPlan(
      input({
        placedBounceRungIndices: [0, 1, 2],
        bounceLadderSoldShares: 70,
        executionPolicy: sellableFlowOnPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    // Same price as rung2 (the last configured rung, index 2 of [0.3,0.4,0.3]).
    expect(result.signal.suggestedPrice).toBeCloseTo(0.18, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(30, 10);
    expect(result.signal.bounceRung).toMatchObject({
      rungIndex: 2,
      originalPositionSize: 100,
      isCleanupRung: true,
    });
  });

  // Sub-min dust (a physical exchange limit) is accepted, not chased — the
  // ladder completes/suppresses rather than emitting an unplaceable rung.
  // Requires sellableFlow.enabled: with the flag off this would suppress
  // anyway (see the byte-identity block below), but for the RIGHT reason
  // here it must be the sub-min-dust check, not the flag-off shortcut.
  it("does NOT emit a cleanup rung when the uncommitted remainder is below the exchange minimum — accepts the dust and suppresses (sellableFlow on)", () => {
    const result = evaluateDecisionPlan(
      input({
        placedBounceRungIndices: [0, 1, 2],
        bounceLadderSoldShares: 97, // remainder 3 < minOrderSize 5
        executionPolicy: sellableFlowOnPolicy(),
      }),
    );
    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "bounce-exit-ladder-complete",
    );
  });

  // Codex C1 fix — flag-off byte-identity: the exact same scenarios above
  // (fill-aware sold/open-commitment data present, e.g. because fillRepo is
  // now wired) must NOT change GATE behaviour when sellableFlow.enabled is
  // false (the default/production-today state). Sizing must use the ORIGINAL
  // leg-level remainingPositionSize (ignoring bounceLadderSoldShares/
  // bounceLadderOpenCommitment entirely), and ladder completion must use the
  // ORIGINAL unconditional suppression (never emit a cleanup rung), exactly
  // as decision-planner.ts behaved before Phase 3.
  describe("Codex C1 fix — flag-off byte-identity (sellableFlow.enabled: false, the default)", () => {
    it("sizes a rung from the ORIGINAL leg-level remainingPositionSize, ignoring bounceLadderSoldShares fill data", () => {
      const result = evaluateDecisionPlan(
        input({
          legState: leg({ cumulativeSellSize: 0 }),
          placedBounceRungIndices: [0],
          bounceLadderSoldShares: 85, // would cap to 15 if fill-aware (flag on) — must be ignored here
        }),
      );
      expect(result.type).toBe("signal");
      if (result.type !== "signal") return;
      // fraction(0.4) x original(100) = 40, capped only by the ORIGINAL
      // leg-level remainingPositionSize (100 - cumulativeSellSize:0 = 100).
      expect(result.signal.suggestedSize).toBeCloseTo(40, 10);
      expect(result.signal.bounceRung).toEqual({
        ladderId: `${tokenId}:${leg().firstTradeAt}`,
        rungIndex: 1,
        anchorPrice: 0.1,
        fraction: 0.4,
        originalPositionSize: 100,
        remainingPositionSize: 100,
        // uncommittedRemainder is absent (Codex H4 fix — byte-identical
        // metadata shape) when the flag is off.
      });
    });

    it("sizes a rung from the ORIGINAL leg-level remainingPositionSize, ignoring bounceLadderOpenCommitment fill data", () => {
      const result = evaluateDecisionPlan(
        input({
          placedBounceRungIndices: [0],
          bounceLadderOpenCommitment: 70, // would cap to 30 if fill-aware (flag on) — must be ignored here
        }),
      );
      expect(result.type).toBe("signal");
      if (result.type !== "signal") return;
      expect(result.signal.suggestedSize).toBeCloseTo(40, 10);
    });

    it("keeps the ORIGINAL unconditional-suppress completion — no cleanup rung — even though the fill-aware residual would clear the exchange minimum", () => {
      const result = evaluateDecisionPlan(
        input({
          placedBounceRungIndices: [0, 1, 2],
          bounceLadderSoldShares: 70, // fill-aware residual 30 clears minOrderSize 5 — would emit a cleanup rung if flag on
        }),
      );
      expect(result.type).toBe("none");
      expect(result.suppressions.map((item) => item.reasonCode)).toContain(
        "bounce-exit-ladder-complete",
      );
    });
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

  it("bypasses a blocked sellLoopGuard when the live best bid satisfies the immutable target", () => {
    const result = evaluateDecisionPlan(
      input({
        market: market({ bestBid: 0.12, bestAsk: 0.13, midPrice: 0.125 }),
        sellLoopGuard: guardSnapshot(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    expect(result.signal.suggestedPrice).toBeCloseTo(0.12, 10);
  });

  it("keeps a below-target BOUNCE_EXIT_TARGET suppressed by the sellLoopGuard", () => {
    const result = evaluateDecisionPlan(
      input({
        market: market({ bestBid: 0.11, bestAsk: 0.13, midPrice: 0.12 }),
        sellLoopGuard: guardSnapshot(),
      }),
    );
    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(SELL_LOOP_GUARD_REASON);
  });

  it("lets a nonterminal ASK intent own ordinary planning but keeps the backstop senior", () => {
    const managed = evaluateDecisionPlan(input({ hasNonterminalBounceAskCaptureIntent: true }));
    expect(managed.type).toBe("none");
    expect(managed.suppressions.map((item) => item.reasonCode)).toContain(
      "bounce-ask-capture-intent-active",
    );
    const senior = evaluateDecisionPlan(
      input({
        hasNonterminalBounceAskCaptureIntent: true,
        market: market({ endDate: new Date(now + 3_600_000).toISOString(), bestBid: 0.1 }),
      }),
    );
    expect(senior.type === "signal" && senior.signal.decisionRuleId).toBe(
      BOUNCE_EXIT_BACKSTOP_RULE_ID,
    );
  });
});

// docs/plans/2026-10-05-single-rung-bounce-exit.md: plankton sells the whole inventory in one
// event at the first target, so the live ladder becomes one rung. Each case pins a price/size the
// three-rung ladder would not produce.
describe("single-rung ladder [1] (operator 2026-10-05)", () => {
  const singleRungPolicy = () =>
    sellableFlowOnPolicy({ bounceExit: { ...ENABLED_BOUNCE_EXIT, ladderFractions: [1] } });

  it("emits rung0 at the first tier target for the whole inventory", () => {
    const result = evaluateDecisionPlan(input({ executionPolicy: singleRungPolicy() }));
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedPrice).toBeCloseTo(0.12, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(100, 10);
    expect(result.signal.bounceRung).toMatchObject({ rungIndex: 0, fraction: 1 });
  });

  it("offers what the $2 cap clipped from rung0 as a cap-exempt cleanup at the same price", () => {
    const result = evaluateDecisionPlan(
      input({
        placedBounceRungIndices: [0],
        bounceLadderOpenCommitment: 16,
        executionPolicy: singleRungPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedPrice).toBeCloseTo(0.12, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(84, 10);
    expect(result.signal.bounceRung).toMatchObject({ rungIndex: 0, isCleanupRung: true });
  });

  it("moves a legacy three-rung remainder to rung0's price once the old rungs are gone", () => {
    const result = evaluateDecisionPlan(
      input({
        placedBounceRungIndices: [0, 1, 2],
        bounceLadderSoldShares: 30,
        executionPolicy: singleRungPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.suggestedPrice).toBeCloseTo(0.12, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(70, 10);
    expect(result.signal.bounceRung).toMatchObject({ rungIndex: 0, isCleanupRung: true });
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

// Phase 4 (docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md): the same
// laddered bounce-exit that used to be GATE-lane-exclusive now also governs
// any OTHER open position, but only once sellableFlow.enabled AND only for
// positions opened at/after its appliesFromMs cutoff — pre-cutoff positions
// keep flowing through the normal D8/D9 stack exactly as before (untouched).
describe("bounce-exit SELL branch (decision-planner) — Phase 4 bounce-for-all", () => {
  const CUTOFF_MS = Date.parse("2026-06-01T00:00:00.000Z");

  function sellableFlowPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
    return executionPolicy({
      sellableFlow: { enabled: true, buffer: 1.2, maxEntryUsdc: 5, appliesFromMs: CUTOFF_MS },
      ...overrides,
    });
  }

  it("governs a non-GATE position opened AT/AFTER appliesFromMs exactly like a GATE position (rung0)", () => {
    const result = evaluateDecisionPlan(
      input({
        position: position({
          entryLane: null,
          openedAt: new Date(CUTOFF_MS + 1_000).toISOString(),
        }),
        executionPolicy: sellableFlowPolicy(),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    expect(result.signal.suggestedPrice).toBeCloseTo(0.12, 10);
    expect(result.signal.suggestedSize).toBeCloseTo(30, 10);
  });

  function profitableLegInput(
    overrides: Partial<DecisionPlanningInput> = {},
  ): DecisionPlanningInput {
    return input({
      legState: leg({ buyCount: 1, cumulativeBuySize: 100, cumulativeBuyNotional: 5 }),
      position: position({ avgEntryPrice: 0.05, size: 100 }),
      market: market({ bestBid: 0.08, bestAsk: 0.09, midPrice: 0.085, spread: 0.01 }),
      executionPolicy: sellableFlowPolicy({
        profitTarget: { ...DEFAULT_EXECUTION_POLICY.profitTarget, holdSecondsMin: 0 },
      }),
      ...overrides,
    });
  }

  it("leaves a non-GATE position opened BEFORE appliesFromMs untouched — D8 still owns it", () => {
    const result = evaluateDecisionPlan(
      profitableLegInput({
        position: position({
          avgEntryPrice: 0.05,
          size: 100,
          entryLane: null,
          openedAt: new Date(CUTOFF_MS - 1_000).toISOString(),
        }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
  });

  it("falls through to D8/D9 (not suppressed) once a bounce-for-all ladder is dust-complete and no rung is resting", () => {
    const result = evaluateDecisionPlan(
      profitableLegInput({
        position: position({
          avgEntryPrice: 0.05,
          size: 100,
          entryLane: null,
          openedAt: new Date(CUTOFF_MS + 1_000).toISOString(),
        }),
        placedBounceRungIndices: [0, 1, 2],
        bounceLadderSoldShares: 100,
        hasOpenBounceRung: false,
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("D8_PROFIT_RATIO");
  });

  it("stays suppressed (does not fall through) while a bounce rung is still resting, even once the ladder is otherwise dust-complete", () => {
    const result = evaluateDecisionPlan(
      profitableLegInput({
        position: position({
          avgEntryPrice: 0.05,
          size: 100,
          entryLane: null,
          openedAt: new Date(CUTOFF_MS + 1_000).toISOString(),
        }),
        placedBounceRungIndices: [0, 1, 2],
        bounceLadderSoldShares: 100,
        hasOpenBounceRung: true,
      }),
    );
    expect(result.type).toBe("none");
    expect(result.suppressions.map((item) => item.reasonCode)).toContain(
      "bounce-exit-ladder-complete",
    );
  });

  it("still emits a cap-exempt cleanup rung for a non-GATE bounce-for-all position, same as GATE", () => {
    const result = evaluateDecisionPlan(
      input({
        position: position({
          entryLane: null,
          openedAt: new Date(CUTOFF_MS + 1_000).toISOString(),
        }),
        executionPolicy: sellableFlowPolicy(),
        placedBounceRungIndices: [0, 1, 2],
        bounceLadderSoldShares: 70,
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.bounceRung).toMatchObject({ isCleanupRung: true });
    expect(result.signal.suggestedSize).toBeCloseTo(30, 10);
  });
});

describe("Release A Phase 3 — owner-authoritative bounce servicing (isBounceOwned)", () => {
  const DISABLED_BOUNCE: BounceExitPolicy = {
    ...ENABLED_BOUNCE_EXIT,
    enabled: false,
    mode: "off",
  };

  it("services a bounce OWNER even when bounceExit is DISABLED and the lane is not GATE", () => {
    // entryLane=null → NOT GATE-eligible; exit_owner='bounce' → owner-authoritative.
    const result = evaluateDecisionPlan(
      input({
        position: position({ entryLane: null, exitOwner: "bounce" }),
        executionPolicy: executionPolicy({ bounceExit: DISABLED_BOUNCE }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
    expect(result.signal.side).toBe("sell");
  });

  it("services a bounce OWNER even when the market is dropped from the whitelist", () => {
    const result = evaluateDecisionPlan(
      input({
        position: position({ entryLane: null, exitOwner: "bounce" }),
        executionPolicy: executionPolicy({
          bounceExit: { ...ENABLED_BOUNCE_EXIT, whitelistConditionIds: [] },
        }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(BOUNCE_EXIT_TARGET_RULE_ID);
  });

  it("does NOT bounce-service a NON-owner non-GATE position when bounceExit is disabled (contrast)", () => {
    const result = evaluateDecisionPlan(
      input({
        position: position({ entryLane: null, exitOwner: null }),
        executionPolicy: executionPolicy({ bounceExit: DISABLED_BOUNCE }),
      }),
    );
    // Owner is what flips servicing on — without it, a disabled/non-GATE position
    // must NOT be routed to the bounce ladder.
    const isBounceSignal =
      result.type === "signal" && result.signal.decisionRuleId === BOUNCE_EXIT_TARGET_RULE_ID;
    expect(isBounceSignal).toBe(false);
  });
});
