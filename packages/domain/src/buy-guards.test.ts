import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUY_GUARDS_POLICY,
  applyStockCloseTailSizeDamp,
  evaluateD3NearDeathGuard,
} from "./index.js";

const stockMarket = {
  slug: "will-meta-meta-close-at-560-570-on-june-19",
  eventSlug: "meta-close-range",
  question: "Will Meta (META) close at $560-$570 on June 19?",
  endDate: "2026-06-19T20:00:00.000Z",
  groupItemTitle: null,
  tags: ["stocks"],
  outcome: "Yes",
};

describe("buy guards", () => {
  it("blocks D3 near-death adds inside the configured effective runway", () => {
    const decision = evaluateD3NearDeathGuard({
      policy: DEFAULT_BUY_GUARDS_POLICY.d3NearDeathGuard,
      addPrice: 0.03,
      avgEntryPrice: 0.08,
      runway: {
        effectiveRunwayHours: 72,
        marketClass: "OTHER",
        confidence: "high",
      },
    });

    expect(decision).toMatchObject({
      action: "block",
      reason: "near_death_add",
      dropVsRunningAvg: -0.625,
    });
  });

  it("allows the same near-death add when effective runway is above threshold", () => {
    const decision = evaluateD3NearDeathGuard({
      policy: DEFAULT_BUY_GUARDS_POLICY.d3NearDeathGuard,
      addPrice: 0.03,
      avgEntryPrice: 0.08,
      runway: {
        effectiveRunwayHours: 72.01,
        marketClass: "OTHER",
        confidence: "high",
      },
    });

    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("runway_above_threshold");
  });

  it("allows D3 adds when the drop from running avg is not severe", () => {
    const decision = evaluateD3NearDeathGuard({
      policy: DEFAULT_BUY_GUARDS_POLICY.d3NearDeathGuard,
      addPrice: 0.03,
      avgEntryPrice: 0.05,
      runway: {
        effectiveRunwayHours: 12,
        marketClass: "OTHER",
        confidence: "high",
      },
    });

    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("not_near_death");
  });

  it("blocks high-confidence stock-close penny adds inside the runway", () => {
    const decision = evaluateD3NearDeathGuard({
      policy: DEFAULT_BUY_GUARDS_POLICY.d3NearDeathGuard,
      addPrice: 0.01,
      avgEntryPrice: 0.012,
      runway: {
        effectiveRunwayHours: 6,
        marketClass: "US_EQUITY_CLOSE",
        confidence: "high",
      },
    });

    expect(decision.action).toBe("block");
    expect(decision.reason).toBe("stock_close_penny_add");
  });

  it("does not apply the stock-close penny block to medium-confidence runway", () => {
    const decision = evaluateD3NearDeathGuard({
      policy: DEFAULT_BUY_GUARDS_POLICY.d3NearDeathGuard,
      addPrice: 0.01,
      avgEntryPrice: 0.012,
      runway: {
        effectiveRunwayHours: 6,
        marketClass: "US_EQUITY_CLOSE",
        confidence: "medium",
      },
    });

    expect(decision.action).toBe("allow");
  });

  it("applies 0.5x size damp to high-confidence stock-close narrow YES tails", () => {
    const decision = applyStockCloseTailSizeDamp({
      policy: DEFAULT_BUY_GUARDS_POLICY.stockCloseTailSizeDamp,
      market: stockMarket,
      baseSizeUsdc: 10,
      target: "probe",
    });

    expect(decision).toMatchObject({
      action: "apply",
      confidence: "high",
      rangePct: 10 / 565,
      dampedSizeUsdc: 5,
    });
  });

  it("applies size damp to ticker-less index close-at ranges", () => {
    const decision = applyStockCloseTailSizeDamp({
      policy: DEFAULT_BUY_GUARDS_POLICY.stockCloseTailSizeDamp,
      market: {
        ...stockMarket,
        slug: "will-the-sp-500-close-at-6000-6100-on-friday",
        question: "Will the S&P 500 close at 6000-6100 on Friday?",
        tags: [],
      },
      baseSizeUsdc: 12,
      target: "probe",
    });

    expect(decision).toMatchObject({
      action: "apply",
      confidence: "high",
      dampedSizeUsdc: 6,
    });
  });

  it("does not damp broad stock-close ranges", () => {
    const decision = applyStockCloseTailSizeDamp({
      policy: DEFAULT_BUY_GUARDS_POLICY.stockCloseTailSizeDamp,
      market: {
        ...stockMarket,
        question: "Will Meta (META) close at $500-$570 on June 19?",
      },
      baseSizeUsdc: 10,
      target: "probe",
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("range_too_wide");
  });

  it("does not damp non-equity ranges", () => {
    const decision = applyStockCloseTailSizeDamp({
      policy: DEFAULT_BUY_GUARDS_POLICY.stockCloseTailSizeDamp,
      market: {
        ...stockMarket,
        slug: "bitcoin-price-between-100000-110000",
        question: "Will Bitcoin be between $100,000-$110,000?",
        tags: ["crypto"],
      },
      baseSizeUsdc: 10,
      target: "probe",
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("not_us_equity_close");
  });

  it("keeps uncertain outcomes telemetry-only", () => {
    const decision = applyStockCloseTailSizeDamp({
      policy: DEFAULT_BUY_GUARDS_POLICY.stockCloseTailSizeDamp,
      market: { ...stockMarket, outcome: "" },
      baseSizeUsdc: 10,
      target: "probe",
    });

    expect(decision.action).toBe("telemetry");
    expect(decision.dampedSizeUsdc).toBe(10);
  });

  it("does not damp probe entries when applyToProbe is disabled", () => {
    const decision = applyStockCloseTailSizeDamp({
      policy: { ...DEFAULT_BUY_GUARDS_POLICY.stockCloseTailSizeDamp, applyToProbe: false },
      market: stockMarket,
      baseSizeUsdc: 10,
      target: "probe",
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("probe_damp_disabled");
    expect(decision.dampedSizeUsdc).toBe(10);
  });

  it("does not damp scale-ins when applyToScaleIn is disabled", () => {
    const decision = applyStockCloseTailSizeDamp({
      policy: { ...DEFAULT_BUY_GUARDS_POLICY.stockCloseTailSizeDamp, applyToScaleIn: false },
      market: stockMarket,
      baseSizeUsdc: 10,
      target: "scale_in",
    });

    expect(decision.action).toBe("none");
    expect(decision.reason).toBe("scale_in_damp_disabled");
    expect(decision.dampedSizeUsdc).toBe(10);
  });
});
