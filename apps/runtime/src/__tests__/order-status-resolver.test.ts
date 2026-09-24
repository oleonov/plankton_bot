import { describe, expect, it, vi, onTestFinished } from "vitest";
import {
  createBotRunId,
  createConditionId,
  createOrderId,
  createTokenId,
  createPositionId,
  ExchangeErrorCode,
  pendingBuyIdentity,
  RESOLVED_LOSER_LOCAL_CANCEL_REASON,
} from "@krabs/domain";
import type { ClientOrderId, Order, OrderRepository } from "@krabs/domain";
import {
  applyOrderVerdict,
  inOrderLifecycleLane,
  hasExactMatchedCoverage,
  hasLocalFullCoverage,
  resolveOrderStatusVerdict,
  registerCancelIntent,
  clearCancelIntent,
  persistTerminalVerdictInLane,
  EXCHANGE_ABSENT_CANCEL_REASON,
} from "../modules/reconciliation/order-status-resolver.js";

const order: Order = {
  orderId: createOrderId("order-1"),
  clientOrderId: "client-1" as ClientOrderId,
  exchangeOrderId: "exchange-1",
  tokenId: createTokenId("token-1"),
  conditionId: createConditionId("condition-1"),
  side: "buy",
  orderType: "GTC",
  size: 100,
  sizeUsdc: 50,
  price: 0.5,
  status: "open",
  signalId: null,
  signalReason: null,
  botRunId: createBotRunId("run-1"),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function cancellationFixture() {
  let row: Order = { ...order, createdAt: new Date(1_000).toISOString() };
  let gross = 5;
  const updateStatus = vi.fn<OrderRepository["updateStatus"]>(
    (_id, status, _code, reason, telemetry) => {
      row = {
        ...row,
        status,
        ...(reason === undefined ? {} : { cancelReason: reason }),
        ...telemetry,
      };
    },
  );
  const publish = vi.fn(async () => {});
  const args = {
    orderRepo: { findById: () => row, updateStatus } as unknown as OrderRepository,
    fillRepo: {
      findByOrderId: () => [
        { side: "buy", size: gross - 0.1, sizeUsdc: gross / 2, price: 0.5, liquidityRole: "taker" },
      ],
    } as any,
    bus: { publish } as any,
    log: {} as any,
    orderId: order.orderId,
    exchange: { status: "CANCELLED" as const, sizeFilled: 5 },
    publish: true,
  };
  return {
    args,
    publish,
    updateStatus,
    row: () => row,
    setRow: (next: Order) => {
      row = next;
    },
    setGross: (next: number) => {
      gross = next;
    },
  };
}

describe("order status resolver", () => {
  it("evaluates validity after entering the existing lifecycle lane before terminal mutation or events", async () => {
    let current = true;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lane = inOrderLifecycleLane(String(order.orderId), () => blocked);
    const orderRepo = {
      findById: vi.fn(() => order),
      updateStatus: vi.fn(),
    } as unknown as OrderRepository;
    const publish = vi.fn();
    const onVerdictApplied = vi.fn();
    const pending = applyOrderVerdict({
      orderRepo,
      fillRepo: { findByOrderId: () => [] },
      bus: { publish } as any,
      log: {} as any,
      orderId: order.orderId,
      exchange: { status: "CANCELLED", sizeFilled: 0 },
      publish: true,
      isCurrent: () => current,
      onVerdictApplied,
    });
    current = false;
    release();
    await lane;
    expect(await pending).toEqual({ status: "unresolved" });
    expect(orderRepo.findById).toHaveBeenCalledOnce();
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(onVerdictApplied).not.toHaveBeenCalled();
  });

  it("keeps the local 0.5% completion normalization separate from exact coverage", () => {
    expect(hasLocalFullCoverage(order, 99.5)).toBe(true);
    expect(hasExactMatchedCoverage({ sizeFilled: 100 } as never, 99.5)).toBe(false);
  });

  it("requires persisted coverage before accepting an exchange cancellation", () => {
    const exchange = { status: "CANCELLED", sizeFilled: 5 } as never;
    expect(resolveOrderStatusVerdict(order, exchange, 4.999)).toEqual({ status: "unresolved" });
    expect(resolveOrderStatusVerdict(order, exchange, 5)).toEqual({
      status: "cancelled",
      reason: "exchange-exact-cancelled",
    });
  });

  it("lets complete persisted fill coverage dominate terminal exchange status", () => {
    expect(
      resolveOrderStatusVerdict(order, { status: "CANCELLED", sizeFilled: 99 } as never, 100),
    ).toEqual({ status: "filled" });
  });

  it("keeps found working, authoritative null, and terminal coverage gaps non-terminal", () => {
    expect(resolveOrderStatusVerdict(order, { status: "OPEN", sizeFilled: 0 } as never, 0)).toEqual(
      { status: "open" },
    );
    expect(
      resolveOrderStatusVerdict(order, { status: "PARTIALLY_FILLED", sizeFilled: 4 } as never, 4),
    ).toEqual({ status: "partially-filled" });
    expect(resolveOrderStatusVerdict(order, null, 0)).toEqual({ status: "unresolved" });
    expect(
      resolveOrderStatusVerdict(order, { status: "FILLED", sizeFilled: 10 } as never, 9.999),
    ).toEqual({ status: "unresolved" });
  });

  it("lets exact working evidence dominate the 0.5% local completion heuristic", () => {
    expect(
      resolveOrderStatusVerdict(order, { status: "OPEN", sizeFilled: 99.7 } as never, 99.7),
    ).toEqual({ status: "partially-filled" });
    expect(
      resolveOrderStatusVerdict(
        order,
        { status: "PARTIALLY_FILLED", sizeFilled: 99.7 } as never,
        99.7,
      ),
    ).toEqual({ status: "partially-filled" });
  });

  it("keeps a local full-fill claim fenced while exact evidence is still working", async () => {
    const mutableOrder = { ...order, status: "cancelled" as const, cancelReason: "operator" };
    const fills = [{ size: 100 }];
    const orderRepo = {
      findById: vi.fn().mockReturnValue(mutableOrder),
      updateStatus: vi.fn(),
    } as unknown as OrderRepository;
    const fillRepo = { findByOrderId: vi.fn().mockReturnValue(fills) } as never;

    await expect(
      applyOrderVerdict({
        orderRepo,
        fillRepo,
        log: { child: () => undefined } as never,
        orderId: order.orderId,
        exchange: { status: "PARTIALLY_FILLED", sizeFilled: 50 } as never,
      }),
    ).resolves.toEqual({ status: "unresolved" });
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("keeps a local cancellation contradicted by an exact working order unresolved", async () => {
    const cancelledOrder = { ...order, status: "cancelled" as const, cancelReason: "operator" };
    const orderRepo = {
      findById: vi.fn().mockReturnValue(cancelledOrder),
      updateStatus: vi.fn(),
    } as unknown as OrderRepository;
    const fillRepo = { findByOrderId: vi.fn().mockReturnValue([{ size: 5 }]) } as never;

    await expect(
      applyOrderVerdict({
        orderRepo,
        fillRepo,
        log: { child: () => undefined } as never,
        orderId: order.orderId,
        exchange: { status: "PARTIALLY_FILLED", sizeFilled: 5 } as never,
      }),
    ).resolves.toEqual({ status: "unresolved" });
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("does not trust a local filled status while exact evidence remains working", async () => {
    const filledOrder = { ...order, status: "filled" as const };
    const orderRepo = {
      findById: vi.fn().mockReturnValue(filledOrder),
      updateStatus: vi.fn(),
    } as unknown as OrderRepository;
    const fillRepo = { findByOrderId: vi.fn().mockReturnValue([{ size: 99.7 }]) } as never;

    await expect(
      applyOrderVerdict({
        orderRepo,
        fillRepo,
        log: { child: () => undefined } as never,
        orderId: order.orderId,
        exchange: { status: "OPEN", sizeFilled: 0 } as never,
      }),
    ).resolves.toEqual({ status: "unresolved" });
    expect(orderRepo.updateStatus).not.toHaveBeenCalled();
  });

  it("publishes one contract-valid rejection from concurrent exact INVALID consumers", async () => {
    let mutableOrder: Order = { ...order };
    const orderRepo = {
      findById: vi.fn().mockImplementation(() => mutableOrder),
      updateStatus: vi.fn().mockImplementation((_id, status, _exchangeCode, reason) => {
        mutableOrder = { ...mutableOrder, status, cancelReason: reason };
      }),
    } as unknown as OrderRepository;
    const fillRepo = { findByOrderId: vi.fn().mockReturnValue([]) } as never;
    const publish = vi.fn().mockResolvedValue(undefined);
    const args = {
      orderRepo,
      fillRepo,
      bus: { publish } as never,
      log: { child: () => undefined } as never,
      orderId: order.orderId,
      exchange: { status: "REJECTED", sizeFilled: 0 } as never,
      publish: true,
      timestamp: 1234,
    };

    await Promise.all([applyOrderVerdict(args), applyOrderVerdict(args)]);

    expect(orderRepo.updateStatus).toHaveBeenCalledOnce();
    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      order.orderId,
      "rejected",
      undefined,
      "exchange-exact-invalid",
    );
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(
      "OrderRejected",
      expect.objectContaining({
        clientOrderId: order.clientOrderId,
        tokenId: order.tokenId,
        conditionId: order.conditionId,
        side: order.side,
        reason: "exchange-exact-invalid",
        errorCode: ExchangeErrorCode.Unknown,
        timestamp: 1234,
      }),
    );
  });

  it("persists an exact INVALID verdict without publishing during startup", async () => {
    const orderRepo = {
      findById: vi.fn().mockReturnValue(order),
      updateStatus: vi.fn(),
    } as unknown as OrderRepository;
    const fillRepo = { findByOrderId: vi.fn().mockReturnValue([]) } as never;
    const publish = vi.fn();

    await applyOrderVerdict({
      orderRepo,
      fillRepo,
      bus: { publish } as never,
      log: { child: () => undefined } as never,
      orderId: order.orderId,
      exchange: { status: "REJECTED", sizeFilled: 0 } as never,
      publish: false,
    });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      order.orderId,
      "rejected",
      undefined,
      "exchange-exact-invalid",
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("persists durable partial fill progress for an exact cancellation without telemetry", async () => {
    const orderRepo = {
      findById: vi.fn().mockReturnValue(order),
      updateStatus: vi.fn(),
    } as unknown as OrderRepository;
    const fillRepo = { findByOrderId: vi.fn().mockReturnValue([{ size: 5 }]) } as never;

    await applyOrderVerdict({
      orderRepo,
      fillRepo,
      log: { child: () => undefined } as never,
      orderId: order.orderId,
      exchange: { status: "CANCELLED", sizeFilled: 5 } as never,
      timestamp: Date.parse(order.createdAt) + 5_000,
    });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      order.orderId,
      "cancelled",
      undefined,
      "exchange-exact-cancelled",
      {
        cancelAgeMs: 5_000,
        cancelAgeBucket: "<1min",
        fillProgressShares: 5,
        marketHorizon: null,
      },
    );
  });

  it.each([
    { label: "omitted", timestamp: undefined, age: 1_000 },
    { label: "supplied", timestamp: 1_500, age: 500 },
    { label: "zero age", timestamp: 1_000, age: 0 },
    { label: "invalid numeric", timestamp: NaN, age: null },
    { label: "before creation", timestamp: 999, age: null },
    { label: "explicit null telemetry", timestamp: undefined, age: null, explicit: true },
    {
      label: "explicit telemetry with different event time",
      timestamp: 9_000,
      age: 17,
      explicit: true,
    },
  ])("CANCEL_ANCHOR first write: $label", async ({ timestamp, age, explicit }) => {
    let clock = 2_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    onTestFinished(() => now.mockRestore());
    const f = cancellationFixture();
    const write = f.updateStatus.getMockImplementation()!;
    f.updateStatus.mockImplementation((...args) => {
      write(...args);
      clock = 10_000;
    });
    const snapshots: Order[] = [];
    f.publish.mockImplementation(async () => {
      snapshots.push({ ...f.row() });
    });
    registerCancelIntent(String(order.orderId), "bounce_ask_capture_reprice");
    await applyOrderVerdict({
      ...f.args,
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(explicit
        ? {
            cancelTelemetry: {
              cancelAgeMs: age,
              cancelAgeBucket: null,
              marketHorizon: age === null ? null : "short",
              fillProgressShares: 999,
            },
          }
        : {}),
    });
    expect(snapshots[0]).toMatchObject({
      cancelAgeMs: age,
      cancelAgeBucket: explicit || age === null ? null : "<1min",
      marketHorizon: explicit && age !== null ? "short" : null,
      fillProgressShares: 5,
      cancelReason: "bounce_ask_capture_reprice",
    });
    expect(f.publish).toHaveBeenCalledWith(
      "OrderCancelled",
      expect.objectContaining({ timestamp: timestamp ?? 2_000 }),
    );
    await applyOrderVerdict({ ...f.args, timestamp: 20_000 });
    expect(f.row()).toEqual(snapshots[0]);
    expect(f.updateStatus).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it("CANCEL_ANCHOR samples the clock only after winning the lifecycle lane", async () => {
    const f = cancellationFixture();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    onTestFinished(() => clock.mockRestore());
    const release = Promise.withResolvers<void>();
    const prior = inOrderLifecycleLane(String(order.orderId), () => release.promise);
    const pending = applyOrderVerdict(f.args);
    clock.mockReturnValue(3_000);
    release.resolve();
    await prior;
    await pending;
    expect(clock).toHaveBeenCalledOnce();
    expect(f.row().cancelAgeMs).toBe(2_000);
    expect(f.publish).toHaveBeenCalledWith(
      "OrderCancelled",
      expect.objectContaining({ timestamp: 3_000 }),
    );
  });

  it.each([
    "historical null",
    "persistence throw",
    "publication throw",
    "publish false",
    "no bus",
    "coverage gap",
    "full fills",
    "missing row",
    "resolved loser",
  ])("CANCEL_ANCHOR terminal effects: %s", async (mode) => {
    const f = cancellationFixture();
    const args = { ...f.args, timestamp: 2_000 };
    if (mode === "historical null")
      f.setRow({ ...f.row(), status: "cancelled", cancelAgeMs: null, cancelReason: "historical" });
    if (mode === "coverage gap") f.setGross(4);
    if (mode === "full fills") f.setGross(100);
    if (mode === "missing row") args.orderRepo.findById = () => null;
    if (mode === "publish false") args.publish = false;
    if (mode === "no bus") args.bus = undefined;
    if (mode === "resolved loser") {
      registerCancelIntent(String(order.orderId), "bounce_ask_capture_reprice");
      await persistTerminalVerdictInLane(
        args,
        f.row(),
        { status: "cancelled", reason: RESOLVED_LOSER_LOCAL_CANCEL_REASON },
        5,
      );
      expect(f.row().cancelReason).toBe(RESOLVED_LOSER_LOCAL_CANCEL_REASON);
      return;
    }
    if (mode === "persistence throw") {
      registerCancelIntent(String(order.orderId), "bounce_ask_capture_reprice");
      f.updateStatus.mockImplementationOnce(() => {
        throw new Error("write failed");
      });
      await expect(applyOrderVerdict(args)).rejects.toThrow("write failed");
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.row().status).toBe("open");
      await applyOrderVerdict(args);
      expect(f.row().cancelReason).toBe("bounce_ask_capture_reprice");
      return;
    }
    if (mode === "publication throw") {
      f.publish.mockRejectedValueOnce(new Error("publish failed"));
      await expect(applyOrderVerdict(args)).rejects.toThrow("publish failed");
      const first = { ...f.row() };
      await applyOrderVerdict({ ...args, timestamp: 8_000 });
      expect(f.row()).toEqual(first);
      f.setGross(100);
      await applyOrderVerdict({ ...args, timestamp: 9_000 });
      expect(f.row()).toEqual({ ...first, status: "filled" });
      expect(f.publish).toHaveBeenCalledOnce();
      return;
    }
    await applyOrderVerdict(args);
    expect(f.publish).not.toHaveBeenCalled();
    if (["historical null", "coverage gap", "missing row"].includes(mode)) {
      expect(f.updateStatus).not.toHaveBeenCalled();
      if (mode === "historical null")
        expect(f.row()).toMatchObject({ cancelAgeMs: null, cancelReason: "historical" });
    } else if (mode === "full fills") expect(f.row().status).toBe("filled");
    else
      expect(f.row()).toMatchObject({
        status: "cancelled",
        cancelAgeMs: 1_000,
        fillProgressShares: 5,
      });
  });
});

describe("exchange-absence terminal flag", () => {
  const absentTerminal = (target: Order, gross: number) =>
    resolveOrderStatusVerdict(target, null, gross, undefined, true);

  it("leaves an exact null non-terminal unless the reconciler sets the flag", () => {
    expect(resolveOrderStatusVerdict(order, null, 0)).toEqual({ status: "unresolved" });
    expect(resolveOrderStatusVerdict(order, null, 5)).toEqual({ status: "partially-filled" });
    expect(absentTerminal(order, 5)).toEqual({
      status: "cancelled",
      reason: EXCHANGE_ABSENT_CANCEL_REASON,
    });
  });

  it("still lets full local coverage win over the absence cancel", () => {
    expect(absentTerminal(order, 100)).toEqual({ status: "filled" });
  });

  it("never terminalizes an open pending-BUY recovery on the flag", () => {
    const base = { ...order, exchangeOrderId: "order-1", positionId: createPositionId("pos-1") };
    const recovery: Order = {
      ...base,
      metadata: {
        pendingBuyRecovery: {
          version: 1,
          groupId: "order-1",
          members: ["order-1"],
          role: "unknown",
          identity: pendingBuyIdentity(base),
          matched: 0,
          completed: false,
        },
      },
    };
    expect(absentTerminal(recovery, 5)).toEqual({ status: "unresolved" });
  });

  it("stores and publishes the absence reason over a leftover execution cancel intent", async () => {
    const f = cancellationFixture();
    registerCancelIntent(String(order.orderId), "stale_exit_ttl");
    onTestFinished(() => clearCancelIntent(String(order.orderId)));
    await applyOrderVerdict({ ...f.args, exchange: null, exchangeNullTerminal: true });
    expect(f.row()).toMatchObject({
      status: "cancelled",
      cancelReason: EXCHANGE_ABSENT_CANCEL_REASON,
    });
    expect(f.publish).toHaveBeenCalledWith(
      "OrderCancelled",
      expect.objectContaining({ reason: EXCHANGE_ABSENT_CANCEL_REASON }),
    );
  });
});
