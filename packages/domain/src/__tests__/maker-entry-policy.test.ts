import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_MAKER_ENTRY,
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
} from "../execution-policy.js";

// ──────────────────────────────────���───────────────────────────────────────────
// Defaults
// ─────────────────────────────��────────────────────────────────────────────────

describe("makerEntry — defaults", () => {
  it("applies defaults when makerEntry key is absent", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.issues).toEqual([]);
    expect(result.policy.makerEntry).toEqual(DEFAULT_MAKER_ENTRY);
  });

  it("default mode is 'off'", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.makerEntry.mode).toBe("off");
  });

  it("default collapseFloorPrice is null (guard off)", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.makerEntry.collapseFloorPrice).toBeNull();
  });

  it("default whitelistConditionIds is empty array", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.makerEntry.whitelistConditionIds).toEqual([]);
  });

  it("falls back to DEFAULT_MAKER_ENTRY when makerEntry is not an object", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ makerEntry: "bad" }));
    expect(result.issues).toContain("makerEntry must be an object");
    expect(result.policy.makerEntry).toEqual(DEFAULT_MAKER_ENTRY);
  });

  it("falls back to DEFAULT_MAKER_ENTRY when makerEntry is an array", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ makerEntry: [] }));
    expect(result.issues).toContain("makerEntry must be an object");
    expect(result.policy.makerEntry).toEqual(DEFAULT_MAKER_ENTRY);
  });
});

// ─────────────────────────���────────────────────────────────────────────────────
// Mode enum
// ────────���──────────────────────────────────────────────────���──────────────────

describe("makerEntry — mode", () => {
  it.each(["off", "shadow", "micro_live"] as const)("accepts valid mode '%s'", (mode) => {
    const result = parseExecutionPolicyJson(JSON.stringify({ makerEntry: { mode } }));
    expect(result.issues).toEqual([]);
    expect(result.policy.makerEntry.mode).toBe(mode);
  });

  it("rejects unknown mode and falls back to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ makerEntry: { mode: "live" } }));
    expect(result.issues.some((i) => i.includes("makerEntry.mode"))).toBe(true);
    expect(result.policy.makerEntry.mode).toBe("off");
  });
});

// ──────────────��──────────────────────────��───────────────────────────��────────
// Bounds enforcement
// ─────────��────────────────────��───────────────────────────────────────────────

describe("makerEntry — bounds", () => {
  it("clamps bidImproveTicks below min to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ makerEntry: { bidImproveTicks: 0 } }));
    expect(result.issues.some((i) => i.includes("makerEntry.bidImproveTicks"))).toBe(true);
    expect(result.policy.makerEntry.bidImproveTicks).toBe(DEFAULT_MAKER_ENTRY.bidImproveTicks);
  });

  it("clamps bidImproveTicks above max to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { bidImproveTicks: 999 } }),
    );
    expect(result.issues.some((i) => i.includes("makerEntry.bidImproveTicks"))).toBe(true);
    expect(result.policy.makerEntry.bidImproveTicks).toBe(DEFAULT_MAKER_ENTRY.bidImproveTicks);
  });

  it("accepts bidImproveTicks=1 (min bound)", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ makerEntry: { bidImproveTicks: 1 } }));
    expect(result.policy.makerEntry.bidImproveTicks).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it("clamps harvestGainPct below min to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { harvestGainPct: 0.001 } }),
    );
    expect(result.issues.some((i) => i.includes("makerEntry.harvestGainPct"))).toBe(true);
    expect(result.policy.makerEntry.harvestGainPct).toBe(DEFAULT_MAKER_ENTRY.harvestGainPct);
  });

  it("accepts harvestGainPct=0.5 (default backtest target)", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { harvestGainPct: 0.5 } }),
    );
    expect(result.policy.makerEntry.harvestGainPct).toBe(0.5);
    expect(result.issues).toEqual([]);
  });

  it("clamps fillWaitMs below min to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ makerEntry: { fillWaitMs: 1_000 } }));
    expect(result.issues.some((i) => i.includes("makerEntry.fillWaitMs"))).toBe(true);
    expect(result.policy.makerEntry.fillWaitMs).toBe(DEFAULT_MAKER_ENTRY.fillWaitMs);
  });

  it("accepts fillWaitMs=300000 (default)", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { fillWaitMs: 300_000 } }),
    );
    expect(result.policy.makerEntry.fillWaitMs).toBe(300_000);
    expect(result.issues).toEqual([]);
  });

  it("clamps microMaxOrderUsdc below min to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { microMaxOrderUsdc: 0 } }),
    );
    expect(result.issues.some((i) => i.includes("makerEntry.microMaxOrderUsdc"))).toBe(true);
    expect(result.policy.makerEntry.microMaxOrderUsdc).toBe(DEFAULT_MAKER_ENTRY.microMaxOrderUsdc);
  });

  it("clamps microMaxOpenUsdc below min to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { microMaxOpenUsdc: 0 } }),
    );
    expect(result.issues.some((i) => i.includes("makerEntry.microMaxOpenUsdc"))).toBe(true);
    expect(result.policy.makerEntry.microMaxOpenUsdc).toBe(DEFAULT_MAKER_ENTRY.microMaxOpenUsdc);
  });
});

