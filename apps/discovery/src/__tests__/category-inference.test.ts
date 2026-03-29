import { describe, it, expect } from "vitest";
import { inferCategory, inferStrategyProfile } from "../category-inference.js";

describe("inferCategory", () => {
  it("detects crypto-btc from bitcoin slug", () => {
    expect(inferCategory(["bitcoin-above-95000"], [])).toBe("crypto-btc");
  });

  it("detects crypto-btc from btc keyword", () => {
    expect(inferCategory(["btc-price-today"], [])).toBe("crypto-btc");
  });

  it("detects crypto-eth from ethereum", () => {
    expect(inferCategory(["ethereum-merge"], [])).toBe("crypto-eth");
  });

  it("detects weather from temperature", () => {
    expect(inferCategory(["temperature-london"], [])).toBe("weather");
  });

  it("detects politics from trump", () => {
    expect(inferCategory([], ["Will Trump win the election?"])).toBe("politics");
  });

  it("detects geopolitics from iran", () => {
    expect(inferCategory(["us-strike-iran"], [])).toBe("geopolitics");
  });

  it("detects sports from nba", () => {
    expect(inferCategory(["nba-totals"], [])).toBe("sports");
  });

  it("returns other for unrecognized content", () => {
    expect(inferCategory(["random-market"], ["Some question"])).toBe("other");
  });

  it("matches from questions when slugs have no keywords", () => {
    expect(inferCategory(["generic-slug"], ["Bitcoin will reach 100k"])).toBe("crypto-btc");
  });
});

describe("inferStrategyProfile", () => {
  it("returns inventory-recycle for threshold + daily-dated", () => {
    expect(inferStrategyProfile("threshold", "daily-dated")).toBe("inventory-recycle");
  });

  it("returns inventory-recycle for threshold + intraday-4h", () => {
    expect(inferStrategyProfile("threshold", "intraday-4h")).toBe("inventory-recycle");
  });

  it("returns event-driven for succession + ad-hoc", () => {
    expect(inferStrategyProfile("succession", "ad-hoc")).toBe("event-driven");
  });

  it("returns event-driven for geopolitics + ad-hoc", () => {
    expect(inferStrategyProfile("geopolitics", "ad-hoc")).toBe("event-driven");
  });

  it("returns scalp for directional-updown + intraday-4h", () => {
    expect(inferStrategyProfile("directional-updown", "intraday-4h")).toBe("scalp");
  });

  it("defaults to scalp", () => {
    expect(inferStrategyProfile("generic", "ad-hoc")).toBe("scalp");
  });
});
