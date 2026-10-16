import { describe, expect, it } from "vitest";
import { createTokenId } from "../ids.js";
import { decideExitAction, isFloorEligible, type ExitDecisionContext } from "../exit-decision.js";
import type { StaleVerdict } from "../stale-sell.js";

const NOW_MS = Date.parse("2026-06-02T00:00:00Z");
const TOKEN_ID = createTokenId("track-c-token-1");

function stale(reason: StaleVerdict["reason"]): StaleVerdict {
  return {
    stale: reason !== "none",
    reason,
  };
}

function ctx(overrides: Partial<ExitDecisionContext> = {}): ExitDecisionContext {
  return {
    tokenId: TOKEN_ID,
    positionPnLRatio: 0.05,
    livenessVerdict: "dead",
    staleVerdict: stale("chain"),
    positionAgeMs: 2 * 24 * 60 * 60_000,
    ttcResolutionMs: 24 * 60 * 60_000,
    subtype: "strike",
    exitPnlPct: -0.95,
    floorIntentState: { active: false, attemptCount: 0 },
    ts: NOW_MS,
    ...overrides,
  };
}

describe("decideExitAction", () => {
  it("defaults unknown liveness to pass-through continue_normal", () => {
    const decision = decideExitAction(
      ctx({
        livenessVerdict: "unknown",
        staleVerdict: stale("chain"),
      }),
    );

    expect(decision.action).toBe("continue_normal");
    expect(decision.reason).toBe("unknown_degrade_normal");
  });

  it.each([
    [
      "unknown + none",
      ctx({ livenessVerdict: "unknown", staleVerdict: stale("none") }),
      "continue_normal",
    ],
    [
      "unknown + chain",
      ctx({ livenessVerdict: "unknown", staleVerdict: stale("chain") }),
      "continue_normal",
    ],
    [
      "live + chain",
      ctx({ livenessVerdict: "live", staleVerdict: stale("chain") }),
      "continue_normal",
    ],
    [
      "dead + price_only",
      ctx({ livenessVerdict: "dead", staleVerdict: stale("price_only") }),
      "continue_passive_sit",
    ],
    [
      "dead + none",
      ctx({ livenessVerdict: "dead", staleVerdict: stale("none") }),
      "continue_passive_sit",
    ],
    [
      "dead + chain",
      ctx({ livenessVerdict: "dead", staleVerdict: stale("chain") }),
      "hold_resolution",
    ],
    [
      "dead + chain+price",
      ctx({ livenessVerdict: "dead", staleVerdict: stale("chain+price") }),
      "hold_resolution",
    ],
  ] as const)("matrix row %s -> %s", (_label, input, expectedAction) => {
    expect(decideExitAction(input).action).toBe(expectedAction);
  });

  it("hard rule: DEAD + price_only never returns floor_close", () => {
    const decision = decideExitAction(
      ctx({
        staleVerdict: stale("price_only"),
        floorCloseRatioThreshold: 0.1,
      }),
    );
    expect(decision.action).toBe("continue_passive_sit");
    expect(decision.reason).toBe("dead_price_only_observability");
  });

  it("uses hold_resolution when Phase 1 floor_close is disabled", () => {
    const decision = decideExitAction(
      ctx({
        staleVerdict: stale("chain"),
        floorCloseRatioThreshold: 0.1,
        positionPnLRatio: 0.01,
      }),
    );
    expect(decision.action).toBe("hold_resolution");
    expect(decision.reason).toBe("phase_1_floor_disabled");
  });

  it("returns a holdResolutionRequest for hold_resolution actions", () => {
    const decision = decideExitAction(
      ctx({
        ttcResolutionMs: 6 * 60 * 60_000,
      }),
    );

    expect(decision.action).toBe("hold_resolution");
    expect(decision.holdResolutionRequest).toEqual({
      tokenId: TOKEN_ID,
      expectedResolutionAt: NOW_MS + 6 * 60 * 60_000,
      reason: "dead_chain_hold_resolution",
    });
  });

  it("requires branded token ids at compile time", () => {
    const brandedContext: ExitDecisionContext = ctx({ tokenId: TOKEN_ID });
    expect(brandedContext.tokenId).toBe(TOKEN_ID);

    // @ts-expect-error tokenId must be TokenId, not a plain string.
    const plainContext: ExitDecisionContext = { ...brandedContext, tokenId: "plain-token" };
    expect(plainContext.tokenId).toBe("plain-token");
  });

  it("guards floor eligibility by stale reason, independent of matrix ordering", () => {
    expect(
      isFloorEligible(
        ctx({
          staleVerdict: stale("price_only"),
          floorCloseRatioThreshold: 0.1,
          positionPnLRatio: 0.01,
        }),
      ),
    ).toBe(false);
  });

  it("does not return floor_close even when a historical threshold is present", () => {
    const decision = decideExitAction(
      ctx({
        staleVerdict: stale("chain"),
        floorCloseRatioThreshold: 0.1,
        positionPnLRatio: 0.01,
      }),
    );
    expect(decision.action).toBe("hold_resolution");
    expect(decision.reason).toBe("phase_1_floor_disabled");
  });

  it("does not create duplicate hold action when hold state is already active", () => {
    const decision = decideExitAction(
      ctx({
        holdResolutionState: { active: true },
      }),
    );
    expect(decision.action).toBe("hold_resolution");
    expect(decision.reason).toBe("hold_resolution_active");
  });

  it("maps the Pt4 v5 Section D matrix rows", () => {
    expect(
      decideExitAction(ctx({ livenessVerdict: "live", staleVerdict: stale("chain") })).action,
    ).toBe("continue_normal");
    expect(
      decideExitAction(ctx({ livenessVerdict: "dead", staleVerdict: stale("none") })).action,
    ).toBe("continue_passive_sit");
    expect(
      decideExitAction(ctx({ livenessVerdict: "dead", staleVerdict: stale("price_only") })).action,
    ).toBe("continue_passive_sit");
    expect(
      decideExitAction(ctx({ livenessVerdict: "dead", staleVerdict: stale("chain") })).action,
    ).toBe("hold_resolution");
    expect(
      decideExitAction(ctx({ livenessVerdict: "dead", staleVerdict: stale("chain+price") })).action,
    ).toBe("hold_resolution");
  });
});
