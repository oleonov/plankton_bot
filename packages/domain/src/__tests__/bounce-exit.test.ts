import { describe, expect, it } from "vitest";

import { DEFAULT_GATE_ENTRY, DEFAULT_BOUNCE_EXIT } from "../execution-policy.js";
import {
  evaluateGateEntryEligibility,
  isGateWhitelisted,
  evaluateBounceExit,
  bounceExitTierGain,
  isBounceForceExit,
  BOUNCE_EXIT_TARGET_RULE_ID,
  BOUNCE_EXIT_BACKSTOP_RULE_ID,
  type GateEntryMarketInput,
  type BounceExitContext,
} from "../bounce-exit.js";
import type { BounceExitPolicy, GateEntryPolicy } from "../types.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function daysAfterCreated(days: number): string {
  return new Date(Date.parse(CREATED_AT) + days * 86_400_000).toISOString();
}

function market(overrides: Partial<GateEntryMarketInput> = {}): GateEntryMarketInput {
  return {
    endDate: daysAfterCreated(30),
    gammaCreatedAt: CREATED_AT,
    midPrice: 0.05,
    ...overrides,
  };
}

// DEFAULT_GATE_ENTRY: minLifespanDays 30, minPrice 0.01, maxPrice 0.15.
const policy = DEFAULT_GATE_ENTRY;

describe("evaluateGateEntryEligibility — lifespan boundary (inclusive >=)", () => {
  it("passes at exactly 30 days (min bound, inclusive)", () => {
    expect(evaluateGateEntryEligibility(policy, market({ endDate: daysAfterCreated(30) }))).toBe(
      true,
    );
  });

  it("fails at 29.9 days (just below min bound)", () => {
    expect(evaluateGateEntryEligibility(policy, market({ endDate: daysAfterCreated(29.9) }))).toBe(
      false,
    );
  });

  it("passes well above the min bound", () => {
    expect(evaluateGateEntryEligibility(policy, market({ endDate: daysAfterCreated(365) }))).toBe(
      true,
    );
  });
});

describe("evaluateGateEntryEligibility — price boundary (inclusive [minPrice, maxPrice])", () => {
  it("passes at exactly minPrice 0.01 (inclusive)", () => {
    expect(evaluateGateEntryEligibility(policy, market({ midPrice: 0.01 }))).toBe(true);
  });

  it("fails just below minPrice", () => {
    expect(evaluateGateEntryEligibility(policy, market({ midPrice: 0.009 }))).toBe(false);
  });

  it("passes at exactly maxPrice 0.15 (inclusive)", () => {
    expect(evaluateGateEntryEligibility(policy, market({ midPrice: 0.15 }))).toBe(true);
  });

  it("fails at 0.151 (just above maxPrice)", () => {
    expect(evaluateGateEntryEligibility(policy, market({ midPrice: 0.151 }))).toBe(false);
  });
});

describe("evaluateGateEntryEligibility — fail-closed on missing inputs", () => {
  it("fails when endDate is null (lifespan undeterminable)", () => {
    expect(evaluateGateEntryEligibility(policy, market({ endDate: null }))).toBe(false);
  });

  it("fails when gammaCreatedAt is null (lifespan undeterminable)", () => {
    expect(evaluateGateEntryEligibility(policy, market({ gammaCreatedAt: null }))).toBe(false);
  });

  it("fails when midPrice is null", () => {
    expect(evaluateGateEntryEligibility(policy, market({ midPrice: null }))).toBe(false);
  });

  it("fails when midPrice is NaN", () => {
    expect(evaluateGateEntryEligibility(policy, market({ midPrice: Number.NaN }))).toBe(false);
  });

  it("fails when endDate is unparseable", () => {
    expect(evaluateGateEntryEligibility(policy, market({ endDate: "not-a-date" }))).toBe(false);
  });
});

describe("evaluateGateEntryEligibility — custom policy overrides", () => {
  it("uses the injected policy thresholds, not the defaults", () => {
    const loosePolicy = { ...policy, minLifespanDays: 1, minPrice: 0, maxPrice: 1 };
    expect(
      evaluateGateEntryEligibility(
        loosePolicy,
        market({ endDate: daysAfterCreated(2), midPrice: 0.9 }),
      ),
    ).toBe(true);
    // Same market fails under the stricter default policy (midPrice 0.9 > maxPrice 0.15).
    expect(
      evaluateGateEntryEligibility(policy, market({ endDate: daysAfterCreated(2), midPrice: 0.9 })),
    ).toBe(false);
  });
});

