import { describe, expect, it } from "vitest";

import { DEFAULT_GATE_ENTRY, DEFAULT_BOUNCE_EXIT } from "../execution-policy.js";
import {
  evaluateGateEntryEligibility,
  evaluateBounceExit,
  type GateEntryMarketInput,
  type BounceExitContext,
} from "../bounce-exit.js";

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

// evaluateBounceExit — Phase 3 (docs/plans/2026-07-15-gate-bounce-live-experiment.md).
// DEFAULT_BOUNCE_EXIT: targetGainPct 0.257, timeoutMs 14_400_000 (4h == 14_400s).
const bounceExitPolicy = DEFAULT_BOUNCE_EXIT;

function bounceCtx(overrides: Partial<BounceExitContext> = {}): BounceExitContext {
  return {
    avgBuyPrice: 0.1,
    holdSeconds: 0,
    tickSize: 0.01,
    hasActiveBounceTargetOrder: false,
    ...overrides,
  };
}

describe("evaluateBounceExit — maker_target on a fresh fill", () => {
  it("returns maker_target at entry x 1.257, ceil-snapped to tick, when no target is resting", () => {
    const result = evaluateBounceExit(
      bounceCtx({ avgBuyPrice: 0.1, holdSeconds: 0 }),
      bounceExitPolicy,
    );
    expect(result).toEqual({ intent: "maker_target", targetPx: 0.13 });
  });

  it("does not fire a duplicate target while one is already resting", () => {
    const result = evaluateBounceExit(
      bounceCtx({ holdSeconds: 60, hasActiveBounceTargetOrder: true }),
      bounceExitPolicy,
    );
    expect(result).toEqual({ intent: "none" });
  });
});

describe("evaluateBounceExit — 4h timeout", () => {
  it("stays maker_target just below the timeout boundary", () => {
    const result = evaluateBounceExit(bounceCtx({ holdSeconds: 14_399 }), bounceExitPolicy);
    expect(result.intent).toBe("maker_target");
  });

  it("fires timeout_taker exactly at the timeout boundary (inclusive >=)", () => {
    const result = evaluateBounceExit(bounceCtx({ holdSeconds: 14_400 }), bounceExitPolicy);
    expect(result).toEqual({ intent: "timeout_taker" });
  });

  it("fires timeout_taker even when a target is still resting (hard bail-out)", () => {
    const result = evaluateBounceExit(
      bounceCtx({ holdSeconds: 20_000, hasActiveBounceTargetOrder: true }),
      bounceExitPolicy,
    );
    expect(result).toEqual({ intent: "timeout_taker" });
  });

  it("fires timeout_taker well past the timeout", () => {
    const result = evaluateBounceExit(bounceCtx({ holdSeconds: 100_000 }), bounceExitPolicy);
    expect(result).toEqual({ intent: "timeout_taker" });
  });
});
