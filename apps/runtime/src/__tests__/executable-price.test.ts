import { describe, expect, it } from "vitest";
import {
  ceilToTick,
  clampExecutablePrice,
  deriveExecutableTopOfBook,
  floorToTick,
  resolveBoundedMidpointPrice,
  roundToTick,
  validateExecutablePrice,
  type BoundedMidpointInput,
} from "../executable-price.js";

describe("validateExecutablePrice", () => {
  it("accepts tick-aligned prices inside the executable interval", () => {
    expect(validateExecutablePrice(0.001, 0.001)).toMatchObject({ ok: true });
    expect(validateExecutablePrice(0.999, 0.001)).toMatchObject({ ok: true });
    expect(validateExecutablePrice(0.505, 0.001)).toMatchObject({ ok: true });
  });

  it("rejects prices outside the executable interval", () => {
    expect(validateExecutablePrice(0.0005, 0.001)).toMatchObject({
      ok: false,
      reason: "price-below-min-tick",
    });
    expect(validateExecutablePrice(1, 0.001)).toMatchObject({
      ok: false,
      reason: "price-above-max-bound",
    });
  });

  it("rejects off-grid prices inside the numeric interval", () => {
    expect(validateExecutablePrice(0.5005, 0.001)).toMatchObject({
      ok: false,
      reason: "price-off-tick-grid",
    });
  });
});

describe("deriveExecutableTopOfBook", () => {
  it("uses the first deeper executable level when the raw best prices are invalid", () => {
    expect(
      deriveExecutableTopOfBook(
        {
          bestBid: 0.0005,
          bestAsk: 1,
          bids: [
            { price: 0.0005, size: 100 },
            { price: 0.001, size: 90 },
          ],
          asks: [
            { price: 1, size: 100 },
            { price: 0.999, size: 90 },
          ],
        },
        0.001,
      ),
    ).toEqual({
      bestBid: 0.001,
      bestAsk: 0.999,
      midPrice: 0.5,
      spread: 0.998,
    });
  });

  it("drops scalar quotes when no executable levels exist", () => {
    expect(
      deriveExecutableTopOfBook(
        {
          bestBid: 0.0005,
          bestAsk: 1,
        },
        0.001,
      ),
    ).toEqual({
      bestBid: null,
      bestAsk: null,
      midPrice: null,
      spread: null,
    });
  });
});

