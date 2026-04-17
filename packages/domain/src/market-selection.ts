const PRE_ENTRY_SLUG_PREFIXES = ["elon-musk-", "bitcoin-", "ethereum-"] as const;

/**
 * Live Pre-Entry Filter (spec v2.2 §0) — slug-prefix only.
 * INCLUDE when event_slug starts with one of elon-musk-, bitcoin-, ethereum-.
 * EXCLUDE otherwise.
 */
export function matchesPreEntryFilter(eventSlug: string | null): boolean {
  if (eventSlug == null) return false;
  return PRE_ENTRY_SLUG_PREFIXES.some((p) => eventSlug.startsWith(p));
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
