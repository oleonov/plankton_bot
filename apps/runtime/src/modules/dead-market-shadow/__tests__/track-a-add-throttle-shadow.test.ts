import { describe, expect, it } from "vitest";
import {
  TRACK_A_MIN_LEG_AGE_MINUTES,
  evaluateTrackAAddThrottle,
  type TrackAAddThrottleInput,
} from "../track-a-add-throttle-shadow.js";

const NOW = Date.parse("2026-06-28T12:00:00.000Z");

// firstBuyTs for a leg that is `minutes` old relative to NOW.
const tsAgeMinutes = (minutes: number): number => NOW - minutes * 60_000;

function input(overrides: Partial<TrackAAddThrottleInput> = {}): TrackAAddThrottleInput {
  return {
    decisionType: "add",
    firstBuyTs: tsAgeMinutes(90),
    hasSellInLeg: false,
    now: NOW,
    ...overrides,
  };
}

describe("evaluateTrackAAddThrottle", () => {
  it("exposes the validated 60-minute leg-age threshold", () => {
    expect(TRACK_A_MIN_LEG_AGE_MINUTES).toBe(60);
  });

  it("allows an entry decision as not_add (the rule only targets adds)", () => {
    const result = evaluateTrackAAddThrottle(input({ decisionType: "entry" }));
    expect(result.classification).toBe("allow");
    expect(result.reason).toBe("not_add");
    expect(result.legAgeMinutes).toBeNull();
  });

  it("allows an unknown decision type as not_add", () => {
    const result = evaluateTrackAAddThrottle(input({ decisionType: "unknown" }));
    expect(result.classification).toBe("allow");
    expect(result.reason).toBe("not_add");
  });

  it("allows an add younger than 60 minutes as insufficient_age", () => {
    const result = evaluateTrackAAddThrottle(input({ firstBuyTs: tsAgeMinutes(30) }));
    expect(result.classification).toBe("allow");
    expect(result.reason).toBe("insufficient_age");
    expect(result.legAgeMinutes).toBeCloseTo(30, 6);
  });

  it("flags an add at exactly 60 minutes with no sell as throttle_candidate", () => {
    const result = evaluateTrackAAddThrottle(input({ firstBuyTs: tsAgeMinutes(60) }));
    expect(result.classification).toBe("throttle_candidate");
    expect(result.reason).toBe("age_60m_no_sell");
    expect(result.legAgeMinutes).toBeCloseTo(60, 6);
  });

  it("flags an add older than 60 minutes with no sell as throttle_candidate", () => {
    const result = evaluateTrackAAddThrottle(input({ firstBuyTs: tsAgeMinutes(90) }));
    expect(result.classification).toBe("throttle_candidate");
    expect(result.reason).toBe("age_60m_no_sell");
    expect(result.legAgeMinutes).toBeCloseTo(90, 6);
  });

  it("allows an old add when a SELL has already occurred in the leg", () => {
    const result = evaluateTrackAAddThrottle(
      input({ firstBuyTs: tsAgeMinutes(90), hasSellInLeg: true }),
    );
    expect(result.classification).toBe("allow");
    expect(result.reason).toBe("sell_seen");
    expect(result.legAgeMinutes).toBeCloseTo(90, 6);
  });

  it("reports unknown/missing_first_buy_ts when the leg start is unavailable", () => {
    const result = evaluateTrackAAddThrottle(input({ firstBuyTs: null }));
    expect(result.classification).toBe("unknown");
    expect(result.reason).toBe("missing_first_buy_ts");
    expect(result.legAgeMinutes).toBeNull();
  });

  it("reports unknown/missing_sell_state for an old-enough add with unknown sell state", () => {
    const result = evaluateTrackAAddThrottle(
      input({ firstBuyTs: tsAgeMinutes(90), hasSellInLeg: null }),
    );
    expect(result.classification).toBe("unknown");
    expect(result.reason).toBe("missing_sell_state");
    expect(result.legAgeMinutes).toBeCloseTo(90, 6);
  });

  it("treats age as decisive: a young add with unknown sell state is still insufficient_age", () => {
    // The throttle requires age>=60 AND no sell; if age alone rules it out we
    // never need the (missing) sell state, so this stays a definitive allow.
    const result = evaluateTrackAAddThrottle(
      input({ firstBuyTs: tsAgeMinutes(30), hasSellInLeg: null }),
    );
    expect(result.classification).toBe("allow");
    expect(result.reason).toBe("insufficient_age");
  });
});
