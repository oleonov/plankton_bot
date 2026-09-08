import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createBotRunId,
  createCommandId,
  createConditionId,
  createPositionId,
  createFillId,
  createTokenId,
  ExchangeErrorCode,
  TokenMinimumAuthority,
  hasNeverPostedMinimumEvidence,
  type ClientOrderId,
  type PlaceOrderCommand,
  type PreparedOrderSubmitResult,
  type RuntimeEventMap,
} from "@krabs/domain";
import { bootstrapDatabase, SqliteFillRepository, SqliteOrderRepository } from "@krabs/db";
import { InProcessEventBus } from "@krabs/event-bus";
import { LiveExchangeGateway, LiveMarketDataGateway } from "@krabs/exchange";
import {
  OrderBuilder,
  type UserOrderV2,
  type CreateOrderOptions,
} from "@polymarket/clob-client-v2";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { prepareSuccessorMinimum } from "../min-order-size.js";

const dirs: string[] = [];
const tokenId = createTokenId("write-ahead-token");
const conditionId = createConditionId("write-ahead-condition");
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => log,
} as any;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function command(suffix = ""): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId(`write-ahead-command${suffix}`),
    clientOrderId: `write_ahead_client${suffix}` as ClientOrderId,
    source: "strategy",
    tokenId: suffix ? createTokenId(`write-ahead-token${suffix}`) : tokenId,
    conditionId: suffix ? createConditionId(`write-ahead-condition${suffix}`) : conditionId,
    side: "buy",
    size: 10,
    price: 0.5,
    orderType: "GTC",
    tickSize: 0.01,
    negRisk: false,
    sequenceInTick: 0,
    signalReason: null,
  };
}

function marketRepo() {
  return {
    findByTokenId: vi.fn((id: string) => ({
      active: true,
      conditionId: id.replace("write-ahead-token", "write-ahead-condition"),
    })),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
  };
}

function gateway(outcomes: PreparedOrderSubmitResult[], inspectPost?: (hash: string) => void) {
  let index = 0;
  const submitPreparedOrder = vi.fn(
    async (prepared: { orderId: string }, beforeInvoke?: () => void) => {
      beforeInvoke?.();
      inspectPost?.(prepared.orderId);
      return outcomes[index++]!;
    },
  );
  return {
    prepareOrder: vi.fn(async (params: { clientOrderId: string }) => {
      const suffix = params.clientOrderId.replace("write_ahead_client", "");
      return {
        orderId: `0xwriteaheadhash${suffix}`,
        __preparedOrderBrand: "PreparedOrder" as const,
      };
    }),
    submitPreparedOrder,
    placeOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAllOrders: vi.fn(),
    getOpenOrders: vi.fn().mockResolvedValue([]),
    getOpenOrdersForToken: vi.fn().mockResolvedValue([]),
    getFills: vi.fn().mockResolvedValue([]),
    getBalances: vi.fn().mockResolvedValue([]),
    getPositionBalance: vi.fn().mockResolvedValue(0),
    getOutcomeTokenBalance: vi.fn().mockResolvedValue(0n),
    redeemPositions: vi.fn(),
    mergePositions: vi.fn(),
    healthCheck: vi.fn(),
  };
}

function moduleWith(
  bus: InProcessEventBus,
  orderRepo: SqliteOrderRepository,
  fillRepo: SqliteFillRepository,
  liveGateway: ReturnType<typeof gateway>,
  maxConcurrency?: number,
) {
  return new ExecutionModule({
    gateway: liveGateway as any,
    bus,
    marketRepo: marketRepo() as any,
    orderRepo,
    fillRepo,
    log,
    botRunId: createBotRunId("write-ahead-run"),
    runtimeMode: "live-lite",
    runtimeControl: { isPaused: () => false },
    maxConcurrency,
  });
}

async function deliver(
  module: ExecutionModule,
  bus: InProcessEventBus,
  suffix = "",
): Promise<void> {
  await module.start();
  await bus.publish("PlaceOrderRequested", { command: command(suffix), timestamp: Date.now() });
}

