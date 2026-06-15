import { describe, expect, it, vi } from "vitest";
import { createConditionId, createTokenId } from "@krabs/domain";

import { ExecutionProfileHealthChecker } from "../execution-profile-health-checker.js";
import { InMemoryExecutionProfileStateRepository } from "../state-repository.js";
import type { ExecutionProfileStateRecord } from "../types.js";

const NOW = Date.parse("2026-06-14T00:00:00.000Z");

function state(overrides: Partial<ExecutionProfileStateRecord> = {}): ExecutionProfileStateRecord {
  return {
    tokenId: createTokenId("health-token"),
    conditionId: createConditionId("health-condition"),
    profile: "cheap",
    state: "PROBING",
    assumedAt: "2026-06-14T00:00:00.000Z",
    lastAvgEntry: 0.02,
    lastTransitionAt: "2026-06-14T00:00:00.000Z",
    activeLadderId: null,
    handoffStartedAt: null,
    addCount: 0,
    lastBuyAtMs: null,
    initialProbeSizeUsd: null,
    metadata: null,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("ExecutionProfileHealthChecker", () => {
  it("emits active-token gauges through writeEvent and reports stub freshness", async () => {
    const riskEvents = { insert: vi.fn() };
    const metrics = { writeCounter: vi.fn(), writeEvent: vi.fn(), writeLatest: vi.fn() };
    const checker = new ExecutionProfileHealthChecker({
      stateRepo: new InMemoryExecutionProfileStateRepository([state()]),
      riskEvents,
      metrics,
      policy: () => ({
        healthCheckIntervalMs: 300_000,
        rollupWindowMs: 300_000,
        maxRollupBuckets: 10_000,
        pendingScaleInWarnAfterMs: 600_000,
        healthRiskEventEveryMs: 1_800_000,
        anomalyDetection: { enabled: false, cooldownMs: 3_600_000 },
      }),
      now: () => NOW,
      signalFreshness: () => ({ status: "stub_active", reason: "stub_feed" }),
      pendingScaleIns: () => [],
    });

    const result = await checker.runOnce("manual");

    expect(result.status).toBe("ok");
    expect(result.freshness.status).toBe("stub_active");
    expect(metrics.writeEvent).toHaveBeenCalledWith(
      "track_execution_profile_active_tokens_gauge",
      1,
      '{"profile":"cheap","state":"PROBING"}',
      "2026-06-14T00:00:00.000Z",
    );
    expect(metrics.writeLatest).not.toHaveBeenCalled();
    expect(riskEvents.insert).toHaveBeenCalledWith({
      eventType: "profile_health_check",
      payload: expect.objectContaining({
        status: "ok",
        freshnessStatus: "stub_active",
      }),
    });
  });
});
