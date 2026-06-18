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

  it("defaults Track S1 disabled with conservative ladder parameters", () => {
    const { policy, issues } = parseExecutionPolicyJson(null);

    expect(issues).toHaveLength(0);
    expect(policy.trackS1).toEqual({
      enabled: false,
      numTiers: 4,
      bottomTierMarkup: 1.05,
      volumeDistribution: [0.1, 0.2, 0.3, 0.4],
      markupCeilings: { cheapMax: 6, midRange: 2.25 },
      handoffTimeToResolutionSeconds: 3600,
      handoffTimeoutSeconds: 300,
      phantomOwnershipReleaseSeconds: 300,
      maxOpenLadderTokens: 20,
      s1MaxOrdersPerToken: 4,
      maxLadderReplacementsPerHour: 6,
      cheapLongshotMaxAvgEntry: 0.05,
      thinSpreadTicks: 10,
      bestBidDepthRatio: 0.1,
      bottomRepriceBidMovePct: 0.05,
      minBestBid: 0.001,
    });
  });

  it("defaults Execution Profile dark with explicit hysteresis bounds", () => {
    const { policy, issues } = parseExecutionPolicyJson(null);

    expect(issues).toHaveLength(0);
    expect(policy.executionProfile).toEqual({
      enabled: false,
      profileHysteresis: {
        cheapMediumLow: 0.045,
        cheapMediumHigh: 0.055,
        mediumExpensiveLow: 0.325,
        mediumExpensiveHigh: 0.375,
      },
      maxTokensPerCycle: 100,
      qdHandoffThresholdMs: 3_600_000,
      costCaps: { enabled: false },
      scaleIn: { enabled: false, useRealFeed: false },
      signalFeed: {
        enabled: false,
        windowShortMs: 3_600_000,
        windowLongMs: 10_800_000,
        hotSampleTargetIntervalMs: 10_000,
        warmBucketMs: 60_000,
        coldArchiveBucketMs: 3_600_000,
        retentionDays: 120,
        minSamplesForSnapshot: 30,
        minSamplesForRecovery60: 60,
        minWarmBucketsForTradeCount: 90,
        flushHotToWarmIntervalMs: 60_000,
        flushWarmToColdIntervalMs: 60_000,
        maintenanceIntervalMs: 3_600_000,
      },
      abandonment: {
        enabled: false,
        evaluationIntervalMs: 60_000,
        maxTokensPerCycle: 100,
        hardStaleFallbackMs: 86_400_000,
        bands: {
          cheap: {
            enabled: false,
            probeSizeMaxUsdc: 9,
            maxProbeBuyCount: 4,
            scaleInRequiredWithinMs: 3_600_000,
          },
          medium_low: {
            enabled: false,
            probeSizeMaxUsdc: 13.45,
            maxProbeBuyCount: 3,
            scaleInRequiredWithinMs: 2_700_000,
          },
          medium_high: {
            enabled: false,
            probeSizeMaxUsdc: 12.83,
            maxProbeBuyCount: 2,
            scaleInRequiredWithinMs: 900_000,
          },
          expensive: {
            enabled: false,
            probeSizeMaxUsdc: 11.84,
            maxProbeBuyCount: 2,
            scaleInRequiredWithinMs: 600_000,
          },
        },
      },
      profiles: {
        cheap: {
          costCaps: { normalCapUsd: 11, aggressiveCapUsd: 23, hardCapAtAggressive: false },
          scaleIn: {
            initialProbeSizeUsd: 0.6,
            sizingDecay: [1, 0.7, 0.6, 0.5, 0.35],
            minTimeBetweenAddsMs: 48_000,
            minAddNotionalUsd: 0.2,
            modes: {
              up: { thresholdPct: 0.05 },
              flat: { thresholdPct: 0.05 },
              avgDown: {
                enabled: true,
                thresholdPct: 0.05,
                requireRecovery: true,
                recoveryThreshold: 0.05,
              },
            },
            triggers: {
              activity: { tradeCount3hThreshold: 40 },
              recovery: {
                threshold: 0.08,
                strongThreshold: 0.1,
                strongActivityRecoveryFloor: 0.05,
              },
              volatility: { range60Threshold: 0.1, std60Threshold: 0.02 },
              strongActivity: { tradeCount3hThreshold: 80 },
            },
          },
        },
        medium: {
          costCaps: { normalCapUsd: 30, aggressiveCapUsd: 70, hardCapAtAggressive: false },
          scaleIn: {
            initialProbeSizeUsd: 7.15,
            sizingDecay: [1, 0.7, 0.6, 0.5, 0.35],
            minTimeBetweenAddsMs: 1_656_000,
            minAddNotionalUsd: 0.2,
            modes: {
              up: { thresholdPct: 0.05 },
              flat: { thresholdPct: 0.05 },
              avgDown: {
                enabled: true,
                thresholdPct: 0.05,
                requireRecovery: true,
                recoveryThreshold: 0.05,
              },
            },
            triggers: {
              activity: { tradeCount3hThreshold: 40 },
              recovery: {
                threshold: 0.08,
                strongThreshold: 0.1,
                strongActivityRecoveryFloor: 0.05,
              },
              volatility: { range60Threshold: 0.1, std60Threshold: 0.02 },
              strongActivity: { tradeCount3hThreshold: 80 },
            },
          },
        },
        expensive: {
          costCaps: { normalCapUsd: 18, aggressiveCapUsd: 33, hardCapAtAggressive: false },
          scaleIn: {
            initialProbeSizeUsd: 8.45,
            sizingDecay: [1, 0.7, 0.6, 0.5, 0.35],
            minTimeBetweenAddsMs: 2_550_000,
            minAddNotionalUsd: 0.2,
            modes: {
              up: { thresholdPct: 0.05 },
              flat: { thresholdPct: 0.05 },
              avgDown: {
                enabled: true,
                thresholdPct: 0.05,
                requireRecovery: true,
                recoveryThreshold: 0.05,
              },
            },
            triggers: {
              activity: { tradeCount3hThreshold: 40 },
              recovery: {
                threshold: 0.08,
                strongThreshold: 0.1,
                strongActivityRecoveryFloor: 0.05,
              },
              volatility: { range60Threshold: 0.1, std60Threshold: 0.02 },
              strongActivity: { tradeCount3hThreshold: 80 },
            },
          },
        },
      },
      sellLadder: DEFAULT_EXECUTION_POLICY.executionProfile.sellLadder,
      adoptExistingPositions: { enabled: false },
      adoptExistingS1Ladders: { enabled: false },
      monitoring: {
        healthCheckIntervalMs: 300_000,
        rollupWindowMs: 300_000,
        maxRollupBuckets: 10_000,
        pendingScaleInWarnAfterMs: 600_000,
        healthRiskEventEveryMs: 1_800_000,
        anomalyDetection: { enabled: false, cooldownMs: 3_600_000 },
      },
    });
  });

  it("parses Execution Profile settings and rejects invalid hysteresis ordering", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          enabled: true,
          profileHysteresis: {
            cheapMediumLow: 0.04,
            cheapMediumHigh: 0.06,
            mediumExpensiveLow: 0.3,
            mediumExpensiveHigh: 0.4,
          },
          maxTokensPerCycle: 25,
          qdHandoffThresholdMs: 600_000,
          costCaps: { enabled: true },
          scaleIn: { enabled: true },
          profiles: {
            cheap: {
              costCaps: {
                normalCapUsd: 12,
                aggressiveCapUsd: 24,
                hardCapAtAggressive: true,
              },
              scaleIn: {
                initialProbeSizeUsd: 0.7,
                sizingDecay: [1, 0.5],
                minTimeBetweenAddsMs: 0,
                minAddNotionalUsd: 0.25,
                modes: {
                  up: { thresholdPct: 0.04 },
                  flat: { thresholdPct: 0.03 },
                  avgDown: {
                    enabled: true,
                    thresholdPct: 0.06,
                    requireRecovery: true,
                    recoveryThreshold: 0.05,
                  },
                },
                triggers: {
                  activity: { tradeCount3hThreshold: 41 },
                  recovery: {
                    threshold: 0.05,
                    strongThreshold: 0.1,
                    strongActivityRecoveryFloor: 0.05,
                  },
                  volatility: { range60Threshold: 0.11, std60Threshold: 0.04 },
                  strongActivity: { tradeCount3hThreshold: 81 },
                },
              },
            },
            medium: {
              costCaps: {
                normalCapUsd: 31,
                aggressiveCapUsd: 71,
                hardCapAtAggressive: false,
              },
            },
            expensive: {
              costCaps: {
                normalCapUsd: 19,
                aggressiveCapUsd: 34,
                hardCapAtAggressive: true,
              },
            },
          },
          sellLadder: {
            enabled: true,
            phase: 1,
            bands: {
              medium_low: {
                enabled: true,
                multipliers: [1.11, 1.31, 1.56, 1.66, 1.86],
              },
            },
          },
          adoptExistingPositions: { enabled: true },
          adoptExistingS1Ladders: { enabled: true },
          monitoring: {
            healthCheckIntervalMs: 60_000,
            rollupWindowMs: 120_000,
            maxRollupBuckets: 500,
            pendingScaleInWarnAfterMs: 300_000,
            healthRiskEventEveryMs: 900_000,
            anomalyDetection: { enabled: true, cooldownMs: 600_000 },
          },
        },
      }),
    );

    expect(parsed.issues).toHaveLength(0);
    expect(parsed.policy.executionProfile).toMatchObject({
      enabled: true,
      profileHysteresis: {
        cheapMediumLow: 0.04,
        cheapMediumHigh: 0.06,
        mediumExpensiveLow: 0.3,
        mediumExpensiveHigh: 0.4,
      },
      maxTokensPerCycle: 25,
      qdHandoffThresholdMs: 600_000,
      costCaps: { enabled: true },
      scaleIn: { enabled: true, useRealFeed: false },
      profiles: {
        cheap: {
          costCaps: { normalCapUsd: 12, aggressiveCapUsd: 24, hardCapAtAggressive: true },
          scaleIn: {
            initialProbeSizeUsd: 0.7,
            sizingDecay: [1, 0.5],
            minTimeBetweenAddsMs: 0,
            minAddNotionalUsd: 0.25,
            modes: {
              up: { thresholdPct: 0.04 },
              flat: { thresholdPct: 0.03 },
              avgDown: {
                enabled: true,
                thresholdPct: 0.06,
                requireRecovery: true,
                recoveryThreshold: 0.05,
              },
            },
            triggers: {
              activity: { tradeCount3hThreshold: 41 },
              recovery: {
                threshold: 0.05,
                strongThreshold: 0.1,
                strongActivityRecoveryFloor: 0.05,
              },
              volatility: { range60Threshold: 0.11, std60Threshold: 0.04 },
              strongActivity: { tradeCount3hThreshold: 81 },
            },
          },
        },
        medium: {
          costCaps: { normalCapUsd: 31, aggressiveCapUsd: 71, hardCapAtAggressive: false },
        },
        expensive: {
          costCaps: { normalCapUsd: 19, aggressiveCapUsd: 34, hardCapAtAggressive: true },
        },
      },
      sellLadder: {
        ...DEFAULT_EXECUTION_POLICY.executionProfile.sellLadder,
        enabled: true,
        phase: 1,
        bands: {
          ...DEFAULT_EXECUTION_POLICY.executionProfile.sellLadder.bands,
          medium_low: {
            ...DEFAULT_EXECUTION_POLICY.executionProfile.sellLadder.bands.medium_low,
            enabled: true,
            multipliers: [1.11, 1.31, 1.56, 1.66, 1.86],
          },
        },
      },
      adoptExistingPositions: { enabled: true },
      adoptExistingS1Ladders: { enabled: true },
      monitoring: {
        healthCheckIntervalMs: 60_000,
        rollupWindowMs: 120_000,
        maxRollupBuckets: 500,
        pendingScaleInWarnAfterMs: 300_000,
        healthRiskEventEveryMs: 900_000,
        anomalyDetection: { enabled: true, cooldownMs: 600_000 },
      },
    });

    const invalid = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          profileHysteresis: {
            cheapMediumLow: 0.06,
            cheapMediumHigh: 0.05,
            mediumExpensiveLow: 0.4,
            mediumExpensiveHigh: 0.3,
          },
          maxTokensPerCycle: 0,
          qdHandoffThresholdMs: -1,
        },
      }),
    );

    expect(invalid.policy.executionProfile).toEqual(DEFAULT_EXECUTION_POLICY.executionProfile);
    expect(
      invalid.issues.some((issue) => issue.includes("executionProfile.profileHysteresis")),
    ).toBe(true);
    expect(
      invalid.issues.some((issue) => issue.includes("executionProfile.maxTokensPerCycle")),
    ).toBe(true);
    expect(
      invalid.issues.some((issue) => issue.includes("executionProfile.qdHandoffThresholdMs")),
    ).toBe(true);
  });

  it("defaults ProfileLadder modeReader dark compare disabled", () => {
    const { policy, issues } = parseExecutionPolicyJson(null);

    expect(issues).toHaveLength(0);
    expect(policy.executionProfile.sellLadder.modeReader).toEqual({
      enabled: false,
      darkCompareOnly: true,
      source: "algo_token_mode_state",
      mapping: {
        PASSIVE: "flat",
        MIDDLE: "flat",
        BURST: "up",
      },
      missingBehavior: "local",
    });
  });

  it("parses ProfileLadder modeReader dark compare config", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            modeReader: {
              enabled: true,
              darkCompareOnly: true,
              source: "algo_token_mode_state",
              mapping: {
                PASSIVE: "flat",
                MIDDLE: "flat",
                BURST: "up",
              },
              missingBehavior: "local",
            },
          },
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect(policy.executionProfile.sellLadder.modeReader).toEqual({
      enabled: true,
      darkCompareOnly: true,
      source: "algo_token_mode_state",
      mapping: {
        PASSIVE: "flat",
        MIDDLE: "flat",
        BURST: "up",
      },
      missingBehavior: "local",
    });
  });

  it("rejects ProfileLadder modeReader avg_down mapping in PR1", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            modeReader: {
              enabled: true,
              mapping: {
                PASSIVE: "avg_down",
                MIDDLE: "flat",
                BURST: "up",
              },
            },
          },
        },
      }),
    );

    expect(issues).toContain(
      "executionProfile.sellLadder.modeReader.mapping.PASSIVE must be up or flat; avg_down is unsupported in PR1",
    );
    expect(policy.executionProfile.sellLadder.modeReader.enabled).toBe(false);
  });

  it("rejects ProfileLadder modeReader unknown mapping keys", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            modeReader: {
              enabled: true,
              mapping: {
                PASSIVE: "flat",
                UNKNOWN: "up",
              },
            },
          },
        },
      }),
    );

    expect(issues).toContain(
      "executionProfile.sellLadder.modeReader.mapping has unsupported key UNKNOWN",
    );
    expect(policy.executionProfile.sellLadder.modeReader.enabled).toBe(false);
  });

  it("rejects ProfileLadder modeReader behavior activation in PR1", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            modeReader: {
              enabled: true,
              darkCompareOnly: false,
            },
          },
        },
      }),
    );

    expect(issues).toContain(
      "executionProfile.sellLadder.modeReader.darkCompareOnly=false is unsupported in PR1",
    );
    expect(policy.executionProfile.sellLadder.modeReader.enabled).toBe(false);
  });

  it("parses Execution Profile monitoring and falls back field-by-field", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          monitoring: {
            healthCheckIntervalMs: 60_000,
            rollupWindowMs: -1,
            maxRollupBuckets: 20_000,
            pendingScaleInWarnAfterMs: 120_000,
            healthRiskEventEveryMs: 600_000,
            anomalyDetection: { enabled: true, cooldownMs: -5 },
          },
        },
      }),
    );

    expect(parsed.policy.executionProfile.monitoring).toEqual({
      healthCheckIntervalMs: 60_000,
      rollupWindowMs: DEFAULT_EXECUTION_POLICY.executionProfile.monitoring.rollupWindowMs,
      maxRollupBuckets: 20_000,
      pendingScaleInWarnAfterMs: 120_000,
      healthRiskEventEveryMs: 600_000,
      anomalyDetection: {
        enabled: true,
        cooldownMs:
          DEFAULT_EXECUTION_POLICY.executionProfile.monitoring.anomalyDetection.cooldownMs,
      },
    });
    expect(
      parsed.issues.some((issue) => issue.includes("executionProfile.monitoring.rollupWindowMs")),
    ).toBe(true);
    expect(
      parsed.issues.some((issue) =>
        issue.includes("executionProfile.monitoring.anomalyDetection.cooldownMs"),
      ),
    ).toBe(true);
  });

  it("falls back malformed Execution Profile cost caps per profile", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          costCaps: { enabled: true, ignored: "ok" },
          profiles: {
            cheap: {
              costCaps: {
                normalCapUsd: -1,
                aggressiveCapUsd: 22,
                hardCapAtAggressive: true,
              },
            },
            medium: {
              costCaps: {
                normalCapUsd: 31,
                aggressiveCapUsd: 71,
                hardCapAtAggressive: true,
                unknown: "ignored",
              },
            },
            expensive: {
              costCaps: {
                normalCapUsd: 40,
                aggressiveCapUsd: 39,
                hardCapAtAggressive: true,
              },
            },
          },
        },
      }),
    );

    expect(parsed.policy.executionProfile.costCaps).toEqual({ enabled: true });
    expect(parsed.policy.executionProfile.profiles.cheap.costCaps).toEqual(
      DEFAULT_EXECUTION_POLICY.executionProfile.profiles.cheap.costCaps,
    );
    expect(parsed.policy.executionProfile.profiles.medium.costCaps).toEqual({
      normalCapUsd: 31,
      aggressiveCapUsd: 71,
      hardCapAtAggressive: true,
    });
    expect(parsed.policy.executionProfile.profiles.expensive.costCaps).toEqual(
      DEFAULT_EXECUTION_POLICY.executionProfile.profiles.expensive.costCaps,
    );
    expect(
      parsed.issues.some((issue) =>
        issue.includes("executionProfile.profiles.cheap.costCaps.normalCapUsd"),
      ),
    ).toBe(true);
    expect(
      parsed.issues.some((issue) => issue.includes("executionProfile.profiles.expensive.costCaps")),
    ).toBe(true);
  });

  it("falls back malformed Execution Profile scale-in per profile", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          scaleIn: { enabled: true },
          profiles: {
            cheap: {
              scaleIn: {
                sizingDecay: [],
                initialProbeSizeUsd: 0.9,
              },
            },
            medium: {
              scaleIn: {
                initialProbeSizeUsd: 8,
                sizingDecay: [1, 0.8],
                minTimeBetweenAddsMs: 0,
                minAddNotionalUsd: 0.4,
                modes: {
                  up: { thresholdPct: 0.04 },
                  flat: { thresholdPct: 0.04 },
                  avgDown: {
                    enabled: false,
                    thresholdPct: 0.06,
                    requireRecovery: false,
                    recoveryThreshold: 0.07,
                  },
                },
                triggers: {
                  activity: { tradeCount3hThreshold: 55 },
                  recovery: {
                    threshold: 0.07,
                    strongThreshold: 0.12,
                    strongActivityRecoveryFloor: 0.05,
                  },
                  volatility: { range60Threshold: 0.13, std60Threshold: 0.05 },
                  strongActivity: { tradeCount3hThreshold: 90 },
                },
                ignored: true,
              },
            },
            expensive: {
              scaleIn: {
                minTimeBetweenAddsMs: -1,
              },
            },
          },
        },
      }),
    );

    expect(parsed.policy.executionProfile.scaleIn).toEqual({ enabled: true, useRealFeed: false });
    expect(parsed.policy.executionProfile.profiles.cheap.scaleIn).toEqual(
      DEFAULT_EXECUTION_POLICY.executionProfile.profiles.cheap.scaleIn,
    );
    expect(parsed.policy.executionProfile.profiles.medium.scaleIn).toMatchObject({
      initialProbeSizeUsd: 8,
      sizingDecay: [1, 0.8],
      minTimeBetweenAddsMs: 0,
      minAddNotionalUsd: 0.4,
      modes: {
        avgDown: {
          enabled: false,
          thresholdPct: 0.06,
          requireRecovery: false,
          recoveryThreshold: 0.07,
        },
      },
      triggers: {
        activity: { tradeCount3hThreshold: 55 },
        recovery: {
          threshold: 0.07,
          strongThreshold: 0.12,
          strongActivityRecoveryFloor: 0.05,
        },
        volatility: { range60Threshold: 0.13, std60Threshold: 0.05 },
        strongActivity: { tradeCount3hThreshold: 90 },
      },
    });
    expect(parsed.policy.executionProfile.profiles.expensive.scaleIn).toEqual(
      DEFAULT_EXECUTION_POLICY.executionProfile.profiles.expensive.scaleIn,
    );
    expect(
      parsed.issues.some((issue) =>
        issue.includes("executionProfile.profiles.cheap.scaleIn.sizingDecay"),
      ),
    ).toBe(true);
    expect(
      parsed.issues.some((issue) =>
        issue.includes("executionProfile.profiles.expensive.scaleIn.minTimeBetweenAddsMs"),
      ),
    ).toBe(true);
  });

  it("parses Track S1 policy field-by-field and normalizes volume distribution", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        trackS1: {
          enabled: true,
          numTiers: 3,
          volumeDistribution: [1, 2, 3],
          s1MaxOrdersPerToken: 3,
          maxLadderReplacementsPerHour: 4,
          phantomOwnershipReleaseSeconds: 120,
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect(policy.trackS1.enabled).toBe(true);
    expect(policy.trackS1.numTiers).toBe(3);
    expect(policy.trackS1.volumeDistribution).toEqual([1 / 6, 2 / 6, 3 / 6]);
    expect(policy.trackS1.s1MaxOrdersPerToken).toBe(3);
    expect(policy.trackS1.maxLadderReplacementsPerHour).toBe(4);
    expect(policy.trackS1.phantomOwnershipReleaseSeconds).toBe(120);
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
        mode: "source_aware_dynamic",
        maxOpenSellOrders: 10,
        maxOpenSellOrdersPerToken: 2,
        profileLadderLiveRungsPerPosition: 2,
        minNonLadderReserve: 10,
        nonLadderReserveRatio: 0.25,
        hardMaxOpenSellOrders: 200,
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
    expect(policy.marketSelection).toEqual({
      maxMidPrice: 0.42,
      minLiquidity: 250,
      shortLifetime: DEFAULT_EXECUTION_POLICY.marketSelection.shortLifetime,
    });
    expect(policy.buyCapacity).toEqual({
      enabled: true,
      minNewEntryWalletHeadroomUsdc: 7,
      minAddWalletHeadroomUsdc: 5,
      maxOpenBuyOrders: 15,
      maxOpenBuyOrdersPerToken: 2,
    });
    expect(policy.sellCapacity).toEqual({
      enabled: true,
      mode: "source_aware_dynamic",
      maxOpenSellOrders: 10,
      maxOpenSellOrdersPerToken: 2,
      profileLadderLiveRungsPerPosition: 2,
      minNonLadderReserve: 10,
      nonLadderReserveRatio: 0.25,
      hardMaxOpenSellOrders: 200,
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

  it("defaults Q.D pre-resolution exit enabled in shadow with salvage off", () => {
    expect(DEFAULT_EXECUTION_POLICY.preResolutionExit).toEqual({
      enabled: true,
      ttcThresholdMs: 2 * 60 * 60_000,
      tierCeiling: 0.05,
      bidFloorAbs: 0.01,
      salvageEnabled: false,
      salvageTtcMs: 30 * 60_000,
      salvageFloorRatio: 0.5,
    });
  });

  it("parses Q.D pre-resolution exit policy and rejects out-of-range values", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        preResolutionExit: {
          enabled: false,
          ttcThresholdMs: 3 * 60 * 60_000,
          tierCeiling: 0.15,
          bidFloorAbs: 0.02,
          salvageEnabled: true,
          salvageTtcMs: 15 * 60_000,
          salvageFloorRatio: 0.6,
        },
      }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.preResolutionExit).toEqual({
      enabled: false,
      ttcThresholdMs: 3 * 60 * 60_000,
      tierCeiling: 0.15,
      bidFloorAbs: 0.02,
      salvageEnabled: true,
      salvageTtcMs: 15 * 60_000,
      salvageFloorRatio: 0.6,
    });

    const invalid = parseExecutionPolicyJson(
      JSON.stringify({ preResolutionExit: { salvageFloorRatio: 5 } }),
    );
    expect(invalid.policy.preResolutionExit.salvageFloorRatio).toBe(
      DEFAULT_EXECUTION_POLICY.preResolutionExit.salvageFloorRatio,
    );
    expect(invalid.issues.some((i) => i.includes("preResolutionExit.salvageFloorRatio"))).toBe(
      true,
    );
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

  it("parses opportunistic taker settings and ignores legacy sides", () => {
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
      safetyBuffer: 2,
      fallbackMinNotionalUsdc: 0.5,
      marketableBuyMinNotionalUsdc: 0.75,
    });

    const invalid = parseExecutionPolicyJson(
      JSON.stringify({ opportunisticTaker: { enabled: "yes", maxSpreadTicks: -1 } }),
    );
    expect(invalid.policy.opportunisticTaker).toEqual(DEFAULT_EXECUTION_POLICY.opportunisticTaker);
    expect(invalid.issues.some((i) => i.includes("opportunisticTaker.enabled"))).toBe(true);
    expect(invalid.issues.some((i) => i.includes("opportunisticTaker.maxSpreadTicks"))).toBe(true);
  });

  it("defaults taker-at-profit off with a fee-aware margin", () => {
    expect(DEFAULT_EXECUTION_POLICY.takerAtProfit).toEqual({
      enabled: false,
      minGrossExitRatio: 1.03,
      maxSpreadTicks: 6,
      rules: "all-sell",
    });
  });

  it("parses taker-at-profit settings and rejects invalid values", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        takerAtProfit: {
          enabled: true,
          minGrossExitRatio: 1.05,
          maxSpreadTicks: 4,
          rules: ["D5", "D8"],
        },
      }),
    );
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.policy.takerAtProfit).toEqual({
      enabled: true,
      minGrossExitRatio: 1.05,
      maxSpreadTicks: 4,
      rules: ["D5", "D8"],
    });

    const invalid = parseExecutionPolicyJson(
      JSON.stringify({
        takerAtProfit: {
          enabled: "yes",
          minGrossExitRatio: 0.99,
          maxSpreadTicks: "wide",
          rules: ["D8", 8],
        },
      }),
    );
    expect(invalid.policy.takerAtProfit).toEqual(DEFAULT_EXECUTION_POLICY.takerAtProfit);
    expect(invalid.issues.some((i) => i.includes("takerAtProfit.enabled"))).toBe(true);
    expect(invalid.issues.some((i) => i.includes("takerAtProfit.minGrossExitRatio"))).toBe(true);
    expect(invalid.issues.some((i) => i.includes("takerAtProfit.maxSpreadTicks"))).toBe(true);
    expect(invalid.issues.some((i) => i.includes("takerAtProfit.rules"))).toBe(true);
  });

  it("ignores legacy opportunisticTaker.sides and takerAtProfit.requireOpportunisticSellSide", () => {
    // Backward compat: prod control DB (policy v47) still carries these removed
    // fields. They must parse without issues and must not surface in the output.
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        opportunisticTaker: {
          enabled: true,
          maxSpreadTicks: 2,
          sides: ["buy", "sell"],
          safetyBuffer: 1.05,
          fallbackMinNotionalUsdc: 1,
          marketableBuyMinNotionalUsdc: 1,
        },
        takerAtProfit: {
          enabled: true,
          minGrossExitRatio: 1.03,
          maxSpreadTicks: 6,
          rules: "all-sell",
          requireOpportunisticSellSide: false,
        },
      }),
    );
    expect(issues).toHaveLength(0);
    expect("sides" in policy.opportunisticTaker).toBe(false);
    expect("requireOpportunisticSellSide" in policy.takerAtProfit).toBe(false);

    // Even malformed legacy values are silently ignored, never validated.
    const garbage = parseExecutionPolicyJson(
      JSON.stringify({
        opportunisticTaker: { sides: ["hold"] },
        takerAtProfit: { requireOpportunisticSellSide: "no" },
      }),
    );
    expect(garbage.issues.some((i) => i.includes("opportunisticTaker.sides"))).toBe(false);
    expect(
      garbage.issues.some((i) => i.includes("takerAtProfit.requireOpportunisticSellSide")),
    ).toBe(false);
  });

  it("defaults Track S3 disabled with conservative margin-aware spread tiers", () => {
    expect(DEFAULT_EXECUTION_POLICY.trackS3).toEqual({
      enabled: false,
      baseCap: 6,
      tiers: [
        { minMargin: 3.0, maxSpreadTicks: 60, label: "tier_3x" },
        { minMargin: 2.0, maxSpreadTicks: 20, label: "tier_2x" },
        { minMargin: 1.5, maxSpreadTicks: 12, label: "tier_1.5x" },
      ],
    });
  });

  it("parses Track S3 settings and rejects invalid values", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        trackS3: {
          enabled: true,
          baseCap: 8,
          tiers: [
            { minMargin: 2.5, maxSpreadTicks: 40, label: "tier_custom" },
            { minMargin: 1.5, maxSpreadTicks: 12, label: "tier_1.5x" },
          ],
        },
      }),
    );
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.policy.trackS3).toEqual({
      enabled: true,
      baseCap: 8,
      tiers: [
        { minMargin: 2.5, maxSpreadTicks: 40, label: "tier_custom" },
        { minMargin: 1.5, maxSpreadTicks: 12, label: "tier_1.5x" },
      ],
    });

    const invalid = parseExecutionPolicyJson(
      JSON.stringify({
        trackS3: {
          enabled: "yes",
          baseCap: null,
          tiers: [
            { minMargin: 0.5, maxSpreadTicks: 40, label: "too_low" },
            { minMargin: 2.0, maxSpreadTicks: 0, label: "" },
          ],
        },
      }),
    );
    expect(invalid.policy.trackS3).toEqual(DEFAULT_EXECUTION_POLICY.trackS3);
    expect(invalid.issues.some((i) => i.includes("trackS3.enabled"))).toBe(true);
    expect(invalid.issues.some((i) => i.includes("trackS3.baseCap"))).toBe(true);
    expect(invalid.issues.some((i) => i.includes("trackS3.tiers"))).toBe(true);
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
    expect(policy.marketSelection.shortLifetime).toEqual(
      DEFAULT_EXECUTION_POLICY.marketSelection.shortLifetime,
    );
  });

  it("parses Guard B short-lifetime market-selection override", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        marketSelection: {
          shortLifetime: { enabled: true, thresholdHours: 0.5 },
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect(policy.marketSelection.shortLifetime).toEqual({
      enabled: true,
      thresholdHours: 0.5,
    });
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

  it("parses dynamic source-aware sell capacity formula parameters", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        sellCapacity: {
          enabled: true,
          mode: "source_aware_dynamic",
          profileLadderLiveRungsPerPosition: 2,
          minNonLadderReserve: 10,
          nonLadderReserveRatio: 0.25,
          hardMaxOpenSellOrders: 200,
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect(policy.sellCapacity).toEqual({
      ...DEFAULT_EXECUTION_POLICY.sellCapacity,
      enabled: true,
      mode: "source_aware_dynamic",
      profileLadderLiveRungsPerPosition: 2,
      minNonLadderReserve: 10,
      nonLadderReserveRatio: 0.25,
      hardMaxOpenSellOrders: 200,
    });
  });

  it("rejects invalid sell/order-capacity values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        sellCapacity: {
          enabled: "yes",
          mode: "dynamic",
          maxOpenSellOrders: 1.5,
          maxOpenSellOrdersPerToken: -1,
          profileLadderLiveRungsPerPosition: 0,
          minNonLadderReserve: -1,
          nonLadderReserveRatio: -0.1,
          hardMaxOpenSellOrders: 0,
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
    expect(issues.some((i) => i.includes("sellCapacity.mode"))).toBe(true);
    expect(issues.some((i) => i.includes("sellCapacity.maxOpenSellOrders"))).toBe(true);
    expect(issues.some((i) => i.includes("sellCapacity.maxOpenSellOrdersPerToken"))).toBe(true);
    expect(issues.some((i) => i.includes("sellCapacity.profileLadderLiveRungsPerPosition"))).toBe(
      true,
    );
    expect(issues.some((i) => i.includes("sellCapacity.minNonLadderReserve"))).toBe(true);
    expect(issues.some((i) => i.includes("sellCapacity.nonLadderReserveRatio"))).toBe(true);
    expect(issues.some((i) => i.includes("sellCapacity.hardMaxOpenSellOrders"))).toBe(true);
    expect(issues.some((i) => i.includes("orderCapacity.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("orderCapacity.maxOpenOrdersTotal"))).toBe(true);
  });

  it("rejects invalid market-selection values with issues", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        marketSelection: {
          maxMidPrice: 2,
          minLiquidity: -1,
          shortLifetime: { enabled: "yes", thresholdHours: 0 },
        },
      }),
    );
    expect(policy.marketSelection).toEqual(DEFAULT_EXECUTION_POLICY.marketSelection);
    expect(issues.some((i) => i.includes("marketSelection.maxMidPrice"))).toBe(true);
    expect(issues.some((i) => i.includes("marketSelection.minLiquidity"))).toBe(true);
    expect(issues.some((i) => i.includes("marketSelection.shortLifetime.enabled"))).toBe(true);
    expect(issues.some((i) => i.includes("marketSelection.shortLifetime.thresholdHours"))).toBe(
      true,
    );
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
    });
  });

  it("parses redeem sweep policy and defaults missing fields", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        redeemSweep: {
          enabled: false,
          intervalMs: 120_000,
          circuitBreakerEnabled: false,
          stateFailedQuarantineThreshold: 7,
          stateFailedQuarantineTtlHours: 48,
        },
      }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.redeemSweep).toEqual({
      ...DEFAULT_EXECUTION_POLICY.redeemSweep,
      enabled: false,
      intervalMs: 120_000,
      circuitBreakerEnabled: false,
      stateFailedQuarantineThreshold: 7,
      stateFailedQuarantineTtlHours: 48,
    });
  });

  it("defaults multi-buy ladder perTokenUsdcCap to Plankton-aligned 25 USDC", () => {
    expect(DEFAULT_EXECUTION_POLICY.multiBuyLadder.perTokenUsdcCap).toBe(25);
  });

  it("defaults redeem sweep to auto-on with 10-minute cadence", () => {
    expect(DEFAULT_EXECUTION_POLICY.redeemSweep).toMatchObject({
      enabled: true,
      intervalMs: 600_000,
      circuitBreakerEnabled: true,
      stateFailedQuarantineThreshold: 5,
      stateFailedQuarantineTtlHours: 24,
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
        redeemSweep: {
          circuitBreakerEnabled: "yes",
          stateFailedQuarantineThreshold: 0,
          stateFailedQuarantineTtlHours: 0,
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
    expect(policy.redeemSweep).toEqual(DEFAULT_EXECUTION_POLICY.redeemSweep);
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
    expect(issues.some((i) => i.includes("redeemSweep.circuitBreakerEnabled"))).toBe(true);
    expect(issues.some((i) => i.includes("redeemSweep.stateFailedQuarantineThreshold"))).toBe(true);
    expect(issues.some((i) => i.includes("redeemSweep.stateFailedQuarantineTtlHours"))).toBe(true);
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

  it("defaults sellLoopGuard to enforcement with 10 / 6h / 6h", () => {
    expect(DEFAULT_EXECUTION_POLICY.sellLoopGuard).toEqual({
      enabled: true,
      windowMs: 21_600_000,
      threshold: 10,
      cooldownMs: 21_600_000,
      countPostOnlyCrossPreSubmit: true,
      countExchangeNoOrderId: true,
    });
    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify({ entryPriceCeiling: 0.4 }));
    expect(issues).toHaveLength(0);
    expect(policy.sellLoopGuard).toEqual(DEFAULT_EXECUTION_POLICY.sellLoopGuard);
  });

  it("parses custom sellLoopGuard values", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        sellLoopGuard: {
          enabled: false,
          windowMs: 3_600_000,
          threshold: 5,
          cooldownMs: 7_200_000,
          countPostOnlyCrossPreSubmit: false,
          countExchangeNoOrderId: false,
        },
      }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.sellLoopGuard).toEqual({
      enabled: false,
      windowMs: 3_600_000,
      threshold: 5,
      cooldownMs: 7_200_000,
      countPostOnlyCrossPreSubmit: false,
      countExchangeNoOrderId: false,
    });
  });

  it("rejects out-of-bound sellLoopGuard numeric fields and falls back to defaults", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        sellLoopGuard: { windowMs: 100, threshold: 0, cooldownMs: 999 * 60 * 60_000 },
      }),
    );
    expect(policy.sellLoopGuard.windowMs).toBe(DEFAULT_EXECUTION_POLICY.sellLoopGuard.windowMs);
    expect(policy.sellLoopGuard.threshold).toBe(DEFAULT_EXECUTION_POLICY.sellLoopGuard.threshold);
    expect(policy.sellLoopGuard.cooldownMs).toBe(DEFAULT_EXECUTION_POLICY.sellLoopGuard.cooldownMs);
    expect(issues.some((i) => i.includes("sellLoopGuard.windowMs"))).toBe(true);
    expect(issues.some((i) => i.includes("sellLoopGuard.threshold"))).toBe(true);
    expect(issues.some((i) => i.includes("sellLoopGuard.cooldownMs"))).toBe(true);
  });

  it("rejects sellLoopGuard as array or scalar with an issue and falls back", () => {
    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify({ sellLoopGuard: [1, 2] }));
    expect(issues.some((i) => i.includes("sellLoopGuard must be an object"))).toBe(true);
    expect(policy.sellLoopGuard).toEqual(DEFAULT_EXECUTION_POLICY.sellLoopGuard);
  });

  it("defaults Track S4 dust auto-close off with calibrated thresholds", () => {
    expect((DEFAULT_EXECUTION_POLICY as any).trackS4).toEqual({
      enabled: false,
      scanIntervalMs: 300_000,
      maxCandidatesPerCycle: 25,
      retryBackoffMs: 24 * 60 * 60_000,
      thresholds: {
        liquidationValueMaxUsdc: 0.5,
        costBasisMaxUsdc: 5,
        lastSellMinAgeMs: 7 * 24 * 60 * 60_000,
      },
      execution: {
        priceOffsetTicks: 1,
        cancelStaleSellOrders: true,
      },
    });

    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify({ entryPriceCeiling: 0.4 }));
    expect(issues).toHaveLength(0);
    expect((policy as any).trackS4).toEqual((DEFAULT_EXECUTION_POLICY as any).trackS4);
  });

  it("parses custom Track S4 dust auto-close values", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        trackS4: {
          enabled: true,
          scanIntervalMs: 300_000,
          maxCandidatesPerCycle: 25,
          retryBackoffMs: 2 * 24 * 60 * 60_000,
          thresholds: {
            liquidationValueMaxUsdc: 0.4,
            costBasisMaxUsdc: 4.5,
            lastSellMinAgeMs: 8 * 24 * 60 * 60_000,
          },
          execution: {
            priceOffsetTicks: 2,
            cancelStaleSellOrders: false,
          },
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect((policy as any).trackS4).toEqual({
      enabled: true,
      scanIntervalMs: 300_000,
      maxCandidatesPerCycle: 25,
      retryBackoffMs: 2 * 24 * 60 * 60_000,
      thresholds: {
        liquidationValueMaxUsdc: 0.4,
        costBasisMaxUsdc: 4.5,
        lastSellMinAgeMs: 8 * 24 * 60 * 60_000,
      },
      execution: {
        priceOffsetTicks: 2,
        cancelStaleSellOrders: false,
      },
    });
  });

  it("rejects unsafe Track S4 numeric values and falls back", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        trackS4: {
          scanIntervalMs: 100,
          maxCandidatesPerCycle: 0,
          retryBackoffMs: 100,
          thresholds: {
            liquidationValueMaxUsdc: 0,
            costBasisMaxUsdc: -1,
            lastSellMinAgeMs: 1_000,
          },
          execution: {
            priceOffsetTicks: -1,
            cancelStaleSellOrders: "yes",
          },
        },
      }),
    );

    expect((policy as any).trackS4).toEqual((DEFAULT_EXECUTION_POLICY as any).trackS4);
    expect(issues.some((i) => i.includes("trackS4.scanIntervalMs"))).toBe(true);
    expect(issues.some((i) => i.includes("trackS4.maxCandidatesPerCycle"))).toBe(true);
    expect(issues.some((i) => i.includes("trackS4.retryBackoffMs"))).toBe(true);
    expect(issues.some((i) => i.includes("trackS4.thresholds.liquidationValueMaxUsdc"))).toBe(true);
    expect(issues.some((i) => i.includes("trackS4.thresholds.costBasisMaxUsdc"))).toBe(true);
    expect(issues.some((i) => i.includes("trackS4.thresholds.lastSellMinAgeMs"))).toBe(true);
    expect(issues.some((i) => i.includes("trackS4.execution.priceOffsetTicks"))).toBe(true);
    expect(issues.some((i) => i.includes("trackS4.execution.cancelStaleSellOrders"))).toBe(true);
  });

  it("defaults Track R honest pricing off with non-zero conservative fallbacks", () => {
    expect(DEFAULT_EXECUTION_POLICY.trackR).toEqual({
      enabled: false,
      safetyMargin: 0.005,
      requireFullDepth: true,
      universalFallbackRate: 0.05,
      maxSaneThreshold: 1.5,
      exitBookFallback: false,
      exitBookStalenessMs: 30000,
      exitBookFetchTtlMs: 20000,
      takerCapSkip: false,
      allowPartialExit: false,
      partialExitMinFraction: 0.2,
      partialExitMinShares: 1,
      partialExitMaxPerHour: 3,
    });

    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify({ entryPriceCeiling: 0.4 }));
    expect(issues).toHaveLength(0);
    expect(policy.trackR).toEqual(DEFAULT_EXECUTION_POLICY.trackR);
  });

  it("defaults FeeScheduleProvider disabled with conservative empty schedule", () => {
    expect((DEFAULT_EXECUTION_POLICY as any).feeSchedule).toEqual({
      enabled: false,
      apiPrimaryEnabled: true,
      scheduleFallbackEnabled: true,
      apiTtlMs: 300_000,
      apiMissTtlMs: 30_000,
      degradedEventCooldownMs: 300_000,
      periods: [],
    });

    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify({ entryPriceCeiling: 0.4 }));
    expect(issues).toHaveLength(0);
    expect((policy as any).feeSchedule).toEqual((DEFAULT_EXECUTION_POLICY as any).feeSchedule);
  });

  it("parses FeeScheduleProvider periods and preserves them in round-trip serialization", () => {
    const raw = {
      feeSchedule: {
        enabled: true,
        apiPrimaryEnabled: true,
        scheduleFallbackEnabled: true,
        apiTtlMs: 120_000,
        apiMissTtlMs: 15_000,
        degradedEventCooldownMs: 600_000,
        periods: [
          {
            periodId: "promo",
            startsAtUtc: "2026-06-01T00:00:00Z",
            endsAtUtc: "2026-07-01T00:00:00Z",
            makerRebateFraction: 0,
            appliesTo: { scope: "all" },
            sourceNote: "operator test fixture",
          },
          {
            periodId: "post_promo",
            startsAtUtc: "2026-07-01T00:00:00Z",
            endsAtUtc: null,
            makerRebateFraction: 0,
            appliesTo: { scope: "all" },
            sourceNote: "operator test fixture",
          },
        ],
      },
    };
    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify(raw));

    expect(issues).toHaveLength(0);
    expect((policy as any).feeSchedule).toEqual(raw.feeSchedule);
    expect(
      (parseExecutionPolicyJson(serializeExecutionPolicy(policy)).policy as any).feeSchedule,
    ).toEqual(raw.feeSchedule);
  });

  it("rejects non-zero FeeScheduleProvider maker rebate fractions in v1", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        feeSchedule: {
          enabled: true,
          periods: [
            {
              periodId: "crypto_rebate_docs_percentage",
              startsAtUtc: "2026-06-01T00:00:00Z",
              endsAtUtc: "2026-07-01T00:00:00Z",
              makerRebateFraction: 0.2,
              appliesTo: { scope: "category", value: "crypto" },
              sourceNote:
                "Polymarket docs category rebate percentage is fee-equivalent based, not notional",
            },
          ],
        },
      }),
    );

    expect((policy as any).feeSchedule).toEqual((DEFAULT_EXECUTION_POLICY as any).feeSchedule);
    expect(
      issues.some((i) => i.includes("feeSchedule.periods[0].makerRebateFraction non-zero")),
    ).toBe(true);
  });

  it("rejects Polymarket 0.25 category rebate percentage as a notional fraction", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        feeSchedule: {
          enabled: true,
          periods: [
            {
              periodId: "sports_rebate_docs_percentage",
              startsAtUtc: "2026-06-01T00:00:00Z",
              endsAtUtc: "2026-07-01T00:00:00Z",
              makerRebateFraction: 0.25,
              appliesTo: { scope: "category", value: "sports" },
              sourceNote:
                "Polymarket docs category rebate percentage is fee-equivalent based, not notional",
            },
          ],
        },
      }),
    );

    expect((policy as any).feeSchedule).toEqual((DEFAULT_EXECUTION_POLICY as any).feeSchedule);
    expect(
      issues.some(
        (i) =>
          i.includes("feeSchedule.periods[0].makerRebateFraction non-zero") &&
          i.includes("fee-equivalent/rebate-pool"),
      ),
    ).toBe(true);
  });

  it("rejects FeeScheduleProvider periods missing makerRebateFraction", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        feeSchedule: {
          enabled: true,
          periods: [
            {
              periodId: "missing_rebate_fraction",
              startsAtUtc: "2026-06-01T00:00:00Z",
              endsAtUtc: "2026-07-01T00:00:00Z",
              appliesTo: { scope: "all" },
              sourceNote: "operator fixture missing required zero-only v1 field",
            },
          ],
        },
      }),
    );

    expect((policy as any).feeSchedule).toEqual((DEFAULT_EXECUTION_POLICY as any).feeSchedule);
    expect(
      issues.some((i) =>
        i.includes("feeSchedule.periods[0].makerRebateFraction out of range [0, 1]"),
      ),
    ).toBe(true);
  });

  it("rejects overlapping FeeScheduleProvider periods and unsafe rebate fractions", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        feeSchedule: {
          enabled: true,
          periods: [
            {
              periodId: "a",
              startsAtUtc: "2026-06-01T00:00:00Z",
              endsAtUtc: "2026-07-01T00:00:00Z",
              makerRebateFraction: 0,
              appliesTo: { scope: "all" },
              sourceNote: "test",
            },
            {
              periodId: "b",
              startsAtUtc: "2026-06-15T00:00:00Z",
              endsAtUtc: "2026-07-15T00:00:00Z",
              makerRebateFraction: 2,
              appliesTo: { scope: "all" },
              sourceNote: "test",
            },
          ],
        },
      }),
    );

    expect((policy as any).feeSchedule).toEqual((DEFAULT_EXECUTION_POLICY as any).feeSchedule);
    expect(issues.some((i) => i.includes("feeSchedule.periods overlap"))).toBe(true);
    expect(issues.some((i) => i.includes("feeSchedule.periods[1].makerRebateFraction"))).toBe(true);
  });

  it("parses custom Track R honest pricing values", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        trackR: {
          enabled: true,
          safetyMargin: 0.01,
          requireFullDepth: false,
          universalFallbackRate: 0.06,
          maxSaneThreshold: 1.25,
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect(policy.trackR).toEqual({
      enabled: true,
      safetyMargin: 0.01,
      requireFullDepth: false,
      universalFallbackRate: 0.06,
      maxSaneThreshold: 1.25,
      exitBookFallback: false,
      exitBookStalenessMs: 30000,
      exitBookFetchTtlMs: 20000,
      takerCapSkip: false,
      allowPartialExit: false,
      partialExitMinFraction: 0.2,
      partialExitMinShares: 1,
      partialExitMaxPerHour: 3,
    });
  });

  it("ignores removed Track R shadowOnly config instead of weakening the static floor", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        trackR: {
          enabled: false,
          shadowOnly: true,
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect(policy.trackR).toEqual(DEFAULT_EXECUTION_POLICY.trackR);
    expect("shadowOnly" in policy.trackR).toBe(false);
  });

  it("rejects unsafe Track R numeric values and falls back", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        trackR: {
          safetyMargin: -1,
          universalFallbackRate: 0,
          maxSaneThreshold: 100,
        },
      }),
    );

    expect(policy.trackR).toEqual(DEFAULT_EXECUTION_POLICY.trackR);
    expect(issues.some((i) => i.includes("trackR.safetyMargin"))).toBe(true);
    expect(issues.some((i) => i.includes("trackR.universalFallbackRate"))).toBe(true);
    expect(issues.some((i) => i.includes("trackR.maxSaneThreshold"))).toBe(true);
  });

  it("defaults the Track S5 exit-path extension flags off with conservative bounds", () => {
    expect(DEFAULT_EXECUTION_POLICY.trackR).toMatchObject({
      exitBookFallback: false,
      exitBookStalenessMs: 30000,
      exitBookFetchTtlMs: 20000,
      takerCapSkip: false,
      allowPartialExit: false,
      partialExitMinFraction: 0.2,
      partialExitMinShares: 1,
      partialExitMaxPerHour: 3,
    });

    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify({ entryPriceCeiling: 0.4 }));
    expect(issues).toHaveLength(0);
    expect(policy.trackR.exitBookFallback).toBe(false);
    expect(policy.trackR.takerCapSkip).toBe(false);
    expect(policy.trackR.allowPartialExit).toBe(false);
  });

  it("parses custom Track S5 exit-path extension flags", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        trackR: {
          exitBookFallback: true,
          exitBookStalenessMs: 45000,
          exitBookFetchTtlMs: 25000,
          takerCapSkip: true,
          allowPartialExit: true,
          partialExitMinFraction: 0.35,
          partialExitMinShares: 5,
          partialExitMaxPerHour: 6,
        },
      }),
    );

    expect(issues).toHaveLength(0);
    expect(policy.trackR).toMatchObject({
      exitBookFallback: true,
      exitBookStalenessMs: 45000,
      exitBookFetchTtlMs: 25000,
      takerCapSkip: true,
      allowPartialExit: true,
      partialExitMinFraction: 0.35,
      partialExitMinShares: 5,
      partialExitMaxPerHour: 6,
    });
  });

  it("rejects out-of-range Track S5 exit-path values and falls back to defaults", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({
        trackR: {
          exitBookStalenessMs: 0,
          exitBookFetchTtlMs: 10 ** 9,
          partialExitMinFraction: 5,
          partialExitMaxPerHour: 0,
        },
      }),
    );

    expect(policy.trackR.exitBookStalenessMs).toBe(
      DEFAULT_EXECUTION_POLICY.trackR.exitBookStalenessMs,
    );
    expect(policy.trackR.exitBookFetchTtlMs).toBe(
      DEFAULT_EXECUTION_POLICY.trackR.exitBookFetchTtlMs,
    );
    expect(policy.trackR.partialExitMinFraction).toBe(
      DEFAULT_EXECUTION_POLICY.trackR.partialExitMinFraction,
    );
    expect(policy.trackR.partialExitMaxPerHour).toBe(
      DEFAULT_EXECUTION_POLICY.trackR.partialExitMaxPerHour,
    );
    expect(issues.some((i) => i.includes("trackR.exitBookStalenessMs"))).toBe(true);
    expect(issues.some((i) => i.includes("trackR.exitBookFetchTtlMs"))).toBe(true);
    expect(issues.some((i) => i.includes("trackR.partialExitMinFraction"))).toBe(true);
    expect(issues.some((i) => i.includes("trackR.partialExitMaxPerHour"))).toBe(true);
  });
});
