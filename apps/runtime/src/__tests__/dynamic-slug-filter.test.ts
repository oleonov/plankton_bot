import { describe, it, expect } from "vitest";
import { slugPatternToRegex } from "@plankton/domain";

/**
 * Tests the dynamic slug filter pattern used in index.ts where the slugFilter
 * callback reads from rulesManager.getAllFamilies() on each call, picking up
 * families added via rules_reload without recreating the filter function.
 */

interface MinimalFamilyIdentity {
  slugPattern: string | null;
}

function makeFamilyIdentity(overrides: Partial<MinimalFamilyIdentity>): MinimalFamilyIdentity {
  return { slugPattern: null, ...overrides };
}

describe("dynamic slug filter after rules_reload", () => {
  it("picks up new families after reload without recreating filter", () => {
    // Simulate: rulesManager starts with 1 family
    const families: MinimalFamilyIdentity[] = [
      makeFamilyIdentity({ slugPattern: "bitcoin-above-*" }),
    ];
    const rulesManager = { getAllFamilies: () => families };

    // This is the dynamic filter pattern from index.ts
    const slugFilter = (slug: string) => {
      return rulesManager.getAllFamilies().some((f) => {
        if (!f.slugPattern) return false;
        try {
          return slugPatternToRegex(f.slugPattern).test(slug);
        } catch {
          return false;
        }
      });
    };

    // Initially: bitcoin-above matches, new-family does not
    expect(slugFilter("bitcoin-above-95000")).toBe(true);
    expect(slugFilter("new-family-market-1")).toBe(false);

    // Simulate rules_reload: add a new family
    families.push(makeFamilyIdentity({ slugPattern: "new-family-*" }));

    // Same filter function, but now picks up new family
    expect(slugFilter("new-family-market-1")).toBe(true);
    expect(slugFilter("bitcoin-above-95000")).toBe(true); // still works
  });

  it("returns false when no families have slug patterns", () => {
    const families: MinimalFamilyIdentity[] = [
      makeFamilyIdentity({ slugPattern: null }),
    ];
    const rulesManager = { getAllFamilies: () => families };

    const slugFilter = (slug: string) => {
      return rulesManager.getAllFamilies().some((f) => {
        if (!f.slugPattern) return false;
        try {
          return slugPatternToRegex(f.slugPattern).test(slug);
        } catch {
          return false;
        }
      });
    };

    expect(slugFilter("anything")).toBe(false);
  });

  it("handles removal of families after reload", () => {
    const families: MinimalFamilyIdentity[] = [
      makeFamilyIdentity({ slugPattern: "bitcoin-above-*" }),
      makeFamilyIdentity({ slugPattern: "eth-below-*" }),
    ];
    const rulesManager = { getAllFamilies: () => families };

    const slugFilter = (slug: string) => {
      return rulesManager.getAllFamilies().some((f) => {
        if (!f.slugPattern) return false;
        try {
          return slugPatternToRegex(f.slugPattern).test(slug);
        } catch {
          return false;
        }
      });
    };

    expect(slugFilter("eth-below-2000")).toBe(true);

    // Simulate rules_reload removing eth family
    families.splice(1, 1);

    expect(slugFilter("eth-below-2000")).toBe(false);
    expect(slugFilter("bitcoin-above-95000")).toBe(true);
  });
});
