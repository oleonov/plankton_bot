import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_CANARY_MIN_TOTAL_FILLS,
  emptyExecutionTelemetrySnapshot,
  evaluateExecutionCanaryGate,
  isPromotionBlockedByExecutionCanary,
  parseValidationScorecardSummary,
  shouldEnforcePromotionExecutionCanary,
} from "./execution-canary.js";
import { ProfileId } from "./enums.js";

describe("evaluateExecutionCanaryGate", () => {
  it("does not require canary gating for fee-free families", () => {
    const result = evaluateExecutionCanaryGate({
      primaryCategory: "geopolitics",
      executionTelemetry: emptyExecutionTelemetrySnapshot(),
    });

    expect(result.required).toBe(false);
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("fails fee-enabled families on taker fills and explicit fees", () => {
    const result = evaluateExecutionCanaryGate({
      primaryCategory: "crypto",
      executionTelemetry: {
        totalFills: 12,
        volumeUsdc: 20,
        makerFills: 10,
        takerFills: 2,
        unknownFills: 0,
        makerRatio: 10 / 12,
        takerRatio: 2 / 12,
        explicitFeesUsdc: 0.12,
        feeLeakageRatio: 0.006,
        lastFillAt: "2026-04-03T00:00:00Z",
      },
    });

    expect(result.required).toBe(true);
    expect(result.eligible).toBe(false);
    expect(result.blockers.find((b) => b.metric === "Taker fills")?.passed).toBe(false);
    expect(result.blockers.find((b) => b.metric === "Explicit fees (USDC)")?.passed).toBe(false);
    expect(result.blockers.find((b) => b.metric === "Fee leakage %")?.passed).toBe(false);
  });

  it("passes fee-enabled families only when the maker-only canary is clean", () => {
    const result = evaluateExecutionCanaryGate({
      primaryCategory: "crypto",
      executionTelemetry: {
        totalFills: DEFAULT_EXECUTION_CANARY_MIN_TOTAL_FILLS,
        volumeUsdc: 25,
        makerFills: DEFAULT_EXECUTION_CANARY_MIN_TOTAL_FILLS,
        takerFills: 0,
        unknownFills: 0,
        makerRatio: 1,
        takerRatio: 0,
        explicitFeesUsdc: 0,
        feeLeakageRatio: 0,
        lastFillAt: "2026-04-03T00:00:00Z",
      },
    });

    expect(result.required).toBe(true);
    expect(result.eligible).toBe(true);
    expect(result.blockers.every((blocker) => blocker.passed)).toBe(true);
  });
});

describe("parseValidationScorecardSummary", () => {
  it("returns null for malformed JSON", () => {
    expect(parseValidationScorecardSummary("{")).toBeNull();
  });

  it("parses execution canary summaries", () => {
    const parsed = parseValidationScorecardSummary(
      JSON.stringify({
        repricingExits: 3,
        executionCanary24h: {
          required: true,
          eligible: false,
          minTotalFills: 10,
          blockers: [],
        },
      }),
    );

    expect(parsed?.repricingExits).toBe(3);
    expect(parsed?.executionCanary24h?.required).toBe(true);
  });
});

describe("promotion execution canary enforcement", () => {
  it("enforces hard blocking only for live-lite promotions", () => {
    const gate = evaluateExecutionCanaryGate({
      primaryCategory: "crypto",
      executionTelemetry: {
        totalFills: 12,
        volumeUsdc: 20,
        makerFills: 0,
        takerFills: 0,
        unknownFills: 12,
        makerRatio: 0,
        takerRatio: 0,
        explicitFeesUsdc: 0,
        feeLeakageRatio: 0,
        lastFillAt: "2026-04-03T00:00:00Z",
      },
    });

    expect(shouldEnforcePromotionExecutionCanary(ProfileId.Paper)).toBe(false);
    expect(shouldEnforcePromotionExecutionCanary(ProfileId.Simulation)).toBe(false);
    expect(shouldEnforcePromotionExecutionCanary(ProfileId.LiveLite)).toBe(true);
    expect(isPromotionBlockedByExecutionCanary(ProfileId.Paper, gate)).toBe(false);
    expect(isPromotionBlockedByExecutionCanary(ProfileId.LiveLite, gate)).toBe(true);
  });
});
