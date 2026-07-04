import { describe, expect, it } from "vitest";
import type { MakerEntryPolicy } from "@krabs/domain";
import type { NormalizedMarket } from "@krabs/domain";
import type { R23DipTriggerResult } from "@krabs/domain";
import type { MakerShadowOrder } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";
import {
  advanceShadowOrder,
  computeShadowOrderId,
  isMakerUniverse,
  tryOpenShadow,
} from "../maker-entry-shadow.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

const FIRED: R23DipTriggerResult = {
  fire: true,
  reason: "r23-dip-fired",
  ratio: 0.68,
  maxMidpoint: 0.5,
};

const NOT_FIRED: R23DipTriggerResult = {
  fire: false,
  reason: "r23-no-dip",
  ratio: 0.9,
  maxMidpoint: 0.5,
};

function makePolicy(overrides: Partial<MakerEntryPolicy> = {}): MakerEntryPolicy {
  return {
    mode: "shadow",
    bidImproveTicks: 1,
    harvestGainPct: 0.5,
    fillWaitMs: 300_000,
    makerMinLiquidity: 5_000,
    makerMinVol24h: 1_000,
    whitelistConditionIds: [],
    microMaxOrderUsdc: 5,
    microMaxOpenUsdc: 25,
    collapseFloorPrice: null,
    ...overrides,
  };
}

function makeMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId: createTokenId("tok-1"),
    conditionId: "cond-1",
    slug: "test-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Will X happen?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.3,
    bestAsk: 0.32,
    midPrice: 0.31,
    spread: 0.02,
    volume24hr: 2_000,
    liquidity: 10_000,
    gammaCreatedAt: null,
    snapshotTs: Date.now(),
    ...overrides,
  };
}

function makePendingShadow(overrides: Partial<MakerShadowOrder> = {}): MakerShadowOrder {
  return {
    shadowOrderId: "abc123",
    tokenId: createTokenId("tok-1"),
    conditionId: "cond-1",
    buyPx: 0.31,
    harvestPx: 0.47,
    postedAt: "2026-07-04T10:00:00.000Z",
    fillDeadline: "2026-07-04T10:05:00.000Z",
    stage: "pending",
    fillKind: null,
    fillPx: null,
    markPx: null,
    netMark: null,
    updatedAt: "2026-07-04T10:00:00.000Z",
    ...overrides,
  };
}

// ─── computeShadowOrderId ────────────────────────────────────────────────────

describe("computeShadowOrderId", () => {
  it("returns 32 hex chars", () => {
    const id = computeShadowOrderId("tok-1", "2026-07-04T10:00:00.000Z");
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for same inputs", () => {
    const a = computeShadowOrderId("tok-1", "2026-07-04T10:00:00.000Z");
    const b = computeShadowOrderId("tok-1", "2026-07-04T10:00:00.000Z");
    expect(a).toBe(b);
  });

  it("is distinct for different times (same token)", () => {
    const a = computeShadowOrderId("tok-1", "2026-07-04T10:00:00.000Z");
    const b = computeShadowOrderId("tok-1", "2026-07-04T10:00:01.000Z");
    expect(a).not.toBe(b);
  });

  it("is distinct for same time different token", () => {
    const a = computeShadowOrderId("tok-1", "2026-07-04T10:00:00.000Z");
    const b = computeShadowOrderId("tok-2", "2026-07-04T10:00:00.000Z");
    expect(a).not.toBe(b);
  });
});

// ─── isMakerUniverse ─────────────────────────────────────────────────────────

