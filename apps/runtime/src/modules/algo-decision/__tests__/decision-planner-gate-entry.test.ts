import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  GATE_ENTRY_RULE_ID,
  createPositionId,
  createTokenId,
  type AlgoDecisionRule,
  type AlgoSizeRule,
  type ConditionId,
  type ExecutionPolicy,
  type GateEntryPolicy,
  type LegState,
  type NormalizedMarket,
  type Position,
} from "@krabs/domain";
import { evaluateDecisionPlan, type DecisionPlanningInput } from "../decision-planner.js";

// Covers docs/plans/2026-07-15-gate-bounce-live-experiment.md — Phase 2: the GATE
// live first-entry branch in the ACTIVE decision path. GATE is default-OFF and
// strictly whitelist/mode-gated; any unmet condition must SUPPRESS (no draft),
// never substitute another order.

const tokenId = createTokenId("gate-entry-planner-token");
const now = Date.parse("2026-06-20T00:00:00.000Z");
const CONDITION_ID = "gate-condition";

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
    slug: "gate-entry-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Gate entry planner?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    // ~105 days after gammaCreatedAt below — well above the 30d GATE floor.
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
    firstTradePrice: 0.12,
    firstTradeAt: "2026-05-19T00:00:00.000Z",
    lastTradeAt: "2026-05-19T00:10:00.000Z",
    updatedAt: "2026-05-19T00:10:00.000Z",
    cumulativeBuySize: 100,
    cumulativeBuyNotional: 12,
    cumulativeSellSize: 0,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("gate-entry-pos"),
    tokenId,
    conditionId: CONDITION_ID as ConditionId,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.12,
    costBasisUsdc: 12,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: "2026-05-19T00:00:00.000Z",
    closedAt: null,
    updatedAt: "2026-05-19T00:10:00.000Z",
    ...overrides,
  };
}

// Fully eligible GATE policy: enabled + micro_live + whitelisted + research-backed
// thresholds (matches DEFAULT_GATE_ENTRY's minLifespanDays/minPrice/maxPrice).
const ENABLED_GATE_ENTRY: GateEntryPolicy = {
  enabled: true,
  mode: "micro_live",
  minLifespanDays: 30,
  minPrice: 0.01,
  maxPrice: 0.15,
  whitelistConditionIds: [CONDITION_ID],
  microMaxOrderUsdc: 2,
};

function executionPolicy(overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    entryMinMarketAgeSeconds: 0,
    // Isolated from R23 by default so GATE-only tests aren't coupled to R23's
    // own dip math; the mutual-exclusion test below re-enables R23 explicitly.
    r23DipTrigger: { enabled: false, dropThresholdRatio: 0.683, windowMs: 86_400_000 },
    gateEntry: ENABLED_GATE_ENTRY,
    ...overrides,
  };
}

function input(overrides: Partial<DecisionPlanningInput> = {}): DecisionPlanningInput {
  return {
    tokenId,
    now,
    selectedForEntry: true,
    hasPendingBuyOrder: false,
    legState: null,
    position: null,
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
    sellLoopGuard: null,
    ...overrides,
  };
}

describe("GATE live first-entry branch (decision-planner)", () => {
  it("emits exactly one probe-entry BUY draft with GATE_ENTRY_RULE_ID when fully eligible", () => {
    const result = evaluateDecisionPlan(input());
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(GATE_ENTRY_RULE_ID);
    expect(result.signal.side).toBe("buy");
    expect(result.signal.reason).toBe("probe-entry");
  });

  it("SUPPRESSES (no draft) when gateEntry.enabled is false", () => {
    const result = evaluateDecisionPlan(
      input({
        executionPolicy: executionPolicy({ gateEntry: { ...ENABLED_GATE_ENTRY, enabled: false } }),
      }),
    );
    expect(result.type).toBe("none");
  });

  it("SUPPRESSES (no draft) when gateEntry.mode is 'off'", () => {
    const result = evaluateDecisionPlan(
      input({
        executionPolicy: executionPolicy({ gateEntry: { ...ENABLED_GATE_ENTRY, mode: "off" } }),
      }),
    );
    expect(result.type).toBe("none");
  });

  it("SUPPRESSES (no draft) when the conditionId is off the whitelist", () => {
    const result = evaluateDecisionPlan(
      input({
        executionPolicy: executionPolicy({
          gateEntry: { ...ENABLED_GATE_ENTRY, whitelistConditionIds: ["some-other-condition"] },
        }),
      }),
    );
    expect(result.type).toBe("none");
  });

  it("SUPPRESSES (no draft) when GATE eligibility fails (lifespan below minLifespanDays)", () => {
    const result = evaluateDecisionPlan(
      input({
        // gammaCreatedAt just 7 days before endDate — well under the 30d floor;
        // midPrice unchanged (0.1, in-band) so only the lifespan leg fails.
        market: market({ gammaCreatedAt: "2026-08-25T00:00:00.000Z" }),
      }),
    );
    expect(result.type).toBe("none");
  });

  it("SUPPRESSES (no draft) when there is a pending BUY order", () => {
    const result = evaluateDecisionPlan(input({ hasPendingBuyOrder: true }));
    expect(result.type).toBe("none");
  });

  it("SUPPRESSES (no draft) when an open position already exists without a leg", () => {
    // legState null + an open position is an existing holding, not a first
    // entry — GATE must not re-probe it.
    const result = evaluateDecisionPlan(input({ legState: null, position: position() }));
    expect(result.type).toBe("none");
  });

  it("fires R23 instead of GATE when both would otherwise be eligible — mutual exclusion on !r23Fired", () => {
    const result = evaluateDecisionPlan(
      input({
        executionPolicy: executionPolicy({
          r23DipTrigger: { enabled: true, dropThresholdRatio: 0.683, windowMs: 86_400_000 },
        }),
      }),
    );
    // mid 0.1 / r23MaxMidpoint 0.2 = ratio 0.5 <= 0.683 → R23 fires; the same
    // market/price is also GATE-eligible, but only one signal must come out.
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe("R23_DIP_TRIGGER");
    expect(result.signal.decisionRuleId).not.toBe(GATE_ENTRY_RULE_ID);
  });

  it("does not fire GATE for an add/scale-in candidate (legState present) — first-entry only", () => {
    const result = evaluateDecisionPlan(input({ legState: leg(), selectedForEntry: false }));
    const isGateSignal =
      result.type === "signal" && result.signal.decisionRuleId === GATE_ENTRY_RULE_ID;
    expect(isGateSignal).toBe(false);
  });
});

