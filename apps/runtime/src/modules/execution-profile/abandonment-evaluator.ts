import type {
  AbandonmentReason,
  AbandonmentEvaluatorInput,
  AbandonmentEvaluatorOutput,
  ExecutionProfileAbandonmentConfig,
} from "@krabs/domain";

export function decideAbandonment(
  input: AbandonmentEvaluatorInput,
  config: ExecutionProfileAbandonmentConfig,
): AbandonmentEvaluatorOutput {
  if (!config.enabled) return kept(input, "abandonment_disabled", null);
  const bandConfig = config.bands[input.band];
  if (bandConfig == null || !bandConfig.enabled) return kept(input, "band_disabled", null);
  const timeSinceFirstBuyMs =
    input.firstBuyAtMs == null ? null : Math.max(0, input.nowMs - input.firstBuyAtMs);

  if (
    !isFiniteNonNegative(input.costBasisUsdc) ||
    !isFiniteNonNegative(input.buyCount) ||
    !Number.isInteger(input.buyCount) ||
    !isFiniteNonNegative(input.sellCount) ||
    !Number.isInteger(input.sellCount) ||
    !isFiniteNonNegative(input.nowMs) ||
    (input.firstBuyAtMs != null && !isFiniteNonNegative(input.firstBuyAtMs))
  ) {
    return kept(input, "invalid_input", timeSinceFirstBuyMs);
  }
  if (input.state !== "PROBING" && input.state !== "ACCUMULATING") {
    return kept(input, "state_not_eligible", timeSinceFirstBuyMs);
  }
  if (input.costBasisUsdc > bandConfig.probeSizeMaxUsdc) {
    return kept(input, "cost_above_probe_max", timeSinceFirstBuyMs);
  }
  if (input.buyCount > bandConfig.maxProbeBuyCount) {
    return kept(input, "buy_count_above_probe_max", timeSinceFirstBuyMs);
  }
  if (input.sellCount > 0) return kept(input, "prior_sell", timeSinceFirstBuyMs);
  if (input.firstBuyAtMs == null) return kept(input, "first_buy_missing", null);
  if ((timeSinceFirstBuyMs ?? 0) < bandConfig.scaleInRequiredWithinMs) {
    return kept(input, "timer_not_elapsed", timeSinceFirstBuyMs);
  }
  if (input.pendingScaleIn) return kept(input, "pending_scale_in", timeSinceFirstBuyMs);
  if (input.activeProfileLadder) return kept(input, "active_profile_ladder", timeSinceFirstBuyMs);
  if (input.activeSellOrder) return kept(input, "active_sell_order", timeSinceFirstBuyMs);

  return {
    shouldAbandon: true,
    result: "abandoned",
    reason: "qualified",
    band: input.band,
    timeSinceFirstBuyMs,
  };
}

function kept(
  input: AbandonmentEvaluatorInput,
  reason: AbandonmentReason,
  timeSinceFirstBuyMs: number | null,
): AbandonmentEvaluatorOutput {
  return {
    shouldAbandon: false,
    result: "kept",
    reason,
    band: input.band,
    timeSinceFirstBuyMs,
  };
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
