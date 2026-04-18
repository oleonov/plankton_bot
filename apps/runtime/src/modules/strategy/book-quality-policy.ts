import type { EntryMode, NormalizedMarket, Signal } from "@plankton/domain";

const EPSILON = 1e-9;
export const DUST_TRADE_FRESHNESS_MS = 5 * 60_000;
export const DUST_GAMMA_SNAPSHOT_FRESHNESS_MS = 60_000;
export const DUST_MAX_SIZE_USDC = 0.25;

export function resolveDustSizeCapUsdc(_executionMinNotionalUsdc?: number | null): number {
  return DUST_MAX_SIZE_USDC;
}

export function hasFreshTradeActivity(
  lastTradeAt: string | null | undefined,
  nowMs: number,
  freshnessMs = DUST_TRADE_FRESHNESS_MS,
): boolean {
  if (!lastTradeAt) return false;
  const tradeMs = Date.parse(lastTradeAt);
  if (!Number.isFinite(tradeMs)) return false;
  return Math.max(0, nowMs - tradeMs) <= freshnessMs;
}

export function isGammaFallbackDustEligible(opts: {
  readonly bundle?: null | undefined;
  readonly market: Pick<
    NormalizedMarket,
    "bookSource" | "lastTradeAt" | "lastTradePrice" | "snapshotTs"
  >;
  readonly nowMs: number;
  readonly entryMode?: EntryMode | null | undefined;
  readonly signal?:
    | {
        readonly side: Signal["side"];
        readonly reason: Signal["reason"] | null;
        readonly suggestedSizeUsdc: number;
      }
    | null
    | undefined;
  readonly suggestedSizeUsdc?: number | null | undefined;
  readonly executionMinNotionalUsdc?: number | null | undefined;
}): boolean {
  if (opts.market.bookSource !== "gamma-fallback") return false;
  if (opts.market.lastTradePrice == null) return false;
  if (Math.max(0, opts.nowMs - opts.market.snapshotTs) > DUST_GAMMA_SNAPSHOT_FRESHNESS_MS) {
    return false;
  }
  if (!hasFreshTradeActivity(opts.market.lastTradeAt, opts.nowMs)) return false;
  const maxDustSizeUsdc = resolveDustSizeCapUsdc(opts.executionMinNotionalUsdc);

  const signal = opts.signal;
  if (signal) {
    return (
      signal.side === "buy" &&
      signal.reason === "spray-entry" &&
      signal.suggestedSizeUsdc <= maxDustSizeUsdc + EPSILON
    );
  }

  const inferredSizeUsdc = opts.suggestedSizeUsdc ?? null;
  if (inferredSizeUsdc == null || inferredSizeUsdc > maxDustSizeUsdc + EPSILON) return false;
  return opts.entryMode === "spray-first";
}

export function resolveGammaFallbackDustReferencePrice(
  market: Pick<NormalizedMarket, "midPrice" | "lastTradePrice" | "tickSize">,
): number | null {
  const priceCandidates = [market.midPrice, market.lastTradePrice].filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  const fallbackPrice =
    priceCandidates.length > 0
      ? Math.min(...priceCandidates)
      : (market.midPrice ?? market.lastTradePrice ?? null);
  if (fallbackPrice == null || fallbackPrice <= 0) return null;
  return roundDownToTick(fallbackPrice, market.tickSize);
}

function roundDownToTick(value: number, tickSize: number): number {
  const precision = getTickPrecision(tickSize);
  const units = Math.floor((value + EPSILON) / tickSize);
  return Number((units * tickSize).toFixed(precision));
}

function getTickPrecision(tickSize: number): number {
  const [, decimals = ""] = tickSize.toString().split(".");
  return decimals.length;
}
