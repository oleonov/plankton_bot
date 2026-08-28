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
  createPositionId,
  createLotId,
  createFillId,
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
  Position,
  PositionRepository,
  InventoryLotRepository,
  MakerCaptureRepriceIntent,
  Order,
  TokenId,
  ClientOrderId,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import { buildMakerCaptureRepriceIdentity } from "../maker-capture-reprice.js";
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
    redeemPositions: vi.fn().mockResolvedValue({
      status: "skipped" as const,
      conditionIds: [],
      txHash: null,
      gasUsed: null,
    }),
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

function activeCapturePolicy(now: number): ExecutionPolicy {
  return executionPolicy({
    buyCapacity: { ...DEFAULT_BUY_CAPACITY_POLICY, maxOpenBuyOrders: 100 },
    orderCapacity: { ...DEFAULT_EXECUTION_POLICY.orderCapacity, maxOpenOrdersTotal: 24 },
    makerEntry: {
      ...DEFAULT_EXECUTION_POLICY.makerEntry,
      mode: "micro_live",
      microLiveWindow: {
        activatedAtUtc: new Date(now - 60_000).toISOString(),
        expiresAtUtc: new Date(now + 60_000).toISOString(),
        maxCumulativeAcceptedPendingUsdc: 44,
        maxCumulativeAcceptedPendingUsdcPerCondition: 1,
        maxDistinctAcceptedConditions: 44,
        maxCumulativeFilledUsdc: 5,
        captureNextR23: true,
      },
    },
  });
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
    claimForReconciliation: vi.fn().mockReturnValue(true),
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

/**
 * Position + a single FIFO lot spanning it, consistent with makeBuyCmd's
 * default price (0.5) — satisfies the exit-loss-floor gate's FIFO-sufficiency
 * and cost-consistency checks for SELLs on `tokenId`.
 */
function createMockPositionWithLots(
  tokenId: TokenId,
  size: number,
): { positionRepo: PositionRepository; inventoryLotRepo: InventoryLotRepository } {
  const position: Position = {
    positionId: createPositionId("pos-wallet-1"),
    tokenId,
    conditionId: createConditionId("cond-wallet-1"),
    side: "buy",
    size,
    avgEntryPrice: 0.5,
    costBasisUsdc: size * 0.5,
    currentValueUsdc: size * 0.5,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    updatedAt: new Date().toISOString(),
  };
  const positionRepo = {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findActiveByTokenId: vi.fn(() => []),
    findByTokenId: vi.fn().mockReturnValue(position),
    findByConditionId: vi.fn().mockReturnValue([]),
    findAllOpen: vi.fn().mockReturnValue([position]),
    updateSize: vi.fn(),
    close: vi.fn(),
  } as unknown as PositionRepository;
  const lot = {
    lotId: createLotId("lot-wallet-1"),
    positionId: position.positionId,
    tokenId,
    side: "buy" as const,
    size,
    remainingSize: size,
    entryPrice: 0.5,
    costUsdc: size * 0.5,
    fillId: createFillId("fill-wallet-1"),
    createdAt: position.openedAt,
  };
  const inventoryLotRepo: InventoryLotRepository = {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([lot]),
    findOpen: vi.fn().mockReturnValue([lot]),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
  return { positionRepo, inventoryLotRepo };
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

  function collectSkipped(b: InProcessEventBus): Array<{ reasonCode: string }> {
    const skipped: Array<{ reasonCode: string }> = [];
    b.subscribe("OrderSkipped", async (p) => {
      skipped.push({ reasonCode: p.reasonCode });
    });
    return skipped;
  }

  function collectCancels(b: InProcessEventBus): Array<{ orderId: string; reason: string }> {
    const cancels: Array<{ orderId: string; reason: string }> = [];
    b.subscribe("CancelOrderRequested", async (p) => {
      cancels.push({ orderId: String(p.command.orderId), reason: p.command.reason });
    });
    return cancels;
  }

  it("keeps wallet/global/token/total capacity occupied during a permanent R23 cancel gap", () => {
    const now = Date.now();
    const activatedAtUtc = new Date(now - 60_000).toISOString();
    const rootId = "permanent-gap-root" as Order["orderId"];
    const root = openOrderFromCommand(
      makeBuyCmd({
        commandId: createCommandId("permanent-gap-root"),
        clientOrderId: "permanent-gap-root" as ClientOrderId,
        tokenId: createTokenId("permanent-gap-token"),
        conditionId: createConditionId("permanent-gap-condition"),
        decisionRuleId: "R23_DIP_TRIGGER",
        signalReason: "probe-entry",
        signalTimestamp: new Date(now - 10_000).toISOString(),
        entryStyle: "maker",
        postOnly: true,
        price: 0.3,
        size: 3,
      }),
      rootId,
    ) as unknown as Order;
    root.status = "cancelled";
    root.cancelReason = "maker_capture_reprice";
    root.sizeUsdc = 0.9;
    root.metadata = {
      makerMicroLiveLifecycle: {
        kind: "permanent_r23",
        activationId: "activation-capacity-red",
        activatedAtUtc,
        fillWaitMs: 120_000,
      },
      makerCaptureLineageV1: {
        version: 1,
        rootOrderId: root.orderId,
        predecessorOrderId: null,
        replacementIndex: 0,
        rootNotionalUsdc: 0.9,
      },
      quoteMotionV1: {
        version: 1,
        kind: "r23_capture",
        cohortId: activatedAtUtc,
        originalSuggestedPrice: 0.4,
        originalTargetPrice: null,
        entryPriceCeiling: 0.45,
        policySchemaVersion: DEFAULT_EXECUTION_POLICY.version,
        policyControlRevision: 7,
        permanentR23ActivationId: "activation-capacity-red",
        permanentR23ActivatedAtUtc: activatedAtUtc,
        initialBook: {
          depthStatus: "full",
          bestBid: 0.29,
          bestAsk: 0.35,
          tickSize: 0.01,
          snapshotTs: now - 10_000,
          source: "test",
        },
      },
    };
    const identity = buildMakerCaptureRepriceIdentity(root.orderId, root.orderId, 1);
    const intent: MakerCaptureRepriceIntent = {
      ...identity,
      predecessorOrderId: root.orderId,
      rootOrderId: root.orderId,
      tokenId: root.tokenId,
      conditionId: root.conditionId,
      replacementIndex: 1,
      status: "cancel_pending",
      candidatePrice: null,
      replacementSize: null,
      childOrderId: null,
      createdAt: new Date(now - 1_000).toISOString(),
      updatedAt: new Date(now - 1_000).toISOString(),
      failure: null,
      proof: {
        version: 1,
        trigger: {
          eventTimestampMs: now - 1_000,
          evaluatedAtMs: now - 1_000,
          bestBid: 0.31,
          bestAsk: 0.35,
          tickSize: 0.01,
          bookSource: "clob",
          policySchemaVersion: DEFAULT_EXECUTION_POLICY.version,
          policyControlRevision: 7,
          activatedAtUtc,
          expiresAtUtc: new Date(now + 110_000).toISOString(),
          originalSuggestedPrice: 0.4,
          entryPriceCeiling: 0.45,
          rootNotionalUsdc: 0.9,
          chainFilledUsdc: 0.2,
          predecessorRemainingShares: 2.3,
        },
        prepared: null,
        submit: null,
      },
    };
    orderRepo.findOpen = vi.fn(() => []);
    orderRepo.findByTokenId = vi.fn(() => [root]);
    orderRepo.findById = vi.fn(() => root);
    orderRepo.findRecoverableMakerCaptureRepriceIntents = vi.fn(() => [intent]);
    orderRepo.findMakerCaptureRepriceIntentBySignal = vi.fn(() => intent);
    orderRepo.getMakerCaptureChainUsage = vi.fn(() => ({
      trusted: true,
      rootOrderId: root.orderId,
      rootNotionalUsdc: 0.9,
      chainFilledUsdc: 0.2,
      predecessorRemainingShares: 2.3,
      replacementIndex: 0,
      orderIds: [root.orderId],
    }));
    const policy = executionPolicy({
      makerEntry: {
        ...DEFAULT_EXECUTION_POLICY.makerEntry,
        mode: "micro_live",
        permanentR23ActivationId: "activation-capacity-red",
        permanentR23ActivatedAtUtc: activatedAtUtc,
        captureBookReprice: { enabled: true, maxRepricesPerRoot: 5 },
      },
    });
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      executionPolicy: () => policy,
      executionPolicySnapshot: () => ({ policy, controlRevision: 7 }),
    });

    const snapshot = (mod as any).getReservationSnapshot(
      makeBuyCmd({ tokenId: createTokenId("competitor-token") }),
    );
    expect(snapshot).toMatchObject({
      openBuyOrderCount: 1,
      openGateBuyOrderCount: 0,
      openOrdersTotal: 1,
    });
    expect(snapshot.reservedBuyUsdc).toBeCloseTo(0.7);
    expect(snapshot.openBuyOrdersByToken.get(String(root.tokenId))).toBe(1);
    expect(
      (mod as any).permanentR23UnpersistedNotional(
        makeBuyCmd({ tokenId: createTokenId("competitor-token") }),
      ),
    ).toBeCloseTo(0.7);
  });

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
    await bus.drain();

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
    await bus.drain();

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
    await bus.drain();

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
    await bus.drain();

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

  it("keeps one physical BUY slot reserved across an in-flight ordinary admission", async () => {
    const now = Date.now();
    let finishFirst!: () => void;
    vi.mocked(gateway.placeOrder).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = () => resolve({ success: true, orderId: "reserved-slot-first" });
        }),
    );
    orderRepo.findOpen = vi.fn().mockReturnValue(
      Array.from({ length: 22 }, (_, index) =>
        openOrderFromCommand(
          makeBuyCmd({
            commandId: createCommandId(`reserved-slot-existing-${index}`),
            clientOrderId: `plk_reserved_slot_${index}` as ClientOrderId,
            tokenId: createTokenId(`reserved-slot-token-${index}`),
          }),
          `reserved-slot-order-${index}`,
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
      controlDb: createMockControlDb(1_000),
      activeProfile: "paper" as any,
      executionPolicy: () => activeCapturePolicy(now),
      maxConcurrency: 1,
    });
    const rejected = collectRejections(bus);
    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("reserved-slot-first"),
        clientOrderId: "plk_reserved_slot_first" as ClientOrderId,
        tokenId: createTokenId("reserved-slot-first-token"),
      }),
      timestamp: now,
    });
    await vi.waitFor(() => expect(gateway.placeOrder).toHaveBeenCalledTimes(1));
    expect(mod.getDiagnostics().buyCapacity).toMatchObject({
      openBuyOrderCount: 23,
      maxOpenBuyOrders: 100,
      protectedOpenBuySlots: 1,
      effectiveMaxOpenBuyOrders: 99,
      entriesBlocked: false,
    });
    expect(mod.getDiagnostics().orderCapacity).toMatchObject({
      protectedOpenOrderSlots: 1,
      effectiveMaxOpenOrdersTotal: 23,
      blocked: true,
    });

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("reserved-slot-second"),
        clientOrderId: "plk_reserved_slot_second" as ClientOrderId,
        tokenId: createTokenId("reserved-slot-second-token"),
      }),
      timestamp: now,
    });
    expect(rejected.map((item) => item.reason)).toEqual(["total_orders_capacity_exhausted"]);
    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

    finishFirst();
    await mod.stop();
  });

  it("dedupes same-token near-price BUY before exchange placement", async () => {
    const controlDb = createMockControlDb(100);
    const existing = makeBuyCmd({
      commandId: createCommandId("existing-duplicate-buy"),
      clientOrderId: "plk_existing_duplicate_buy" as ClientOrderId,
      tokenId: createTokenId("dup-buy-token"),
      signalReason: "probe-entry",
      decisionRuleId: "R23_DIP_TRIGGER",
      price: 0.5,
      tickSize: 0.01,
      metadata: { source: "strategy" },
    });
    orderRepo.findOpen = vi
      .fn()
      .mockReturnValue([openOrderFromCommand(existing, "ord-existing-duplicate-buy")]);
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
      executionPolicy: () => buyCapacityPolicy({ maxOpenBuyOrdersPerToken: 2 }),
    });

    await mod.start();
    const skipped = collectSkipped(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-duplicate-buy"),
        clientOrderId: "plk_duplicate_buy" as ClientOrderId,
        tokenId: createTokenId("dup-buy-token"),
        signalReason: "probe-entry",
        decisionRuleId: "R23_DIP_TRIGGER",
        price: 0.51,
        tickSize: 0.01,
        metadata: { source: "strategy" },
      }),
      timestamp: Date.now(),
    });
    await bus.drain();

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(skipped).toEqual([{ reasonCode: "buy_duplicate_deduped" }]);

    await mod.stop();
  });

  it("allows same-token BUY at materially different price under the per-token cap", async () => {
    const controlDb = createMockControlDb(100);
    const existing = makeBuyCmd({
      commandId: createCommandId("existing-different-price-buy"),
      clientOrderId: "plk_existing_different_price_buy" as ClientOrderId,
      tokenId: createTokenId("different-price-token"),
      signalReason: "scale-in",
      decisionRuleId: "D3",
      price: 0.5,
      tickSize: 0.01,
    });
    orderRepo.findOpen = vi
      .fn()
      .mockReturnValue([openOrderFromCommand(existing, "ord-existing-different-price-buy")]);
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
      executionPolicy: () => buyCapacityPolicy({ maxOpenBuyOrdersPerToken: 2 }),
    });

    await mod.start();
    const skipped = collectSkipped(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-different-price-buy"),
        clientOrderId: "plk_different_price_buy" as ClientOrderId,
        tokenId: createTokenId("different-price-token"),
        signalReason: "scale-in",
        decisionRuleId: "D3",
        price: 0.53,
        tickSize: 0.01,
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);
    expect(skipped).toHaveLength(0);

    await mod.stop();
  });

  it("clears one stale BUY blocker when global BUY cap is full without placing immediately", async () => {
    const controlDb = createMockControlDb(100);
    const stale = makeBuyCmd({
      commandId: createCommandId("existing-stale-buy"),
      clientOrderId: "plk_existing_stale_buy" as ClientOrderId,
      tokenId: createTokenId("stale-buy-token"),
      signalReason: "confirm-scale",
    });
    const fresh = makeBuyCmd({
      commandId: createCommandId("existing-fresh-buy"),
      clientOrderId: "plk_existing_fresh_buy" as ClientOrderId,
      tokenId: createTokenId("fresh-buy-token"),
      signalReason: "probe-entry",
    });
    orderRepo.findOpen = vi.fn().mockReturnValue([
      {
        ...openOrderFromCommand(stale, "ord-existing-stale-buy"),
        createdAt: new Date(Date.now() - 3 * 60 * 60_000 - 60_000).toISOString(),
      },
      openOrderFromCommand(fresh, "ord-existing-fresh-buy"),
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
    const skipped = collectSkipped(bus);
    const cancels = collectCancels(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-cap-full-stale-clear"),
        clientOrderId: "plk_cap_full_stale_clear" as ClientOrderId,
        tokenId: createTokenId("new-buy-after-stale"),
        signalReason: "probe-entry",
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(cancels).toEqual([{ orderId: "ord-existing-stale-buy", reason: "stale_entry_ttl" }]);
    expect(skipped).toEqual([{ reasonCode: "buy_cap_full_targeted_replacement" }]);

    await mod.stop();
  });

  it("keeps blocking when global BUY cap is full and no targeted replacement exists", async () => {
    const controlDb = createMockControlDb(100);
    orderRepo.findOpen = vi.fn().mockReturnValue([
      openOrderFromCommand(
        makeBuyCmd({
          commandId: createCommandId("fresh-cap-buy-1"),
          clientOrderId: "plk_fresh_cap_buy_1" as ClientOrderId,
          tokenId: createTokenId("fresh-cap-token-1"),
          signalReason: "probe-entry",
        }),
        "ord-fresh-cap-buy-1",
      ),
      openOrderFromCommand(
        makeBuyCmd({
          commandId: createCommandId("fresh-cap-buy-2"),
          clientOrderId: "plk_fresh_cap_buy_2" as ClientOrderId,
          tokenId: createTokenId("fresh-cap-token-2"),
          signalReason: "probe-entry",
        }),
        "ord-fresh-cap-buy-2",
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
      controlDb,
      activeProfile: "paper" as any,
      executionPolicy: () => buyCapacityPolicy({ maxOpenBuyOrders: 2 }),
    });

    await mod.start();
    const rejected = collectRejections(bus);
    const cancels = collectCancels(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeBuyCmd({
        commandId: createCommandId("cmd-cap-full-no-target"),
        clientOrderId: "plk_cap_full_no_target" as ClientOrderId,
        tokenId: createTokenId("new-buy-no-target"),
        signalReason: "probe-entry",
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(cancels).toHaveLength(0);
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

  it("uses source-aware capacity for direct profile_ladder PlaceOrderRequested", async () => {
    orderRepo.findOpen = vi.fn().mockReturnValue(
      Array.from({ length: 150 }, (_, index) =>
        openOrderFromCommand(
          makeSellCmd({
            commandId: createCommandId(`existing-profile-ladder-${index}`),
            clientOrderId: `plk_existing_profile_ladder_${index}` as ClientOrderId,
            tokenId: createTokenId(`profile-ladder-token-${index}`),
            decisionRuleId: "PROFILE_LADDER",
            metadata: { source: "profile_ladder" },
          }),
          `ord-existing-profile-ladder-${index}`,
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
      executionPolicy: () =>
        executionPolicy({
          sellCapacity: {
            ...DEFAULT_EXECUTION_POLICY.sellCapacity,
            mode: "source_aware_dynamic",
            profileLadderLiveRungsPerPosition: 2,
            minNonLadderReserve: 10,
            nonLadderReserveRatio: 0.25,
            hardMaxOpenSellOrders: 200,
          },
        }),
      profileOwnedOpenPositionCount: () => 100,
    });

    await mod.start();
    const rejected = collectRejections(bus);

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd({
        commandId: createCommandId("cmd-profile-ladder-dynamic-cap"),
        clientOrderId: "plk_profile_ladder_dynamic_cap" as ClientOrderId,
        decisionRuleId: "PROFILE_LADDER",
        metadata: { source: "profile_ladder" },
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).not.toHaveBeenCalled();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBe("wallet_sell_capacity_exhausted");

    await mod.stop();
  });

  it("allows direct D8 PlaceOrderRequested when profile_ladder is at cap and reserve remains", async () => {
    orderRepo.findOpen = vi.fn().mockReturnValue(
      Array.from({ length: 150 }, (_, index) =>
        openOrderFromCommand(
          makeSellCmd({
            commandId: createCommandId(`existing-profile-ladder-reserve-${index}`),
            clientOrderId: `plk_existing_profile_ladder_reserve_${index}` as ClientOrderId,
            tokenId: createTokenId(`profile-ladder-reserve-token-${index}`),
            decisionRuleId: "PROFILE_LADDER",
            metadata: { source: "profile_ladder" },
          }),
          `ord-existing-profile-ladder-reserve-${index}`,
        ),
      ),
    );
    // The D8 SELL below is on tokenId "tok-yes" (makeSellCmd's default), distinct
    // from the 150 profile-ladder orders above — so reservedSell for it is 0 and
    // position.size=100 alone gates availableSize, well clear of the cmd.size=10.
    const { positionRepo, inventoryLotRepo } = createMockPositionWithLots(
      createTokenId("tok-yes"),
      100,
    );
    const mod = new ExecutionModule({
      gateway,
      bus,
      marketRepo: marketRepo as any,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      log: silentLog,
      botRunId: BOT_RUN_ID,
      runtimeControl: { isPaused: () => false },
      executionPolicy: () =>
        executionPolicy({
          sellCapacity: {
            ...DEFAULT_EXECUTION_POLICY.sellCapacity,
            mode: "source_aware_dynamic",
            profileLadderLiveRungsPerPosition: 2,
            minNonLadderReserve: 10,
            nonLadderReserveRatio: 0.25,
            hardMaxOpenSellOrders: 200,
          },
          orderCapacity: {
            ...DEFAULT_EXECUTION_POLICY.orderCapacity,
            maxOpenOrdersTotal: 250,
          },
        }),
      profileOwnedOpenPositionCount: () => 100,
    });

    await mod.start();

    await bus.publish("PlaceOrderRequested", {
      command: makeSellCmd({
        commandId: createCommandId("cmd-d8-dynamic-reserve"),
        clientOrderId: "plk_d8_dynamic_reserve" as ClientOrderId,
        decisionRuleId: "D8_PROFIT_RATIO",
      }),
      timestamp: Date.now(),
    });

    expect(gateway.placeOrder).toHaveBeenCalledTimes(1);

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
