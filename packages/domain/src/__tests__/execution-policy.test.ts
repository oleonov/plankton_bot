import { describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_PROFILE_POLICY, parseExecutionPolicyJson } from "../execution-policy.js";

describe("execution profile signal feed policy", () => {
  it("defaults signal feed and real-feed consumption to dark", () => {
    const policy = parseExecutionPolicyJson(null).policy.executionProfile;

    expect(policy.signalFeed).toMatchObject({
      enabled: false,
      windowShortMs: 3_600_000,
      windowLongMs: 10_800_000,
      warmBucketMs: 60_000,
      coldArchiveBucketMs: 3_600_000,
      retentionDays: 120,
      minSamplesForSnapshot: 30,
      minSamplesForRecovery60: 60,
      minWarmBucketsForTradeCount: 90,
    });
    expect(policy.scaleIn).toMatchObject({ enabled: false, useRealFeed: false });
  });

  it("uses calibrated Spec 3.1 trigger defaults", () => {
    const cheap = DEFAULT_EXECUTION_PROFILE_POLICY.profiles.cheap.scaleIn.triggers;

    expect(cheap.activity.tradeCount3hThreshold).toBe(40);
    expect(cheap.recovery).toEqual({
      threshold: 0.08,
      strongThreshold: 0.1,
      strongActivityRecoveryFloor: 0.05,
    });
    expect(cheap.volatility).toEqual({ range60Threshold: 0.1, std60Threshold: 0.02 });
    expect(cheap.strongActivity.tradeCount3hThreshold).toBe(80);
  });

  it("parses signal feed config and strong activity recovery floor", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          scaleIn: { enabled: true, useRealFeed: true },
          signalFeed: {
            enabled: true,
            windowShortMs: 123,
            windowLongMs: 456,
            hotSampleTargetIntervalMs: 789,
            warmBucketMs: 60,
            coldArchiveBucketMs: 3600,
            retentionDays: 12,
            minSamplesForSnapshot: 7,
            minSamplesForRecovery60: 9,
            minWarmBucketsForTradeCount: 11,
            flushHotToWarmIntervalMs: 1000,
            flushWarmToColdIntervalMs: 2000,
            maintenanceIntervalMs: 3000,
          },
          profiles: {
            cheap: {
              scaleIn: {
                triggers: {
                  recovery: {
                    threshold: 0.08,
                    strongThreshold: 0.11,
                    strongActivityRecoveryFloor: 0.06,
                  },
                },
              },
            },
          },
        },
      }),
    );

    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.executionProfile.scaleIn).toMatchObject({
      enabled: true,
      useRealFeed: true,
    });
    expect(parsed.policy.executionProfile.signalFeed).toMatchObject({
      enabled: true,
      windowShortMs: 123,
      minSamplesForSnapshot: 7,
    });
    expect(
      parsed.policy.executionProfile.profiles.cheap.scaleIn.triggers.recovery
        .strongActivityRecoveryFloor,
    ).toBe(0.06);
  });

  it("falls back invalid strong activity recovery floor only for that field", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          profiles: {
            cheap: {
              scaleIn: {
                triggers: {
                  recovery: {
                    threshold: 0.09,
                    strongThreshold: 0.12,
                    strongActivityRecoveryFloor: -1,
                  },
                },
              },
            },
          },
        },
      }),
    );

    expect(parsed.issues).toContain(
      "executionProfile.profiles.cheap.scaleIn.triggers.recovery.strongActivityRecoveryFloor must be > 0",
    );
    expect(parsed.policy.executionProfile.profiles.cheap.scaleIn.triggers.recovery).toEqual({
      threshold: 0.09,
      strongThreshold: 0.12,
      strongActivityRecoveryFloor: 0.05,
    });
  });
});

