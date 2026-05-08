import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
} from "./execution-policy.js";

describe("parseExecutionPolicyJson (ADR-015)", () => {
  it("returns defaults for null/empty input without issues", () => {
    const r1 = parseExecutionPolicyJson(null);
    expect(r1.policy).toBe(DEFAULT_EXECUTION_POLICY);
    expect(r1.issues).toHaveLength(0);

    const r2 = parseExecutionPolicyJson("   ");
    expect(r2.policy).toBe(DEFAULT_EXECUTION_POLICY);
    expect(r2.issues).toHaveLength(0);
  });

  it("falls back to defaults on malformed JSON with one issue", () => {
    const { policy, issues } = parseExecutionPolicyJson("{not-json");
    expect(policy).toBe(DEFAULT_EXECUTION_POLICY);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("invalid JSON");
  });

  it("rejects non-object payloads (arrays, scalars)", () => {
    const r1 = parseExecutionPolicyJson("[1,2,3]");
    expect(r1.issues[0]).toContain("must be an object");

    const r2 = parseExecutionPolicyJson('"hello"');
    expect(r2.issues[0]).toContain("must be an object");
  });

  it("accepts a well-formed full policy as-is", () => {
    const input = {
      version: 1,
      entryPriceCeiling: 0.6,
      exitOrderTtlMs: 600_000,
      marketSelection: { maxMidPrice: 0.42, minLiquidity: 250 },
      buyCapacity: {
        enabled: true,
        minNewEntryWalletHeadroomUsdc: 7,
        minAddWalletHeadroomUsdc: 5,
        maxOpenBuyOrders: 2,
      },
      deadSideGuard: { mode: "enforce", askCeiling: 0.05, maxTimeToEndMs: 60_000 },
      pricing: {
        mode: "bounded-midpoint",
        maxEntrySpreadTicks: 15,
        maxExitSpreadTicks: 30,
        maxImprovementTicks: 5,
        minExitPriceSignalRatio: 0.6,
        wideSpreadPolicy: "skip",
        oneSidedPolicy: "skip",
      },
      orderLifetime: {
        enabled: true,
        enforcement: "enforce",
        staleResetMs: 86_400_000,
        safetyBufferMs: 3_600_000,
        resolutionAggressiveWindowMs: 21_600_000,
        resolutionStopWindowMs: 3_600_000,
        resolutionExitTtlCapMs: 600_000,
        relayerSubmitBudgetPerMinute: 20,
        maxTransitionEventsPerTokenPerDay: 10,
        oscillationTransitionLimitPerDay: 3,
        burst: {
          candidateFirstFillLatencyMs: 30_000,
          confirmSpanMs: 180_000,
          confirmMedianGapMs: 30_000,
          confirmFirstFillLatencyMs: 120_000,
          confirmP75GapMs: 60_000,
          confirmMaxSpanMs: 300_000,
          lowTtlMs: 60_000,
          mediumTtlMs: 30_000,
          highTtlMs: 15_000,
        },
        middle: {
          minMedianGapMs: 60_000,
          maxMedianGapMs: 600_000,
          maxSpanMs: 3_600_000,
          lowTtlMs: 1_800_000,
          mediumTtlMs: 3_600_000,
          highTtlMs: 7_200_000,
        },
        passive: {
          lowTtlMs: 21_600_000,
          mediumTtlMs: 86_400_000,
          highTtlMs: 259_200_000,
          highConfidenceMinFills: 3,
          highConfidenceMinSpanMs: 21_600_000,
        },
      },
      telemetry: { deadSideCanary: false, pricingShadow: false },
    };
    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify(input));
    expect(issues).toHaveLength(0);
    expect(policy.entryPriceCeiling).toBe(0.6);
    expect(policy.marketSelection).toEqual({ maxMidPrice: 0.42, minLiquidity: 250 });
    expect(policy.buyCapacity).toEqual({
      enabled: true,
      minNewEntryWalletHeadroomUsdc: 7,
      minAddWalletHeadroomUsdc: 5,
      maxOpenBuyOrders: 2,
    });
    expect(policy.deadSideGuard.mode).toBe("enforce");
    expect(policy.pricing.mode).toBe("bounded-midpoint");
    expect(policy.pricing.minExitPriceSignalRatio).toBe(0.6);
    expect(policy.pricing.wideSpreadPolicy).toBe("skip");
    expect(policy.orderLifetime.passive.highTtlMs).toBe(259_200_000);
    expect(policy.telemetry.deadSideCanary).toBe(false);
  });

  it("falls back field-by-field on invalid enum values", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ deadSideGuard: { mode: "bogus" } }),
    );
    expect(policy.deadSideGuard.mode).toBe(DEFAULT_EXECUTION_POLICY.deadSideGuard.mode);
    expect(issues.some((i) => i.includes("deadSideGuard.mode"))).toBe(true);
  });

  it("clamps-to-default on out-of-range numbers (no silent clip)", () => {
    // entryPriceCeiling bounds are [0.05, 0.99]
    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify({ entryPriceCeiling: 5 }));
    expect(policy.entryPriceCeiling).toBe(DEFAULT_EXECUTION_POLICY.entryPriceCeiling);
    expect(issues.some((i) => i.includes("entryPriceCeiling"))).toBe(true);
  });

  it("rejects non-integer exitOrderTtlMs with an issue", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ exitOrderTtlMs: 12_345.6 }),
    );
    expect(policy.exitOrderTtlMs).toBe(DEFAULT_EXECUTION_POLICY.exitOrderTtlMs);
    expect(issues.some((i) => i.includes("exitOrderTtlMs"))).toBe(true);
  });

  it("preserves partial pricing override and defaults the rest", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ pricing: { mode: "bounded-midpoint" } }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.pricing.mode).toBe("bounded-midpoint");
    expect(policy.pricing.maxEntrySpreadTicks).toBe(
      DEFAULT_EXECUTION_POLICY.pricing.maxEntrySpreadTicks,
    );
    expect(policy.pricing.minExitPriceSignalRatio).toBe(
      DEFAULT_EXECUTION_POLICY.pricing.minExitPriceSignalRatio,
    );
    expect(policy.pricing.wideSpreadPolicy).toBe(DEFAULT_EXECUTION_POLICY.pricing.wideSpreadPolicy);
  });

  it("rejects invalid SELL signal-distance guard ratios with an issue", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ pricing: { minExitPriceSignalRatio: 1.5 } }),
    );
    expect(policy.pricing.minExitPriceSignalRatio).toBe(
      DEFAULT_EXECUTION_POLICY.pricing.minExitPriceSignalRatio,
    );
    expect(issues.some((i) => i.includes("pricing.minExitPriceSignalRatio"))).toBe(true);
  });

  it("preserves partial market-selection override and defaults the rest", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ marketSelection: { minLiquidity: 500 } }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.marketSelection.maxMidPrice).toBe(
      DEFAULT_EXECUTION_POLICY.marketSelection.maxMidPrice,
    );
    expect(policy.marketSelection.minLiquidity).toBe(500);
  });

  it("preserves partial order-lifetime override and defaults nested mode policies", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        orderLifetime: {
          enforcement: "enforce",
          passive: { lowTtlMs: 12 * 60 * 60_000 },
        },
      }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.orderLifetime.enforcement).toBe("enforce");
    expect(policy.orderLifetime.passive.lowTtlMs).toBe(12 * 60 * 60_000);
    expect(policy.orderLifetime.passive.highTtlMs).toBe(
      DEFAULT_EXECUTION_POLICY.orderLifetime.passive.highTtlMs,
    );
    expect(policy.orderLifetime.burst.highTtlMs).toBe(
      DEFAULT_EXECUTION_POLICY.orderLifetime.burst.highTtlMs,
    );
  });

  it("rejects invalid order-lifetime values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ orderLifetime: { enforcement: "live", passive: { highTtlMs: 1 } } }),
    );
    expect(policy.orderLifetime.enforcement).toBe(
      DEFAULT_EXECUTION_POLICY.orderLifetime.enforcement,
    );
    expect(policy.orderLifetime.passive.highTtlMs).toBe(
      DEFAULT_EXECUTION_POLICY.orderLifetime.passive.highTtlMs,
    );
    expect(issues.some((i) => i.includes("orderLifetime.enforcement"))).toBe(true);
    expect(issues.some((i) => i.includes("orderLifetime.passive.highTtlMs"))).toBe(true);
  });

  it("preserves partial buy-capacity override and defaults the rest", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ buyCapacity: { minNewEntryWalletHeadroomUsdc: 10 } }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.buyCapacity).toEqual({
      ...DEFAULT_EXECUTION_POLICY.buyCapacity,
      minNewEntryWalletHeadroomUsdc: 10,
    });
  });

  it("rejects invalid buy-capacity values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        buyCapacity: {
          enabled: "yes",
          minNewEntryWalletHeadroomUsdc: -1,
          minAddWalletHeadroomUsdc: 20_000,
          maxOpenBuyOrders: 1.5,
        },
      }),
    );
    expect(policy.buyCapacity).toEqual(DEFAULT_EXECUTION_POLICY.buyCapacity);
    expect(issues.some((i) => i.includes("buyCapacity.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("buyCapacity.minNewEntryWalletHeadroomUsdc"))).toBe(true);
    expect(issues.some((i) => i.includes("buyCapacity.minAddWalletHeadroomUsdc"))).toBe(true);
    expect(issues.some((i) => i.includes("buyCapacity.maxOpenBuyOrders"))).toBe(true);
  });

  it("rejects invalid market-selection values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ marketSelection: { maxMidPrice: 2, minLiquidity: -1 } }),
    );
    expect(policy.marketSelection).toEqual(DEFAULT_EXECUTION_POLICY.marketSelection);
    expect(issues.some((i) => i.includes("marketSelection.maxMidPrice"))).toBe(true);
    expect(issues.some((i) => i.includes("marketSelection.minLiquidity"))).toBe(true);
  });

  it("rejects deadSideGuard as array or scalar with an issue", () => {
    const { issues: a } = parseExecutionPolicyJson(JSON.stringify({ deadSideGuard: [1, 2] }));
    expect(a.some((i) => i.includes("deadSideGuard must be an object"))).toBe(true);

    const { issues: b } = parseExecutionPolicyJson(JSON.stringify({ deadSideGuard: 42 }));
    expect(b.some((i) => i.includes("deadSideGuard must be an object"))).toBe(true);
  });

  it("round-trips via serializeExecutionPolicy", () => {
    const { policy } = parseExecutionPolicyJson(
      JSON.stringify({
        pricing: { mode: "bounded-midpoint", maxEntrySpreadTicks: 42 },
      }),
    );
    const reparsed = parseExecutionPolicyJson(serializeExecutionPolicy(policy)).policy;
    expect(reparsed).toEqual(policy);
  });
});
