import { describe, expect, it } from "vitest";
import {
  DEFAULT_R23_DIP_TRIGGER_POLICY,
  evaluateR23DipTrigger,
  R23_DIP_FIRED_REASON,
  R23_DISABLED_REASON,
  R23_EXISTING_POSITION_REASON,
  R23_INVALID_PRICE_REASON,
  R23_NO_DIP_REASON,
  R23_NO_HISTORY_REASON,
} from "../index.js";

describe("evaluateR23DipTrigger", () => {
  it("fires for a 50% dip with a valid 24h peak", () => {
    const result = evaluateR23DipTrigger(
      { state: "OTHER", currentMidpoint: 0.1, maxMidpointInWindow: 0.2 },
      DEFAULT_R23_DIP_TRIGGER_POLICY,
    );

    expect(result).toMatchObject({
      fire: true,
      reason: R23_DIP_FIRED_REASON,
      ratio: 0.5,
      maxMidpoint: 0.2,
    });
  });

  it("does not fire for a 20% dip", () => {
    const result = evaluateR23DipTrigger(
      { state: "OTHER", currentMidpoint: 0.8, maxMidpointInWindow: 1 },
      DEFAULT_R23_DIP_TRIGGER_POLICY,
    );

    expect(result.fire).toBe(false);
    expect(result.reason).toBe(R23_NO_DIP_REASON);
    expect(result.ratio).toBe(0.8);
  });

  it("fires at the exact 0.683 boundary", () => {
    const result = evaluateR23DipTrigger(
      { state: "OTHER", currentMidpoint: 0.683, maxMidpointInWindow: 1 },
      DEFAULT_R23_DIP_TRIGGER_POLICY,
    );

    expect(result.fire).toBe(true);
    expect(result.reason).toBe(R23_DIP_FIRED_REASON);
  });

  it("does not fire just under the calibrated drop", () => {
    const result = evaluateR23DipTrigger(
      { state: "OTHER", currentMidpoint: 0.685, maxMidpointInWindow: 1 },
      DEFAULT_R23_DIP_TRIGGER_POLICY,
    );

    expect(result.fire).toBe(false);
    expect(result.reason).toBe(R23_NO_DIP_REASON);
  });

  it("does not fire without history", () => {
    const result = evaluateR23DipTrigger(
      { state: "OTHER", currentMidpoint: 0.1, maxMidpointInWindow: null },
      DEFAULT_R23_DIP_TRIGGER_POLICY,
    );

    expect(result).toEqual({
      fire: false,
      reason: R23_NO_HISTORY_REASON,
      ratio: null,
      maxMidpoint: null,
    });
  });

  it("does not fire on existing positions", () => {
    const result = evaluateR23DipTrigger(
      { state: "S1", currentMidpoint: 0.1, maxMidpointInWindow: 0.2 },
      DEFAULT_R23_DIP_TRIGGER_POLICY,
    );

    expect(result.fire).toBe(false);
    expect(result.reason).toBe(R23_EXISTING_POSITION_REASON);
  });

  it("does not fire when config disabled", () => {
    const result = evaluateR23DipTrigger(
      { state: "OTHER", currentMidpoint: 0.1, maxMidpointInWindow: 0.2 },
      { ...DEFAULT_R23_DIP_TRIGGER_POLICY, enabled: false },
    );

    expect(result).toEqual({
      fire: false,
      reason: R23_DISABLED_REASON,
      ratio: null,
      maxMidpoint: null,
    });
  });

  it("does not fire on invalid current price", () => {
    const result = evaluateR23DipTrigger(
      { state: "OTHER", currentMidpoint: 0, maxMidpointInWindow: 0.2 },
      DEFAULT_R23_DIP_TRIGGER_POLICY,
    );

    expect(result.fire).toBe(false);
    expect(result.reason).toBe(R23_INVALID_PRICE_REASON);
  });
});
