import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadFamilyRulesYaml } from "../loader.js";
import { resolveDiscoveryEntryPolicy } from "../../../domain/src/discovery-entry-policy.js";

const PKG_ROOT = path.resolve(import.meta.dirname, "../..");
const MONOREPO_ROOT = path.resolve(PKG_ROOT, "../..");
const REAL_RULES_PATH = path.join(MONOREPO_ROOT, "config/family_rules.yaml");

describe("discovery entry policy corpus", () => {
  it("matches the current curated family entry presets", () => {
    const loaded = loadFamilyRulesYaml(REAL_RULES_PATH);
    expect(loaded.defaults.entry).not.toBeNull();
    const defaultEntryPreset = loaded.defaults.entry!;

    for (const family of loaded.families) {
      const resolved = resolveDiscoveryEntryPolicy({
        familyKey: family.identity.familyKey,
        primaryCategory: family.identity.primaryCategory,
        regime: family.identity.regime,
        horizon: family.identity.horizon,
        strategyProfile: family.identity.strategyProfile,
        slugPattern: family.identity.slugPattern,
        defaultEntryPreset,
      });

      expect({
        minEntryPrice: family.rules.entry.minEntryPrice,
        maxEntryPrice: family.rules.entry.maxEntryPrice,
        highPriceThreshold: family.rules.entry.highPriceThreshold,
        requireProvenFamilyAbovePrice: family.rules.entry.requireProvenFamilyAbovePrice,
        preferredEntryBand: family.rules.entry.preferredEntryBand,
      }).toEqual(resolved.preset);
    }
  });
});
