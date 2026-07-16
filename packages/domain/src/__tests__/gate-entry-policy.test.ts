import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_GATE_ENTRY,
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
} from "../execution-policy.js";

// ──────────────────────────────────────────────────────────────────────────────
// Defaults
// ──────────────────────────────────────────────────────────────────────────────

describe("gateEntry — defaults", () => {
  it("applies defaults when gateEntry key is absent", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.issues).toEqual([]);
    expect(result.policy.gateEntry).toEqual(DEFAULT_GATE_ENTRY);
  });

  it("default enabled is false and mode is 'off' (fail-safe)", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.gateEntry.enabled).toBe(false);
    expect(result.policy.gateEntry.mode).toBe("off");
  });

  it("default whitelistConditionIds is empty array", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.gateEntry.whitelistConditionIds).toEqual([]);
  });

  it("default research-backed params (minLifespanDays 30, minPrice 0.01, maxPrice 0.15, microMaxOrderUsdc 2)", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.gateEntry.minLifespanDays).toBe(30);
    expect(result.policy.gateEntry.minPrice).toBe(0.01);
    expect(result.policy.gateEntry.maxPrice).toBe(0.15);
    expect(result.policy.gateEntry.microMaxOrderUsdc).toBe(2);
  });

  it("falls back to DEFAULT_GATE_ENTRY when gateEntry is not an object", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: "bad" }));
    expect(result.issues).toContain("gateEntry must be an object");
    expect(result.policy.gateEntry).toEqual(DEFAULT_GATE_ENTRY);
  });

  it("falls back to DEFAULT_GATE_ENTRY when gateEntry is an array", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: [] }));
    expect(result.issues).toContain("gateEntry must be an object");
    expect(result.policy.gateEntry).toEqual(DEFAULT_GATE_ENTRY);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Mode enum
// ──────────────────────────────────────────────────────────────────────────────

describe("gateEntry — mode", () => {
  it.each(["off", "micro_live"] as const)("accepts valid mode '%s'", (mode) => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: { mode } }));
    expect(result.issues).toEqual([]);
    expect(result.policy.gateEntry.mode).toBe(mode);
  });

  it("rejects unknown mode and falls back to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: { mode: "shadow" } }));
    expect(result.issues.some((i) => i.includes("gateEntry.mode"))).toBe(true);
    expect(result.policy.gateEntry.mode).toBe("off");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// enabled
// ──────────────────────────────────────────────────────────────────────────────

describe("gateEntry — enabled", () => {
  it("accepts enabled=true", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: { enabled: true } }));
    expect(result.issues).toEqual([]);
    expect(result.policy.gateEntry.enabled).toBe(true);
  });

  it("rejects non-boolean enabled and falls back to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: { enabled: "yes" } }));
    expect(result.issues.some((i) => i.includes("gateEntry.enabled"))).toBe(true);
    expect(result.policy.gateEntry.enabled).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Bounds enforcement
// ──────────────────────────────────────────────────────────────────────────────

describe("gateEntry — bounds", () => {
  it("clamps minLifespanDays below min to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ gateEntry: { minLifespanDays: -1 } }),
    );
    expect(result.issues.some((i) => i.includes("gateEntry.minLifespanDays"))).toBe(true);
    expect(result.policy.gateEntry.minLifespanDays).toBe(DEFAULT_GATE_ENTRY.minLifespanDays);
  });

  it("accepts a valid minLifespanDays override", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: { minLifespanDays: 45 } }));
    expect(result.issues).toEqual([]);
    expect(result.policy.gateEntry.minLifespanDays).toBe(45);
  });

  it("clamps minPrice below min (0) to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: { minPrice: -0.1 } }));
    expect(result.issues.some((i) => i.includes("gateEntry.minPrice"))).toBe(true);
    expect(result.policy.gateEntry.minPrice).toBe(DEFAULT_GATE_ENTRY.minPrice);
  });

  it("clamps maxPrice above max (1) to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: { maxPrice: 1.5 } }));
    expect(result.issues.some((i) => i.includes("gateEntry.maxPrice"))).toBe(true);
    expect(result.policy.gateEntry.maxPrice).toBe(DEFAULT_GATE_ENTRY.maxPrice);
  });

  it("clamps microMaxOrderUsdc below min to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ gateEntry: { microMaxOrderUsdc: 0 } }));
    expect(result.issues.some((i) => i.includes("gateEntry.microMaxOrderUsdc"))).toBe(true);
    expect(result.policy.gateEntry.microMaxOrderUsdc).toBe(DEFAULT_GATE_ENTRY.microMaxOrderUsdc);
  });

  it("accepts a valid microMaxOrderUsdc override", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ gateEntry: { microMaxOrderUsdc: 5 } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.gateEntry.microMaxOrderUsdc).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// whitelistConditionIds
// ──────────────────────────────────────────────────────────────────────────────

describe("gateEntry — whitelistConditionIds", () => {
  it("accepts a non-empty whitelist", () => {
    const ids = ["0xabc", "0xdef"];
    const result = parseExecutionPolicyJson(
      JSON.stringify({ gateEntry: { whitelistConditionIds: ids } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.gateEntry.whitelistConditionIds).toEqual(ids);
  });

  it("rejects non-array whitelist and falls back to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ gateEntry: { whitelistConditionIds: "0xabc" } }),
    );
    expect(result.issues.some((i) => i.includes("gateEntry.whitelistConditionIds"))).toBe(true);
    expect(result.policy.gateEntry.whitelistConditionIds).toEqual([]);
  });

  it("rejects whitelist containing empty strings and falls back to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ gateEntry: { whitelistConditionIds: ["0xabc", ""] } }),
    );
    expect(result.issues.some((i) => i.includes("gateEntry.whitelistConditionIds"))).toBe(true);
    expect(result.policy.gateEntry.whitelistConditionIds).toEqual([]);
  });

  it("deduplicates repeated condition IDs", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ gateEntry: { whitelistConditionIds: ["0xabc", "0xabc", "0xdef"] } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.gateEntry.whitelistConditionIds).toEqual(["0xabc", "0xdef"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Serialize → parse round-trip
// ──────────────────────────────────────────────────────────────────────────────

describe("gateEntry — serialize → parse round-trip", () => {
  it("preserves all fields through round-trip", () => {
    const policy = {
      ...DEFAULT_EXECUTION_POLICY,
      gateEntry: {
        enabled: true,
        mode: "micro_live" as const,
        minLifespanDays: 45,
        minPrice: 0.02,
        maxPrice: 0.2,
        whitelistConditionIds: ["0xabc123"],
        microMaxOrderUsdc: 5,
      },
    };
    const json = serializeExecutionPolicy(policy);
    const parsed = parseExecutionPolicyJson(json);
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.gateEntry).toEqual(policy.gateEntry);
  });

  it("patching gateEntry does not clobber other policy blocks", () => {
    const base = DEFAULT_EXECUTION_POLICY;
    const patched = {
      ...base,
      gateEntry: { ...base.gateEntry, enabled: true },
    };
    const json = serializeExecutionPolicy(patched);
    const parsed = parseExecutionPolicyJson(json);
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.makerEntry).toEqual(base.makerEntry);
    expect(parsed.policy.bounceExit).toEqual(base.bounceExit);
    expect(parsed.policy.gateEntry.enabled).toBe(true);
    expect(parsed.policy.gateEntry.mode).toBe("off");
  });
});
