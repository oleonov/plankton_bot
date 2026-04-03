import { ProfileId } from "./enums.js";
import type { ProfileId as RuntimeProfileId } from "./enums.js";
import { resolveFamilyLiveTradingPolicy } from "./live-trading-policy.js";
import type { FamilyLiveTradingPolicyInput } from "./live-trading-policy.js";
import type { PromotionBlocker } from "./promotion-blockers.js";

export const DEFAULT_EXECUTION_CANARY_WINDOW_HOURS = 24;
export const DEFAULT_EXECUTION_CANARY_MIN_TOTAL_FILLS = 10;

export interface ExecutionTelemetrySnapshot {
  totalFills: number;
  volumeUsdc: number;
  makerFills: number;
  takerFills: number;
  unknownFills: number;
  makerRatio: number | null;
  takerRatio: number | null;
  explicitFeesUsdc: number;
  feeLeakageRatio: number | null;
  lastFillAt: string | null;
}

export interface ExecutionCanaryGate {
  required: boolean;
  eligible: boolean;
  minTotalFills: number;
  blockers: PromotionBlocker[];
}

export interface ValidationScorecardSummary {
  repricingExits?: number;
  executionTelemetry24h?: ExecutionTelemetrySnapshot;
  executionCanary24h?: ExecutionCanaryGate;
}

export interface EvaluateExecutionCanaryGateInput extends FamilyLiveTradingPolicyInput {
  executionTelemetry: ExecutionTelemetrySnapshot;
  minTotalFills?: number;
}

export function shouldEnforcePromotionExecutionCanary(
  profile: RuntimeProfileId | null | undefined,
): boolean {
  return profile === ProfileId.LiveLite;
}

export function isPromotionBlockedByExecutionCanary(
  profile: RuntimeProfileId | null | undefined,
  executionCanary: ExecutionCanaryGate,
): boolean {
  return (
    shouldEnforcePromotionExecutionCanary(profile) &&
    executionCanary.required &&
    !executionCanary.eligible
  );
}

export function emptyExecutionTelemetrySnapshot(): ExecutionTelemetrySnapshot {
  return {
    totalFills: 0,
    volumeUsdc: 0,
    makerFills: 0,
    takerFills: 0,
    unknownFills: 0,
    makerRatio: null,
    takerRatio: null,
    explicitFeesUsdc: 0,
    feeLeakageRatio: null,
    lastFillAt: null,
  };
}

export function evaluateExecutionCanaryGate(
  input: EvaluateExecutionCanaryGateInput,
): ExecutionCanaryGate {
  const policy = resolveFamilyLiveTradingPolicy(input);
  const required = policy.feeTier === "fee-enabled" || policy.requiresPostOnlyForLive;
  if (!required) {
    return {
      required: false,
      eligible: true,
      minTotalFills: input.minTotalFills ?? DEFAULT_EXECUTION_CANARY_MIN_TOTAL_FILLS,
      blockers: [],
    };
  }

  const minTotalFills = input.minTotalFills ?? DEFAULT_EXECUTION_CANARY_MIN_TOTAL_FILLS;
  const telemetry = input.executionTelemetry;
  const makerRatioPct = telemetry.makerRatio == null ? 0 : +(telemetry.makerRatio * 100).toFixed(2);
  const leakagePct =
    telemetry.feeLeakageRatio == null ? 0 : +(telemetry.feeLeakageRatio * 100).toFixed(4);
  const explicitFeesUsdc = +telemetry.explicitFeesUsdc.toFixed(6);

  const blockers: PromotionBlocker[] = [
    {
      metric: "24h fills",
      current: telemetry.totalFills,
      required: minTotalFills,
      passed: telemetry.totalFills >= minTotalFills,
    },
    {
      metric: "Maker ratio %",
      current: makerRatioPct,
      required: 100,
      passed: telemetry.totalFills > 0 && telemetry.makerFills === telemetry.totalFills,
    },
    {
      metric: "Taker fills",
      current: telemetry.takerFills,
      required: 0,
      passed: telemetry.takerFills === 0,
    },
    {
      metric: "Unknown fills",
      current: telemetry.unknownFills,
      required: 0,
      passed: telemetry.unknownFills === 0,
    },
    {
      metric: "Explicit fees (USDC)",
      current: explicitFeesUsdc,
      required: 0,
      passed: explicitFeesUsdc === 0,
    },
    {
      metric: "Fee leakage %",
      current: leakagePct,
      required: 0,
      passed: leakagePct === 0,
    },
  ];

  return {
    required: true,
    eligible: blockers.every((blocker) => blocker.passed),
    minTotalFills,
    blockers,
  };
}

export function parseValidationScorecardSummary(
  summaryJson: string | null,
): ValidationScorecardSummary | null {
  if (!summaryJson) return null;
  try {
    const parsed = JSON.parse(summaryJson);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ValidationScorecardSummary;
  } catch {
    return null;
  }
}
