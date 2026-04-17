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

  it("returns ACTIVELY_TRADING when entry approvals exist", () => {
    expect(
      resolveTradingState({
        signalWindow: {
          produced: 10,
          approved: 3,
          rejected: 7,
          entryApproved: 2,
          exitApproved: 1,
        },
      }),
    ).toBe("ACTIVELY_TRADING");
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
      }),
    ).toBe("ALIVE_BUT_BLOCKED");
  });
});
