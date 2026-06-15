import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  type CostCapInput,
  type CostCapSignalContext,
  type ExecutionProfileCostCapDecisionConfig,
  type ExecutionProfileName,
} from "@krabs/domain";
import { describe, expect, it, vi } from "vitest";

import { decideCostCap } from "../cost-cap-enforcer.js";

const NO_SIGNALS: CostCapSignalContext = {
  hasConfirmationSignal: false,
  hasStrongOverrideSignal: false,
  signalReasons: [],
};

const CONFIRMATION_SIGNAL: CostCapSignalContext = {
  hasConfirmationSignal: true,
  hasStrongOverrideSignal: false,
  signalReasons: ["recovery60_ge_5pct"],
};

const STRONG_SIGNAL: CostCapSignalContext = {
  hasConfirmationSignal: true,
  hasStrongOverrideSignal: true,
  signalReasons: ["recovery60_ge_10pct", "volume_activity_confirmed"],
};

function config(
  overrides: Partial<ExecutionProfileCostCapDecisionConfig> = {},
): ExecutionProfileCostCapDecisionConfig {
  return {
    enabled: true,
    profiles: DEFAULT_EXECUTION_PROFILE_POLICY.profiles,
    ...overrides,
  };
}

function input(
  profile: ExecutionProfileName,
  currentCostUsd: number,
  proposedNotionalUsd: number,
  signals: CostCapSignalContext = NO_SIGNALS,
): CostCapInput {
  return {
    profile,
    currentCostUsd,
    action: {
      side: "buy",
      kind: "scale_in",
      proposedNotionalUsd,
    },
    signals,
  };
}

describe("decideCostCap", () => {
  it("is pure: no clock, no I/O dependencies, no input mutation", () => {
    const nowSpy = vi.spyOn(Date, "now");
    const request = input("cheap", 5, 3);
    const policy = config();

    const decision = decideCostCap(request, policy);

    expect(decision.allow).toBe(true);
    expect(nowSpy).not.toHaveBeenCalled();
    expect(request.action.proposedNotionalUsd).toBe(3);
    expect(Object.keys(policy)).toEqual(["enabled", "profiles"]);
    nowSpy.mockRestore();
  });

  it.each([
    ["cheap", 10.99, "under_p75"],
    ["cheap", 11, "between"],
    ["cheap", 22.99, "between"],
    ["cheap", 23, "over_p90"],
    ["cheap", 25, "over_p90"],
    ["medium", 29, "under_p75"],
    ["medium", 30, "between"],
    ["medium", 69, "between"],
    ["medium", 70, "over_p90"],
    ["medium", 80, "over_p90"],
    ["expensive", 17, "under_p75"],
    ["expensive", 18, "between"],
    ["expensive", 32, "between"],
    ["expensive", 33, "over_p90"],
    ["expensive", 40, "over_p90"],
  ] as const)("classifies %s projected cost %s as %s", (profile, projected, severity) => {
    expect(decideCostCap(input(profile, 0, projected), config()).severity).toBe(severity);
  });

  it("rounds projected cost to cents before boundary comparisons", () => {
    expect(decideCostCap(input("cheap", 0, 10.999999998), config())).toMatchObject({
      severity: "between",
      roundedProjectedCostUsd: 11,
    });
    expect(decideCostCap(input("cheap", 0, 11.000000002), config())).toMatchObject({
      severity: "between",
      roundedProjectedCostUsd: 11,
    });
    expect(decideCostCap(input("cheap", 0, 22.999999998), config())).toMatchObject({
      severity: "over_p90",
      roundedProjectedCostUsd: 23,
    });
    expect(decideCostCap(input("cheap", 0, 23.000000002), config())).toMatchObject({
      severity: "over_p90",
      roundedProjectedCostUsd: 23,
    });
  });

  it("reports projected cap crossings", () => {
    expect(decideCostCap(input("cheap", 5, 8), config())).toMatchObject({
      severity: "between",
      crossedBand: "normal",
    });
    expect(decideCostCap(input("cheap", 15, 10), config())).toMatchObject({
      severity: "over_p90",
      crossedBand: "aggressive",
    });
    expect(decideCostCap(input("cheap", 12, 5), config())).toMatchObject({
      severity: "between",
      crossedBand: "none",
    });
  });

  it("short-circuits disabled config before validation", () => {
    expect(decideCostCap(input("cheap", Number.NaN, -1), config({ enabled: false }))).toMatchObject(
      {
        allow: true,
        severity: "under_p75",
        crossedBand: "none",
        reason: "cost_caps_disabled",
        requiredSignal: "none",
      },
    );
  });

  it.each([
    ["NaN current", Number.NaN, 1],
    ["negative current", -1, 1],
    ["NaN proposed", 1, Number.NaN],
    ["negative proposed", 1, -1],
  ])("fails closed for invalid enabled inputs: %s", (_label, currentCostUsd, proposed) => {
    expect(decideCostCap(input("cheap", currentCostUsd, proposed), config())).toMatchObject({
      allow: false,
      severity: "over_p90",
      reason: "hard_cap_at_aggressive",
      requiredSignal: "none",
    });
  });

  it("allows zero proposed notional and classifies using current cost", () => {
    expect(decideCostCap(input("cheap", 10.99, 0), config())).toMatchObject({
      allow: true,
      severity: "under_p75",
      roundedProjectedCostUsd: 10.99,
    });
    expect(decideCostCap(input("cheap", 11, 0), config())).toMatchObject({
      allow: false,
      severity: "between",
      requiredSignal: "confirmation",
    });
  });

  it("applies signal requirements by severity", () => {
    expect(decideCostCap(input("cheap", 0, 10.99), config())).toMatchObject({
      allow: true,
      reason: "under_normal_cap",
      requiredSignal: "none",
    });
    expect(decideCostCap(input("cheap", 0, 12), config())).toMatchObject({
      allow: false,
      reason: "between_requires_confirmation",
      requiredSignal: "confirmation",
    });
    expect(decideCostCap(input("cheap", 0, 12, CONFIRMATION_SIGNAL), config())).toMatchObject({
      allow: true,
      reason: "between_confirmation_present",
      requiredSignal: "confirmation",
    });
    expect(
      decideCostCap(input("cheap", 0, 24, STRONG_SIGNAL), config({ profiles: hardCapProfiles() })),
    ).toMatchObject({
      allow: false,
      reason: "hard_cap_at_aggressive",
      requiredSignal: "none",
    });
    expect(decideCostCap(input("cheap", 0, 24, STRONG_SIGNAL), config())).toMatchObject({
      allow: true,
      reason: "over_aggressive_strong_signal_present",
      requiredSignal: "strong",
    });
    expect(decideCostCap(input("cheap", 0, 24), config())).toMatchObject({
      allow: false,
      reason: "over_aggressive_requires_strong_signal",
      requiredSignal: "strong",
    });
  });
});

function hardCapProfiles(): ExecutionProfileCostCapDecisionConfig["profiles"] {
  return {
    ...DEFAULT_EXECUTION_PROFILE_POLICY.profiles,
    cheap: {
      scaleIn: DEFAULT_EXECUTION_PROFILE_POLICY.profiles.cheap.scaleIn,
      costCaps: {
        ...DEFAULT_EXECUTION_PROFILE_POLICY.profiles.cheap.costCaps,
        hardCapAtAggressive: true,
      },
    },
  };
}
