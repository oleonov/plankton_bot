import type { HarvestingGuardPolicy } from "./types.js";

export type PostSellBuybackGuardReason =
  | "below_last_sell"
  | "within_allowed_ratio"
  | "outside_window"
  | "strong_override"
  | "missing_last_sell_context"
  | "policy_disabled"
  | "above_last_sell_suppressed";

export type PostSellBuybackOverrideStatus = "n/a" | "fired" | "failed_closed" | "below_thresholds";

export type PostSellBuybackOverrideReason = "recovery60" | "range60" | "std60" | null;

export interface PostSellBuybackGuardSignals {
  recovery60: number | null;
  range60: number | null;
  std60: number | null;
  usable: boolean;
}

export interface PostSellBuybackGuardInput {
  buyPrice: number | null;
  lastSellPrice: number | null;
  lastSellAtMs: number | null;
  nowMs: number;
  signals: PostSellBuybackGuardSignals;
}

export interface PostSellBuybackGuardDecision {
  action: "allow" | "block";
  reason: PostSellBuybackGuardReason;
  ratio: number | null;
  overrideStatus: PostSellBuybackOverrideStatus;
  overrideReason: PostSellBuybackOverrideReason;
}

export function evaluatePostSellBuybackGuard(
  input: PostSellBuybackGuardInput,
  policy: HarvestingGuardPolicy,
): PostSellBuybackGuardDecision {
  if (!policy.enabled) {
    return allow("policy_disabled", null, "n/a", null);
  }
  if (
    !isFinitePositive(input.buyPrice) ||
    !isFinitePositive(input.lastSellPrice) ||
    typeof input.lastSellAtMs !== "number" ||
    !Number.isFinite(input.lastSellAtMs)
  ) {
    return allow("missing_last_sell_context", null, "n/a", null);
  }

  const buyPrice = input.buyPrice;
  const lastSellPrice = input.lastSellPrice;
  const lastSellAtMs = input.lastSellAtMs;
  const ratio = buyPrice / lastSellPrice;
  if (buyPrice <= lastSellPrice) {
    return allow("below_last_sell", ratio, "n/a", null);
  }
  if (buyPrice <= policy.maxBuyVsLastSellRatio * lastSellPrice) {
    return allow("within_allowed_ratio", ratio, "n/a", null);
  }
  if (input.nowMs - lastSellAtMs > policy.windowMs) {
    return allow("outside_window", ratio, "n/a", null);
  }

  const overrideReason = resolveOverrideReason(input.signals, policy);
  if (overrideReason != null) {
    return allow("strong_override", ratio, "fired", overrideReason);
  }
  return {
    action: "block",
    reason: "above_last_sell_suppressed",
    ratio,
    overrideStatus: input.signals.usable ? "below_thresholds" : "failed_closed",
    overrideReason: null,
  };
}

function resolveOverrideReason(
  signals: PostSellBuybackGuardSignals,
  policy: HarvestingGuardPolicy,
): Exclude<PostSellBuybackOverrideReason, null> | null {
  if (!signals.usable) return null;
  if (isAtLeast(signals.recovery60, policy.override.recovery60Min)) return "recovery60";
  if (isAtLeast(signals.range60, policy.override.range60Min)) return "range60";
  if (isAtLeast(signals.std60, policy.override.std60Min)) return "std60";
  return null;
}

function allow(
  reason: Exclude<PostSellBuybackGuardReason, "above_last_sell_suppressed">,
  ratio: number | null,
  overrideStatus: PostSellBuybackOverrideStatus,
  overrideReason: PostSellBuybackOverrideReason,
): PostSellBuybackGuardDecision {
  return { action: "allow", reason, ratio, overrideStatus, overrideReason };
}

function isAtLeast(value: number | null, threshold: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= threshold;
}

function isFinitePositive(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
