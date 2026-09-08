import { describe, it, expect } from "vitest";
import { normalizeReasonCode } from "../risk-event-codes.js";

describe("normalizeReasonCode", () => {
  it("maps static reason strings verbatim", () => {
    expect(normalizeReasonCode("buy_order_count_limit")).toBe("buy_order_count_limit");
    expect(normalizeReasonCode("live-lite-open-value-cap-exceeded")).toBe(
      "live_lite_open_value_cap",
    );
    expect(normalizeReasonCode("live-lite-active-markets-cap-exceeded")).toBe(
      "live_lite_active_markets_cap",
    );
    expect(normalizeReasonCode("live-lite-allowlist-rejected")).toBe("live_lite_allowlist");
    expect(normalizeReasonCode("live-post-only-required")).toBe("live_post_only_required");
    expect(normalizeReasonCode("live-min-order-usdc-rejected")).toBe("live_min_order_usdc");
    expect(normalizeReasonCode("live-eoa-fee-enabled-family-rejected")).toBe(
      "live_eoa_fee_enabled_family",
    );
  });

  it("maps the first recognized reason from multi-reason rejections", () => {
    expect(
      normalizeReasonCode("live-post-only-required; live-eoa-fee-enabled-family-rejected"),
    ).toBe("live_post_only_required");
  });

  it("maps dynamic open-value reason", () => {
    expect(normalizeReasonCode("open value would be 15.50 USDC, exceeds max 10 USDC")).toBe(
      "max_open_value",
    );
  });

  it("maps dynamic active-markets reason", () => {
    expect(normalizeReasonCode("active markets 4 >= max 4")).toBe("max_active_markets");
  });

  it("maps dynamic dust-positions reason", () => {
    expect(normalizeReasonCode("dust positions 3 >= max 2")).toBe("max_dust_positions");
  });

  it("maps family not found", () => {
    expect(normalizeReasonCode("family fam-xyz not found in rules")).toBe("family_not_found");
  });

  it("maps family disabled as deployment_disabled", () => {
    expect(normalizeReasonCode("family fam-xyz is disabled")).toBe("deployment_disabled");
  });

  it("maps probe token open-order blocker", () => {
    expect(normalizeReasonCode("probe token already has open buy order")).toBe(
      "probe_token_open_buy_order",
    );
  });

  it("maps BUY admission guard reasons to themselves (identity)", () => {
    expect(normalizeReasonCode("resolution_tracker_unavailable")).toBe(
      "resolution_tracker_unavailable",
    );
    expect(normalizeReasonCode("market_resolved")).toBe("market_resolved");
    expect(normalizeReasonCode("market_ended")).toBe("market_ended");
    expect(normalizeReasonCode("market_inactive")).toBe("market_inactive");
    expect(normalizeReasonCode("market_not_tradable")).toBe("market_not_tradable");
    expect(normalizeReasonCode("market_not_alive")).toBe("market_not_alive");
  });

  it("maps Track Q loop guard reason codes", () => {
    expect(normalizeReasonCode("sell_loop_guard")).toBe("sell_loop_guard");
    expect(normalizeReasonCode("sell-loop-guard")).toBe("sell_loop_guard");
    expect(normalizeReasonCode("post-only-cross-pre-submit")).toBe("post_only_cross_pre_submit");
  });

  it("maps taker-at-profit below-margin suppression", () => {
    expect(normalizeReasonCode("taker-below-margin")).toBe("taker_below_margin");
  });

  it("returns unknown_rejection for unrecognized strings", () => {
    expect(normalizeReasonCode("some future rejection reason")).toBe("unknown_rejection");
  });
});
