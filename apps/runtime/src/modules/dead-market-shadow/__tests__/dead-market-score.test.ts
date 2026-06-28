import { describe, expect, it } from "vitest";
import { SignalReason } from "@krabs/domain";
import {
  classifyDeadMarketScore,
  computeDeadMarketScore,
  deriveDecisionType,
  deriveSourceGroup,
  type DeadMarketScoreInput,
} from "../dead-market-score.js";

// A baseline "healthy market" input: not cheap, non-R23 source, liquid, and
// every live-unavailable feature left unknown (null). Tests override one field
// at a time so each assertion isolates a single component's contribution.
function baseInput(overrides: Partial<DeadMarketScoreInput> = {}): DeadMarketScoreInput {
  return {
    selectedPrice: 0.5,
    sourceGroup: "d1_d3",
    gammaLiquidity: 500,
    planktonActive24h: null,
    planktonEverTouched: null,
    observerDead: null,
    ...overrides,
  };
}

describe("computeDeadMarketScore", () => {
  it("scores 0 and classifies shadow_allow for a non-cheap, non-R23, liquid market", () => {
    const result = computeDeadMarketScore(baseInput());
    expect(result.score).toBe(0);
    expect(result.classification).toBe("shadow_allow");
    expect(result.components.cheapTail).toBe(false);
    expect(result.components.r23OrFallbackSource).toBe(false);
    expect(result.components.lowGammaLiquidity).toBe(false);
  });

  it("scores 1 and still classifies shadow_allow when only the price is in the cheap tail", () => {
    const result = computeDeadMarketScore(baseInput({ selectedPrice: 0.01 }));
    expect(result.score).toBe(1);
    expect(result.classification).toBe("shadow_allow");
    expect(result.components.cheapTail).toBe(true);
  });

  it("treats exactly 0.02 as cheap tail (inclusive boundary)", () => {
    const result = computeDeadMarketScore(baseInput({ selectedPrice: 0.02 }));
    expect(result.components.cheapTail).toBe(true);
  });

  it("does not flag cheap tail at 0.021 (above boundary)", () => {
    const result = computeDeadMarketScore(baseInput({ selectedPrice: 0.021 }));
    expect(result.components.cheapTail).toBe(false);
  });

  it("scores 2 and classifies shadow_downweight_candidate for cheap + low liquidity", () => {
    const result = computeDeadMarketScore(baseInput({ selectedPrice: 0.01, gammaLiquidity: 50 }));
    expect(result.score).toBe(2);
    expect(result.classification).toBe("shadow_downweight_candidate");
    expect(result.components.cheapTail).toBe(true);
    expect(result.components.lowGammaLiquidity).toBe(true);
  });

  it("scores 3 and classifies shadow_block_candidate for cheap + R23 source + low liquidity", () => {
    const result = computeDeadMarketScore(
      baseInput({ selectedPrice: 0.01, sourceGroup: "r23", gammaLiquidity: 50 }),
    );
    expect(result.score).toBe(3);
    expect(result.classification).toBe("shadow_block_candidate");
    expect(result.components.r23OrFallbackSource).toBe(true);
  });

  it("flags r23OrFallbackSource for the FALLBACK source group too", () => {
    const result = computeDeadMarketScore(baseInput({ sourceGroup: "fallback" }));
    expect(result.components.r23OrFallbackSource).toBe(true);
  });

  it("scores 4 and classifies shadow_hard_block_candidate when a Plankton feature is known-dead", () => {
    const result = computeDeadMarketScore(
      baseInput({
        selectedPrice: 0.01,
        sourceGroup: "r23",
        gammaLiquidity: 50,
        planktonActive24h: false,
      }),
    );
    expect(result.score).toBe(4);
    expect(result.classification).toBe("shadow_hard_block_candidate");
    expect(result.components.planktonNotActive24h).toBe(true);
    expect(result.unknownComponents).not.toContain("planktonNotActive24h");
  });

  it("scores 5 and stays shadow_hard_block_candidate with a second known-dead Plankton feature", () => {
    const result = computeDeadMarketScore(
      baseInput({
        selectedPrice: 0.01,
        sourceGroup: "r23",
        gammaLiquidity: 50,
        planktonActive24h: false,
        planktonEverTouched: false,
      }),
    );
    expect(result.score).toBe(5);
    expect(result.classification).toBe("shadow_hard_block_candidate");
    expect(result.components.planktonNeverTouched).toBe(true);
  });

  it("computes the documented score for cheap + R23 + never-touched + low liquidity", () => {
    // cheapTail + r23OrFallbackSource + planktonNeverTouched + lowGammaLiquidity = 4.
    const result = computeDeadMarketScore(
      baseInput({
        selectedPrice: 0.01,
        sourceGroup: "r23",
        gammaLiquidity: 50,
        planktonEverTouched: false,
      }),
    );
    expect(result.score).toBe(4);
    expect(result.classification).toBe("shadow_hard_block_candidate");
  });

  describe("fail-open for live-unavailable features", () => {
    it("reports Plankton/observer as unknown and never lets them inflate the score", () => {
      const result = computeDeadMarketScore(baseInput());
      expect(result.components.planktonNotActive24h).toBe(false);
      expect(result.components.planktonNeverTouched).toBe(false);
      expect(result.components.observerDead).toBe(false);
      expect(result.unknownComponents).toContain("planktonNotActive24h");
      expect(result.unknownComponents).toContain("planktonNeverTouched");
      expect(result.unknownComponents).toContain("observerDead");
    });

    it("reports cheapTail as unknown when the selected price is missing (no live inflation)", () => {
      const result = computeDeadMarketScore(baseInput({ selectedPrice: null }));
      expect(result.components.cheapTail).toBe(false);
      expect(result.unknownComponents).toContain("cheapTail");
    });

    it("reports lowGammaLiquidity as unknown when liquidity is missing", () => {
      const result = computeDeadMarketScore(baseInput({ gammaLiquidity: null }));
      expect(result.components.lowGammaLiquidity).toBe(false);
      expect(result.unknownComponents).toContain("lowGammaLiquidity");
    });

    it("never lists a known component (sourceGroup) as unknown", () => {
      const result = computeDeadMarketScore(baseInput({ sourceGroup: "unknown" }));
      expect(result.unknownComponents).not.toContain("r23OrFallbackSource");
    });

    it("treats a non-finite price as missing rather than cheap", () => {
      const result = computeDeadMarketScore(baseInput({ selectedPrice: Number.NaN }));
      expect(result.components.cheapTail).toBe(false);
      expect(result.unknownComponents).toContain("cheapTail");
    });
  });
});

