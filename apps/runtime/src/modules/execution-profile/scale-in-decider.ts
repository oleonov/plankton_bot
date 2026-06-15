import type {
  CostCapSignalContext,
  CostCapSignalReason,
  ExecutionProfileScaleInProfilePolicy,
  ScaleInConfig,
  ScaleInDecision,
  ScaleInInput,
  ScaleInMode,
  ScaleInTriggerSignals,
} from "@krabs/domain";

export const EXECUTION_PROFILE_SCALE_IN_RULE_ID = "EXECUTION_PROFILE_SCALE_IN";

export function decideScaleIn(input: ScaleInInput, config: ScaleInConfig): ScaleInDecision {
  if (!config.enabled) return skip("scale_in_disabled", baseTriggers(input), emptyCostCapContext());
  if (!isValidInput(input))
    return skip("invalid_inputs", baseTriggers(input), emptyCostCapContext());

  const profileConfig = config.profiles[input.profile].scaleIn;
  const triggerSignals = buildTriggerSignals(input, profileConfig);
  const costCapContext = buildCostCapContext(input, profileConfig);

  if (input.timeSinceLastBuyMs < profileConfig.minTimeBetweenAddsMs) {
    return skip("time_gate_blocked", triggerSignals, costCapContext);
  }

  const mode = detectMode(input, profileConfig);
  const modeBlock = resolveModeBlock(mode, triggerSignals, profileConfig);
  if (modeBlock != null) {
    return skip(modeBlock, triggerSignals, costCapContext, mode);
  }

  const sizingMultiplier = resolveSizingMultiplier(
    profileConfig.sizingDecay,
    input.previousAddCount,
  );
  const proposedAddSizeUsd = roundToCents(input.initialProbeSizeUsd * sizingMultiplier);
  if (proposedAddSizeUsd < profileConfig.minAddNotionalUsd) {
    return {
      action: "skip",
      reason: "below_min_add",
      mode,
      proposedAddSizeUsd,
      sizingMultiplier,
      triggerSignals,
      costCapContext,
    };
  }

  return {
    action: "add",
    reason: "allowed",
    mode,
    proposedAddSizeUsd,
    sizingMultiplier,
    triggerSignals,
    costCapContext,
  };
}

function isValidInput(input: ScaleInInput): boolean {
  return (
    isFiniteAtLeast(input.currentCostUsd, 0) &&
    isFiniteAtLeast(input.avgEntryPrice, Number.MIN_VALUE) &&
    isFiniteAtLeast(input.currentMarkPrice, Number.MIN_VALUE) &&
    isFiniteAtLeast(input.timeSinceLastBuyMs, 0) &&
    isFiniteAtLeast(input.previousAddCount, 0) &&
    isFiniteAtLeast(input.initialProbeSizeUsd, 0) &&
    isFiniteAtLeast(input.marketSignals.recovery60, 0) &&
    isFiniteAtLeast(input.marketSignals.range60, 0) &&
    isFiniteAtLeast(input.marketSignals.std60, 0) &&
    isFiniteAtLeast(input.marketSignals.tradeCount3h, 0) &&
    isFiniteAtLeast(input.marketSignals.notional3h, 0)
  );
}

function detectMode(
  input: ScaleInInput,
  config: ExecutionProfileScaleInProfilePolicy,
): ScaleInMode {
  if (input.currentMarkPrice > input.avgEntryPrice * (1 + config.modes.up.thresholdPct)) {
    return "up";
  }
  if (input.currentMarkPrice < input.avgEntryPrice * (1 - config.modes.avgDown.thresholdPct)) {
    return "avg_down";
  }
  return "flat";
}

function buildTriggerSignals(
  input: ScaleInInput,
  config: ExecutionProfileScaleInProfilePolicy,
): ScaleInTriggerSignals {
  const range60Above = input.marketSignals.range60 >= config.triggers.volatility.range60Threshold;
  const std60Above = input.marketSignals.std60 >= config.triggers.volatility.std60Threshold;
  return {
    activity: input.marketSignals.tradeCount3h >= config.triggers.activity.tradeCount3hThreshold,
    recovery: input.marketSignals.recovery60 >= config.triggers.recovery.threshold,
    volatility: range60Above || std60Above,
    range60Above,
    std60Above,
    notional3h: input.marketSignals.notional3h,
  };
}

function buildCostCapContext(
  input: ScaleInInput,
  config: ExecutionProfileScaleInProfilePolicy,
): CostCapSignalContext {
  const hasRecovery = input.marketSignals.recovery60 >= config.triggers.recovery.threshold;
  const hasStrongRecovery =
    input.marketSignals.recovery60 >= config.triggers.recovery.strongThreshold;
  const hasActivity =
    input.marketSignals.tradeCount3h >= config.triggers.activity.tradeCount3hThreshold;
  const hasRange = input.marketSignals.range60 >= config.triggers.volatility.range60Threshold;
  const hasStd = input.marketSignals.std60 >= config.triggers.volatility.std60Threshold;
  const signalReasons: CostCapSignalReason[] = [];
  if (hasRecovery) signalReasons.push("recovery60_ge_5pct");
  if (hasStrongRecovery) signalReasons.push("recovery60_ge_10pct");
  if (hasActivity) signalReasons.push("volume_activity_confirmed");
  return {
    hasConfirmationSignal: hasRecovery || hasActivity || hasRange || hasStd,
    hasStrongOverrideSignal:
      hasStrongRecovery ||
      (hasRecovery &&
        input.marketSignals.tradeCount3h >= config.triggers.strongActivity.tradeCount3hThreshold),
    signalReasons,
  };
}

function resolveModeBlock(
  mode: ScaleInMode,
  triggerSignals: ScaleInTriggerSignals,
  config: ExecutionProfileScaleInProfilePolicy,
): ScaleInDecision["reason"] | null {
  if (mode === "up") return null;
  if (mode === "flat")
    return triggerSignals.activity || triggerSignals.volatility ? null : "flat_no_trigger";
  if (!config.modes.avgDown.enabled) return "avg_down_disabled";
  if (config.modes.avgDown.requireRecovery && !triggerSignals.recovery) {
    return "avg_down_no_recovery";
  }
  return null;
}

function resolveSizingMultiplier(decay: readonly number[], previousAddCount: number): number {
  const idx = Math.min(Math.floor(previousAddCount), decay.length - 1);
  return decay[Math.max(0, idx)] ?? 0;
}

function skip(
  reason: ScaleInDecision["reason"],
  triggerSignals: ScaleInTriggerSignals,
  costCapContext: CostCapSignalContext,
  mode?: ScaleInMode,
): ScaleInDecision {
  const decision: ScaleInDecision = {
    action: "skip",
    reason,
    proposedAddSizeUsd: 0,
    sizingMultiplier: 0,
    triggerSignals,
    costCapContext,
  };
  if (mode != null) return { ...decision, mode };
  return decision;
}

function baseTriggers(input: ScaleInInput): ScaleInTriggerSignals {
  return {
    activity: false,
    recovery: false,
    volatility: false,
    range60Above: false,
    std60Above: false,
    notional3h: finiteOrZero(input.marketSignals.notional3h),
  };
}

function emptyCostCapContext(): CostCapSignalContext {
  return {
    hasConfirmationSignal: false,
    hasStrongOverrideSignal: false,
    signalReasons: [],
  };
}

function isFiniteAtLeast(value: number, min: number): boolean {
  return Number.isFinite(value) && value >= min;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function roundToCents(value: number): number {
  return Math.round(value * 100) / 100;
}
