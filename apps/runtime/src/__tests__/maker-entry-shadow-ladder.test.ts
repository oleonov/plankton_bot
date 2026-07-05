/**
 * Phase 1 maker-entry shadow ladder tests.
 *
 * Covers:
 *  1. shouldOpenNextLevel: open on ≥step drop; reject 1-tick-spread; reject at max; reject <step
 *  2. advanceShadowOrder: filled_at set at pending→filled; mark uses filled_at+holdWindowMs
 *  3. openNextLevelOrder: returns correct level with expected fields
 *  4. advanceShadowOrder: each level progresses independently
 */

import { describe, expect, it } from "vitest";
import {
  shouldOpenNextLevel,
  openNextLevelOrder,
  advanceShadowOrder,
  computeShadowOrderId,
} from "../modules/algo-decision/maker-entry-shadow.js";
import type { MakerShadowOrder } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";
import type { MakerEntryPolicy } from "@krabs/domain";
import type { NormalizedMarket } from "@krabs/domain";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TOKEN_ID = createTokenId("tok-ladder");
const COND_ID = "cond-ladder-1";

const BASE_POLICY: MakerEntryPolicy = {
  mode: "shadow",
  bidImproveTicks: 1,
  harvestGainPct: 0.2,
  fillWaitMs: 7_200_000, // 2h
  holdWindowMs: 10_800_000, // 3h
  makerMinLiquidity: 100,
  makerMinVol24h: 50,
  maxScaleInLevels: 4,
  scaleInStepPct: 0.1,
  whitelistConditionIds: [],
  microMaxOrderUsdc: 10,
  microMaxOpenUsdc: 20,
  collapseFloorPrice: 0.05,
};

