/**
 * Tests for scale-in level-index logic in maker-entry-shadow.ts:
 *   - shouldOpenNextLevel: BBO finiteness guard (Finding 2)
 *   - shouldOpenNextLevel + openNextLevelOrder: max(levelIndex)+1 derivation (Finding 1)
 */
import { describe, expect, it } from "vitest";
import type { MakerEntryPolicy } from "@krabs/domain";
import type { MakerShadowOrder } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";
import { openNextLevelOrder, shouldOpenNextLevel } from "../maker-entry-shadow.js";
import type { ShadowBook } from "../maker-entry-shadow.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

function makePolicy(overrides: Partial<MakerEntryPolicy> = {}): MakerEntryPolicy {
  return {
    mode: "shadow",
    bidImproveTicks: 1,
    harvestGainPct: 0.5,
    fillWaitMs: 300_000,
    holdWindowMs: 10_800_000,
    makerMinLiquidity: 5_000,
    makerMinVol24h: 1_000,
    maxScaleInLevels: 4,
    scaleInStepPct: 0.1,
    whitelistConditionIds: [],
    microMaxOrderUsdc: 5,
    microMaxOpenUsdc: 25,
    captureBookReprice: { enabled: false, maxRepricesPerRoot: 5 },
    collapseFloorPrice: null,
    ...overrides,
  };
}

function makeLevel(levelIndex: number, buyPx: number): MakerShadowOrder {
  return {
    shadowOrderId: `order-level-${levelIndex}`,
    tokenId: createTokenId("tok-ladder"),
    conditionId: "cond-ladder",
    buyPx,
    harvestPx: buyPx * 1.5,
    postedAt: "2026-07-05T10:00:00.000Z",
    fillDeadline: "2026-07-05T10:05:00.000Z",
    stage: "pending",
    fillKind: null,
    fillPx: null,
    markPx: null,
    netMark: null,
    ladderId: "ladder-root",
    levelIndex,
    filledAt: null,
    updatedAt: "2026-07-05T10:00:00.000Z",
  };
}

// A book that qualifies: finite, bestBid=0.21, bestAsk=0.24, tick=0.01
// buyPx = floor(0.21 + 1*0.01, 0.01) = 0.22
// stepThreshold at level index 2 (buyPx=0.25): 0.25 * 0.9 = 0.225 → 0.22 ≤ 0.225 ✓
const GOOD_BOOK: ShadowBook = { bestBid: 0.21, bestAsk: 0.24, tickSize: 0.01 };

// ─── Finding 2: BBO finiteness guard ─────────────────────────────────────────

describe("shouldOpenNextLevel — BBO finiteness guard", () => {
  // Ladder has two valid levels: indices [0, 2]
  const ladder = [makeLevel(0, 0.31), makeLevel(2, 0.25)];

  it("returns false when bestAsk is Infinity", () => {
    const book: ShadowBook = { bestBid: 0.21, bestAsk: Infinity, tickSize: 0.01 };
    expect(shouldOpenNextLevel(ladder, book, makePolicy())).toBe(false);
  });

  it("returns false when bestAsk is NaN", () => {
    const book: ShadowBook = { bestBid: 0.21, bestAsk: NaN, tickSize: 0.01 };
    expect(shouldOpenNextLevel(ladder, book, makePolicy())).toBe(false);
  });

  it("returns false when bestBid is Infinity", () => {
    const book: ShadowBook = { bestBid: Infinity, bestAsk: 0.24, tickSize: 0.01 };
    expect(shouldOpenNextLevel(ladder, book, makePolicy())).toBe(false);
  });

  it("returns false when bestBid is NaN", () => {
    const book: ShadowBook = { bestBid: NaN, bestAsk: 0.24, tickSize: 0.01 };
    expect(shouldOpenNextLevel(ladder, book, makePolicy())).toBe(false);
  });

  it("returns true with a fully valid finite book (sanity check)", () => {
    expect(shouldOpenNextLevel(ladder, GOOD_BOOK, makePolicy())).toBe(true);
  });
});

// ─── Finding 1: max(levelIndex)+1 derivation ─────────────────────────────────

