import { describe, it, expect } from "vitest";
import { classifyMarketRegime, hasText, type StrikeClassifierInput } from "../strike-classifier.js";

// 12 real Krabs losing strike slugs (krabs_strike_deployment_data_2026-05-26.md
// Q2/Q3) — every one must classify as `strike` (spec §3.5).
const STRIKE_FIXTURES = [
  "highest-temperature-in-hong-kong-on-may-26-2026-30c",
  "highest-temperature-in-toronto-on-may-17-2026-27corhig",
  "highest-temperature-in-tokyo-on-may-18-2026-25c",
  "highest-temperature-in-chicago-on-may-18-2026-59forbel",
  "will-the-price-of-ethereum-be-between-2400-2500-on-may",
  "will-the-price-of-solana-be-between-120-130-on-may-30-",
  "will-the-price-of-ethereum-be-between-1700-1800-on-may",
  "will-bitcoin-hit-150k-by-june-30-2026",
  "will-bitcoin-reach-140000-by-december-31-2026-131-829-",
  "will-riku-dining-group-ltds-market-cap-be-less-than-90",
  "will-mrbeasts-next-video-get-between-35-and-40-million",
  "solstice-fdv-above-300m-one-day-after-launch-827-437-1",
] as const;

// 3 winning non-strike (event-outcome, no numeric threshold) → `non-strike`.
const NON_STRIKE_FIXTURES = [
  "will-zelenskyy-meet-trump-before-july",
  "will-starmer-remain-uk-prime-minister",
  "will-melania-trump-attend-state-of-the-union",
] as const;

// F6 (§3.6): every fixture carries a non-empty group-item like prod, but the
// slug is a non-strike shape — expectation is `non-strike`, proving the
// classifier ignores group-item (primary demoted).
const F6_NON_STRIKE_FIXTURES: StrikeClassifierInput[] = [
  {
    slug: "will-spain-win-the-2026-fifa-world-cup-963",
    groupItemTitle: "Spain",
    groupItemThreshold: "0",
  },
  {
    slug: "will-new-zealand-win-the-2026-fifa-world-cup-635",
    groupItemTitle: "New Zealand",
    groupItemThreshold: "21",
  },
  {
    slug: "will-max-verstappen-be-the-2026-f1-drivers-champion",
    groupItemTitle: "Max Verstappen",
    groupItemThreshold: "4",
  },
  {
    slug: "will-george-russell-be-the-2026-f1-drivers-champion",
    groupItemTitle: "George Russell",
    groupItemThreshold: "2",
  },
  {
    slug: "will-the-iran-ceasefire-continue-through-may-27-496",
    groupItemTitle: "May 27",
    groupItemThreshold: "7",
  },
  {
    slug: "will-the-fed-decrease-interest-rates-by-25-bps-after-the-june-2026-meeting",
    groupItemTitle: "25 bps decrease",
    groupItemThreshold: "1",
  },
  { slug: "eth-updown-5m-1779887400", groupItemTitle: null, groupItemThreshold: "0" },
];

describe("classifyMarketRegime", () => {
  it.each(STRIKE_FIXTURES)("classifies real losing strike slug as strike: %s", (slug) => {
    expect(classifyMarketRegime({ slug })).toBe("strike");
  });

  it.each(NON_STRIKE_FIXTURES)(
    "classifies winning event-outcome slug as non-strike: %s",
    (slug) => {
      expect(classifyMarketRegime({ slug })).toBe("non-strike");
    },
  );

  describe("borderline numeric-bracket → strike (spec §3.4)", () => {
    it("tweet-count bracket", () => {
      expect(classifyMarketRegime({ slug: "elon-musk-of-tweets-may-19-may-26-40-59" })).toBe(
        "strike",
      );
    });
    it("box-office range bracket", () => {
      expect(
        classifyMarketRegime({ slug: "will-movie-x-box-office-be-between-50-and-60-million" }),
      ).toBe("strike");
    });
    it("approval-rating bracket", () => {
      expect(
        classifyMarketRegime({ slug: "will-trump-approval-rating-be-between-40-and-45" }),
      ).toBe("strike");
    });
  });

  describe("event outcomes without a number → non-strike", () => {
    it("sports winner", () => {
      expect(classifyMarketRegime({ slug: "lakers-vs-celtics-winner" })).toBe("non-strike");
    });
    it("court ruling", () => {
      expect(classifyMarketRegime({ slug: "supreme-court-rules-on-abortion" })).toBe("non-strike");
    });
  });

  it("secondary tag signal classifies generic slug as strike", () => {
    expect(classifyMarketRegime({ slug: "generic-market-no-pattern", tags: ["weather"] })).toBe(
      "strike",
    );
  });

  it("empty signals → non-strike", () => {
    expect(classifyMarketRegime({ slug: "fed-rate-cut-yes" })).toBe("non-strike");
  });

  describe("F6 — group-item must NOT trigger strike (primary demoted, §3.6)", () => {
    it.each(F6_NON_STRIKE_FIXTURES)("non-strike despite group-item: $slug", (fixture) => {
      expect(classifyMarketRegime(fixture)).toBe("non-strike");
    });

    it("positive control: strike via slug even with group-item present", () => {
      expect(
        classifyMarketRegime({
          slug: "bitcoin-above-66k-on-may-26-2026",
          groupItemTitle: "66,000",
        }),
      ).toBe("strike");
      expect(
        classifyMarketRegime({
          slug: "elon-musk-of-tweets-may-19-may-26-40-59",
          groupItemTitle: "40-59",
        }),
      ).toBe("strike");
    });
  });

  it("tag matching is case-insensitive", () => {
    expect(classifyMarketRegime({ slug: "generic", tags: ["WEATHER"] })).toBe("strike");
  });
});

describe("hasText", () => {
  it("true for non-empty strings", () => {
    expect(hasText("x")).toBe(true);
    expect(hasText("0")).toBe(true);
  });
  it("false for empty/whitespace/non-strings", () => {
    expect(hasText("")).toBe(false);
    expect(hasText("   ")).toBe(false);
    expect(hasText(null)).toBe(false);
    expect(hasText(undefined)).toBe(false);
  });
});
