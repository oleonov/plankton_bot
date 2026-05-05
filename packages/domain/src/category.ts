// Heuristic category derivation for the soft-ranking score (Step 3, audit doc §D6).
//
// Verbatim TS port of `category_from_text(slug, event_slug, raw_text)` in
// `research_plankton/soft_ranking_score_analysis.py:357-371`, with `raw_text`
// hard-wired to "" because the runtime scorer has no raw market JSON. The
// Python retrain (P0) was patched to use the same call shape, so train and
// inference share the exact same input space.
//
// The 7-label set below is the canonical heuristic category set; both the
// trained one-hot column ordering in the runtime artifact (`categories` array,
// in `apps/runtime/src/data/soft-ranking-model.v1.json`) and the runtime
// feature builder consume this list. Do not reorder without retraining.

export type HeuristicCategory =
  | "other"
  | "sports"
  | "politics"
  | "weather"
  | "stocks"
  | "crypto"
  | "esports";

export const HEURISTIC_CATEGORIES: readonly HeuristicCategory[] = [
  "other",
  "sports",
  "politics",
  "weather",
  "stocks",
  "crypto",
  "esports",
];

const CRYPTO = ["bitcoin", "ethereum", "solana", "xrp", "doge", "crypto", "btc-", "eth-"];
const SPORTS = [
  "nba",
  "nfl",
  "mlb",
  "nhl",
  "soccer",
  "fifa",
  "ufc",
  "tennis",
  "champion",
  "winner",
];
const POLITICS = [
  "election",
  "president",
  "senate",
  "governor",
  "mayor",
  "nominee",
  "trump",
  "biden",
];
const WEATHER = ["weather", "temperature", "rain", "snow", "hurricane"];
const STOCKS = ["stock", "nasdaq", "company", "market-cap", "earnings"];
const ESPORTS = ["esports", "lol-", "cs2", "iem-", "valorant"];

function anyMatch(text: string, keywords: readonly string[]): boolean {
  for (const k of keywords) {
    if (text.includes(k)) return true;
  }
  return false;
}

export function deriveCategory(slug: string, eventSlug: string | null): HeuristicCategory {
  const text = `${slug} ${eventSlug ?? ""}`.toLowerCase();
  if (anyMatch(text, CRYPTO)) return "crypto";
  if (anyMatch(text, SPORTS)) return "sports";
  if (anyMatch(text, POLITICS)) return "politics";
  if (anyMatch(text, WEATHER)) return "weather";
  if (anyMatch(text, STOCKS)) return "stocks";
  if (anyMatch(text, ESPORTS)) return "esports";
  return "other";
}
