import { describe, expect, it } from "vitest";

import { DEFAULT_EXECUTION_PROFILE_POLICY, parseExecutionPolicyJson } from "../execution-policy.js";
import { parseBounceAskCaptureProofV1 } from "../repositories.js";

describe("sellableFlow policy", () => {
  it("defaults to OFF (byte-identical behaviour when off)", () => {
    const sf = parseExecutionPolicyJson(null).policy.sellableFlow;
    expect(sf).toMatchObject({ enabled: false, buffer: 1.2, maxEntryUsdc: 5, appliesFromMs: null });
  });

  it("fail-closed: enabled:true with appliesFromMs=null forces enabled=false", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({ sellableFlow: { enabled: true, appliesFromMs: null } }),
    );
    expect(parsed.policy.sellableFlow.enabled).toBe(false);
    expect(parsed.issues.some((i) => i.includes("appliesFromMs"))).toBe(true);
  });

  it("enables only with an explicit appliesFromMs cutoff", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({ sellableFlow: { enabled: true, appliesFromMs: 1_700_000_000_000 } }),
    );
    expect(parsed.policy.sellableFlow).toMatchObject({
      enabled: true,
      appliesFromMs: 1_700_000_000_000,
    });
  });

  // Codex H5 fix: a malformed non-null appliesFromMs must fail closed to
  // null/disabled, never silently fall back to 0 (epoch zero) — 0 is itself
  // a valid non-null timestamp that would satisfy the enabled-requires-
  // cutoff check and enable bounce-for-all for every position ever opened.
  // (NaN can't be represented in real JSON text, so only type-mismatches
  // reachable through the actual JSON-string API are exercised here.)
  it.each([
    ["a non-numeric string", '"not-a-timestamp"'],
    ["an object", '{"bad":true}'],
  ])("fail-closed: %s appliesFromMs is treated as null, not 0", (_label, rawJsonValue) => {
    const parsed = parseExecutionPolicyJson(
      `{"sellableFlow":{"enabled":true,"appliesFromMs":${rawJsonValue}}}`,
    );
    expect(parsed.policy.sellableFlow.enabled).toBe(false);
    expect(parsed.policy.sellableFlow.appliesFromMs).toBeNull();
    expect(parsed.issues.some((i) => i.includes("appliesFromMs"))).toBe(true);
  });
});

