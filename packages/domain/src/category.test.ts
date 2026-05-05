import { describe, expect, it } from "vitest";
import { deriveCategory } from "./category.js";

describe("deriveCategory", () => {
  it("returns crypto for bitcoin/ethereum/solana/xrp/doge/btc-/eth-/crypto keywords", () => {
    expect(deriveCategory("bitcoin-100k-by-eoy", null)).toBe("crypto");
    expect(deriveCategory("ethereum-merge", "eth-merge-2025")).toBe("crypto");
    expect(deriveCategory("will-solana-double", null)).toBe("crypto");
    expect(deriveCategory("xrp-rally", null)).toBe("crypto");
    expect(deriveCategory("doge-to-1", null)).toBe("crypto");
    expect(deriveCategory("btc-50k", null)).toBe("crypto");
    expect(deriveCategory("eth-3k", null)).toBe("crypto");
    expect(deriveCategory("crypto-winter-2026", null)).toBe("crypto");
  });

  it("returns sports for nba/nfl/mlb/nhl/soccer/fifa/ufc/tennis/champion/winner keywords", () => {
    expect(deriveCategory("nba-finals-mvp", null)).toBe("sports");
    expect(deriveCategory("nfl-super-bowl", null)).toBe("sports");
    expect(deriveCategory("mlb-world-series", null)).toBe("sports");
    expect(deriveCategory("nhl-stanley-cup", null)).toBe("sports");
    expect(deriveCategory("soccer-uefa", null)).toBe("sports");
    expect(deriveCategory("fifa-world-cup", null)).toBe("sports");
    expect(deriveCategory("ufc-300", null)).toBe("sports");
    expect(deriveCategory("us-open-tennis", null)).toBe("sports");
    expect(deriveCategory("league-of-legends-champion", null)).toBe("sports");
    expect(deriveCategory("oscars-best-picture-winner", null)).toBe("sports");
  });

  it("returns politics for election/president/senate/etc keywords", () => {
    expect(deriveCategory("us-election-2028", null)).toBe("politics");
    expect(deriveCategory("president-impeachment", null)).toBe("politics");
    expect(deriveCategory("senate-runoff", null)).toBe("politics");
    expect(deriveCategory("ohio-governor", null)).toBe("politics");
    expect(deriveCategory("nyc-mayor-race", null)).toBe("politics");
    expect(deriveCategory("rnc-nominee", null)).toBe("politics");
    expect(deriveCategory("trump-2028", null)).toBe("politics");
    expect(deriveCategory("biden-resignation", null)).toBe("politics");
  });

  it("returns weather for weather keywords", () => {
    expect(deriveCategory("nyc-weather-2026", null)).toBe("weather");
    expect(deriveCategory("la-temperature-january", null)).toBe("weather");
    expect(deriveCategory("rain-in-seattle-may", null)).toBe("weather");
    expect(deriveCategory("snow-in-chicago", null)).toBe("weather");
    expect(deriveCategory("hurricane-season-2026", null)).toBe("weather");
  });

  it("returns stocks for stock/nasdaq/company/market-cap/earnings keywords", () => {
    expect(deriveCategory("apple-stock-2026", null)).toBe("stocks");
    expect(deriveCategory("nasdaq-5000", null)).toBe("stocks");
    expect(deriveCategory("nvidia-company-revenue", null)).toBe("stocks");
    expect(deriveCategory("tesla-market-cap", null)).toBe("stocks");
    expect(deriveCategory("msft-earnings-q1", null)).toBe("stocks");
  });

  it("returns esports for esports/lol-/cs2/iem-/valorant keywords", () => {
    expect(deriveCategory("esports-major", null)).toBe("esports");
    expect(deriveCategory("lol-worlds-2026", null)).toBe("esports");
    expect(deriveCategory("cs2-major-2026", null)).toBe("esports");
    expect(deriveCategory("iem-katowice-2026", null)).toBe("esports");
    expect(deriveCategory("valorant-major-2026", null)).toBe("esports");
  });

  it("returns other for slugs that match no keyword", () => {
    expect(deriveCategory("totally-unrelated-thing", null)).toBe("other");
    expect(deriveCategory("a-random-prediction", "")).toBe("other");
    expect(deriveCategory("", null)).toBe("other");
  });

  it("respects keyword priority: crypto > sports > politics > weather > stocks > esports", () => {
    // crypto wins over sports when both match
    expect(deriveCategory("nba-bitcoin-prop", null)).toBe("crypto");
    // sports wins over politics
    expect(deriveCategory("nba-mvp-trump-bet", null)).toBe("sports");
    // politics wins over weather
    expect(deriveCategory("election-day-rain", null)).toBe("politics");
    // weather wins over stocks
    expect(deriveCategory("nasdaq-snow-day", null)).toBe("weather");
    // stocks wins over esports
    expect(deriveCategory("nasdaq-iem-sponsor", null)).toBe("stocks");
  });

  it("uses event slug as a search-text channel", () => {
    expect(deriveCategory("foo-bar", "bitcoin-2026")).toBe("crypto");
    expect(deriveCategory("nondescript", "world-cup-fifa")).toBe("sports");
    // null event slug treated as empty
    expect(deriveCategory("nondescript", null)).toBe("other");
  });

  it("is case-insensitive (matches Python `.lower()`)", () => {
    expect(deriveCategory("BITCOIN-2026", null)).toBe("crypto");
    expect(deriveCategory("NBA-Finals", null)).toBe("sports");
  });
});
