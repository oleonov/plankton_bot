import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTokenId } from "../ids.js";
import { isStaleSell, type StaleSellContext } from "../stale-sell.js";

interface PlanktonStaleFixture {
  readonly expected_stale: boolean;
  readonly metrics: {
    readonly sell_price: number | null;
    readonly best_ask: number | null;
    readonly lifecycle_s: number | null;
  };
}

interface KnownStuckFixture {
  readonly expected_stale: boolean;
  readonly metrics: {
    readonly current_sell_price?: number | null;
    readonly current_ask: number | null;
    readonly age_days: number;
    readonly reprice_chain_count_24h: number;
    readonly sell_fills: number;
  };
}

interface Point3Results {
  readonly fixtures: {
    readonly plankton_stale_positive_proxy: readonly PlanktonStaleFixture[];
    readonly plankton_stale_negative_proxy: readonly PlanktonStaleFixture[];
    readonly known_stuck_positions: readonly KnownStuckFixture[];
  };
}

const NOW_MS = Date.parse("2026-06-02T00:00:00Z");
const ASSET_ID = createTokenId("asset-stale-sell");

function loadPoint3Fixtures(): Point3Results {
  const file = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "research_plankton",
    "track_c",
    "point_3_stale_sell_detection_results.json",
  );
  return JSON.parse(readFileSync(file, "utf-8")) as Point3Results;
}

function ctx(overrides: Partial<StaleSellContext> = {}): StaleSellContext {
  return {
    assetId: ASSET_ID,
    sellPrice: 0.1,
    currentBid: 0.08,
    currentAsk: 0.1,
    sellPostedAt: NOW_MS - 10 * 60_000,
    repriceChainCount24h: 0,
    sellCount: 1,
    positionAgeMs: 10 * 60_000,
    livenessVerdict: "dead",
    ts: NOW_MS,
    ...overrides,
  };
}

function planktonCtx(fixture: PlanktonStaleFixture): StaleSellContext {
  const lifecycleMs = (fixture.metrics.lifecycle_s ?? 0) * 1000;
  return ctx({
    sellPrice: fixture.metrics.sell_price,
    currentAsk: fixture.metrics.best_ask,
    sellPostedAt: NOW_MS - lifecycleMs,
    positionAgeMs: lifecycleMs,
    repriceChainCount24h: 0,
    sellCount: 1,
  });
}

function stuckCtx(fixture: KnownStuckFixture): StaleSellContext {
  const ageMs = fixture.metrics.age_days * 24 * 60 * 60_000;
  return ctx({
    sellPrice: fixture.metrics.current_sell_price ?? null,
    currentAsk: fixture.metrics.current_ask,
    sellPostedAt: NOW_MS - ageMs,
    positionAgeMs: ageMs,
    repriceChainCount24h: fixture.metrics.reprice_chain_count_24h,
    sellCount: fixture.metrics.sell_fills,
  });
}

describe("isStaleSell", () => {
  it("returns price_only for the price branch only", () => {
    expect(
      isStaleSell(ctx({ sellPrice: 0.101, currentAsk: 0.1, sellPostedAt: NOW_MS - 31 * 60_000 })),
    ).toEqual({ stale: true, reason: "price_only" });
  });

  it("requires branded asset ids at compile time", () => {
    const brandedContext: StaleSellContext = ctx({ assetId: ASSET_ID });
    expect(brandedContext.assetId).toBe(ASSET_ID);

    // @ts-expect-error assetId must be TokenId, not a plain string.
    const plainContext: StaleSellContext = { ...brandedContext, assetId: "plain-asset" };
    expect(plainContext.assetId).toBe("plain-asset");
  });

  it("returns chain for the chain branch only", () => {
    expect(
      isStaleSell(
        ctx({
          sellPrice: 0.1,
          currentAsk: 0.1,
          repriceChainCount24h: 13,
          sellCount: 0,
          positionAgeMs: 12 * 60 * 60_000 + 1,
        }),
      ),
    ).toEqual({ stale: true, reason: "chain" });
  });

  it("returns chain+price when both branches fire", () => {
    expect(
      isStaleSell(
        ctx({
          sellPrice: 0.101,
          currentAsk: 0.1,
          sellPostedAt: NOW_MS - 31 * 60_000,
          repriceChainCount24h: 13,
          sellCount: 0,
          positionAgeMs: 12 * 60 * 60_000 + 1,
        }),
      ),
    ).toEqual({ stale: true, reason: "chain+price" });
  });

  it("returns none when neither branch fires", () => {
    expect(isStaleSell(ctx())).toEqual({ stale: false, reason: "none" });
  });

  it("classifies 20 Plankton stale-negative proxy fixtures as none", () => {
    const fixtures = loadPoint3Fixtures().fixtures.plankton_stale_negative_proxy;
    expect(fixtures).toHaveLength(20);
    for (const fixture of fixtures) {
      expect(isStaleSell(planktonCtx(fixture))).toEqual({ stale: false, reason: "none" });
    }
  });

  it("classifies 20 Plankton stale-positive proxy fixtures as price_only diagnostics", () => {
    const fixtures = loadPoint3Fixtures().fixtures.plankton_stale_positive_proxy;
    expect(fixtures).toHaveLength(20);
    for (const fixture of fixtures) {
      expect(isStaleSell(planktonCtx(fixture))).toEqual({ stale: true, reason: "price_only" });
    }
  });

  it("classifies the 5 known stuck positions as chain-bearing stale signals", () => {
    const fixtures = loadPoint3Fixtures().fixtures.known_stuck_positions;
    expect(fixtures).toHaveLength(5);
    for (const fixture of fixtures) {
      const verdict = isStaleSell(stuckCtx(fixture));
      expect(verdict.stale).toBe(true);
      expect(["chain", "chain+price"]).toContain(verdict.reason);
    }
  });
});
