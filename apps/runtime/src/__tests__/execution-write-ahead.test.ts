import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createBotRunId,
  createCommandId,
  createConditionId,
  createTokenId,
  type ClientOrderId,
  type PlaceOrderCommand,
  type PreparedOrderSubmitResult,
} from "@krabs/domain";
import { bootstrapDatabase, SqliteFillRepository, SqliteOrderRepository } from "@krabs/db";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";

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
    findByTokenId: vi.fn().mockReturnValue({ active: true }),
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
  const submitPreparedOrder = vi.fn(async (prepared: { orderId: string }) => {
    inspectPost?.(prepared.orderId);
    return outcomes[index++]!;
  });
  return {
    prepareOrder: vi.fn(async () => ({
      orderId: "0xwriteaheadhash",
      __preparedOrderBrand: "PreparedOrder" as const,
    })),
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

describe("ExecutionModule live write-ahead", () => {
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
