export interface SellPriceCapSkipContext {
  /** Existing S3 carve-out: a margin-aware wide-spread taker that changed behaviour (signal-to-order.ts:1288). */
  trackS3BehaviorChanged: boolean;
  /** Track S5 P0b flag (trackR.takerCapSkip): generalize the carve-out to any covered taker. */
  takerCapSkip: boolean;
  /** Track R safetyMargin (default 0.005); the live bid must cover cap × (1 − safetyMargin). */
  safetyMargin: number;
}

/**
 * Pure decision for whether a SELL may skip the Plankton sell-price cap.
 *
 * The Plankton cap clamps resting maker SELLs down to an entry-aligned markup. For a taker that
 * executes immediately against the live bid it is inappropriate: cap-down can push the price below
 * the marketable bid and falsely block a profitable exit. Skip is only ever granted to takers; the
 * post-cap Track R invariant (resolveTakerBelowMarginBlock) remains the loss-protection.
 *
 * `pricedMode` is a plain string to keep this domain helper decoupled from the runtime OrderPricedMode.
 */
export function shouldSkipSellPriceCap(input: {
  pricedMode: string;
  bestBid: number;
  cap: number;
  context: SellPriceCapSkipContext;
}): boolean {
  const { pricedMode, bestBid, cap, context } = input;
  if (pricedMode !== "taker") return false;
  if (context.trackS3BehaviorChanged === true) return true;
  if (context.takerCapSkip && bestBid >= cap * (1 - context.safetyMargin)) return true;
  return false;
}
