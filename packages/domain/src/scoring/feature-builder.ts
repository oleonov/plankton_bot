// Soft-ranking feature row builder (Step 3, audit doc §P1.3).
//
// TS port of the Python `build_feature_dict` (numeric features) +
// rows_to_matrix's category-one-hot logic. Returns null if any required
// numeric input is missing or non-finite — the consumer treats null as
// "skip scoring this market this tick" (audit doc §G' open Q1).
//
// Numeric-feature names mirror `NUMERIC_FEATURES` at
// `research_plankton/soft_ranking_score_analysis.py:26-39`. Category one-hot
// columns are emitted in the order of the artifact's `categories` array,
// each prefixed `category=`. The category resolver uses
// `deriveCategory(slug, eventSlug)` from `../category.ts`.

import { deriveCategory, HEURISTIC_CATEGORIES, type HeuristicCategory } from "../category.js";

export interface FeatureRowInput {
  /** Required: rolling-24h liquidity from the live pricing snapshot. */
  liquidity: number | null;
  /** Required: token mid price (or executable proxy). */
  midPrice: number | null;
  /**
   * Required: rolling-24h traded volume from Gamma (`volume24hr`).
   *
   * The model's `volume_24h` feature is rolling-24h on both training sides
   * (B9 of the audit doc). Pass the new pricing-path field, NOT the legacy
   * lifetime-volume `volume24h` field.
   */
  volume24hr: number | null;
  /** Required: market end date (ISO-8601). Drives `horizon_hours`. */
  endDate: string | null;
  /** Required: tick size. `min_tick_001` is 1.0 iff tickSize ≈ 0.001. */
  tickSize: number | null;
  /** Required: number of markets in parent Gamma event (Step 0/2 lookup). */
  eventMarketCount: number;
  /**
   * Required: pricing snapshot timestamp (unix ms). `horizon_hours` =
   * (endDateMs − snapshotTs) / 3.6e6. Mirrors the Python "negatives" path:
   * `horizon_hours = (end_ts - now_ts) / 3600.0` where `now_ts` was the
   * snapshot capture time.
   */
  snapshotTs: number;
  /** Slug + event-slug feed `deriveCategory()`. */
  slug: string;
  eventSlug: string | null;
  /**
   * Optional override of the category list. Defaults to HEURISTIC_CATEGORIES.
   * Real callers pass `model.categories` to keep one-hot column ordering in
   * lockstep with the model's coefficient ordering — the model's category
   * one-hots are at the end of `featureNames` in the same order.
   */
  categories?: readonly HeuristicCategory[];
}

const MS_PER_HOUR = 3_600_000;
const HORIZON_30D_HOURS = 30 * 24;
const TICK_001_TOLERANCE = 1e-9;

function log1pNonNegative(value: number): number {
  return Math.log(Math.max(value, 0) + 1);
}

export function buildFeatureRow(input: FeatureRowInput): Map<string, number> | null {
  const { liquidity, midPrice, volume24hr, endDate, tickSize, eventMarketCount, snapshotTs } = input;

  if (
    liquidity === null ||
    !Number.isFinite(liquidity) ||
    midPrice === null ||
    !Number.isFinite(midPrice) ||
    volume24hr === null ||
    !Number.isFinite(volume24hr) ||
    tickSize === null ||
    !Number.isFinite(tickSize) ||
    !Number.isFinite(eventMarketCount) ||
    !Number.isFinite(snapshotTs) ||
    endDate === null
  ) {
    return null;
  }
  const endDateMs = Date.parse(endDate);
  if (!Number.isFinite(endDateMs)) {
    return null;
  }
  const horizonHours = (endDateMs - snapshotTs) / MS_PER_HOUR;
  if (!Number.isFinite(horizonHours)) {
    return null;
  }

  const row = new Map<string, number>();
  row.set("log_liquidity", log1pNonNegative(liquidity));
  row.set("liquidity_raw", liquidity);
  row.set("min_tick_001", Math.abs(tickSize - 0.001) <= TICK_001_TOLERANCE ? 1 : 0);
  row.set("mid_price", midPrice);
  row.set("mid_below_010", midPrice < 0.1 ? 1 : 0);
  row.set("mid_below_005", midPrice < 0.05 ? 1 : 0);
  row.set("horizon_hours", horizonHours);
  row.set("log_horizon", log1pNonNegative(horizonHours));
  row.set("horizon_above_30d", horizonHours > HORIZON_30D_HOURS ? 1 : 0);
  row.set("event_size", eventMarketCount);
  row.set("volume_24h", volume24hr);
  row.set("log_volume", log1pNonNegative(volume24hr));

  const category = deriveCategory(input.slug, input.eventSlug);
  const categories = input.categories ?? HEURISTIC_CATEGORIES;
  for (const cat of categories) {
    row.set(`category=${cat}`, cat === category ? 1 : 0);
  }
  return row;
}
