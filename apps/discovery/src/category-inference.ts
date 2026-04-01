// ─── Category inference (keyword-based, aligned with research/enrich_analysis.py) ───

const CATEGORY_RULES: Array<{ keywords: string[]; category: string }> = [
  { keywords: ["bitcoin", "btc"], category: "crypto-btc" },
  { keywords: ["ethereum", "eth"], category: "crypto-eth" },
  { keywords: ["solana", "sol"], category: "crypto-sol" },
  { keywords: ["temperature", "weather", "rain", "snow"], category: "weather" },
  {
    keywords: [
      "trump",
      "biden",
      "election",
      "president",
      "congress",
      "governor",
      "senator",
      "parliament",
      "prime-minister",
    ],
    category: "politics",
  },
  {
    keywords: ["strike", "iran", "israel", "missile", "hezbollah"],
    category: "geopolitics",
  },
  {
    keywords: [
      "nba",
      "nfl",
      "soccer",
      "mlb",
      "premier-league",
      "nhl",
      "uefa",
      "playoffs",
      "champion",
    ],
    category: "sports",
  },
  { keywords: ["xrp"], category: "crypto-xrp" },
  { keywords: ["doge", "dogecoin"], category: "crypto-doge" },
];

function containsKeyword(text: string, keyword: string): boolean {
  // Word-boundary-aware: check as a token in a hyphenated slug
  return text.includes(keyword);
}

export function inferCategory(slugs: string[], questions: string[]): string {
  const combined = [...slugs, ...questions].join(" ").toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => containsKeyword(combined, kw))) {
      return rule.category;
    }
  }
  return "other";
}

// ─── Strategy profile inference ─────────────────────────────────────────────

export function inferStrategyProfile(regime: string, cadence: string): string {
  if (regime === "threshold" && (cadence === "daily-dated" || cadence === "intraday-4h")) {
    return "inventory-recycle";
  }
  if ((regime === "succession" || regime === "geopolitics") && cadence === "ad-hoc") {
    return "event-driven";
  }
  if (regime === "directional-updown" && cadence === "intraday-4h") {
    return "scalp";
  }
  return "scalp";
}