describe("classifyDeadMarketScore", () => {
  it("maps score buckets to the documented shadow classifications", () => {
    expect(classifyDeadMarketScore(0)).toBe("shadow_allow");
    expect(classifyDeadMarketScore(1)).toBe("shadow_allow");
    expect(classifyDeadMarketScore(2)).toBe("shadow_downweight_candidate");
    expect(classifyDeadMarketScore(3)).toBe("shadow_block_candidate");
    expect(classifyDeadMarketScore(4)).toBe("shadow_hard_block_candidate");
    expect(classifyDeadMarketScore(5)).toBe("shadow_hard_block_candidate");
    expect(classifyDeadMarketScore(6)).toBe("shadow_hard_block_candidate");
  });
});

describe("deriveSourceGroup", () => {
  it("maps known BUY decision rule ids to bounded source groups", () => {
    expect(deriveSourceGroup("R23_DIP_TRIGGER")).toBe("r23");
    expect(deriveSourceGroup("FALLBACK")).toBe("fallback");
    expect(deriveSourceGroup("EXECUTION_PROFILE_SCALE_IN")).toBe("scale_in");
    expect(deriveSourceGroup("S1_LADDER")).toBe("ladder");
    expect(deriveSourceGroup("D1")).toBe("d1_d3");
    expect(deriveSourceGroup("D3")).toBe("d1_d3");
  });

  it("returns unknown for a missing rule id and other for an unrecognized one", () => {
    expect(deriveSourceGroup(null)).toBe("unknown");
    expect(deriveSourceGroup(undefined)).toBe("unknown");
    expect(deriveSourceGroup("SOMETHING_ELSE")).toBe("other");
  });
});

describe("deriveDecisionType", () => {
  it("maps probe-entry to entry", () => {
    expect(deriveDecisionType(SignalReason.ProbeEntry)).toBe("entry");
  });

  it("maps every scale reason (confirm/scale-in/heavy) to add", () => {
    expect(deriveDecisionType(SignalReason.ConfirmScale)).toBe("add");
    expect(deriveDecisionType(SignalReason.ScaleIn)).toBe("add");
    expect(deriveDecisionType(SignalReason.HeavyScale)).toBe("add");
  });

  it("maps unknown / nonstandard / missing reasons to unknown", () => {
    expect(deriveDecisionType(SignalReason.Operator)).toBe("unknown");
    expect(deriveDecisionType("nonstandard-reason")).toBe("unknown");
    expect(deriveDecisionType(null)).toBe("unknown");
    expect(deriveDecisionType(undefined)).toBe("unknown");
  });
});
