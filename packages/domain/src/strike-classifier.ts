/**
 * Track B strike classifier — binary strike / non-strike market-structure class.
 *
 * NOTE: this is NOT the `Regime` enum (enums.ts) — that is a 9-way taxonomy
 * (threshold / price-range / weather-range / …). Track B operates on a binary
 * strike/non-strike split derived on-demand; it is intentionally NOT mapped
 * onto `Regime` (see spec §4.5).
 *
 * F6 amendment (2026-05-26, prod-verified): Gamma `groupItemTitle` /
 * `groupItemThreshold` do NOT discriminate strike vs non-strike — `groupItemTitle`
 * is present on every grouped event (team / date / candidate / bps bracket) and
 * `groupItemThreshold` is a within-event ordering index (0,1,2,…). They are
 * collected and persisted (spec §4) for a future Track C with a larger sample,
 * but the Track B classifier ignores them. Classification is therefore
 * two-level: primary = slug shape (port of the counter-factual STRIKE_RULES),
 * secondary = Gamma event tags. Slug-only matches the counter-factual basis, so
 * the D1 numbers (spec §9.4) stay valid bit-for-bit.
 */

export type StrikeClass = "strike" | "non-strike";

/** Minimal shape satisfied by both `PreEntryInput` and `NormalizedMarket` (spec §3.2). */
export interface StrikeClassifierInput {
  readonly slug: string;
  readonly question?: string | null;
  /** Collected/persisted for future Track C — NOT used by the Track B classifier (F6, §3.6). */
  readonly groupItemTitle?: string | null;
  /** Collected/persisted for future Track C — NOT used by the Track B classifier (F6, §3.6). */
  readonly groupItemThreshold?: string | null;
  readonly tags?: readonly string[] | null;
}

// Port of the counter-factual classifier
// (research_plankton/krabs_strike_deployment_data_2026-05-26.py → STRIKE_RULES)
// that produced the D1 numbers (RETAINED 32 / EXCLUDED 124). Order and form are
// kept 1:1 so the runtime classifier reproduces the counter-factual (spec §9.4,
// Appendix B). All patterns are case-insensitive — slug is lower-cased below.
const STRIKE_SLUG_PATTERNS: readonly RegExp[] = [
  /temperature-in-/,
  /between-\d/,
  /be-greater-than-\d/,
  /be-less-than-\d/,
  /be-above-\d/,
  /be-below-\d/,
  /-above-\d/,
  /-reach-\d/,
  /-dip-to-\d/,
  /-hit-(?:high-|low-)?\d/,
  /close-above-\d/,
  /market-cap-be-(?:less-than|greater-than|above|below)-?\d?/,
  /fdv-(?:above|below)-\d/,
  /precipitation/,
  /ships-transit|transits-be-less-than/,
  /earthquakes-of-magnitude|volcanic-eruptions/,
  /of-tweets-\S*\d|of-truth-social-posts-\S*\d/,
  /box-office-be-(?:less-than|between)-\d/,
  /reach-a-new-all-time-high/,
  /over-\d+m-committed/,
  /approval-rating-be-between/,
];

// Gamma event tags treated as a strike signal (draft §1.3). Tags `recurring`,
// `ipo`, `finance` are intentionally absent — they describe broader categories
// that include both strike and non-strike markets, so they are not standalone
// signals.
const STRIKE_TAGS: ReadonlySet<string> = new Set([
  "weather",
  "daily-temperature",
  "price-range",
  "threshold",
  "social-activity",
]);

/** Shared text-presence helper; also used by the Gamma mapper on `unknown` raw fields (spec §4.2a). */
export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function classifyMarketRegime(market: StrikeClassifierInput): StrikeClass {
  // Primary (Track B) — slug shape. Matches the slug-only counter-factual basis.
  const slug = market.slug.toLowerCase();
  if (STRIKE_SLUG_PATTERNS.some((re) => re.test(slug))) {
    return "strike";
  }
  // Secondary — Gamma event tags (supporting evidence).
  if (market.tags != null && market.tags.some((t) => STRIKE_TAGS.has(t.toLowerCase()))) {
    return "strike";
  }
  return "non-strike";
}
