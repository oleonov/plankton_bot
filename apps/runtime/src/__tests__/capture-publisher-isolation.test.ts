import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXECUTION_POLICY,
  TokenMinimumAuthority,
  createBotRunId,
  createConditionId,
  createFillId,
  createLotId,
  createOrderId,
  createPositionId,
  createTokenId,
  type Order,
  type Fill,
  type InventoryLot,
  type NormalizedMarket,
  type Position,
  type PlaceOrderParams,
  type RuntimeEventMap,
} from "@krabs/domain";
import { bootstrapDatabase, SqliteOrderRepository, SqliteFillRepository } from "@krabs/db";
import { InProcessEventBus } from "@krabs/event-bus";
import { EntryLifecycleModule } from "../modules/entry-lifecycle/entry-lifecycle-module.js";
import { BounceAskCaptureLifecycleModule } from "../modules/bounce-ask-capture/bounce-ask-capture-lifecycle-module.js";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { CAPTURE_READ_RETRY_MS } from "../capture-work-runner.js";
import type { Logger } from "../logger.js";
import { resolveBounceAskPolicyOrigin, isOrdinaryBounceAskRoot } from "../bounce-ask-capture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(side: "buy" | "sell") {
  const conn = bootstrapDatabase(":memory:");
  const orderRepo = new SqliteOrderRepository(conn.db);
  const fillRepo = new SqliteFillRepository(conn.db);
  const bus = new InProcessEventBus();
  let now = Date.now();
  let paused = false,
    generation = 0;
  const cohort = new Date(now - 1_000).toISOString();
  const expiresAtUtc = new Date(now + 60_000).toISOString();
  const tokenId = createTokenId("123456789");
  const conditionId = createConditionId("capture-condition");
  const positionId = createPositionId("capture-position");
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  } as unknown as Logger;
  const policy = {
    ...DEFAULT_EXECUTION_POLICY,
    makerEntry: {
      ...DEFAULT_EXECUTION_POLICY.makerEntry,
      mode: "micro_live" as const,
      microLiveWindow: {
        activatedAtUtc: cohort,
        expiresAtUtc,
        maxCumulativeAcceptedPendingUsdc: 1,
        captureNextR23: true,
      },
      captureBookReprice: { enabled: true, maxRepricesPerRoot: 5 },
    },
    bounceAskCapture: {
      ...DEFAULT_EXECUTION_POLICY.bounceAskCapture,
      enabled: true,
      sourceCohortActivatedAtUtc: cohort,
      maxRepricesPerRoot: 1,
    },
  };
  const origin = (buy: boolean) => ({
    version: 1,
    kind: buy ? "r23_capture" : "bounce_exit_target",
    cohortId: cohort,
    originalSuggestedPrice: 0.4,
    originalTargetPrice: buy ? null : 0.3,
    entryPriceCeiling: buy ? policy.entryPriceCeiling : null,
    policySchemaVersion: policy.version,
    policyControlRevision: 7,
    initialBook: {
      depthStatus: "full",
      bestBid: 0.32,
      bestAsk: 0.36,
      tickSize: 0.01,
      snapshotTs: now,
      source: "test",
    },
  });
  const buy: Order = {
    orderId: createOrderId("buy-root"),
    clientOrderId: "buy-client" as Order["clientOrderId"],
    tokenId,
    conditionId,
    positionId,
    side: "buy",
    price: 0.3,
    size: 10,
    sizeUsdc: 3,
    status: side === "buy" ? "open" : "filled",
    orderType: "GTC",
    postOnly: true,
    entryStyle: "maker",
    exchangeOrderId: "buy-root",
    signalId: "buy-signal",
    signalReason: "probe-entry",
    decisionRuleId: "R23_DIP_TRIGGER",
    botRunId: createBotRunId("capture-run"),
    createdAt: cohort,
    updatedAt: cohort,
    metadata: {
      makerMicroLiveLifecycle: {
        kind: "r23_capture",
        activatedAtUtc: cohort,
        expiresAtUtc,
        fillWaitMs: 7_200_000,
      },
      makerCaptureLineageV1: {
        version: 1,
        rootOrderId: "buy-root",
        predecessorOrderId: null,
        replacementIndex: 0,
        rootNotionalUsdc: 3,
      },
      quoteMotionV1: origin(true),
    },
  };
  orderRepo.save(buy);
  const sell: Order = {
    ...buy,
    orderId: createOrderId("sell-root"),
    clientOrderId: "sell-client" as Order["clientOrderId"],
    exchangeOrderId: "sell-root",
    side: "sell",
    status: "open",
    price: 0.4,
    sizeUsdc: 4,
    signalReason: "repricing-exit",
    decisionRuleId: "BOUNCE_EXIT_TARGET",
    metadata: { bounceRung: { rungIndex: 0 }, quoteMotionV1: origin(false) },
  };
  const fill: Fill = {
    fillId: createFillId("source-fill"),
    orderId: buy.orderId,
    tokenId,
    conditionId,
    side: "buy",
    price: 0.3,
    size: 10,
    sizeUsdc: 3,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    filledAt: cohort,
  };
  if (side === "sell") {
    orderRepo.save(sell);
    fillRepo.save(fill);
  }
  const predecessor = side === "buy" ? buy : sell;
  const position = {
    positionId,
    tokenId,
    conditionId,
    size: 10,
    status: "open",
    avgEntryPrice: 0.3,
    costBasisUsdc: 3,
    entryStyle: "maker",
  } as Position;
  const lot = {
    lotId: createLotId("source-lot"),
    positionId,
    tokenId,
    fillId: fill.fillId,
    remainingSize: 10,
    entryPrice: 0.3,
  } as InventoryLot;
  const source = new TokenMinimumAuthority(
    async (id) => {
      const request = source.begin([id]);
      source.complete(request, new Map([[id, 1]]));
      return true;
    },
    () => {},
  );
  let remoteCancelled = false;
  const gateway = {
    prepareOrder: vi.fn(async (params: PlaceOrderParams) => ({
      params,
      receipt: await source.resolve(String(params.tokenId)),
    })),
    validatePreparedMinimum: vi.fn(
      (prepared: {
        params: PlaceOrderParams;
        receipt: Awaited<ReturnType<typeof source.resolve>>;
      }) => {
        source.validate(prepared.receipt, String(prepared.params.tokenId), prepared.params.size);
      },
    ),
    cancelOrder: vi.fn(async () => {
      remoteCancelled = true;
      return { success: true };
    }),
    getFillsResult: vi.fn(async () => ({ ok: true, data: [] })),
    getOrderResult: vi.fn(async () => ({
      ok: true,
      data: {
        orderId: predecessor.exchangeOrderId,
        clientOrderId: predecessor.clientOrderId,
        tokenId,
        side,
        price: predecessor.price,
        sizeTotal: predecessor.size,
        sizeFilled: 0,
        sizeRemaining: predecessor.size,
        status: remoteCancelled ? "CANCELLED" : "OPEN",
        createdAt: now - 1_000,
      },
    })),
  };
  const candidateBookCache = {
    prime: vi.fn(
      async () =>
        new Map([
          [
            String(tokenId),
            {
              tokenId: String(tokenId),
              snapshotTs: now,
              cachedAtMs: now,
              sourcePolledAtMs: now,
              sourceKind: "rest" as const,
              bookSource: "clob" as const,
              book: {
                tokenId,
                bids: [
                  { price: 0.32, size: 20 },
                  { price: 0.3, size: 10 },
                ],
                asks: [
                  { price: 0.36, size: 20 },
                  { price: 0.4, size: 10 },
                ],
                bestBid: 0.32,
                bestAsk: 0.36,
                midPrice: 0.34,
                spread: 0.04,
                minOrderSize: 1,
                timestamp: now,
              },
            },
          ],
        ]),
    ),
  };
  const runtimeControl = { isPaused: () => paused, generation: () => generation };
  const policySnapshot = () => ({ policy, controlRevision: 7 });
  const common = {
    bus,
    orderRepo,
    fillRepo,
    log,
    gateway: gateway as never,
    candidateBookCache,
    runtimeControl,
    now: () => now,
    policySnapshot,
  };
  if (side === "sell") {
    expect(orderRepo.getMakerCaptureChainUsage(buy.orderId)).toMatchObject({ trusted: true });
    expect(isOrdinaryBounceAskRoot(orderRepo.findById(sell.orderId)!)).toBe(true);
    expect(
      resolveBounceAskPolicyOrigin(positionId, tokenId, policy.bounceAskCapture, {
        orderRepo,
        fillRepo,
        positionRepo: { findById: () => position },
        inventoryLotRepo: { findOpen: () => [lot] },
      }),
    ).not.toBeNull();
  }
  const lifecycle =
    side === "buy"
      ? new EntryLifecycleModule({
          ...common,
          positionRepo: { findByTokenId: () => null },
          legStateRepo: {} as never,
          algoRulesRepo: {} as never,
          policy: () => policy,
          getOrderResult: gateway.getOrderResult as never,
        })
      : new BounceAskCaptureLifecycleModule({
          ...common,
          positionRepo: { findById: () => position },
          inventoryLotRepo: { findOpen: () => [lot] },
        });
  const market = (): NormalizedMarket =>
    ({
      tokenId,
      conditionId,
      active: true,
      tradable: true,
      acceptingOrders: true,
      enableOrderBook: true,
      tickSize: 0.01,
      negRisk: false,
      bestBid: 0.32,
      bestAsk: 0.36,
      snapshotTs: now,
      endDate: expiresAtUtc,
      minOrderSize: 1,
      bookSource: "clob",
    }) as unknown as NormalizedMarket;
  const execution = new ExecutionModule({
    bus,
    orderRepo,
    fillRepo,
    log,
    gateway: gateway as never,
    positionRepo: {
      findById: () => position,
      findByTokenId: () => position,
      findOpen: () => [],
    } as never,
    inventoryLotRepo: { findOpen: () => [lot] } as never,
    marketRepo: { findByTokenId: market } as never,
    runtimeMode: "live-lite",
    runtimeControl,
    botRunId: buy.botRunId,
    executionPolicy: () => policy,
    executionPolicySnapshot: policySnapshot,
    maxConcurrency: 1,
  });
  const commands: RuntimeEventMap["CancelOrderRequested"][] = [];
  bus.subscribe("CancelOrderRequested", async (event) => {
    commands.push(event);
  });
  const intent = () =>
    side === "buy"
      ? orderRepo.findMakerCaptureRepriceIntentByPredecessor(predecessor.orderId)
      : orderRepo.findBounceAskCaptureIntentByPredecessor(predecessor.orderId);
  return {
    bus,
    lifecycle,
    execution,
    gateway,
    candidateBookCache,
    commands,
    orderRepo,
    predecessor,
    intent,
    log,
    minimumChanged: () =>
      source.complete(source.begin([String(tokenId)]), new Map([[String(tokenId), 100]])),
    recordPartialFill: () => {
      fillRepo.save({
        ...fill,
        fillId: createFillId("concurrent-fill"),
        orderId: predecessor.orderId,
        side,
        size: 1,
        sizeUsdc: predecessor.price,
      });
      orderRepo.updateStatus(predecessor.orderId, "partially-filled");
    },
    publish: (overrides: Partial<NormalizedMarket> = {}) =>
      bus.publish("NormalizedMarketUpdated", {
        markets: [{ ...market(), ...overrides }],
        timestamp: now,
      }),
    removeMarket: () =>
      bus.publish("TrackedMarketsChanged", {
        addedTokenIds: [],
        removedTokenIds: [tokenId],
        activeTokenIds: [],
        timestamp: now,
      }),
    shortMarketEnd: () => new Date(now + 1_000).toISOString(),
    advance: () => {
      now += CAPTURE_READ_RETRY_MS;
    },
    pauseResume: () => {
      paused = true;
      generation++;
      paused = false;
      generation++;
    },
    close: async () => {
      await lifecycle.stop();
      await execution.stop();
      lifecycle.disposeTerminalListeners();
      conn.close();
    },
  };
}

