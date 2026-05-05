import { describe, expect, it } from "vitest";
import { buildFeatureRow } from "./feature-builder.js";

const SNAPSHOT_TS = Date.parse("2026-05-05T12:00:00Z");

function isoAtHorizon(hours: number): string {
  return new Date(SNAPSHOT_TS + hours * 3_600_000).toISOString();
}

function baseInput(overrides: Partial<Parameters<typeof buildFeatureRow>[0]> = {}) {
  return {
    liquidity: 1000,
    midPrice: 0.04,
    volume24hr: 500,
    endDate: isoAtHorizon(72),
    tickSize: 0.01,
    eventMarketCount: 2,
    snapshotTs: SNAPSHOT_TS,
    slug: "some-slug",
    eventSlug: "some-event",
    ...overrides,
  };
}

describe("buildFeatureRow", () => {
  it("produces all 12 numeric columns + 7 category one-hots", () => {
    const row = buildFeatureRow(baseInput({ slug: "bitcoin-100k", eventSlug: null }));
    expect(row).not.toBeNull();
    expect(row!.size).toBe(19);
    // Numeric columns
    for (const name of [
      "log_liquidity",
      "liquidity_raw",
      "min_tick_001",
      "mid_price",
      "mid_below_010",
      "mid_below_005",
      "horizon_hours",
      "log_horizon",
      "horizon_above_30d",
      "event_size",
      "volume_24h",
      "log_volume",
    ]) {
      expect(row!.has(name)).toBe(true);
    }
    // Category one-hots in HEURISTIC_CATEGORIES order
    for (const cat of ["other", "sports", "politics", "weather", "stocks", "crypto", "esports"]) {
      expect(row!.has(`category=${cat}`)).toBe(true);
    }
    // Crypto slug → category=crypto = 1, others = 0
    expect(row!.get("category=crypto")).toBe(1);
    expect(row!.get("category=other")).toBe(0);
    expect(row!.get("category=sports")).toBe(0);
  });

  it("min_tick_001 is 1.0 only when tickSize ≈ 0.001", () => {
    expect(buildFeatureRow(baseInput({ tickSize: 0.001 }))!.get("min_tick_001")).toBe(1);
    expect(buildFeatureRow(baseInput({ tickSize: 0.01 }))!.get("min_tick_001")).toBe(0);
    expect(buildFeatureRow(baseInput({ tickSize: 0.0001 }))!.get("min_tick_001")).toBe(0);
  });

  it("mid_below_005 / mid_below_010 fire at the right boundaries", () => {
    expect(buildFeatureRow(baseInput({ midPrice: 0.04 }))!.get("mid_below_005")).toBe(1);
    expect(buildFeatureRow(baseInput({ midPrice: 0.04 }))!.get("mid_below_010")).toBe(1);
    expect(buildFeatureRow(baseInput({ midPrice: 0.05 }))!.get("mid_below_005")).toBe(0);
    expect(buildFeatureRow(baseInput({ midPrice: 0.05 }))!.get("mid_below_010")).toBe(1);
    expect(buildFeatureRow(baseInput({ midPrice: 0.10 }))!.get("mid_below_010")).toBe(0);
    expect(buildFeatureRow(baseInput({ midPrice: 0.50 }))!.get("mid_below_010")).toBe(0);
  });

  it("horizon_above_30d fires above 720 hours", () => {
    expect(
      buildFeatureRow(baseInput({ endDate: isoAtHorizon(720) }))!.get("horizon_above_30d"),
    ).toBe(0);
    expect(
      buildFeatureRow(baseInput({ endDate: isoAtHorizon(721) }))!.get("horizon_above_30d"),
    ).toBe(1);
  });

  it("computes log1p on liquidity and volume", () => {
    const row = buildFeatureRow(baseInput({ liquidity: 0, volume24hr: 0 }))!;
    expect(row.get("log_liquidity")).toBe(0); // log(1) = 0
    expect(row.get("log_volume")).toBe(0);
    const row2 = buildFeatureRow(baseInput({ liquidity: 100, volume24hr: 1000 }))!;
    expect(row2.get("log_liquidity")).toBeCloseTo(Math.log(101), 12);
    expect(row2.get("log_volume")).toBeCloseTo(Math.log(1001), 12);
  });

  it("clamps negative liquidity/volume in log1p (via Math.max(0, …))", () => {
    const row = buildFeatureRow(baseInput({ liquidity: -50, volume24hr: -100 }))!;
    expect(row.get("log_liquidity")).toBe(0);
    expect(row.get("log_volume")).toBe(0);
    // raw fields are passed through unchanged
    expect(row.get("liquidity_raw")).toBe(-50);
    expect(row.get("volume_24h")).toBe(-100);
  });

  it("returns null when any required input is missing or non-finite", () => {
    expect(buildFeatureRow(baseInput({ liquidity: null }))).toBeNull();
    expect(buildFeatureRow(baseInput({ midPrice: null }))).toBeNull();
    expect(buildFeatureRow(baseInput({ volume24hr: null }))).toBeNull();
    expect(buildFeatureRow(baseInput({ tickSize: null }))).toBeNull();
    expect(buildFeatureRow(baseInput({ endDate: null }))).toBeNull();
    expect(buildFeatureRow(baseInput({ liquidity: Number.NaN }))).toBeNull();
    expect(buildFeatureRow(baseInput({ midPrice: Number.POSITIVE_INFINITY }))).toBeNull();
    expect(buildFeatureRow(baseInput({ endDate: "not-a-date" }))).toBeNull();
  });

  it("very short horizon (< 1 hour) produces a positive horizon_hours", () => {
    const row = buildFeatureRow(baseInput({ endDate: isoAtHorizon(0.25) }))!;
    expect(row.get("horizon_hours")).toBeCloseTo(0.25, 10);
    expect(row.get("log_horizon")).toBeCloseTo(Math.log(1.25), 10);
    expect(row.get("horizon_above_30d")).toBe(0);
  });

  it("very long horizon (> 30 days) trips the 30-day flag", () => {
    const row = buildFeatureRow(baseInput({ endDate: isoAtHorizon(45 * 24) }))!;
    expect(row.get("horizon_above_30d")).toBe(1);
    expect(row.get("horizon_hours")).toBeCloseTo(45 * 24, 10);
  });

  it("uses HEURISTIC_CATEGORIES order by default; custom categories override", () => {
    const def = buildFeatureRow(baseInput({ slug: "nba-mvp", eventSlug: null }))!;
    expect(def.get("category=sports")).toBe(1);
    const custom = buildFeatureRow(
      baseInput({
        slug: "nba-mvp",
        eventSlug: null,
        categories: ["sports", "other"], // only the two columns the model expects
      }),
    )!;
    expect(custom.size).toBe(12 + 2);
    expect(custom.get("category=sports")).toBe(1);
    expect(custom.get("category=other")).toBe(0);
    expect(custom.has("category=crypto")).toBe(false);
  });

  it("category falls back to 'other' when no keyword matches", () => {
    const row = buildFeatureRow(baseInput({ slug: "no-keywords", eventSlug: "" }))!;
    expect(row.get("category=other")).toBe(1);
    for (const cat of ["sports", "politics", "weather", "stocks", "crypto", "esports"]) {
      expect(row.get(`category=${cat}`)).toBe(0);
    }
  });
});
