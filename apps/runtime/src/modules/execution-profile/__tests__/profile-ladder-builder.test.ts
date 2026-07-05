import {
  DEFAULT_EXECUTION_PROFILE_POLICY,
  createConditionId,
  createTokenId,
  type ExecutionProfileSellLadderConfig,
  type LadderBuilderInput,
  type LadderRung,
  type ProfileLadderBand,
  type ProfileLadderMode,
} from "@krabs/domain";
import { describe, expect, it, vi } from "vitest";

import { computeProfileLadder, fitRungsToMinNotional } from "../profile-ladder-builder.js";
import {
  computeProfileLadderShadowEvaluation,
  resolveProfileLadderShadowEntryBand,
} from "../profile-ladder-shadow-policy.js";

const shadowPlanktonPolicy = {
  enabled: true,
  writeRiskEvents: true,
  variants: ["p25", "median", "cheap_tail"],
  liveBehaviorEnabled: false,
  riskEventDedupeMs: 600_000,
  bands: {
    lt_0_005: {
      p25: 1.5,
      median: 2.33,
      p75: 4.5,
      observedMedianFirstFraction: 0.7,
      sampleSize: 1166,
    },
    gte_0_005_lt_0_01: {
      p25: 1.2,
      median: 1.47,
      p75: 2,
      observedMedianFirstFraction: 1,
      sampleSize: 531,
    },
    gte_0_01_lt_0_02: {
      p25: 1.14,
      median: 1.36,
      p75: 1.73,
      observedMedianFirstFraction: 1,
      sampleSize: 1455,
    },
    gte_0_02_lt_0_05: {
      p25: 1.1,
      median: 1.23,
      p75: 1.46,
      observedMedianFirstFraction: 1,
      sampleSize: 3918,
    },
    gte_0_05_lt_0_10: {
      p25: 1.1,
      median: 1.19,
      p75: 1.43,
      observedMedianFirstFraction: 1,
      sampleSize: 2390,
    },
    gte_0_10: {
      p25: 1.06,
      median: 1.13,
      p75: 1.25,
      observedMedianFirstFraction: 1,
      sampleSize: 11531,
    },
  },
} satisfies ExecutionProfileSellLadderConfig["shadowPlanktonPolicy"];