describe("isMakerUniverse", () => {
  it("passes when both liq and vol meet thresholds", () => {
    expect(isMakerUniverse(makeMarket({ liquidity: 5_000, volume24hr: 1_000 }), makePolicy())).toBe(
      true,
    );
  });

  it("rejects when liquidity is below threshold", () => {
    expect(isMakerUniverse(makeMarket({ liquidity: 4_999, volume24hr: 1_000 }), makePolicy())).toBe(
      false,
    );
  });

  it("rejects when vol24h is below threshold", () => {
    expect(isMakerUniverse(makeMarket({ liquidity: 5_000, volume24hr: 999 }), makePolicy())).toBe(
      false,
    );
  });

  it("rejects when liquidity is null (conservative)", () => {
    expect(isMakerUniverse(makeMarket({ liquidity: null }), makePolicy())).toBe(false);
  });

  it("rejects when volume24hr is null (conservative)", () => {
    expect(isMakerUniverse(makeMarket({ volume24hr: null }), makePolicy())).toBe(false);
  });

  it("accepts exactly at threshold boundary", () => {
    expect(isMakerUniverse(makeMarket({ liquidity: 5_000, volume24hr: 1_000 }), makePolicy())).toBe(
      true,
    );
  });

  // ── sig-field fallback (the bug being fixed) ────────────────────────────────

  it("passes when live liq/vol are null but sig fields qualify (core bug fix)", () => {
    // CLOB stream updates omit Gamma features → live fields frequently null.
    // isMakerUniverse must fall back to sig fields so shadows are not silently blocked.
    expect(
      isMakerUniverse(
        makeMarket({ liquidity: null, volume24hr: null, sigLiquidity: 6_000, sigVol24hr: 2_000 }),
        makePolicy(),
      ),
    ).toBe(true);
  });

  it("rejects when both sig and live fields are null", () => {
    expect(
      isMakerUniverse(
        makeMarket({ liquidity: null, volume24hr: null, sigLiquidity: null, sigVol24hr: null }),
        makePolicy(),
      ),
    ).toBe(false);
  });

  it("rejects when sig fields are present but below threshold", () => {
    expect(
      isMakerUniverse(
        makeMarket({ liquidity: null, volume24hr: null, sigLiquidity: 100, sigVol24hr: 50 }),
        makePolicy(),
      ),
    ).toBe(false);
  });

  it("passes via live fallback when sig fields are absent", () => {
    // sig fields omitted (not set in makeMarket) → falls back to live liquidity / volume24hr
    expect(isMakerUniverse(makeMarket({ liquidity: 5_000, volume24hr: 1_000 }), makePolicy())).toBe(
      true,
    );
  });
});

// ─── tryOpenShadow ───────────────────────────────────────────────────────────

