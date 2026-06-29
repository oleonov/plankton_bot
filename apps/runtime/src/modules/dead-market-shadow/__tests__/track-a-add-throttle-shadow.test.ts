import { describe, expect, it } from "vitest";
import { SignalReason, createTokenId, type LegState, type LegStateRepository } from "@krabs/domain";
import {
  TRACK_A_MIN_LEG_AGE_MINUTES,
  evaluateSignalTrackAAddThrottle,
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

const TOKEN = createTokenId("0xtokenA");

function makeLegState(overrides: Partial<LegState> = {}): LegState {
  const firstTradeAt = new Date(tsAgeMinutes(90)).toISOString();
  return {
    tokenId: TOKEN,
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.3,
    firstTradeAt,
    lastTradeAt: firstTradeAt,
    updatedAt: firstTradeAt,
    ...overrides,
  };
}

// Minimal repo stub: only `get` is exercised by the shared helper.
function repoReturning(legState: LegState | null): LegStateRepository {
  return { get: () => legState } as unknown as LegStateRepository;
}

describe("evaluateSignalTrackAAddThrottle (shared shadow/bridge contract)", () => {
  it("flags an old add with no SELL as a throttle candidate and derives labels", () => {
    const evaluation = evaluateSignalTrackAAddThrottle(
      { reason: SignalReason.ScaleIn, decisionRuleId: "D3", tokenId: TOKEN },
      repoReturning(makeLegState()),
      NOW,
    );

    expect(evaluation.decisionType).toBe("add");
    expect(evaluation.sourceGroup).toBe("d1_d3");
    expect(evaluation.result.classification).toBe("throttle_candidate");
    expect(evaluation.result.reason).toBe("age_60m_no_sell");
    expect(evaluation.legStatePresent).toBe(true);
    expect(evaluation.hasSellInLeg).toBe(false);
    expect(evaluation.firstBuyTs).toBe(tsAgeMinutes(90));
  });

  it("does not query the leg repo for a probe-entry and returns not_add", () => {
    let queried = false;
    const repo = {
      get: () => {
        queried = true;
        return makeLegState();
      },
    } as unknown as LegStateRepository;

    const evaluation = evaluateSignalTrackAAddThrottle(
      { reason: SignalReason.ProbeEntry, decisionRuleId: "FALLBACK", tokenId: TOKEN },
      repo,
      NOW,
    );

    expect(queried).toBe(false);
    expect(evaluation.decisionType).toBe("entry");
    expect(evaluation.sourceGroup).toBe("fallback");
    expect(evaluation.result.classification).toBe("allow");
    expect(evaluation.result.reason).toBe("not_add");
    expect(evaluation.legStatePresent).toBe(false);
  });

  it("fails open to unknown when the leg repo is absent for an add", () => {
    const evaluation = evaluateSignalTrackAAddThrottle(
      { reason: SignalReason.ScaleIn, decisionRuleId: "D1", tokenId: TOKEN },
      undefined,
      NOW,
    );

    expect(evaluation.result.classification).toBe("unknown");
    expect(evaluation.result.reason).toBe("missing_first_buy_ts");
    expect(evaluation.legStatePresent).toBe(false);
    expect(evaluation.firstBuyTs).toBeNull();
    expect(evaluation.hasSellInLeg).toBeNull();
  });

  it("allows an old add once a SELL has occurred in the leg", () => {
    const evaluation = evaluateSignalTrackAAddThrottle(
      { reason: SignalReason.ScaleIn, decisionRuleId: "D1", tokenId: TOKEN },
      repoReturning(makeLegState({ sellCount: 1, lastAction: "SELL" })),
      NOW,
    );

    expect(evaluation.result.classification).toBe("allow");
    expect(evaluation.result.reason).toBe("sell_seen");
    expect(evaluation.hasSellInLeg).toBe(true);
  });
});
