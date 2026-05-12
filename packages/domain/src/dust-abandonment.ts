import type { DustAbandonmentPolicyConfig, LegState } from "./types.js";

// CHANGE B — dust abandonment with auto-recovery per R67 spec 11.5.
// When position.size < market.minOrderSize, the executor cannot submit a
// valid SELL. Without this policy algo-decision would loop forever on
// shouldSuppressSellResidualBelowMinSize. After N consecutive suppressions
// we mark the token abandoned; auto-recovery on (a) ≥50% upward price move
// (R67: 38.13%) or (b) any new BUY fill (R67: 61.85%).
//
// priceRecoveryRatio default = 1.5 (R67 "observed price move >50%", upward
// direction). NOTE: only upward direction is captured. If post-deploy data
// shows Plankton also re-engages on >=50% drops, add a `dropRecoveryRatio`
// field + second branch in shouldRecoverFromPriceMove.

export const DEFAULT_DUST_ABANDONMENT_POLICY: DustAbandonmentPolicyConfig = {
  enabled: true,
  maxConsecutiveRejects: 10,
  priceRecoveryRatio: 1.5,
};

export function isAbandoned(legState: LegState | null | undefined): boolean {
  return legState != null && legState.abandonedAtTs != null;
}

export function shouldMarkAbandoned(
  legState: LegState,
  policy: DustAbandonmentPolicyConfig,
): boolean {
  if (!policy.enabled) return false;
  if (legState.abandonedAtTs != null) return false;
  return (legState.consecutiveSellResidualRejects ?? 0) >= policy.maxConsecutiveRejects;
}

export function shouldRecoverFromPriceMove(
  legState: LegState,
  currentPrice: number,
  policy: DustAbandonmentPolicyConfig,
): boolean {
  if (!policy.enabled) return false;
  if (legState.abandonedAtTs == null) return false;
  const anchor = legState.abandonedAtPrice;
  if (anchor == null || anchor <= 0 || !Number.isFinite(anchor)) return false;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return false;
  return currentPrice / anchor >= policy.priceRecoveryRatio;
}
