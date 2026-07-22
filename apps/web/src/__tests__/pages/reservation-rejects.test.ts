import { describe, expect, it } from "vitest";
import { formatReservationRejects, humanizeInternalRejectReason } from "../../pages/Overview.tsx";

describe("humanizeInternalRejectReason", () => {
  it("maps known reason codes to plain English", () => {
    expect(humanizeInternalRejectReason("clamped-below-min-order-size")).toBe(
      "below 5-share minimum",
    );
    expect(humanizeInternalRejectReason("below_min_size")).toBe("below 5-share minimum");
    expect(humanizeInternalRejectReason("sell-residual-below-min-order-size")).toBe(
      "below 5-share minimum",
    );
    expect(humanizeInternalRejectReason("pending-wallet-sync")).toBe("wallet sync pending");
    expect(humanizeInternalRejectReason("wallet_buy_capacity_exhausted")).toBe(
      "insufficient buy budget",
    );
  });

  it("falls back to a de-slugified code for unknown reasons", () => {
    expect(humanizeInternalRejectReason("some_new-code")).toBe("some new code");
  });
});

describe("formatReservationRejects", () => {
  it("single reason → plain '<n> orders blocked pre-exchange: <reason>'", () => {
    expect(formatReservationRejects({ "clamped-below-min-order-size": 2 }, 2)).toBe(
      "2 orders blocked pre-exchange: below 5-share minimum",
    );
  });

  it("uses the singular for a single order", () => {
    expect(formatReservationRejects({ "pending-wallet-sync": 1 }, 1)).toBe(
      "1 order blocked pre-exchange: wallet sync pending",
    );
  });

  it("distinct codes sharing a label are merged (min-size family)", () => {
    expect(
      formatReservationRejects({ below_min_size: 1, "clamped-below-min-order-size": 2 }, 3),
    ).toBe("3 orders blocked pre-exchange: below 5-share minimum");
  });

  it("multiple reasons → all listed with counts summing to the total (sorted desc)", () => {
    expect(
      formatReservationRejects(
        { "clamped-below-min-order-size": 2, wallet_buy_capacity_exhausted: 1 },
        3,
      ),
    ).toBe("3 orders blocked pre-exchange: below 5-share minimum (2), insufficient buy budget (1)");
  });

  it("falls back to the legacy bare count when the by-reason map is absent", () => {
    expect(formatReservationRejects(undefined, 4)).toBe("reservation rejects 4");
  });

  it("returns null when there are none", () => {
    expect(formatReservationRejects({}, 0)).toBeNull();
    expect(formatReservationRejects(undefined, 0)).toBeNull();
  });
});
