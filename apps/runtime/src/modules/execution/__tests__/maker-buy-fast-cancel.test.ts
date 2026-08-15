import { describe, expect, it, vi } from "vitest";
import {
  createBotRunId,
  createConditionId,
  createOrderId,
  createTokenId,
  type ClientOrderId,
  type CancelOrderCommand,
  type Order,
} from "@krabs/domain";
import { canonicalInstant, MakerBuyFastCancel } from "../maker-buy-fast-cancel.js";

const ACTIVATION = "2026-08-15T00:00:00.000Z";

function makeOrder(id: string, overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId(id),
    clientOrderId: `client-${id}` as ClientOrderId,
    tokenId: createTokenId(`token-${id}`),
    conditionId: createConditionId(`condition-${id}`),
    side: "buy",
    orderType: "GTC",
    price: 0.3,
    size: 10,
    sizeUsdc: 3,
    status: "open",
    exchangeOrderId: `exchange-${id}`,
    signalId: null,
    signalReason: "confirm-scale",
    botRunId: createBotRunId("run"),
    entryStyle: "maker",
    createdAt: ACTIVATION,
    updatedAt: ACTIVATION,
    ...overrides,
  };
}

describe("MakerBuyFastCancel", () => {
  it("accepts only canonical ISO instants and defers without engaging before execution is ready", async () => {
    const coordinator = new MakerBuyFastCancel({
      orderRepo: { findOpen: () => [] },
      bus: { publish: vi.fn() } as never,
      isMakerModeOff: () => true,
      inFlightMakerBuys: () => 0,
    });

    expect(canonicalInstant(ACTIVATION)).not.toBeNull();
    expect(canonicalInstant("2026-08-15T00:00:00Z")).toBeNull();
    expect(canonicalInstant("2026-02-30T00:00:00.000Z")).toBeNull();
    expect(await coordinator.cancelSince(ACTIVATION, vi.fn())).toBe("deferred");
    expect(coordinator.isLatched()).toBe(false);
  });

  it("cancels the exact active maker-BUY cohort and preserves SELL, probe, and pre-cutoff rows", async () => {
    const after = "2026-08-15T00:00:00.001Z";
    let orders = [
      makeOrder("equal", { status: "pending" }),
      makeOrder("open", { createdAt: after }),
      makeOrder("partial", { status: "partially-filled", createdAt: after }),
      makeOrder("sell", { side: "sell", createdAt: after }),
      makeOrder("probe", { entryStyle: "probe", createdAt: after }),
      makeOrder("before", { createdAt: "2026-08-14T23:59:59.999Z" }),
    ];
    const cancels: CancelOrderCommand[] = [];
    const coordinator = new MakerBuyFastCancel({
      orderRepo: { findOpen: () => orders },
      bus: {
        publish: async (_event: string, payload: { command: CancelOrderCommand }) => {
          cancels.push(payload.command);
          orders = orders.filter((order) => order.orderId !== payload.command.orderId);
        },
      } as never,
      isMakerModeOff: () => true,
      inFlightMakerBuys: () => 0,
      sleep: async () => undefined,
    });
    coordinator.setReady(true);

    expect(await coordinator.cancelSince(ACTIVATION, vi.fn())).toBe("applied");
    expect(cancels.map((cancel) => String(cancel.orderId)).sort()).toEqual([
      "equal",
      "open",
      "partial",
    ]);
    expect(new Set(cancels.map((cancel) => String(cancel.commandId))).size).toBe(3);
    expect(cancels.every((cancel) => cancel.reason === "maker_fast_cancel")).toBe(true);
    expect(orders.map((order) => String(order.orderId)).sort()).toEqual([
      "before",
      "probe",
      "sell",
    ]);
  });

  it("drains every maker reservation and catches a pre-boundary admission persisted late", async () => {
    let orders: Order[] = [];
    let inFlight = 1;
    let sleeps = 0;
    const coordinator = new MakerBuyFastCancel({
      orderRepo: { findOpen: () => orders },
      bus: {
        publish: async (_event: string, payload: { command: CancelOrderCommand }) => {
          orders = orders.filter((order) => order.orderId !== payload.command.orderId);
        },
      } as never,
      isMakerModeOff: () => true,
      inFlightMakerBuys: () => inFlight,
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) {
          inFlight = 0;
          orders = [makeOrder("persisted-after-boundary", { createdAt: ACTIVATION })];
        }
      },
    });
    coordinator.setReady(true);

    expect(await coordinator.cancelSince(ACTIVATION, vi.fn())).toBe("applied");
    expect(sleeps).toBe(2);
    expect(orders).toHaveLength(0);
  });

  it("keeps the latch closed and uses unique cancel IDs until exact terminal proof times out", async () => {
    let now = 0;
    let sleeps = 0;
    const cancelIds: string[] = [];
    const cancelTimes: number[] = [];
    const coordinator = new MakerBuyFastCancel({
      orderRepo: { findOpen: () => [makeOrder("stuck")] },
      bus: {
        publish: async (_event: string, payload: { command: CancelOrderCommand }) => {
          cancelIds.push(String(payload.command.commandId));
          cancelTimes.push(now);
        },
      } as never,
      isMakerModeOff: () => true,
      inFlightMakerBuys: () => 0,
      now: () => now,
      deadlineMs: 10,
      rescanMs: 1,
      sleep: async () => {
        sleeps++;
        now = sleeps === 1 ? 9 : 10;
      },
    });
    coordinator.setReady(true);

    expect(await coordinator.cancelSince(ACTIVATION, vi.fn())).toBe("rejected");
    expect(cancelIds).toHaveLength(3);
    expect(new Set(cancelIds).size).toBe(cancelIds.length);
    expect(cancelTimes).toEqual([0, 9, 10]);
    expect(sleeps).toBe(2);
    expect(coordinator.isLatched()).toBe(true);
  });

  it("uses disjoint cancel IDs when the same durable action is retried", async () => {
    const cancels: CancelOrderCommand[] = [];
    const coordinator = new MakerBuyFastCancel({
      orderRepo: { findOpen: () => [makeOrder("stuck-retry")] },
      bus: {
        publish: async (_event: string, payload: { command: CancelOrderCommand }) => {
          cancels.push(payload.command);
        },
      } as never,
      isMakerModeOff: () => true,
      inFlightMakerBuys: () => 0,
      now: () => 0,
      deadlineMs: 0,
    });
    coordinator.setReady(true);

    expect(await coordinator.cancelSince(ACTIVATION, vi.fn())).toBe("rejected");
    expect(await coordinator.cancelSince(ACTIVATION, vi.fn())).toBe("rejected");
    expect(cancels).toHaveLength(2);
    expect(cancels[0]?.orderId).toBe(cancels[1]?.orderId);
    expect(cancels[0]?.commandId).not.toBe(cancels[1]?.commandId);
  });

  it("rejects policy reactivation after engagement and retains the latch", async () => {
    let modeOff = true;
    const commit = vi.fn();
    const coordinator = new MakerBuyFastCancel({
      orderRepo: { findOpen: () => [makeOrder("mode-flip")] },
      bus: {
        publish: async () => {
          modeOff = false;
        },
      } as never,
      isMakerModeOff: () => modeOff,
      inFlightMakerBuys: () => 0,
      sleep: async () => undefined,
    });
    coordinator.setReady(true);

    expect(await coordinator.cancelSince(ACTIVATION, commit)).toBe("rejected");
    expect(commit).not.toHaveBeenCalled();
    expect(coordinator.isLatched()).toBe(true);
  });

  it("holds the admission latch through the success commit and releases it afterwards", async () => {
    const coordinator = new MakerBuyFastCancel({
      orderRepo: { findOpen: () => [] },
      bus: { publish: vi.fn() } as never,
      isMakerModeOff: () => true,
      inFlightMakerBuys: () => 0,
      now: () => Date.parse(ACTIVATION) + 7,
    });
    coordinator.setReady(true);
    const commit = vi.fn(async (completedAt: string) => {
      expect(completedAt).toBe("2026-08-15T00:00:00.007Z");
      expect(coordinator.isLatched()).toBe(true);
    });

    expect(await coordinator.cancelSince(ACTIVATION, commit)).toBe("applied");
    expect(commit).toHaveBeenCalledOnce();
    expect(coordinator.isLatched()).toBe(false);
  });
});
