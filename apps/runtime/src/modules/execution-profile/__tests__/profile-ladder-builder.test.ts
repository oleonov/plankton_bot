import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  createConditionId,
  createTokenId,
  type LadderBuilderInput,
  type ProfileLadderBand,
  type ProfileLadderMode,
} from "@krabs/domain";
import { describe, expect, it, vi } from "vitest";

import { computeProfileLadder } from "../profile-ladder-builder.js";

const config = {
  ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder,
  enabled: true,
  bands: {
    ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands,
    cheap: { ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.cheap, enabled: true },
    medium_low: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_low,
      enabled: true,
    },
    medium_high: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.medium_high,
      enabled: true,
    },
    expensive: {
      ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder.bands.expensive,
      enabled: true,
    },
  },
};

function input(overrides: Partial<LadderBuilderInput> = {}): LadderBuilderInput {
  return {
    tokenId: createTokenId("token-ladder"),
    conditionId: createConditionId("condition-ladder"),
    openedAt: "2026-06-15T00:00:00.000Z",
    avgEntryPrice: 0.1,
    costBasisUsd: 25,
    positionSizeShares: 250,
    mode: "flat",
    bestBid: 0.09,
    bestAsk: 0.11,
    tickSize: 0.001,
    minOrderSize: 1,
    config,
    previousBand: null,
    ...overrides,
  };
}

function expectBand(avgEntryPrice: number, band: ProfileLadderBand): void {
  const result = computeProfileLadder(input({ avgEntryPrice }));

  expect(result).toMatchObject({ ok: true, band });
}

