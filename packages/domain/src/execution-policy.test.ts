import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
} from "./execution-policy.js";

describe("parseExecutionPolicyJson (ADR-015)", () => {
  it("returns defaults for null/empty input without issues", () => {
    const r1 = parseExecutionPolicyJson(null);
    expect(r1.policy).toBe(DEFAULT_EXECUTION_POLICY);
    expect(r1.issues).toHaveLength(0);

    const r2 = parseExecutionPolicyJson("   ");
    expect(r2.policy).toBe(DEFAULT_EXECUTION_POLICY);
    expect(r2.issues).toHaveLength(0);
  });

  it("falls back to defaults on malformed JSON with one issue", () => {
    const { policy, issues } = parseExecutionPolicyJson("{not-json");
    expect(policy).toBe(DEFAULT_EXECUTION_POLICY);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("invalid JSON");
  });

  it("rejects non-object payloads (arrays, scalars)", () => {
    const r1 = parseExecutionPolicyJson("[1,2,3]");
    expect(r1.issues[0]).toContain("must be an object");

    const r2 = parseExecutionPolicyJson('"hello"');
    expect(r2.issues[0]).toContain("must be an object");
  });

  it("accepts a well-formed full policy as-is", () => {
    const input = {
      version: 1,
      entryPriceCeiling: 0.6,
      exitOrderTtlMs: 600_000,
      deadSideGuard: { mode: "enforce", askCeiling: 0.05, maxTimeToEndMs: 60_000 },
      pricing: {
        mode: "bounded-midpoint",
        maxEntrySpreadTicks: 15,
        maxExitSpreadTicks: 30,
        maxImprovementTicks: 5,
        wideSpreadPolicy: "skip",
        oneSidedPolicy: "skip",
      },
      telemetry: { deadSideCanary: false, pricingShadow: false },
    };
    const { policy, issues } = parseExecutionPolicyJson(JSON.stringify(input));
    expect(issues).toHaveLength(0);
    expect(policy.entryPriceCeiling).toBe(0.6);
    expect(policy.deadSideGuard.mode).toBe("enforce");
    expect(policy.pricing.mode).toBe("bounded-midpoint");
    expect(policy.pricing.wideSpreadPolicy).toBe("skip");
    expect(policy.telemetry.deadSideCanary).toBe(false);
  });

  it("falls back field-by-field on invalid enum values", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ deadSideGuard: { mode: "bogus" } }),
    );
    expect(policy.deadSideGuard.mode).toBe(DEFAULT_EXECUTION_POLICY.deadSideGuard.mode);
    expect(issues.some((i) => i.includes("deadSideGuard.mode"))).toBe(true);
  });

  it("clamps-to-default on out-of-range numbers (no silent clip)", () => {
    // entryPriceCeiling bounds are [0.05, 0.99]
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ entryPriceCeiling: 5 }),
    );
    expect(policy.entryPriceCeiling).toBe(DEFAULT_EXECUTION_POLICY.entryPriceCeiling);
    expect(issues.some((i) => i.includes("entryPriceCeiling"))).toBe(true);
  });

  it("rejects non-integer exitOrderTtlMs with an issue", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ exitOrderTtlMs: 12_345.6 }),
    );
    expect(policy.exitOrderTtlMs).toBe(DEFAULT_EXECUTION_POLICY.exitOrderTtlMs);
    expect(issues.some((i) => i.includes("exitOrderTtlMs"))).toBe(true);
  });

  it("preserves partial pricing override and defaults the rest", () => {
    const { policy, issues } = parseExecutionPolicyJson(
      JSON.stringify({ pricing: { mode: "bounded-midpoint" } }),
    );
    expect(issues).toHaveLength(0);
    expect(policy.pricing.mode).toBe("bounded-midpoint");
    expect(policy.pricing.maxEntrySpreadTicks).toBe(
      DEFAULT_EXECUTION_POLICY.pricing.maxEntrySpreadTicks,
    );
    expect(policy.pricing.wideSpreadPolicy).toBe(
      DEFAULT_EXECUTION_POLICY.pricing.wideSpreadPolicy,
    );
  });

  it("rejects deadSideGuard as array or scalar with an issue", () => {
    const { issues: a } = parseExecutionPolicyJson(JSON.stringify({ deadSideGuard: [1, 2] }));
    expect(a.some((i) => i.includes("deadSideGuard must be an object"))).toBe(true);

    const { issues: b } = parseExecutionPolicyJson(JSON.stringify({ deadSideGuard: 42 }));
    expect(b.some((i) => i.includes("deadSideGuard must be an object"))).toBe(true);
  });

  it("round-trips via serializeExecutionPolicy", () => {
    const { policy } = parseExecutionPolicyJson(
      JSON.stringify({
        pricing: { mode: "bounded-midpoint", maxEntrySpreadTicks: 42 },
      }),
    );
    const reparsed = parseExecutionPolicyJson(serializeExecutionPolicy(policy)).policy;
    expect(reparsed).toEqual(policy);
  });
});
