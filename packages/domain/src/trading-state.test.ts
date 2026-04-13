import { describe, expect, it } from "vitest";
import { resolveTradingState } from "./trading-state.js";

describe("resolveTradingState", () => {
  it("returns PAUSED when runtime is paused", () => {
    expect(
      resolveTradingState({
        paused: true,
        signalWindow: null,
      }),
    ).toBe("PAUSED");
  });

  it("returns PROBING_ONLY when all active families are probe-only and entries are approved", () => {
    expect(
      resolveTradingState({
        signalWindow: {
          produced: 10,
          approved: 3,
          rejected: 7,
          entryApproved: 2,
          exitApproved: 1,
        },
        activeFamilies: {
          total: 2,
          probeOnly: 2,
        },
      }),
    ).toBe("PROBING_ONLY");
  });

  it("returns EXITS_ONLY before ALIVE_BUT_BLOCKED when only exit approvals exist", () => {
    expect(
      resolveTradingState({
        signalWindow: {
          produced: 20,
          approved: 1,
          rejected: 19,
          entryApproved: 0,
          exitApproved: 1,
        },
        activeFamilies: {
          total: 3,
          probeOnly: 0,
        },
      }),
    ).toBe("EXITS_ONLY");
  });

  it("returns ALIVE_BUT_BLOCKED when there are rejected signals and no approvals", () => {
    expect(
      resolveTradingState({
        signalWindow: {
          produced: 20,
          approved: 0,
          rejected: 20,
          entryApproved: 0,
          exitApproved: 0,
        },
        activeFamilies: {
          total: 3,
          probeOnly: 0,
        },
      }),
    ).toBe("ALIVE_BUT_BLOCKED");
  });
});
