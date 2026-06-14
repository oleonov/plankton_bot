import { afterEach, describe, expect, it, vi } from "vitest";
import { DEDUPED_SUPPRESSION_REASONS } from "../algo-decision-module.js";
import {
  MAX_ROLLUP_BUCKETS,
  PlannerSuppressionRollup,
  ROLLUP_SUPPRESSION_REASONS,
  type PlannerSuppressionFacts,
} from "../planner-suppression-rollup.js";

const ROLLUP_REASON = "sell-spread-too-wide-below-avg-entry";

function makeFacts(overrides: Partial<PlannerSuppressionFacts> = {}): PlannerSuppressionFacts {
  const tokenId = overrides.tokenId ?? "token-a";
  const reasonCode = overrides.reasonCode ?? ROLLUP_REASON;
  return {
    tokenId,
    conditionId: overrides.conditionId ?? "cond-a",
    reasonCode,
    decisionRuleId: overrides.decisionRuleId ?? "D8_PROFIT_RATIO",
    side: overrides.side ?? "sell",
    sample: overrides.sample ?? {
      tokenId,
      reasonCode,
      price: 0.04,
      signalTimestamp: "2026-06-14T00:00:00.000Z",
    },
  };
}

function createHarness(overrides: { windowMs?: number; maxBuckets?: number } = {}) {
  let nowMs = Date.parse("2026-06-14T00:00:00.000Z");
  const emitted: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const counters: Array<{ metricName: string; value: number; labels: string | null }> = [];
  const gauges: Array<{ metricName: string; value: number; labels: string | null }> = [];
  const rollup = new PlannerSuppressionRollup({
    windowMs: overrides.windowMs ?? 300_000,
    maxBuckets: overrides.maxBuckets ?? MAX_ROLLUP_BUCKETS,
    now: () => nowMs,
    emit: (event) => emitted.push(event),
    writeCounter: (metricName, value, labels) => counters.push({ metricName, value, labels }),
    writeLatest: (metricName, value, labels) => gauges.push({ metricName, value, labels }),
  });
  return {
    rollup,
    emitted,
    counters,
    gauges,
    advance(ms: number): void {
      nowMs += ms;
    },
  };
}

describe("PlannerSuppressionRollup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rolls up repeated sell-spread suppressions under one key", () => {
    const h = createHarness();

    expect(h.rollup.record(makeFacts())).toBe(true);
    h.advance(1_000);
    expect(h.rollup.record(makeFacts({ sample: { price: 0.05 } }))).toBe(true);

    expect(h.rollup.bucketCount()).toBe(1);
    expect(h.emitted).toEqual([]);
    expect(h.counters).toEqual([]);
  });

  it("does not touch non-rollup reasons or disabled windows", () => {
    const h = createHarness();
    const disabled = createHarness({ windowMs: 0 });

    expect(h.rollup.record(makeFacts({ reasonCode: "r23-no-history" }))).toBe(false);
    expect(disabled.rollup.record(makeFacts())).toBe(false);

    expect(h.rollup.bucketCount()).toBe(0);
    expect(disabled.rollup.bucketCount()).toBe(0);
    expect(h.counters).toEqual([]);
    expect(disabled.counters).toEqual([]);
  });

  it("flushes first and last samples and clears buckets", () => {
    const h = createHarness();

    h.rollup.record(makeFacts({ sample: { price: 0.04 } }));
    h.advance(2_000);
    h.rollup.record(makeFacts({ sample: { price: 0.06 } }));

    expect(h.rollup.flushAll("periodic")).toBe(1);
    expect(h.rollup.bucketCount()).toBe(0);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]).toMatchObject({
      eventType: "planner_suppressed_rollup",
      payload: {
        tokenId: "token-a",
        conditionId: "cond-a",
        reasonCode: ROLLUP_REASON,
        decisionRuleId: "D8_PROFIT_RATIO",
        side: "sell",
        count: 2,
        windowMs: 300_000,
        firstPayloadSample: { price: 0.04 },
        lastPayloadSample: { price: 0.06 },
        flushReason: "periodic",
        schemaVersion: 1,
      },
    });
    expect(h.gauges).toContainEqual({
      metricName: "track_planner_rollup_bucket_count_gauge",
      value: 1,
      labels: null,
    });
  });

  it("flushes only the requested token on state transition", () => {
    const h = createHarness();
    h.rollup.record(makeFacts({ tokenId: "token-a" }));
    h.rollup.record(makeFacts({ tokenId: "token-b" }));

    expect(h.rollup.flushToken("token-a", "order_placed")).toBe(1);

    expect(h.rollup.bucketCount()).toBe(1);
    expect(h.emitted).toHaveLength(1);
    expect(h.emitted[0]?.payload).toMatchObject({
      tokenId: "token-a",
      flushReason: "order_placed",
    });
  });

  it("drains instead of evicting when the bucket cap is reached", () => {
    const h = createHarness({ maxBuckets: 3 });
    h.rollup.record(makeFacts({ tokenId: "token-a" }));
    h.rollup.record(makeFacts({ tokenId: "token-b" }));
    h.rollup.record(makeFacts({ tokenId: "token-c" }));

    h.rollup.record(makeFacts({ tokenId: "token-d" }));

    expect(h.emitted).toHaveLength(3);
    expect(h.emitted.every((event) => event.payload.flushReason === "overflow")).toBe(true);
    expect(h.rollup.bucketCount()).toBe(1);
    expect(h.counters).toContainEqual({
      metricName: "track_planner_rollup_overflow_count",
      value: 1,
      labels: null,
    });
  });

  it("periodic start and stop flushes drain pending buckets", async () => {
    vi.useFakeTimers();
    const h = createHarness({ windowMs: 60_000 });

    h.rollup.record(makeFacts());
    h.rollup.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.emitted).toHaveLength(1);

    h.rollup.record(makeFacts({ tokenId: "token-b" }));
    await h.rollup.stop();

    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1]?.payload.flushReason).toBe("shutdown");
  });

  it("keeps rollup reasons out of the legacy noisy suppression dedupe set", () => {
    const overlap = [...ROLLUP_SUPPRESSION_REASONS].filter((reason) =>
      DEDUPED_SUPPRESSION_REASONS.has(reason),
    );

    expect(overlap).toEqual([]);
  });
});
