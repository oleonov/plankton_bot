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

  it("default research-backed params (targetGainPct 0.257, timeoutMs 14_400_000, microMaxOrderUsdc 2) — still read by the shipped evaluator", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.bounceExit.targetGainPct).toBe(0.257);
    expect(result.policy.bounceExit.timeoutMs).toBe(14_400_000);
    expect(result.policy.bounceExit.microMaxOrderUsdc).toBe(2);
  });

  it("default ladder scaffolding params (tiers, fractions, step, backstop) — Phase 1 additive, not yet consumed", () => {
    const result = parseExecutionPolicyJson(null);
    expect(result.policy.bounceExit.targetTiers).toEqual([
      { maxPrice: 0.02, gainPct: 0.36 },
      { maxPrice: 0.03, gainPct: 0.27 },
      { maxPrice: 0.05, gainPct: 0.19 },
      { maxPrice: 0.08, gainPct: 0.15 },
      { maxPrice: 0.15, gainPct: 0.15 },
      { maxPrice: 0.35, gainPct: 0.12 },
      { maxPrice: 1.0, gainPct: 0.08 },
    ]);
    expect(result.policy.bounceExit.ladderFractions).toEqual([0.3, 0.4, 0.3]);
    expect(result.policy.bounceExit.ladderStepPct).toBe(0.22);
    expect(result.policy.bounceExit.backstopTtcHours).toBe(24);
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
// Legacy shape (old fields only, new ladder fields absent) — FAIL-CLOSED
// (docs/plans/2026-07-16-bounce-exit-ladder-redesign.md Phase 2 Codex fix):
// the ladder is now the ACTIVE bounce-exit path, so an old flat block must
// never silently activate it. enabled/mode are only honoured when all four
// ladder fields (targetTiers/ladderFractions/ladderStepPct/backstopTtcHours)
// are legitimately present AND valid; otherwise the parsed policy is forced
// to enabled:false/mode:"off", regardless of what the legacy block requested.
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — legacy shape forced fail-closed (ladder fields absent)", () => {
  it("forces enabled:false/mode:off for an old enabled:true/mode:micro_live flat block with no ladder fields", () => {
    const legacy = {
      enabled: true,
      mode: "micro_live",
      targetGainPct: 0.257,
      timeoutMs: 14_400_000,
      whitelistConditionIds: ["0xabc"],
      microMaxOrderUsdc: 2,
    };
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: legacy }));
    expect(() => result).not.toThrow();
    // Fail-closed: the ladder fields are absent, so enabled/mode are forced
    // off rather than running the ladder on unreviewed defaults.
    expect(result.policy.bounceExit.enabled).toBe(false);
    expect(result.policy.bounceExit.mode).toBe("off");
    expect(result.issues.some((i) => i.includes("bounceExit") && i.includes("fail-closed"))).toBe(
      true,
    );
    // Legacy fields (still read by the shipped evaluateBounceExit) and the
    // whitelist are preserved as requested — only enabled/mode are forced.
    expect(result.policy.bounceExit.targetGainPct).toBe(0.257);
    expect(result.policy.bounceExit.timeoutMs).toBe(14_400_000);
    expect(result.policy.bounceExit.whitelistConditionIds).toEqual(["0xabc"]);
    // New ladder fields default since absent from the legacy block.
    expect(result.policy.bounceExit.targetTiers).toEqual(DEFAULT_BOUNCE_EXIT.targetTiers);
    expect(result.policy.bounceExit.ladderFractions).toEqual(DEFAULT_BOUNCE_EXIT.ladderFractions);
    expect(result.policy.bounceExit.ladderStepPct).toBe(DEFAULT_BOUNCE_EXIT.ladderStepPct);
    expect(result.policy.bounceExit.backstopTtcHours).toBe(DEFAULT_BOUNCE_EXIT.backstopTtcHours);
  });

  it("does not push a fail-closed issue when the legacy block was already enabled:false/mode:off (no-op)", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({
        bounceExit: {
          enabled: false,
          mode: "off",
          targetGainPct: 0.3,
          timeoutMs: 7_200_000,
        },
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.enabled).toBe(false);
    expect(result.policy.bounceExit.mode).toBe("off");
  });

  it("still activates when a legacy-shaped block is paired with a full, valid ladder shape", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({
        bounceExit: {
          enabled: true,
          mode: "micro_live",
          targetGainPct: 0.257,
          timeoutMs: 14_400_000,
          targetTiers: DEFAULT_BOUNCE_EXIT.targetTiers,
          ladderFractions: DEFAULT_BOUNCE_EXIT.ladderFractions,
          ladderStepPct: DEFAULT_BOUNCE_EXIT.ladderStepPct,
          backstopTtcHours: DEFAULT_BOUNCE_EXIT.backstopTtcHours,
        },
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.enabled).toBe(true);
    expect(result.policy.bounceExit.mode).toBe("micro_live");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Mode enum
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — mode", () => {
  it("accepts valid mode 'off' even with ladder fields absent (off never triggers the fail-closed override)", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { mode: "off" } }));
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.mode).toBe("off");
  });

  it("accepts valid mode 'micro_live' when paired with a full, valid ladder shape", () => {
    // mode enum-acceptance is isolated from the fail-closed ladder-fields
    // gate (see the "legacy shape forced fail-closed" describe block above)
    // by supplying a complete, valid ladder shape here.
    const result = parseExecutionPolicyJson(
      JSON.stringify({
        bounceExit: {
          mode: "micro_live",
          targetTiers: DEFAULT_BOUNCE_EXIT.targetTiers,
          ladderFractions: DEFAULT_BOUNCE_EXIT.ladderFractions,
          ladderStepPct: DEFAULT_BOUNCE_EXIT.ladderStepPct,
          backstopTtcHours: DEFAULT_BOUNCE_EXIT.backstopTtcHours,
        },
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.mode).toBe("micro_live");
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
  it("accepts enabled=true when paired with a full, valid ladder shape", () => {
    // Same isolation rationale as the "mode" describe block above: enabled's
    // own acceptance semantics, independent of the fail-closed ladder-fields
    // gate.
    const result = parseExecutionPolicyJson(
      JSON.stringify({
        bounceExit: {
          enabled: true,
          targetTiers: DEFAULT_BOUNCE_EXIT.targetTiers,
          ladderFractions: DEFAULT_BOUNCE_EXIT.ladderFractions,
          ladderStepPct: DEFAULT_BOUNCE_EXIT.ladderStepPct,
          backstopTtcHours: DEFAULT_BOUNCE_EXIT.backstopTtcHours,
        },
      }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.enabled).toBe(true);
  });

  it("forces enabled:false when requested enabled=true but ladder fields are absent (fail-closed)", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { enabled: true } }));
    expect(result.policy.bounceExit.enabled).toBe(false);
  });

  it("rejects non-boolean enabled and falls back to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { enabled: "yes" } }));
    expect(result.issues.some((i) => i.includes("bounceExit.enabled"))).toBe(true);
    expect(result.policy.bounceExit.enabled).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Bounds enforcement (legacy fields — still the shipped evaluator's inputs)
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
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { targetGainPct: 0.3 } }));
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
// targetTiers validation (Phase 1 additive scaffolding — per-field fallback to
// default on absence/invalidity; not a whole-bounceExit-block fail-closed).
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — targetTiers validation", () => {
  it("accepts a valid custom tier table", () => {
    const targetTiers = [
      { maxPrice: 0.1, gainPct: 0.3 },
      { maxPrice: 1.0, gainPct: 0.1 },
    ];
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { targetTiers } }));
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.targetTiers).toEqual(targetTiers);
  });

  it("rejects an empty tier array, falls back to default tiers, and forces enabled:false (fail-closed — an invalid ladder field is not 'legitimately present')", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { enabled: true, targetTiers: [] } }),
    );
    expect(result.issues.some((i) => i.includes("targetTiers"))).toBe(true);
    expect(result.policy.bounceExit.targetTiers).toEqual(DEFAULT_BOUNCE_EXIT.targetTiers);
    // targetTiers was requested but invalid — the ladder fields are not all
    // legitimately present, so enabled is forced off regardless of the
    // requested enabled:true (Codex Phase-2 fail-closed fix).
    expect(result.policy.bounceExit.enabled).toBe(false);
  });

  it("rejects a non-monotonic (increasing) gainPct sequence and falls back to default tiers", () => {
    const targetTiers = [
      { maxPrice: 0.1, gainPct: 0.1 },
      { maxPrice: 1.0, gainPct: 0.3 },
    ];
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { targetTiers } }));
    expect(result.issues.some((i) => i.includes("targetTiers") && i.includes("monotonic"))).toBe(
      true,
    );
    expect(result.policy.bounceExit.targetTiers).toEqual(DEFAULT_BOUNCE_EXIT.targetTiers);
  });

  it("rejects a tier list whose maxPrice is out of ascending order and falls back to default tiers", () => {
    // bounceExitTierGain (bounce-exit.ts) does a first-match `entryPrice <= maxPrice`
    // lookup, which is only correct when tiers are ordered by strictly ascending
    // maxPrice. An out-of-order list like this one would silently resolve low-price
    // entries to the wrong tier if accepted.
    const targetTiers = [
      { maxPrice: 0.05, gainPct: 0.36 },
      { maxPrice: 0.02, gainPct: 0.27 },
      { maxPrice: 1, gainPct: 0.08 },
    ];
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { targetTiers } }));
    expect(result.issues.some((i) => i.includes("targetTiers") && i.includes("ascending"))).toBe(
      true,
    );
    expect(result.policy.bounceExit.targetTiers).toEqual(DEFAULT_BOUNCE_EXIT.targetTiers);
  });

  it("rejects a tier list with a repeated (non-strictly-ascending) maxPrice", () => {
    const targetTiers = [
      { maxPrice: 0.1, gainPct: 0.3 },
      { maxPrice: 0.1, gainPct: 0.2 },
      { maxPrice: 1.0, gainPct: 0.1 },
    ];
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { targetTiers } }));
    expect(result.issues.some((i) => i.includes("targetTiers") && i.includes("ascending"))).toBe(
      true,
    );
    expect(result.policy.bounceExit.targetTiers).toEqual(DEFAULT_BOUNCE_EXIT.targetTiers);
  });

  it("accepts equal (flat) consecutive gainPct — non-increasing allows equality", () => {
    const targetTiers = [
      { maxPrice: 0.1, gainPct: 0.2 },
      { maxPrice: 1.0, gainPct: 0.2 },
    ];
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { targetTiers } }));
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.targetTiers).toEqual(targetTiers);
  });

  it("rejects a tier table whose last maxPrice is below 1.0 (no catch-all)", () => {
    const targetTiers = [
      { maxPrice: 0.1, gainPct: 0.3 },
      { maxPrice: 0.5, gainPct: 0.1 },
    ];
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { targetTiers } }));
    expect(result.issues.some((i) => i.includes("targetTiers") && i.includes("maxPrice"))).toBe(
      true,
    );
    expect(result.policy.bounceExit.targetTiers).toEqual(DEFAULT_BOUNCE_EXIT.targetTiers);
  });

  it("rejects a tier with gainPct out of bounds", () => {
    const targetTiers = [{ maxPrice: 1.0, gainPct: 0.001 }];
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { targetTiers } }));
    expect(result.policy.bounceExit.targetTiers).toEqual(DEFAULT_BOUNCE_EXIT.targetTiers);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ladderFractions validation
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — ladderFractions validation", () => {
  it("accepts fractions that sum to ~1.0", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { ladderFractions: [0.5, 0.5] } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.ladderFractions).toEqual([0.5, 0.5]);
  });

  it("accepts fractions within the 0.001 sum tolerance", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { ladderFractions: [0.3, 0.4, 0.3009] } }),
    );
    expect(result.issues).toEqual([]);
  });

  it("rejects fractions that don't sum to ~1.0 and falls back to default fractions", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { ladderFractions: [0.3, 0.3, 0.3] } }),
    );
    expect(result.issues.some((i) => i.includes("ladderFractions") && i.includes("sum"))).toBe(
      true,
    );
    expect(result.policy.bounceExit.ladderFractions).toEqual(DEFAULT_BOUNCE_EXIT.ladderFractions);
  });

  it("rejects a non-positive fraction", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { ladderFractions: [1.2, -0.2] } }),
    );
    expect(result.policy.bounceExit.ladderFractions).toEqual(DEFAULT_BOUNCE_EXIT.ladderFractions);
  });

  it("rejects an empty fractions array", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { ladderFractions: [] } }),
    );
    expect(result.policy.bounceExit.ladderFractions).toEqual(DEFAULT_BOUNCE_EXIT.ladderFractions);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// ladderStepPct / backstopTtcHours validation
