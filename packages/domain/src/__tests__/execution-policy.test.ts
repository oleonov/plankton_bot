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
    expect(parsed.policy.executionProfile.scaleIn).toEqual({ enabled: true, useRealFeed: true });
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
