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
        maxOpenBuyOrders: 15,
        maxOpenBuyOrdersPerToken: 2,
      },
      sellCapacity: {
        enabled: true,
        maxOpenSellOrders: 10,
        maxOpenSellOrdersPerToken: 2,
      },
      orderCapacity: {
        enabled: true,
        maxOpenOrdersTotal: 22,
      },
      repriceOnOutbid: {
        enabled: true,
        maxRepriceCount: 5,
      },
      dropTrigger: {
        enabled: true,
        thresholdPct: -0.02,
        lookbackMs: 3_600_000,
        historyMaxAgeMs: 600_000,
      },
      multiBuyLadder: {
        enabled: true,
        maxLadderFillsPerToken: 5,
        ladderGapMs: 60_000,
        perTokenUsdcCap: 10,
        maxPriceDriftTicks: 5,
        minStepFillRate: 0.1,
      },
      opportunisticTaker: {
        enabled: true,
        maxSpreadTicks: 2,
        sides: ["buy", "sell"],
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
      maxOpenBuyOrders: 15,
      maxOpenBuyOrdersPerToken: 2,
    });
    expect(policy.sellCapacity).toEqual({
      enabled: true,
      maxOpenSellOrders: 10,
      maxOpenSellOrdersPerToken: 2,
    });
    expect(policy.orderCapacity).toEqual({
      enabled: true,
      maxOpenOrdersTotal: 22,
    });
    expect(policy.repriceOnOutbid).toEqual({ enabled: true, maxRepriceCount: 5 });
    expect(policy.dropTrigger).toEqual({
      enabled: true,
      failOpenOnNoData: true,
      thresholdPct: -0.02,
      lookbackMs: 3_600_000,
      historyMaxAgeMs: 600_000,
    });
    expect(policy.multiBuyLadder).toEqual({
      enabled: true,
      maxLadderFillsPerToken: 5,
      ladderGapMs: 60_000,
      perTokenUsdcCap: 10,
      maxPriceDriftTicks: 5,
      minStepFillRate: 0.1,
    });
    expect(policy.opportunisticTaker).toEqual({
      enabled: true,
      maxSpreadTicks: 2,
      sides: ["buy", "sell"],
      safetyBuffer: 1.05,
      fallbackMinNotionalUsdc: 1,
      marketableBuyMinNotionalUsdc: 1,
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

  it("parses opportunistic taker settings and rejects invalid sides", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        opportunisticTaker: {
          enabled: false,
          maxSpreadTicks: 4,
          sides: ["buy"],
          safetyBuffer: 2,
          fallbackMinNotionalUsdc: 0.5,
          marketableBuyMinNotionalUsdc: 0.75,
        },
      }),
    );
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.policy.opportunisticTaker).toEqual({
      enabled: false,
      maxSpreadTicks: 4,
      sides: ["buy"],
      safetyBuffer: 2,
      fallbackMinNotionalUsdc: 0.5,
      marketableBuyMinNotionalUsdc: 0.75,
    });

    const invalid = parseExecutionPolicyJson(
      JSON.stringify({ opportunisticTaker: { enabled: true, maxSpreadTicks: 2, sides: ["hold"] } }),
    );
    expect(invalid.policy.opportunisticTaker).toEqual(DEFAULT_EXECUTION_POLICY.opportunisticTaker);
    expect(invalid.issues.some((i) => i.includes("opportunisticTaker.sides"))).toBe(true);
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
          maxOpenBuyOrdersPerToken: -1,
        },
      }),
    );
    expect(policy.buyCapacity).toEqual(DEFAULT_EXECUTION_POLICY.buyCapacity);
    expect(issues.some((i) => i.includes("buyCapacity.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("buyCapacity.minNewEntryWalletHeadroomUsdc"))).toBe(true);
    expect(issues.some((i) => i.includes("buyCapacity.minAddWalletHeadroomUsdc"))).toBe(true);
    expect(issues.some((i) => i.includes("buyCapacity.maxOpenBuyOrders"))).toBe(true);
    expect(issues.some((i) => i.includes("buyCapacity.maxOpenBuyOrdersPerToken"))).toBe(true);
  });

  it("preserves partial sell/order-capacity overrides and defaults the rest", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        sellCapacity: { maxOpenSellOrders: 7 },
        orderCapacity: { maxOpenOrdersTotal: 19 },
      }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.sellCapacity).toEqual({
      ...DEFAULT_EXECUTION_POLICY.sellCapacity,
      maxOpenSellOrders: 7,
    });
    expect(policy.orderCapacity).toEqual({
      ...DEFAULT_EXECUTION_POLICY.orderCapacity,
      maxOpenOrdersTotal: 19,
    });
  });

  it("rejects invalid sell/order-capacity values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        sellCapacity: {
          enabled: "yes",
          maxOpenSellOrders: 1.5,
          maxOpenSellOrdersPerToken: -1,
        },
        orderCapacity: {
          enabled: "yes",
          maxOpenOrdersTotal: 1.5,
        },
      }),
    );
    expect(policy.sellCapacity).toEqual(DEFAULT_EXECUTION_POLICY.sellCapacity);
    expect(policy.orderCapacity).toEqual(DEFAULT_EXECUTION_POLICY.orderCapacity);
    expect(issues.some((i) => i.includes("sellCapacity.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("sellCapacity.maxOpenSellOrders"))).toBe(true);
    expect(issues.some((i) => i.includes("sellCapacity.maxOpenSellOrdersPerToken"))).toBe(true);
    expect(issues.some((i) => i.includes("orderCapacity.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("orderCapacity.maxOpenOrdersTotal"))).toBe(true);
  });

  it("rejects invalid market-selection values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ marketSelection: { maxMidPrice: 2, minLiquidity: -1 } }),
    );
    expect(policy.marketSelection).toEqual(DEFAULT_EXECUTION_POLICY.marketSelection);
    expect(issues.some((i) => i.includes("marketSelection.maxMidPrice"))).toBe(true);
    expect(issues.some((i) => i.includes("marketSelection.minLiquidity"))).toBe(true);
  });

  it("preserves partial fill-rate feature overrides and defaults the rest", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        exitPricingMode: "edge",
        exitBidAnchorTicks: 7,
        repriceOnOutbid: { enabled: false },
        exitRepriceOnDownprice: { thresholdTicks: 7 },
        dropTrigger: { enabled: true, failOpenOnNoData: false, thresholdPct: -0.05 },
        multiBuyLadder: { maxLadderFillsPerToken: 4 },
        opportunisticTaker: { maxSpreadTicks: 4, sides: ["sell"] },
      }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.exitPricingMode).toBe("edge");
    expect(policy.exitBidAnchorTicks).toBe(7);
    expect(policy.repriceOnOutbid).toEqual({
      ...DEFAULT_EXECUTION_POLICY.repriceOnOutbid,
      enabled: false,
    });
    expect(policy.exitRepriceOnDownprice).toEqual({
      ...DEFAULT_EXECUTION_POLICY.exitRepriceOnDownprice,
      thresholdTicks: 7,
    });
    expect(policy.dropTrigger).toEqual({
      ...DEFAULT_EXECUTION_POLICY.dropTrigger,
      enabled: true,
      failOpenOnNoData: false,
      thresholdPct: -0.05,
    });
    expect(policy.multiBuyLadder).toEqual({
      ...DEFAULT_EXECUTION_POLICY.multiBuyLadder,
      maxLadderFillsPerToken: 4,
    });
    expect(policy.opportunisticTaker).toEqual({
      ...DEFAULT_EXECUTION_POLICY.opportunisticTaker,
      maxSpreadTicks: 4,
      sides: ["sell"],
    });
  });

  it("parses redeem sweep policy and defaults missing fields", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ redeemSweep: { enabled: false, intervalMs: 120_000 } }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.redeemSweep).toEqual({
      ...DEFAULT_EXECUTION_POLICY.redeemSweep,
      enabled: false,
      intervalMs: 120_000,
    });
  });

  it("defaults multi-buy ladder perTokenUsdcCap to Plankton-aligned 25 USDC", () => {
    expect(DEFAULT_EXECUTION_POLICY.multiBuyLadder.perTokenUsdcCap).toBe(25);
  });

  it("defaults redeem sweep to auto-on with four-hour cadence", () => {
    expect(DEFAULT_EXECUTION_POLICY.redeemSweep).toMatchObject({
      enabled: true,
      intervalMs: 14_400_000,
    });
    expect(DEFAULT_EXECUTION_POLICY.redeemSweep).not.toHaveProperty("minAgeAfterResolutionSec");
  });

  it("rejects invalid fill-rate feature policy values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        exitPricingMode: "ask",
        exitBidAnchorTicks: -1,
        repriceOnOutbid: { enabled: "yes", maxRepriceCount: 1.5 },
        exitRepriceOnDownprice: {
          enabled: "yes",
          thresholdTicks: -1,
          maxRepricesPerOrder: 1.5,
          stuckWarningEnabled: "yes",
          stuckWarningAgeMs: 1,
          stuckWarningGapPct: 2,
        },
        dropTrigger: {
          enabled: "yes",
          failOpenOnNoData: "yes",
          thresholdPct: 0.1,
          lookbackMs: 1,
        },
        multiBuyLadder: {
          enabled: "yes",
          maxLadderFillsPerToken: 0,
          ladderGapMs: 1,
          perTokenUsdcCap: -1,
          maxPriceDriftTicks: -1,
          minStepFillRate: 2,
        },
        opportunisticTaker: {
          enabled: "yes",
          maxSpreadTicks: -1,
          sides: ["buy", "hold"],
        },
      }),
    );
    expect(policy.exitPricingMode).toBe(DEFAULT_EXECUTION_POLICY.exitPricingMode);
    expect(policy.exitBidAnchorTicks).toBe(DEFAULT_EXECUTION_POLICY.exitBidAnchorTicks);
    expect(policy.repriceOnOutbid).toEqual(DEFAULT_EXECUTION_POLICY.repriceOnOutbid);
    expect(policy.exitRepriceOnDownprice).toEqual(DEFAULT_EXECUTION_POLICY.exitRepriceOnDownprice);
    expect(policy.dropTrigger).toEqual(DEFAULT_EXECUTION_POLICY.dropTrigger);
    expect(policy.multiBuyLadder).toEqual(DEFAULT_EXECUTION_POLICY.multiBuyLadder);
    expect(policy.opportunisticTaker).toEqual(DEFAULT_EXECUTION_POLICY.opportunisticTaker);
    expect(issues.some((i) => i.includes("repriceOnOutbid.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("exitPricingMode"))).toBe(true);
    expect(issues.some((i) => i.includes("exitBidAnchorTicks"))).toBe(true);
    expect(issues.some((i) => i.includes("repriceOnOutbid.maxRepriceCount"))).toBe(true);
    expect(issues.some((i) => i.includes("exitRepriceOnDownprice.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("exitRepriceOnDownprice.thresholdTicks"))).toBe(true);
    expect(issues.some((i) => i.includes("exitRepriceOnDownprice.maxRepricesPerOrder"))).toBe(true);
    expect(issues.some((i) => i.includes("exitRepriceOnDownprice.stuckWarningEnabled"))).toBe(true);
    expect(issues.some((i) => i.includes("exitRepriceOnDownprice.stuckWarningAgeMs"))).toBe(true);
    expect(issues.some((i) => i.includes("exitRepriceOnDownprice.stuckWarningGapPct"))).toBe(true);
    expect(issues.some((i) => i.includes("dropTrigger.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("dropTrigger.failOpenOnNoData"))).toBe(true);
    expect(issues.some((i) => i.includes("dropTrigger.thresholdPct"))).toBe(true);
    expect(issues.some((i) => i.includes("dropTrigger.lookbackMs"))).toBe(true);
    expect(issues.some((i) => i.includes("multiBuyLadder.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("multiBuyLadder.maxLadderFillsPerToken"))).toBe(true);
    expect(issues.some((i) => i.includes("multiBuyLadder.ladderGapMs"))).toBe(true);
    expect(issues.some((i) => i.includes("multiBuyLadder.perTokenUsdcCap"))).toBe(true);
    expect(issues.some((i) => i.includes("multiBuyLadder.maxPriceDriftTicks"))).toBe(true);
    expect(issues.some((i) => i.includes("multiBuyLadder.minStepFillRate"))).toBe(true);
    expect(issues.some((i) => i.includes("opportunisticTaker.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("opportunisticTaker.maxSpreadTicks"))).toBe(true);
    expect(issues.some((i) => i.includes("opportunisticTaker.sides"))).toBe(true);
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