function makeLevel(
  overrides: Partial<MakerShadowOrder> & { shadowOrderId?: string } = {},
): MakerShadowOrder {
  const now = "2026-07-05T10:00:00.000Z";
  return {
    shadowOrderId: computeShadowOrderId("tok-ladder", now),
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    buyPx: 0.5,
    harvestPx: 0.6,
    postedAt: now,
    fillDeadline: "2026-07-05T12:00:00.000Z",
    stage: "pending",
    fillKind: null,
    fillPx: null,
    markPx: null,
    netMark: null,
    ladderId: computeShadowOrderId("tok-ladder", now),
    levelIndex: 0,
    filledAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function makeMarket(bestBid: number, bestAsk: number, tickSize = 0.01): NormalizedMarket {
  return {
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    slug: "test-ladder-market",
    eventSlug: null,
    question: "Test?",
    outcome: "Yes",
    outcomeIndex: 0,
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize,
    negRisk: false,
    bestBid,
    bestAsk,
    lastPrice: null,
    volume24hr: 200,
    liquidity: 500,
    sigLiquidity: 500,
    sigVol24hr: 200,
    sigMid: null,
    sigCheapMid: null,
    sigFeaturesAt: null,
    score: null,
    scoreModelVersion: null,
    scoredAt: null,
    featuresCapuredAt: null,
  } as unknown as NormalizedMarket;
}

// ─── shouldOpenNextLevel ──────────────────────────────────────────────────────

describe("shouldOpenNextLevel", () => {
  it("returns true when candidate is ≥ step% below the last entry", () => {
    // last entry = 0.50, step=10% → threshold = 0.45
    // bestBid=0.43, bestAsk=0.55, tickSize=0.01 → buyPx = floor(0.43+0.01*1, 0.01) = 0.44 ≤ 0.45 ✓
    const level0 = makeLevel({ buyPx: 0.5, levelIndex: 0 });
    const book = { bestBid: 0.43, bestAsk: 0.55, tickSize: 0.01 };
    expect(shouldOpenNextLevel([level0], book, BASE_POLICY)).toBe(true);
  });

  it("returns false when candidate is less than step% below the last entry", () => {
    // last entry = 0.50, step=10% → threshold = 0.45
    // bestBid=0.47, bestAsk=0.55, tickSize=0.01 → buyPx=0.48 > 0.45 ✗
    const level0 = makeLevel({ buyPx: 0.5, levelIndex: 0 });
    const book = { bestBid: 0.47, bestAsk: 0.55, tickSize: 0.01 };
    expect(shouldOpenNextLevel([level0], book, BASE_POLICY)).toBe(false);
  });

  it("returns false at max levels", () => {
    const levels = Array.from({ length: BASE_POLICY.maxScaleInLevels }, (_, i) =>
      makeLevel({ buyPx: 0.5 - i * 0.07, levelIndex: i }),
    );
    const book = { bestBid: 0.2, bestAsk: 0.55, tickSize: 0.01 };
    expect(shouldOpenNextLevel(levels, book, BASE_POLICY)).toBe(false);
  });

  it("rejects 1-tick spread where buyPx >= bestAsk", () => {
    // bestBid=0.49, bestAsk=0.50 (1-tick spread), bidImproveTicks=1, tickSize=0.01
    // buyPx = floor(0.49 + 0.01, 0.01) = 0.50 = bestAsk → would cross → reject
    const level0 = makeLevel({ buyPx: 0.6, levelIndex: 0 }); // last entry at 0.60 — large step still needed
    const book = { bestBid: 0.49, bestAsk: 0.5, tickSize: 0.01 };
    expect(shouldOpenNextLevel([level0], book, BASE_POLICY)).toBe(false);
  });

  it("returns false when BBO is invalid (bestAsk <= bestBid)", () => {
    const level0 = makeLevel({ buyPx: 0.5, levelIndex: 0 });
    const book = { bestBid: 0.55, bestAsk: 0.5, tickSize: 0.01 };
    expect(shouldOpenNextLevel([level0], book, BASE_POLICY)).toBe(false);
  });

  it("returns false when bestBid is zero", () => {
    const level0 = makeLevel({ buyPx: 0.5, levelIndex: 0 });
    const book = { bestBid: 0, bestAsk: 0.55, tickSize: 0.01 };
    expect(shouldOpenNextLevel([level0], book, BASE_POLICY)).toBe(false);
  });

  it("returns false for empty ladder", () => {
    const book = { bestBid: 0.4, bestAsk: 0.55, tickSize: 0.01 };
    expect(shouldOpenNextLevel([], book, BASE_POLICY)).toBe(false);
  });

  it("counts all levels (incl. terminal) toward the cap", () => {
    // 3 terminal levels, cap=4: one slot remaining
    const levels = [
      makeLevel({ buyPx: 0.5, levelIndex: 0, stage: "expired" }),
      makeLevel({ buyPx: 0.42, levelIndex: 1, stage: "marked" }),
      makeLevel({ buyPx: 0.35, levelIndex: 2, stage: "harvested" }),
    ];
    const book = { bestBid: 0.28, bestAsk: 0.55, tickSize: 0.01 }; // well below 0.35 * 0.9 = 0.315
    // 3 levels < cap=4, buyPx≈0.29 ≤ 0.35*0.9=0.315 → should open
    expect(shouldOpenNextLevel(levels, book, BASE_POLICY)).toBe(true);
  });

  it("takes last-entry price from highest levelIndex, not array order", () => {
    // Last entry is level 2 at 0.30; level 1 at 0.42
    const levels = [
      makeLevel({ buyPx: 0.42, levelIndex: 1, stage: "pending" }),
      makeLevel({ buyPx: 0.3, levelIndex: 2, stage: "pending" }),
    ];
    // threshold = 0.30 * 0.9 = 0.27; buyPx needs to be ≤ 0.27
    const bookAbove = { bestBid: 0.28, bestAsk: 0.55, tickSize: 0.01 }; // buyPx≈0.29 > 0.27 → false
    const bookBelow = { bestBid: 0.24, bestAsk: 0.55, tickSize: 0.01 }; // buyPx≈0.25 ≤ 0.27 → true
    expect(shouldOpenNextLevel(levels, bookAbove, BASE_POLICY)).toBe(false);
    expect(shouldOpenNextLevel(levels, bookBelow, BASE_POLICY)).toBe(true);
  });
});

// ─── openNextLevelOrder ───────────────────────────────────────────────────────

describe("openNextLevelOrder", () => {
  it("returns null when shouldOpenNextLevel is false", () => {
    const level0 = makeLevel({ buyPx: 0.5, levelIndex: 0 });
    const book = { bestBid: 0.47, bestAsk: 0.55, tickSize: 0.01 }; // < step down
    const result = openNextLevelOrder(
      { ladderId: level0.ladderId, levels: [level0] },
      "tok-ladder",
      COND_ID,
      book,
      BASE_POLICY,
      "2026-07-05T11:00:00.000Z",
    );
    expect(result).toBeNull();
  });

  it("returns correct level fields when conditions are met", () => {
    const level0 = makeLevel({ buyPx: 0.5, levelIndex: 0 });
    const nowIso = "2026-07-05T11:00:00.000Z";
    const book = { bestBid: 0.43, bestAsk: 0.55, tickSize: 0.01 }; // buyPx=0.44 ≤ 0.45
    const result = openNextLevelOrder(
      { ladderId: level0.ladderId, levels: [level0] },
      "tok-ladder",
      COND_ID,
      book,
      BASE_POLICY,
      nowIso,
    );
    expect(result).not.toBeNull();
    expect(result!.levelIndex).toBe(1);
    expect(result!.ladderId).toBe(level0.ladderId);
    expect(result!.stage).toBe("pending");
    expect(result!.filledAt).toBeNull();
    expect(result!.buyPx).toBe(0.44);
    // fillDeadline = nowIso + fillWaitMs (2h)
    const expectedDeadline = new Date(Date.parse(nowIso) + BASE_POLICY.fillWaitMs).toISOString();
    expect(result!.fillDeadline).toBe(expectedDeadline);
  });
});

// ─── advanceShadowOrder: filledAt and separated hold clock ───────────────────

describe("advanceShadowOrder — hold horizon", () => {
  it("sets filledAt at the pending→filled transition", () => {
    const shadow = makeLevel({ buyPx: 0.5 });
    const fillIso = "2026-07-05T11:00:00.000Z";
    const market = makeMarket(0.5, 0.55); // bestBid = buyPx → touch fill

    const outcome = advanceShadowOrder(shadow, market, fillIso, BASE_POLICY.holdWindowMs);
    expect(outcome.transition).toBe(true);
    if (!outcome.transition) return;
    expect(outcome.update.stage).toBe("filled");
    expect(outcome.update.filledAt).toBe(fillIso);
  });

  it("marks at filled_at + holdWindowMs (not fillDeadline)", () => {
    // filledAt = 10:00, holdWindowMs = 3h → mark at 13:00
    // fillDeadline = 12:00 (2h) — must NOT trigger mark at 12:00
    const filledAt = "2026-07-05T10:00:00.000Z";
    const fillDeadline = "2026-07-05T12:00:00.000Z"; // 2h from posted
    const markDeadline = "2026-07-05T13:00:00.000Z"; // 3h from filled

    const shadow = makeLevel({
      stage: "filled",
      filledAt,
      fillDeadline,
      buyPx: 0.5,
      harvestPx: 0.6,
    });
    const market = makeMarket(0.45, 0.55); // below harvest

    // At fillDeadline (12:00) — old logic would mark, new logic should NOT
    const outcomeAtFillDeadline = advanceShadowOrder(
      shadow,
      market,
      "2026-07-05T12:00:00.000Z",
      BASE_POLICY.holdWindowMs,
    );
    expect(outcomeAtFillDeadline.transition).toBe(false);

    // Just before holdWindowMs deadline (12:59) — still no mark
    const outcomeJustBefore = advanceShadowOrder(
      shadow,
      market,
      "2026-07-05T12:59:59.000Z",
      BASE_POLICY.holdWindowMs,
    );
    expect(outcomeJustBefore.transition).toBe(false);

    // At holdWindowMs deadline (13:00) — must mark
    const outcomeAtMark = advanceShadowOrder(
      shadow,
      market,
      markDeadline,
      BASE_POLICY.holdWindowMs,
    );
    expect(outcomeAtMark.transition).toBe(true);
    if (!outcomeAtMark.transition) return;
    expect(outcomeAtMark.update.stage).toBe("marked");
  });

  it("harvests inside the hold window (before markDeadline)", () => {
    const filledAt = "2026-07-05T10:00:00.000Z";
    const shadow = makeLevel({
      stage: "filled",
      filledAt,
      fillDeadline: "2026-07-05T12:00:00.000Z",
      buyPx: 0.5,
      harvestPx: 0.6,
    });
    // bestBid at harvest target, within hold window
    const market = makeMarket(0.6, 0.65);
    const outcome = advanceShadowOrder(
      shadow,
      market,
      "2026-07-05T11:00:00.000Z", // 1h after fill — inside the 3h window
      BASE_POLICY.holdWindowMs,
    );
    expect(outcome.transition).toBe(true);
    if (!outcome.transition) return;
    expect(outcome.update.stage).toBe("harvested");
  });

  it("falls back to fillDeadline as mark deadline when filledAt is null (pre-migration row)", () => {
    // Pre-migration rows have filledAt=null; for these, fillDeadline was the
    // original mark trigger. We keep that semantics to avoid breaking existing rows.
    const shadow = makeLevel({
      stage: "filled",
      filledAt: null,
      fillDeadline: "2026-07-05T12:00:00.000Z",
      buyPx: 0.5,
      harvestPx: 0.6,
    });
    const market = makeMarket(0.45, 0.55); // below harvest
    const outcomeAtFillDeadline = advanceShadowOrder(
      shadow,
      market,
      "2026-07-05T12:00:00.000Z",
      BASE_POLICY.holdWindowMs,
    );
    expect(outcomeAtFillDeadline.transition).toBe(true);
    if (!outcomeAtFillDeadline.transition) return;
    expect(outcomeAtFillDeadline.update.stage).toBe("marked");
  });
});

// ─── Restart: tracker state reconstruction ───────────────────────────────────
//
// These tests simulate what hydrateMakerShadowOrders does on restart.
// It calls repo.findOpen() to get open levels, then repo.findLadder() for
// each unique ladderId to get the full ladder including terminal levels.

describe("tracker state reconstruction (restart scenario)", () => {
  it("level 0 terminal + level 1 open: shouldOpenNextLevel counts both levels", () => {
    // Simulate: after restart, tracker reconstructs [level0(expired), level1(pending)]
    const level0 = makeLevel({ buyPx: 0.5, levelIndex: 0, stage: "expired" });
    const level1: MakerShadowOrder = {
      ...makeLevel({ buyPx: 0.44, levelIndex: 1 }),
      shadowOrderId: computeShadowOrderId("tok-ladder", "2026-07-05T10:30:00.000Z:L1"),
      ladderId: level0.ladderId,
    };
    const reconstructed = [level0, level1];

    // The next level would be index 2; step threshold from level1 (last entry = 0.44)
    // threshold = 0.44 * 0.9 = 0.396; buyPx must be ≤ 0.396
    const bookAboveThreshold = { bestBid: 0.39, bestAsk: 0.55, tickSize: 0.01 }; // buyPx=0.40 > 0.396 → false
    const bookBelowThreshold = { bestBid: 0.37, bestAsk: 0.55, tickSize: 0.01 }; // buyPx=0.38 ≤ 0.396 → true
    expect(shouldOpenNextLevel(reconstructed, bookAboveThreshold, BASE_POLICY)).toBe(false);
    expect(shouldOpenNextLevel(reconstructed, bookBelowThreshold, BASE_POLICY)).toBe(true);
  });

  it("openNextLevelOrder assigns next index based on ladder length, not max level_index", () => {
    const level0 = makeLevel({ buyPx: 0.5, levelIndex: 0, stage: "expired" });
    const level1: MakerShadowOrder = {
      ...makeLevel({ buyPx: 0.44, levelIndex: 1 }),
      shadowOrderId: computeShadowOrderId("tok-ladder", "2026-07-05T10:30:00.000Z:L1"),
      ladderId: level0.ladderId,
    };
    const ladder = { ladderId: level0.ladderId, levels: [level0, level1] };
    const book = { bestBid: 0.37, bestAsk: 0.55, tickSize: 0.01 };
    const nextLevel = openNextLevelOrder(
      ladder,
      "tok-ladder",
      COND_ID,
      book,
      BASE_POLICY,
      "2026-07-05T11:00:00.000Z",
    );
    expect(nextLevel).not.toBeNull();
    // levels.length == 2, so next index == 2
    expect(nextLevel!.levelIndex).toBe(2);
    expect(nextLevel!.ladderId).toBe(level0.ladderId);
  });

  it("does not exceed maxScaleInLevels even across restarts with mixed terminal+open", () => {
    // maxScaleInLevels=4; 3 terminal + 1 open = 4 levels → cap reached
    const levels: MakerShadowOrder[] = [
      makeLevel({ buyPx: 0.5, levelIndex: 0, stage: "expired" }),
      makeLevel({ buyPx: 0.44, levelIndex: 1, stage: "marked" }),
      makeLevel({ buyPx: 0.38, levelIndex: 2, stage: "harvested" }),
      makeLevel({ buyPx: 0.32, levelIndex: 3, stage: "pending" }),
    ];
    const book = { bestBid: 0.2, bestAsk: 0.55, tickSize: 0.01 };
    expect(shouldOpenNextLevel(levels, book, BASE_POLICY)).toBe(false);
  });
});

// ─── Two independent levels in one ladder ────────────────────────────────────

describe("independent level lifecycle", () => {
  it("level 0 (filled) harvests while level 1 (pending) gets a touch fill — independently", () => {
    const now1 = "2026-07-05T10:30:00.000Z";
    const filledAt0 = "2026-07-05T10:10:00.000Z";

    // Level 0 is already in filled state (pending→filled happened earlier)
    const level0 = makeLevel({
      buyPx: 0.5,
      harvestPx: 0.6,
      levelIndex: 0,
      stage: "filled",
      fillKind: "trade_through",
      fillPx: 0.49,
      filledAt: filledAt0,
    });

    // Level 1 is still pending, shares the same ladderId
    const level1: MakerShadowOrder = {
      ...makeLevel({ buyPx: 0.44, levelIndex: 1 }),
      shadowOrderId: computeShadowOrderId("tok-ladder", `${now1}:L1`),
      ladderId: level0.ladderId,
      postedAt: now1,
      fillDeadline: new Date(Date.parse(now1) + BASE_POLICY.fillWaitMs).toISOString(),
    };

    // Level 0 reaches harvest target: bestBid (0.62) >= harvestPx (0.60) → harvested
    const marketHighBid = makeMarket(0.62, 0.7);
    const outcome0 = advanceShadowOrder(
      level0,
      marketHighBid,
      "2026-07-05T11:00:00.000Z",
      BASE_POLICY.holdWindowMs,
    );
    expect(outcome0.transition).toBe(true);
    if (outcome0.transition) expect(outcome0.update.stage).toBe("harvested");

    // Level 1 gets a touch fill (bestBid=0.44 >= level1.buyPx=0.44) — independent of level 0
    const marketAtBid = makeMarket(0.44, 0.55);
    const outcome1 = advanceShadowOrder(
      level1,
      marketAtBid,
      "2026-07-05T11:00:00.000Z",
      BASE_POLICY.holdWindowMs,
    );
    expect(outcome1.transition).toBe(true);
    if (outcome1.transition) {
      expect(outcome1.update.stage).toBe("filled");
      expect(outcome1.update.filledAt).toBe("2026-07-05T11:00:00.000Z");
    }
  });
});