describe("BUY capture recovery eligibility", () => {
  it.each(["minimum event", "inactive market event", "in-flight recovery"])(
    "preserves a post-cancel intent across cache loss: %s",
    async (removal) => {
      const h = harness("buy"),
        held = deferred();
      const healthy = h.candidateBookCache.prime.getMockImplementation()!;
      h.candidateBookCache.prime.mockImplementation(async () => {
        if (h.candidateBookCache.prime.mock.calls.length === 3)
          throw new DOMException("post-cancel read deferred", "TimeoutError");
        return healthy();
      });
      const signals = vi.fn();
      h.bus.subscribe("SignalProduced", async (event) => {
        signals(event);
      });
      try {
        await h.execution.start();
        await h.lifecycle.start();
        await h.publish();
        await vi.waitFor(() =>
          expect(h.log.warn).toHaveBeenCalledWith(
            { reason: "timeout" },
            "capture transient read deferred",
          ),
        );
        await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
        expect(h.intent()?.status).toBe("cancel_pending");
        expect(h.orderRepo.findById(h.predecessor.orderId)?.status).toBe("cancelled");
        h.advance();
        if (removal === "in-flight recovery") {
          const exact = h.gateway.getOrderResult.getMockImplementation()!;
          const entered = deferred();
          h.gateway.getOrderResult.mockImplementationOnce(async () => {
            entered.resolve();
            await held.promise;
            return exact();
          });
          await h.publish();
          await entered.promise;
          await h.removeMarket();
          held.resolve();
        } else if (removal === "inactive market event") {
          await h.publish({ active: false });
        } else {
          await h.removeMarket();
          await h.bus.publish("TokenMinimumChanged", {
            tokenId: String(h.predecessor.tokenId),
            minimum: 1,
          });
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(h.intent()).toMatchObject({ status: "cancel_pending", failure: null });
        expect(h.candidateBookCache.prime).toHaveBeenCalledTimes(3);
        expect(signals).not.toHaveBeenCalled();
        expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1);
        await h.publish();
        await vi.waitFor(() => expect(signals).toHaveBeenCalledTimes(1));
        expect(signals.mock.calls[0]![0].signal.makerCaptureReprice.intentId).toBe(
          h.intent()?.intentId,
        );
        expect(h.intent()?.status).toBe("ready");
        expect(h.commands).toHaveLength(1);
        expect(h.log.error).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await h.close();
      }
    },
  );

  it.each(["acceptingOrders", "tradable", "expiry"] as const)(
    "retains a queued predecessor and releases its ID across %s ineligibility",
    async (reason) => {
      const h = harness("buy"),
        held = deferred();
      const healthy = h.gateway.prepareOrder.getMockImplementation()!;
      h.gateway.prepareOrder.mockImplementation(async (params) => {
        const result = await healthy(params);
        if (h.gateway.prepareOrder.mock.calls.length === 2) await held.promise;
        return result;
      });
      try {
        await h.execution.start();
        await h.lifecycle.start();
        await h.publish(reason === "expiry" ? { endDate: h.shortMarketEnd() } : {});
        await vi.waitFor(() => expect(h.gateway.prepareOrder).toHaveBeenCalledTimes(2));
        if (reason === "expiry") h.advance();
        else h.pauseResume();
        held.resolve();
        await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
        expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
        const commandId = h.commands[0]!.command.commandId;
        if (reason !== "expiry") {
          await h.publish({ [reason]: false });
          await new Promise<void>((resolve) => setImmediate(resolve));
          await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
          expect(h.gateway.prepareOrder).toHaveBeenCalledTimes(2);
        }
        expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
        expect(h.orderRepo.findById(h.predecessor.orderId)?.status).toBe("open");
        expect(h.intent()).toMatchObject({ status: "cancel_pending", failure: null });
        expect(h.commands).toHaveLength(1);
        await h.publish();
        await vi.waitFor(() => expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
        expect(h.commands.map((event) => event.command.commandId)).toEqual([commandId, commandId]);
        expect(h.orderRepo.findById(h.predecessor.orderId)?.status).toBe("cancelled");
        expect(h.log.error).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await h.close();
      }
    },
  );
});

describe.each(["buy", "sell"] as const)("%s capture publisher isolation", (side) => {
  it.each(["book", "minimum"])(
    "releases the same queued cancel ID after a second-check %s TimeoutError",
    async (read) => {
      const h = harness(side);
      const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
      expect(timeout.code).toBe(23);
      const readMock = read === "book" ? h.candidateBookCache.prime : h.gateway.prepareOrder;
      const healthy = readMock.getMockImplementation()!;
      const failAt = read === "book" && side === "sell" ? 3 : 2;
      (readMock as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => {
        if (readMock.mock.calls.length === failAt) throw timeout;
        return (healthy as (...args: unknown[]) => unknown)(...args);
      });
      try {
        await h.execution.start();
        await h.lifecycle.start();
        await h.publish();
        await vi.waitFor(() => {
          expect(h.log.error).not.toHaveBeenCalled();
          expect(readMock).toHaveBeenCalledTimes(failAt);
        });
        await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
        expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
        expect(h.orderRepo.findById(h.predecessor.orderId)?.status).toBe("open");
        expect(h.intent()?.status).toBe("cancel_pending");
        const commandId = h.commands[0]!.command.commandId;
        await h.publish();
        expect(readMock).toHaveBeenCalledTimes(failAt);
        h.advance();
        await h.publish();
        await vi.waitFor(() => expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
        expect(h.commands.map((event) => event.command.commandId)).toEqual([commandId, commandId]);
        expect(h.orderRepo.findById(h.predecessor.orderId)?.status).toBe("cancelled");
        expect(h.log.warn).toHaveBeenCalledWith(
          { reason: "timeout" },
          "capture transient read deferred",
        );
      } finally {
        await h.close();
      }
    },
  );

  it.each(["stop", "pause-resume"])(
    "publishes unrelated work while capture is held and invalidates on %s",
    async (invalidate) => {
      const h = harness(side),
        held = deferred();
      const healthy = h.candidateBookCache.prime.getMockImplementation()!;
      h.candidateBookCache.prime.mockImplementationOnce(async () => {
        await held.promise;
        return healthy();
      });
      const decision = vi.fn();
      h.bus.subscribe("NormalizedMarketUpdated", async () => {
        decision();
      });
      try {
        await h.execution.start();
        await h.lifecycle.start();
        await h.publish();
        await vi.waitFor(() => expect(h.candidateBookCache.prime).toHaveBeenCalledTimes(1));
        expect(decision).toHaveBeenCalledTimes(1);
        expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
        let drained = false;
        const stopping =
          invalidate === "stop"
            ? h.lifecycle.stop().then(() => {
                drained = true;
              })
            : Promise.resolve();
        if (invalidate === "pause-resume") h.pauseResume();
        expect(drained).toBe(false);
        held.resolve();
        await stopping;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
        expect(h.commands).toHaveLength(0);
      } finally {
        held.resolve();
        await h.close();
      }
    },
  );

  it.each(["minimum", "fill", "resolution"])(
    "rejects stale queued preparation after %s evidence changes",
    async (change) => {
      const h = harness(side),
        held = deferred(),
        prepared = deferred();
      const healthy = h.gateway.prepareOrder.getMockImplementation()!;
      h.gateway.prepareOrder.mockImplementation(async (params) => {
        const result = await healthy(params);
        if (h.gateway.prepareOrder.mock.calls.length === 2) {
          prepared.resolve();
          await held.promise;
        }
        return result;
      });
      try {
        await h.execution.start();
        await h.lifecycle.start();
        await h.publish();
        await prepared.promise;
        if (change === "minimum") h.minimumChanged();
        if (change === "fill") h.recordPartialFill();
        if (change === "resolution")
          await h.bus.publish("MarketResolvedHint", {
            tokenIds: [h.predecessor.tokenId],
            conditionId: h.predecessor.conditionId,
            timestamp: Date.now(),
            marketId: null,
            slug: null,
            winningTokenId: null,
          });
        held.resolve();
        await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
        expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
        expect(h.orderRepo.findById(h.predecessor.orderId)?.status).toBe(
          change === "fill" ? "partially-filled" : "open",
        );
      } finally {
        held.resolve();
        await h.close();
      }
    },
  );

  it("keeps an unexpected queued preparation error a failure without cancellation permission", async () => {
    const h = harness(side);
    const healthy = h.gateway.prepareOrder.getMockImplementation()!;
    h.gateway.prepareOrder.mockImplementation(async (params) => {
      if (h.gateway.prepareOrder.mock.calls.length === 2) throw new Error("invalid request");
      return healthy(params);
    });
    try {
      await h.execution.start();
      await h.lifecycle.start();
      await h.publish();
      await vi.waitFor(() => expect(h.gateway.prepareOrder).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
      expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
      expect(h.intent()?.status).toBe("cancel_pending");
      expect(h.log.error).toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it("invalidates a queued second check and never retries its old callback after restart", async () => {
    const h = harness(side),
      held = deferred();
    const healthy = h.gateway.prepareOrder.getMockImplementation()!;
    h.gateway.prepareOrder.mockImplementation(async (params) => {
      if (h.gateway.prepareOrder.mock.calls.length === 2) await held.promise;
      return healthy(params);
    });
    try {
      await h.execution.start();
      await h.lifecycle.start();
      await h.publish();
      await vi.waitFor(() => expect(h.gateway.prepareOrder).toHaveBeenCalledTimes(2));
      await h.lifecycle.stop();
      held.resolve();
      await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
      const previous = h.commands[0]!;
      const reads = h.gateway.prepareOrder.mock.calls.length;
      h.advance();
      await h.lifecycle.start();
      expect(await previous.successorMinimum!()).toBeNull();
      expect(h.gateway.prepareOrder).toHaveBeenCalledTimes(reads);
      expect(h.gateway.cancelOrder).not.toHaveBeenCalled();
      expect(h.intent()?.status).toBe("cancel_pending");
    } finally {
      held.resolve();
      await h.close();
    }
  });

  it("persists a dispatched cancellation after lifecycle stop without issuing a successor", async () => {
    const h = harness(side),
      held = deferred();
    const cancel = h.gateway.cancelOrder.getMockImplementation()!;
    h.gateway.cancelOrder.mockImplementation(async () => {
      await held.promise;
      return cancel();
    });
    const signals = vi.fn();
    h.bus.subscribe("SignalProduced", async () => {
      signals();
    });
    try {
      await h.execution.start();
      await h.lifecycle.start();
      await h.publish();
      await vi.waitFor(() => expect(h.gateway.cancelOrder).toHaveBeenCalledTimes(1));
      await h.lifecycle.stop();
      held.resolve();
      await vi.waitFor(() => expect(h.execution.pendingCount).toBe(0));
      expect(h.orderRepo.findById(h.predecessor.orderId)?.status).toBe("cancelled");
      expect(h.intent()?.status).toBe("cancel_pending");
      expect(signals).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await h.close();
    }
  });
});
