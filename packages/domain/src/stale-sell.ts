import type { TokenId } from "./ids.js";

export const STALE_SELL_PRICE_ASK_RATIO = 1.01;
export const STALE_SELL_MIN_PRICE_BRANCH_AGE_MS = 30 * 60_000;
export const STALE_SELL_REPRICE_CHAIN_COUNT_THRESHOLD = 13;
export const STALE_SELL_MIN_CHAIN_POSITION_AGE_MS = 12 * 60 * 60_000;

export type StaleSellReason = "none" | "chain" | "price_only" | "chain+price";
export type StaleSellLivenessVerdict = "live" | "dead" | "unknown";

export interface StaleSellContext {
  readonly assetId: TokenId;
  readonly sellPrice: number | null;
  readonly currentBid: number | null;
  readonly currentAsk: number | null;
  readonly sellPostedAt: number | null;
  readonly repriceChainCount24h: number | null;
  readonly sellCount: number | null;
  readonly positionAgeMs: number | null;
  readonly livenessVerdict: StaleSellLivenessVerdict;
  readonly ts: number;
}

export interface StaleVerdict {
  readonly stale: boolean;
  readonly reason: StaleSellReason;
}

export function isStaleSell(ctx: StaleSellContext): StaleVerdict {
  const priceSignal = hasPriceSignal(ctx);
  const chainSignal = hasChainSignal(ctx);

  if (priceSignal && chainSignal) return { stale: true, reason: "chain+price" };
  if (chainSignal) return { stale: true, reason: "chain" };
  if (priceSignal) return { stale: true, reason: "price_only" };
  return { stale: false, reason: "none" };
}

function hasPriceSignal(ctx: StaleSellContext): boolean {
  if (!isFinitePositive(ctx.sellPrice) || !isFinitePositive(ctx.currentAsk)) return false;
  if (!Number.isFinite(ctx.ts) || ctx.sellPostedAt == null || !Number.isFinite(ctx.sellPostedAt)) {
    return false;
  }
  const ageMs = ctx.ts - ctx.sellPostedAt;
  if (ageMs <= STALE_SELL_MIN_PRICE_BRANCH_AGE_MS) return false;
  return ctx.sellPrice / ctx.currentAsk >= STALE_SELL_PRICE_ASK_RATIO;
}

function hasChainSignal(ctx: StaleSellContext): boolean {
  if (
    ctx.repriceChainCount24h == null ||
    !Number.isFinite(ctx.repriceChainCount24h) ||
    ctx.repriceChainCount24h < STALE_SELL_REPRICE_CHAIN_COUNT_THRESHOLD
  ) {
    return false;
  }
  if (ctx.sellCount !== 0) return false;
  if (ctx.positionAgeMs == null || !Number.isFinite(ctx.positionAgeMs)) return false;
  return ctx.positionAgeMs > STALE_SELL_MIN_CHAIN_POSITION_AGE_MS;
}

function isFinitePositive(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}
