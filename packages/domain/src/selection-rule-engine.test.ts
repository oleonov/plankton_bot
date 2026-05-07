import { describe, it, expect } from "vitest";
import { SelectionRuleEngine, normalizeSelectionPattern } from "./selection-rule-engine.js";
import type { SelectionRule } from "./types.js";

function rule(
  partial: Partial<SelectionRule> & Pick<SelectionRule, "ruleId" | "ruleType" | "pattern">,
): SelectionRule {
  return {
    profileId: "simulation",
    enabled: true,
    note: null,
    createdAt: "2026-04-18T00:00:00Z",
    updatedAt: "2026-04-18T00:00:00Z",
    ...partial,
  };
}

describe("SelectionRuleEngine", () => {
  it("returns no_match when rule set is empty", () => {
    const engine = new SelectionRuleEngine([]);
    const d = engine.resolve("bitcoin-price-on-2025", "bitcoin-up");
    expect(d.status).toBe("no_match");
    expect(d.winningRuleId).toBeNull();
  });

  it("ignores include_slug rules", () => {
    const engine = new SelectionRuleEngine([
      rule({ ruleId: "r1", ruleType: "include_prefix", pattern: "bitcoin-" }),
      rule({ ruleId: "r2", ruleType: "include_slug", pattern: "bitcoin-up" }),
    ]);
    const d = engine.resolve("bitcoin-price-on-2025", "bitcoin-up");
    expect(d.status).toBe("no_match");
    expect(d.winningRuleId).toBeNull();
  });

  it("exclude_slug still applies when include_slug is also present", () => {
    const engine = new SelectionRuleEngine([
      rule({ ruleId: "r1", ruleType: "include_slug", pattern: "bitcoin-up" }),
      rule({ ruleId: "r2", ruleType: "exclude_slug", pattern: "bitcoin-up" }),
    ]);
    const d = engine.resolve("bitcoin-price-on-2025", "bitcoin-up");
    expect(d.status).toBe("exclude");
    expect(d.winningRuleId).toBe("r2");
  });

  it("ignores include_prefix rules", () => {
    const engine = new SelectionRuleEngine([
      rule({ ruleId: "r1", ruleType: "include_prefix", pattern: "bitcoin-" }),
      rule({ ruleId: "r2", ruleType: "include_prefix", pattern: "bitcoin-price-" }),
    ]);
    const d = engine.resolve("bitcoin-price-on-2025", "bitcoin-up");
    expect(d.status).toBe("no_match");
    expect(d.winningRuleId).toBeNull();
  });

  it("ignores exclude_prefix rules", () => {
    const engine = new SelectionRuleEngine([
      rule({ ruleId: "r1", ruleType: "include_prefix", pattern: "bitcoin-price-" }),
      rule({ ruleId: "r2", ruleType: "exclude_prefix", pattern: "bitcoin-price-" }),
    ]);
    const d = engine.resolve("bitcoin-price-on-2025", "bitcoin-up");
    expect(d.status).toBe("no_match");
    expect(d.winningRuleId).toBeNull();
  });

  it("ignores disabled rules", () => {
    const engine = new SelectionRuleEngine([
      rule({ ruleId: "r1", ruleType: "include_prefix", pattern: "bitcoin-", enabled: false }),
    ]);
    const d = engine.resolve("bitcoin-price-on-2025", "bitcoin-up");
    expect(d.status).toBe("no_match");
  });

  it("normalizes incoming slugs (case + whitespace)", () => {
    const engine = new SelectionRuleEngine([
      rule({ ruleId: "r1", ruleType: "exclude_slug", pattern: "bitcoin-up" }),
    ]);
    const d = engine.resolve("  BITCOIN-price-on-2025  ", " Bitcoin-Up ");
    expect(d.status).toBe("exclude");
    expect(d.winningRuleId).toBe("r1");
  });

  it("null eventSlug skips prefix evaluation", () => {
    const engine = new SelectionRuleEngine([
      rule({ ruleId: "r1", ruleType: "include_prefix", pattern: "bitcoin-" }),
    ]);
    const d = engine.resolve(null, "bitcoin-up");
    expect(d.status).toBe("no_match");
  });

  it("normalizeSelectionPattern trims + lowercases", () => {
    expect(normalizeSelectionPattern("  BITCOIN- ")).toBe("bitcoin-");
  });
});