// bounceExitTierGain — Phase 1 (docs/plans/2026-07-16-bounce-exit-ladder-redesign.md).
// DEFAULT_BOUNCE_EXIT.targetTiers: ≤0.02→0.36, ≤0.03→0.27, ≤0.05→0.19, ≤0.08→0.15,
// ≤0.15→0.15, ≤0.35→0.12, ≤1.0→0.08. Inclusive lookup (price <= maxPrice), unlike
// D8's exclusive `<` bucket lookup.
describe("bounceExitTierGain — inclusive tier boundaries", () => {
  it("entry 0.02 (exactly the first tier's maxPrice, inclusive) → 0.36", () => {
    expect(bounceExitTierGain(DEFAULT_BOUNCE_EXIT, 0.02)).toBe(0.36);
  });

  it("entry exactly 0.05 (tier boundary, inclusive) → 0.19", () => {
    expect(bounceExitTierGain(DEFAULT_BOUNCE_EXIT, 0.05)).toBe(0.19);
  });

  it("entry 0.051 (just above the 0.05 boundary) → falls into the next tier, 0.15", () => {
    expect(bounceExitTierGain(DEFAULT_BOUNCE_EXIT, 0.051)).toBe(0.15);
  });

  it("entry 0.5 (within the catch-all ≤1.0 tier) → 0.08", () => {
    expect(bounceExitTierGain(DEFAULT_BOUNCE_EXIT, 0.5)).toBe(0.08);
  });

  it("entry below the smallest tier's maxPrice still resolves to that tier", () => {
    expect(bounceExitTierGain(DEFAULT_BOUNCE_EXIT, 0.001)).toBe(0.36);
  });

  it("falls back to the last tier's gainPct for an entry beyond every maxPrice (defensive only)", () => {
    const policy: BounceExitPolicy = {
      ...DEFAULT_BOUNCE_EXIT,
      targetTiers: [{ maxPrice: 0.5, gainPct: 0.2 }],
    };
    expect(bounceExitTierGain(policy, 0.9)).toBe(0.2);
  });
});

// evaluateBounceExit — ladder redesign Phase 2 (docs/plans/2026-07-16-bounce-
// exit-ladder-redesign.md). DEFAULT_BOUNCE_EXIT.ladderFractions: [0.3, 0.4, 0.3];
// ladderStepPct: 0.22. For firstEntryPrice 0.1, bounceExitTierGain resolves to
// 0.15 (0.08 < 0.1 <= 0.15 tier — see the tier-gain tests above), so:
//   rung0 px = ceilToTick(0.1 * 1.15, 0.01)                          = 0.12
//   rung1 px = ceilToTick(0.1 * (1.15 * 1.22 - 1 + 1), 0.01)         = 0.15
//   rung2 px = ceilToTick(0.1 * (1.15 * 1.22^2 - 1 + 1), 0.01)       = 0.18
// (values hand-verified against tick-math.ts's ceilQuantize).
const bounceExitPolicy = DEFAULT_BOUNCE_EXIT;

function bounceCtx(overrides: Partial<BounceExitContext> = {}): BounceExitContext {
  return {
    firstEntryPrice: 0.1,
    tickSize: 0.01,
    placedRungIndices: [],
    backstopEligible: false,
    ...overrides,
  };
}

describe("evaluateBounceExit — rung selection on a fresh GATE position", () => {
  it("emits rung0 at firstEntryPrice x (1 + tierGain), sized by ladderFractions[0]", () => {
    const result = evaluateBounceExit(bounceCtx(), bounceExitPolicy);
    expect(result).toEqual({ intent: "maker_rung", rungIndex: 0, px: 0.12, fraction: 0.3 });
  });

  it("anchors to firstEntryPrice, not a different (e.g. averaged) entry price", () => {
    // entry 0.05 sits in the <=0.05 tier (gainPct 0.19, inclusive boundary).
    const result = evaluateBounceExit(bounceCtx({ firstEntryPrice: 0.05 }), bounceExitPolicy);
    expect(result).toEqual({ intent: "maker_rung", rungIndex: 0, px: 0.06, fraction: 0.3 });
  });
});

