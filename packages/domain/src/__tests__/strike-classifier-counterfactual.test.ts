import { describe, it, expect } from "vitest";
import { classifyMarketRegime } from "../strike-classifier.js";
import { evaluateStrikeEntryFilter, type StrikeEntryRejectReason } from "../market-selection.js";

// Track B §9.4 — counter-factual regression fixture.
//
// Source: research_plankton/krabs_strike_deployment_data_2026-05-26.md, the
// per-slug "filter verdict" table (Q3). Every row is a real losing strike leg
// from the 60-day live-lite ledger. The counter-factual reproducer
// (krabs_strike_deployment_data_2026-05-26.py) used the same `classify` /
// `STRIKE_RULES` slug classifier this TS `classifyMarketRegime` is a 1:1 port
// of, so slug-only classification must match bit-for-bit.
//
// This test validates the D1 *formula* on the analysis inputs:
//   pass = (ttc >= 24h) AND (entry > $0.05 OR ttc >= 7d)
// using `avg_entry_price` as the `midPrice` proxy and the reported
// `time_to_close_at_entry`. (§9.4 caveat: runtime uses live `midPrice` + `now`,
// validated integrationally in §9.2 — not against these historical numbers.)
//
// Slugs are reproduced verbatim from the report, which truncates display slugs
// to 53 chars. Every fixture below keeps its strike-matching token intact past
// the truncation. The one report row that does NOT — `…-box-office-be` (the
// `box-office-be-(?:less-than|between)-\d` token is cut off) — is omitted; on
// the full slug the python classifier matches it, but the truncated form here
// would not, so including it would test a truncation artifact, not the port.

const H = 60 * 60 * 1000;
const DAY_H = 24;

interface CfFixture {
  readonly slug: string;
  readonly entry: number;
  readonly ttcHours: number;
  readonly verdict: "PASS" | "FAIL";
  /** Asserted only where the ttc is unambiguously off the 24h boundary. */
  readonly reason?: StrikeEntryRejectReason;
}