describe("execution profile sell ladder policy", () => {
  it("defaults all profile ladder bands to dark with calibrated Spec 4 values", () => {
    const policy = parseExecutionPolicyJson(null).policy.executionProfile.sellLadder;

    expect(policy).toMatchObject({
      enabled: false,
      phase: 0,
      decisionRuleId: "PROFILE_LADDER",
      orderTag: "profile_ladder",
      modeAdjustments: { up: 0.95, flat: 1, avg_down: 1.5 },
      reprice: { majorBboMovePct: 0.05, strongBboMovePct: 0.1, cooldownMs: 1_800_000 },
      staleReview: { enabled: true, staleAfterMs: 86_400_000 },
      postFill: { reevalCooldownMs: 900_000 },
    });
    expect(policy.bands.medium_low).toEqual({
      enabled: false,
      minAvgEntry: 0.05,
      maxAvgEntry: 0.15,
      multipliers: [1.1, 1.3, 1.55, 1.65, 1.85],
      sizingVector: [0.38, 0.24, 0.2, 0.18],
      costCapUsd: 55,
      allowFourthRung: true,
      fourthRungMinCostUsd: 15,
      maxConcurrentRungs: 1,
    });
    expect(Object.values(policy.bands).every((band) => band.enabled === false)).toBe(true);
  });

  it("defaults every band's maxConcurrentRungs to 1 (Plankton conservative cap)", () => {
    const policy = parseExecutionPolicyJson(null).policy.executionProfile.sellLadder;

    expect(policy.bands.cheap.maxConcurrentRungs).toBe(1);
    expect(policy.bands.medium_low.maxConcurrentRungs).toBe(1);
    expect(policy.bands.medium_high.maxConcurrentRungs).toBe(1);
    expect(policy.bands.expensive.maxConcurrentRungs).toBe(1);
  });

  it("allows maxConcurrentRungs up to 2 for cheap and medium_low bands", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            bands: {
              cheap: { maxConcurrentRungs: 2 },
              medium_low: { maxConcurrentRungs: 2 },
            },
          },
        },
      }),
    );

    expect(parsed.policy.executionProfile.sellLadder.bands.cheap.maxConcurrentRungs).toBe(2);
    expect(parsed.policy.executionProfile.sellLadder.bands.medium_low.maxConcurrentRungs).toBe(2);
    expect(parsed.issues).toEqual([]);
  });

  it("rejects maxConcurrentRungs above the per-band ceiling and falls the band back to its safe default", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            bands: {
              cheap: { maxConcurrentRungs: 3 },
              medium_high: { maxConcurrentRungs: 2 },
              expensive: { maxConcurrentRungs: 2 },
            },
          },
        },
      }),
    );
    const ladder = parsed.policy.executionProfile.sellLadder;

    expect(ladder.bands.cheap.maxConcurrentRungs).toBe(1);
    expect(ladder.bands.medium_high.maxConcurrentRungs).toBe(1);
    expect(ladder.bands.expensive.maxConcurrentRungs).toBe(1);
    expect(parsed.issues.some((issue) => issue.includes("maxConcurrentRungs"))).toBe(true);
  });

  it("defaults sellLadder.postFill.reevalCooldownMs to 15 minutes (Plankton rest cooldown)", () => {
    const policy = parseExecutionPolicyJson(null).policy.executionProfile.sellLadder;

    expect(policy.postFill).toEqual({ reevalCooldownMs: 900_000 });
    expect(DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.postFill).toEqual({
      reevalCooldownMs: 900_000,
    });
  });

  it("parses a non-default sellLadder.postFill.reevalCooldownMs", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: { sellLadder: { postFill: { reevalCooldownMs: 1_200_000 } } },
      }),
    );

    expect(parsed.policy.executionProfile.sellLadder.postFill.reevalCooldownMs).toBe(1_200_000);
    expect(parsed.issues).toEqual([]);
  });

  it("falls back an invalid postFill.reevalCooldownMs to the safe default", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: { sellLadder: { postFill: { reevalCooldownMs: -1 } } },
      }),
    );

    expect(parsed.policy.executionProfile.sellLadder.postFill.reevalCooldownMs).toBe(900_000);
    expect(parsed.issues).toContain(
      "executionProfile.sellLadder.postFill.reevalCooldownMs must be >= 0",
    );
  });

  it("parses per-band sell ladder config with isolated fallback", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            enabled: true,
            phase: 1,
            bands: {
              medium_low: {
                enabled: true,
                multipliers: [1.11, 1.31, 1.56, 1.66, 1.86],
              },
              expensive: {
                costCapUsd: -1,
              },
            },
          },
        },
      }),
    );

    expect(parsed.policy.executionProfile.sellLadder.enabled).toBe(true);
    expect(parsed.policy.executionProfile.sellLadder.phase).toBe(1);
    expect(parsed.policy.executionProfile.sellLadder.bands.medium_low).toMatchObject({
      enabled: true,
      multipliers: [1.11, 1.31, 1.56, 1.66, 1.86],
    });
    expect(parsed.policy.executionProfile.sellLadder.bands.expensive).toEqual(
      DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.expensive,
    );
    expect(parsed.issues).toContain(
      "executionProfile.sellLadder.bands.expensive.costCapUsd must be > 0",
    );
  });

  it("defaults sellLadder.adoptExisting to disabled", () => {
    const policy = parseExecutionPolicyJson(null).policy.executionProfile.sellLadder;

    expect(policy.adoptExisting).toEqual({ enabled: false });
    expect(DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.adoptExisting).toEqual({ enabled: false });
  });

  it("parses a non-default sellLadder.adoptExisting enabled flag", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            adoptExisting: { enabled: true },
          },
        },
      }),
    );

    expect(parsed.policy.executionProfile.sellLadder.adoptExisting).toEqual({ enabled: true });
    expect(parsed.issues).toEqual([]);
  });
});

describe("execution profile abandonment policy", () => {
  it("defaults all abandonment bands to dark with calibrated Spec 5 values", () => {
    const policy = parseExecutionPolicyJson(null).policy.executionProfile.abandonment;

    expect(policy).toEqual({
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
    });
  });

  it("parses abandonment config with isolated per-band fallback", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          abandonment: {
            enabled: true,
            maxTokensPerCycle: 25,
            bands: {
              medium_low: {
                enabled: true,
                probeSizeMaxUsdc: 14,
                maxProbeBuyCount: 4,
                scaleInRequiredWithinMs: 3_000_000,
              },
              expensive: {
                probeSizeMaxUsdc: -1,
              },
            },
          },
        },
      }),
    );

    expect(parsed.policy.executionProfile.abandonment.enabled).toBe(true);
    expect(parsed.policy.executionProfile.abandonment.maxTokensPerCycle).toBe(25);
    expect(parsed.policy.executionProfile.abandonment.bands.medium_low).toEqual({
      enabled: true,
      probeSizeMaxUsdc: 14,
      maxProbeBuyCount: 4,
      scaleInRequiredWithinMs: 3_000_000,
    });
    expect(parsed.policy.executionProfile.abandonment.bands.expensive).toEqual(
      DEFAULT_EXECUTION_PROFILE_POLICY.abandonment.bands.expensive,
    );
    expect(parsed.issues).toContain(
      "executionProfile.abandonment.bands.expensive.probeSizeMaxUsdc must be > 0",
    );
  });
});
