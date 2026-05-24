import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXIT_TTL_BY_LIQUIDITY_POLICY,
  DEFAULT_EXECUTION_POLICY,
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
} from "./execution-policy.js";
import { resolveExitTtlByMarket } from "./exit-ttl.js";

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
      exitTtlByLiquidity: { enabled: true, thinMs: 86_400_000, mediumMs: 21_600_000 },
      sellTimeoutMs: 21_600_000,
      sellReplaceMinPriceDeltaTicks: 3,
      exitRepriceThresholdPct: 0.25,
      exitRepriceThresholdTicks: 8,
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
      r23DipTrigger: {
        enabled: true,
        dropThresholdRatio: 0.683,
        windowMs: 86_400_000,
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
      repriceChain: {
        enabled: true,
        windowMs: 86_400_000,
        maxChainCount: 13,
        dynamicChainCap: {
          enabled: true,
          tradeCountThinThreshold: 12,
          tradeCountLiquidThreshold: 55,
          capThin: 45,
          capMedium: 25,
          capLiquid: 12,
          capUnknown: 28,
        },
      },
    };
    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify(input));
    expect(issues).toHaveLength(0);
    expect(policy.entryPriceCeiling).toBe(0.6);
    expect(policy.exitOrderTtlMs).toBe(600_000);
    expect(policy.exitTtlByLiquidity).toEqual({
      enabled: true,
      thinMs: 86_400_000,
      mediumMs: 21_600_000,
    });
    expect(policy.sellTimeoutMs).toBe(21_600_000);
    expect(policy.sellReplaceMinPriceDeltaTicks).toBe(3);
    expect(policy.exitRepriceThresholdPct).toBe(0.25);
    expect(policy.exitRepriceThresholdTicks).toBe(8);
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
    expect(policy.r23DipTrigger).toEqual({
      enabled: true,
      dropThresholdRatio: 0.683,
      windowMs: 86_400_000,
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
    expect(policy.repriceChain.dynamicChainCap).toEqual({
      enabled: true,
      tradeCountThinThreshold: 12,
      tradeCountLiquidThreshold: 55,
      capThin: 45,
      capMedium: 25,
      capLiquid: 12,
      capUnknown: 28,
    });
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

  it("defaults exitOrderTtlMs to 4 hours with liquidity-tier extension enabled", () => {
    expect(DEFAULT_EXECUTION_POLICY.exitOrderTtlMs).toBe(4 * 60 * 60_000);
    expect(DEFAULT_EXECUTION_POLICY.exitTtlByLiquidity).toEqual({
      enabled: true,
      thinMs: 24 * 60 * 60_000,
      mediumMs: 6 * 60 * 60_000,
    });
    expect(DEFAULT_EXECUTION_POLICY.sellTimeoutMs).toBe(6 * 60 * 60_000);
  });

  it("accepts the 24h exit TTL parser bound", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        exitOrderTtlMs: 24 * 60 * 60_000,
        exitTtlByLiquidity: {
          enabled: true,
          thinMs: 24 * 60 * 60_000,
          mediumMs: 6 * 60 * 60_000,
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect(policy.exitOrderTtlMs).toBe(24 * 60 * 60_000);
    expect(policy.exitTtlByLiquidity.thinMs).toBe(24 * 60 * 60_000);
  });

  it("rejects exit TTLs above 24h", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        exitOrderTtlMs: 24 * 60 * 60_000 + 1,
        exitTtlByLiquidity: {
          thinMs: 24 * 60 * 60_000 + 1,
          mediumMs: 24 * 60 * 60_000 + 1,
        },
      }),
    );

    expect(policy.exitOrderTtlMs).toBe(DEFAULT_EXECUTION_POLICY.exitOrderTtlMs);
    expect(policy.exitTtlByLiquidity).toEqual(DEFAULT_EXIT_TTL_BY_LIQUIDITY_POLICY);
    expect(issues.some((i) => i.includes("exitOrderTtlMs"))).toBe(true);
    expect(issues.some((i) => i.includes("exitTtlByLiquidity.thinMs"))).toBe(true);
  });

  it("resolves exit TTL by market activity tier", () => {
    const policy = DEFAULT_EXECUTION_POLICY;

    expect(resolveExitTtlByMarket({ publicTradeCount24h: 0 }, policy)).toMatchObject({
      ttlMs: policy.exitTtlByLiquidity.thinMs,
      tier: "thin",
    });
    expect(resolveExitTtlByMarket({ publicTradeCount24h: 10 }, policy).tier).toBe("thin");
    expect(resolveExitTtlByMarket({ publicTradeCount24h: 11 }, policy)).toMatchObject({
      ttlMs: policy.exitTtlByLiquidity.mediumMs,
      tier: "medium",
    });
    expect(resolveExitTtlByMarket({ publicTradeCount24h: 49 }, policy).tier).toBe("medium");
    expect(resolveExitTtlByMarket({ publicTradeCount24h: 50 }, policy)).toMatchObject({
      ttlMs: policy.exitOrderTtlMs,
      tier: "liquid",
    });
    expect(resolveExitTtlByMarket({ publicTradeCount24h: null }, policy)).toMatchObject({
      ttlMs: policy.exitOrderTtlMs,
      tier: "default",
    });
    expect(
      resolveExitTtlByMarket(
        { publicTradeCount24h: 2 },
        { ...policy, exitTtlByLiquidity: { ...policy.exitTtlByLiquidity, enabled: false } },
      ),
    ).toMatchObject({
      ttlMs: policy.exitOrderTtlMs,
      tier: "disabled",
    });
  });

  it("defaults SELL replacement tolerance to two ticks", () => {
    expect(DEFAULT_EXECUTION_POLICY.sellReplaceMinPriceDeltaTicks).toBe(2);
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ sellReplaceMinPriceDeltaTicks: 1 }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.sellReplaceMinPriceDeltaTicks).toBe(1);
  });

  it("defaults and parses EXIT-FIX-2 reprice thresholds", () => {
    expect(DEFAULT_EXECUTION_POLICY.exitRepriceThresholdPct).toBe(0.3);
    expect(DEFAULT_EXECUTION_POLICY.exitRepriceThresholdTicks).toBe(10);
    expect(DEFAULT_EXECUTION_POLICY.repriceChain.dynamicChainCap).toEqual({
      enabled: true,
      tradeCountThinThreshold: 10,
      tradeCountLiquidThreshold: 49,
      capThin: 50,
      capMedium: 30,
      capLiquid: 13,
      capUnknown: 30,
    });

    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        exitRepriceThresholdPct: 0.2,
        exitRepriceThresholdTicks: 6,
        repriceChain: {
          dynamicChainCap: {
            enabled: false,
            tradeCountThinThreshold: 8,
            tradeCountLiquidThreshold: 40,
            capThin: 44,
            capMedium: 24,
            capLiquid: 11,
            capUnknown: 20,
          },
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect(policy.exitRepriceThresholdPct).toBe(0.2);
    expect(policy.exitRepriceThresholdTicks).toBe(6);
    expect(policy.repriceChain.dynamicChainCap).toEqual({
      enabled: false,
      tradeCountThinThreshold: 8,
      tradeCountLiquidThreshold: 40,
      capThin: 44,
      capMedium: 24,
      capLiquid: 11,
      capUnknown: 20,
    });
  });

  it("defaults and parses the post-BUY fill SELL cooldown", () => {
    expect(DEFAULT_EXECUTION_POLICY.postBuyFillSellCooldownMs).toBe(5_000);

    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ postBuyFillSellCooldownMs: 0 }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.postBuyFillSellCooldownMs).toBe(0);

    const invalid = parseExecutionPolicyJson(JSON.stringify({ postBuyFillSellCooldownMs: -1 }));
    expect(invalid.policy.postBuyFillSellCooldownMs).toBe(
      DEFAULT_EXECUTION_POLICY.postBuyFillSellCooldownMs,
    );
    expect(invalid.issues.some((i) => i.includes("postBuyFillSellCooldownMs"))).toBe(true);
  });

  it("defaults D9 loss exit disabled with R96 liquidity threshold", () => {
    expect(DEFAULT_EXECUTION_POLICY.lossExit).toEqual({
      enabled: false,
      states: ["S1", "S2"],
      minPublicTradeCount24h: 41,
      cohortGuard: {
        enabled: true,
        state: "S2",
        avgBuyMin: 0.02,
        avgBuyMax: 0.4,
        minDaysToResolve: 14,
      },
    });
  });

  it("parses D9 loss exit policy and validates states", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        lossExit: {
          enabled: true,
          states: ["S1", "S2"],
          minPublicTradeCount24h: 41,
          cohortGuard: {
            enabled: false,
            state: "S2",
            avgBuyMin: 0.03,
            avgBuyMax: 0.3,
            minDaysToResolve: 30,
          },
        },
      }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.lossExit).toEqual({
      enabled: true,
      states: ["S1", "S2"],
      minPublicTradeCount24h: 41,
      cohortGuard: {
        enabled: false,
        state: "S2",
        avgBuyMin: 0.03,
        avgBuyMax: 0.3,
        minDaysToResolve: 30,
      },
    });

    const invalid = parseExecutionPolicyJson(JSON.stringify({ lossExit: { states: ["BAD"] } }));
    expect(invalid.policy.lossExit).toEqual(DEFAULT_EXECUTION_POLICY.lossExit);
    expect(invalid.issues.some((i) => i.includes("lossExit.states"))).toBe(true);
  });

  it("validates D9 H5_wide cohort guard bounds", () => {
    const invalidRange = parseExecutionPolicyJson(
      JSON.stringify({
        lossExit: {
          cohortGuard: {
            avgBuyMin: 0.4,
            avgBuyMax: 0.02,
          },
        },
      }),
    );
    expect(invalidRange.policy.lossExit.cohortGuard).toEqual(
      DEFAULT_EXECUTION_POLICY.lossExit.cohortGuard,
    );
    expect(invalidRange.issues.some((i) => i.includes("avgBuyMin must be less"))).toBe(true);

    const invalidState = parseExecutionPolicyJson(
      JSON.stringify({ lossExit: { cohortGuard: { state: "BAD" } } }),
    );
    expect(invalidState.policy.lossExit.cohortGuard.state).toBe(
      DEFAULT_EXECUTION_POLICY.lossExit.cohortGuard.state,
    );
    expect(invalidState.issues.some((i) => i.includes("lossExit.cohortGuard.state"))).toBe(true);
  });

  it("rejects invalid SELL replacement tolerance values with an issue", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ sellReplaceMinPriceDeltaTicks: 0 }),
    );
    expect(policy.sellReplaceMinPriceDeltaTicks).toBe(
      DEFAULT_EXECUTION_POLICY.sellReplaceMinPriceDeltaTicks,
    );
    expect(issues.some((i) => i.includes("sellReplaceMinPriceDeltaTicks"))).toBe(true);
  });

  it("rejects invalid EXIT-FIX-2 reprice threshold values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        exitRepriceThresholdPct: 0,
        exitRepriceThresholdTicks: 0,
        repriceChain: {
          dynamicChainCap: {
            tradeCountThinThreshold: -1,
            tradeCountLiquidThreshold: -1,
            capThin: 0,
            capMedium: 0,
            capLiquid: 0,
            capUnknown: 0,
          },
        },
      }),
    );

    expect(policy.exitRepriceThresholdPct).toBe(DEFAULT_EXECUTION_POLICY.exitRepriceThresholdPct);
    expect(policy.exitRepriceThresholdTicks).toBe(
      DEFAULT_EXECUTION_POLICY.exitRepriceThresholdTicks,
    );
    expect(policy.repriceChain.dynamicChainCap).toEqual(
      DEFAULT_EXECUTION_POLICY.repriceChain.dynamicChainCap,
    );
    expect(issues.some((i) => i.includes("exitRepriceThresholdPct"))).toBe(true);
    expect(issues.some((i) => i.includes("exitRepriceThresholdTicks"))).toBe(true);
    expect(
      issues.some((i) => i.includes("repriceChain.dynamicChainCap.tradeCountThinThreshold")),
    ).toBe(true);
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
        exitPricingMode: "midpoint-anchored",
        exitBidAnchorTicks: 7,
        exitMidpointAnchorTicks: 5,
        repriceOnOutbid: { enabled: false },
        exitRepriceOnDownprice: { thresholdTicks: 7 },
        dropTrigger: { enabled: true, failOpenOnNoData: false, thresholdPct: -0.05 },
        multiBuyLadder: { maxLadderFillsPerToken: 4 },
        opportunisticTaker: { maxSpreadTicks: 4, sides: ["sell"] },
      }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.exitPricingMode).toBe("midpoint-anchored");
    expect(policy.exitBidAnchorTicks).toBe(7);
    expect(policy.exitMidpointAnchorTicks).toBe(5);
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

  it("defaults redeem sweep to auto-on with 10-minute cadence", () => {
    expect(DEFAULT_EXECUTION_POLICY.redeemSweep).toMatchObject({
      enabled: true,
      intervalMs: 600_000,
    });
    expect(DEFAULT_EXECUTION_POLICY.redeemSweep).not.toHaveProperty("minAgeAfterResolutionSec");
  });

  it("rejects invalid fill-rate feature policy values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        exitPricingMode: "ask",
        exitBidAnchorTicks: -1,
        exitMidpointAnchorTicks: -1,
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
        r23DipTrigger: {
          enabled: "yes",
          dropThresholdRatio: 2,
          windowMs: 1,
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
    expect(policy.exitMidpointAnchorTicks).toBe(DEFAULT_EXECUTION_POLICY.exitMidpointAnchorTicks);
    expect(policy.repriceOnOutbid).toEqual(DEFAULT_EXECUTION_POLICY.repriceOnOutbid);
    expect(policy.exitRepriceOnDownprice).toEqual(DEFAULT_EXECUTION_POLICY.exitRepriceOnDownprice);
    expect(policy.dropTrigger).toEqual(DEFAULT_EXECUTION_POLICY.dropTrigger);
    expect(policy.r23DipTrigger).toEqual(DEFAULT_EXECUTION_POLICY.r23DipTrigger);
    expect(policy.multiBuyLadder).toEqual(DEFAULT_EXECUTION_POLICY.multiBuyLadder);
    expect(policy.opportunisticTaker).toEqual(DEFAULT_EXECUTION_POLICY.opportunisticTaker);
    expect(issues.some((i) => i.includes("repriceOnOutbid.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("exitPricingMode"))).toBe(true);
    expect(issues.some((i) => i.includes("exitBidAnchorTicks"))).toBe(true);
    expect(issues.some((i) => i.includes("exitMidpointAnchorTicks"))).toBe(true);
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
    expect(issues.some((i) => i.includes("r23DipTrigger.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("r23DipTrigger.dropThresholdRatio"))).toBe(true);
    expect(issues.some((i) => i.includes("r23DipTrigger.windowMs"))).toBe(true);
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
