/**
 * ADR-015 — DB-backed execution policy parser (shared).
 *
 * Reads `profile_settings.execution_policy_json` into a validated
 * `ExecutionPolicy`. Invalid JSON, invalid enum, and out-of-bound numeric
 * fields all fall back to safe defaults rather than crashing the bridge.
 *
 * Shared across runtime + api so PATCH validation stays single-sourced.
 * Keep this module pure — no runtime deps, no I/O.
 */
import type {
  DeadSideGuardPolicy,
  ExecutionPolicy,
  ExecutionPricingPolicy,
  ExecutionPolicyTelemetry,
} from "./types.js";

export const DEFAULT_DEAD_SIDE_GUARD: DeadSideGuardPolicy = {
  mode: "observe",
  askCeiling: 0.02,
  maxTimeToEndMs: 120_000,
};

export const DEFAULT_PRICING_POLICY: ExecutionPricingPolicy = {
  mode: "edge",
  maxEntrySpreadTicks: 20,
  maxExitSpreadTicks: 40,
  maxImprovementTicks: 10,
  wideSpreadPolicy: "edge",
  oneSidedPolicy: "edge",
};

export const DEFAULT_TELEMETRY: ExecutionPolicyTelemetry = {
  deadSideCanary: true,
  pricingShadow: true,
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  version: 1,
  entryPriceCeiling: 0.75,
  exitOrderTtlMs: 300_000,
  deadSideGuard: DEFAULT_DEAD_SIDE_GUARD,
  pricing: DEFAULT_PRICING_POLICY,
  telemetry: DEFAULT_TELEMETRY,
};

const DEAD_SIDE_MODES = ["off", "observe", "enforce"] as const;
const PRICING_MODES = ["edge", "bounded-midpoint"] as const;
const BINARY_PRICING_POLICIES = ["edge", "skip"] as const;

// Bounds chosen to match the Zod schema that previously lived in
// packages/config/src/env.ts so operators can't wedge the runtime via SQL.
const BOUND_ASK_CEILING_MAX = 0.2;
const BOUND_MAX_TIME_TO_END_MIN_MS = 1_000;
const BOUND_MAX_TIME_TO_END_MAX_MS = 15 * 60_000;
const BOUND_SPREAD_TICKS_MIN = 1;
const BOUND_SPREAD_TICKS_MAX = 2000;
const BOUND_IMPROVEMENT_TICKS_MIN = 0;
const BOUND_IMPROVEMENT_TICKS_MAX = 500;
const BOUND_ENTRY_CEILING_MIN = 0.05;
const BOUND_ENTRY_CEILING_MAX = 0.99;
const BOUND_EXIT_TTL_MIN_MS = 10_000;
const BOUND_EXIT_TTL_MAX_MS = 60 * 60_000;

export interface ParseResult {
  policy: ExecutionPolicy;
  issues: string[];
}

export function parseExecutionPolicyJson(jsonString: string | null | undefined): ParseResult {
  const issues: string[] = [];
  if (jsonString == null || jsonString.trim() === "") {
    return { policy: DEFAULT_EXECUTION_POLICY, issues };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(jsonString);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "JSON parse failure";
    issues.push(`executionPolicyJson invalid JSON: ${msg}`);
    return { policy: DEFAULT_EXECUTION_POLICY, issues };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push("executionPolicyJson must be an object");
    return { policy: DEFAULT_EXECUTION_POLICY, issues };
  }
  const obj = raw as Record<string, unknown>;

  const version = numberOr(obj.version, DEFAULT_EXECUTION_POLICY.version, issues, "version");
  const entryPriceCeiling = clampedNumber(
    obj.entryPriceCeiling,
    DEFAULT_EXECUTION_POLICY.entryPriceCeiling,
    BOUND_ENTRY_CEILING_MIN,
    BOUND_ENTRY_CEILING_MAX,
    issues,
    "entryPriceCeiling",
  );
  const exitOrderTtlMs = clampedInt(
    obj.exitOrderTtlMs,
    DEFAULT_EXECUTION_POLICY.exitOrderTtlMs,
    BOUND_EXIT_TTL_MIN_MS,
    BOUND_EXIT_TTL_MAX_MS,
    issues,
    "exitOrderTtlMs",
  );

  const deadSideGuard = parseDeadSideGuard(obj.deadSideGuard, issues);
  const pricing = parsePricing(obj.pricing, issues);
  const telemetry = parseTelemetry(obj.telemetry, issues);

  return {
    policy: {
      version,
      entryPriceCeiling,
      exitOrderTtlMs,
      deadSideGuard,
      pricing,
      telemetry,
    },
    issues,
  };
}