describe("execution profile signal feed policy", () => {
  it("defaults signal feed and real-feed consumption to dark", () => {
    const policy = parseExecutionPolicyJson(null).policy.executionProfile;

    expect(policy.signalFeed).toMatchObject({
      enabled: false,
      windowShortMs: 3_600_000,
      windowLongMs: 10_800_000,
      warmBucketMs: 60_000,
      coldArchiveBucketMs: 3_600_000,
      retentionDays: 7,
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

  // `retentionDays` is the ONLY source of truth for the signal_feed_buckets DELETE horizon
  // (ledger-retention-module.ts), and that consumer refuses any horizon under one hour — it skips
  // the sweep rather than delete on a mis-scaled value. A policy that accepts what the sweep will
  // refuse forever is a table that grows unbounded while everything reports healthy: this is how
  // signal_feed_buckets reached 35.1M rows / 15.50 GB. The parser must reject it at the door.
  it.each([
    ["under the consumer's one-hour floor", 1 / 1440],
    ["past the ten-year ceiling", 3_651],
  ])("rejects a retentionDays %s instead of passing it to the sweep", (_label, retentionDays) => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({ executionProfile: { signalFeed: { retentionDays } } }),
    );

    expect(parsed.policy.executionProfile.signalFeed.retentionDays).toBe(
      DEFAULT_EXECUTION_PROFILE_POLICY.signalFeed.retentionDays,
    );
    expect(
      parsed.issues.some((i) => i.startsWith("executionProfile.signalFeed.retentionDays=")),
    ).toBe(true);
  });

  // A sub-second maintenance cadence is not a tuning choice — it is a mis-scaled value that fires
  // the feed's own timers a thousand times a second, and one of them writes three runtime_metrics
  // rows per tick: 3 000 rows/s into the very ledger this retention work bounds.
  it.each<[keyof typeof DEFAULT_EXECUTION_PROFILE_POLICY.signalFeed, number]>([
    ["flushHotToWarmIntervalMs", 999],
    ["flushWarmToColdIntervalMs", 0],
    ["maintenanceIntervalMs", 24 * 60 * 60_000 + 1],
  ])("rejects an out-of-range %s", (field, value) => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({ executionProfile: { signalFeed: { [field]: value } } }),
    );

    expect(parsed.policy.executionProfile.signalFeed[field]).toBe(
      DEFAULT_EXECUTION_PROFILE_POLICY.signalFeed[field],
    );
    expect(parsed.issues.some((i) => i.startsWith(`executionProfile.signalFeed.${field}=`))).toBe(
      true,
    );
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

  it("defaults sellLadder.shadowPlanktonPolicy to shadow-only", () => {
    const policy = parseExecutionPolicyJson(null).policy.executionProfile.sellLadder;

    expect(policy.shadowPlanktonPolicy).toMatchObject({
      enabled: true,
      writeRiskEvents: true,
      variants: ["p25", "median", "cheap_tail"],
      liveBehaviorEnabled: false,
      riskEventDedupeMs: 600_000,
    });
    expect(policy.shadowPlanktonPolicy.bands.gte_0_01_lt_0_02).toMatchObject({
      p25: 1.14,
      median: 1.36,
      p75: 1.73,
      sampleSize: 1455,
    });
  });

  it("parses a shadow Plankton policy without enabling live behavior", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            shadowPlanktonPolicy: {
              enabled: false,
              writeRiskEvents: false,
              variants: ["p25", "p75"],
              riskEventDedupeMs: 120_000,
            },
          },
        },
      }),
    );

    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.executionProfile.sellLadder.shadowPlanktonPolicy).toMatchObject({
      enabled: false,
      writeRiskEvents: false,
      variants: ["p25", "p75"],
      liveBehaviorEnabled: false,
      riskEventDedupeMs: 120_000,
    });
  });

  it("rejects shadow Plankton live behavior activation in Phase 1", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        executionProfile: {
          sellLadder: {
            shadowPlanktonPolicy: {
              enabled: true,
              liveBehaviorEnabled: true,
            },
          },
        },
      }),
    );

    expect(parsed.issues).toContain(
      "executionProfile.sellLadder.shadowPlanktonPolicy.liveBehaviorEnabled=true is unsupported in Phase 1",
    );
    expect(parsed.policy.executionProfile.sellLadder.shadowPlanktonPolicy.liveBehaviorEnabled).toBe(
      false,
    );
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

describe("track A add-throttle live enforcement policy", () => {
  it("defaults trackAAddThrottle.enforce to false (shadow-only)", () => {
    const policy = parseExecutionPolicyJson(null).policy;

    expect(policy.trackAAddThrottle).toEqual({ enforce: false });
  });

  it("parses trackAAddThrottle.enforce override", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({ trackAAddThrottle: { enforce: true } }),
    );

    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.trackAAddThrottle).toEqual({ enforce: true });
  });

  it("falls back invalid trackAAddThrottle.enforce to default with an issue", () => {
    const parsed = parseExecutionPolicyJson(
      JSON.stringify({ trackAAddThrottle: { enforce: "yes" } }),
    );

    expect(parsed.issues).toContain("trackAAddThrottle.enforce must be boolean");
    expect(parsed.policy.trackAAddThrottle).toEqual({ enforce: false });
  });
});

