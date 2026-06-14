import type {
  CapDecision,
  CostCapCrossedBand,
  CostCapDecisionReason,
  CostCapInput,
  CostCapRequiredSignal,
  CostCapSeverity,
  ExecutionProfileCostCapDecisionConfig,
} from "@krabs/domain";

export function decideCostCap(
  input: CostCapInput,
  config: ExecutionProfileCostCapDecisionConfig,
): CapDecision {
  const caps = config.profiles[input.profile].costCaps;
  const proposedNotionalUsd = input.action.proposedNotionalUsd;
  const projectedCostUsd = input.currentCostUsd + proposedNotionalUsd;
  const roundedCurrentCostUsd = roundCostToCents(input.currentCostUsd);
  const roundedProjectedCostUsd = roundCostToCents(projectedCostUsd);
  const base = {
    profile: input.profile,
    currentCostUsd: input.currentCostUsd,
    roundedCurrentCostUsd,
    proposedNotionalUsd,
    projectedCostUsd,
    roundedProjectedCostUsd,
    normalCapUsd: caps.normalCapUsd,
    aggressiveCapUsd: caps.aggressiveCapUsd,
    hardCapAtAggressive: caps.hardCapAtAggressive,
    signalReasons: input.signals.signalReasons,
  };

  if (!config.enabled) {
    return {
      ...base,
      allow: true,
      severity: "under_p75",
      crossedBand: "none",
      reason: "cost_caps_disabled",
      requiredSignal: "none",
    };
  }

  if (!isValidCost(input.currentCostUsd) || !isValidCost(proposedNotionalUsd)) {
    return {
      ...base,
      allow: false,
      severity: "over_p90",
      crossedBand: "none",
      reason: "hard_cap_at_aggressive",
      requiredSignal: "none",
    };
  }

  const severity = classifySeverity(roundedProjectedCostUsd, caps);
  const crossedBand = classifyCrossedBand(roundedCurrentCostUsd, severity, caps);
  const decision = decideBySeverity({
    severity,
    hasConfirmationSignal: input.signals.hasConfirmationSignal,
    hasStrongOverrideSignal: input.signals.hasStrongOverrideSignal,
    hardCapAtAggressive: caps.hardCapAtAggressive,
  });

  return {
    ...base,
    severity,
    crossedBand,
    ...decision,
  };
}

function roundCostToCents(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

function isValidCost(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function classifySeverity(
  roundedProjectedCostUsd: number,
  caps: { normalCapUsd: number; aggressiveCapUsd: number },
): CostCapSeverity {
  if (roundedProjectedCostUsd < caps.normalCapUsd) return "under_p75";
  if (roundedProjectedCostUsd < caps.aggressiveCapUsd) return "between";
  return "over_p90";
}

function classifyCrossedBand(
  roundedCurrentCostUsd: number,
  projectedSeverity: CostCapSeverity,
  caps: { normalCapUsd: number; aggressiveCapUsd: number },
): CostCapCrossedBand {
  if (projectedSeverity === "over_p90" && roundedCurrentCostUsd < caps.aggressiveCapUsd) {
    return "aggressive";
  }
  if (projectedSeverity === "between" && roundedCurrentCostUsd < caps.normalCapUsd) {
    return "normal";
  }
  return "none";
}

function decideBySeverity(input: {
  severity: CostCapSeverity;
  hasConfirmationSignal: boolean;
  hasStrongOverrideSignal: boolean;
  hardCapAtAggressive: boolean;
}): { allow: boolean; reason: CostCapDecisionReason; requiredSignal: CostCapRequiredSignal } {
  if (input.severity === "under_p75") {
    return { allow: true, reason: "under_normal_cap", requiredSignal: "none" };
  }
  if (input.severity === "between") {
    return input.hasConfirmationSignal
      ? { allow: true, reason: "between_confirmation_present", requiredSignal: "confirmation" }
      : { allow: false, reason: "between_requires_confirmation", requiredSignal: "confirmation" };
  }
  if (input.hardCapAtAggressive) {
    return { allow: false, reason: "hard_cap_at_aggressive", requiredSignal: "none" };
  }
  return input.hasStrongOverrideSignal
    ? { allow: true, reason: "over_aggressive_strong_signal_present", requiredSignal: "strong" }
    : { allow: false, reason: "over_aggressive_requires_strong_signal", requiredSignal: "strong" };
}
