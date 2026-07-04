import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapLedgerDb,
  SqliteFillRepository,
  SqliteInventoryLotRepository,
  SqliteLegStateRepository,
  SqliteMarketRepository,
  SqliteOrderRepository,
  SqlitePositionRepository,
} from "@krabs/db";
import {
  createBotRunId,
  createConditionId,
  createFillId,
  createLotId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ClientOrderId,
  type ExchangeFill,
} from "@krabs/domain";
import {
  cleanupPriorStartupAdoptionArtifacts,
  runStartupPositionAdoption,
} from "../startup-position-adoption.js";

const TOKEN_ID = createTokenId("tok-btc-yes");

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => silentLog,
} as any;

function makeExchangeFill(overrides?: Partial<ExchangeFill>): ExchangeFill {
  return {
    fillId: "fill-1",
    orderId: "ex-1",
    clientOrderId: "plk_missing",
    tokenId: TOKEN_ID,
    side: "buy",
    price: 0.4,
    size: 10,
    liquidityRole: "unknown",
    fee: 0,
    feeRateBps: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

function seedMarket(repo: SqliteMarketRepository): void {
  repo.save({
    tokenId: TOKEN_ID,
    conditionId: "cond-1",
    slug: "bitcoin-above-68000",
    eventSlug: "bitcoin-april",
    question: "Will BTC be above 68k?",
    outcome: "YES",
    regime: "threshold",
    horizon: "daily",
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe("runStartupPositionAdoption", () => {
  const connections: Array<ReturnType<typeof bootstrapLedgerDb>> = [];

  afterEach(() => {
    while (connections.length > 0) {
      connections.pop()!.close();
    }
  });

  it("adopts orphan buy fills into local order/fill/position/lot state", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    const result = await runStartupPositionAdoption({
      gateway: {
        getFills: vi.fn().mockResolvedValue([makeExchangeFill()]),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });

    expect(result.appliedFills).toBe(1);
    expect(result.adoptedOrphanFills).toBe(1);
    expect(result.syntheticOrdersCreated).toBe(1);
    expect(result.positionsCreated).toBe(1);
    expect(orderRepo.findByExchangeOrderId("ex-1")).not.toBeNull();
    expect(fillRepo.findByTokenId(TOKEN_ID)).toHaveLength(1);
    expect(fillRepo.findUnreconciled()).toHaveLength(0);
    expect(inventoryLotRepo.findByTokenId(TOKEN_ID)).toHaveLength(1);

    const position = positionRepo.findByTokenId(TOKEN_ID);
    expect(position).not.toBeNull();
    expect(position?.size).toBe(10);
    expect(position?.costBasisUsdc).toBe(4);
  });

  it("forwards fillCompletionTolerance=0 → near-complete fill leaves local order partially-filled (#36)", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    const orderId = createOrderId("ord-known");
    orderRepo.save({
      orderId,
      clientOrderId: "plk_known" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      side: "buy",
      orderType: "GTC",
      price: 0.4,
      size: 10, // fill below is 9.97 → 0.3% short
      sizeUsdc: 4,
      status: "open",
      exchangeOrderId: "ex-known",
      signalId: null,
      signalReason: "probe-entry",
      botRunId: createBotRunId("run-1"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await runStartupPositionAdoption({
      gateway: {
        getFills: vi.fn().mockResolvedValue([
          makeExchangeFill({
            fillId: "fill-known",
            orderId: "ex-known",
            clientOrderId: "plk_known",
            size: 9.97,
          }),
        ]),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
      fillCompletionTolerance: 0,
    });

    expect(orderRepo.findById(orderId)?.status).toBe("partially-filled");
  });

  it("rebuilds the same startup-adopted state across repeated startups", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    const gateway = {
      getFills: vi.fn().mockResolvedValue([makeExchangeFill()]),
    };

    const first = await runStartupPositionAdoption({
      gateway,
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });
    const second = await runStartupPositionAdoption({
      gateway,
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-2"),
    });

    expect(first.appliedFills).toBe(1);
    expect(second.cleanedSyntheticOrders).toBe(1);
    expect(second.cleanedSyntheticFills).toBe(1);
    expect(second.appliedFills).toBe(1);
    expect(positionRepo.findOpen()).toHaveLength(1);
    expect(fillRepo.findByTokenId(TOKEN_ID)).toHaveLength(1);
  });

  it("skips orphan fills whose token is not classified into a market family", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);

    const result = await runStartupPositionAdoption({
      gateway: {
        getFills: vi.fn().mockResolvedValue([makeExchangeFill()]),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });

    expect(result.appliedFills).toBe(0);
    expect(result.skippedNoMarket).toBe(1);
    expect(positionRepo.findOpen()).toHaveLength(0);
  });

  it("skips invalid-timestamp fills instead of crashing startup", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    const result = await runStartupPositionAdoption({
      gateway: {
        getFills: vi.fn().mockResolvedValue([makeExchangeFill({ timestamp: Number.NaN })]),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });

    expect(result.appliedFills).toBe(0);
    expect(result.skippedInvalidTimestamp).toBe(1);
    expect(positionRepo.findOpen()).toHaveLength(0);
    expect(fillRepo.findByTokenId(TOKEN_ID)).toHaveLength(0);
  });

  it("cleans previous startup-adoption artifacts before rebuilding corrected positions", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);
    seedMarket(marketRepo);

    orderRepo.save({
      orderId: createOrderId("bad-order"),
      clientOrderId: "adopt-bad" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),

      side: "buy",
      orderType: "GTC",
      postOnly: false,
      price: 0.9,
      size: 334.37188,
      sizeUsdc: 300.934692,
      status: "filled",
      exchangeOrderId: "bad-order",
      signalId: null,
      signalReason: "startup-adoption",
      botRunId: createBotRunId("bad-run"),
      createdAt: "2026-04-05T00:00:00Z",
      updatedAt: "2026-04-05T00:00:00Z",
    });
    fillRepo.save({
      fillId: createFillId("bad-fill"),
      orderId: createOrderId("bad-order"),
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),

      side: "buy",
      price: 0.9,
      size: 334.37188,
      sizeUsdc: 300.934692,
      liquidityRole: "maker",
      fee: 0,
      feeRateBps: 0,
      filledAt: "2026-04-05T00:00:00Z",
    });
    positionRepo.save({
      positionId: createPositionId("bad-position"),
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),

      side: "buy",
      size: 334.37188,
      avgEntryPrice: 0.9,
      costBasisUsdc: 300.934692,
      currentValueUsdc: 255.79,
      realizedPnl: 0,
      status: "open",
      entryStyle: "probe",
      openedAt: "2026-04-05T00:00:00Z",
      closedAt: null,
      updatedAt: "2026-04-05T00:00:00Z",
    });
    inventoryLotRepo.save({
      lotId: createLotId("bad-lot"),
      positionId: createPositionId("bad-position"),
      tokenId: TOKEN_ID,

      side: "buy",
      size: 334.37188,
      remainingSize: 334.37188,
      entryPrice: 0.9,
      costUsdc: 300.934692,
      fillId: createFillId("bad-fill"),
      createdAt: "2026-04-05T00:00:00Z",
    });

    const result = await runStartupPositionAdoption({
      gateway: {
        getFills: vi.fn().mockResolvedValue([
          makeExchangeFill({
            fillId: "good-fill",
            orderId: "good-order",
            clientOrderId: "",
            size: 43.47,
            price: 0.11,
          }),
        ]),
      },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-1"),
    });

    expect(result.cleanedSyntheticOrders).toBe(1);
    expect(result.cleanedSyntheticFills).toBe(1);
    expect(result.appliedFills).toBe(1);

    const position = positionRepo.findByTokenId(TOKEN_ID);
    expect(position).not.toBeNull();
    expect(position?.size).toBeCloseTo(43.47, 6);
    expect(position?.avgEntryPrice).toBeCloseTo(0.11, 6);
    expect(position?.costBasisUsdc).toBeCloseTo(4.7817, 6);
  });

  describe("leg-state rebuild", () => {
    function seedOrder(orderRepo: SqliteOrderRepository, orderId: string): void {
      orderRepo.save({
        orderId: createOrderId(orderId),
        clientOrderId: `coid-${orderId}` as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),

        side: "buy",
        orderType: "GTC",
        postOnly: false,
        price: 0.42,
        size: 10,
        sizeUsdc: 4.2,
        status: "filled",
        exchangeOrderId: orderId,
        signalId: null,
        signalReason: "probe-entry",
        botRunId: createBotRunId("run-seed"),
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
      });
    }

    function seedOpenPosition(
      positionRepo: SqlitePositionRepository,
      overrides?: Partial<Parameters<SqlitePositionRepository["save"]>[0]>,
    ): void {
      positionRepo.save({
        positionId: createPositionId("pos-1"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),

        side: "buy",
        size: 10,
        avgEntryPrice: 0.42,
        costBasisUsdc: 4.2,
        currentValueUsdc: 4.2,
        realizedPnl: 0,
        status: "open",
        entryStyle: "probe",
        openedAt: "2026-04-01T00:00:00Z",
        closedAt: null,
        updatedAt: "2026-04-01T00:00:00Z",
        ...overrides,
      });
    }

    function seedFill(
      fillRepo: SqliteFillRepository,
      overrides: Omit<Partial<Parameters<SqliteFillRepository["save"]>[0]>, "fillId"> & {
        fillId: string;
      },
    ): void {
      const { fillId, ...rest } = overrides;
      fillRepo.save({
        fillId: createFillId(fillId),
        orderId: createOrderId("ord-seed"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),

        side: "buy",
        price: 0.42,
        size: 10,
        sizeUsdc: 4.2,
        liquidityRole: "maker",
        fee: 0,
        feeRateBps: 0,
        filledAt: "2026-04-01T00:00:00Z",
        ...rest,
      });
    }

    async function runRebuild(conn: ReturnType<typeof bootstrapLedgerDb>): Promise<{
      result: Awaited<ReturnType<typeof runStartupPositionAdoption>>;
      legStateRepo: SqliteLegStateRepository;
    }> {
      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      const result = await runStartupPositionAdoption({
        gateway: { getFills: vi.fn().mockResolvedValue([]) },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });
      return { result, legStateRepo };
    }

    function primeLedger(conn: ReturnType<typeof bootstrapLedgerDb>): {
      marketRepo: SqliteMarketRepository;
      orderRepo: SqliteOrderRepository;
      fillRepo: SqliteFillRepository;
      positionRepo: SqlitePositionRepository;
    } {
      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      seedMarket(marketRepo);
      seedOrder(orderRepo, "ord-seed");
      return { marketRepo, orderRepo, fillRepo, positionRepo };
    }

    it("seeds leg_state for open position with matching fills", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      expect(result.alreadyPresentLegStates).toBe(0);
      expect(result.positionsWithoutFills).toEqual([]);
      const state = legStateRepo.get(TOKEN_ID);
      expect(state).not.toBeNull();
      expect(state?.buyCount).toBe(1);
      expect(state?.sellCount).toBe(0);
      expect(state?.lastAction).toBe("BUY");
      expect(state?.firstTradePrice).toBe(0.42);
      expect(state?.firstTradeAt).toBe("2026-04-01T00:00:00Z");
    });

    it("is idempotent: second run does not overwrite existing leg_state", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const first = await runRebuild(conn);
      expect(first.result.seededLegStates).toBe(1);
      const firstState = first.legStateRepo.get(TOKEN_ID);

      const second = await runRebuild(conn);
      expect(second.result.seededLegStates).toBe(0);
      expect(second.result.alreadyPresentLegStates).toBe(1);
      const secondState = second.legStateRepo.get(TOKEN_ID);
      expect(secondState).toEqual(firstState);
    });

    it("counts buy and sell fills across multiple fills of each side", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);
      seedFill(fillRepo, {
        fillId: "f-1",
        side: "buy",
        price: 0.42,
        filledAt: "2026-04-01T00:00:00Z",
      });
      seedFill(fillRepo, {
        fillId: "f-2",
        side: "buy",
        price: 0.11,
        filledAt: "2026-04-02T00:00:00Z",
      });
      seedFill(fillRepo, {
        fillId: "f-3",
        side: "sell",
        price: 0.55,
        filledAt: "2026-04-03T00:00:00Z",
      });

      const { legStateRepo } = await runRebuild(conn);

      const state = legStateRepo.get(TOKEN_ID);
      expect(state?.buyCount).toBe(2);
      expect(state?.sellCount).toBe(1);
      expect(state?.lastAction).toBe("SELL");
      expect(state?.lastTradeAt).toBe("2026-04-03T00:00:00Z");
    });

    it("uses first BUY fill for firstTradePrice (ordered by filled_at ASC, fill_id ASC)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);
      seedFill(fillRepo, { fillId: "f-b", price: 0.99, filledAt: "2026-04-01T00:00:00Z" });
      seedFill(fillRepo, { fillId: "f-a", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });
      seedFill(fillRepo, { fillId: "f-c", price: 0.11, filledAt: "2026-04-02T00:00:00Z" });

      const { legStateRepo } = await runRebuild(conn);

      const state = legStateRepo.get(TOKEN_ID);
      expect(state?.firstTradePrice).toBe(0.42);
      expect(state?.firstTradeAt).toBe("2026-04-01T00:00:00Z");
    });

    it("reports positionsWithoutFills for an open position with zero fills", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo);

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.positionsWithoutFills).toEqual([TOKEN_ID]);
      expect(result.seededLegStates).toBe(0);
      expect(legStateRepo.get(TOKEN_ID)).toBeNull();
    });

    it("falls back to position.avgEntryPrice when the first BUY fill has price=0", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo, { avgEntryPrice: 0.37, costBasisUsdc: 3.7 });
      seedFill(fillRepo, { fillId: "f-1", price: 0, filledAt: "2026-04-01T00:00:00Z" });

      const { legStateRepo } = await runRebuild(conn);

      const state = legStateRepo.get(TOKEN_ID);
      expect(state?.firstTradePrice).toBe(0.37);
    });

    it("seeds leg_state for dust positions (not just open)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo, { status: "dust" });
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      expect(legStateRepo.get(TOKEN_ID)?.buyCount).toBe(1);
    });

    it("skips closed positions", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      seedOpenPosition(positionRepo, {
        status: "closed",
        closedAt: "2026-04-02T00:00:00Z",
      });
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(0);
      expect(result.positionsWithoutFills).toEqual([]);
      expect(legStateRepo.get(TOKEN_ID)).toBeNull();
    });

    it("scopes replay past prior closed-leg fills — prior fills don't leak into rebuilt leg_state", async () => {
      // ADR-027 §D-B — a token can have a prior CLOSED leg and a later
      // reopened active position with no leg_state row (e.g. control DB
      // migrated independently). The rebuild must scope fills to
      // `filled_at > MAX(prior closed_at)`. opened_at is wall-clock and can
      // race ahead of an exchange-supplied filled_at; closed_at is always
      // strictly after the prior leg's last fill, so it gives a clean strict
      // lower bound that excludes the old leg without dropping the active
      // leg's opening fill.
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);

      // Prior closed leg with its own fills — must be ignored by the rebuild:
      positionRepo.save({
        positionId: createPositionId("pos-prior"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        size: 0,
        avgEntryPrice: 0.1,
        costBasisUsdc: 0,
        currentValueUsdc: 0,
        realizedPnl: 0,
        status: "closed",
        entryStyle: "probe",
        openedAt: "2026-03-01T00:00:00Z",
        closedAt: "2026-03-15T00:00:00Z",
        updatedAt: "2026-03-15T00:00:00Z",
      });
      seedFill(fillRepo, { fillId: "f-old-1", price: 0.1, filledAt: "2026-03-01T00:00:00Z" });
      seedFill(fillRepo, {
        fillId: "f-old-2",
        side: "sell",
        price: 0.15,
        filledAt: "2026-03-02T00:00:00Z",
      });

      // Active position with one BUY whose exchange filled_at is BEFORE its
      // wall-clock opened_at — exercises the clock-skew gap that broke the
      // earlier opened_at-based scope.
      seedOpenPosition(positionRepo, { openedAt: "2026-04-01T00:00:01Z" });
      seedFill(fillRepo, {
        fillId: "f-new-1",
        side: "buy",
        price: 0.42,
        filledAt: "2026-04-01T00:00:00Z",
      });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      const state = legStateRepo.get(TOKEN_ID);
      // Without scoping: buyCount=2, sellCount=1, firstTradePrice=0.10.
      // With prior-close scoping (`filled_at > "2026-03-15"`): only the
      // active leg's BUY survives, even though its filled_at < opened_at.
      expect(state?.buyCount).toBe(1);
      expect(state?.sellCount).toBe(0);
      expect(state?.firstTradePrice).toBe(0.42);
      expect(state?.firstTradeAt).toBe("2026-04-01T00:00:00Z");
    });

    it("ignores synthetic late closed_at (post-active-leg) when scoping replay", async () => {
      // Bootstrap's duplicate-open repair (`ensureUniqueOpenPositionIndex`)
      // closes losing duplicates with `closed_at = datetime('now')`, which
      // can be AFTER the active leg's actual fills. The replay scope must
      // pick the largest `closed_at < active.opened_at`, not a global MAX,
      // or that synthetic timestamp would mask out the active leg's own
      // fills and leave the position without a leg_state row.
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);

      // Active position opened 2026-04-01 — its first BUY fill is here:
      seedOpenPosition(positionRepo, {
        positionId: createPositionId("pos-active"),
        openedAt: "2026-04-01T00:00:00Z",
      });
      seedFill(fillRepo, {
        fillId: "f-active-1",
        side: "buy",
        price: 0.42,
        filledAt: "2026-04-01T00:00:01Z",
      });

      // Synthetic late-closed duplicate row: opened earlier (2026-03-25) but
      // closed_at synthesised at "2026-05-10" by the dup-open repair. With
      // an unfiltered MAX(closed_at), this would set the lower bound past
      // the active leg's fill and orphan the position.
      positionRepo.save({
        positionId: createPositionId("pos-dup"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        size: 0,
        avgEntryPrice: 0.1,
        costBasisUsdc: 0,
        currentValueUsdc: 0,
        realizedPnl: 0,
        status: "closed",
        entryStyle: "probe",
        openedAt: "2026-03-25T00:00:00Z",
        closedAt: "2026-05-10T00:00:00Z",
        updatedAt: "2026-05-10T00:00:00Z",
      });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      expect(result.positionsWithoutFills).toEqual([]);
      const state = legStateRepo.get(TOKEN_ID);
      expect(state?.buyCount).toBe(1);
      expect(state?.firstTradePrice).toBe(0.42);
    });

    it("uses time parsing (not lexical sort) when comparing mixed-format timestamps", async () => {
      // bootstrap.ts:600 (`ensureUniqueOpenPositionIndex`) writes
      // `closed_at = datetime('now')`, which yields SQLite's compact format
      // `YYYY-MM-DD HH:MM:SS` (space separator), while runtime opens/fills
      // are ISO strings `...T...Z`. Lexical ordering disagrees with
      // chronological ordering across the two formats because space (0x20)
      // sorts before T (0x54). With raw text comparison, an ISO timestamp
      // at 08:00 sorts AFTER an SQLite-format timestamp at 10:00 on the
      // same date — so a stale prior-leg fill at 08:00 ISO would slip past
      // a `filled_at > "YYYY-MM-DD 10:00:00"` predicate and leak into the
      // active leg's rebuilt counts. We use julianday() to compare both
      // sides numerically.
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);

      // Active position opened the next day.
      seedOpenPosition(positionRepo, {
        positionId: createPositionId("pos-active"),
        openedAt: "2026-04-02T00:00:00.000Z",
      });
      seedFill(fillRepo, {
        fillId: "f-active",
        side: "buy",
        price: 0.42,
        filledAt: "2026-04-02T00:00:01.000Z",
      });

      // Stale fill from the prior leg, BEFORE the synthetic close at 10:00
      // SQLite-format. Should be excluded by the replay scope. With raw
      // text comparison, "2026-04-01T08:00:00.000Z" > "2026-04-01 10:00:00"
      // (T > space at char 10) — so the broken impl wrongly includes it.
      seedFill(fillRepo, {
        fillId: "f-stale",
        side: "buy",
        price: 0.99,
        filledAt: "2026-04-01T08:00:00.000Z",
      });

      // Bypass repository writes to inject SQLite's space-format timestamp
      // directly, mirroring what `ensureUniqueOpenPositionIndex` produces
      // via `datetime('now')`.
      conn.db
        .prepare(
          `INSERT INTO positions (
             position_id, token_id, condition_id, side, size,
             avg_entry_price, cost_basis_usdc, current_value_usdc,
             realized_pnl, status, entry_style,
             opened_at, closed_at, updated_at
           ) VALUES (?, ?, ?, 'buy', 0, 0.1, 0, 0, 0, 'closed', 'probe', ?, ?, ?)`,
        )
        .run(
          "pos-prior",
          TOKEN_ID,
          "cond-1",
          "2026-04-01T07:00:00.000Z",
          "2026-04-01 10:00:00",
          "2026-04-01 10:00:00",
        );

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      const state = legStateRepo.get(TOKEN_ID);
      // Only the active fill should count — the stale 08:00 ISO fill must
      // not bleed past the 10:00 SQLite-format prior close boundary.
      expect(state?.buyCount).toBe(1);
      expect(state?.firstTradePrice).toBe(0.42);
    });

    it("dedups tokens with coexisting open + dust rows (counts fills once)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      positionRepo.save({
        positionId: createPositionId("pos-dust"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),

        side: "buy",
        size: 1,
        avgEntryPrice: 0.3,
        costBasisUsdc: 0.3,
        currentValueUsdc: 0.3,
        realizedPnl: 0,
        status: "dust",
        entryStyle: "probe",
        openedAt: "2026-03-30T00:00:00Z",
        closedAt: null,
        updatedAt: "2026-03-30T00:00:00Z",
      });
      seedOpenPosition(positionRepo, { positionId: createPositionId("pos-open") });
      seedFill(fillRepo, { fillId: "f-1", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });

      const { result, legStateRepo } = await runRebuild(conn);

      expect(result.seededLegStates).toBe(1);
      expect(legStateRepo.get(TOKEN_ID)?.buyCount).toBe(1);
    });
  });

  describe("maker entryStyle propagation through adoption", () => {
    it("carries 'maker' entryStyle from a local order into the created position", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      const orderId = createOrderId("ord-maker");
      orderRepo.save({
        orderId,
        clientOrderId: "plk_maker" as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        orderType: "GTC",
        price: 0.4,
        size: 10,
        sizeUsdc: 4,
        status: "open",
        exchangeOrderId: "ex-maker",
        signalId: null,
        signalReason: "maker-entry",
        entryStyle: "maker",
        botRunId: createBotRunId("run-1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      await runStartupPositionAdoption({
        gateway: {
          getFills: vi
            .fn()
            .mockResolvedValue([
              makeExchangeFill({ orderId: "ex-maker", clientOrderId: "plk_maker" }),
            ]),
        },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      const position = positionRepo.findByTokenId(TOKEN_ID);
      expect(position).not.toBeNull();
      expect(position?.entryStyle).toBe("maker");
    });

    it("defaults position to 'probe' when order has no entryStyle (byte-identical for non-maker path)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      // No entryStyle on the order — probe default
      await runStartupPositionAdoption({
        gateway: {
          getFills: vi.fn().mockResolvedValue([makeExchangeFill()]),
        },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      const position = positionRepo.findByTokenId(TOKEN_ID);
      expect(position).not.toBeNull();
      expect(position?.entryStyle).toBe("probe");
    });

    it("preserves 'maker' entryStyle through a second startup (reconcileAndRepairPosition path)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);

      const marketRepo = new SqliteMarketRepository(conn.db);
      const orderRepo = new SqliteOrderRepository(conn.db);
      const fillRepo = new SqliteFillRepository(conn.db);
      const positionRepo = new SqlitePositionRepository(conn.db);
      const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
      const legStateRepo = new SqliteLegStateRepository(conn.db);
      seedMarket(marketRepo);

      const gateway = {
        getFills: vi
          .fn()
          .mockResolvedValue([
            makeExchangeFill({ orderId: "ex-restart", clientOrderId: "plk_restart" }),
          ]),
      };

      const orderId = createOrderId("ord-restart");
      orderRepo.save({
        orderId,
        clientOrderId: "plk_restart" as ClientOrderId,
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        side: "buy",
        orderType: "GTC",
        price: 0.4,
        size: 10,
        sizeUsdc: 4,
        status: "open",
        exchangeOrderId: "ex-restart",
        signalId: null,
        signalReason: "maker-entry",
        entryStyle: "maker",
        botRunId: createBotRunId("run-1"),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // First startup — creates the position with "maker"
      await runStartupPositionAdoption({
        gateway,
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-1"),
      });

      expect(positionRepo.findByTokenId(TOKEN_ID)?.entryStyle).toBe("maker");

      // Second startup — goes through reconcileAndRepairPosition which reads entry_style from DB
      await runStartupPositionAdoption({
        gateway,
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        log: silentLog,
        db: conn.db,
        botRunId: createBotRunId("run-2"),
      });

      const afterRestart = positionRepo.findByTokenId(TOKEN_ID);
      expect(afterRestart?.entryStyle).toBe("maker");
    });
  });
});

describe("cleanupPriorStartupAdoptionArtifacts — orphan-loop guard", () => {
  const connections: Array<ReturnType<typeof bootstrapLedgerDb>> = [];

  afterEach(() => {
    while (connections.length > 0) {
      connections.pop()!.close();
    }
  });

  type LedgerDb = ReturnType<typeof bootstrapLedgerDb>["db"];

  function makeDeps(db: LedgerDb): Parameters<typeof cleanupPriorStartupAdoptionArtifacts>[0] {
    return { db, log: silentLog } as unknown as Parameters<
      typeof cleanupPriorStartupAdoptionArtifacts
    >[0];
  }

  function rowExists(db: LedgerDb, table: string, column: string, value: string): boolean {
    return db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(value) !== undefined;
  }

  function insertSyntheticOrder(db: LedgerDb, token: string, orderId: string): void {
    db.prepare(
      `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type,
          price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
       VALUES (?, ?, ?, 'cond-1', 'sell', 'GTC', 0.023, 7.43, 0.17089, 'filled',
               'startup-adoption', 'run-1', '2026-06-05T03:48:51Z', '2026-06-05T03:48:51Z')`,
    ).run(orderId, `coid-${orderId}`, token);
  }

  function seedSyntheticArtifact(
    db: LedgerDb,
    opts: {
      token: string;
      orderId: string;
      fillId: string;
      positionId: string;
      lotId: string;
      reconciled: 0 | 1;
      withLegStateTransition: boolean;
    },
  ): void {
    insertSyntheticOrder(db, opts.token, opts.orderId);
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, status, opened_at, updated_at)
       VALUES (?, ?, 'cond-1', 'buy', 7.43, 0.006, 0.04458, 'open',
               '2026-06-05T03:48:51Z', '2026-06-05T03:48:51Z')`,
    ).run(opts.positionId, opts.token);
    db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
          liquidity_role, reconciled, filled_at)
       VALUES (?, ?, ?, 'cond-1', 'sell', 0.023, 7.43, 0.17089, 'maker', ?,
               '2026-06-05T03:48:51Z')`,
    ).run(opts.fillId, opts.orderId, opts.token, opts.reconciled);
    db.prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
       VALUES (?, ?, ?, 'buy', 7.43, 7.43, 0.006, 0.04458, ?, '2026-06-05T03:48:51Z')`,
    ).run(opts.lotId, opts.positionId, opts.token, opts.fillId);
    if (opts.withLegStateTransition) {
      db.prepare(
        `INSERT INTO leg_state_transitions
           (token_id, position_id, fill_id, order_id, from_phase, to_phase, action,
            from_buy_count, from_sell_count, to_buy_count, to_sell_count, reason, occurred_at)
         VALUES (?, ?, ?, ?, 'S2', 'S2', 'SELL', 1, 3, 1, 4, 'orphan-reconciled', '2026-06-05T03:48:51Z')`,
      ).run(opts.token, opts.positionId, opts.fillId, opts.orderId);
    }
  }

  it("preserves a reconciled orphan adoption order already reflected in leg state (loop fix → NOT re-adopted)", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    seedSyntheticArtifact(conn.db, {
      token: "tok-loop",
      orderId: "ord-loop",
      fillId: "fill-loop",
      positionId: "pos-loop",
      lotId: "lot-loop",
      reconciled: 1,
      withLegStateTransition: true,
    });

    const result = cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db));

    expect(result.orderIds).toEqual([]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-loop")).toBe(true);
    expect(rowExists(conn.db, "fills", "fill_id", "fill-loop")).toBe(true);
    expect(rowExists(conn.db, "inventory_lots", "lot_id", "lot-loop")).toBe(true);
    expect(rowExists(conn.db, "positions", "position_id", "pos-loop")).toBe(true);
  });

  it("removes an unreconciled orphan adoption order, and one with no fill (backward compat → existing behavior)", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    // (a) reconciled = 0 even though it has a leg-state transition → still removed.
    seedSyntheticArtifact(conn.db, {
      token: "tok-bw",
      orderId: "ord-bw",
      fillId: "fill-bw",
      positionId: "pos-bw",
      lotId: "lot-bw",
      reconciled: 0,
      withLegStateTransition: true,
    });
    // (b) a synthetic order with no fill at all → guard sees a null fill id and
    //     stays out of the way; existing behavior removes it.
    insertSyntheticOrder(conn.db, "tok-nofill", "ord-nofill");

    const result = cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db));

    expect(result.orderIds.sort()).toEqual(["ord-bw", "ord-nofill"]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-bw")).toBe(false);
    expect(rowExists(conn.db, "fills", "fill_id", "fill-bw")).toBe(false);
    expect(rowExists(conn.db, "inventory_lots", "lot_id", "lot-bw")).toBe(false);
    expect(rowExists(conn.db, "orders", "order_id", "ord-nofill")).toBe(false);
  });

  it("removes a reconciled orphan adoption order that is not reflected in leg state (missing leg-state entry → removal)", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    seedSyntheticArtifact(conn.db, {
      token: "tok-noleg",
      orderId: "ord-noleg",
      fillId: "fill-noleg",
      positionId: "pos-noleg",
      lotId: "lot-noleg",
      reconciled: 1,
      withLegStateTransition: false,
    });

    const result = cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db));

    expect(result.orderIds).toEqual(["ord-noleg"]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-noleg")).toBe(false);
    expect(rowExists(conn.db, "fills", "fill_id", "fill-noleg")).toBe(false);
    expect(rowExists(conn.db, "inventory_lots", "lot_id", "lot-noleg")).toBe(false);
  });

  it("is safe and removes nothing when there are no startup-adoption artifacts (fill not found)", () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);
    // A non-synthetic order — outside the cleanup's signal_reason scope.
    conn.db
      .prepare(
        `INSERT INTO orders
           (order_id, client_order_id, token_id, condition_id, side, order_type,
            price, size, size_usdc, status, signal_reason, bot_run_id, created_at, updated_at)
         VALUES ('ord-real', 'coid-real', 'tok-real', 'cond-1', 'buy', 'GTC', 0.4, 10, 4, 'filled',
                 'first_entry', 'run-1', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
      )
      .run();

    let result: ReturnType<typeof cleanupPriorStartupAdoptionArtifacts> | undefined;
    expect(() => {
      result = cleanupPriorStartupAdoptionArtifacts(makeDeps(conn.db));
    }).not.toThrow();

    expect(result?.orderIds).toEqual([]);
    expect(rowExists(conn.db, "orders", "order_id", "ord-real")).toBe(true);
  });
});
