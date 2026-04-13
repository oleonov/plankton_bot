import { describe, expect, it } from "vitest";
import {
  classifyFamilyEntryTier,
  resolveDiscoveryEntryPolicy,
  resolveFamilyMarketabilityTier,
  type EntryRulePreset,
} from "./discovery-entry-policy.js";

const DEFAULT_PRESET: EntryRulePreset = {
  minEntryPrice: 0.03,
  maxEntryPrice: 0.2,
  highPriceThreshold: 0.2,
  requireProvenFamilyAbovePrice: 0.2,
  preferredEntryBand: "0.03-0.20",
};

describe("resolveDiscoveryEntryPolicy", () => {
  it("classifies geopolitics candidates as aggressive", () => {
    expect(
      resolveDiscoveryEntryPolicy({
        familyKey: "us-next-strikes-iran-on",
        primaryCategory: "geopolitics",
        regime: "geopolitics",
        horizon: "ad-hoc",
        strategyProfile: "event-driven",
        slugPattern: "will-the-us-next-strike-iran-on-*",
        defaultEntryPreset: DEFAULT_PRESET,
      }),
    ).toMatchObject({
      tier: "aggressive",
      matchedBy: "structured",
      preset: {
        minEntryPrice: 0.02,
        maxEntryPrice: 0.5,
      },
    });
  });

  it("classifies crypto candidates as standard", () => {
    expect(
      resolveDiscoveryEntryPolicy({
        familyKey: "bitcoin-above",
        primaryCategory: "crypto-btc",
        regime: "threshold",
        horizon: "daily",
        strategyProfile: "scalp",
        slugPattern: "bitcoin-above-*",
        defaultEntryPreset: DEFAULT_PRESET,
      }),
    ).toMatchObject({
      tier: "standard",
      matchedBy: "structured",
      preset: {
        maxEntryPrice: 0.35,
        preferredEntryBand: "0.05-0.35",
      },
    });
  });

  it("classifies directional-updown candidates as standard even outside crypto", () => {
    expect(
      resolveDiscoveryEntryPolicy({
        familyKey: "spy-up-or-down",
        primaryCategory: "stocks",
        regime: "directional-updown",
        horizon: "deadline",
        strategyProfile: "scalp",
        slugPattern: "spy-up-or-down-*",
        defaultEntryPreset: DEFAULT_PRESET,
      }),
    ).toMatchObject({
      tier: "standard",
      matchedBy: "structured",
      reason: "structured regime match (directional-updown)",
      preset: {
        maxEntryPrice: 0.35,
        preferredEntryBand: "0.05-0.35",
      },
    });
  });

  it("uses london weather override", () => {
    expect(
      resolveDiscoveryEntryPolicy({
        familyKey: "highest-temperature-in-london",
        primaryCategory: "weather",
        regime: "price-range",
        horizon: "daily",
        strategyProfile: "scalp",
        slugPattern: "highest-temperature-in-london-*",
        defaultEntryPreset: DEFAULT_PRESET,
      }),
    ).toMatchObject({
      tier: "micro-default",
      matchedBy: "override",
      preset: {
        maxEntryPrice: 0.2,
        preferredEntryBand: "0.05-0.20",
      },
    });
  });

  it("forces micro-default when tick size is 0.001 even for aggressive-looking families", () => {
    expect(
      resolveDiscoveryEntryPolicy({
        familyKey: "elon-musk-of-tweets",
        primaryCategory: "geopolitics",
        regime: "social-activity",
        horizon: "ad-hoc",
        strategyProfile: "event-driven",
        slugPattern: "elon-musk-of-tweets*",
        tickSize: 0.001,
        defaultEntryPreset: DEFAULT_PRESET,
      }),
    ).toMatchObject({
      tier: "micro-default",
      matchedBy: "safety",
      preset: {
        maxEntryPrice: 0.2,
      },
    });
  });

  it("classifies social activity keywords as aggressive", () => {
    expect(
      resolveDiscoveryEntryPolicy({
        familyKey: "elon-musk-of-tweets",
        primaryCategory: "other",
        regime: "generic",
        horizon: "weekly-window",
        strategyProfile: "event-driven",
        slugPattern: "elon-musk-of-tweets*",
        defaultEntryPreset: DEFAULT_PRESET,
      }),
    ).toMatchObject({
      tier: "aggressive",
      matchedBy: "keyword",
    });
  });

  it("classifies macro keywords as standard", () => {
    expect(
      resolveDiscoveryEntryPolicy({
        familyKey: "march-inflation-us-annual",
        primaryCategory: "other",
        regime: "generic",
        horizon: "deadline",
        strategyProfile: "event-driven",
        slugPattern: "will-annual-inflation-increase-by-*-in-march*",
        defaultEntryPreset: DEFAULT_PRESET,
      }),
    ).toMatchObject({
      tier: "standard",
      matchedBy: "keyword",
      preset: {
        maxEntryPrice: 0.35,
      },
    });
  });

  it("falls back to the configured default preset when no rule matches", () => {
    expect(
      resolveDiscoveryEntryPolicy({
        familyKey: "unknown-family",
        primaryCategory: "other",
        regime: "generic",
        horizon: "daily",
        strategyProfile: "scalp",
        slugPattern: "unknown-family-*",
        defaultEntryPreset: DEFAULT_PRESET,
      }),
    ).toEqual({
      tier: "micro-default",
      matchedBy: "fallback",
      reason: "no override, structured rule, or keyword rule matched",
      preset: DEFAULT_PRESET,
    });
  });
});

