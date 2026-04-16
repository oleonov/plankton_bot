const PRE_ENTRY_SLUG_PREFIXES = ["elon-musk-", "bitcoin-", "ethereum-"] as const;

/**
 * Live Pre-Entry Filter — should this token be in the eligible universe?
 * Evaluates STEP 1 (event_slug prefix) then STEP 2 (distinct_outcomes = 1).
 */
export function matchesPreEntryFilter(eventSlug: string | null, distinctOutcomes: number): boolean {
  if (eventSlug != null && PRE_ENTRY_SLUG_PREFIXES.some((p) => eventSlug.startsWith(p))) {
    return true;
  }
  if (distinctOutcomes === 1) return true;
  return false;
}

/**
 * Count distinct outcome values in a token set.
 * Used by the scanner to compute distinct_outcomes per ClobMarket
 * for the Live Pre-Entry Filter (spec section 0, STEP 2).
 */
export function countDistinctOutcomes(tokens: ReadonlyArray<{ readonly outcome: string }>): number {
  const seen = new Set<string>();
  for (const t of tokens) seen.add(t.outcome.toLowerCase());
  return seen.size;
}

/**
 * Post-Entry Continuation Filter — should the bot keep scaling into this leg?
 * Returns true for CONTINUE, false for STOP.
 */
export function evaluateContinuation(tradeCount: number, firstTradePrice: number): boolean {
  if (tradeCount >= 6) return true;
  if (firstTradePrice >= 0.05 && tradeCount >= 2) return true;
  return false;
}