const COUNTERFACTUAL_FIXTURES: readonly CfFixture[] = [
  // ttc < 24h → strike_min_horizon
  {
    slug: "donald-trump-of-truth-social-posts-may-19-may-26-200pl",
    entry: 0.033,
    ttcHours: 4.1,
    verdict: "FAIL",
    reason: "strike_min_horizon",
  },
  {
    slug: "highest-temperature-in-hong-kong-on-may-26-2026-30c",
    entry: 0.076,
    ttcHours: 6.9,
    verdict: "FAIL",
    reason: "strike_min_horizon",
  },
  {
    slug: "highest-temperature-in-toronto-on-may-17-2026-27corhig",
    entry: 0.22,
    ttcHours: 9.4,
    verdict: "FAIL",
    reason: "strike_min_horizon",
  },
  {
    slug: "highest-temperature-in-tokyo-on-may-18-2026-25c",
    entry: 0.001,
    ttcHours: 10.4,
    verdict: "FAIL",
    reason: "strike_min_horizon",
  },
  {
    slug: "highest-temperature-in-hong-kong-on-may-18-2026-29c",
    entry: 0.049,
    ttcHours: 19.8,
    verdict: "FAIL",
    reason: "strike_min_horizon",
  },
  // ttc ≈ 24h exactly — on the boundary; assert the verdict only, not the reason.
  {
    slug: "highest-temperature-in-wellington-on-may-18-2026-11c",
    entry: 0.001,
    ttcHours: 24.0,
    verdict: "FAIL",
  },
  // ttc in [24h, 168h) AND entry ≤ $0.05 → strike_yes_tail_short_runway
  {
    slug: "highest-temperature-in-chicago-on-may-18-2026-59forbel",
    entry: 0.003,
    ttcHours: 26.8,
    verdict: "FAIL",
    reason: "strike_yes_tail_short_runway",
  },
  {
    slug: "will-riku-dining-group-ltds-market-cap-be-less-than-90",
    entry: 0.004,
    ttcHours: 36.6,
    verdict: "FAIL",
    reason: "strike_yes_tail_short_runway",
  },
  {
    slug: "highest-temperature-in-tokyo-on-may-18-2026-18corbelow",
    entry: 0.001,
    ttcHours: 2.1 * DAY_H,
    verdict: "FAIL",
    reason: "strike_yes_tail_short_runway",
  },
  {
    slug: "will-the-price-of-ethereum-be-between-2400-2500-on-may",
    entry: 0.01,
    ttcHours: 3.7 * DAY_H,
    verdict: "FAIL",
    reason: "strike_yes_tail_short_runway",
  },
  {
    slug: "will-the-price-of-solana-be-between-120-130-on-may-30-",
    entry: 0.01,
    ttcHours: 4.3 * DAY_H,
    verdict: "FAIL",
    reason: "strike_yes_tail_short_runway",
  },
  {
    slug: "will-the-price-of-ethereum-be-between-1700-1800-on-may",
    entry: 0.01,
    ttcHours: 5.6 * DAY_H,
    verdict: "FAIL",
    reason: "strike_yes_tail_short_runway",
  },
  // PASS — ttc ≥ 7d (cheap entry, long runway)
  {
    slug: "will-mrbeasts-next-video-get-between-35-and-40-million",
    entry: 0.007,
    ttcHours: 13.7 * DAY_H,
    verdict: "PASS",
  },
  {
    slug: "will-global-temperature-increase-by-between-1pt20c-and",
    entry: 0.013,
    ttcHours: 17.6 * DAY_H,
    verdict: "PASS",
  },
  {
    slug: "will-bitcoin-hit-150k-by-june-30-2026",
    entry: 0.013,
    ttcHours: 52.9 * DAY_H,
    verdict: "PASS",
  },
  {
    slug: "solstice-fdv-above-400m-one-day-after-launch-776",
    entry: 0.043,
    ttcHours: 220.4 * DAY_H,
    verdict: "PASS",
  },
  // PASS — entry > $0.05
  {
    slug: "solstice-fdv-above-300m-one-day-after-launch-827-437-1",
    entry: 0.077,
    ttcHours: 220.5 * DAY_H,
    verdict: "PASS",
  },
  {
    slug: "will-bitcoin-reach-140000-by-december-31-2026-131-829-",
    entry: 0.087,
    ttcHours: 265.8 * DAY_H,
    verdict: "PASS",
  },
  // PASS — ttc ≥ 7d
  {
    slug: "will-spacexs-market-cap-be-less-than-1pt0t-at-market-c",
    entry: 0.049,
    ttcHours: 600.7 * DAY_H,
    verdict: "PASS",
  },
  {
    slug: "yo-fdv-above-300m-one-day-after-launch-231-825",
    entry: 0.379,
    ttcHours: 602.0 * DAY_H,
    verdict: "PASS",
  },
];

const NOW = Date.parse("2026-05-26T11:55:00Z");

function endDateFor(ttcHours: number): string {
  return new Date(NOW + ttcHours * H).toISOString();
}

describe("strike classifier counter-factual regression (§9.4)", () => {
  it("classifies every counter-factual strike leg as strike (slug-only)", () => {
    for (const fx of COUNTERFACTUAL_FIXTURES) {
      // slug-only input — group-item/tags are unavailable historically (§9.4).
      expect(classifyMarketRegime({ slug: fx.slug }), fx.slug).toBe("strike");
    }
  });

  it("reproduces the per-slug PASS/FAIL verdict from the counter-factual table", () => {
    for (const fx of COUNTERFACTUAL_FIXTURES) {
      const result = evaluateStrikeEntryFilter(
        { slug: fx.slug, endDate: endDateFor(fx.ttcHours), midPrice: fx.entry },
        NOW,
      );
      expect(result.blocked, `${fx.slug} (${fx.verdict})`).toBe(fx.verdict === "FAIL");
      if (fx.reason != null) {
        expect(result.reason, fx.slug).toBe(fx.reason);
      }
    }
  });

  it("matches the analysis RETAINED/EXCLUDED split on the fixture sample", () => {
    let retained = 0;
    let excluded = 0;
    for (const fx of COUNTERFACTUAL_FIXTURES) {
      const result = evaluateStrikeEntryFilter(
        { slug: fx.slug, endDate: endDateFor(fx.ttcHours), midPrice: fx.entry },
        NOW,
      );
      if (result.blocked) excluded++;
      else retained++;
    }
    // 8 PASS (RETAINED) / 12 FAIL (EXCLUDED) across the 20-slug fixture — the
    // same direction as the position-level 32 RETAINED / 124 EXCLUDED split.
    expect({ retained, excluded }).toEqual({ retained: 8, excluded: 12 });
  });
});
