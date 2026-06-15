import { DEFAULT_EXECUTION_PROFILE_POLICY, type AbandonmentEvaluatorInput } from "@krabs/domain";
import { describe, expect, it, vi } from "vitest";

import { decideAbandonment } from "../abandonment-evaluator.js";

const NOW = 1_800_000_000_000;

function config() {
  const abandonment = DEFAULT_EXECUTION_PROFILE_POLICY.abandonment;
  return {
    ...abandonment,
    enabled: true,
    bands: {
      ...abandonment.bands,
      cheap: { ...abandonment.bands.cheap, enabled: true },
      medium_low: { ...abandonment.bands.medium_low, enabled: true },
      medium_high: { ...abandonment.bands.medium_high, enabled: true },
      expensive: { ...abandonment.bands.expensive, enabled: true },
    },
  };
}

function input(overrides: Partial<AbandonmentEvaluatorInput> = {}): AbandonmentEvaluatorInput {
  return {
    band: "medium_low",
    state: "PROBING",
    costBasisUsdc: 13.45,
    buyCount: 3,
    sellCount: 0,
    firstBuyAtMs: NOW - 2_700_000,
    nowMs: NOW,
    pendingScaleIn: false,
    activeProfileLadder: false,
    activeSellOrder: false,
    ...overrides,
  };
}

describe("decideAbandonment", () => {
  it("qualifies medium_low at calibrated threshold boundary", () => {
    const decision = decideAbandonment(input(), config());

    expect(decision).toMatchObject({
      shouldAbandon: true,
      result: "abandoned",
      reason: "qualified",
      band: "medium_low",
      timeSinceFirstBuyMs: 2_700_000,
    });
  });

  it.each([
    ["cheap", 9, 4, 3_600_000],
    ["medium_low", 13.45, 3, 2_700_000],
    ["medium_high", 12.83, 2, 900_000],
    ["expensive", 11.84, 2, 600_000],
  ] as const)("qualifies %s at calibrated threshold", (band, costBasisUsdc, buyCount, ageMs) => {
    expect(
      decideAbandonment(
        input({ band, costBasisUsdc, buyCount, firstBuyAtMs: NOW - ageMs }),
        config(),
      ).shouldAbandon,
    ).toBe(true);
  });

  it.each([
    [{ costBasisUsdc: 13.46 }, "cost_above_probe_max"],
    [{ buyCount: 4 }, "buy_count_above_probe_max"],
    [{ sellCount: 1 }, "prior_sell"],
    [{ firstBuyAtMs: null }, "first_buy_missing"],
    [{ firstBuyAtMs: NOW - 2_699_999 }, "timer_not_elapsed"],
    [{ pendingScaleIn: true }, "pending_scale_in"],
    [{ activeProfileLadder: true }, "active_profile_ladder"],
    [{ activeSellOrder: true }, "active_sell_order"],
  ] as const)("keeps when %j with reason %s", (overrides, reason) => {
    expect(decideAbandonment(input(overrides), config())).toMatchObject({
      shouldAbandon: false,
      result: "kept",
      reason,
    });
  });

  it("short-circuits disabled root and disabled band", () => {
    expect(decideAbandonment(input(), { ...config(), enabled: false })).toMatchObject({
      shouldAbandon: false,
      reason: "abandonment_disabled",
    });
    expect(
      decideAbandonment(input(), {
        ...config(),
        bands: { ...config().bands, medium_low: { ...config().bands.medium_low, enabled: false } },
      }),
    ).toMatchObject({ shouldAbandon: false, reason: "band_disabled" });
  });

  it("is pure and does not read the clock", () => {
    const spy = vi.spyOn(Date, "now");

    decideAbandonment(input(), config());

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
