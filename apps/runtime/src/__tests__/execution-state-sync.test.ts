/**
 * Tests for the exchange-state-store integration with ExecutionModule.
 *
 * Covers four scenarios that motivated the PR after the live "balance is
 * not enough" desync episode:
 *
 *  A. Per-token SELL safety block after gateway "balance is not enough"
 *     reject — second SELL is rejected with `pending-wallet-sync` until the
 *     60 s cooldown expires.
 *  B. SELL clamp uses min(localPosition, walletPosition) — when the wallet
 *     reports fewer shares than local state believes, the order is clamped
 *     down (or rejected, if the residual is too small).
 *  C. `reservedSell` honors exchange-side open SELL orders — a phantom
 *     restart leaves an exchange order our local DB doesn't know about and
 *     the new SELL must not over-reserve.
 *  D. Drift metrics — store.computeMetrics yields the expected drift sums.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createCommandId,
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
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
  Order,
  OrderRepository,
  FillRepository,
  PlaceOrderCommand,
  Position,
  PositionRepository,
  TokenId,
  ClientOrderId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import {
  ExchangeStateStore,
  computeSellUpperBound,
  isExchangeBalanceRejection,
} from "../modules/execution/exchange-state-store.js";

const BOT_RUN_ID = createBotRunId("test-state-sync-run");
const TOKEN = createTokenId("tok-state-sync");
const COND = createConditionId("cond-state-sync");

function makeSellCmd(size: number): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId(`cmd-sell-${size}-${Math.random()}`),
    clientOrderId: `plk_sell_${size}_${Math.random()}` as ClientOrderId,
    source: "strategy",
    tokenId: TOKEN,
    conditionId: COND,
    side: "sell",
    size,
    price: 0.5,
    orderType: "GTC",
    tickSize: 0.01,
    negRisk: false,
    sequenceInTick: 0,
    signalReason: null,
  };
}

function createMockGateway(placeResult: PlaceOrderResult = { success: true, orderId: "ord" }) {
  return {
    placeOrder: vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValue(placeResult),
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
    redeemPositions: vi.fn().mockResolvedValue({
      status: "skipped" as const,
      conditionIds: [],
      txHash: null,
      gasUsed: null,
    }),
    mergePositions: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  } satisfies ExchangeGateway;
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
  } as unknown as OrderRepository;
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
  } as unknown as FillRepository;
}

function createMockPositionRepo(positionSize: number): PositionRepository {
  const pos: Position = {
    positionId: createPositionId("pos-state-1"),
    tokenId: TOKEN,
    conditionId: COND,
    side: "buy",
    size: positionSize,
    avgEntryPrice: 0.5,
    costBasisUsdc: positionSize * 0.5,
    currentValueUsdc: positionSize * 0.5,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
  };
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByTokenId: vi.fn().mockReturnValue(pos),
    findByConditionId: vi.fn().mockReturnValue([]),
    findAllOpen: vi.fn().mockReturnValue([pos]),
    findAll: vi.fn().mockReturnValue([pos]),
    updateSize: vi.fn(),
    close: vi.fn(),
  } as unknown as PositionRepository;
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

function collectRejections(b: InProcessEventBus): Array<{ reason: string; errorCode: string }> {
  const rejected: Array<{ reason: string; errorCode: string }> = [];
  b.subscribe("OrderRejected", async (p) => {
    rejected.push({ reason: p.reason, errorCode: p.errorCode as string });
  });
  return rejected;
}

beforeEach(() => {
  silentLog.info.mockClear();
  silentLog.warn.mockClear();
  silentLog.error.mockClear();
  silentLog.debug.mockClear();
});

describe("isExchangeBalanceRejection", () => {
  it("detects polymarket relayer balance/allowance phrasing", () => {
    expect(
      isExchangeBalanceRejection({
        errorMessage: "not enough balance / allowance",
        errorDetails: null,
      }),
    ).toBe(true);
    expect(
      isExchangeBalanceRejection({
        errorMessage: null,
        errorDetails: {
          responseBody: { error: "not enough balance" },
        },
      }),
    ).toBe(true);
    expect(
      isExchangeBalanceRejection({
        errorMessage: "balance and allowance are insufficient",
        errorDetails: null,
      }),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isExchangeBalanceRejection({ errorMessage: "rate limited", errorDetails: null })).toBe(
      false,
    );
    expect(
      isExchangeBalanceRejection({
        errorMessage: null,
        errorDetails: { responseBody: "invalid signature" },
      }),
    ).toBe(false);
  });
});

describe("computeSellUpperBound", () => {
  it("returns local size when no wallet snapshot", () => {
    expect(
      computeSellUpperBound({
        localPositionSize: 10,
        walletPositionSize: null,
        walletCapturedAtMs: null,
        latestFillMs: null,
      }),
    ).toBe(10);
  });

  it("falls back to local size when the wallet snapshot is older than the latest fill", () => {
    // Stale-by-fill: the wallet number is older than the most recent fill, so
    // we trust local but never go unbounded — an Infinity here would silently
    // disable the SELL clamp and admit oversized orders.
    const result = computeSellUpperBound({
      localPositionSize: 10,
      walletPositionSize: 0,
      walletCapturedAtMs: 1000,
      latestFillMs: 2000,
    });
    expect(result).toBe(10);
  });

  it("returns min(local, wallet) when wallet snapshot is fresh", () => {
    expect(
      computeSellUpperBound({
        localPositionSize: 10,
        walletPositionSize: 3,
        walletCapturedAtMs: 5000,
        latestFillMs: 4000,
      }),
    ).toBe(3);
    expect(
      computeSellUpperBound({
        localPositionSize: 2,
        walletPositionSize: 10,
        walletCapturedAtMs: 5000,
        latestFillMs: null,
      }),
    ).toBe(2);
  });
});

describe("ExchangeStateStore — drift metrics", () => {
  it("aggregates absolute drift across tokens", () => {
    const store = new ExchangeStateStore({ now: () => 1_000_000 });
    store.updateExchangeSellOrders(
      [
        { orderId: "ex-a1", tokenId: "tok-a", sizeRemaining: 5 },
        { orderId: "ex-a2", tokenId: "tok-a", sizeRemaining: 3 },
        { orderId: "ex-b1", tokenId: "tok-b", sizeRemaining: 2 },
      ],
      1_000_000,
    );
    store.updateWalletPosition("tok-a", 12, 1_000_000);
    store.updateWalletPosition("tok-b", 4, 1_000_000);

    const metrics = store.computeMetrics({
      localOpenSellSizeByToken: new Map([
        ["tok-a", 6],
        ["tok-c", 4],
      ]),
      localPositionSizeByToken: new Map([
        ["tok-a", 10],
        ["tok-b", 0],
      ]),
    });
    expect(metrics.reservedSellDriftAbs).toBeCloseTo(Math.abs(6 - 8) + Math.abs(0 - 2) + 4, 6);
    expect(metrics.walletPositionDriftAbs).toBeCloseTo(Math.abs(10 - 12) + Math.abs(0 - 4), 6);
    expect(metrics.walletPositionActionableDriftAbs).toBeCloseTo(Math.abs(10 - 12), 6);
    expect(metrics.walletPositionRemoteOnlyRedeemableAbs).toBe(0);
    expect(metrics.latestExchangeOrdersCaptureMs).toBe(1_000_000);
    expect(metrics.latestWalletCaptureMs).toBe(1_000_000);
  });

  it("counts local positions with no wallet snapshot toward walletPositionDriftAbs", () => {
    // Regression: before the symmetric union, a local position without a
    // matching wallet snapshot silently contributed zero drift — masking the
    // very desync this PR was written to detect.
    const store = new ExchangeStateStore({ now: () => 1_000_000 });
    store.updateWalletPosition("tok-a", 5, 1_000_000);

    const metrics = store.computeMetrics({
      localOpenSellSizeByToken: new Map(),
      localPositionSizeByToken: new Map([
        ["tok-a", 5],
        ["tok-no-wallet", 7],
      ]),
    });
    expect(metrics.walletPositionDriftAbs).toBeCloseTo(7, 6);
    expect(metrics.walletPositionActionableDriftAbs).toBeCloseTo(7, 6);
  });

  it("replaces authoritative wallet snapshots and clears disappeared tokens", () => {
    const store = new ExchangeStateStore({ now: () => 1_000_000 });
    store.replaceWalletPositionsBatch(
      [
        { tokenId: "tok-a", size: 5 },
        { tokenId: "tok-stale", size: 4, redeemable: true },
      ],
      1_000_000,
    );

    store.replaceWalletPositionsBatch([{ tokenId: "tok-a", size: 5 }], 1_001_000);

    expect(store.getWalletPositionSize("tok-stale")).toBeNull();
    const metrics = store.computeMetrics({
      localOpenSellSizeByToken: new Map(),
      localPositionSizeByToken: new Map([["tok-a", 5]]),
    });
    expect(metrics.walletPositionDriftAbs).toBe(0);
    expect(metrics.walletPositionActionableDriftAbs).toBe(0);
    expect(metrics.walletPositionRemoteOnlyRedeemableAbs).toBe(0);
  });

  it("keeps absent tokens on partial wallet updates", () => {
    const store = new ExchangeStateStore({ now: () => 1_000_000 });
    store.replaceWalletPositionsBatch(
      [
        { tokenId: "tok-a", size: 5 },
        { tokenId: "tok-b", size: 4, redeemable: true },
      ],
      1_000_000,
    );

    store.updateWalletPositionsBatch([{ tokenId: "tok-a", size: 6 }], 1_001_000);

    expect(store.getWalletPositionSize("tok-b")).toBe(4);
    const metrics = store.computeMetrics({
      localOpenSellSizeByToken: new Map(),
      localPositionSizeByToken: new Map([["tok-a", 6]]),
    });
    expect(metrics.walletPositionDriftAbs).toBe(4);
    expect(metrics.walletPositionActionableDriftAbs).toBe(0);
    expect(metrics.walletPositionRemoteOnlyRedeemableAbs).toBe(4);
  });

  it("classifies local active drift separately from remote-only redeemable drift", () => {
    const store = new ExchangeStateStore({ now: () => 1_000_000 });
    store.replaceWalletPositionsBatch(
      [
        { tokenId: "tok-active", size: 7 },
        { tokenId: "tok-redeemable", size: 11, redeemable: true },
      ],
      1_000_000,
    );

    const metrics = store.computeMetrics({
      localOpenSellSizeByToken: new Map(),
      localPositionSizeByToken: new Map([
        ["tok-active", 10],
        ["tok-local-only", 5],
      ]),
    });

    expect(metrics.walletPositionDriftAbs).toBeCloseTo(3 + 11 + 5, 6);
    expect(metrics.walletPositionActionableDriftAbs).toBeCloseTo(3 + 5, 6);
    expect(metrics.walletPositionRemoteOnlyRedeemableAbs).toBe(11);
  });

  it("expires snapshots after the configured max age", () => {
    let now = 0;
    const store = new ExchangeStateStore({ snapshotMaxAgeMs: 1_000, now: () => now });
    store.updateExchangeSellOrders([{ orderId: "ex-a", tokenId: "tok-a", sizeRemaining: 5 }], 0);
    expect(store.getOpenSellSizeForToken("tok-a")).toBe(5);
    now = 1_500;
    expect(store.getOpenSellSizeForToken("tok-a")).toBeNull();
  });

  it("getWalletPositionCapturedAt mirrors staleness contract of getWalletPositionSize", () => {
    let now = 0;
    const store = new ExchangeStateStore({ snapshotMaxAgeMs: 1_000, now: () => now });
    store.updateWalletPosition("tok-a", 10, 0);
    expect(store.getWalletPositionCapturedAt("tok-a")).toBe(0);
    expect(store.getWalletPositionSize("tok-a")).toBe(10);
    now = 2_000;
    expect(store.getWalletPositionSize("tok-a")).toBeNull();
    expect(store.getWalletPositionCapturedAt("tok-a")).toBeNull();
  });
});

describe("ExecutionModule — exchange state integration", () => {
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

  it("CHANGE A — blocks SELL after exchange balance reject and triggers reconcile", async () => {
    let now = 1_000_000;
    const store = new ExchangeStateStore({ balanceRejectBlockMs: 60_000, now: () => now });
    store.updateWalletPosition(TOKEN, 100, now);

    const trigger = vi.fn();
    gateway.placeOrder = vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValueOnce({
        success: false,
        errorMessage: "not enough balance / allowance",
        errorDetails: { responseBody: { error: "not enough balance" } },
      })
      .mockResolvedValue({ success: true, orderId: "ex-2" });

    const positionRepo = createMockPositionRepo(50);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      exchangeStateStore: store,
      sellBalanceRejectBlockEnabled: true,
      reconciliationTrigger: trigger,
    });
    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", { command: makeSellCmd(5), timestamp: now });
    await bus.drain();

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(store.isBalanceBlocked(TOKEN)).toBe(true);

    // Second SELL within the cooldown is rejected with `pending-wallet-sync`.
    await bus.publish("PlaceOrderRequested", { command: makeSellCmd(5), timestamp: now });
    await bus.drain();
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(rejected.some((r) => r.reason === "pending-wallet-sync")).toBe(true);

    // After the cooldown expires, SELL is admitted again (placeOrder mock
    // now returns success by default — the placement is allowed).
    now += 61_000;
    await bus.publish("PlaceOrderRequested", { command: makeSellCmd(5), timestamp: now });
    await bus.drain();
    expect(gateway.placeOrder).toHaveBeenCalledTimes(2);

    await mod.stop();
  });

  it("CHANGE A — blocked token with an existing open SELL does not cancel the live exit", async () => {
    // Regression: balance-block check must run BEFORE deferSellReplacementIfNeeded.
    // Otherwise a reprice command would cancel the live exit SELL and then the
    // replacement would itself be rejected by the same block, leaving no
    // live exit order on the book.
    const now = 1_000_000;
    const store = new ExchangeStateStore({ balanceRejectBlockMs: 60_000, now: () => now });
    store.markBalanceReject(TOKEN);

    // Existing live exit SELL at price 0.55, different from the incoming
    // reprice at 0.60 — so deferSellReplacementIfNeeded WOULD normally
    // cancel-and-replace.
    const existingExit: Order = {
      orderId: createOrderId("ord-existing-exit"),
      clientOrderId: "client-existing-exit" as Order["clientOrderId"],
      tokenId: TOKEN,
      conditionId: COND,
      side: "sell",
      orderType: "GTC",
      postOnly: true,
      price: 0.55,
      size: 5,
      sizeUsdc: 5 * 0.55,
      status: "open",
      exchangeOrderId: "ex-existing",
      signalId: null,
      signalReason: null,
      botRunId: BOT_RUN_ID,
      createdAt: new Date(now - 30_000).toISOString(),
      updatedAt: new Date(now - 30_000).toISOString(),
    };
    orderRepo.findByTokenId = vi.fn().mockReturnValue([existingExit]);

    const cancelEvents: unknown[] = [];
    bus.subscribe("CancelOrderRequested", async (p) => {
      cancelEvents.push(p);
    });

    const positionRepo = createMockPositionRepo(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      exchangeStateStore: store,
      sellBalanceRejectBlockEnabled: true,
    });
    await mod.start();
    const rejected = collectRejections(bus);

    const repriceCmd: PlaceOrderCommand = { ...makeSellCmd(5), price: 0.6 };
    await bus.publish("PlaceOrderRequested", { command: repriceCmd, timestamp: now });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(cancelEvents).toHaveLength(0);
    expect(rejected.some((r) => r.reason === "pending-wallet-sync")).toBe(true);

    await mod.stop();
  });

  it("CHANGE B — clamps SELL down when wallet position is smaller than local", async () => {
    const now = 1_000_000;
    const store = new ExchangeStateStore({ now: () => now });
    // Wallet says we only have 2 shares; local DB believes 10.
    store.updateWalletPosition(TOKEN, 2, now);

    const positionRepo = createMockPositionRepo(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      exchangeStateStore: store,
    });
    await mod.start();

    await bus.publish("PlaceOrderRequested", { command: makeSellCmd(5), timestamp: now });
    await bus.drain();

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.placeOrder).mock.calls[0]![0].size).toBe(2);

    await mod.stop();
  });

  it("CHANGE B — falls back to local size when the latest fill is fresher than the wallet snapshot", async () => {
    const walletAt = 1_000_000;
    const fillAt = walletAt + 30_000;
    const now = fillAt + 1_000;
    const store = new ExchangeStateStore({ now: () => now });
    store.updateWalletPosition(TOKEN, 0, walletAt);

    fillRepo.findRecentByTokenId = vi.fn().mockReturnValue([
      {
        filledAt: new Date(fillAt).toISOString(),
      },
    ]);

    const positionRepo = createMockPositionRepo(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      exchangeStateStore: store,
    });
    await mod.start();

    await bus.publish("PlaceOrderRequested", { command: makeSellCmd(5), timestamp: now });
    await bus.drain();

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.placeOrder).mock.calls[0]![0].size).toBe(5);

    await mod.stop();
  });

  it("CHANGE C — reservedSell honours exchange-side open SELL orders", async () => {
    const now = 1_000_000;
    const store = new ExchangeStateStore({ now: () => now });
    store.updateExchangeSellOrders(
      [{ orderId: "ex-phantom", tokenId: TOKEN, sizeRemaining: 8 }], // exchange already has an 8-share SELL we lost track of
      now,
    );
    store.updateWalletPosition(TOKEN, 10, now);

    const positionRepo = createMockPositionRepo(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      exchangeStateStore: store,
      sellExchangeReservedEnabled: true,
    });
    await mod.start();

    // Intent 5 shares vs available = 10 - 8 = 2 → clamp to 2.
    await bus.publish("PlaceOrderRequested", { command: makeSellCmd(5), timestamp: now });
    await bus.drain();

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.placeOrder).mock.calls[0]![0].size).toBe(2);

    await mod.stop();
  });

  it("CHANGE C — feature flag off falls back to local reservedSell only", async () => {
    const now = 1_000_000;
    const store = new ExchangeStateStore({ now: () => now });
    store.updateExchangeSellOrders(
      [{ orderId: "ex-phantom-2", tokenId: TOKEN, sizeRemaining: 8 }],
      now,
    );
    store.updateWalletPosition(TOKEN, 10, now);

    const positionRepo = createMockPositionRepo(10);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      exchangeStateStore: store,
      sellExchangeReservedEnabled: false,
    });
    await mod.start();

    await bus.publish("PlaceOrderRequested", { command: makeSellCmd(5), timestamp: now });
    await bus.drain();

    // No clamp from exchange-reserved: order proceeds at full size.
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gateway.placeOrder).mock.calls[0]![0].size).toBe(5);

    await mod.stop();
  });

  it("CHANGE A — feature flag off does not block, even on relayer reject", async () => {
    const now = 1_000_000;
    const store = new ExchangeStateStore({ now: () => now });
    store.updateWalletPosition(TOKEN, 100, now);
    gateway.placeOrder = vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValueOnce({
        success: false,
        errorMessage: "not enough balance / allowance",
      })
      .mockResolvedValueOnce({ success: true, orderId: "ord-2" });

    const positionRepo = createMockPositionRepo(50);
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      exchangeStateStore: store,
      sellBalanceRejectBlockEnabled: false,
    });
    await mod.start();

    await bus.publish("PlaceOrderRequested", { command: makeSellCmd(5), timestamp: now });
    await bus.drain();
    await bus.publish("PlaceOrderRequested", { command: makeSellCmd(5), timestamp: now });
    await bus.drain();

    expect(gateway.placeOrder).toHaveBeenCalledTimes(2);
    expect(store.isBalanceBlocked(TOKEN)).toBe(false);

    await mod.stop();
  });
});
