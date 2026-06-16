import {
  DEFAULT_EXECUTION_POLICY,
  type DustCleanupDecisionInput,
  type TrackS4DustAutoCloseConfig,
} from "@krabs/domain";
import { describe, expect, it, vi } from "vitest";

import { computeDustCleanup } from "../dust-cleanup-decider.js";

const DAY_MS = 24 * 60 * 60_000;

function config(overrides: Partial<TrackS4DustAutoCloseConfig> = {}): TrackS4DustAutoCloseConfig {
  return {
    ...DEFAULT_EXECUTION_POLICY.trackS4,
    enabled: true,
    ...overrides,
  };
}

function input(overrides: Partial<DustCleanupDecisionInput> = {}): DustCleanupDecisionInput {
  return {
    status: "open",
    liquidationValueUsdc: 0.49,
    costBasisUsdc: 5,
    sellCountTotal: 1,
    lastSellAgeMs: 7 * DAY_MS,
    size: 12,
    minOrderSize: 5,
    marketTradable: true,
    bestBid: 0.024,
    tickSize: 0.001,
    minValidPrice: 0.001,
    retryEligible: true,
    profileOwned: false,
    redeemInFlight: false,
    ...overrides,
  };
}

describe("computeDustCleanup", () => {
  it("is pure and does not read the clock", () => {
    const now = vi.spyOn(Date, "now");

    computeDustCleanup(input(), config());

    expect(now).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it("qualifies the calibrated sellable boundary and prices at bestBid minus one tick", () => {
    expect(computeDustCleanup(input(), config())).toEqual({
      action: "close",
      reason: "qualified",
      limitPrice: 0.023,
      sellSize: 12,
      nextRetryDelayMs: null,
    });
  });

  it.each([
    [{ liquidationValueUsdc: 0.5 }, "liquidation_above_threshold"],
    [{ costBasisUsdc: 5.01 }, "cost_above_threshold"],
    [{ sellCountTotal: 0, status: "open" }, "no_prior_sell"],
    [{ lastSellAgeMs: 7 * DAY_MS - 1 }, "recent_sell"],
    [{ retryEligible: false }, "retry_backoff"],
    [{ profileOwned: true }, "profile_owned"],
    [{ redeemInFlight: true }, "redeem_in_flight"],
  ] as const)("skips when %j with reason %s", (overrides, reason) => {
    expect(computeDustCleanup(input(overrides), config())).toMatchObject({
      action: "skip",
      reason,
      limitPrice: null,
      sellSize: null,
    });
  });

  it("lets status=dust bypass prior-sell and age gates but marks it non-closeable", () => {
    expect(
      computeDustCleanup(
        input({
          status: "dust",
          sellCountTotal: 0,
          lastSellAgeMs: null,
        }),
        config(),
      ),
    ).toEqual({
      action: "mark_non_closeable",
      reason: "status_dust",
      limitPrice: null,
      sellSize: null,
      nextRetryDelayMs: 24 * 60 * 60_000,
    });
  });

  it.each([
    [{ bestBid: null }, "missing_best_bid"],
    [{ bestBid: 0 }, "invalid_price"],
    [{ bestBid: 0.001 }, "invalid_price"],
    [{ marketTradable: false }, "market_not_tradable"],
    [{ minOrderSize: null }, "unknown_min_order_size"],
    [{ size: 4.99, minOrderSize: 5 }, "below_min_order_size"],
  ] as const)("marks non-closeable when %j with reason %s", (overrides, reason) => {
    expect(computeDustCleanup(input(overrides), config())).toMatchObject({
      action: "mark_non_closeable",
      reason,
      limitPrice: null,
      sellSize: null,
      nextRetryDelayMs: 24 * 60 * 60_000,
    });
  });

  it("short-circuits when Track S4 is disabled", () => {
    expect(computeDustCleanup(input(), config({ enabled: false }))).toMatchObject({
      action: "skip",
      reason: "disabled",
    });
  });
});