describe("floorToTick", () => {
  it("leaves on-grid prices unchanged", () => {
    expect(floorToTick(0.5, 0.001)).toBe(0.5);
    expect(floorToTick(0.25, 0.01)).toBe(0.25);
    expect(floorToTick(0.123, 0.001)).toBe(0.123);
  });

  it("snaps down to the nearest tick on fine grids", () => {
    // raw mid of bb=0.001 / ba=0.999 = 0.5; subtract tick 0.001 → 0.499 (on grid).
    expect(floorToTick(0.499, 0.001)).toBe(0.499);
    // midpoint of 0.01/0.02 is 0.015 → floor to 0.01 on 0.01 grid.
    expect(floorToTick(0.015, 0.01)).toBe(0.01);
    // snap off-grid 0.4997 down to 0.499 on 0.001.
    expect(floorToTick(0.4997, 0.001)).toBe(0.499);
  });

  it("is stable against binary-float residue", () => {
    // 0.1 + 0.2 = 0.30000000000000004; must still round to 0.3.
    expect(floorToTick(0.1 + 0.2, 0.001)).toBe(0.3);
    expect(floorToTick(0.1 + 0.2, 0.01)).toBe(0.3);
  });

  it("passes non-finite values through without mutation", () => {
    expect(floorToTick(Number.NaN, 0.001)).toBeNaN();
    expect(floorToTick(Number.POSITIVE_INFINITY, 0.001)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("ceilToTick", () => {
  it("snaps up to the nearest tick on fine grids", () => {
    // midpoint of 0.98/0.99 is 0.985; add tick 0.001 → 0.986 (on grid).
    expect(ceilToTick(0.986, 0.001)).toBe(0.986);
    // raw 0.015 on 0.01 grid → ceil to 0.02.
    expect(ceilToTick(0.015, 0.01)).toBe(0.02);
    // off-grid 0.5003 → ceil to 0.501 on 0.001.
    expect(ceilToTick(0.5003, 0.001)).toBe(0.501);
  });

  it("leaves on-grid prices unchanged", () => {
    expect(ceilToTick(0.5, 0.001)).toBe(0.5);
    expect(ceilToTick(0.25, 0.01)).toBe(0.25);
  });

  it("is stable against binary-float residue", () => {
    expect(ceilToTick(0.1 + 0.2, 0.001)).toBe(0.3);
  });
});

describe("roundToTick", () => {
  it("rounds to the nearest tick", () => {
    expect(roundToTick(0.5004, 0.001)).toBe(0.5);
    expect(roundToTick(0.5005, 0.001)).toBeGreaterThanOrEqual(0.5); // banker's rounding edge
    expect(roundToTick(0.5006, 0.001)).toBe(0.501);
  });
});

describe("clampExecutablePrice", () => {
  it("BUY snaps down (floor) and clamps to [tick, 1 - tick]", () => {
    // BUY raw mid − tick on 0.001 grid for 0.01/0.99 book:
    //   mid = 0.5, raw = 0.499, snap down = 0.499, clamp → 0.499.
    expect(clampExecutablePrice(0.499, 0.001, "buy")).toBe(0.499);
    // Off-grid above bound: 1.1 → clamp to maxPrice = 0.999.
    expect(clampExecutablePrice(1.1, 0.001, "buy")).toBe(0.999);
    // Below minPrice: 0 → clamp to minPrice = 0.001.
    expect(clampExecutablePrice(0, 0.001, "buy")).toBe(0.001);
    // Odd tick: BUY midpoint 0.5005 floors to 0.5.
    expect(clampExecutablePrice(0.5005, 0.001, "buy")).toBe(0.5);
  });

  it("SELL snaps up (ceil) and clamps to [tick, 1 - tick]", () => {
    // SELL raw mid + tick on 0.001 grid: mid=0.5, raw=0.501, snap up = 0.501.
    expect(clampExecutablePrice(0.501, 0.001, "sell")).toBe(0.501);
    // Off-grid 0.5001 → ceil = 0.501.
    expect(clampExecutablePrice(0.5001, 0.001, "sell")).toBe(0.501);
    // Clamp upper bound.
    expect(clampExecutablePrice(1.0, 0.001, "sell")).toBe(0.999);
  });

  it("output always validates via validateExecutablePrice", () => {
    const fuzz = [0.0003, 0.0101, 0.4997, 0.5003, 0.9998, 1.1, -0.2];
    for (const p of fuzz) {
      for (const side of ["buy", "sell"] as const) {
        const out = clampExecutablePrice(p, 0.001, side);
        expect(validateExecutablePrice(out, 0.001).ok).toBe(true);
      }
    }
  });
});

describe("resolveBoundedMidpointPrice (ADR-014)", () => {
  const base = (partial: Partial<BoundedMidpointInput> = {}): BoundedMidpointInput => ({
    bestBid: 0.5,
    bestAsk: 0.51,
    tickSize: 0.001,
    side: "buy",
    maxSpreadTicks: 20,
    maxImprovementTicks: 10,
    wideSpreadPolicy: "edge",
    oneSidedPolicy: "edge",
    ...partial,
  });

  it("BUY on tight 10-tick spread improves inside spread, below ask, tick-aligned", () => {
    // bb=0.5, ba=0.51, spread=10 ticks, mid=0.505, raw=0.504, floor=0.504
    const out = resolveBoundedMidpointPrice(base({ bestBid: 0.5, bestAsk: 0.51 }));
    expect(out.kind).toBe("improved");
    if (out.kind !== "improved") throw new Error("expected improved");
    expect(out.price).toBeLessThan(0.51);
    expect(out.price).toBeGreaterThan(0.5);
    expect(validateExecutablePrice(out.price, 0.001).ok).toBe(true);
    expect(out.diagnostics.edgePrice).toBe(0.5);
    expect(out.diagnostics.midpoint).toBe(0.505);
    expect(out.diagnostics.improvementTicks).toBeGreaterThan(0);
  });

  it("SELL on tight spread improves inside spread and above bid", () => {
    // bb=0.5, ba=0.51, spread=10 ticks, mid=0.505, raw=0.506, ceil=0.506
    const out = resolveBoundedMidpointPrice(base({ side: "sell", bestBid: 0.5, bestAsk: 0.51 }));
    expect(out.kind).toBe("improved");
    if (out.kind !== "improved") throw new Error("expected improved");
    expect(out.price).toBeGreaterThan(0.5);
    expect(out.price).toBeLessThanOrEqual(0.51);
    expect(validateExecutablePrice(out.price, 0.001).ok).toBe(true);
  });

  it("BUY with 1-tick spread cannot improve (no room) — returns edge", () => {
    const out = resolveBoundedMidpointPrice(base({ bestBid: 0.5, bestAsk: 0.501 }));
    expect(out.kind).toBe("edge");
    if (out.kind !== "edge") throw new Error("expected edge");
    expect(out.price).toBe(0.5);
  });

  it("BUY with wide spread falls back to edge when policy=edge", () => {
    // bb=0.01, ba=0.99, spread=980 ticks > 20 → wide, fall back to bestBid
    const out = resolveBoundedMidpointPrice(
      base({ bestBid: 0.01, bestAsk: 0.99, maxSpreadTicks: 20, wideSpreadPolicy: "edge" }),
    );
    expect(out.kind).toBe("edge");
    if (out.kind !== "edge") throw new Error("expected edge");
    expect(out.price).toBe(0.01);
    expect(out.diagnostics.spreadTicks).toBe(980);
  });

  it("BUY with wide spread skips when policy=skip", () => {
    const out = resolveBoundedMidpointPrice(
      base({ bestBid: 0.01, bestAsk: 0.99, maxSpreadTicks: 20, wideSpreadPolicy: "skip" }),
    );
    expect(out.kind).toBe("skip");
    if (out.kind !== "skip") throw new Error("expected skip");
    expect(out.reason).toBe("wide-spread");
  });

  it("improvement cap clips long-tail improvement on moderately wide books", () => {
    // bb=0.001, ba=0.025, spread=24 ticks, maxSpreadTicks=30, maxImprovementTicks=5
    // mid=0.013, raw=0.012, floor=0.012 → improved=0.012, but cap = bb + 5*0.001 = 0.006
    const out = resolveBoundedMidpointPrice(
      base({
        bestBid: 0.001,
        bestAsk: 0.025,
        maxSpreadTicks: 30,
        maxImprovementTicks: 5,
      }),
    );
    expect(out.kind).toBe("improved");
    if (out.kind !== "improved") throw new Error("expected improved");
    expect(out.price).toBe(0.006);
    expect(out.diagnostics.improvementTicks).toBe(5);
  });

  it("BUY never crosses the ask across fuzzed books", () => {
    // Invariant: finalPrice < bestAsk for BUY, even with huge improvement cap.
    const books: Array<[number, number]> = [
      [0.5, 0.503],
      [0.5, 0.51],
      [0.1, 0.12],
      [0.4, 0.6],
    ];
    for (const [bb, ba] of books) {
      const out = resolveBoundedMidpointPrice(
        base({
          bestBid: bb,
          bestAsk: ba,
          maxSpreadTicks: 1000,
          maxImprovementTicks: 1000,
        }),
      );
      if (out.kind === "improved" || out.kind === "edge") {
        expect(out.price).toBeLessThan(ba);
      }
    }
  });

  it("SELL never crosses the bid across fuzzed books", () => {
    const books: Array<[number, number]> = [
      [0.5, 0.503],
      [0.5, 0.51],
      [0.1, 0.12],
      [0.4, 0.6],
    ];
    for (const [bb, ba] of books) {
      const out = resolveBoundedMidpointPrice(
        base({
          side: "sell",
          bestBid: bb,
          bestAsk: ba,
          maxSpreadTicks: 1000,
          maxImprovementTicks: 1000,
        }),
      );
      if (out.kind === "improved" || out.kind === "edge") {
        expect(out.price).toBeGreaterThan(bb);
      }
    }
  });

  it("one-sided book with policy=edge falls back to edge", () => {
    const out = resolveBoundedMidpointPrice(
      base({ bestBid: 0.5, bestAsk: null, oneSidedPolicy: "edge" }),
    );
    expect(out.kind).toBe("edge");
    if (out.kind !== "edge") throw new Error("expected edge");
    expect(out.price).toBe(0.5);
  });

  it("one-sided book with policy=skip returns skip", () => {
    const out = resolveBoundedMidpointPrice(
      base({ bestBid: 0.5, bestAsk: null, oneSidedPolicy: "skip" }),
    );
    expect(out.kind).toBe("skip");
    if (out.kind !== "skip") throw new Error("expected skip");
    expect(out.reason).toBe("one-sided");
  });

  it("missing edge side (bestBid null for BUY) always skips regardless of policy", () => {
    const out = resolveBoundedMidpointPrice(
      base({ side: "buy", bestBid: null, bestAsk: 0.5, oneSidedPolicy: "edge" }),
    );
    expect(out.kind).toBe("skip");
    if (out.kind !== "skip") throw new Error("expected skip");
    expect(out.reason).toBe("one-sided");
  });

  it("diagnostics include all required fields per ADR-014 §D6", () => {
    const out = resolveBoundedMidpointPrice(base({ bestBid: 0.5, bestAsk: 0.51 }));
    expect(out.diagnostics).toMatchObject({
      side: "buy",
      tickSize: 0.001,
      bestBid: 0.5,
      bestAsk: 0.51,
      midpoint: 0.505,
      spread: expect.any(Number),
      spreadTicks: expect.any(Number),
      edgePrice: 0.5,
      rawCandidate: expect.any(Number),
      snappedCandidate: expect.any(Number),
      finalPrice: expect.any(Number),
      improvementTicks: expect.any(Number),
      maxSpreadTicks: 20,
      maxImprovementTicks: 10,
    });
  });

  it("output always validates on fuzzed inputs", () => {
    const fuzz: Array<[number, number]> = [
      [0.001, 0.002],
      [0.001, 0.01],
      [0.01, 0.02],
      [0.499, 0.501],
      [0.5, 0.55],
      [0.98, 0.99],
      [0.001, 0.999],
    ];
    for (const [bb, ba] of fuzz) {
      for (const side of ["buy", "sell"] as const) {
        const out = resolveBoundedMidpointPrice(
          base({ bestBid: bb, bestAsk: ba, side, maxSpreadTicks: 1000 }),
        );
        if (out.kind === "improved" || out.kind === "edge") {
          expect(validateExecutablePrice(out.price, 0.001).ok).toBe(true);
        }
      }
    }
  });
});