function signedGateway() {
  const builder = new OrderBuilder(
    {
      getAddress: async () => "0x1111111111111111111111111111111111111111",
      _signTypedData: async () => `0x${"11".repeat(65)}`,
    },
    137,
  );
  const client = {
    chainId: 137,
    createOrder: vi.fn((order: UserOrderV2, options: CreateOrderOptions) =>
      builder.buildOrder(order, options, 2),
    ),
    getOrderBook: vi.fn().mockResolvedValue({ min_order_size: "5" }),
    postOrder: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  };
  const liveGateway = new LiveExchangeGateway({ client });
  const marketData = new LiveMarketDataGateway({ client });
  const source = new TokenMinimumAuthority(
    async (id) => {
      await marketData.getOrderBook(createTokenId(id));
      return true;
    },
    () => {},
  );
  marketData.setTokenMinimumAuthority(source);
  liveGateway.setTokenMinimumSource(source);
  return { client, liveGateway, marketData, source };
}

describe("ExecutionModule live write-ahead", () => {
  it.each([0.5, 6.5])(
    "reconciles SDK 6.50 after ambiguity and a local block, filled shares %s",
    async (filled) => {
      const conn = bootstrapDatabase(":memory:");
      const orders = new SqliteOrderRepository(conn.db);
      const fills = new SqliteFillRepository(conn.db);
      const cmd = {
        ...command(),
        tokenId: createTokenId("123456789"),
        positionId: createPositionId("signed-recovery"),
        side: "sell" as const,
        size: 6.504000000000005,
        price: 0.018,
        tickSize: 0.001,
      };
      const position = {
        positionId: cmd.positionId,
        tokenId: cmd.tokenId,
        conditionId,
        size: cmd.size,
        status: "open",
        avgEntryPrice: 0.01,
        costBasisUsdc: cmd.size * 0.01,
      };
      const { client, liveGateway, source } = signedGateway();
      client.postOrder.mockRejectedValue(new Error("timeout"));
      const prepare = vi.spyOn(liveGateway, "prepareOrder");
      const markets = marketRepo();
      markets.findByTokenId.mockReturnValue({ active: true, conditionId });
      const bus = new InProcessEventBus();
      const mod = new ExecutionModule({
        gateway: liveGateway,
        bus,
        marketRepo: markets as never,
        orderRepo: orders,
        fillRepo: fills,
        tokenMinimum: source,
        log,
        positionRepo: {
          findOpen: () => [position],
          findByTokenId: () => position,
          findById: () => position,
          findActiveByTokenId: () => [position],
        } as never,
        inventoryLotRepo: {
          findOpen: () => [{ remainingSize: position.size, entryPrice: 0.01 }],
        } as never,
        exchangeStateStore: {
          isBalanceBlocked: () => false,
          getOpenSellSizeUnknownToLocal: () => 0,
          getWalletPositionSize: () => position.size,
          getWalletPositionCapturedAt: () => Date.now(),
        } as never,
        botRunId: createBotRunId("signed-recovery"),
        runtimeMode: "live-lite",
        runtimeControl: { isPaused: () => false },
      });
      try {
        await mod.start();
        await bus.publish("PlaceOrderRequested", { command: cmd, timestamp: Date.now() });
        const pending = orders.findByClientOrderId(cmd.clientOrderId)!;
        expect(pending.status).toBe("pending");
        expect(pending.size).toBe(cmd.size);
        expect((client.postOrder.mock.calls[0]![0] as { makerAmount: string }).makerAmount).toBe(
          "6500000",
        );
        client.getOrderBook.mockResolvedValue({ min_order_size: "7" });
        expect(
          await liveGateway.submitPreparedOrder(await prepare.mock.results[0]!.value),
        ).toMatchObject({ kind: "local-minimum", neverPosted: false });
        expect(orders.findById(pending.orderId)).toEqual(pending);
        expect(hasNeverPostedMinimumEvidence(pending)).toBe(false);
        const fillId = createFillId("signed-recovery-fill");
        const at = Date.now();
        fills.save({
          fillId,
          orderId: pending.orderId,
          tokenId: cmd.tokenId,
          conditionId,
          side: "sell",
          price: cmd.price,
          size: filled,
          sizeUsdc: filled * cmd.price,
          liquidityRole: "maker",
          fee: 0,
          feeRateBps: 0,
          filledAt: new Date(at).toISOString(),
        });
        fills.markReconciled([fillId]);
        orders.save({ ...pending, status: "partially-filled", fillProgressShares: filled });
        position.size = cmd.size - filled;
        Object.assign(client, {
          getOrder: vi.fn(async () => ({
            id: pending.orderId,
            asset_id: cmd.tokenId,
            side: "SELL",
            price: String(cmd.price),
            original_size: "6.50",
            size_matched: String(filled),
            status: filled === 6.5 ? "FILLED" : "PARTIALLY_FILLED",
            created_at: at / 1000,
          })),
        });
        const exact = await liveGateway.getOrderResult(pending.orderId);
        expect(exact.ok).toBe(true);
        if (!exact.ok) throw new Error("exact signed response was not parsed");
        const snapshot = {
          fills: [
            { fillId, orderId: pending.orderId, tokenId: cmd.tokenId, size: filled, timestamp: at },
          ],
        };
        const coverage = (child: typeof pending) =>
          (
            mod as unknown as { reconciledRecoveryCoverage(...args: unknown[]): string | null }
          ).reconciledRecoveryCoverage(
            pending,
            child,
            { residualShares: cmd.size },
            snapshot,
            exact.data,
          );
        const child = orders.findById(pending.orderId)!;
        expect(coverage(child)).toBe(filled === 6.5 ? "terminal" : "partial");
        expect(
          coverage({ ...child, metadata: { ...child.metadata, signedOrderFactsV1: null } }),
        ).toBeNull();
        expect(position.size).toBeCloseTo(cmd.size - filled, 12);
        expect(client.postOrder).toHaveBeenCalledOnce();
        expect(orders.findByTokenId(cmd.tokenId)).toHaveLength(1);
      } finally {
        await mod.stop();
        conn.close();
      }
    },
  );

  it("retains a predecessor when the minimum changes in the cancel queue and releases the deterministic cancel ID", async () => {
    const conn = bootstrapDatabase(":memory:");
    const orders = new SqliteOrderRepository(conn.db);
    const fills = new SqliteFillRepository(conn.db);
    const a = { ...command("-a"), tokenId: createTokenId("111111") };
    const b = { ...command("-b"), tokenId: createTokenId("222222") };
    const { client, liveGateway, source, marketData } = signedGateway();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    client.postOrder.mockImplementation(async (signed) => {
      const cmd = (signed as { tokenId: string }).tokenId === a.tokenId ? a : b;
      if (cmd === a) await held;
      return { orderID: orders.findByClientOrderId(cmd.clientOrderId)!.orderId };
    });
    const cancelOrder = vi.fn(async ({ orderID }: { orderID: string }) => ({
      canceled: [orderID],
      not_canceled: {},
    }));
    Object.assign(client, {
      cancelOrder,
      getTradesPaginated: vi.fn().mockResolvedValue({ data: [], next_cursor: "LTE=" }),
      getOrder: vi.fn(async (id: string) => {
        const order = orders.findByExchangeOrderId(id)!;
        return {
          id,
          asset_id: String(order.tokenId),
          side: "BUY",
          price: String(order.price),
          original_size: String(order.size),
          size_matched: "0",
          status: "CANCELLED",
          created_at: Date.now() / 1000,
        };
      }),
    });
    const markets = marketRepo();
    markets.findByTokenId.mockImplementation((id) => ({
      active: true,
      conditionId: id === a.tokenId ? a.conditionId : b.conditionId,
    }));
    const bus = new InProcessEventBus();
    const mod = new ExecutionModule({
      gateway: liveGateway,
      bus,
      marketRepo: markets as never,
      orderRepo: orders,
      fillRepo: fills,
      tokenMinimum: source,
      log,
      maxConcurrency: 1,
      botRunId: createBotRunId("minimum-cancel"),
      runtimeMode: "live-lite",
      runtimeControl: { isPaused: () => false },
    });
    try {
      await mod.start();
      await bus.publish("PlaceOrderRequested", { command: b, timestamp: Date.now() });
      await vi.waitFor(() =>
        expect(orders.findByClientOrderId(b.clientOrderId)?.status).toBe("open"),
      );
      const predecessor = orders.findByClientOrderId(b.clientOrderId)!;
      const successorMinimum = () =>
        prepareSuccessorMinimum(liveGateway, () => {
          const current = orders.findById(predecessor.orderId);
          return current?.status === "open" ? { params: b, state: JSON.stringify(current) } : null;
        });
      expect((await successorMinimum())?.()).toBe(true);
      await bus.publish("PlaceOrderRequested", { command: a, timestamp: Date.now() });
      await vi.waitFor(() => expect(client.postOrder).toHaveBeenCalledTimes(2));
      const event = {
        command: {
          type: "CancelOrderCommand" as const,
          commandId: createCommandId("queued-minimum-cancel"),
          orderId: predecessor.orderId,
          reason: "stale_entry_ttl" as const,
        },
        successorMinimum,
        timestamp: Date.now(),
      };
      await bus.publish("CancelOrderRequested", event);
      client.getOrderBook.mockResolvedValue({ min_order_size: "11" });
      await marketData.getOrderBook(b.tokenId);
      release();
      await vi.waitFor(() => expect(mod.getDiagnostics().cancelCompleted).toBe(1));
      expect(cancelOrder).not.toHaveBeenCalled();
      expect(orders.findById(predecessor.orderId)?.status).toBe("open");
      client.getOrderBook.mockResolvedValue({ min_order_size: "5" });
      await marketData.getOrderBook(b.tokenId);
      await bus.publish("CancelOrderRequested", event);
      await vi.waitFor(() => expect(cancelOrder).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(orders.findById(predecessor.orderId)?.status).toBe("cancelled"),
      );
      expect(client.postOrder).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await mod.stop();
      conn.close();
    }
  });

  it.each([5, 11, null])(
    "keeps attempt authority through the real delayed lane: latest minimum %s",
    async (minimum) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const conn = bootstrapDatabase(":memory:");
      const orders = new SqliteOrderRepository(conn.db);
      const fills = new SqliteFillRepository(conn.db);
      const a = { ...command("-a"), tokenId: createTokenId("111111") };
      const b = { ...command("-b"), tokenId: createTokenId("222222") };
      const { client, liveGateway, source } = signedGateway();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      client.postOrder.mockImplementation(async (signed) => {
        const cmd = (signed as { tokenId: string }).tokenId === a.tokenId ? a : b;
        if (cmd === a) await held;
        return { orderID: orders.findByClientOrderId(cmd.clientOrderId)!.orderId };
      });
      const markets = marketRepo();
      markets.findByTokenId.mockImplementation((id) => ({
        active: true,
        conditionId: id === a.tokenId ? a.conditionId : b.conditionId,
      }));
      const bus = new InProcessEventBus();
      const mod = new ExecutionModule({
        gateway: liveGateway,
        bus,
        marketRepo: markets as any,
        orderRepo: orders,
        fillRepo: fills,
        tokenMinimum: source,
        log,
        maxConcurrency: 2,
        botRunId: createBotRunId("minimum-lane"),
        runtimeMode: "live-lite",
        runtimeControl: { isPaused: () => false },
      });
      let first: Promise<void> | undefined;
      let second: Promise<void> | undefined;
      try {
        await mod.start();
        first = bus.publish("PlaceOrderRequested", { command: a, timestamp: Date.now() });
        await vi.waitFor(() => expect(client.postOrder).toHaveBeenCalledOnce());
        second = bus.publish("PlaceOrderRequested", { command: b, timestamp: Date.now() });
        await vi.waitFor(() =>
          expect(orders.findByClientOrderId(b.clientOrderId)?.status).toBe("pending"),
        );
        vi.setSystemTime(Date.now() + 60_000);
        if (minimum !== 5)
          source.complete(source.begin([b.tokenId]), new Map([[b.tokenId, minimum]]));
        release();
        await Promise.all([first, second]);
        await vi.waitFor(() =>
          expect(orders.findByClientOrderId(a.clientOrderId)?.status).toBe("open"),
        );
        await vi.waitFor(() =>
          expect(orders.findByClientOrderId(b.clientOrderId)?.status).not.toBe("pending"),
        );
        expect(client.postOrder).toHaveBeenCalledTimes(minimum === 5 ? 2 : 1);
        expect(orders.findByClientOrderId(a.clientOrderId)?.status).toBe("open");
        const child = orders.findByClientOrderId(b.clientOrderId)!;
        expect(child.status).toBe(minimum === 5 ? "open" : "rejected");
        expect(hasNeverPostedMinimumEvidence(child)).toBe(minimum !== 5);
        expect(client.createOrder).toHaveBeenCalledTimes(2);
      } finally {
        release();
        await Promise.all([first, second]);
        await mod.stop();
        conn.close();
      }
    },
  );

  it.each(["buy", "sell"] as const)(
    "replaces a provably never-posted SQLite %s identity on the identical deterministic retry, preserving inventory clamps",
    async (side) => {
      const conn = bootstrapDatabase(":memory:");
      const orders = new SqliteOrderRepository(conn.db);
      const fills = new SqliteFillRepository(conn.db);
      const positionId = createPositionId("minimum-retry-position");
      const cmd = {
        ...command(),
        tokenId: createTokenId("123456789"),
        side,
        ...(side === "sell" ? { positionId } : {}),
      };
      const position = {
        positionId,
        tokenId: cmd.tokenId,
        conditionId,
        size: 8,
        status: "open",
        avgEntryPrice: 0.1,
        costBasisUsdc: 0.8,
      };
      const expectedSize = side === "sell" ? 8 : 10;
      const { client, liveGateway, marketData, source } = signedGateway();
      client.postOrder.mockImplementation(async () => ({
        orderID: orders.findByClientOrderId(cmd.clientOrderId)!.orderId,
      }));
      const bus = new InProcessEventBus();
      const skipped: RuntimeEventMap["OrderSkipped"][] = [];
      bus.subscribe("OrderSkipped", async (event) => {
        skipped.push(event);
      });
      const markets = marketRepo();
      markets.findByTokenId.mockReturnValue({ active: true, conditionId });
      const mod = new ExecutionModule({
        gateway: liveGateway,
        bus,
        marketRepo: markets as any,
        orderRepo: orders,
        fillRepo: fills,
        tokenMinimum: source,
        log,
        botRunId: createBotRunId("minimum-retry"),
        ...(side === "sell"
          ? {
              positionRepo: {
                findByTokenId: () => position,
                findById: () => position,
                findActiveByTokenId: () => [position],
                findOpen: () => [position],
              } as never,
              inventoryLotRepo: {
                findOpen: () => [{ remainingSize: 8, entryPrice: 0.1 }],
              } as never,
            }
          : {}),
        runtimeMode: "live-lite",
        runtimeControl: { isPaused: () => false },
      });
      const save = orders.save.bind(orders);
      let interruptPending = true;
      vi.spyOn(orders, "save").mockImplementation((order) => {
        save(order);
        if (order.status === "pending" && interruptPending) {
          interruptPending = false;
          source.complete(source.begin([cmd.tokenId]), new Map([[cmd.tokenId, 11]]));
        }
      });
      const replace = vi.spyOn(orders, "replacePendingIdentity");
      try {
        await mod.start();
        await bus.publish("PlaceOrderRequested", { command: cmd, timestamp: Date.now() });
        expect(client.postOrder).not.toHaveBeenCalled();
        const rejected = orders.findByClientOrderId(cmd.clientOrderId)!;
        expect(hasNeverPostedMinimumEvidence(rejected)).toBe(true);
        expect(rejected.size).toBe(expectedSize);
        expect(skipped).toHaveLength(1);
        await marketData.getOrderBook(cmd.tokenId);
        await bus.publish("PlaceOrderRequested", { command: cmd, timestamp: Date.now() });
        expect(replace).toHaveBeenCalledOnce();
        expect(client.postOrder).toHaveBeenCalledOnce();
        const accepted = orders.findByClientOrderId(cmd.clientOrderId)!;
        expect(accepted.status).toBe("open");
        expect(accepted.size).toBe(expectedSize);
        expect(accepted.metadata?.neverPostedMinimumV1).toBeUndefined();
        expect(accepted.metadata?.signedOrderFactsV1).toMatchObject({
          orderId: accepted.orderId,
          logicalSize: expectedSize,
          shares: expectedSize,
        });
        expect(fills.findByOrderId(accepted.orderId)).toEqual([]);
      } finally {
        await mod.stop();
        conn.close();
      }
    },
  );

  it("commits the complete exact-hash pending row before POST", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-write-ahead-"));
    dirs.push(dir);
    const file = path.join(dir, "ledger.db");
    const writer = bootstrapDatabase(file);
    const reader = bootstrapDatabase(file);
    const orders = new SqliteOrderRepository(writer.db);
    const observed = new SqliteOrderRepository(reader.db);
    const fills = new SqliteFillRepository(writer.db);
    const liveGateway = gateway(
      [{ kind: "unknown", errorMessage: "timeout", errorDetails: null }],
      (hash) => {
        const pending = observed.findByExchangeOrderId(hash);
        expect(pending).toMatchObject({
          orderId: hash,
          exchangeOrderId: hash,
          clientOrderId: "write_ahead_client",
          tokenId,
          conditionId,
          positionId: null,
          side: "buy",
          orderType: "GTC",
          postOnly: false,
          price: 0.5,
          size: 10,
          sizeUsdc: 5,
          status: "pending",
          signalId: null,
          signalReason: null,
          decisionRuleId: null,
          signalTimestamp: null,
          entryStyle: null,
          exchangeErrorCode: null,
          exchangeErrorMessage: null,
          exchangeErrorPayload: null,
          exchangeRejectionReason: null,
          metadata: { orderSource: "strategy" },
          botRunId: createBotRunId("write-ahead-run"),
        });
      },
    );
    const bus = new InProcessEventBus();
    const mod = moduleWith(bus, orders, fills, liveGateway);

    await deliver(mod, bus);
    expect(liveGateway.submitPreparedOrder).toHaveBeenCalledOnce();
    expect(orders.findByExchangeOrderId("0xwriteaheadhash")?.status).toBe("pending");
    await mod.stop();
    reader.close();
    writer.close();
  });

  it("persists semantic trading-disabled rejections while bounding repeated WARN telemetry", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-write-ahead-"));
    dirs.push(dir);
    const conn = bootstrapDatabase(path.join(dir, "ledger.db"));
    const orders = new SqliteOrderRepository(conn.db);
    const fills = new SqliteFillRepository(conn.db);
    const actualDetails = {
      responseBody: { status: 503, error: "trading is disabled" },
    };
    const syntheticDetails = {
      ...actualDetails,
      synthetic: "trading-disabled-cooldown",
      retryAt: Date.now() + 300_000,
    };
    const liveGateway = gateway([
      {
        kind: "rejected",
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "trading is disabled",
        errorDetails: actualDetails,
      },
      {
        kind: "rejected",
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "trading is disabled",
        errorDetails: syntheticDetails,
      },
      {
        kind: "rejected",
        errorCode: ExchangeErrorCode.Unknown,
        errorMessage: "trading is disabled",
        errorDetails: syntheticDetails,
      },
    ]);
    const bus = new InProcessEventBus();
    const rejected: RuntimeEventMap["OrderRejected"][] = [];
    bus.subscribe("OrderRejected", async (event) => {
      rejected.push(event);
    });
    const writeCounter = vi.fn();
    log.warn.mockClear();
    const mod = new ExecutionModule({
      gateway: liveGateway as any,
      bus,
      marketRepo: marketRepo() as any,
      orderRepo: orders,
      fillRepo: fills,
      log,
      botRunId: createBotRunId("write-ahead-run"),
      runtimeMode: "live-lite",
      runtimeControl: { isPaused: () => false },
      runtimeMetrics: { writeEvent: vi.fn(), writeCounter },
    });
    await mod.start();

    for (const suffix of ["-disabled-one", "-disabled-two", "-disabled-three"]) {
      await bus.publish("PlaceOrderRequested", { command: command(suffix), timestamp: Date.now() });
    }

    expect(rejected).toHaveLength(3);
    for (const suffix of ["-disabled-one", "-disabled-two", "-disabled-three"]) {
      expect(orders.findByClientOrderId(`write_ahead_client${suffix}`)).toMatchObject({
        status: "rejected",
        exchangeRejectionReason: "rejection_trading_disabled",
      });
    }
    expect(
      log.warn.mock.calls.filter((call: unknown[]) => call[1] === "order rejected by gateway"),
    ).toHaveLength(1);
    expect(
      writeCounter.mock.calls.filter(
        (call: unknown[]) => call[0] === "exchange_trading_disabled_rejection_total",
      ),
    ).toHaveLength(3);

    await mod.stop();
    conn.close();
  });

  it("does not re-sign or repost unknown and accepted-before-open pending rows after fresh delivery", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-write-ahead-"));
    dirs.push(dir);
    const file = path.join(dir, "ledger.db");
    const first = bootstrapDatabase(file);
    const orders = new SqliteOrderRepository(first.db);
    const fills = new SqliteFillRepository(first.db);
    const unknownGateway = gateway([
      { kind: "unknown", errorMessage: "timeout", errorDetails: null },
    ]);
    const firstBus = new InProcessEventBus();
    const firstMod = moduleWith(firstBus, orders, fills, unknownGateway);
    await deliver(firstMod, firstBus);
    await firstMod.stop();
    first.close();

    const second = bootstrapDatabase(file);
    const secondGateway = gateway([{ kind: "accepted", orderId: "0xwriteaheadhash" }]);
    const secondBus = new InProcessEventBus();
    const secondMod = moduleWith(
      secondBus,
      new SqliteOrderRepository(second.db),
      new SqliteFillRepository(second.db),
      secondGateway,
    );
    await deliver(secondMod, secondBus);
    expect(secondGateway.prepareOrder).not.toHaveBeenCalled();
    expect(secondGateway.submitPreparedOrder).not.toHaveBeenCalled();
    await secondMod.stop();
    second.close();
  });

  it("keeps an accepted order pending when the open update fails, so a fresh module fences redelivery", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-write-ahead-"));
    dirs.push(dir);
    const file = path.join(dir, "ledger.db");
    const first = bootstrapDatabase(file);
    const orders = new SqliteOrderRepository(first.db);
    const failingOrders = Object.create(orders) as SqliteOrderRepository;
    failingOrders.updateStatus = () => {
      throw new Error("open update failed");
    };
    const firstGateway = gateway([{ kind: "accepted", orderId: "0xwriteaheadhash" }]);
    const firstBus = new InProcessEventBus();
    const firstMod = moduleWith(
      firstBus,
      failingOrders,
      new SqliteFillRepository(first.db),
      firstGateway,
    );

    await deliver(firstMod, firstBus);
    expect(orders.findByExchangeOrderId("0xwriteaheadhash")?.status).toBe("pending");
    await firstMod.stop();
    first.close();

    const second = bootstrapDatabase(file);
    const secondGateway = gateway([{ kind: "accepted", orderId: "0xwriteaheadhash" }]);
    const secondBus = new InProcessEventBus();
    const secondMod = moduleWith(
      secondBus,
      new SqliteOrderRepository(second.db),
      new SqliteFillRepository(second.db),
      secondGateway,
    );
    await deliver(secondMod, secondBus);
    expect(secondGateway.prepareOrder).not.toHaveBeenCalled();
    expect(secondGateway.submitPreparedOrder).not.toHaveBeenCalled();
    await secondMod.stop();
    second.close();
  });

  it("serializes concurrent prepared POSTs through the global submission lane", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-write-ahead-"));
    dirs.push(dir);
    const conn = bootstrapDatabase(path.join(dir, "ledger.db"));
    const release = (() => {
      let resolve!: (value: PreparedOrderSubmitResult) => void;
      return {
        promise: new Promise<PreparedOrderSubmitResult>((done) => (resolve = done)),
        resolve,
      };
    })();
    const liveGateway = gateway([]);
    let calls = 0;
    liveGateway.prepareOrder.mockImplementation(async () => ({
      orderId: `0xqueued${++calls}`,
      __preparedOrderBrand: "PreparedOrder" as const,
    }));
    liveGateway.submitPreparedOrder.mockImplementation(async () =>
      liveGateway.submitPreparedOrder.mock.calls.length === 1
        ? release.promise
        : { kind: "accepted", orderId: "0xqueued2" },
    );
    const bus = new InProcessEventBus();
    const mod = moduleWith(
      bus,
      new SqliteOrderRepository(conn.db),
      new SqliteFillRepository(conn.db),
      liveGateway,
      2,
    );
    await mod.start();
    const first = bus.publish("PlaceOrderRequested", {
      command: command("-one"),
      timestamp: Date.now(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = bus.publish("PlaceOrderRequested", {
      command: command("-two"),
      timestamp: Date.now(),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(liveGateway.submitPreparedOrder).toHaveBeenCalledTimes(1);
    release.resolve({ kind: "accepted", orderId: "0xqueued1" });
    await Promise.all([first, second]);
    await mod.stop();
    expect(liveGateway.submitPreparedOrder).toHaveBeenCalledTimes(2);
    conn.close();
  });

  it("latches the global lane and pauses when a returned hash mismatches, even if evidence persistence fails", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-write-ahead-"));
    dirs.push(dir);
    const conn = bootstrapDatabase(path.join(dir, "ledger.db"));
    const liveGateway = gateway([]);
    let prepared = 0;
    liveGateway.prepareOrder.mockImplementation(async () => ({
      orderId: `0xmismatch${++prepared}`,
      __preparedOrderBrand: "PreparedOrder" as const,
    }));
    liveGateway.submitPreparedOrder.mockResolvedValue({ kind: "accepted", orderId: "0xreturned" });
    const pauseLiveTrading = vi.fn();
    const bus = new InProcessEventBus();
    vi.resetModules();
    try {
      const { ExecutionModule: IsolatedExecutionModule } =
        await import("../modules/execution/execution-module.js");
      const mod = new IsolatedExecutionModule({
        gateway: liveGateway as any,
        bus,
        marketRepo: marketRepo() as any,
        orderRepo: new SqliteOrderRepository(conn.db),
        fillRepo: new SqliteFillRepository(conn.db),
        log,
        botRunId: createBotRunId("write-ahead-run"),
        runtimeMode: "live-lite",
        runtimeControl: { isPaused: () => false },
        maxConcurrency: 2,
        pauseLiveTrading,
        riskEventRepo: {
          insert: vi.fn(() => {
            throw new Error("risk db unavailable");
          }),
        } as any,
      });
      await mod.start();
      await Promise.all([
        bus.publish("PlaceOrderRequested", {
          command: command("-mismatch-one"),
          timestamp: Date.now(),
        }),
        bus.publish("PlaceOrderRequested", {
          command: command("-mismatch-two"),
          timestamp: Date.now(),
        }),
      ]);
      await mod.stop();

      expect(pauseLiveTrading).toHaveBeenCalledOnce();
      expect(liveGateway.submitPreparedOrder).toHaveBeenCalledTimes(1);
    } finally {
      conn.close();
      vi.resetModules();
    }
  });
});
