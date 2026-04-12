import type { FamilyRuleBundle, NormalizedMarket } from "@plankton/domain";
import {
  isGammaFallbackDustEligible,
  resolveGammaFallbackDustReferencePrice,
} from "./book-quality-policy.js";

const MAX_ABSOLUTE_ENTRY_SPREAD = 0.03;
const MAX_RELATIVE_ENTRY_SPREAD = 0.4;
const CHEAP_PRICE_FLOOR = 0.01;

export type OutcomeCandidateRejection =
  | "missing-book"
  | "gamma-fallback"
  | "outside-entry-band"
  | "spread-too-wide"
  | "relative-spread-too-wide";

export interface OutcomeCandidateScore {
  market: NormalizedMarket;
  score: number;
}

export interface OutcomeCandidateDiagnostics {
  tokenId: string;
  outcome: string;
  price: number | null;
  spread: number | null;
  relativeSpread: number | null;
  bookSource: string | null;
  score: number | null;
  rejection: OutcomeCandidateRejection | null;
}

export interface OutcomeSelection {
  tokenId: string | null;
  candidates: OutcomeCandidateDiagnostics[];
}

export interface OutcomeCandidatePolicy {
  maxEntryPrice?: number | null;
  allowGammaFallbackDust?: boolean;
  dustSuggestedSizeUsdc?: number | null;
  nowMs?: number;
  executionMinNotionalUsdc?: number | null;
}

export function rejectOutcomeCandidate(
  market: NormalizedMarket,
  bundle: FamilyRuleBundle,
  policy?: OutcomeCandidatePolicy,
): OutcomeCandidateRejection | null {
  const nowMs = policy?.nowMs ?? Date.now();
  const fallbackPrice = resolveGammaFallbackDustReferencePrice(market);
  const allowGammaFallbackDust =
    policy?.allowGammaFallbackDust === true &&
    isGammaFallbackDustEligible({
      bundle,
      market,
      nowMs,
      suggestedSizeUsdc: policy?.dustSuggestedSizeUsdc ?? null,
      executionMinNotionalUsdc: policy?.executionMinNotionalUsdc ?? null,
    });

  if (market.bookSource === "gamma-fallback" && !allowGammaFallbackDust) return "gamma-fallback";
  if (allowGammaFallbackDust) {
    if (fallbackPrice == null) return "missing-book";
    const entry = bundle.rules.entry;
    const maxEntryPrice = policy?.maxEntryPrice ?? entry.maxEntryPrice;
    if (fallbackPrice < entry.minEntryPrice || fallbackPrice > maxEntryPrice) {
      return "outside-entry-band";
    }
    return null;
  }
  if (market.midPrice === null || market.bestBid === null || market.bestAsk === null) {
    return "missing-book";
  }

  const price = market.midPrice;
  const entry = bundle.rules.entry;
  const maxEntryPrice = policy?.maxEntryPrice ?? entry.maxEntryPrice;
  if (price < entry.minEntryPrice || price > maxEntryPrice) return "outside-entry-band";

  const spread = market.spread ?? market.bestAsk - market.bestBid;
  if (!Number.isFinite(spread) || spread < 0) return "missing-book";
  if (spread > MAX_ABSOLUTE_ENTRY_SPREAD) return "spread-too-wide";

  const relativeSpread = spread / Math.max(price, CHEAP_PRICE_FLOOR);
  if (relativeSpread > MAX_RELATIVE_ENTRY_SPREAD) return "relative-spread-too-wide";

  return null;
}

export function scoreOutcomeCandidate(market: NormalizedMarket): number {
  const price = resolveGammaFallbackDustReferencePrice(market) ?? market.midPrice ?? 1;
  const spread = market.spread ?? 0;
  const relativeSpread = spread / Math.max(price, CHEAP_PRICE_FLOOR);
  const cheapnessScore = Math.log10(1 / Math.max(price, CHEAP_PRICE_FLOOR)) * 12;
  const volumeBonus = Math.log10(Math.max(market.volume24h ?? 0, 0) + 1);
  const liquidityBonus = Math.log10(Math.max(market.liquidity ?? 0, 0) + 1) * 0.5;
  const fallbackPenalty = market.bookSource === "gamma-fallback" ? 5 : 0;

  return (
    cheapnessScore +
    volumeBonus +
    liquidityBonus -
    spread * 120 -
    relativeSpread * 20 -
    fallbackPenalty
  );
}

export function selectFirstEntryOutcomeForCondition(
  markets: readonly NormalizedMarket[],
  bundle: FamilyRuleBundle,
  policy?: OutcomeCandidatePolicy,
): OutcomeSelection {
  let best: OutcomeCandidateScore | null = null;
  const candidates: OutcomeCandidateDiagnostics[] = [];
  for (const market of markets) {
    const rejection = rejectOutcomeCandidate(market, bundle, policy);
    const fallbackPrice = resolveGammaFallbackDustReferencePrice(market);
    const score = rejection ? null : scoreOutcomeCandidate(market);
    candidates.push({
      tokenId: String(market.tokenId),
      outcome: market.outcome,
      price: fallbackPrice ?? market.midPrice,
      spread: market.spread,
      relativeSpread:
        (fallbackPrice ?? market.midPrice) !== null && market.spread !== null
          ? market.spread / Math.max(fallbackPrice ?? market.midPrice ?? 0, CHEAP_PRICE_FLOOR)
          : null,
      bookSource: market.bookSource ?? null,
      score,
      rejection,
    });
    if (rejection || score === null) continue;

    if (!best || score > best.score) {
      best = { market, score };
    }
  }

  return { tokenId: best ? String(best.market.tokenId) : null, candidates };
}

export function selectFirstEntryTokenForCondition(
  markets: readonly NormalizedMarket[],
  bundle: FamilyRuleBundle,
): string | null {
  return selectFirstEntryOutcomeForCondition(markets, bundle).tokenId;
}