// ──────────────────────────────────────────────────────────────────────────────

describe("bounceExit — ladderStepPct / backstopTtcHours validation", () => {
  it("accepts a positive ladderStepPct and backstopTtcHours", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { ladderStepPct: 0.15, backstopTtcHours: 12 } }),
    );
    expect(result.issues).toEqual([]);
    expect(result.policy.bounceExit.ladderStepPct).toBe(0.15);
    expect(result.policy.bounceExit.backstopTtcHours).toBe(12);
  });

  it("rejects a zero/negative ladderStepPct and falls back to default", () => {
    const result = parseExecutionPolicyJson(JSON.stringify({ bounceExit: { ladderStepPct: 0 } }));
    expect(result.policy.bounceExit.ladderStepPct).toBe(DEFAULT_BOUNCE_EXIT.ladderStepPct);
  });

  it("rejects a zero/negative backstopTtcHours and falls back to default", () => {
    const result = parseExecutionPolicyJson(
      JSON.stringify({ bounceExit: { backstopTtcHours: -1 } }),
    );
    expect(result.policy.bounceExit.backstopTtcHours).toBe(DEFAULT_BOUNCE_EXIT.backstopTtcHours);
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
  it("preserves all fields (legacy + new ladder scaffolding) through round-trip", () => {
    const policy = {
      ...DEFAULT_EXECUTION_POLICY,
      bounceExit: {
        enabled: true,
        mode: "micro_live" as const,
        targetGainPct: 0.3,
        timeoutMs: 7_200_000,
        targetTiers: [
          { maxPrice: 0.1, gainPct: 0.3 },
          { maxPrice: 1.0, gainPct: 0.1 },
        ],
        ladderFractions: [0.5, 0.5],
        ladderStepPct: 0.18,
        backstopTtcHours: 12,
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
    expect(parsed.policy.bounceExit.targetTiers).toEqual(base.bounceExit.targetTiers);
  });
});
