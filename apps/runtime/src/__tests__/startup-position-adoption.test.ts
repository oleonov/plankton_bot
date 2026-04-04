import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapLedgerDb,
  SqliteFamilyStateRepository,
  SqliteFillRepository,
  SqliteInventoryLotRepository,
  SqliteMarketRepository,
  SqliteOrderRepository,
  SqlitePositionRepository,
} from "@plankton/db";
import {
  createBotRunId,
  createFamilyId,
  createTokenId,
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
    tickSize: 0.01,
    negRisk: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function seedFamilyState(repo: SqliteFamilyStateRepository): void {
  repo.save({
    familyId: FAMILY_ID,
    runtimeMode: "active",
    openValueUsdc: 0,
    openPositionCount: 0,
    openDustCount: 0,
    activeMarketCount: 0,
    currentTailCostUsdc: 0,
    tailAdjustedPnlLive: 0,
    lastEntryTs: null,
    lastExitTs: null,
    quarantineReason: null,
    effectiveMode: null,
    derivedModeReason: null,
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

  it("is idempotent across repeated startups", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
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
      familyStateRepo,
      rulesProvider: createRulesProvider(),
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-2"),
    });

    expect(first.appliedFills).toBe(1);
    expect(second.appliedFills).toBe(0);
    expect(second.alreadyKnownFills).toBe(1);
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
});
