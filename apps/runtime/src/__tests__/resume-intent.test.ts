import { describe, it, expect } from "vitest";
import { evaluateResumeIntent, type ResumeIntentInput } from "../resume-intent.js";

const NOW = new Date("2026-04-01T12:00:00Z").getTime();

function input(overrides: Partial<ResumeIntentInput> = {}): ResumeIntentInput {
  return {
    intentAt: new Date(NOW - 2 * 60 * 1000).toISOString(), // 2 min ago
    nowMs: NOW,
    hasActiveSwitch: false,
    desiredProfile: "paper",
    activeProfile: "paper",
    ...overrides,
  };
}

describe("evaluateResumeIntent", () => {
  it("returns resume when intent is fresh and conditions are met", () => {
    const result = evaluateResumeIntent(input());
    expect(result.action).toBe("resume");
  });

  it("returns no_intent when intentAt is null", () => {
    const result = evaluateResumeIntent(input({ intentAt: null }));
    expect(result).toEqual({ action: "no_intent" });
  });

  it("returns stay_paused when intent is expired (>15 min)", () => {
    const result = evaluateResumeIntent(
      input({ intentAt: new Date(NOW - 20 * 60 * 1000).toISOString() }),
    );
    expect(result.action).toBe("stay_paused");
    expect(result).toHaveProperty("reason", "intent expired");
  });

  it("returns stay_paused when active switch in progress", () => {
    const result = evaluateResumeIntent(input({ hasActiveSwitch: true }));
    expect(result.action).toBe("stay_paused");
    expect(result).toHaveProperty("reason", "active profile switch in progress");
  });

  it("returns stay_paused when desired profile differs from active", () => {
    const result = evaluateResumeIntent(
      input({ desiredProfile: "live-lite", activeProfile: "paper" }),
    );
    expect(result.action).toBe("stay_paused");
    expect(result).toHaveProperty("reason", "profile mismatch");
  });

  it("resumes when desired profile is null (no switch requested)", () => {
    const result = evaluateResumeIntent(input({ desiredProfile: null }));
    expect(result.action).toBe("resume");
  });

  it("resumes at exactly 15 min (boundary)", () => {
    const result = evaluateResumeIntent(
      input({ intentAt: new Date(NOW - 15 * 60 * 1000).toISOString() }),
    );
    expect(result.action).toBe("stay_paused");
  });

  it("resumes at just under 15 min", () => {
    const result = evaluateResumeIntent(
      input({ intentAt: new Date(NOW - 15 * 60 * 1000 + 1000).toISOString() }),
    );
    expect(result.action).toBe("resume");
  });
});