describe("shouldOpenNextLevel — cap derived from max(levelIndex)+1", () => {
  it("opens at index 3 when ladder has gap [0, 2] and maxScaleInLevels=4", () => {
    // ladder has 2 entries but the max levelIndex is 2 → next = 3 < 4 → should open
    const ladder = [makeLevel(0, 0.31), makeLevel(2, 0.25)];
    expect(shouldOpenNextLevel(ladder, GOOD_BOOK, makePolicy({ maxScaleInLevels: 4 }))).toBe(true);
  });

  it("does NOT open when max(levelIndex)+1 >= maxScaleInLevels (gap [0,2,3], cap=4)", () => {
    // max=3 → next=4 >= 4 → capped
    const ladder = [makeLevel(0, 0.31), makeLevel(2, 0.25), makeLevel(3, 0.22)];
    // For this ladder, lastLevel is index 3 (buyPx=0.22), stepThreshold=0.198
    // buyPx with GOOD_BOOK = 0.22, which is NOT <= 0.198, so the step-down check
    // would fail anyway — use a book that steps down enough.
    const deepBook: ShadowBook = { bestBid: 0.17, bestAsk: 0.2, tickSize: 0.01 };
    // buyPx = 0.18, stepThreshold = 0.22 * 0.9 = 0.198 → 0.18 <= 0.198 ✓
    // But cap: max=3 → next=4 >= 4 → false
    expect(shouldOpenNextLevel(ladder, deepBook, makePolicy({ maxScaleInLevels: 4 }))).toBe(false);
  });

  it("length=2 with gap [0,2] is NOT treated as cap reached (cap=4)", () => {
    // Old bug: ladder.length=2 < 4 would open a duplicate at index 2.
    // New code: nextLevelIndex = max(0,2)+1 = 3, not length.
    const ladder = [makeLevel(0, 0.31), makeLevel(2, 0.25)];
    // The cap check passes (3 < 4), so shouldOpenNextLevel can return true
    // (given the book also satisfies all other checks).
    expect(shouldOpenNextLevel(ladder, GOOD_BOOK, makePolicy({ maxScaleInLevels: 4 }))).toBe(true);
  });
});

describe("openNextLevelOrder — levelIndex is max(levelIndex)+1 for gapped ladder", () => {
  const NOW = "2026-07-05T10:00:00.000Z";

  it("assigns levelIndex=3 for a ladder with gap [0, 2]", () => {
    const ladderState = {
      ladderId: "ladder-root",
      levels: [makeLevel(0, 0.31), makeLevel(2, 0.25)],
    };
    const newLevel = openNextLevelOrder(
      ladderState,
      "tok-ladder",
      "cond-ladder",
      GOOD_BOOK,
      makePolicy(),
      NOW,
    );
    expect(newLevel).not.toBeNull();
    expect(newLevel!.levelIndex).toBe(3);
  });

  it("assigns levelIndex=1 for a contiguous ladder [0] (no gap)", () => {
    const ladderState = {
      ladderId: "ladder-root",
      levels: [makeLevel(0, 0.31)],
    };
    // bestBid=0.25, bestAsk=0.29, tick=0.01 → buyPx = 0.25+0.01 = 0.26
    // stepThreshold = 0.31 * 0.9 = 0.279 → 0.26 <= 0.279 ✓
    const book: ShadowBook = { bestBid: 0.25, bestAsk: 0.29, tickSize: 0.01 };
    const newLevel = openNextLevelOrder(
      ladderState,
      "tok-ladder",
      "cond-ladder",
      book,
      makePolicy(),
      NOW,
    );
    expect(newLevel).not.toBeNull();
    expect(newLevel!.levelIndex).toBe(1);
  });

  it("returns null when nextLevelIndex=max+1 reaches the cap", () => {
    // 4 levels with indices [0,1,2,3] → max=3, next=4 >= maxScaleInLevels=4 → null
    const ladderState = {
      ladderId: "ladder-root",
      levels: [makeLevel(0, 0.31), makeLevel(1, 0.28), makeLevel(2, 0.25), makeLevel(3, 0.22)],
    };
    const deepBook: ShadowBook = { bestBid: 0.17, bestAsk: 0.2, tickSize: 0.01 };
    expect(
      openNextLevelOrder(ladderState, "tok-ladder", "cond-ladder", deepBook, makePolicy(), NOW),
    ).toBeNull();
  });
});
