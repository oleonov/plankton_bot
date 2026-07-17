import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createFillId,
  createOrderId,
  createPositionId,
  createLotId,
  createConditionId,
  createBotRunId,
  DEFAULT_EXECUTION_POLICY,
  GATE_ENTRY_RULE_ID,
} from "@krabs/domain";
import { LiveLiteGuard } from "../live-lite-guard.js";
import type {
  PositionRepository,
  InventoryLotRepository,
  OrderRepository,
  Position,
  InventoryLot,
  Order,
  Signal,
  ClientOrderId,
  NormalizedMarket,
  Fill,
} from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  bootstrapDatabase,
  SqliteInventoryLotRepository,
  SqlitePositionRepository,
  type DbConnection,
} from "@krabs/db";
import {
  RiskInventoryModule,
  W4_STALENESS_FALLBACK_MS,
} from "../modules/risk-inventory/risk-inventory-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

const TOK_ID = createTokenId("tok-yes");
const COND_ID = createConditionId("cond-btc");
const MTM_NOW_MS = Date.parse("2026-05-14T12:00:00.000Z");
const FRESH_MTM_UPDATED_AT = new Date(MTM_NOW_MS - 30_000).toISOString();
const STALE_MTM_UPDATED_AT = new Date(MTM_NOW_MS - W4_STALENESS_FALLBACK_MS - 1).toISOString();
const LIVE_LITE_CAP = 250;

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    signalId: "sig-1",
    tokenId: TOK_ID,
    conditionId: COND_ID,
    side: "buy",
    suggestedPrice: 0.5,
    suggestedSize: 10,
    suggestedSizeUsdc: 5,
    reason: "probe-entry",
    strategyTick: Date.now(),
    sequenceInTick: 0,
    decisionRuleId: null,
    sizingRuleId: null,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  return {
    tokenId: TOK_ID,
    conditionId: String(COND_ID),
    slug: "test",
    eventSlug: null,
    question: "test?",
    outcome: "YES",
    regime: "threshold" as any,
    horizon: "daily",
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    gammaCreatedAt: null,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.49,
    bestAsk: 0.51,
    midPrice: 0.5,
    spread: 0.02,
    snapshotTs: Date.now(),
    eventMarketCount: 1,
    ...overrides,
  } as NormalizedMarket;
}

function makeMtmPosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("pos-mtm"),
    tokenId: TOK_ID,
    conditionId: COND_ID,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.05,
    costBasisUsdc: 5,
    currentValueUsdc: 5,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: "2026-05-14T11:00:00.000Z",
    closedAt: null,
    updatedAt: STALE_MTM_UPDATED_AT,
    ...overrides,
  };
}

function makeActivePositions(
  count: number,
  includeTokenId?: ReturnType<typeof createTokenId>,
): Position[] {
  return Array.from({ length: count }, (_, index) =>
    makeMtmPosition({
      positionId: createPositionId(`pos-active-${index}`),
      tokenId:
        includeTokenId && index === 0 ? includeTokenId : createTokenId(`tok-active-${index}`),
      conditionId: createConditionId(`cond-active-${index}`),
      status: "open",
    }),
  );
}

function createMockPositionRepo(position?: Position | Position[] | null): PositionRepository {
  const positions = Array.isArray(position) ? position : position ? [position] : [];
  return {
    save: vi.fn(),
    findByTokenId: vi
      .fn()
      .mockImplementation(
        (tokenId: ReturnType<typeof createTokenId>) =>
          positions.find((entry) => String(entry.tokenId) === String(tokenId)) ?? null,
      ),
    findOpen: vi.fn().mockReturnValue(positions.filter((entry) => entry.status === "open")),
    findDust: vi.fn().mockReturnValue(positions.filter((entry) => entry.status === "dust")),
    findAll: vi.fn().mockReturnValue(positions),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
  };
}

function createMockLotRepo(): InventoryLotRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockReturnValue([]),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
}