describe("evaluateBounceExit — next-cycle rung advancement", () => {
  it("skips rung0 once placed and emits rung1 at the compounded ladder step, sized 0.4", () => {
    const result = evaluateBounceExit(bounceCtx({ placedRungIndices: [0] }), bounceExitPolicy);
    expect(result).toEqual({ intent: "maker_rung", rungIndex: 1, px: 0.15, fraction: 0.4 });
  });

  it("emits rung2 once rung0 and rung1 are both placed, sized 0.3", () => {
    const result = evaluateBounceExit(bounceCtx({ placedRungIndices: [0, 1] }), bounceExitPolicy);
    expect(result).toEqual({ intent: "maker_rung", rungIndex: 2, px: 0.18, fraction: 0.3 });
  });

  it("selects the lowest un-placed rung, not merely 'after the highest placed'", () => {
    // Only rung1 is placed (e.g. an out-of-order fill/backfill) — rung0 is
    // still open work and must be selected ahead of rung2.
    const result = evaluateBounceExit(bounceCtx({ placedRungIndices: [1] }), bounceExitPolicy);
    expect(result).toEqual({ intent: "maker_rung", rungIndex: 0, px: 0.12, fraction: 0.3 });
  });

  it("does not re-emit a rung that is already placed (open or filled)", () => {
    const result = evaluateBounceExit(
      bounceCtx({ placedRungIndices: [0, 1, 2] }),
      bounceExitPolicy,
    );
    expect(result.intent).not.toBe("maker_rung");
  });
});

describe("evaluateBounceExit — ladder complete, no backstop", () => {
  it("returns none once every rung is placed and backstopEligible is false", () => {
    const result = evaluateBounceExit(
      bounceCtx({ placedRungIndices: [0, 1, 2], backstopEligible: false }),
      bounceExitPolicy,
    );
    expect(result).toEqual({ intent: "none" });
  });
});

describe("evaluateBounceExit — backstop_taker", () => {
  it("returns backstop_taker when backstopEligible is true, even with rungs still open", () => {
    const result = evaluateBounceExit(
      bounceCtx({ placedRungIndices: [], backstopEligible: true }),
      bounceExitPolicy,
    );
    expect(result).toEqual({ intent: "backstop_taker" });
  });

  it("returns backstop_taker when backstopEligible is true even with every rung already placed", () => {
    const result = evaluateBounceExit(
      bounceCtx({ placedRungIndices: [0, 1, 2], backstopEligible: true }),
      bounceExitPolicy,
    );
    expect(result).toEqual({ intent: "backstop_taker" });
  });
});

describe("isBounceForceExit", () => {
  it("is true for a lowercase sell signal on the backstop rule id", () => {
    expect(isBounceForceExit({ side: "sell", decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID })).toBe(
      true,
    );
  });

  it("is true case-insensitively for an uppercase SELL side", () => {
    expect(isBounceForceExit({ side: "SELL", decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID })).toBe(
      true,
    );
  });

  it("is false for the ladder target rule id (not a force-exit)", () => {
    expect(isBounceForceExit({ side: "sell", decisionRuleId: BOUNCE_EXIT_TARGET_RULE_ID })).toBe(
      false,
    );
  });

  it("is false for a buy side even on the backstop rule id", () => {
    expect(isBounceForceExit({ side: "buy", decisionRuleId: BOUNCE_EXIT_BACKSTOP_RULE_ID })).toBe(
      false,
    );
  });

  it("is false when decisionRuleId is null", () => {
    expect(isBounceForceExit({ side: "sell", decisionRuleId: null })).toBe(false);
  });
});

// docs/plans/2026-07-17-gate-entry-selection-bypass.md — the single predicate the
// GATE entry branch and the GATE selection-bypass share (must stay in sync).
describe("isGateWhitelisted", () => {
  const COND = "cond-x";
  const live: GateEntryPolicy = {
    ...DEFAULT_GATE_ENTRY,
    enabled: true,
    mode: "micro_live",
    whitelistConditionIds: [COND],
  };

  it("is true when enabled + micro_live + conditionId whitelisted", () => {
    expect(isGateWhitelisted(live, COND)).toBe(true);
  });

  it("is false when disabled", () => {
    expect(isGateWhitelisted({ ...live, enabled: false }, COND)).toBe(false);
  });

  it("is false when mode is 'off'", () => {
    expect(isGateWhitelisted({ ...live, mode: "off" }, COND)).toBe(false);
  });

  it("is false when the conditionId is not on the whitelist", () => {
    expect(isGateWhitelisted(live, "other-cond")).toBe(false);
  });

  it("is false for a null or undefined policy", () => {
    expect(isGateWhitelisted(null, COND)).toBe(false);
    expect(isGateWhitelisted(undefined, COND)).toBe(false);
  });
});