describe("computeProfileLadder", () => {
  it("is pure and does not call the clock", () => {
    const now = vi.spyOn(Date, "now");

    computeProfileLadder(input());

    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("resolves all four calibrated profile bands", () => {
    expectBand(0.04, "cheap");
    expectBand(0.05, "medium_low");
    expectBand(0.149, "medium_low");
    expectBand(0.15, "medium_high");
    expectBand(0.349, "medium_high");
    expectBand(0.35, "expensive");
  });

  it("uses Round 5 medium_low multipliers and normalized sizing", () => {
    const result = computeProfileLadder(input({ avgEntryPrice: 0.1, costBasisUsd: 25 }));

    expect(result).toMatchObject({ ok: true, band: "medium_low", activeRungCount: 4 });
    if (!result.ok) throw new Error("expected ladder");
    expect(result.rungs.map((rung) => rung.multiplier)).toEqual([1.1, 1.3, 1.55, 1.65]);
    expect(result.rungs.map((rung) => rung.sizingFraction)).toEqual([0.38, 0.24, 0.2, 0.18]);
    expect(result.rungs.map((rung) => rung.price)).toEqual([0.11, 0.13, 0.155, 0.165]);
    expect(result.rungs.map((rung) => rung.sizeShares)).toEqual([95, 60, 50, 45]);
  });

  it.each([
    ["up", 0.95, [0.105, 0.124, 0.148, 0.157]],
    ["flat", 1, [0.11, 0.13, 0.155, 0.165]],
    ["avg_down", 1.5, [0.165, 0.195, 0.233, 0.248]],
  ] as const)(
    "applies %s mode adjustment to ladder prices",
    (mode: ProfileLadderMode, _adjustment, prices) => {
      const result = computeProfileLadder(input({ mode, avgEntryPrice: 0.1, costBasisUsd: 25 }));

      if (!result.ok) throw new Error("expected ladder");
      expect(result.rungs.map((rung) => rung.price)).toEqual(prices);
    },
  );

  it.each([
    [4.99, 1],
    [5, 2],
    [14.99, 2],
    [15, 4],
    [49.99, 4],
    [50, 4],
  ])("uses position-size rung count rule for cost basis %s", (costBasisUsd, expectedCount) => {
    const result = computeProfileLadder(input({ costBasisUsd, avgEntryPrice: 0.1 }));

    expect(result).toMatchObject({ ok: true, activeRungCount: expectedCount });
  });

  it("caps active rungs at four and reserves the fifth multiplier", () => {
    const result = computeProfileLadder(input({ avgEntryPrice: 0.1, costBasisUsd: 100 }));

    if (!result.ok) throw new Error("expected ladder");
    expect(result.rungs).toHaveLength(4);
    expect(result.rungs.map((rung) => rung.multiplier)).not.toContain(1.85);
  });

  it("uses only three active rungs for medium_high and expensive at $15-$50", () => {
    expect(computeProfileLadder(input({ avgEntryPrice: 0.2, costBasisUsd: 25 }))).toMatchObject({
      ok: true,
      band: "medium_high",
      activeRungCount: 3,
    });
    expect(computeProfileLadder(input({ avgEntryPrice: 0.4, costBasisUsd: 25 }))).toMatchObject({
      ok: true,
      band: "expensive",
      activeRungCount: 3,
    });
  });

  it("rejects disabled master or band gates without side effects", () => {
    expect(computeProfileLadder(input({ config: { ...config, enabled: false } }))).toMatchObject({
      ok: false,
      reason: "sell_ladder_disabled",
      band: null,
    });
    expect(
      computeProfileLadder(
        input({
          config: {
            ...config,
            bands: {
              ...config.bands,
              medium_low: { ...config.bands.medium_low, enabled: false },
            },
          },
        }),
      ),
    ).toMatchObject({ ok: false, reason: "band_disabled", band: "medium_low" });
  });

  it("skips rungs that cannot satisfy Polymarket min order size", () => {
    expect(
      computeProfileLadder(
        input({ avgEntryPrice: 0.1, costBasisUsd: 25, positionSizeShares: 10, minOrderSize: 5 }),
      ),
    ).toMatchObject({ ok: false, reason: "below_min_order_size", band: "medium_low" });
  });

  it("skips placement when even one merged rung cannot satisfy min order notional", () => {
    expect(
      computeProfileLadder(
        input({ avgEntryPrice: 0.1, costBasisUsd: 1.5, positionSizeShares: 15, minOrderSize: 2 }),
      ),
    ).toMatchObject({ ok: false, reason: "below_min_order_size", band: "medium_low" });
  });

  it("merges undersized rungs into the largest neighbor before reducing rung count", () => {
    const result = computeProfileLadder(
      input({ avgEntryPrice: 0.1, costBasisUsd: 5, positionSizeShares: 50, minOrderSize: 4 }),
    );

    expect(result).toMatchObject({ ok: true, band: "medium_low", activeRungCount: 1 });
    if (!result.ok) throw new Error("expected merged ladder");
    expect(result.rungs).toHaveLength(1);
    expect(result.rungs[0]).toMatchObject({
      rungIndex: 0,
      multiplier: 1.3,
      price: 0.13,
      sizeShares: 50,
      sizingFraction: 1,
      notionalUsd: 6.5,
    });
  });

  it("keeps four rungs when every rung satisfies min order notional", () => {
    const result = computeProfileLadder(
      input({ avgEntryPrice: 0.1, costBasisUsd: 50, positionSizeShares: 500, minOrderSize: 1 }),
    );

    expect(result).toMatchObject({ ok: true, activeRungCount: 4 });
    if (!result.ok) throw new Error("expected ladder");
    expect(result.rungs).toHaveLength(4);
    expect(result.rungs.every((rung) => rung.notionalUsd >= 1)).toBe(true);
  });

  it("fails closed on invalid BBO or tick size", () => {
    expect(computeProfileLadder(input({ bestBid: null }))).toMatchObject({
      ok: false,
      reason: "invalid_bbo",
    });
    expect(computeProfileLadder(input({ tickSize: 0 }))).toMatchObject({
      ok: false,
      reason: "invalid_tick_size",
    });
  });
});

describe("computeProfileLadder avg-entry floor (GAP-2)", () => {
  // GAP-2: medium_high/expensive rung0 multiplier is 1.0; mode "up" applies a
  // 0.95 adjustment, so rung0 = avg * 1.0 * 0.95 < avg entry — a SELL below cost.
  // The floor clamps every rung price up to ceilToTick(avgEntry, tick).
  const ceilToTick = (value: number, tick: number): number =>
    Number((Math.ceil((value - 1e-12) / tick) * tick).toFixed(6));

  const MODES = ["up", "flat", "avg_down"] as const;
  const AVG_ENTRIES = [0.04, 0.1, 0.2, 0.4];

  it("(8) never prices any rung below the avg-entry tick floor across bands and modes", () => {
    for (const avgEntryPrice of AVG_ENTRIES) {
      for (const mode of MODES) {
        const result = computeProfileLadder(
          input({ avgEntryPrice, mode, tickSize: 0.01, costBasisUsd: 25, positionSizeShares: 250 }),
        );
        if (!result.ok) throw new Error(`expected ladder for ${avgEntryPrice}/${mode}`);
        const floor = ceilToTick(avgEntryPrice, 0.01);
        for (const rung of result.rungs) {
          expect(rung.price).toBeGreaterThanOrEqual(floor - 1e-9);
        }
      }
    }
  });

  it("(9) clamps the MrBeast medium_high/up/rung0 case to the avg-entry floor", () => {
    const result = computeProfileLadder(
      input({
        avgEntryPrice: 0.2,
        mode: "up",
        tickSize: 0.01,
        costBasisUsd: 25,
        positionSizeShares: 250,
      }),
    );

    expect(result).toMatchObject({ ok: true, band: "medium_high" });
    if (!result.ok) throw new Error("expected ladder");
    expect(result.rungs[0]!.price).toBe(0.2);
    expect(result.rungs[0]!.floored).toBe(true);
  });

  it("(10) keeps the floor tick-upward-safe for non-tick-aligned avg entries", () => {
    const result = computeProfileLadder(
      input({
        avgEntryPrice: 0.197,
        mode: "up",
        tickSize: 0.01,
        costBasisUsd: 25,
        positionSizeShares: 250,
      }),
    );

    expect(result).toMatchObject({ ok: true, band: "medium_high" });
    if (!result.ok) throw new Error("expected ladder");
    const floor = ceilToTick(0.197, 0.01); // 0.2
    expect(floor).toBe(0.2);
    for (const rung of result.rungs) {
      expect(rung.price).toBeGreaterThanOrEqual(floor - 1e-9);
    }
    expect(result.rungs[0]!.price).toBe(0.2);
    expect(result.rungs[0]!.floored).toBe(true);
  });

  it("(11) leaves rungs at or above the floor unchanged (no floored flag)", () => {
    const result = computeProfileLadder(
      input({
        avgEntryPrice: 0.2,
        mode: "flat",
        tickSize: 0.01,
        costBasisUsd: 25,
        positionSizeShares: 250,
      }),
    );

    expect(result).toMatchObject({ ok: true, band: "medium_high" });
    if (!result.ok) throw new Error("expected ladder");
    expect(result.rungs.map((rung) => rung.price)).toEqual([0.2, 0.22, 0.25]);
    expect(result.rungs.every((rung) => rung.floored !== true)).toBe(true);
  });
});
