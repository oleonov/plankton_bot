import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EXECUTION_PROFILE_POLICY, type ScaleInInput } from "@krabs/domain";

import { decideScaleIn } from "../scale-in-decider.js";

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
          marketSignals: { ...input().marketSignals, recovery60: 0.049 },
        }),
        baseConfig,
      ),
    ).toMatchObject({ action: "skip", reason: "avg_down_no_recovery" });
    expect(
      decideScaleIn(
        input({
          currentMarkPrice: 0.094,
          marketSignals: { ...input().marketSignals, recovery60: 0.05 },
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
      input({ marketSignals: { ...input().marketSignals, std60: 0.03 } }),
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
        input({ marketSignals: { ...input().marketSignals, recovery60: 0.05, tradeCount3h: 80 } }),
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