describe("bounce ask-capture policy and proof", () => {
  const sourceCohortActivatedAtUtc = "2026-08-20T10:00:00.000Z";
  const trigger = {
    eventTimestampMs: 1,
    evaluatedAtMs: 2,
    policySchemaVersion: 1,
    policyControlRevision: 7,
    sourceCohortActivatedAtUtc,
    originalTargetPrice: 0.25,
    candidatePrice: 0.19,
    externalBestBid: 0.1,
    externalBestAsk: 0.2,
    tickSize: 0.01,
    positionResidualShares: 10,
    sourceBuyRootOrderIds: ["buy-root-1"],
  };
  const prepared = {
    ...trigger,
    evaluatedAtMs: 3,
    candidatePrice: 0.18,
    externalBestBid: 0.11,
    externalBestAsk: 0.19,
    positionResidualShares: 9,
    snapshotTs: 4,
    cachedAtMs: 5,
    sourcePolledAtMs: 6,
    minOrderSize: 5,
    replacementSize: 8,
  };
  const submit = {
    ...prepared,
    evaluatedAtMs: 7,
    candidatePrice: 0.17,
    externalBestBid: 0.12,
    externalBestAsk: 0.18,
    snapshotTs: 8,
    cachedAtMs: 9,
    sourcePolledAtMs: 10,
    childOrderId: "ask-child-1",
    clientOrderId: "ask-child-client-1",
    authoritativeStateCapturedAtMs: 11,
    authoritativeOpenOrderCount: 1,
    authoritativeFilledShares: 2,
    authoritativeWalletShares: 10,
    authoritativeStateHash: "sha256:authoritative-state",
  };

  it("defaults OFF and enables only with a canonical source cohort plus bounded cap", () => {
    expect(parseExecutionPolicyJson(null).policy.bounceAskCapture).toEqual({
      enabled: false,
      sourceCohortActivatedAtUtc: "",
      maxRepricesPerRoot: 5,
    });

    const parsed = parseExecutionPolicyJson(
      JSON.stringify({
        bounceAskCapture: {
          enabled: true,
          sourceCohortActivatedAtUtc,
          maxRepricesPerRoot: 3,
        },
      }),
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.bounceAskCapture).toEqual({
      enabled: true,
      sourceCohortActivatedAtUtc,
      maxRepricesPerRoot: 3,
    });
  });

  it.each([
    ["missing cohort", { enabled: true, maxRepricesPerRoot: 3 }],
    [
      "non-canonical cohort",
      {
        enabled: true,
        sourceCohortActivatedAtUtc: "2026-08-20T10:00:00Z",
        maxRepricesPerRoot: 3,
      },
    ],
    [
      "impossible cohort",
      {
        enabled: true,
        sourceCohortActivatedAtUtc: "2026-02-30T10:00:00.000Z",
        maxRepricesPerRoot: 3,
      },
    ],
    ["zero cap", { enabled: true, sourceCohortActivatedAtUtc, maxRepricesPerRoot: 0 }],
    ["oversized cap", { enabled: true, sourceCohortActivatedAtUtc, maxRepricesPerRoot: 6 }],
  ])("fails closed for %s", (_label, bounceAskCapture) => {
    const parsed = parseExecutionPolicyJson(JSON.stringify({ bounceAskCapture }));

    expect(parsed.policy.bounceAskCapture.enabled).toBe(false);
    expect(parsed.policy.bounceAskCapture.sourceCohortActivatedAtUtc).toBe("");
    expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it("strictly parses complete, internally consistent trigger/prepared/submit proof", () => {
    const proof = { version: 1, trigger, prepared, submit };

    expect(parseBounceAskCaptureProofV1(proof)).toEqual(proof);
    expect(parseBounceAskCaptureProofV1({ ...proof, prepared: null })).toBeNull();
    expect(
      parseBounceAskCaptureProofV1({
        version: 1,
        trigger,
        prepared: { ...prepared, replacementSize: 4 },
        submit: null,
      }),
    ).toBeNull();
    expect(
      parseBounceAskCaptureProofV1({
        ...proof,
        prepared: { ...prepared, sourceBuyRootOrderIds: ["different-root"] },
      }),
    ).toBeNull();
    expect(
      parseBounceAskCaptureProofV1({
        ...proof,
        trigger: { ...trigger, unexpected: true },
      }),
    ).toBeNull();
  });
});