const config = {
  ...DEFAULT_EXECUTION_PROFILE_POLICY.sellLadder,
  enabled: true,
  shadowPlanktonPolicy,
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

describe("computeProfileLadder positive floor (GAP-2)", () => {
  // GAP-2: medium_high/expensive rung0 multiplier is 1.0; mode "up" applies a
  // 0.95 adjustment, so rung0 = avg * 1.0 * 0.95 < avg entry — a SELL below cost.
  // The floor clamps normal ladder exits at least one tick above ceilToTick(avgEntry).
  const ceilToTick = (value: number, tick: number): number =>
    Number((Math.ceil((value - 1e-12) / tick) * tick).toFixed(6));
  const positiveFloor = (avgEntryPrice: number, tick: number): number =>
    ceilToTick(ceilToTick(avgEntryPrice, tick) + tick, tick);

  const MODES = ["up", "flat", "avg_down"] as const;
  const AVG_ENTRIES = [0.04, 0.1, 0.2, 0.4];

  it("(8) never prices any rung below the positive tick floor across bands and modes", () => {
    for (const avgEntryPrice of AVG_ENTRIES) {
      for (const mode of MODES) {
        const result = computeProfileLadder(
          input({ avgEntryPrice, mode, tickSize: 0.01, costBasisUsd: 25, positionSizeShares: 250 }),
        );
        if (!result.ok) throw new Error(`expected ladder for ${avgEntryPrice}/${mode}`);
        const floor = positiveFloor(avgEntryPrice, 0.01);
        for (const rung of result.rungs) {
          expect(rung.price).toBeGreaterThanOrEqual(floor - 1e-9);
        }
      }
    }
  });

  it("(9) clamps the medium_high/up/rung0 case to the positive floor", () => {
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
    expect(result.rungs[0]!.price).toBe(0.21);
    expect(result.rungs[0]!.floored).toBe(true);
  });

  it("(10) keeps the positive floor tick-upward-safe for non-tick-aligned avg entries", () => {
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
    const entryFloor = ceilToTick(0.197, 0.01); // 0.2
    const floor = positiveFloor(0.197, 0.01); // 0.21
    expect(entryFloor).toBe(0.2);
    expect(floor).toBe(0.21);
    for (const rung of result.rungs) {
      expect(rung.price).toBeGreaterThanOrEqual(floor - 1e-9);
    }
    expect(result.rungs[0]!.price).toBe(0.21);
    expect(result.rungs[0]!.floored).toBe(true);
  });

  it("(11) leaves rungs above the positive floor unchanged (no floored flag)", () => {
    const result = computeProfileLadder(
      input({
        avgEntryPrice: 0.2,
        mode: "avg_down",
        tickSize: 0.01,
        costBasisUsd: 25,
        positionSizeShares: 250,
      }),
    );

    expect(result).toMatchObject({ ok: true, band: "medium_high" });
    if (!result.ok) throw new Error("expected ladder");
    expect(result.rungs.map((rung) => rung.price)).toEqual([0.3, 0.33, 0.38]);
    expect(result.rungs.every((rung) => rung.floored !== true)).toBe(true);
  });

  // Phase 6: maker-entry first-rung override
  describe("maker-entry first-rung override (Phase 6)", () => {
    const cheapConfig = {
      ...config,
      bands: {
        ...config.bands,
        cheap: { ...config.bands.cheap, enabled: true },
      },
    };

    it("maker-tagged cheap position: first rung price == ceil(avgEntry * 1.5, tick) (+50%)", () => {
      const result = computeProfileLadder(
        input({ avgEntryPrice: 0.03, costBasisUsd: 25, config: cheapConfig, entryStyle: "maker" }),
      );

      expect(result).toMatchObject({ ok: true, band: "cheap" });
      if (!result.ok) throw new Error("expected ok ladder");
      // ceilToTick(0.03 * 1.5, 0.001) = ceilToTick(0.045, 0.001) = 0.045
      expect(result.rungs[0]?.price).toBe(0.045);
      expect(result.rungs[0]?.multiplier).toBe(1.5);
    });

    it("maker only overrides index 0; subsequent rungs keep band multipliers", () => {
      const result = computeProfileLadder(
        input({ avgEntryPrice: 0.03, costBasisUsd: 25, config: cheapConfig, entryStyle: "maker" }),
      );

      if (!result.ok) throw new Error("expected ok ladder");
      // cheap band multipliers: [1.1, 1.25, 1.5, 1.75, 2.35]; maker overrides index 0 to 1.5
      expect(result.rungs[0]?.multiplier).toBe(1.5);
      expect(result.rungs[1]?.multiplier).toBe(1.25);
      expect(result.rungs[2]?.multiplier).toBe(1.5);
    });

    it.each([null, "probe"] as const)(
      "non-maker cheap position (entryStyle=%s): first rung keeps band multiplier (regression)",
      (entryStyle) => {
        const result = computeProfileLadder(
          input({ avgEntryPrice: 0.03, costBasisUsd: 25, config: cheapConfig, entryStyle }),
        );

        expect(result).toMatchObject({ ok: true, band: "cheap" });
        if (!result.ok) throw new Error("expected ok ladder");
        // ceilToTick(0.03 * 1.1, 0.001) = ceilToTick(0.033, 0.001) = 0.033
        expect(result.rungs[0]?.price).toBe(0.033);
        expect(result.rungs[0]?.multiplier).toBe(1.1);
      },
    );

    it("non-maker cheap ladder prices are byte-identical regardless of entryStyle variant", () => {
      const baseline = computeProfileLadder(
        input({ avgEntryPrice: 0.03, costBasisUsd: 25, config: cheapConfig }),
      );
      const withNull = computeProfileLadder(
        input({ avgEntryPrice: 0.03, costBasisUsd: 25, config: cheapConfig, entryStyle: null }),
      );
      const withProbe = computeProfileLadder(
        input({ avgEntryPrice: 0.03, costBasisUsd: 25, config: cheapConfig, entryStyle: "probe" }),
      );

      if (!baseline.ok || !withNull.ok || !withProbe.ok) throw new Error("expected ok ladders");
      expect(withNull.rungs.map((r) => r.price)).toEqual(baseline.rungs.map((r) => r.price));
      expect(withProbe.rungs.map((r) => r.price)).toEqual(baseline.rungs.map((r) => r.price));
      expect(withNull.rungs.map((r) => r.multiplier)).toEqual(
        baseline.rungs.map((r) => r.multiplier),
      );
    });

    it.each([["up", 0.95] as const, ["flat", 1.0] as const, ["avg_down", 1.5] as const] as const)(
      "maker first rung price == ceilToTick(avgEntry*1.5, tick) in %s mode (modeAdjustment bypassed)",
      (mode, _modeAdjustment) => {
        const avgEntryPrice = 0.03;
        const tickSize = 0.001;
        const expected = ceilToTick(avgEntryPrice * 1.5, tickSize); // 0.045, always
        const result = computeProfileLadder(
          input({
            avgEntryPrice,
            costBasisUsd: 25,
            config: cheapConfig,
            entryStyle: "maker",
            mode,
          }),
        );
        expect(result).toMatchObject({ ok: true, band: "cheap" });
        if (!result.ok) throw new Error("expected ok ladder");
        expect(result.rungs[0]?.price).toBe(expected);
      },
    );

    // Phase 2: config-driven harvestGainPct tests
    it("maker first rung at harvestGainPct=0.20 → ceilToTick(avgEntry × 1.20, tick)", () => {
      const avgEntryPrice = 0.03;
      const harvestGainPct = 0.2;
      const expectedPrice = ceilToTick(avgEntryPrice * (1 + harvestGainPct), 0.001); // 0.036
      const expectedMultiplier = 1 + harvestGainPct; // 1.2

      const result = computeProfileLadder(
        input({
          avgEntryPrice,
          costBasisUsd: 25,
          config: cheapConfig,
          entryStyle: "maker",
          harvestGainPct,
        }),
      );

      expect(result).toMatchObject({ ok: true, band: "cheap" });
      if (!result.ok) throw new Error("expected ok ladder");
      expect(result.rungs[0]?.price).toBe(expectedPrice);
      expect(result.rungs[0]?.multiplier).toBe(expectedMultiplier);
    });

    it("maker first rung at harvestGainPct=0.50 (explicit) matches absent fallback", () => {
      const avgEntryPrice = 0.03;
      const explicit = computeProfileLadder(
        input({
          avgEntryPrice,
          costBasisUsd: 25,
          config: cheapConfig,
          entryStyle: "maker",
          harvestGainPct: 0.5,
        }),
      );
      const fallback = computeProfileLadder(
        input({ avgEntryPrice, costBasisUsd: 25, config: cheapConfig, entryStyle: "maker" }),
      );

      if (!explicit.ok || !fallback.ok) throw new Error("expected ok ladders");
      expect(explicit.rungs[0]?.price).toBe(fallback.rungs[0]?.price);
      expect(explicit.rungs[0]?.multiplier).toBe(fallback.rungs[0]?.multiplier);
      expect(explicit.rungs[0]?.price).toBe(ceilToTick(avgEntryPrice * 1.5, 0.001)); // 0.045
    });

    it("harvestGainPct only affects maker rung 0; subsequent rungs are byte-identical", () => {
      const base = input({
        avgEntryPrice: 0.03,
        costBasisUsd: 25,
        config: cheapConfig,
        entryStyle: "maker",
      });
      const with020 = computeProfileLadder({ ...base, harvestGainPct: 0.2 });
      const with050 = computeProfileLadder({ ...base, harvestGainPct: 0.5 });

      if (!with020.ok || !with050.ok) throw new Error("expected ok ladders");
      // Rung 0 must differ
      expect(with020.rungs[0]?.price).not.toBe(with050.rungs[0]?.price);
      // Rungs 1+ must be byte-identical
      const tail020 = with020.rungs.slice(1);
      const tail050 = with050.rungs.slice(1);
      expect(tail020.map((r) => r.price)).toEqual(tail050.map((r) => r.price));
      expect(tail020.map((r) => r.multiplier)).toEqual(tail050.map((r) => r.multiplier));
    });
  });
});

function shadowEvaluation(overrides: Partial<LadderBuilderInput> = {}) {
  const builderInput = input({
    bestBid: 0.001,
    bestAsk: 0.5,
    ...overrides,
  });
  const live = computeProfileLadder(builderInput);
  if (!live.ok) throw new Error(`expected live ladder, got ${live.reason}`);
  const evaluation = computeProfileLadderShadowEvaluation({
    avgEntryPrice: builderInput.avgEntryPrice,
    costBasisUsd: builderInput.costBasisUsd,
    positionSizeShares: builderInput.positionSizeShares,
    mode: builderInput.mode,
    bestBid: builderInput.bestBid,
    bestAsk: builderInput.bestAsk,
    tickSize: builderInput.tickSize,
    minOrderSize: builderInput.minOrderSize,
    config: builderInput.config.shadowPlanktonPolicy,
    currentRungs: live.rungs,
  });
  if (evaluation == null) throw new Error("expected shadow evaluation");
  return evaluation;
}

describe("ProfileLadder Plankton shadow policy", () => {
  it.each([
    [0.004999, "lt_0_005"],
    [0.005, "gte_0_005_lt_0_01"],
    [0.01, "gte_0_01_lt_0_02"],
    [0.02, "gte_0_02_lt_0_05"],
    [0.05, "gte_0_05_lt_0_10"],
    [0.1, "gte_0_10"],
  ] as const)("resolves shadow band boundary %s", (avgEntryPrice, expected) => {
    expect(resolveProfileLadderShadowEntryBand(avgEntryPrice)).toBe(expected);
  });

  it("calculates P25, median, P75, and cheap-tail targets from the Plankton table", () => {
    const evaluation = computeProfileLadderShadowEvaluation({
      avgEntryPrice: 0.01,
      costBasisUsd: 25,
      positionSizeShares: 250,
      mode: "flat",
      bestBid: 0.001,
      bestAsk: 0.5,
      tickSize: 0.001,
      minOrderSize: 0.1,
      config: { ...config.shadowPlanktonPolicy, variants: ["p25", "median", "p75", "cheap_tail"] },
      currentRungs: [
        rungForTest({ sizingFraction: 0.6, sizeShares: 150 }),
        rungForTest({ sizingFraction: 0.4, sizeShares: 100 }),
      ],
    });
    if (evaluation == null) throw new Error("expected shadow evaluation");

    expect(evaluation.band).toBe("gte_0_01_lt_0_02");
    const byVariant = new Map(evaluation.results.map((result) => [result.variant, result]));
    expect(byVariant.get("p25")?.firstTargetMultiple).toBe(1.14);
    expect(byVariant.get("median")?.firstTargetMultiple).toBe(1.36);
    expect(byVariant.get("p75")?.firstTargetMultiple).toBe(1.73);
    expect(byVariant.get("cheap_tail")?.candidateRungs.map((rung) => rung.targetKind)).toEqual([
      "median",
      "p75",
    ]);
  });

  it("uses tick rounding and positive floor and detects variants collapsed by floor/tick", () => {
    const evaluation = shadowEvaluation({
      avgEntryPrice: 0.105,
      tickSize: 0.05,
      bestBid: 0.01,
      bestAsk: 0.5,
      config: {
        ...config,
        shadowPlanktonPolicy: {
          ...config.shadowPlanktonPolicy,
          variants: ["p25", "median", "p75"],
        },
      },
    });

    expect(evaluation.variantCollapse?.collapseType).toBe(
      "same_effective_price_after_tick_and_floor",
    );
    expect(evaluation.results.map((result) => result.candidateRungs[0]?.price)).toEqual([
      0.2, 0.2, 0.2,
    ]);
  });

  it("reuses the live min-order collapse helper for shadow candidate collapse", () => {
    const rawRungs = [
      rungForTest({ rungIndex: 0, price: 0.01, sizeShares: 35, notionalUsd: 0.35 }),
      rungForTest({ rungIndex: 1, price: 0.018, sizeShares: 15, notionalUsd: 0.27 }),
    ];
    const expected = fitRungsToMinNotional(rawRungs, 50, 0.5);
    const evaluation = computeProfileLadderShadowEvaluation({
      avgEntryPrice: 0.004,
      costBasisUsd: 0.62,
      positionSizeShares: 50,
      mode: "flat",
      bestBid: 0.001,
      bestAsk: 0.5,
      tickSize: 0.001,
      minOrderSize: 0.5,
      config: { ...config.shadowPlanktonPolicy, variants: ["cheap_tail"] },
      currentRungs: [rungForTest({ sizingFraction: 0.7 }), rungForTest({ sizingFraction: 0.3 })],
    });
    if (evaluation == null) throw new Error("expected shadow evaluation");
    const candidate = evaluation.results[0]!;

    expect(expected).toHaveLength(1);
    expect(candidate.collapsedDueMinOrder).toBe(true);
    expect(candidate.candidateRungs).toHaveLength(expected.length);
    expect(candidate.candidateRungs[0]?.sizingFraction).toBe(expected[0]?.sizingFraction);
  });

  it("recomputes shadow band when scale-in changes avgEntry", () => {
    expect(resolveProfileLadderShadowEntryBand(0.009)).toBe("gte_0_005_lt_0_01");
    expect(resolveProfileLadderShadowEntryBand(0.02)).toBe("gte_0_02_lt_0_05");
  });

  it("does not default cheap entries to a <=1.10x normal target", () => {
    const evaluation = shadowEvaluation({ avgEntryPrice: 0.01, tickSize: 0.001 });
    const median = evaluation.results.find((result) => result.variant === "median");

    expect(median?.firstTargetMultiple).toBe(1.36);
    expect(median?.effectiveFirstTargetMultiple).toBeGreaterThan(1.1);
  });

  it("allows an expensive entry to use a full-size lower-multiple candidate", () => {
    const evaluation = shadowEvaluation({ avgEntryPrice: 0.2, tickSize: 0.001 });
    const p25 = evaluation.results.find((result) => result.variant === "p25");

    expect(p25?.firstTargetMultiple).toBe(1.06);
    expect(p25?.firstSizeFraction).toBe(1);
    expect(p25?.result).not.toBe("candidate_not_executable");
  });

  it("marks crossing post-only candidates non-executable without changing live ladder output", () => {
    const evaluation = shadowEvaluation({
      avgEntryPrice: 0.1,
      bestBid: 0.2,
      bestAsk: 0.25,
    });

    expect(evaluation.results.every((result) => result.result === "crossing_post_only")).toBe(true);
    expect(evaluation.results.every((result) => result.reason === "post_only_crossing")).toBe(true);
  });

  it("detects PR2 protected-exposure conflicts without mutating current rungs", () => {
    const currentRungs = [
      rungForTest({
        rungIndex: 0,
        price: 0.018,
        sizeShares: 50,
        sizingFraction: 0.5,
        lifecycle: "placed",
        orderId: "old-high-rung",
      }),
      rungForTest({
        rungIndex: 1,
        price: 0.014,
        sizeShares: 50,
        sizingFraction: 0.5,
      }),
    ];
    const evaluation = computeProfileLadderShadowEvaluation({
      avgEntryPrice: 0.01,
      costBasisUsd: 1,
      positionSizeShares: 100,
      mode: "flat",
      bestBid: 0.001,
      bestAsk: 0.5,
      tickSize: 0.001,
      minOrderSize: 0.1,
      config: { ...config.shadowPlanktonPolicy, variants: ["cheap_tail"] },
      currentRungs,
    });

    expect(evaluation?.results[0]?.pr2ProtectedExposureConflict).toBe(true);
    expect(currentRungs[0]?.lifecycle).toBe("placed");
    expect(currentRungs[0]?.orderId).toBe("old-high-rung");
  });
});

function rungForTest(overrides: Partial<LadderRung> = {}): LadderRung {
  return {
    rungIndex: 0,
    price: 0.014,
    sizeShares: 30,
    notionalUsd: 0.42,
    multiplier: 1.36,
    sizingFraction: 0.6,
    lifecycle: "planned" as const,
    orderId: null,
    filledSizeShares: 0,
    ...overrides,
  };
}
