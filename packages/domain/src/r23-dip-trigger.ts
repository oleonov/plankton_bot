import type { AlgoState } from "./algo-engine.js";
import type { R23DipTriggerPolicy } from "./types.js";

export const R23_DIP_TRIGGER_RULE_ID = "R23_DIP_TRIGGER";
export const R23_DIP_FIRED_REASON = "r23-dip-fired";
export const R23_DISABLED_REASON = "r23-disabled";
export const R23_EXISTING_POSITION_REASON = "r23-existing-position";
export const R23_INVALID_PRICE_REASON = "r23-invalid-price";
export const R23_NO_HISTORY_REASON = "r23-no-history";
export const R23_NO_DIP_REASON = "r23-no-dip";

export interface R23DipTriggerContext {
  state: AlgoState;
  currentMidpoint: number;
  maxMidpointInWindow: number | null;
}

export interface R23DipTriggerResult {
  fire: boolean;
  reason: string;
  ratio: number | null;
  maxMidpoint: number | null;
}

/**
 * R23 first-entry dip trigger.
 *
 * Formula: fire for state OTHER when
 * current_midpoint / max(midpoint_last_24h) <= dropThresholdRatio.
 *
 * Default threshold 0.683 = 1 - 0.317, from R23 dip-trigger evidence
 * referenced by ADR-033. The boundary is inclusive so the exact calibrated
 * point is actionable.
 */
export function evaluateR23DipTrigger(
  ctx: R23DipTriggerContext,
  policy: R23DipTriggerPolicy,
): R23DipTriggerResult {
  if (!policy.enabled) {
    return { fire: false, reason: R23_DISABLED_REASON, ratio: null, maxMidpoint: null };
  }
  if (ctx.state !== "OTHER") {
    return {
      fire: false,
      reason: R23_EXISTING_POSITION_REASON,
      ratio: null,
      maxMidpoint: null,
    };
  }
  if (!Number.isFinite(ctx.currentMidpoint) || ctx.currentMidpoint <= 0) {
    return {
      fire: false,
      reason: R23_INVALID_PRICE_REASON,
      ratio: null,
      maxMidpoint: null,
    };
  }
  const maxMidpoint = ctx.maxMidpointInWindow;
  if (maxMidpoint == null || !Number.isFinite(maxMidpoint) || maxMidpoint <= 0) {
    return { fire: false, reason: R23_NO_HISTORY_REASON, ratio: null, maxMidpoint: null };
  }
  const ratio = ctx.currentMidpoint / maxMidpoint;
  if (ratio <= policy.dropThresholdRatio) {
    return { fire: true, reason: R23_DIP_FIRED_REASON, ratio, maxMidpoint };
  }
  return { fire: false, reason: R23_NO_DIP_REASON, ratio, maxMidpoint };
}
