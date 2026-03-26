import { describe, it, expect } from "vitest";
import { normalizeReasonCode } from "../risk-event-codes.js";

describe("normalizeReasonCode", () => {
  it("maps static reason strings verbatim", () => {
    expect(normalizeReasonCode("family-in-flight-limit")).toBe("family_in_flight_limit");
    expect(normalizeReasonCode("live-lite-open-value-cap-exceeded")).toBe(
      "live_lite_open_value_cap",
    );
    expect(normalizeReasonCode("live-lite-active-markets-cap-exceeded")).toBe(
      "live_lite_active_markets_cap",
    );
    expect(normalizeReasonCode("live-lite-allowlist-rejected")).toBe("live_lite_allowlist");
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

  it("maps derived reduce-only reason", () => {
    expect(
      normalizeReasonCode(
        "entry blocked — family in derived reduce-only (tail cost 3.75 breaches cap)",
      ),
    ).toBe("derived_reduce_only");
  });

  it("maps derived probe-only reason", () => {
    expect(
      normalizeReasonCode(
        "confirm-scale blocked — family in derived probe-only (tailAdjustedPnlLive -4.00 < 0)",
      ),
    ).toBe("derived_probe_only");
  });

  it("maps requirePositiveRecycleHistoryForScale reason", () => {
    expect(
      normalizeReasonCode(
        "scale-in blocked — requirePositiveRecycleHistoryForScale and tailAdjustedPnlLive -2.50 <= 0",
      ),
    ).toBe("require_positive_recycle");
  });

  it("maps family not found", () => {
    expect(normalizeReasonCode("family fam-xyz not found in rules")).toBe("family_not_found");
  });

  it("maps family disabled", () => {
    expect(normalizeReasonCode("family fam-xyz is disabled")).toBe("family_disabled");
  });

  it("maps operator quarantine mode", () => {
    expect(normalizeReasonCode("family in quarantine mode")).toBe("operator_quarantine");
  });

  it("maps operator reduce-only mode", () => {
    expect(normalizeReasonCode("family in reduce-only mode — entry blocked")).toBe(
      "operator_reduce_only",
    );
  });

  it("maps operator probe-only mode", () => {
    expect(normalizeReasonCode("family in probe-only mode — scale-in blocked")).toBe(
      "operator_probe_only",
    );
  });

  it("returns unknown_rejection for unrecognized strings", () => {
    expect(normalizeReasonCode("some future rejection reason")).toBe("unknown_rejection");
  });
});
