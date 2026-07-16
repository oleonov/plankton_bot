import { describe, expect, it } from "vitest";

import {
  DEFAULT_BOUNCE_EXIT,
  DEFAULT_EXECUTION_POLICY,
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
} from "../execution-policy.js";

// ──────────────────────────────────────────────────────────────────────────────
// Defaults
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — defaults", () => {
  it("applies defaults when bounceExit key is absent", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit).toEqual(DEFAULT_BOUNCE_EXIT);
  });

  it("default enabled is false and mode is 'off' (fail-safe)", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.bounceExit.enabled).toBe(false);
    expect(result.policy.bounceExit.mode).toBe("off");
  });

  it("default whitelistConditionIds is empty array", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.bounceExit.whitelistConditionIds).toEqual([]);
  });

  it("default research-backed params (targetGainPct 0.257, timeoutMs 14_400_000, microMaxOrderUsdc 2)", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.bounceExit.targetGainPct).toBe(0.257);
    expect(result.policy.bounceExit.timeoutMs).toBe(14_400_000);
    expect(result.policy.bounceExit.microMaxOrderUsdc).toBe(2);
  });

  it("falls back to DEFAULT_BOUNCE_EXIT when bounceExit is not an object", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: "bad" }));
    expect(result.issues).toContain("bounceExit must be an object");
    expect(result.policy.bounceExit).toEqual(DEFAULT_BOUNCE_EXIT);
  });

  it("falls back to DEFAULT_BOUNCE_EXIT when bounceExit is an array", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: [] }));
    expect(result.issues).toContain("bounceExit must be an object");
    expect(result.policy.bounceExit).toEqual(DEFAULT_BOUNCE_EXIT);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Mode enum
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — mode", () => {
  it.each(["off", "micro_live"] as const)("accepts valid mode '%s'", (mode) => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { mode } }));
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.mode).toBe(mode);
  });

  it("rejects unknown mode and falls back to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { mode: "shadow" } }));
    expect(result.issues.some((i) => i.includes("bounceExit.mode"))).toBe(true);
    expect(result.policy.bounceExit.mode).toBe("off");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// enabled
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — enabled", () => {
  it("accepts enabled=true", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { enabled: true } }));
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.enabled).toBe(true);
  });

  it("rejects non-boolean enabled and falls back to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { enabled: "yes" } }));
    expect(result.issues.some((i) => i.includes("bounceExit.enabled"))).toBe(true);
    expect(result.policy.bounceExit.enabled).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Bounds enforcement
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — bounds", () => {
  it("clamps targetGainPct below min to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { targetGainPct: 0.001 } }),
    );
    expect(result.issues.some((i) => i.includes("bounceExit.targetGainPct"))).toBe(true);
    expect(result.policy.bounceExit.targetGainPct).toBe(DEFAULT_BOUNCE_EXIT.targetGainPct);
  });

  it("accepts a valid targetGainPct override", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { targetGainPct: 0.3 } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.targetGainPct).toBe(0.3);
  });

  it("clamps timeoutMs below min to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { timeoutMs: 1_000 } }));
    expect(result.issues.some((i) => i.includes("bounceExit.timeoutMs"))).toBe(true);
    expect(result.policy.bounceExit.timeoutMs).toBe(DEFAULT_BOUNCE_EXIT.timeoutMs);
  });

  it("accepts timeoutMs=14_400_000 (default, 4h)", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { timeoutMs: 14_400_000 } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.timeoutMs).toBe(14_400_000);
  });

  it("clamps microMaxOrderUsdc below min to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { microMaxOrderUsdc: 0 } }),
    );
    expect(result.issues.some((i) => i.includes("bounceExit.microMaxOrderUsdc"))).toBe(true);
    expect(result.policy.bounceExit.microMaxOrderUsdc).toBe(DEFAULT_BOUNCE_EXIT.microMaxOrderUsdc);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// whitelistConditionIds
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — whitelistConditionIds", () => {
  it("accepts a non-empty whitelist", () => {
    const ids = ["0xabc", "0xdef"];
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { whitelistConditionIds: ids } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.whitelistConditionIds).toEqual(ids);
  });

  it("rejects non-array whitelist and falls back to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { whitelistConditionIds: "0xabc" } }),
    );
    expect(result.issues.some((i) => i.includes("bounceExit.whitelistConditionIds"))).toBe(true);
    expect(result.policy.bounceExit.whitelistConditionIds).toEqual([]);
  });

  it("deduplicates repeated condition IDs", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { whitelistConditionIds: ["0xabc", "0xabc", "0xdef"] } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.whitelistConditionIds).toEqual(["0xabc", "0xdef"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Serialize → parse round-trip
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — serialize → parse round-trip", () => {
  it("preserves all fields through round-trip", () => {
    const policy = {
      ...DEFAULT_EXECUTION_POLICY,
      bounceExit: {
        enabled: true,
        mode: "micro_live" as const,
        targetGainPct: 0.3,
        timeoutMs: 7_200_000,
        whitelistConditionIds: ["0xabc123"],
        microMaxOrderUsdc: 5,
      },
    };
    const json = serializeExecutionPolicy(policy);
    const parsed = parseExecutionPolicyJson(json);
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.bounceExit).toEqual(policy.bounceExit);
  });

  it("patching bounceExit does not clobber other policy blocks", () => {
    const base = DEFAULT_EXECUTION_POLICY;
    const patched = {
      ...base,
      bounceExit: { ...base.bounceExit, enabled: true },
    };
    const json = serializeExecutionPolicy(patched);
    const parsed = parseExecutionPolicyJson(json);
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy.makerEntry).toEqual(base.makerEntry);
    expect(parsed.policy.gateEntry).toEqual(base.gateEntry);
    expect(parsed.policy.bounceExit.enabled).toBe(true);
    expect(parsed.policy.bounceExit.mode).toBe("off");
  });
});
