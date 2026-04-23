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
} from "@plankton/domain";
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
  TokenId,
  ClientOrderId,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
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
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
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
});