// Covers docs/plans/2026-07-17-gate-entry-selection-bypass.md — the GATE selection
// bypass: a whitelisted market that failed ONLY the v5.11 hard data filters reaches
// the planner via `gateBypass` (NOT `selectedForEntry`) and is evaluated on a PURE
// GATE path — it may enter only via GATE, never fall through to R23 / the rule table.
describe("GATE selection-bypass path (decision-planner)", () => {
  it("emits a GATE_ENTRY probe-entry BUY for a gateBypass market that is NOT selectedForEntry", () => {
    const result = evaluateDecisionPlan(input({ selectedForEntry: false, gateBypass: true }));
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(GATE_ENTRY_RULE_ID);
    expect(result.signal.side).toBe("buy");
    expect(result.signal.reason).toBe("probe-entry");
  });

  it("SUPPRESSES a not-selectedForEntry whitelist market when gateBypass is false (bypass is required)", () => {
    const result = evaluateDecisionPlan(input({ selectedForEntry: false, gateBypass: false }));
    expect(result.type).toBe("none");
  });

  it("SUPPRESSES (gate-not-eligible) a gateBypass market whose mid is outside the GATE band, and NEVER falls through to R23", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        gateBypass: true,
        // mid 0.3 > maxPrice 0.15 → GATE eligibility fails; book two-sided so the
        // mid-price/isAlive checks still pass and we reach the gate-only block.
        market: market({ bestBid: 0.29, bestAsk: 0.31, midPrice: 0.3 }),
        // R23 armed with a dip that WOULD fire (0.3 / 0.6 = 0.5 <= 0.683) — it must
        // NOT fire, proving the gate-only path returns before ever reaching R23.
        executionPolicy: executionPolicy({
          r23DipTrigger: { enabled: true, dropThresholdRatio: 0.683, windowMs: 86_400_000 },
        }),
        r23MaxMidpoint: 0.6,
      }),
    );
    expect(result.type).toBe("none");
    if (result.type !== "none") return;
    // Hard proof the gate-only path returned BEFORE the R23 branch: R23 was never
    // evaluated (counter stays 0), and the suppression carries the GATE-scoped reason
    // — not an R23 reason, and not a min-size suppression from an accidental
    // fall-through to R23 / the generic rule table.
    expect(result.metrics.r23DipChecked).toBe(0);
    expect(result.suppressions.some((s) => s.reasonCode === "gate-not-eligible")).toBe(true);
  });
});

// docs/plans/2026-07-17-gate-isalive-plankton-whitelist.md — the GATE-whitelist liveness
// override: a gateBypass flat-first-entry market whose runtime carries stale
// acceptingOrders/enableOrderBook=false (CLOB says live) but a live bestBid must reach the
// GATE lane; no_bid still blocks; a non-gateBypass market is NOT relaxed.
describe("GATE-whitelist liveness override (decision-planner)", () => {
  it("enters a gateBypass market with stale acceptingOrders/enableOrderBook=false + live bestBid", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        gateBypass: true,
        market: market({ acceptingOrders: false, enableOrderBook: false }),
      }),
    );
    expect(result.type).toBe("signal");
    if (result.type !== "signal") return;
    expect(result.signal.decisionRuleId).toBe(GATE_ENTRY_RULE_ID);
  });

  it("still blocks (market-not-live) a gateBypass market with no_bid, even under the override", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: false,
        gateBypass: true,
        market: market({ acceptingOrders: false, enableOrderBook: false, bestBid: null }),
      }),
    );
    expect(result.type).toBe("none");
  });

  it("does NOT relax isAlive for a non-gateBypass (selectedForEntry) market — stays market-not-live", () => {
    const result = evaluateDecisionPlan(
      input({
        selectedForEntry: true,
        gateBypass: false,
        market: market({ acceptingOrders: false, enableOrderBook: false }),
      }),
    );
    expect(result.type).toBe("none");
  });
});
