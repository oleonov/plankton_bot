import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapLedgerDb,
  SqliteFamilyStateRepository,
  SqliteFillRepository,
  SqliteInventoryLotRepository,
  SqliteLegStateRepository,
  SqliteMarketRepository,
  SqliteOrderRepository,
  SqlitePositionRepository,
} from "@plankton/db";
import {
  createBotRunId,
  createConditionId,
  createFamilyId,
  createFillId,
  createLotId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ClientOrderId,
  type ExchangeFill,
  type FamilyRulesProvider,
} from "@plankton/domain";
import { runStartupPositionAdoption } from "../startup-position-adoption.js";

const FAMILY_ID = createFamilyId("fam-btc");
const TOKEN_ID = createTokenId("tok-btc-yes");

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => silentLog,
} as any;

function createRulesProvider(): FamilyRulesProvider {
  return {
    getRule: vi.fn().mockReturnValue({
      identity: { familyId: FAMILY_ID },
      rules: {
        tailSuppression: {
          tailQuarantineThresholdUsdc: 1_000,
          tailQuarantineThresholdRatio: 10,
        },
      },
    }),
    isEnabled: vi.fn().mockReturnValue(true),
    getAllFamilies: vi.fn().mockReturnValue([]),
    getRulesForRegime: vi.fn().mockReturnValue([]),
  } as unknown as FamilyRulesProvider;
}

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
    familyId: FAMILY_ID,
    familyKey: "btc-above",
    regime: "threshold",
    horizon: "daily",
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function seedFamilyState(repo: SqliteFamilyStateRepository): void {
  repo.save({
    familyId: FAMILY_ID,
    openValueUsdc: 0,
    openPositionCount: 0,
    openDustCount: 0,
    activeMarketCount: 0,
    currentTailCostUsdc: 0,
    tailAdjustedPnlLive: 0,
    lastEntryTs: null,
    lastExitTs: null,
    firstNegativeTailAt: null,
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
    const familyStateRepo = new SqliteFamilyStateRepository(conn.db);
    seedMarket(marketRepo);
    seedFamilyState(familyStateRepo);

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
      familyStateRepo,
      rulesProvider: createRulesProvider(),
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

    const familyState = familyStateRepo.get(FAMILY_ID);
    expect(familyState?.openPositionCount).toBe(1);
    expect(familyState?.openValueUsdc).toBe(4);
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
    const familyStateRepo = new SqliteFamilyStateRepository(conn.db);
    seedMarket(marketRepo);
    seedFamilyState(familyStateRepo);

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
      familyStateRepo,
      rulesProvider: createRulesProvider(),
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
      familyStateRepo,
      rulesProvider: createRulesProvider(),
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
    const familyStateRepo = new SqliteFamilyStateRepository(conn.db);
    seedFamilyState(familyStateRepo);

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
      familyStateRepo,
      rulesProvider: createRulesProvider(),
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
    const familyStateRepo = new SqliteFamilyStateRepository(conn.db);
    seedMarket(marketRepo);
    seedFamilyState(familyStateRepo);

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
      familyStateRepo,
      rulesProvider: createRulesProvider(),
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
    const familyStateRepo = new SqliteFamilyStateRepository(conn.db);
    seedMarket(marketRepo);
    seedFamilyState(familyStateRepo);

    orderRepo.save({
      orderId: createOrderId("bad-order"),
      clientOrderId: "adopt-bad" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: createConditionId("cond-1"),
      familyId: FAMILY_ID,
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
      familyId: FAMILY_ID,
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
      familyId: FAMILY_ID,
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
      familyId: FAMILY_ID,
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
      familyStateRepo,
      rulesProvider: createRulesProvider(),
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
        familyId: FAMILY_ID,
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
        familyId: FAMILY_ID,
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
        familyId: FAMILY_ID,
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
      const familyStateRepo = new SqliteFamilyStateRepository(conn.db);
      const result = await runStartupPositionAdoption({
        gateway: { getFills: vi.fn().mockResolvedValue([]) },
        marketRepo,
        orderRepo,
        fillRepo,
        positionRepo,
        inventoryLotRepo,
        legStateRepo,
        familyStateRepo,
        rulesProvider: createRulesProvider(),
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
      seedFill(fillRepo, { fillId: "f-1", side: "buy", price: 0.42, filledAt: "2026-04-01T00:00:00Z" });
      seedFill(fillRepo, { fillId: "f-2", side: "buy", price: 0.11, filledAt: "2026-04-02T00:00:00Z" });
      seedFill(fillRepo, { fillId: "f-3", side: "sell", price: 0.55, filledAt: "2026-04-03T00:00:00Z" });

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

    it("dedups tokens with coexisting open + dust rows (counts fills once)", async () => {
      const conn = bootstrapLedgerDb(":memory:");
      connections.push(conn);
      const { fillRepo, positionRepo } = primeLedger(conn);
      positionRepo.save({
        positionId: createPositionId("pos-dust"),
        tokenId: TOKEN_ID,
        conditionId: createConditionId("cond-1"),
        familyId: FAMILY_ID,
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
});