// ──────────────────────────��─────────────────────────────��─────────────────────
// collapseFloorPrice (nullable)
// ───────────────────────────────────────────────────────────���──────────────────

describe("makerEntry — collapseFloorPrice", () => {
  it("accepts null explicitly (guard off)", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { collapseFloorPrice: null } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.makerEntry.collapseFloorPrice).toBeNull();
  });

  it("accepts a valid floor price (operator rollout value 0.02)", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { collapseFloorPrice: 0.02 } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.makerEntry.collapseFloorPrice).toBe(0.02);
  });

  it("rejects a floor price below min and returns an issue (clamps to min)", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { collapseFloorPrice: 0.0001 } }),
    );
    expect(result.issues.some((i) => i.includes("makerEntry.collapseFloorPrice"))).toBe(true);
    // nullableClampedNumber uses (fallback ?? min) as the clamped fallback when
    // an out-of-range value is supplied; since DEFAULT is null, null ?? 0.001 = 0.001.
    expect(result.policy.makerEntry.collapseFloorPrice).toBe(0.001);
  });
});

// ──────────────────────────────────────────────────────��───────────────────────
// whitelistConditionIds
// ──────────────────────────────────────────────────────────────────────────────

describe("makerEntry — whitelistConditionIds", () => {
  it("accepts a non-empty whitelist", () => {
    const ids = ["0xabc", "0xdef"];
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { whitelistConditionIds: ids } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.makerEntry.whitelistConditionIds).toEqual(ids);
  });

  it("accepts an empty whitelist", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { whitelistConditionIds: [] } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.makerEntry.whitelistConditionIds).toEqual([]);
  });

  it("rejects non-array whitelist and falls back to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { whitelistConditionIds: "0xabc" } }),
    );
    expect(result.issues.some((i) => i.includes("makerEntry.whitelistConditionIds"))).toBe(true);
    expect(result.policy.makerEntry.whitelistConditionIds).toEqual([]);
  });

  it("rejects whitelist containing empty strings and falls back to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { whitelistConditionIds: ["0xabc", ""] } }),
    );
    expect(result.issues.some((i) => i.includes("makerEntry.whitelistConditionIds"))).toBe(true);
    expect(result.policy.makerEntry.whitelistConditionIds).toEqual([]);
  });

  it("deduplicates repeated condition IDs", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ makerEntry: { whitelistConditionIds: ["0xabc", "0xabc", "0xdef"] } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.makerEntry.whitelistConditionIds).toEqual(["0xabc", "0xdef"]);
  });
});

// ──────��───────────────────────────���────────────────────────────��──────────────
// Serialize → parse round-trip
// ────���───────────��──────────────────────────────────��──────────────────────────

describe("makerEntry — serialize ��� parse round-trip", () => {
  it("preserves all fields through round-trip", () => {
    const policy = {
      ...DEFAULT_EXECUTION_POLICY,
      makerEntry: {
        mode: "shadow" as const,
        bidImproveTicks: 2,
        harvestGainPct: 0.5,
        fillWaitMs: 600_000,
        makerMinLiquidity: 7_500,
        makerMinVol24h: 2_000,
        whitelistConditionIds: ["0xabc123", "0xdef456"],
        microMaxOrderUsdc: 25,
        microMaxOpenUsdc: 100,
        collapseFloorPrice: 0.02,
      },
    };
    const json = serializeExecutionPolicy(policy);
    const parsed = parseExecutionPolicyJson(json);
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.makerEntry).toEqual(policy.makerEntry);
  });

  it("preserves null collapseFloorPrice through round-trip", () => {
    const policy = {
      ...DEFAULT_EXECUTION_POLICY,
      makerEntry: { ...DEFAULT_MAKER_ENTRY, mode: "shadow" as const, collapseFloorPrice: null },
    };
    const json = serializeExecutionPolicy(policy);
    const parsed = parseExecutionPolicyJson(json);
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.makerEntry.collapseFloorPrice).toBeNull();
  });

  it("patching makerEntry.mode does not clobber other policy blocks", () => {
    // Simulate the deep-merge behavior: start from full default, patch one makerEntry field.
    const base = DEFAULT_EXECUTION_POLICY;
    const patched = {
      ...base,
      makerEntry: { ...base.makerEntry, mode: "shadow" as const },
    };
    const json = serializeExecutionPolicy(patched);
    const parsed = parseExecutionPolicyJson(json);
    expect(parsed.issues).toEqual([]);
    // Other blocks are untouched
    expect(parsed.policy.dustAbandonment).toEqual(base.dustAbandonment);
    expect(parsed.policy.trackAAddThrottle).toEqual(base.trackAAddThrottle);
    expect(parsed.policy.r23DipTrigger).toEqual(base.r23DipTrigger);
    // makerEntry.mode was changed
    expect(parsed.policy.makerEntry.mode).toBe("shadow");
    // Other makerEntry fields preserved from base
    expect(parsed.policy.makerEntry.collapseFloorPrice).toBeNull();
    expect(parsed.policy.makerEntry.whitelistConditionIds).toEqual([]);
  });
});