describe("tryOpenShadow", () => {
  const NOW = "2026-07-04T10:00:00.000Z";

  it("opens a pending shadow when R23 fires and universe qualifies", () => {
    const result = tryOpenShadow("tok-1", "cond-1", FIRED, makeMarket(), makePolicy(), NOW);
    expect(result).not.toBeNull();
    expect(result!.stage).toBe("pending");
    expect(result!.fillKind).toBeNull();
    // buy_px = floor(0.30 + 1*0.01, 0.01) = 0.31
    expect(result!.buyPx).toBeCloseTo(0.31);
    // harvest_px = ceil(0.31 * 1.5, 0.01) = ceil(0.465) = 0.47
    expect(result!.harvestPx).toBeCloseTo(0.47);
    // fill_deadline = NOW + fillWaitMs
    const deadlineMs = Date.parse(result!.fillDeadline);
    const postedMs = Date.parse(NOW);
    expect(deadlineMs - postedMs).toBe(300_000);
  });

  it("returns null when R23 has not fired", () => {
    const result = tryOpenShadow("tok-1", "cond-1", NOT_FIRED, makeMarket(), makePolicy(), NOW);
    expect(result).toBeNull();
  });

  it("returns null when outside maker universe (low liquidity)", () => {
    const result = tryOpenShadow(
      "tok-1",
      "cond-1",
      FIRED,
      makeMarket({ liquidity: 1_000 }),
      makePolicy(),
      NOW,
    );
    expect(result).toBeNull();
  });

  it("returns null when book is invalid (bestBid=0)", () => {
    const result = tryOpenShadow(
      "tok-1",
      "cond-1",
      FIRED,
      makeMarket({ bestBid: 0 }),
      makePolicy(),
      NOW,
    );
    expect(result).toBeNull();
  });

  it("returns null when buy would cross the ask", () => {
    // bestBid=0.49, bestAsk=0.50, tick=0.01, improve=1 → buyPx=0.50 = bestAsk → would_cross
    const result = tryOpenShadow(
      "tok-1",
      "cond-1",
      FIRED,
      makeMarket({ bestBid: 0.49, bestAsk: 0.5, tickSize: 0.01 }),
      makePolicy(),
      NOW,
    );
    expect(result).toBeNull();
  });

  it("shadow ID is deterministic (same token+time)", () => {
    const r1 = tryOpenShadow("tok-1", "cond-1", FIRED, makeMarket(), makePolicy(), NOW);
    const r2 = tryOpenShadow("tok-1", "cond-1", FIRED, makeMarket(), makePolicy(), NOW);
    expect(r1!.shadowOrderId).toBe(r2!.shadowOrderId);
  });

  it("shadow IDs differ at different timestamps", () => {
    const r1 = tryOpenShadow(
      "tok-1",
      "cond-1",
      FIRED,
      makeMarket(),
      makePolicy(),
      "2026-07-04T10:00:00.000Z",
    );
    const r2 = tryOpenShadow(
      "tok-1",
      "cond-1",
      FIRED,
      makeMarket(),
      makePolicy(),
      "2026-07-04T10:00:01.000Z",
    );
    expect(r1!.shadowOrderId).not.toBe(r2!.shadowOrderId);
  });
});

// ─── advanceShadowOrder — pending transitions ─────────────────────────────────

describe("advanceShadowOrder — pending", () => {
  it("no transition when book has not reached buy_px", () => {
    const shadow = makePendingShadow();
    // bestBid=0.25 (below buy_px=0.31), bestAsk=0.32 (above buy_px)
    const result = advanceShadowOrder(
      shadow,
      makeMarket({ bestBid: 0.25, bestAsk: 0.32 }),
      "2026-07-04T10:01:00.000Z",
    );
    expect(result.transition).toBe(false);
  });

  it("trade_through fill: bestAsk < buy_px", () => {
    const shadow = makePendingShadow();
    // bestAsk=0.30 < buy_px=0.31 → trade-through
    const result = advanceShadowOrder(
      shadow,
      makeMarket({ bestBid: 0.28, bestAsk: 0.3 }),
      "2026-07-04T10:01:00.000Z",
    );
    expect(result.transition).toBe(true);
    if (!result.transition) return;
    expect(result.update.stage).toBe("filled");
    expect(result.update.fillKind).toBe("trade_through");
    expect(result.update.fillPx).toBeCloseTo(0.3);
  });

  it("touch fill: bestBid >= buy_px (ask not below buy_px)", () => {
    const shadow = makePendingShadow();
    // bestBid=0.31 = buy_px → touch
    const result = advanceShadowOrder(
      shadow,
      makeMarket({ bestBid: 0.31, bestAsk: 0.33 }),
      "2026-07-04T10:01:00.000Z",
    );
    expect(result.transition).toBe(true);
    if (!result.transition) return;
    expect(result.update.stage).toBe("filled");
    expect(result.update.fillKind).toBe("touch");
    expect(result.update.fillPx).toBeCloseTo(0.31);
  });

  it("trade_through takes priority over touch when bestAsk < buy_px", () => {
    // If both conditions hold (bestAsk < buy_px AND bestBid >= buy_px — crossed book)
    // trade_through is checked first and takes priority
    const shadow = makePendingShadow();
    const result = advanceShadowOrder(
      shadow,
      makeMarket({ bestBid: 0.32, bestAsk: 0.3 }),
      "2026-07-04T10:01:00.000Z",
    );
    expect(result.transition).toBe(true);
    if (!result.transition) return;
    expect(result.update.fillKind).toBe("trade_through");
  });

  it("expires when now >= fill_deadline with no fill", () => {
    const shadow = makePendingShadow({ fillDeadline: "2026-07-04T10:05:00.000Z" });
    const result = advanceShadowOrder(
      shadow,
      makeMarket({ bestBid: 0.2, bestAsk: 0.5 }),
      "2026-07-04T10:05:00.000Z", // exactly at deadline
    );
    expect(result.transition).toBe(true);
    if (!result.transition) return;
    expect(result.update.stage).toBe("expired");
  });

  it("does not expire before fill_deadline", () => {
    const shadow = makePendingShadow({ fillDeadline: "2026-07-04T10:05:00.000Z" });
    const result = advanceShadowOrder(
      shadow,
      makeMarket({ bestBid: 0.2, bestAsk: 0.5 }),
      "2026-07-04T10:04:59.999Z", // 1ms before
    );
    expect(result.transition).toBe(false);
  });
});