describe("family entry tier classification", () => {
  it("reuses the same aggressive classification for marketability tiering", () => {
    const classified = classifyFamilyEntryTier({
      familyKey: "will-israel-strike-gaza-on",
      primaryCategory: "geopolitics",
      regime: "geopolitics",
      horizon: "ad-hoc",
      strategyProfile: "event-driven",
      slugPattern: "will-israel-strike-gaza-on-*",
    });

    expect(classified).toMatchObject({
      tier: "aggressive",
      matchedBy: "structured",
    });
    expect(
      resolveFamilyMarketabilityTier({
        familyKey: "will-israel-strike-gaza-on",
        primaryCategory: "geopolitics",
        regime: "geopolitics",
        horizon: "ad-hoc",
        strategyProfile: "event-driven",
        slugPattern: "will-israel-strike-gaza-on-*",
      }),
    ).toBe("core");
  });

  it("maps standard families to reduced marketability and micro families to fallback", () => {
    expect(
      resolveFamilyMarketabilityTier({
        familyKey: "bitcoin-price",
        primaryCategory: "crypto-btc",
        regime: "price-range",
        horizon: "daily",
        strategyProfile: "scalp",
        slugPattern: "bitcoin-price-*",
      }),
    ).toBe("reduced");

    expect(
      resolveFamilyMarketabilityTier({
        familyKey: "highest-temperature-in-nyc",
        primaryCategory: "weather",
        regime: "price-range",
        horizon: "daily",
        strategyProfile: "scalp",
        slugPattern: "highest-temperature-in-nyc-*",
      }),
    ).toBe("fallback");

    expect(
      resolveFamilyMarketabilityTier({
        familyKey: "elon-musk-of-tweets",
        primaryCategory: "other",
        regime: "social-activity",
        horizon: "ad-hoc",
        strategyProfile: "event-driven",
        slugPattern: "elon-musk-of-tweets-*",
        tickSize: 0.001,
      }),
    ).toBe("fallback");

    expect(
      resolveFamilyMarketabilityTier({
        familyKey: "spy-up-or-down",
        primaryCategory: "stocks",
        regime: "directional-updown",
        horizon: "deadline",
        strategyProfile: "scalp",
        slugPattern: "spy-up-or-down-*",
      }),
    ).toBe("reduced");
  });
});
