import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeRepriceThreshold,
  REPRICE_THRESHOLD_FIXED_TICKS,
  type RepriceContext,
} from "../reprice-threshold.js";
import { createTokenId } from "../ids.js";

interface Point2Fixture {
  readonly expected_reprice_decision: boolean;
  readonly metrics: {
    readonly ask_movement_ticks_30m: number | null;
  };
}

interface Point2Results {
  readonly fixtures: {
    readonly alive_reprice_expected_true: readonly Point2Fixture[];
    readonly alive_reprice_expected_false: readonly Point2Fixture[];
    readonly stuck_positions: readonly Point2Fixture[];
  };
}

const NOW_MS = Date.parse("2026-06-02T00:00:00Z");
const ASSET_ID = createTokenId("asset-reprice");

function loadPoint2Fixtures(): Point2Results {
  const file = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "research_plankton",
    "track_c",
    "point_2_reprice_threshold_results.json",
  );
  return JSON.parse(readFileSync(file, "utf-8")) as Point2Results;
}

function ctx(overrides: Partial<RepriceContext> = {}): RepriceContext {
  return {
    assetId: ASSET_ID,
    subtype: "strike",
    currentSpread: 0.02,
    currentMid: 0.2,
    livenessVerdict: "live",
    capturedAt: NOW_MS,
    ts: NOW_MS,
    ...overrides,
  };
}

describe("computeRepriceThreshold", () => {
  it("returns fixed_3 when liveness is live and subtype is strike", () => {
    expect(computeRepriceThreshold(ctx())).toEqual({
      shouldReprice: true,
      tickThreshold: 3,
      reason: "fixed_3_live_strike",
    });
  });

  it("requires branded asset ids at compile time", () => {
    const brandedContext: RepriceContext = ctx({ assetId: ASSET_ID });
    expect(brandedContext.assetId).toBe(ASSET_ID);

    // @ts-expect-error assetId must be TokenId, not a plain string.
    const plainContext: RepriceContext = { ...brandedContext, assetId: "plain-asset" };
    expect(plainContext.assetId).toBe("plain-asset");
  });

  it("gates reprice when liveness is dead", () => {
    expect(computeRepriceThreshold(ctx({ livenessVerdict: "dead" }))).toEqual({
      shouldReprice: false,
      tickThreshold: null,
      reason: "liveness_dead",
    });
  });

  it("gates reprice when captured market data is stale", () => {
    expect(computeRepriceThreshold(ctx({ capturedAt: NOW_MS - 10 * 60_000 - 1 }))).toEqual({
      shouldReprice: false,
      tickThreshold: null,
      reason: "stale_market_data_fallback",
    });
  });

  it("keeps Phase 1 subtype mapping binary and leaves non-strike on fallback", () => {
    expect(computeRepriceThreshold(ctx({ subtype: "non-strike" }))).toEqual({
      shouldReprice: false,
      tickThreshold: null,
      reason: "non_strike_static_fallback",
    });
  });

  it("matches the 30 expected-true Point 2 counter-factual anchors", () => {
    const fixtures = loadPoint2Fixtures().fixtures.alive_reprice_expected_true;
    expect(fixtures).toHaveLength(30);
    const decision = computeRepriceThreshold(ctx());
    expect(decision.tickThreshold).toBe(REPRICE_THRESHOLD_FIXED_TICKS);
    for (const fixture of fixtures) {
      expect(fixture.metrics.ask_movement_ticks_30m ?? 0).toBeGreaterThanOrEqual(
        decision.tickThreshold!,
      );
    }
  });

  it("matches the 30 expected-false Point 2 counter-factual anchors", () => {
    const fixtures = loadPoint2Fixtures().fixtures.alive_reprice_expected_false;
    expect(fixtures).toHaveLength(30);
    const decision = computeRepriceThreshold(ctx());
    expect(decision.tickThreshold).toBe(REPRICE_THRESHOLD_FIXED_TICKS);
    for (const fixture of fixtures) {
      expect(fixture.metrics.ask_movement_ticks_30m ?? 0).toBeLessThan(decision.tickThreshold!);
    }
  });

  it("keeps the 5 stuck positions gated by liveness before Point 2 acts", () => {
    const fixtures = loadPoint2Fixtures().fixtures.stuck_positions;
    expect(fixtures).toHaveLength(5);
    const decision = computeRepriceThreshold(ctx({ livenessVerdict: "dead" }));
    expect(decision.shouldReprice).toBe(false);
    for (const fixture of fixtures) {
      expect(fixture.expected_reprice_decision).toBe(false);
    }
  });
});
