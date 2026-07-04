import { describe, expect, it } from "vitest";
import type { R23DipTriggerResult } from "@krabs/domain";
import {
  computeHarvestTarget,
  computeMakerEntryPrice,
  evaluateMakerEntry,
  type MakerBookSnapshot,
  type MakerEntryInputs,
} from "../maker-entry.js";

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

function makeBook(overrides: Partial<MakerBookSnapshot> = {}): MakerBookSnapshot {
  return { bestBid: 0.3, bestAsk: 0.32, tickSize: 0.01, ...overrides };
}

function makeInputs(overrides: Partial<MakerEntryInputs> = {}): MakerEntryInputs {
  return { improveTicks: 1, harvestGainPct: 0.5, ...overrides };
}

// ─── computeMakerEntryPrice ───────────────────────────────────────────────────

describe("computeMakerEntryPrice", () => {
  it("returns bestBid + improveTicks*tick on a clean grid", () => {
    // 0.05 + 1*0.001 = 0.051 — already on grid, floor is no-op
    expect(computeMakerEntryPrice(0.05, 0.001, 1)).toBeCloseTo(0.051, 10);
  });

  it("floors when raw value falls between ticks", () => {
    // bestBid=0.051 is off the 0.01 grid; 0.051 + 0.01 = 0.061 → floor to 0.06
    expect(computeMakerEntryPrice(0.051, 0.01, 1)).toBeCloseTo(0.06, 10);
  });

  it("supports multi-tick improvement", () => {
    // 0.1 + 3*0.01 = 0.13
    expect(computeMakerEntryPrice(0.1, 0.01, 3)).toBeCloseTo(0.13, 10);
  });
});

// ─── computeHarvestTarget ─────────────────────────────────────────────────────

describe("computeHarvestTarget", () => {
  it("ceils the raw product onto the tick grid", () => {
    // 0.051 * 1.5 = 0.0765 → 76.5 ticks, NOT on grid for tick=0.001
    // ceilToTick rounds up to 77 ticks = 0.077
    expect(computeHarvestTarget(0.051, 0.5, 0.001)).toBeCloseTo(0.077, 10);
  });

  it("ceils when raw product falls between ticks", () => {
    // 0.033 * 1.5 = 0.0495, tick=0.01 → ceil to 0.05
    expect(computeHarvestTarget(0.033, 0.5, 0.01)).toBeCloseTo(0.05, 10);
  });

  it("handles 50% gain on a 0.1 entry with 0.01 tick", () => {
    // 0.1 * 1.5 = 0.15 — on grid
    expect(computeHarvestTarget(0.1, 0.5, 0.01)).toBeCloseTo(0.15, 10);
  });
});

// ─── evaluateMakerEntry ───────────────────────────────────────────────────────

describe("evaluateMakerEntry", () => {
  it("approves a valid R23-fired entry", () => {
    const result = evaluateMakerEntry(FIRED, makeBook(), makeInputs());
    expect(result.shouldPost).toBe(true);
    expect(result.reason).toBe("ok");
    // 0.3 + 1*0.01 = 0.31
    expect(result.buyPx).toBeCloseTo(0.31, 10);
    // 0.31 * 1.5 = 0.465 → ceil-to-tick 0.01 = 0.47
    expect(result.harvestPx).toBeCloseTo(0.47, 10);
  });

  it("rejects when R23 has not fired", () => {
    const result = evaluateMakerEntry(NOT_FIRED, makeBook(), makeInputs());
    expect(result.shouldPost).toBe(false);
    expect(result.reason).toBe("r23_not_fired");
    expect(result.buyPx).toBeNull();
    expect(result.harvestPx).toBeNull();
  });

  it("rejects when bestBid is zero (invalid book)", () => {
    const result = evaluateMakerEntry(FIRED, makeBook({ bestBid: 0 }), makeInputs());
    expect(result.shouldPost).toBe(false);
    expect(result.reason).toBe("invalid_book");
  });

  it("rejects when bestAsk is not greater than bestBid (crossed book)", () => {
    const result = evaluateMakerEntry(
      FIRED,
      makeBook({ bestBid: 0.4, bestAsk: 0.3 }),
      makeInputs(),
    );
    expect(result.shouldPost).toBe(false);
    expect(result.reason).toBe("invalid_book");
  });

  it("rejects when bestBid is NaN", () => {
    const result = evaluateMakerEntry(FIRED, makeBook({ bestBid: NaN }), makeInputs());
    expect(result.shouldPost).toBe(false);
    expect(result.reason).toBe("invalid_book");
  });

  it("rejects when computed buyPx would cross the ask (would_cross)", () => {
    // bestBid=0.49, bestAsk=0.50, tick=0.01, improve=1
    // buyPx = floor(0.49 + 0.01, 0.01) = 0.50 >= bestAsk(0.50) → would_cross
    const result = evaluateMakerEntry(
      FIRED,
      makeBook({ bestBid: 0.49, bestAsk: 0.5, tickSize: 0.01 }),
      makeInputs({ improveTicks: 1 }),
    );
    expect(result.shouldPost).toBe(false);
    expect(result.reason).toBe("would_cross");
    expect(result.buyPx).toBeNull();
  });

  it("is pure: same inputs always produce the same output", () => {
    const book = makeBook({ bestBid: 0.05, bestAsk: 0.1, tickSize: 0.001 });
    const inputs = makeInputs({ improveTicks: 1, harvestGainPct: 0.5 });
    const first = evaluateMakerEntry(FIRED, book, inputs);
    const second = evaluateMakerEntry(FIRED, book, inputs);
    expect(first).toEqual(second);
  });

  it("does not throw on extreme edge inputs", () => {
    // Very small tick, high gain
    const book: MakerBookSnapshot = { bestBid: 0.001, bestAsk: 0.999, tickSize: 0.001 };
    expect(() => evaluateMakerEntry(FIRED, book, makeInputs({ harvestGainPct: 9 }))).not.toThrow();
    // Infinity/NaN book values
    expect(() =>
      evaluateMakerEntry(FIRED, makeBook({ bestBid: Infinity }), makeInputs()),
    ).not.toThrow();
  });
});