function parseDeadSideGuard(raw: unknown, issues: string[]): DeadSideGuardPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("deadSideGuard must be an object");
    return DEFAULT_DEAD_SIDE_GUARD;
  }
  const obj = raw as Record<string, unknown>;
  const mode = enumOr(
    obj.mode,
    DEAD_SIDE_MODES,
    DEFAULT_DEAD_SIDE_GUARD.mode,
    issues,
    "deadSideGuard.mode",
  );
  const askCeiling = clampedNumber(
    obj.askCeiling,
    DEFAULT_DEAD_SIDE_GUARD.askCeiling,
    Number.MIN_VALUE,
    BOUND_ASK_CEILING_MAX,
    issues,
    "deadSideGuard.askCeiling",
  );
  const maxTimeToEndMs = clampedInt(
    obj.maxTimeToEndMs,
    DEFAULT_DEAD_SIDE_GUARD.maxTimeToEndMs,
    BOUND_MAX_TIME_TO_END_MIN_MS,
    BOUND_MAX_TIME_TO_END_MAX_MS,
    issues,
    "deadSideGuard.maxTimeToEndMs",
  );
  return { mode, askCeiling, maxTimeToEndMs };
}

function parsePricing(raw: unknown, issues: string[]): ExecutionPricingPolicy {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("pricing must be an object");
    return DEFAULT_PRICING_POLICY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    mode: enumOr(obj.mode, PRICING_MODES, DEFAULT_PRICING_POLICY.mode, issues, "pricing.mode"),
    maxEntrySpreadTicks: clampedInt(
      obj.maxEntrySpreadTicks,
      DEFAULT_PRICING_POLICY.maxEntrySpreadTicks,
      BOUND_SPREAD_TICKS_MIN,
      BOUND_SPREAD_TICKS_MAX,
      issues,
      "pricing.maxEntrySpreadTicks",
    ),
    maxExitSpreadTicks: clampedInt(
      obj.maxExitSpreadTicks,
      DEFAULT_PRICING_POLICY.maxExitSpreadTicks,
      BOUND_SPREAD_TICKS_MIN,
      BOUND_SPREAD_TICKS_MAX,
      issues,
      "pricing.maxExitSpreadTicks",
    ),
    maxImprovementTicks: clampedInt(
      obj.maxImprovementTicks,
      DEFAULT_PRICING_POLICY.maxImprovementTicks,
      BOUND_IMPROVEMENT_TICKS_MIN,
      BOUND_IMPROVEMENT_TICKS_MAX,
      issues,
      "pricing.maxImprovementTicks",
    ),
    wideSpreadPolicy: enumOr(
      obj.wideSpreadPolicy,
      BINARY_PRICING_POLICIES,
      DEFAULT_PRICING_POLICY.wideSpreadPolicy,
      issues,
      "pricing.wideSpreadPolicy",
    ),
    oneSidedPolicy: enumOr(
      obj.oneSidedPolicy,
      BINARY_PRICING_POLICIES,
      DEFAULT_PRICING_POLICY.oneSidedPolicy,
      issues,
      "pricing.oneSidedPolicy",
    ),
  };
}

function parseTelemetry(raw: unknown, issues: string[]): ExecutionPolicyTelemetry {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    if (raw !== undefined) issues.push("telemetry must be an object");
    return DEFAULT_TELEMETRY;
  }
  const obj = raw as Record<string, unknown>;
  return {
    deadSideCanary: booleanOr(
      obj.deadSideCanary,
      DEFAULT_TELEMETRY.deadSideCanary,
      issues,
      "telemetry.deadSideCanary",
    ),
    pricingShadow: booleanOr(
      obj.pricingShadow,
      DEFAULT_TELEMETRY.pricingShadow,
      issues,
      "telemetry.pricingShadow",
    ),
  };
}

function numberOr(raw: unknown, fallback: number, issues: string[], name: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    issues.push(`${name} must be a finite number`);
    return fallback;
  }
  return raw;
}

function clampedNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  issues: string[],
  name: string,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    issues.push(`${name} must be a finite number`);
    return fallback;
  }
  if (raw < min || raw > max) {
    issues.push(`${name}=${raw} out of range [${min}, ${max}]`);
    return fallback;
  }
  return raw;
}

function clampedInt(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  issues: string[],
  name: string,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    issues.push(`${name} must be a finite integer`);
    return fallback;
  }
  if (raw < min || raw > max) {
    issues.push(`${name}=${raw} out of range [${min}, ${max}]`);
    return fallback;
  }
  return raw;
}

function enumOr<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
  issues: string[],
  name: string,
): T {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    issues.push(`${name}=${String(raw)} not in [${allowed.join(",")}]`);
    return fallback;
  }
  return raw as T;
}

function booleanOr(raw: unknown, fallback: boolean, issues: string[], name: string): boolean {
  if (raw === undefined) return fallback;
  if (typeof raw !== "boolean") {
    issues.push(`${name} must be boolean`);
    return fallback;
  }
  return raw;
}

/** Serialize an ExecutionPolicy back to the compact JSON used by the DB. */
export function serializeExecutionPolicy(policy: ExecutionPolicy): string {
  return JSON.stringify(policy);
}
