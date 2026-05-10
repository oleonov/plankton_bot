/**
 * Wallet reservation rejection tests for ExecutionModule.
 *
 * Verifies that BUY orders are rejected when wallet balance minus the wallet
 * buffer cannot cover the order notional. Covers both the percentage-based
 * buffer path and the floor (minUsdc) path, plus per-instance override.
 *
 * Ref: docs/audits/2026-04-19-algo-spec-remediation-plan.md §8.1
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createCommandId,
  createBotRunId,
  createConditionId,
  DEFAULT_BUY_CAPACITY_POLICY,
  DEFAULT_EXECUTION_POLICY,
} from "@krabs/domain";
import type {
  ExchangeGateway,
  PlaceOrderParams,
  CancelOrderParams,
  PlaceOrderResult,
  CancelOrderResult,
  ExchangeOrder,
  ExchangeFill,
  ExchangeBalance,
  OrderRepository,
  FillRepository,
  PlaceOrderCommand,
  ExecutionPolicy,
  TokenId,
  ClientOrderId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────

const BOT_RUN_ID = createBotRunId("test-wallet-run");

function makeBuyCmd(overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId("cmd-wallet-1"),
    clientOrderId: "plk_wallet_test" as ClientOrderId,
    source: "strategy",
    tokenId: createTokenId("tok-yes"),
    conditionId: createConditionId("cond-wallet-1"),
    side: "buy",
    size: 10,
    price: 0.5,
    orderType: "GTC",
    tickSize: 0.01,
    negRisk: false,
    sequenceInTick: 0,
    signalReason: null,
    ...overrides,
  };
}

function makeSellCmd(overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
  return makeBuyCmd({
    commandId: createCommandId("cmd-sell-1"),
    clientOrderId: "plk_sell_test" as ClientOrderId,
    side: "sell",
    signalReason: "repricing-exit",
    ...overrides,
  });
}

function createMockGateway(): ExchangeGateway {
  return {
    placeOrder: vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValue({ success: true, orderId: "sim-ord-wallet" }),
    cancelOrder: vi
      .fn<(params: CancelOrderParams) => Promise<CancelOrderResult>>()
      .mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ success: true }),
    getOpenOrders: vi.fn<() => Promise<ExchangeOrder[]>>().mockResolvedValue([]),
    getOpenOrdersForToken: vi
      .fn<(tokenId: TokenId) => Promise<ExchangeOrder[]>>()
      .mockResolvedValue([]),
    getFills: vi.fn<(sinceMs: number) => Promise<ExchangeFill[]>>().mockResolvedValue([]),
    getBalances: vi.fn<() => Promise<ExchangeBalance[]>>().mockResolvedValue([]),
    getPositionBalance: vi.fn<(tokenId: TokenId) => Promise<number>>().mockResolvedValue(0),
    getOutcomeTokenBalance: vi.fn<(tokenId: TokenId) => Promise<bigint>>().mockResolvedValue(0n),
    redeemPositions: vi.fn<(conditionIds: string[]) => Promise<void>>().mockResolvedValue(),
    mergePositions: vi
      .fn<(merges: { conditionId: string; amount: number }[]) => Promise<void>>()
      .mockResolvedValue(),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  };
}

function createMockMarketRepo() {
  return {
    save: vi.fn(),
    saveBatch: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue({ active: true }),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    upsertAll: vi.fn(),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    updateScoresBatch: vi.fn(),
  };
}

function createMockOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

function buyCapacityPolicy(overrides?: Partial<typeof DEFAULT_EXECUTION_POLICY.buyCapacity>) {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    buyCapacity: {
      ...DEFAULT_BUY_CAPACITY_POLICY,
      ...overrides,
    },
  };
}

function executionPolicy(overrides?: Partial<ExecutionPolicy>): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    ...overrides,
    buyCapacity: {
      ...DEFAULT_EXECUTION_POLICY.buyCapacity,
      ...overrides?.buyCapacity,
    },
    sellCapacity: {
      ...DEFAULT_EXECUTION_POLICY.sellCapacity,
      ...overrides?.sellCapacity,
    },
    orderCapacity: {
      ...DEFAULT_EXECUTION_POLICY.orderCapacity,
      ...overrides?.orderCapacity,
    },
  };
}

function openOrderFromCommand(command: PlaceOrderCommand, orderId: string) {
  return {
    ...command,
    orderId,
    orderType: "GTC",
    postOnly: true,
    status: "open",
    sizeUsdc: command.size * command.price,
    exchangeOrderId: null,
    signalId: null,
    signalReason: command.signalReason,
    botRunId: BOT_RUN_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createMockFillRepo(): FillRepository {
  return {
    save: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    findByOrderId: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    findRecent: vi.fn().mockReturnValue([]),
    findUnreconciled: vi.fn().mockReturnValue([]),
    markReconciled: vi.fn(),
    getLatestTimestamp: vi.fn().mockReturnValue(null),
  };
}

/** Returns a mock controlDb that reports the given wallet balance. */
function createMockControlDb(walletBalance: number | null) {
  return {
    prepare: vi.fn().mockReturnValue({
      get: vi
        .fn()
        .mockReturnValue(
          walletBalance != null ? { wallet_balance_usdc: walletBalance } : undefined,
        ),
    }),
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ExecutionModule — wallet reservation rejection", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let bus: InProcessEventBus;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let fillRepo: ReturnType<typeof createMockFillRepo>;

  beforeEach(() => {
    gateway = createMockGateway();
    bus = new InProcessEventBus();
    marketRepo = createMockMarketRepo();
    orderRepo = createMockOrderRepo();
    fillRepo = createMockFillRepo();
  });

  // Helper: collect OrderRejected events published on the bus.
  function collectRejections(b: InProcessEventBus): Array<{ reason: string; errorCode: string }> {
    const rejected: Array<{ reason: string; errorCode: string }> = [];
    b.subscribe("OrderRejected", async (p) => {
      rejected.push({ reason: p.reason, errorCode: p.errorCode as string });
    });
    return rejected;
  }

  // ── Case 1: 3% buffer ($0.30) > floor ($0.25); notional $9.80 → reject ──

  it("rejects BUY when notional exceeds available balance after 3% buffer", async () => {
    // balance=$10, buffer=max(0.25, 0.03×10)=$0.30, available=$9.70, notional=$9.80
    const controlDb = createMockControlDb(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
      executionPolicy: () => buyCapacityPolicy({ enabled: false }),
      // defaults: walletBufferPct=0.03, walletBufferMinUsdc=0.25
    });

    await mod.start();
    const rejected = collectRejections(bus);

    // price=0.98, size=10 → notional=9.80
    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-case1"),
        clientOrderId: "plk_case1" as ClientOrderId,
        price: 0.98,
        size: 10,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    // Rejection reason must reference the wallet/balance/insufficient path
    expect(rejected[0]!.reason).toBe("reserved-usdc-limit");
    expect(rejected[0]!.errorCode).toBe("INSUFFICIENT_BALANCE");

    await mod.stop();
  });

  // ── Case 2: same balance, notional $9.00 → allowed ──

  it("allows BUY when notional fits within balance minus 3% buffer", async () => {
    // balance=$10, buffer=$0.30, available=$9.70, notional=$9.00 → ok
    const controlDb = createMockControlDb(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
      executionPolicy: () => buyCapacityPolicy({ enabled: false }),
    });

    await mod.start();
    const rejected = collectRejections(bus);

    // price=0.90, size=10 → notional=9.00
    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-case2"),
        clientOrderId: "plk_case2" as ClientOrderId,
        price: 0.9,
        size: 10,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveLength(0);

    await mod.stop();
  });

  // ── Case 3: floor path — 3%×$5=$0.15 < floor $0.25; notional $4.80 → reject ──

  it("rejects BUY when floor buffer kicks in and notional exceeds available balance", async () => {
    // balance=$5, buffer=max(0.25, 0.03×5)=max(0.25, 0.15)=$0.25, available=$4.75, notional=$4.80
    const controlDb = createMockControlDb(5);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
      executionPolicy: () => buyCapacityPolicy({ enabled: false }),
      // defaults: walletBufferPct=0.03, walletBufferMinUsdc=0.25
    });

    await mod.start();
    const rejected = collectRejections(bus);

    // price=0.96, size=5 → notional=4.80
    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-case3"),
        clientOrderId: "plk_case3" as ClientOrderId,
        price: 0.96,
        size: 5,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("reserved-usdc-limit");
    expect(rejected[0]!.errorCode).toBe("INSUFFICIENT_BALANCE");

    await mod.stop();
  });

  // ── Case 4: per-instance override walletBufferPct=0.10; notional $9.30 → reject ──

  it("rejects BUY using overridden 10% buffer when notional exceeds available balance", async () => {
    // balance=$10, buffer=max(0.25, 0.10×10)=max(0.25,1.00)=$1.00, available=$9.00, notional=$9.30
    const controlDb = createMockControlDb(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
      executionPolicy: () => buyCapacityPolicy({ enabled: false }),
      walletBufferPct: 0.1,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    // price=0.93, size=10 → notional=9.30
    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-case4"),
        clientOrderId: "plk_case4" as ClientOrderId,
        price: 0.93,
        size: 10,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("reserved-usdc-limit");
    expect(rejected[0]!.errorCode).toBe("INSUFFICIENT_BALANCE");

    await mod.stop();
  });

  it("rejects new-entry BUY when buy-capacity reserve would be exactly exhausted", async () => {
    // balance - 3% wallet buffer - $2 order = $7.00 required new-entry headroom.
    const controlDb = createMockControlDb(9 / 0.97);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
      executionPolicy: () => buyCapacityPolicy({ maxOpenBuyOrders: 2 }),
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-capacity-new-entry"),
        clientOrderId: "plk_capacity_new_entry" as ClientOrderId,
        signalReason: "probe-entry",
        price: 0.2,
        size: 10,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("wallet_buy_capacity_exhausted");

    await mod.stop();
  });

  it("rejects add-buy when buy-capacity add reserve would be below threshold", async () => {
    const controlDb = createMockControlDb(6.5);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
      executionPolicy: () => buyCapacityPolicy(),
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-capacity-add"),
        clientOrderId: "plk_capacity_add" as ClientOrderId,
        signalReason: "scale-in",
        price: 0.2,
        size: 10,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("wallet_buy_capacity_exhausted");

    await mod.stop();
  });

  it("enforces maxOpenBuyOrders before placing another BUY", async () => {
    const controlDb = createMockControlDb(100);
    const openBuy = makeBuyCmd({
      commandId: createCommandId("existing-1"),
      tokenId: createTokenId("existing-buy-token-1"),
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([
      {
        ...openBuy,
        orderId: "ord-existing-1",
        orderType: "GTC",
        postOnly: true,
        status: "open",
        sizeUsdc: 1,
        exchangeOrderId: null,
        signalId: null,
        signalReason: "probe-entry",
        botRunId: BOT_RUN_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        ...openBuy,
        orderId: "ord-existing-2",
        clientOrderId: "plk_existing_2",
        tokenId: createTokenId("existing-buy-token-2"),
        orderType: "GTC",
        postOnly: true,
        status: "open",
        sizeUsdc: 1,
        exchangeOrderId: null,
        signalId: null,
        signalReason: "probe-entry",
        botRunId: BOT_RUN_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
      executionPolicy: () => buyCapacityPolicy({ maxOpenBuyOrders: 2 }),
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-capacity-count"),
        clientOrderId: "plk_capacity_count" as ClientOrderId,
        signalReason: "probe-entry",
        tokenId: createTokenId("new-buy-token"),
        price: 0.2,
        size: 10,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("wallet_buy_capacity_exhausted");

    await mod.stop();
  });

  it("enforces maxOpenSellOrders before placing another SELL", async () => {
    orderRepo.findOpen = vi.fn().mockReturnValue(
      Array.from({ length: 10 }, (_, index) =>
        openOrderFromCommand(
          makeSellCmd({
            commandId: createCommandId(`existing-sell-${index}`),
            clientOrderId: `plk_existing_sell_${index}` as ClientOrderId,
            tokenId: createTokenId(`sell-token-${index}`),
          }),
          `ord-existing-sell-${index}`,
        ),
      ),
    );
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () => executionPolicy(),
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd({
        commandId: createCommandId("cmd-sell-capacity-count"),
        clientOrderId: "plk_sell_capacity_count" as ClientOrderId,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("wallet_sell_capacity_exhausted");

    await mod.stop();
  });

  it("enforces maxOpenOrdersTotal before placing BUY or SELL", async () => {
    orderRepo.findOpen = vi.fn().mockReturnValue([
      ...Array.from({ length: 12 }, (_, index) =>
        openOrderFromCommand(
          makeBuyCmd({
            commandId: createCommandId(`existing-buy-total-${index}`),
            clientOrderId: `plk_existing_buy_total_${index}` as ClientOrderId,
            tokenId: createTokenId(`buy-total-token-${index}`),
          }),
          `ord-existing-buy-total-${index}`,
        ),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        openOrderFromCommand(
          makeSellCmd({
            commandId: createCommandId(`existing-sell-total-${index}`),
            clientOrderId: `plk_existing_sell_total_${index}` as ClientOrderId,
            tokenId: createTokenId(`sell-total-token-${index}`),
          }),
          `ord-existing-sell-total-${index}`,
        ),
      ),
    ]);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb: createMockControlDb(100),
      activeProfile: "paper" as any,
      executionPolicy: () =>
        executionPolicy({
          sellCapacity: { ...DEFAULT_EXECUTION_POLICY.sellCapacity, maxOpenSellOrders: 11 },
        }),
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-total-buy"),
        clientOrderId: "plk_total_buy" as ClientOrderId,
        tokenId: createTokenId("new-total-buy"),
      }),
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd({
        commandId: createCommandId("cmd-total-sell"),
        clientOrderId: "plk_total_sell" as ClientOrderId,
        tokenId: createTokenId("new-total-sell"),
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(2);
    expect(rejected.map((item) => item.reason)).toEqual([
      "total_orders_capacity_exhausted",
      "total_orders_capacity_exhausted",
    ]);

    await mod.stop();
  });

  it("enforces per-token BUY and SELL caps from current open orders after restart", async () => {
    const tokenId = createTokenId("restart-token");
    orderRepo.findOpen = vi.fn().mockReturnValue([
      openOrderFromCommand(makeBuyCmd({ tokenId }), "ord-restart-buy-1"),
      openOrderFromCommand(
        makeBuyCmd({
          commandId: createCommandId("restart-buy-2"),
          clientOrderId: "plk_restart_buy_2" as ClientOrderId,
          tokenId,
        }),
        "ord-restart-buy-2",
      ),
      openOrderFromCommand(makeSellCmd({ tokenId }), "ord-restart-sell-1"),
      openOrderFromCommand(
        makeSellCmd({
          commandId: createCommandId("restart-sell-2"),
          clientOrderId: "plk_restart_sell_2" as ClientOrderId,
          tokenId,
        }),
        "ord-restart-sell-2",
      ),
    ]);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb: createMockControlDb(100),
      activeProfile: "paper" as any,
      executionPolicy: () => executionPolicy(),
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-restart-buy"),
        clientOrderId: "plk_restart_buy" as ClientOrderId,
        tokenId,
        signalReason: "scale-in",
      }),
      timestamp: Date.now(),
    });
    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd({
        commandId: createCommandId("cmd-restart-sell"),
        clientOrderId: "plk_restart_sell" as ClientOrderId,
        tokenId,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected.map((item) => item.reason)).toEqual([
      "per_token_buy_limit",
      "per_token_sell_limit",
    ]);

    await mod.stop();
  });

  it("restores flat wallet-buffer behavior when buy capacity is disabled", async () => {
    const controlDb = createMockControlDb(9);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      controlDb,
      activeProfile: "paper" as any,
      executionPolicy: () => buyCapacityPolicy({ enabled: false }),
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-capacity-disabled"),
        clientOrderId: "plk_capacity_disabled" as ClientOrderId,
        signalReason: "probe-entry",
        price: 0.2,
        size: 10,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveLength(0);

    await mod.stop();
  });
});