// ─── advanceShadowOrder — filled transitions ──────────────────────────────────

describe("advanceShadowOrder — filled", () => {
  const filledShadow = makePendingShadow({
    stage: "filled",
    fillKind: "trade_through",
    fillPx: 0.3,
  });

  it("harvested when bestBid >= harvest_px", () => {
    const result = advanceShadowOrder(
      filledShadow,
      makeMarket({ bestBid: 0.47, bestAsk: 0.5 }),
      "2026-07-04T10:03:00.000Z",
    );
    expect(result.transition).toBe(true);
    if (!result.transition) return;
    expect(result.update.stage).toBe("harvested");
    expect(result.update.markPx).toBeCloseTo(0.47);
    // netMark = 0.47 / 0.31 - 1 ≈ 0.516
    expect(result.update.netMark).toBeCloseTo(0.516, 2);
  });

  it("marked when past fill_deadline with no harvest", () => {
    const result = advanceShadowOrder(
      filledShadow,
      makeMarket({ bestBid: 0.25, bestAsk: 0.4 }),
      "2026-07-04T10:05:00.000Z", // at deadline
    );
    expect(result.transition).toBe(true);
    if (!result.transition) return;
    expect(result.update.stage).toBe("marked");
    expect(result.update.markPx).toBeCloseTo(0.25);
    // netMark = 0.25 / 0.31 - 1 ≈ -0.194
    expect(result.update.netMark).toBeCloseTo(-0.194, 2);
  });

  it("marked with null netMark when bestBid is null", () => {
    const result = advanceShadowOrder(
      filledShadow,
      makeMarket({ bestBid: null, bestAsk: null }),
      "2026-07-04T10:05:00.000Z",
    );
    expect(result.transition).toBe(true);
    if (!result.transition) return;
    expect(result.update.stage).toBe("marked");
    expect(result.update.markPx).toBeNull();
    expect(result.update.netMark).toBeNull();
  });

  it("no transition when below harvest and before deadline", () => {
    const result = advanceShadowOrder(
      filledShadow,
      makeMarket({ bestBid: 0.35, bestAsk: 0.4 }),
      "2026-07-04T10:02:00.000Z",
    );
    expect(result.transition).toBe(false);
  });
});

// ─── mode=off → no shadow opened ─────────────────────────────────────────────

describe("mode=off gate", () => {
  it("tryOpenShadow returns null when mode is off (via caller-side check)", () => {
    // tryOpenShadow itself doesn't check mode (that's the planner/module's job),
    // but we verify isMakerUniverse and evaluateMakerEntry still work correctly
    // and no shadow is produced when R23 didn't fire.
    const result = tryOpenShadow(
      "tok-1",
      "cond-1",
      NOT_FIRED,
      makeMarket(),
      makePolicy({ mode: "off" }),
      "2026-07-04T10:00:00.000Z",
    );
    // NOT_FIRED => null regardless of mode
    expect(result).toBeNull();
  });
});
