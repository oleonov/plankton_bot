import { describe, expect, it } from "vitest";
import { exitsOnlyMessage } from "../../pages/Overview.tsx";
import type { StatusData } from "../../api/types.ts";

function statusWith(executionQueue: unknown): StatusData {
  return { executionQueue } as unknown as StatusData;
}

const baseCapacity = {
  enabled: true,
  minNewEntryWalletHeadroomUsdc: 7,
  minAddWalletHeadroomUsdc: 5,
  minViableEntryUsdc: 1,
  maxOpenBuyOrders: 25,
  maxOpenBuyOrdersPerToken: 2,
  openBuyOrderCount: 10,
  newEntryCapacityUsdc: 0.4,
  addCapacityUsdc: 2.4,
  entriesBlocked: false,
  addsBlocked: false,
};

describe("exitsOnlyMessage", () => {
  it("shows the deployable-capacity breakdown when entries are effectively blocked by funds", () => {
    const msg = exitsOnlyMessage(
      statusWith({
        freeUsdcForNewOrders: 7.4,
        buyCapacity: { ...baseCapacity, entriesBlocked: true },
      }),
    );
    // Assert the COMPLETE string so a value coming from the wrong field would fail:
    // deployable $0.40, free $7.40, reserve $7.00.
    expect(msg).toBe(
      "Insufficient entry capacity — $0.40 available for a new entry ($7.40 free − $7.00 reserve)",
    );
  });

  it("shows the open-BUY-order-limit message when the order cap is hit", () => {
    const msg = exitsOnlyMessage(
      statusWith({
        freeUsdcForNewOrders: 50,
        buyCapacity: {
          ...baseCapacity,
          entriesBlocked: true,
          openBuyOrderCount: 25,
          maxOpenBuyOrders: 25,
        },
      }),
    );
    expect(msg).toContain("open BUY order limit reached (25/25)");
  });

  it("shows the selection/risk message when capacity is present and unblocked", () => {
    const msg = exitsOnlyMessage(
      statusWith({ freeUsdcForNewOrders: 50, buyCapacity: { ...baseCapacity } }),
    );
    expect(msg).toContain("selection / risk gate");
  });

  it("shows the neutral message when diagnostics are unavailable", () => {
    // executionQueue null → capacity UNKNOWN, not blocked
    expect(exitsOnlyMessage(statusWith(null))).toBe(
      "Only exit signals active — no new entries being opened",
    );
    // executionQueue present but buyCapacity absent → still neutral (unknown)
    expect(exitsOnlyMessage(statusWith({ freeUsdcForNewOrders: 5 }))).toBe(
      "Only exit signals active — no new entries being opened",
    );
  });
});
