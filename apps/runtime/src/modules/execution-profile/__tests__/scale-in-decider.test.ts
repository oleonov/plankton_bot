import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXECUTION_PROFILE_POLICY, type ScaleInInput } from "@krabs/domain";

import { decideScaleIn } from "../scale-in-decider.js";
import { validateExecutionProfileLabels } from "../execution-profile-metrics.js";

const baseConfig = {
  enabled: true,
  profiles: DEFAULT_EXECUTION_PROFILE_POLICY.profiles,
};

function input(overrides: Partial<ScaleInInput> = {}): ScaleInInput {
  return {
    profile: "cheap",
    currentCostUsd: 8,
    avgEntryPrice: 0.1,
    currentMarkPrice: 0.106,
    timeSinceLastBuyMs: 60_000,
    marketSignals: {
      recovery60: 0,
      range60: 0,
      std60: 0,
      tradeCount3h: 0,
      notional3h: 0,
    },
    previousAddCount: 0,
    initialProbeSizeUsd: 0.6,
    ...overrides,
  };
}

describe("decideScaleIn", () => {
  it("is pure and does not call the clock", () => {
    const now = vi.spyOn(Date, "now");

    decideScaleIn(input(), baseConfig);

    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("short-circuits disabled config before validating inputs", () => {
    const decision = decideScaleIn(input({ avgEntryPrice: Number.NaN, timeSinceLastBuyMs: -1 }), {
      ...baseConfig,
      enabled: false,
    });

    expect(decision).toMatchObject({ action: "skip", reason: "scale_in_disabled" });
  });

  it("fails closed on invalid inputs", () => {
    expect(decideScaleIn(input({ avgEntryPrice: 0 }), baseConfig)).toMatchObject({
      action: "skip",
      reason: "invalid_inputs",
    });
    expect(decideScaleIn(input({ currentMarkPrice: Number.NaN }), baseConfig)).toMatchObject({
      action: "skip",
      reason: "invalid_inputs",
    });
  });

  it("blocks inside the per-profile time gate", () => {
    expect(decideScaleIn(input({ timeSinceLastBuyMs: 47_999 }), baseConfig)).toMatchObject({
      action: "skip",
      reason: "time_gate_blocked",
    });
    expect(decideScaleIn(input({ timeSinceLastBuyMs: 48_000 }), baseConfig).reason).toBe("allowed");
  });

  it("allows UP mode without rolling signals", () => {
    const decision = decideScaleIn(input({ currentMarkPrice: 0.106 }), baseConfig);

    expect(decision).toMatchObject({
      action: "add",
      reason: "allowed",
      mode: "up",
      proposedAddSizeUsd: 0.6,
      sizingMultiplier: 1,
    });
  });

  it("requires activity or volatility in FLAT mode", () => {
    expect(decideScaleIn(input({ currentMarkPrice: 0.1 }), baseConfig)).toMatchObject({
      action: "skip",
      reason: "flat_no_trigger",
      mode: "flat",
    });
    expect(
      decideScaleIn(
        input({
          currentMarkPrice: 0.1,
          marketSignals: { ...input().marketSignals, tradeCount3h: 40 },
        }),
        baseConfig,
      ),
    ).toMatchObject({ action: "add", mode: "flat", reason: "allowed" });
  });

  it("requires recovery for AVG_DOWN by default", () => {
    expect(
      decideScaleIn(
        input({ currentMarkPrice: 0.094, marketSignals: input().marketSignals }),
        baseConfig,
      ),
    ).toMatchObject({
      action: "skip",
      reason: "avg_down_no_recovery",
      mode: "avg_down",
    });
    expect(
      decideScaleIn(
        input({
          currentMarkPrice: 0.094,
          marketSignals: { ...input().marketSignals, recovery60: 0.079 },
        }),
        baseConfig,
      ),
    ).toMatchObject({ action: "skip", reason: "avg_down_no_recovery" });
    expect(
      decideScaleIn(
        input({
          currentMarkPrice: 0.094,
          marketSignals: { ...input().marketSignals, recovery60: 0.08 },
        }),
        baseConfig,
      ),
    ).toMatchObject({ action: "add", reason: "allowed", mode: "avg_down" });
  });

  it("applies sizing decay and min add guard", () => {
    expect(decideScaleIn(input({ previousAddCount: 0 }), baseConfig)).toMatchObject({
      proposedAddSizeUsd: 0.6,
      sizingMultiplier: 1,
    });
    expect(decideScaleIn(input({ previousAddCount: 1 }), baseConfig)).toMatchObject({
      proposedAddSizeUsd: 0.42,
      sizingMultiplier: 0.7,
    });
    expect(decideScaleIn(input({ previousAddCount: 10 }), baseConfig)).toMatchObject({
      proposedAddSizeUsd: 0.21,
      sizingMultiplier: 0.35,
    });
    expect(
      decideScaleIn(input({ initialProbeSizeUsd: 0.1, previousAddCount: 10 }), baseConfig),
    ).toMatchObject({
      action: "skip",
      reason: "below_min_add",
      sizingMultiplier: 0.35,
    });
  });

  it("computes triggers independently without notional gating", () => {
    const activity = decideScaleIn(
      input({ marketSignals: { ...input().marketSignals, tradeCount3h: 40, notional3h: 0 } }),
      baseConfig,
    );
    const range = decideScaleIn(
      input({ marketSignals: { ...input().marketSignals, range60: 0.1 } }),
      baseConfig,
    );
    const std = decideScaleIn(
      input({ marketSignals: { ...input().marketSignals, std60: 0.02 } }),
      baseConfig,
    );

    expect(activity.triggerSignals).toMatchObject({ activity: true, notional3h: 0 });
    expect(range.triggerSignals).toMatchObject({ volatility: true, range60Above: true });
    expect(std.triggerSignals).toMatchObject({ volatility: true, std60Above: true });
  });

  it("populates CostCapSignalContext with confirmation and J.6 strong override", () => {
    expect(
      decideScaleIn(
        input({ marketSignals: { ...input().marketSignals, notional3h: 100_000 } }),
        baseConfig,
      ).costCapContext.hasConfirmationSignal,
    ).toBe(false);
    expect(
      decideScaleIn(
        input({ marketSignals: { ...input().marketSignals, range60: 0.1 } }),
        baseConfig,
      ).costCapContext.hasConfirmationSignal,
    ).toBe(true);
    expect(
      decideScaleIn(
        input({ marketSignals: { ...input().marketSignals, recovery60: 0.1 } }),
        baseConfig,
      ).costCapContext.hasStrongOverrideSignal,
    ).toBe(true);
    expect(
      decideScaleIn(
        input({ marketSignals: { ...input().marketSignals, recovery60: 0.06, tradeCount3h: 80 } }),
        baseConfig,
      ).costCapContext.hasStrongOverrideSignal,
    ).toBe(true);
    expect(
      decideScaleIn(
        input({ marketSignals: { ...input().marketSignals, recovery60: 0, tradeCount3h: 80 } }),
        baseConfig,
      ).costCapContext.hasStrongOverrideSignal,
    ).toBe(false);
  });
});

// avgEntryPrice: 0.1, avgDown threshold: 5% → avg_down when mark < 0.095
const AVG_DOWN_MARK = 0.094;
const FLOOR_ABOVE_MARK = 0.1; // floor > mark → guard fires (0.094 < 0.10)
const FLOOR_AT_MARK = 0.094; // floor === mark → not blocked (strict <)
const FLOOR_BELOW_MARK = 0.02; // floor < mark → not blocked (0.094 > 0.02)

describe("decideScaleIn — Phase 4 avg_down_collapsed_tail guard", () => {
  it("blocks a maker-tagged avg_down position when mark is below collapseFloorPrice", () => {
    const decision = decideScaleIn(
      input({
        currentMarkPrice: AVG_DOWN_MARK,
        entryStyle: "maker",
        collapseFloorPrice: FLOOR_ABOVE_MARK,
      }),
      baseConfig,
    );
    expect(decision).toMatchObject({
      action: "skip",
      reason: "avg_down_collapsed_tail",
      mode: "avg_down",
    });
  });

  it("does NOT block when mark equals collapseFloorPrice (strict < boundary)", () => {
    const decision = decideScaleIn(
      input({
        currentMarkPrice: AVG_DOWN_MARK,
        entryStyle: "maker",
        collapseFloorPrice: FLOOR_AT_MARK,
      }),
      baseConfig,
    );
    expect(decision.reason).not.toBe("avg_down_collapsed_tail");
  });

  it("does NOT block a maker position when mark is above collapseFloorPrice", () => {
    const decision = decideScaleIn(
      input({
        currentMarkPrice: AVG_DOWN_MARK,
        entryStyle: "maker",
        collapseFloorPrice: FLOOR_BELOW_MARK,
        marketSignals: { ...input().marketSignals, recovery60: 0.08 },
      }),
      baseConfig,
    );
    expect(decision.reason).not.toBe("avg_down_collapsed_tail");
  });

  it("does NOT block a probe-tagged position even when mark is below floor", () => {
    const decision = decideScaleIn(
      input({
        currentMarkPrice: AVG_DOWN_MARK,
        entryStyle: "probe",
        collapseFloorPrice: FLOOR_ABOVE_MARK,
      }),
      baseConfig,
    );
    expect(decision.reason).not.toBe("avg_down_collapsed_tail");
  });

  it("does NOT block a null-entryStyle position even when mark is below floor", () => {
    const decision = decideScaleIn(
      input({
        currentMarkPrice: AVG_DOWN_MARK,
        entryStyle: null,
        collapseFloorPrice: FLOOR_ABOVE_MARK,
      }),
      baseConfig,
    );
    expect(decision.reason).not.toBe("avg_down_collapsed_tail");
  });

  it("is a no-op when collapseFloorPrice is null (regression: floor-null paths byte-identical)", () => {
    const withFloorNull = decideScaleIn(
      input({ currentMarkPrice: AVG_DOWN_MARK, entryStyle: "maker", collapseFloorPrice: null }),
      baseConfig,
    );
    const withNoProvenance = decideScaleIn(input({ currentMarkPrice: AVG_DOWN_MARK }), baseConfig);
    // Neither should be blocked by the collapse guard; both should match the pre-guard behavior
    expect(withFloorNull.reason).not.toBe("avg_down_collapsed_tail");
    expect(withNoProvenance.reason).not.toBe("avg_down_collapsed_tail");
    // Both take the same code path (avg_down_no_recovery by default)
    expect(withFloorNull.reason).toBe(withNoProvenance.reason);
  });

  it("is a no-op for non-avg_down modes even for maker-tagged positions with a floor set", () => {
    // UP mode — mark above entry
    const up = decideScaleIn(
      input({ currentMarkPrice: 0.106, entryStyle: "maker", collapseFloorPrice: 0.05 }),
      baseConfig,
    );
    expect(up.reason).not.toBe("avg_down_collapsed_tail");
    expect(up.mode).toBe("up");
  });

  it("metric allowlist accepts avg_down_collapsed_tail as a reason label", () => {
    expect(() =>
      validateExecutionProfileLabels("test_metric", { reason: "avg_down_collapsed_tail" }),
    ).not.toThrow();
  });
});
