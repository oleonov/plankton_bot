import { describe, expect, it, vi } from "vitest";
import {
  createBotRunId,
  createConditionId,
  createOrderId,
  createTokenId,
  ExchangeErrorCode,
} from "@krabs/domain";
import type { ClientOrderId, Order, OrderRepository } from "@krabs/domain";
import {
  applyOrderVerdict,
  hasExactMatchedCoverage,
  hasLocalFullCoverage,
  resolveOrderStatusVerdict,
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

describe("order status resolver", () => {
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
    });

    expect(orderRepo.updateStatus).toHaveBeenCalledWith(
      order.orderId,
      "cancelled",
      undefined,
      "exchange-exact-cancelled",
      {
        cancelAgeMs: null,
        cancelAgeBucket: null,
        fillProgressShares: 5,
        marketHorizon: null,
      },
    );
  });
});
