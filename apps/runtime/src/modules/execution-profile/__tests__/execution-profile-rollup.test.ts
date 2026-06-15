import { describe, expect, it, vi } from "vitest";

import { ExecutionProfileRollup } from "../execution-profile-rollup.js";

const NOW = Date.parse("2026-06-14T00:00:00.000Z");

describe("ExecutionProfileRollup", () => {
  it("aggregates finite-label decision-chain buckets and flushes durable events", () => {
    const emit = vi.fn();
    const writeCounter = vi.fn();
    const writeEvent = vi.fn();
    const rollup = new ExecutionProfileRollup({
      windowMs: 300_000,
      maxBuckets: 10_000,
      now: () => NOW,
      emit,
      writeCounter,
      writeEvent,
    });

    rollup.record({
      kind: "scale_in",
      profile: "medium",
      outcome: "skip",
      mode: "up",
      reason: "time_gate_blocked",
      sample: { tokenId: "token-a" },
    });
    rollup.record({
      kind: "scale_in",
      profile: "medium",
      outcome: "skip",
      mode: "up",
      reason: "time_gate_blocked",
      sample: { tokenId: "token-b" },
    });

    expect(rollup.bucketCount()).toBe(1);
    rollup.flushAll("periodic");

    expect(emit).toHaveBeenCalledWith({
      eventType: "execution_profile_decision_chain_rollup",
      payload: expect.objectContaining({
        count: 2,
        flushReason: "periodic",
        kind: "scale_in",
        profile: "medium",
        outcome: "skip",
        mode: "up",
        reason: "time_gate_blocked",
      }),
    });
    expect(writeCounter).toHaveBeenCalledWith(
      "track_execution_profile_chain_decision",
      2,
      '{"kind":"scale_in","mode":"up","outcome":"skip","profile":"medium","reason":"time_gate_blocked"}',
    );
    expect(writeEvent).toHaveBeenCalledWith(
      "track_execution_profile_rollup_bucket_count_gauge",
      1,
      "{}",
      "2026-06-14T00:00:00.000Z",
    );
  });

  it("writes the pre-flush bucket peak to the gauge on overflow", () => {
    const writeEvent = vi.fn();
    const rollup = new ExecutionProfileRollup({
      windowMs: 300_000,
      maxBuckets: 1,
      now: () => NOW,
      emit: vi.fn(),
      writeCounter: vi.fn(),
      writeEvent,
    });

    rollup.record({
      kind: "scale_in",
      profile: "cheap",
      outcome: "skip",
      mode: "flat",
      reason: "flat_no_trigger",
      sample: {},
    });
    rollup.record({
      kind: "scale_in",
      profile: "medium",
      outcome: "skip",
      mode: "flat",
      reason: "flat_no_trigger",
      sample: {},
    });

    expect(writeEvent).toHaveBeenCalledWith(
      "track_execution_profile_rollup_bucket_count_gauge",
      1,
      "{}",
      "2026-06-14T00:00:00.000Z",
    );
    expect(rollup.bucketCount()).toBe(1);
  });

  it("rejects unknown reasons before they become metric labels", () => {
    const rollup = new ExecutionProfileRollup({
      windowMs: 300_000,
      maxBuckets: 10_000,
      now: () => NOW,
      emit: vi.fn(),
      writeCounter: vi.fn(),
      writeEvent: vi.fn(),
    });

    expect(() =>
      rollup.record({
        kind: "scale_in",
        profile: "cheap",
        outcome: "skip",
        mode: "flat",
        reason: "free-form-reason" as never,
        sample: {},
      }),
    ).toThrow(/reason/);
  });
});