function createMockOrderRepo(order?: Order | null): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(order ?? null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

function seedRealSellFillFixture(
  conn: DbConnection,
  overrides?: {
    positionId?: string;
    orderId?: string;
    clientOrderId?: string;
    buyFillId?: string;
    sellFillId?: string;
    runId?: string;
    now?: string;
  },
): {
  positionId: ReturnType<typeof createPositionId>;
  buyFillId: ReturnType<typeof createFillId>;
  sellFillId: ReturnType<typeof createFillId>;
} {
  const now = overrides?.now ?? "2026-04-27T00:00:00.000Z";
  const runId = overrides?.runId ?? "run-real-sell";
  const orderId = overrides?.orderId ?? "ord-real-sell";
  const clientOrderId = overrides?.clientOrderId ?? "coid-real-sell";
  const positionId = createPositionId(overrides?.positionId ?? "pos-real-sell");
  const buyFillId = createFillId(overrides?.buyFillId ?? "fill-buy-real-sell");
  const sellFillId = createFillId(overrides?.sellFillId ?? "fill-sell-real-sell");

  conn.db
    .prepare("INSERT INTO bot_runs (run_id, mode, started_at) VALUES (?, ?, ?)")
    .run(createBotRunId(runId), "test", now);
  conn.db
    .prepare(
      `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type, price,
          size, size_usdc, status, bot_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      orderId,
      clientOrderId,
      TOK_ID,
      COND_ID,
      "buy",
      "GTC",
      0.4,
      10,
      4,
      "filled",
      runId,
      now,
      now,
    );
  conn.db
    .prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
          liquidity_role, fee, fee_rate_bps, filled_at, reconciled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(buyFillId, orderId, TOK_ID, COND_ID, "buy", 0.4, 10, 4, "maker", 0, 0, now, 1);
  conn.db
    .prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
          liquidity_role, fee, fee_rate_bps, filled_at, reconciled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sellFillId, orderId, TOK_ID, COND_ID, "sell", 0.6, 10, 6, "maker", 0, 0, now, 0);

  const positionRepo = new SqlitePositionRepository(conn.db);
  const lotRepo = new SqliteInventoryLotRepository(conn.db);
  positionRepo.save({
    positionId,
    tokenId: TOK_ID,
    conditionId: COND_ID,
    side: "buy",
    size: 10,
    avgEntryPrice: 0.4,
    costBasisUsdc: 4,
    currentValueUsdc: 5,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: now,
    closedAt: null,
    updatedAt: now,
  });
  lotRepo.save({
    lotId: createLotId(`lot-${buyFillId}`),
    positionId,
    tokenId: TOK_ID,
    side: "buy",
    size: 10,
    remainingSize: 10,
    entryPrice: 0.4,
    costUsdc: 4,
    fillId: buyFillId,
    createdAt: now,
  });

  return { positionId, buyFillId, sellFillId };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

function immediateTransaction<T extends (...args: any[]) => any>(fn: T): T & { immediate: T } {
  const tx = ((...args: Parameters<T>) => fn(...args)) as T & { immediate: T };
  tx.immediate = tx;
  return tx;
}

const mockDb = {
  prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
  transaction: vi.fn((fn) => immediateTransaction(fn)),
} as any;

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

// ─── Tests ───────────────────────────────────────────────────────────────

describe("RiskInventoryModule", () => {
  let bus: InProcessEventBus;
  let positionRepo: ReturnType<typeof createMockPositionRepo>;
  let lotRepo: ReturnType<typeof createMockLotRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let fillRepo: {
    markReconciled: ReturnType<typeof vi.fn>;
    findUnreconciled: ReturnType<typeof vi.fn>;
  };
  let mod: RiskInventoryModule;

  function createModule(
    liveLiteGuard?: LiveLiteGuard,
    overrides: Partial<ConstructorParameters<typeof RiskInventoryModule>[0]> = {},
  ) {
    return new RiskInventoryModule({
      bus,
      positionRepo,
      inventoryLotRepo: lotRepo,
      orderRepo,
      fillRepo,
      log: silentLog,
      db: mockDb,
      liveLiteGuard,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new InProcessEventBus();
    positionRepo = createMockPositionRepo();
    lotRepo = createMockLotRepo();
    orderRepo = createMockOrderRepo();
    fillRepo = { markReconciled: vi.fn(), findUnreconciled: vi.fn().mockReturnValue([]) };
    mod = createModule();
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────

  it("healthCheck returns not-ok before start", async () => {
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
  });

  it("healthCheck returns ok after start", async () => {
    await mod.start();
    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
    await mod.stop();
  });

  // ─── Signal approval ───────────────────────────────────────────────

  it("approves valid entry signal for active family", async () => {
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });

    expect(approved).toHaveLength(1);
    expect(approved[0].signal.signalId).toBe("sig-1");

    await mod.stop();
  });

  // Phase 2.A: the market snapshot observed at signal generation must pass
  // through unchanged to SignalApproved / SignalRejected, so the downstream
  // bridge re-evaluates liveness against the same snapshot the pre-entry gate
  // already accepted.
  it("forwards SignalProduced.market unchanged to SignalApproved", async () => {
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    const embedded = makeMarket({ bestBid: 0.42, bestAsk: 0.44, midPrice: 0.43 });
    await bus.publish("SignalProduced", { signal: makeSignal(), market: embedded });

    expect(approved).toHaveLength(1);
    expect(approved[0].market).toBe(embedded);

    await mod.stop();
  });

  it("forwards SignalProduced.market unchanged to SignalRejected", async () => {
    orderRepo = createMockOrderRepo();
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(8);
    mod = createModule(undefined, {
      controlDb: createMockControlDb(10),
      activeProfile: "paper" as any,
    });
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    const embedded = makeMarket({ bestBid: 0.42, bestAsk: 0.44 });
    await bus.publish("SignalProduced", {
      signal: makeSignal({ suggestedSizeUsdc: 2, suggestedSize: 4 }),
      market: embedded,
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].market).toBe(embedded);

    await mod.stop();
  });

  it("suppresses R23 probe-entry before approval when live-lite active market cap is full", async () => {
    positionRepo = createMockPositionRepo(makeActivePositions(LIVE_LITE_CAP));
    const runtimeMetrics = { writeCounter: vi.fn() };
    mod = createModule(
      new LiveLiteGuard({
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 25,
        maxActiveMarkets: LIVE_LITE_CAP,
      }),
      {
        runtimeMetrics: runtimeMetrics as any,
        activeProfile: "live-lite" as any,
      },
    );
    await mod.start();

    const approved: any[] = [];
    const rejected: any[] = [];
    bus.subscribe("SignalApproved", async (payload) => {
      approved.push(payload);
    });
    bus.subscribe("SignalRejected", async (payload) => {
      rejected.push(payload);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({
        decisionRuleId: "R23_DIP_TRIGGER",
        reason: "probe-entry",
      }),
      market: makeMarket(),
    });

    expect(approved).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("live_lite_active_markets_cap_full");
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "probe_entry_active_market_cap_suppressed_total",
      1,
      expect.not.stringContaining("token"),
    );

    await mod.stop();
  });

  it("allows R23 probe-entry when live-lite active market cap has room", async () => {
    positionRepo = createMockPositionRepo(makeActivePositions(LIVE_LITE_CAP - 1));
    mod = createModule(
      new LiveLiteGuard({
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 25,
        maxActiveMarkets: LIVE_LITE_CAP,
      }),
    );
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (payload) => {
      approved.push(payload);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({
        decisionRuleId: "R23_DIP_TRIGGER",
        reason: "probe-entry",
      }),
      market: makeMarket(),
    });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("does not block same-market scale-in when active market cap is full", async () => {
    positionRepo = createMockPositionRepo(makeActivePositions(LIVE_LITE_CAP, TOK_ID));
    mod = createModule(
      new LiveLiteGuard({
        maxOpenValueUsdc: 500,
        maxOrderUsdc: 25,
        maxActiveMarkets: LIVE_LITE_CAP,
      }),
    );
    await mod.start();

    const approved: any[] = [];
    const rejected: any[] = [];
    bus.subscribe("SignalApproved", async (payload) => {
      approved.push(payload);
    });
    bus.subscribe("SignalRejected", async (payload) => {
      rejected.push(payload);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({
        reason: "scale-in",
        decisionRuleId: "EXECUTION_PROFILE_SCALE_IN",
      }),
      market: makeMarket(),
    });

    expect(rejected).toHaveLength(0);
    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  it("does not apply the D3 near-death guard to initial probe-entry BUY signals", () => {
    positionRepo = createMockPositionRepo(makeMtmPosition({ avgEntryPrice: 0.08 }));
    const runtimeMetrics = { writeCounter: vi.fn() };
    const localModule = createModule(undefined, {
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      runtimeMetrics: runtimeMetrics as any,
      effectiveResolution: {
        toBuyPlacementFields: () => ({
          effectiveResolutionAt: new Date(MTM_NOW_MS + 6 * 3_600_000).toISOString(),
          calendarMissing: false,
          appliesToBuy: false,
          minRunwayHours: 24,
        }),
        toBuyRunwayFields: () => ({
          effectiveResolutionAt: new Date(MTM_NOW_MS + 6 * 3_600_000).toISOString(),
          effectiveRunwayHours: 6,
          calendarMissing: false,
          appliesToBuy: false,
          marketClass: "OTHER",
          confidence: "high",
        }),
      },
    });

    const reason = (localModule as any).evaluateD3BuyGuard(
      makeSignal({
        reason: "probe-entry",
        suggestedPrice: 0.03,
        suggestedSize: 10,
        suggestedSizeUsdc: 0.3,
      }),
      makeMarket({ bestAsk: 0.03, midPrice: 0.03 }),
    );

    expect(reason).toBeNull();
    expect(runtimeMetrics.writeCounter).not.toHaveBeenCalled();
  });

  it("blocks post-entry scale-in BUY signals with the D3 near-death guard", () => {
    positionRepo = createMockPositionRepo(makeMtmPosition({ avgEntryPrice: 0.08 }));
    const runtimeMetrics = { writeCounter: vi.fn() };
    const localModule = createModule(undefined, {
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      runtimeMetrics: runtimeMetrics as any,
      effectiveResolution: {
        toBuyPlacementFields: () => ({
          effectiveResolutionAt: new Date(MTM_NOW_MS + 6 * 3_600_000).toISOString(),
          calendarMissing: false,
          appliesToBuy: false,
          minRunwayHours: 24,
        }),
        toBuyRunwayFields: () => ({
          effectiveResolutionAt: new Date(MTM_NOW_MS + 6 * 3_600_000).toISOString(),
          effectiveRunwayHours: 6,
          calendarMissing: false,
          appliesToBuy: false,
          marketClass: "OTHER",
          confidence: "high",
        }),
      },
    });

    const reason = (localModule as any).evaluateD3BuyGuard(
      makeSignal({
        reason: "scale-in",
        suggestedPrice: 0.03,
        suggestedSize: 10,
        suggestedSizeUsdc: 0.3,
      }),
      makeMarket({ bestAsk: 0.03, midPrice: 0.03 }),
    );

    expect(reason).toBe("near_death_add");
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "d3_near_death_scale_in_suppressed_total",
      1,
      expect.stringContaining('"reason":"near_death_add"'),
    );
  });

  it("rejects legacy profile-owned HARVESTING BUY adds above recent last sell", async () => {
    const runtimeMetrics = { writeCounter: vi.fn() };
    mod = createModule(undefined, {
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      runtimeMetrics: runtimeMetrics as any,
      profileStateReader: {
        getState: () =>
          ({
            tokenId: TOK_ID,
            conditionId: COND_ID,
            profile: "medium",
            state: "HARVESTING",
            metadata: {
              lastSellPrice: 0.265,
              lastSellAtMs: MTM_NOW_MS - 4 * 60_000,
            },
          }) as any,
      },
      now: () => MTM_NOW_MS,
    });
    await mod.start();
    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (payload) => {
      rejected.push(payload);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({
        reason: "confirm-scale",
        decisionRuleId: "D3",
        suggestedPrice: 0.309,
        suggestedSize: 10,
        suggestedSizeUsdc: 3.09,
      }),
      market: makeMarket(),
    });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("above_last_sell_suppressed");
    expect(runtimeMetrics.writeCounter).toHaveBeenCalledWith(
      "harvesting_buy_above_last_sell_suppressed_total",
      1,
      expect.not.stringContaining("token"),
    );
  });

  it("does not double-guard EXECUTION_PROFILE_SCALE_IN or block flat probe entries", async () => {
    positionRepo = createMockPositionRepo(makeMtmPosition());
    mod = createModule(undefined, {
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      profileStateReader: {
        getState: () =>
          ({
            tokenId: TOK_ID,
            conditionId: COND_ID,
            profile: "medium",
            state: "HARVESTING",
            metadata: {
              lastSellPrice: 0.265,
              lastSellAtMs: MTM_NOW_MS - 4 * 60_000,
            },
          }) as any,
      },
      now: () => MTM_NOW_MS,
    });

    const evaluate = (mod as any).evaluateHarvestingBuyGuard.bind(mod);

    expect(
      evaluate(
        makeSignal({
          signalId: "sig-scale-in",
          reason: "scale-in",
          decisionRuleId: "EXECUTION_PROFILE_SCALE_IN",
          suggestedPrice: 0.309,
        }),
      ),
    ).toBeNull();
    expect(
      evaluate(
        makeSignal({
          signalId: "sig-probe",
          reason: "probe-entry",
          decisionRuleId: "R23",
          suggestedPrice: 0.309,
        }),
      ),
    ).toBeNull();
  });

  it("emits the configured redeem-in-flight rejection counter for BUY and SELL", async () => {
    const fixedNow = Date.parse("2026-05-11T00:00:00.000Z");
    const runtimeMetrics = { writeEvent: vi.fn(), writeLatest: vi.fn() };
    mod = createModule(undefined, {
      executionPolicy: () => DEFAULT_EXECUTION_POLICY,
      redeemInFlightGuard: () => true,
      runtimeMetrics: runtimeMetrics as never,
      now: () => fixedNow,
    });
    await mod.start();

    await bus.publish("SignalProduced", {
      signal: makeSignal({ side: "buy" }),
      market: makeMarket(),
    });
    await bus.publish("SignalProduced", {
      signal: makeSignal({ signalId: "sig-sell", side: "sell", reason: "repricing-exit" }),
      market: makeMarket(),
    });

    expect(runtimeMetrics.writeEvent).toHaveBeenCalledWith(
      "buy_rejected_due_to_redeem_in_flight_total",
      1,
      JSON.stringify({ side: "buy", condition_id: String(COND_ID) }),
      new Date(fixedNow).toISOString(),
    );
    expect(runtimeMetrics.writeEvent).toHaveBeenCalledWith(
      "buy_rejected_due_to_redeem_in_flight_total",
      1,
      JSON.stringify({ side: "sell", condition_id: String(COND_ID) }),
      new Date(fixedNow).toISOString(),
    );

    await mod.stop();
  });

  it("rejects BUY before SignalApproved when wallet buy budget is exhausted", async () => {
    orderRepo = createMockOrderRepo();
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(8);
    mod = createModule(undefined, {
      controlDb: createMockControlDb(10),
      activeProfile: "paper" as any,
    });
    await mod.start();

    const approved: any[] = [];
    const rejected: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal({ suggestedSizeUsdc: 2, suggestedSize: 4 }),
      market: makeMarket(),
    });

    expect(approved).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("wallet_buy_budget_exhausted");

    await mod.stop();
  });

  it("rate-limits repeated rejection logs by reason", async () => {
    let now = 1_000;
    orderRepo = createMockOrderRepo();
    (orderRepo.sumOpenBuyNotional as ReturnType<typeof vi.fn>).mockReturnValue(8);
    mod = createModule(undefined, {
      controlDb: createMockControlDb(10),
      activeProfile: "paper" as any,
      now: () => now,
      rejectionLogCooldownMs: 60 * 60 * 1000,
    });
    await mod.start();
    silentLog.info.mockClear();

    await bus.publish("SignalProduced", {
      signal: makeSignal({ signalId: "sig-wallet-1", suggestedSizeUsdc: 2, suggestedSize: 4 }),
      market: makeMarket(),
    });
    await bus.publish("SignalProduced", {
      signal: makeSignal({ signalId: "sig-wallet-2", suggestedSizeUsdc: 2, suggestedSize: 4 }),
      market: makeMarket(),
    });

    const isSignalRejectedLog = (call: readonly unknown[]): boolean =>
      call[1] === "signal rejected";
    let rejectionLogs = silentLog.info.mock.calls.filter(isSignalRejectedLog);
    expect(rejectionLogs).toHaveLength(1);

    now += 60 * 60 * 1000 + 1;
    await bus.publish("SignalProduced", {
      signal: makeSignal({ signalId: "sig-wallet-3", suggestedSizeUsdc: 2, suggestedSize: 4 }),
      market: makeMarket(),
    });

    rejectionLogs = silentLog.info.mock.calls.filter(isSignalRejectedLog);
    expect(rejectionLogs).toHaveLength(2);
    expect(rejectionLogs[1]![0]).toMatchObject({ suppressedSinceLast: 1 });

    await mod.stop();
  });

  it("ignores in-flight signals while paused without publishing risk outcomes", async () => {
    let paused = true;
    mod = createModule(undefined, {
      runtimeControl: { isPaused: () => paused },
      now: () => 1_000,
    });
    await mod.start();
    silentLog.info.mockClear();

    const approved: any[] = [];
    const rejected: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });

    expect(approved).toHaveLength(0);
    expect(rejected).toHaveLength(0);
    expect(mod.getDiagnostics()).toMatchObject({ signalsProcessed: 1, signalsRejected: 0 });
    expect(silentLog.info).toHaveBeenCalledWith(
      expect.objectContaining({ signalId: "sig-1" }),
      "signal ignored while runtime is paused",
    );

    paused = false;
    await mod.stop();
  });

  // ─── BUY admission guard (canPlaceBuyOrder + resolution tracker) ──

  function makeStubTracker(
    opts: {
      healthy?: boolean;
      resolved?: ReadonlySet<string>;
    } = {},
  ) {
    return {
      healthy: () => opts.healthy ?? true,
      isResolved: (cid: string) => (opts.resolved ?? new Set<string>()).has(cid),
    };
  }

  async function runBuyAdmission(opts: {
    market?: Partial<NormalizedMarket>;
    signal?: Partial<Signal>;
    tracker?: ReturnType<typeof makeStubTracker>;
    effectiveResolution?: ConstructorParameters<
      typeof RiskInventoryModule
    >[0]["effectiveResolution"];
    executionPolicy?: ConstructorParameters<typeof RiskInventoryModule>[0]["executionPolicy"];
    now?: number;
  }) {
    mod = createModule(undefined, {
      ...(opts.tracker ? { resolutionTracker: opts.tracker as any } : {}),
      ...(opts.effectiveResolution ? { effectiveResolution: opts.effectiveResolution } : {}),
      ...(opts.executionPolicy ? { executionPolicy: opts.executionPolicy } : {}),
      ...(opts.now != null ? { now: () => opts.now! } : {}),
    });
    await mod.start();

    const approved: any[] = [];
    const rejected: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", {
      signal: makeSignal(opts.signal),
      market: makeMarket(opts.market),
    });

    await mod.stop();
    return { approved, rejected };
  }

  it("rejects BUY with reason market_ended when endDate ≤ now", async () => {
    const now = Date.parse("2026-04-25T12:00:00Z");
    const { approved, rejected } = await runBuyAdmission({
      now,
      market: { endDate: "2026-04-25T11:00:00Z" },
    });
    expect(approved).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe("market_ended");
  });

  it("rejects BUY when effective US equity runway is below 24h", async () => {
    const now = Date.parse("2026-06-18T10:00:00.000Z");
    const { approved, rejected } = await runBuyAdmission({
      now,
      market: {
        endDate: "2026-06-19T20:00:00.000Z",
        slug: "will-meta-close-between-560-and-570-week-june-19-2026",
        question: "Will Meta (META) close at $560-$570 on June 19?",
        tags: ["stocks", "price-range"],
      },
      effectiveResolution: {
        toBuyPlacementFields: () => ({
          effectiveResolutionAt: "2026-06-18T20:00:00.000Z",
          calendarMissing: false,
          appliesToBuy: true,
          minRunwayHours: 24,
        }),
      },
    });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("effective_resolution_short_runway");
  });

  it("rejects BUY when effective resolution calendar coverage is missing", async () => {
    const { approved, rejected } = await runBuyAdmission({
      effectiveResolution: {
        toBuyPlacementFields: () => ({
          effectiveResolutionAt: null,
          calendarMissing: true,
          appliesToBuy: true,
          minRunwayHours: 24,
        }),
      },
    });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("effective_resolution_calendar_missing");
  });

  it("rejects BUY with reason market_inactive when active=false", async () => {
    const { approved, rejected } = await runBuyAdmission({ market: { active: false } });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("market_inactive");
  });

  it("rejects BUY with reason market_not_tradable when tradable=false", async () => {
    const { approved, rejected } = await runBuyAdmission({ market: { tradable: false } });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("market_not_tradable");
  });

  it("rejects BUY with reason market_not_alive when bestBid is null", async () => {
    const { approved, rejected } = await runBuyAdmission({ market: { bestBid: null } });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("market_not_alive");
  });

  // docs/plans/2026-07-17-gate-isalive-plankton-whitelist.md — GATE-whitelist liveness
  // override at the RiskInventory layer.
  const gateEnabledPolicy = () => ({
    ...DEFAULT_EXECUTION_POLICY,
    gateEntry: {
      enabled: true,
      mode: "micro_live" as const,
      minLifespanDays: 30,
      minPrice: 0.01,
      maxPrice: 0.15,
      whitelistConditionIds: [String(COND_ID)],
      microMaxOrderUsdc: 2,
    },
  });
  const staleMetadataMarket = { acceptingOrders: false, enableOrderBook: false };

  it("GATE override: ADMITS a GATE_ENTRY BUY on a whitelisted market with stale accepting/enable=false + bestBid", async () => {
    const { approved, rejected } = await runBuyAdmission({
      market: staleMetadataMarket,
      signal: { decisionRuleId: GATE_ENTRY_RULE_ID },
      executionPolicy: gateEnabledPolicy,
    });
    expect(rejected).toHaveLength(0);
    expect(approved).toHaveLength(1);
  });

  it("no override: REJECTS a NON-GATE BUY on the same stale market (market_not_alive)", async () => {
    const { approved, rejected } = await runBuyAdmission({
      market: staleMetadataMarket,
      signal: { decisionRuleId: "R23_DIP_TRIGGER" },
      executionPolicy: gateEnabledPolicy,
    });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("market_not_alive");
  });

  it("no override: REJECTS a GATE_ENTRY BUY on the stale market when bestBid is null (no_bid)", async () => {
    const { approved, rejected } = await runBuyAdmission({
      market: { ...staleMetadataMarket, bestBid: null },
      signal: { decisionRuleId: GATE_ENTRY_RULE_ID },
      executionPolicy: gateEnabledPolicy,
    });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("market_not_alive");
  });

  it("no override: REJECTS a GATE_ENTRY BUY whose conditionId is NOT whitelisted", async () => {
    const { approved, rejected } = await runBuyAdmission({
      market: staleMetadataMarket,
      signal: { decisionRuleId: GATE_ENTRY_RULE_ID },
      executionPolicy: () => ({
        ...gateEnabledPolicy(),
        gateEntry: { ...gateEnabledPolicy().gateEntry, whitelistConditionIds: ["other-cond"] },
      }),
    });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("market_not_alive");
  });

  it("rejects BUY with reason market_resolved when tracker says so", async () => {
    const tracker = makeStubTracker({ resolved: new Set([String(COND_ID)]) });
    const { approved, rejected } = await runBuyAdmission({ tracker });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("market_resolved");
  });

  it("rejects BUY fail-closed with reason resolution_tracker_unavailable when tracker is unhealthy", async () => {
    const tracker = makeStubTracker({ healthy: false });
    const { approved, rejected } = await runBuyAdmission({ tracker });
    expect(approved).toHaveLength(0);
    expect(rejected[0].reason).toBe("resolution_tracker_unavailable");
  });

  it("admits BUY when tracker is healthy and condition not resolved and lifecycle is fine", async () => {
    const tracker = makeStubTracker({ resolved: new Set(["other-condition"]) });
    const { approved, rejected } = await runBuyAdmission({ tracker });
    expect(rejected).toHaveLength(0);
    expect(approved).toHaveLength(1);
  });

  it("does NOT block SELL signals on resolved/ended/inactive markets (BUY-only gate)", async () => {
    const tracker = makeStubTracker({ resolved: new Set([String(COND_ID)]) });
    const { approved, rejected } = await runBuyAdmission({
      tracker,
      signal: { side: "sell" },
      market: { active: false, tradable: false, endDate: "2025-01-01T00:00:00Z" },
    });
    expect(rejected).toHaveLength(0);
    expect(approved).toHaveLength(1);
  });

  // ─── Fill handling: buy ───────────────────────────────────────────

  it("creates new position on buy fill", async () => {
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: "plk_abc" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    // Position was created
    expect(positionRepo.save).toHaveBeenCalledTimes(1);
    expect(posUpdates).toHaveLength(1);
    expect(posUpdates[0].position.size).toBe(10);
    expect(posUpdates[0].position.avgEntryPrice).toBe(0.5);
    expect(posUpdates[0].position.status).toBe("open");

    // Lot was created
    expect(lotRepo.save).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("uses cash notional per net share as entry cost when BUY fees reduce wallet size", async () => {
    await mod.start();

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-net-buy"),
      orderId: createOrderId("ord-net-buy"),
      clientOrderId: "plk_net_buy" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.001,
      size: 1085.84424,
      sizeUsdc: 1.17,
      liquidityRole: "taker",
      fee: 0.08415576,
      feeRateBps: 1000,
      signalReason: null,
      timestamp: Date.now(),
    });

    const savedPosition = (positionRepo.save as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Position;
    const savedLot = (lotRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as InventoryLot;
    const effectiveEntry = 1.17 / 1085.84424;

    expect(savedPosition.size).toBeCloseTo(1085.84424, 5);
    expect(savedPosition.costBasisUsdc).toBeCloseTo(1.17, 6);
    expect(savedPosition.avgEntryPrice).toBeCloseTo(effectiveEntry, 8);
    expect(savedLot.entryPrice).toBeCloseTo(effectiveEntry, 8);
    expect(savedLot.costUsdc).toBeCloseTo(1.17, 6);

    await mod.stop();
  });

  it("sets entryStyle='probe' on new position from probe-entry fill", async () => {
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-probe"),
      orderId: createOrderId("ord-probe"),
      clientOrderId: "plk_probe" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });

    expect(posUpdates).toHaveLength(1);
    expect(posUpdates[0].position.entryStyle).toBe("probe");

    await mod.stop();
  });

  it("scales into existing position on buy fill", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      conditionId: COND_ID,

      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);
    mod = createModule();
    await mod.start();

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-2"),
      orderId: createOrderId("ord-2"),
      clientOrderId: "plk_def" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.6,
      size: 10,
      sizeUsdc: 6,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    // Position updated with new avg price
    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.size).toBe(20); // 10 + 10
    expect(saved.costBasisUsdc).toBe(10); // 4 + 6
    expect(saved.avgEntryPrice).toBe(0.5); // 10/20

    await mod.stop();
  });

  // ─── Fill handling: sell with FIFO ────────────────────────────────

  it("applies sell fill with FIFO lot consumption", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      conditionId: COND_ID,

      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);

    // FIFO consumption returns consumed lots
    const consumedLot: InventoryLot = {
      lotId: createLotId("lot-1"),
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,

      side: "buy",
      size: 10,
      remainingSize: 5, // 5 remaining after consuming 5
      entryPrice: 0.4,
      costUsdc: 4,
      fillId: createFillId("fill-orig"),
      createdAt: new Date().toISOString(),
    };
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockReturnValue([
      { lot: consumedLot, consumed: 5 },
    ]);
    // After consumption, lots still open
    (lotRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...consumedLot, remainingSize: 5 },
    ]);

    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-sell"),
      orderId: createOrderId("ord-sell"),
      clientOrderId: "plk_sell" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "sell" as const,
      price: 0.6,
      size: 5,
      sizeUsdc: 3,
      liquidityRole: "unknown",
      fee: 0.01,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(lotRepo.consumeFifo).toHaveBeenCalledWith(createPositionId("pos-1"), 5);

    // Position updated
    expect(posUpdates).toHaveLength(1);
    const updatedPos = posUpdates[0].position as Position;
    expect(updatedPos.size).toBe(5); // 10 - 5
    expect(updatedPos.status).toBe("open");
    // Realized PnL: (5 * 0.6) - (5 * 0.4) - 0.01 fee = 3.0 - 2.0 - 0.01 = 0.99
    expect(updatedPos.realizedPnl).toBeCloseTo(0.99, 2);

    await mod.stop();
  });

  it("closes position when fully sold", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      conditionId: COND_ID,

      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);

    const consumedLot: InventoryLot = {
      lotId: createLotId("lot-1"),
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,

      side: "buy",
      size: 10,
      remainingSize: 0,
      entryPrice: 0.4,
      costUsdc: 4,
      fillId: createFillId("fill-orig"),
      createdAt: new Date().toISOString(),
    };
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockReturnValue([
      { lot: consumedLot, consumed: 10 },
    ]);
    (lotRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([]);

    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-sell-all"),
      orderId: createOrderId("ord-sell-all"),
      clientOrderId: "plk_sellall" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "sell" as const,
      price: 0.6,
      size: 10,
      sizeUsdc: 6,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    const updatedPos = posUpdates[0].position as Position;
    expect(updatedPos.size).toBe(0);
    expect(updatedPos.status).toBe("closed");
    expect(updatedPos.closedAt).not.toBeNull();
    // Realized PnL: (10 * 0.6) - (10 * 0.4) = 6 - 4 = 2
    expect(updatedPos.realizedPnl).toBeCloseTo(2, 2);

    await mod.stop();
  });

  // ─── Fill reconciliation marking ─────────────────────────────────

  it("marks fill as reconciled after successful applyFill", async () => {
    await mod.start();

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: "plk_test" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0.01,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(fillRepo.markReconciled).toHaveBeenCalledWith([createFillId("fill-1")]);

    await mod.stop();
  });

  it("does NOT call markReconciled when applyFill throws", async () => {
    await mod.start();

    // Sell fill for a token with no existing position — applyFill will throw
    await bus.publish("FillReceived", {
      fillId: createFillId("fill-err"),
      orderId: createOrderId("ord-err"),
      clientOrderId: "plk_err" as ClientOrderId,
      tokenId: createTokenId("tok-nonexistent"),
      conditionId: COND_ID,
      side: "sell" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0.01,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(fillRepo.markReconciled).not.toHaveBeenCalled();

    await mod.stop();
  });

  it("replays unreconciled fills on start before live trading resumes", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-unreconciled"),
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);
    const consumedLot: InventoryLot = {
      lotId: createLotId("lot-unreconciled"),
      positionId: existingPos.positionId,
      tokenId: TOK_ID,
      side: "buy",
      size: 10,
      remainingSize: 0,
      entryPrice: 0.4,
      costUsdc: 4,
      fillId: createFillId("fill-buy-unreconciled"),
      createdAt: new Date().toISOString(),
    };
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockReturnValue([
      { lot: consumedLot, consumed: 10 },
    ]);
    (lotRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([]);
    fillRepo.findUnreconciled.mockReturnValue([
      {
        fillId: createFillId("fill-unreconciled-sell"),
        orderId: createOrderId("ord-unreconciled-sell"),
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "sell",
        price: 0.6,
        size: 10,
        sizeUsdc: 6,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        signalId: null,
        decisionRuleId: null,
        signalTimestamp: null,
        filledAt: "2026-04-27T00:05:51.000Z",
      } satisfies Fill,
    ]);

    mod = createModule();
    await mod.start();

    expect(positionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: existingPos.positionId,
        size: 0,
        status: "closed",
        realizedPnl: 2,
      }),
    );
    expect(fillRepo.markReconciled).toHaveBeenCalledWith([createFillId("fill-unreconciled-sell")]);

    await mod.stop();
  });

  it("applies sell fills against legacy pnl ledger family columns", async () => {
    const conn = bootstrapDatabase(":memory:");
    try {
      const now = "2026-04-27T00:00:00.000Z";
      const { positionId, buyFillId, sellFillId } = seedRealSellFillFixture(conn, {
        positionId: "pos-legacy-pnl",
        orderId: "ord-legacy-pnl",
        clientOrderId: "coid-legacy-pnl",
        buyFillId: "fill-buy-legacy",
        sellFillId: "fill-sell-legacy",
        runId: "run-legacy-pnl",
        now,
      });
      conn.db.exec(`
        DROP TABLE pnl_ledger;
        CREATE TABLE pnl_ledger (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          fill_id     TEXT NOT NULL REFERENCES fills(fill_id),
          position_id TEXT NOT NULL REFERENCES positions(position_id),
          family_id   TEXT NOT NULL,
          delta       REAL NOT NULL,
          filled_at   TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      const localBus = new InProcessEventBus();
      const localFillRepo = {
        markReconciled: vi.fn(),
        findUnreconciled: vi.fn().mockReturnValue([]),
      };
      const localModule = new RiskInventoryModule({
        bus: localBus,
        positionRepo: new SqlitePositionRepository(conn.db),
        inventoryLotRepo: new SqliteInventoryLotRepository(conn.db),
        orderRepo: createMockOrderRepo(),
        fillRepo: localFillRepo,
        log: silentLog,
        db: conn.db,
      });
      await localModule.start();

      await localBus.publish("FillReceived", {
        fillId: sellFillId,
        orderId: createOrderId("ord-legacy-pnl"),
        clientOrderId: "coid-sell-legacy" as ClientOrderId,
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "sell" as const,
        price: 0.6,
        size: 10,
        sizeUsdc: 6,
        liquidityRole: "maker",
        fee: 0,
        feeRateBps: 0,
        signalReason: null,
        timestamp: new Date(now).getTime(),
      });

      const lot = conn.db
        .prepare("SELECT remaining_size FROM inventory_lots WHERE fill_id = ?")
        .get(buyFillId) as { remaining_size: number };
      const position = conn.db
        .prepare("SELECT size, status, realized_pnl FROM positions WHERE position_id = ?")
        .get(positionId) as { size: number; status: string; realized_pnl: number };
      const pnl = conn.db
        .prepare("SELECT family_id, delta FROM pnl_ledger WHERE fill_id = ?")
        .get(sellFillId) as { family_id: string; delta: number };

      expect(lot.remaining_size).toBe(0);
      expect(position).toMatchObject({ size: 0, status: "closed", realized_pnl: 2 });
      expect(pnl).toEqual({ family_id: "legacy", delta: 2 });
      expect(localFillRepo.markReconciled).toHaveBeenCalledWith([sellFillId]);

      await localModule.stop();
    } finally {
      conn.close();
    }
  });

  it("rolls back FIFO lot consumption when sell fill persistence fails", async () => {
    const conn = bootstrapDatabase(":memory:");
    try {
      const now = "2026-04-27T00:00:00.000Z";
      const { positionId, buyFillId, sellFillId } = seedRealSellFillFixture(conn, {
        positionId: "pos-failing-pnl",
        orderId: "ord-failing-pnl",
        clientOrderId: "coid-failing-pnl",
        buyFillId: "fill-buy-failing-pnl",
        sellFillId: "fill-sell-failing-pnl",
        runId: "run-failing-pnl",
        now,
      });
      conn.db.exec(`
        CREATE TRIGGER fail_pnl_insert
        BEFORE INSERT ON pnl_ledger
        BEGIN
          SELECT RAISE(FAIL, 'forced pnl failure');
        END;
      `);

      const localBus = new InProcessEventBus();
      const localFillRepo = {
        markReconciled: vi.fn(),
        findUnreconciled: vi.fn().mockReturnValue([]),
      };
      const localModule = new RiskInventoryModule({
        bus: localBus,
        positionRepo: new SqlitePositionRepository(conn.db),
        inventoryLotRepo: new SqliteInventoryLotRepository(conn.db),
        orderRepo: createMockOrderRepo(),
        fillRepo: localFillRepo,
        log: silentLog,
        db: conn.db,
      });
      await localModule.start();

      await localBus.publish("FillReceived", {
        fillId: sellFillId,
        orderId: createOrderId("ord-failing-pnl"),
        clientOrderId: "coid-sell-failing-pnl" as ClientOrderId,
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "sell" as const,
        price: 0.6,
        size: 10,
        sizeUsdc: 6,
        liquidityRole: "maker",
        fee: 0,
        feeRateBps: 0,
        signalReason: null,
        timestamp: new Date(now).getTime(),
      });

      const lot = conn.db
        .prepare("SELECT remaining_size FROM inventory_lots WHERE fill_id = ?")
        .get(buyFillId) as { remaining_size: number };
      const position = conn.db
        .prepare("SELECT size, status FROM positions WHERE position_id = ?")
        .get(positionId) as { size: number; status: string };

      expect(lot.remaining_size).toBe(10);
      expect(position).toMatchObject({ size: 10, status: "open" });
      expect(localFillRepo.markReconciled).not.toHaveBeenCalled();

      await localModule.stop();
    } finally {
      conn.close();
    }
  });

  // ─── Unsubscribe on stop ──────────────────────────────────────────

  it("does not process events after stop", async () => {
    await mod.start();
    await mod.stop();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });

    expect(approved).toHaveLength(0);
  });

  // ─── Error resilience ─────────────────────────────────────────────

  it("rejects signal on internal error without crashing", async () => {
    // Make orderRepo.findOpen throw to trigger internal error path in AlgoRiskGate.
    (orderRepo.findOpen as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("db explosion");
    });
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("internal error");

    await mod.stop();
  });

  // ─── Null-family signals (algo critical path) ─────────────
  //
  // Per design spec: the algo trading path must flow through the risk gate
  // using only token-level checks (open-order dedup, token in-flight limit,
  // min order size). Family rules and live-lite family allowlist MUST NOT
  // be consulted.

  describe("null-family signals", () => {
    it("approves a null-family buy signal when token-level checks pass", async () => {
      mod = createModule(undefined, { executionPolicy: () => DEFAULT_EXECUTION_POLICY });
      await mod.start();

      const approved: any[] = [];
      const rejected: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });

      expect(rejected).toHaveLength(0);
      expect(approved).toHaveLength(1);
      expect(approved[0].signal.tokenId).toBe(String(TOK_ID));

      await mod.stop();
    });

    it("still rejects null-family signals that fail token-level checks", async () => {
      // Simulate the per-token BUY cap on the same token — AlgoRiskGate
      // must reject with the token-level reason regardless of family.
      const existingOrder: Order = {
        orderId: createOrderId("ord-nullfam-open"),
        clientOrderId: "plk_nullfam_open" as ClientOrderId,
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "buy",
        orderType: "GTC",
        postOnly: true,
        price: 0.5,
        size: 10,
        sizeUsdc: 5,
        status: "open",
        exchangeOrderId: "ex-nullfam-open",
        signalId: null,
        signalReason: "probe-entry",
        botRunId: "run-1" as any,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      (orderRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
        existingOrder,
        {
          ...existingOrder,
          orderId: createOrderId("ord-nullfam-open-2"),
          clientOrderId: "plk_nullfam_open_2" as ClientOrderId,
        },
      ]);
      mod = createModule(undefined, { executionPolicy: () => DEFAULT_EXECUTION_POLICY });
      await mod.start();

      const approved: any[] = [];
      const rejected: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });

      expect(approved).toHaveLength(0);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("per_token_buy_limit");

      await mod.stop();
    });

    it("processes fills and creates a position", async () => {
      mod = createModule();
      await mod.start();

      const posUpdates: any[] = [];
      bus.subscribe("PositionUpdated", async (p) => {
        posUpdates.push(p);
      });

      await bus.publish("FillReceived", {
        fillId: createFillId("fill-nullfam"),
        orderId: createOrderId("ord-nullfam"),
        clientOrderId: "coid-nullfam" as ClientOrderId,
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "buy" as const,
        price: 0.5,
        size: 10,
        sizeUsdc: 5,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        signalReason: "probe-entry",
        timestamp: Date.now(),
      });

      expect(posUpdates).toHaveLength(1);
      expect(posUpdates[0].position.size).toBe(10);

      await mod.stop();
    });
  });

  // ─── Live-lite allowlist check ────────────────────────────

  // NOTE: Live-lite family-level gates (allowlist, fee-tier, wallet mode) were removed
  // from AlgoRiskGate. These checks now live upstream. RiskInventoryModule accepts the
  // liveLiteGuard in deps for compatibility but AlgoRiskGate no longer uses it.

  it("approves signal regardless of live-lite allowlist (family gate removed)", async () => {
    const liveLiteGuard = new LiveLiteGuard({
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 50,
      maxActiveMarkets: 3,
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  // ─── Error resilience ─────────────────────────────────────

  it("logs error on orphan sell fill without fabricating PnL", async () => {
    // No existing position for the token
    positionRepo = createMockPositionRepo(null);
    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-orphan"),
      orderId: createOrderId("ord-orphan"),
      clientOrderId: "plk_orphan" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "sell" as const,
      price: 0.6,
      size: 5,
      sizeUsdc: 3,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    // No position should be created — the error is caught by the module
    expect(posUpdates).toHaveLength(0);
    // No synthetic position saved
    expect(positionRepo.save).not.toHaveBeenCalled();

    await mod.stop();
  });

  // ─── Wave 5: mark-to-market (P2-1) ─────────────────────────────────

  describe("mark-to-market (P2-1)", () => {
    it("revalues open positions on NormalizedMarketUpdated", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-1"),
        tokenId: TOK_ID,
        conditionId: COND_ID,

        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: STALE_MTM_UPDATED_AT,
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      // Market moves from 0.05 to 0.08 mark price → new value = 100 * 0.08 = 8.0
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,

            regime: "threshold" as any,
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.01,
            negRisk: false,
            gammaCreatedAt: null,
            acceptingOrders: true,
            enableOrderBook: true,
            bestBid: 0.07,
            bestAsk: 0.09,
            midPrice: 0.08,
            spread: 0.02,
            snapshotTs: Date.now(),
            eventMarketCount: 1,
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      // positionRepo.save should have been called with updated currentValueUsdc
      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedPos = saveCalls[saveCalls.length - 1][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(8.0, 2);
      expect(savedPos.status).toBe("open");

      await mod.stop();
    });

    it("batches multiple mark-to-market saves into one transaction per market update", async () => {
      const tokA = createTokenId("tok-mtm-a");
      const tokB = createTokenId("tok-mtm-b");
      positionRepo = createMockPositionRepo([
        makeMtmPosition({
          positionId: createPositionId("pos-mtm-a"),
          tokenId: tokA,
          currentValueUsdc: 5,
        }),
        makeMtmPosition({
          positionId: createPositionId("pos-mtm-b"),
          tokenId: tokB,
          currentValueUsdc: 5,
        }),
      ]);
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();
      vi.mocked(mockDb.transaction).mockClear();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          makeMarket({ tokenId: tokA, midPrice: 0.08 }),
          makeMarket({ tokenId: tokB, midPrice: 0.09 }),
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(positionRepo.save).toHaveBeenCalledTimes(2);

      await mod.stop();
    });

    it("uses market-data mark-to-market as a staleness-gated fallback for live wallet marks", async () => {
      positionRepo = createMockPositionRepo(
        makeMtmPosition({
          positionId: createPositionId("pos-live-wallet-mark-fresh"),
          size: 28.37,
          avgEntryPrice: 0.074,
          costBasisUsdc: 2.0993,
          currentValueUsdc: 2.1135,
          updatedAt: FRESH_MTM_UPDATED_AT,
        }),
      );
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ bestBid: 0.057, bestAsk: 0.058, midPrice: 0.0575 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      expect(positionRepo.save).not.toHaveBeenCalled();

      await mod.stop();

      bus = new InProcessEventBus();
      positionRepo = createMockPositionRepo(
        makeMtmPosition({
          positionId: createPositionId("pos-live-wallet-mark-stale"),
          size: 28.37,
          avgEntryPrice: 0.074,
          costBasisUsdc: 2.0993,
          currentValueUsdc: 2.1135,
          updatedAt: STALE_MTM_UPDATED_AT,
        }),
      );
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ bestBid: 0.057, bestAsk: 0.058, midPrice: 0.0575 })],
        timestamp: MTM_NOW_MS,
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls).toHaveLength(1);
      const savedPos = saveCalls[0][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(28.37 * 0.0575, 6);
      expect(savedPos.updatedAt).toBe(new Date(MTM_NOW_MS).toISOString());

      await mod.stop();
    });

    it("honors the markToMarketEnabled kill switch", async () => {
      positionRepo = createMockPositionRepo(
        makeMtmPosition({
          updatedAt: STALE_MTM_UPDATED_AT,
        }),
      );
      mod = createModule(undefined, { markToMarketEnabled: false, now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ bestBid: 0.057, bestAsk: 0.058, midPrice: 0.0575 })],
        timestamp: MTM_NOW_MS,
      });
      await bus.drain();

      expect(positionRepo.save).not.toHaveBeenCalled();

      await mod.stop();
    });

    it("values long inventory at midpoint/current price instead of thin best bid", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-wide-spread"),
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: STALE_MTM_UPDATED_AT,
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ bestBid: 0.003, bestAsk: 0.125, midPrice: 0.064 })],
        timestamp: Date.now(),
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedPos = saveCalls[saveCalls.length - 1][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(6.4, 2);
      expect(savedPos.status).toBe("open");

      await mod.stop();
    });

    it("skips mark-to-market when midpoint/current price is unavailable", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-no-bid"),
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "buy",
        size: 2100,
        avgEntryPrice: 0.001,
        costBasisUsdc: 2.1,
        currentValueUsdc: 3.15,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: STALE_MTM_UPDATED_AT,
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ bestBid: null, bestAsk: 0.001, midPrice: null })],
        timestamp: Date.now(),
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls).toHaveLength(0);

      await mod.stop();
    });

    it("reclassifies true below-min open positions to dust on mark-to-market", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-dustify"),
        tokenId: TOK_ID,
        conditionId: COND_ID,

        side: "buy",
        size: 1,
        avgEntryPrice: 0.8,
        costBasisUsdc: 0.8,
        currentValueUsdc: 0.8,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: STALE_MTM_UPDATED_AT,
      };
      positionRepo = createMockPositionRepo(pos);
      const updates: Position[] = [];
      bus.subscribe("PositionUpdated", async (payload) => {
        updates.push(payload.position);
      });
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,

            regime: "threshold" as any,
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.01,
            negRisk: false,
            gammaCreatedAt: null,
            acceptingOrders: true,
            enableOrderBook: true,
            bestBid: 0.19,
            bestAsk: 0.21,
            midPrice: 0.2,
            spread: 0.02,
            minOrderSize: 5,
            snapshotTs: Date.now(),
            eventMarketCount: 1,
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedPos = saveCalls[saveCalls.length - 1][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(0.2, 2);
      expect(savedPos.status).toBe("dust");
      expect(updates).toEqual([expect.objectContaining({ status: "dust", size: 1 })]);

      await mod.stop();
    });

    it("keeps sellable low-bid positions open when share size exceeds min order", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-sellable-low-bid"),
        tokenId: TOK_ID,
        conditionId: COND_ID,

        side: "buy",
        size: 105,
        avgEntryPrice: 0.02,
        costBasisUsdc: 2.1,
        currentValueUsdc: 0.315,
        realizedPnl: 0,
        status: "dust",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: STALE_MTM_UPDATED_AT,
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          makeMarket({
            bestBid: 0.003,
            bestAsk: 0.05,
            midPrice: 0.0265,
            minOrderSize: 5,
          }),
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedPos = saveCalls[saveCalls.length - 1][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(2.7825, 4);
      expect(savedPos.status).toBe("open");

      await mod.stop();
    });

    it("reclassifies dust positions back to open on mark-to-market", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-reopen"),
        tokenId: TOK_ID,
        conditionId: COND_ID,

        side: "buy",
        size: 67.28,
        avgEntryPrice: 0.027,
        costBasisUsdc: 1.81656,
        currentValueUsdc: 0.49,
        realizedPnl: 0,
        status: "dust",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: STALE_MTM_UPDATED_AT,
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,

            regime: "threshold" as any,
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.001,
            negRisk: false,
            gammaCreatedAt: null,
            acceptingOrders: true,
            enableOrderBook: true,
            bestBid: 0.075,
            bestAsk: 0.077,
            midPrice: 0.076,
            spread: 0.002,
            snapshotTs: Date.now(),
            eventMarketCount: 1,
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedPos = saveCalls[saveCalls.length - 1][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(5.11328, 5);
      expect(savedPos.status).toBe("open");

      await mod.stop();
    });

    it("skips positions without live price data", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-1"),
        tokenId: TOK_ID,
        conditionId: COND_ID,

        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: STALE_MTM_UPDATED_AT,
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      // Market update with null midPrice → no revaluation
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: createTokenId("tok-other"),
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,

            regime: "threshold" as any,
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.01,
            negRisk: false,
            gammaCreatedAt: null,
            acceptingOrders: false,
            enableOrderBook: false,
            bestBid: null,
            bestAsk: null,
            midPrice: null,
            spread: null,
            snapshotTs: Date.now(),
            eventMarketCount: 1,
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      // No save call for position (no price data matched)
      expect(positionRepo.save).not.toHaveBeenCalled();

      await mod.stop();
    });

    it("writes mark-to-market when currentValueUsdc is null", async () => {
      positionRepo = createMockPositionRepo(
        makeMtmPosition({
          positionId: createPositionId("pos-null-current-value"),
          size: 6.85,
          currentValueUsdc: null,
          updatedAt: FRESH_MTM_UPDATED_AT,
        }),
      );
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();
      (positionRepo.save as any).mockClear();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ midPrice: 0.2 })],
        timestamp: MTM_NOW_MS,
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0][0].currentValueUsdc).toBeCloseTo(6.85 * 0.2, 6);
      expect(saveCalls[0][0].updatedAt).toBe(new Date(MTM_NOW_MS).toISOString());

      await mod.stop();
    });

    it("overrides implausible currentValueUsdc immediately", async () => {
      positionRepo = createMockPositionRepo(
        makeMtmPosition({
          positionId: createPositionId("pos-implausible-current-value"),
          size: 0.01,
          currentValueUsdc: 8.0964,
          updatedAt: FRESH_MTM_UPDATED_AT,
        }),
      );
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();
      (positionRepo.save as any).mockClear();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ midPrice: 0.2 })],
        timestamp: MTM_NOW_MS,
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0][0].currentValueUsdc).toBeCloseTo(0.01 * 0.2, 6);

      await mod.stop();
    });

    it("skips plausible fresh values and writes plausible stale values", async () => {
      positionRepo = createMockPositionRepo(
        makeMtmPosition({
          positionId: createPositionId("pos-plausible-fresh"),
          currentValueUsdc: 4,
          updatedAt: new Date(MTM_NOW_MS - 30_000).toISOString(),
        }),
      );
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ midPrice: 0.08 })],
        timestamp: MTM_NOW_MS,
      });
      await bus.drain();

      expect(positionRepo.save).not.toHaveBeenCalled();
      await mod.stop();

      bus = new InProcessEventBus();
      positionRepo = createMockPositionRepo(
        makeMtmPosition({
          positionId: createPositionId("pos-plausible-stale"),
          currentValueUsdc: 4,
          updatedAt: new Date(MTM_NOW_MS - 90_000).toISOString(),
        }),
      );
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [makeMarket({ midPrice: 0.08 })],
        timestamp: MTM_NOW_MS,
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0][0].currentValueUsdc).toBeCloseTo(8, 6);

      await mod.stop();
    });

    it("backfills null and implausible startup values from latest usable price", async () => {
      const nullToken = createTokenId("tok-null-backfill");
      const implausibleToken = createTokenId("tok-implausible-backfill");
      const plausibleToken = createTokenId("tok-plausible-backfill");
      positionRepo = createMockPositionRepo([
        makeMtmPosition({
          positionId: createPositionId("pos-null-backfill"),
          tokenId: nullToken,
          size: 6.85,
          currentValueUsdc: null,
        }),
        makeMtmPosition({
          positionId: createPositionId("pos-implausible-backfill"),
          tokenId: implausibleToken,
          size: 0.01,
          currentValueUsdc: 8.0964,
        }),
        makeMtmPosition({
          positionId: createPositionId("pos-plausible-backfill"),
          tokenId: plausibleToken,
          size: 10,
          currentValueUsdc: 2,
        }),
      ]);
      mod = createModule(undefined, {
        now: () => MTM_NOW_MS,
        latestUsablePriceForToken: (tokenId) =>
          String(tokenId) === String(plausibleToken) ? null : 0.2,
      });

      await mod.start();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls).toHaveLength(2);
      expect(saveCalls[0][0].tokenId).toBe(nullToken);
      expect(saveCalls[0][0].currentValueUsdc).toBeCloseTo(6.85 * 0.2, 6);
      expect(saveCalls[0][0].updatedAt).toBe(new Date(MTM_NOW_MS).toISOString());
      expect(saveCalls[1][0].tokenId).toBe(implausibleToken);
      expect(saveCalls[1][0].currentValueUsdc).toBeCloseTo(0.01 * 0.2, 6);
      expect(saveCalls[1][0].updatedAt).toBe(new Date(MTM_NOW_MS).toISOString());
      expect(silentLog.info).toHaveBeenCalledWith(
        { backfilled: 2 },
        "startup mark-to-market backfill",
      );

      await mod.stop();
    });

    it("writes explicit null during startup backfill when latest usable price is unavailable", async () => {
      positionRepo = createMockPositionRepo(
        makeMtmPosition({
          positionId: createPositionId("pos-null-no-midpoint"),
          currentValueUsdc: null,
        }),
      );
      mod = createModule(undefined, {
        now: () => MTM_NOW_MS,
        latestUsablePriceForToken: () => null,
      });

      await mod.start();

      expect(positionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          currentValueUsdc: null,
          updatedAt: new Date(MTM_NOW_MS).toISOString(),
        }),
      );

      await mod.stop();
    });

    it("clears implausible startup value to null when latest usable price is unavailable", async () => {
      positionRepo = createMockPositionRepo(
        makeMtmPosition({
          positionId: createPositionId("pos-implausible-no-price"),
          size: 0.01,
          currentValueUsdc: 8.0964,
        }),
      );
      mod = createModule(undefined, {
        now: () => MTM_NOW_MS,
        latestUsablePriceForToken: () => null,
      });

      await mod.start();

      expect(positionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          currentValueUsdc: null,
          status: "open",
          updatedAt: new Date(MTM_NOW_MS).toISOString(),
        }),
      );

      await mod.stop();
    });
  });

  // ─── Wave 5: operator diagnostics (P2-2) ───────────────────────────

  describe("operator diagnostics (P2-2)", () => {
    it("tracks approved and rejected signal counts per family", async () => {
      await mod.start();

      // Approve a probe-entry
      await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });
      await bus.drain();

      // Reject by making orderRepo.findOpen throw (triggers internal error path)
      (orderRepo.findOpen as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("db explosion");
      });
      await bus.publish("SignalProduced", {
        signal: makeSignal({ signalId: "sig-2" }),
        market: makeMarket(),
      });
      await bus.drain();

      const diag = mod.getDiagnostics();
      expect(diag.signalsProcessed).toBe(2);
      expect(diag.signalsApproved).toBe(1);
      expect(diag.signalsRejected).toBe(1);

      await mod.stop();
    });

    it("tracks last signal reason (approved signals increment counter)", async () => {
      await mod.start();

      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "probe-entry" }),
        market: makeMarket(),
      });
      await bus.drain();

      const diag = mod.getDiagnostics();
      expect(diag.signalsApproved).toBe(1);
      expect(diag.signalsProcessed).toBe(1);

      await mod.stop();
    });

    it("reports mark-to-market update count", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-1"),
        tokenId: TOK_ID,
        conditionId: COND_ID,

        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: STALE_MTM_UPDATED_AT,
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule(undefined, { now: () => MTM_NOW_MS });
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,

            regime: "threshold" as any,
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.01,
            negRisk: false,
            gammaCreatedAt: null,
            acceptingOrders: true,
            enableOrderBook: true,
            bestBid: 0.07,
            bestAsk: 0.09,
            midPrice: 0.08,
            spread: 0.02,
            snapshotTs: Date.now(),
            eventMarketCount: 1,
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      const diag = mod.getDiagnostics();
      expect(diag.markToMarketUpdates).toBe(1);

      await mod.stop();
    });

    it("healthCheck includes approved/rejected/mtm counts", async () => {
      await mod.start();

      await bus.publish("SignalProduced", { signal: makeSignal(), market: makeMarket() });
      await bus.drain();

      const h = await mod.healthCheck();
      expect(h.detail).toContain("approved=1");
      expect(h.detail).toContain("rejected=0");
      expect(h.detail).toContain("mtm=0");

      await mod.stop();
    });
  });
});
