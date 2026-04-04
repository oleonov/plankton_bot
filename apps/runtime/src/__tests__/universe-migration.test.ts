import { describe, it, expect, vi } from "vitest";
import type {
  PositionRepository,
  MarketRepository,
  InventoryLotRepository,
  FamilyIdentity,
  Position,
  Market,
  TokenId,
  PositionId,
} from "@plankton/domain";
import { createFamilyId, createTokenId, createPositionId } from "@plankton/domain";
import { migrateOrphanedPositions } from "../universe-migration.js";

// ─── Helpers ───────────────────────────────────────────────────────

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => silentLog,
  fatal: vi.fn(),
} as any;

function makeFamily(overrides?: Partial<FamilyIdentity>): FamilyIdentity {
  return {
    familyId: createFamilyId("fam-btc"),
    familyKey: "bitcoin-above",
    primaryCategory: "crypto-btc",
    regime: "threshold",
    horizon: "daily",
    cadence: "daily",
    strategyProfile: "scalp",
    topicKey: "bitcoin",
    slugPattern: "bitcoin-above-*",
    notes: null,
    ...overrides,
  };
}

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: createPositionId("pos-1"),
    tokenId: createTokenId("tok-1"),
    familyId: createFamilyId("fam-btc"),
    side: "buy",
    size: 100,
    avgEntryPrice: 0.05,
    costBasisUsdc: 5,
    currentValueUsdc: null,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: "2026-03-14T00:00:00Z",
    closedAt: null,
    updatedAt: "2026-03-14T00:00:00Z",
    ...overrides,
  };
}

function makeMarket(overrides?: Partial<Market>): Market {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return {
    tokenId: createTokenId("tok-1"),
    conditionId: "cond-1",
    slug: "bitcoin-above-100k-on-march-16",
    eventSlug: null,
    question: "Bitcoin above 100k?",
    outcome: "YES",
    familyId: createFamilyId("fam-btc"),
    familyKey: "bitcoin-above",
    regime: "threshold",
    horizon: "daily",
    endDate: tomorrow.toISOString(),
    active: true,
    tickSize: 0.01,
    negRisk: false,
    createdAt: "2026-03-14T00:00:00Z",
    updatedAt: "2026-03-14T00:00:00Z",
    ...overrides,
  };
}

function makeLotRepo(openLots: { positionId: string; lots: any[] }[] = []): InventoryLotRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockImplementation((pid: PositionId) => {
      const entry = openLots.find((e) => e.positionId === String(pid));
      return entry ? entry.lots : [];
    }),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
}

function makeMarketRepo(findByTokenId: Market | null = null): MarketRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue(findByTokenId),
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByConditionId: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    findByFamily: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
  } satisfies MarketRepository;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("migrateOrphanedPositions", () => {
  it("closes positions whose market slug no longer matches family pattern", () => {
    const oldPosition = makePosition({
      tokenId: createTokenId("tok-old"),
      size: 0,
    });
    const oldMarket = makeMarket({
      tokenId: createTokenId("tok-old"),
      slug: "will-bitcoin-reach-190000-by-december-31-2026",
    });

    const saved: Position[] = [];
    const positionRepo: PositionRepository = {
      save: vi.fn((p: Position) => {
        saved.push(p);
      }),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockReturnValue([oldPosition]),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    };

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo: makeMarketRepo(oldMarket),
      lotRepo: makeLotRepo(),
      families: [makeFamily({ slugPattern: "bitcoin-above-*" })],
      log: silentLog,
    });

    expect(result.closedCount).toBe(1);
    expect(saved[0]!.status).toBe("closed");
    expect(saved[0]!.closedAt).toBeTruthy();
  });

  it("closes positions whose market has long-dated endDate for daily horizon", () => {
    const longEndDate = new Date(Date.now() + 270 * 24 * 60 * 60 * 1000).toISOString();
    const pos = makePosition({ size: 0 });
    const market = makeMarket({
      slug: "bitcoin-above-190k",
      endDate: longEndDate,
    });

    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockReturnValue([pos]),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    };

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo: makeMarketRepo(market),
      lotRepo: makeLotRepo(),
      families: [makeFamily({ horizon: "daily" })],
      log: silentLog,
    });

    expect(result.closedCount).toBe(1);
  });

  it("keeps positions whose market still matches pattern and horizon", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pos = makePosition();
    const market = makeMarket({
      slug: "bitcoin-above-100k-on-march-16",
      endDate: tomorrow.toISOString(),
    });

    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockReturnValue([pos]),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    };

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo: makeMarketRepo(market),
      lotRepo: makeLotRepo(),
      families: [makeFamily()],
      log: silentLog,
    });

    expect(result.closedCount).toBe(0);
    expect(positionRepo.save).not.toHaveBeenCalled();
  });

  it("closes positions when market not found in DB", () => {
    const pos = makePosition({ size: 0 });

    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockReturnValue([pos]),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    };

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo: makeMarketRepo(null),
      lotRepo: makeLotRepo(),
      families: [makeFamily()],
      log: silentLog,
    });

    expect(result.closedCount).toBe(1);
  });

  it("skips already-closed positions", () => {
    const closedPos = makePosition({ status: "closed" });

    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockReturnValue([closedPos]),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    };

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo: makeMarketRepo(null),
      lotRepo: makeLotRepo(),
      families: [makeFamily()],
      log: silentLog,
    });

    expect(result.closedCount).toBe(0);
  });

  it("returns closedPositionIds for caller to trigger recompute", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const orphan = makePosition({
      positionId: createPositionId("pos-orphan"),
      tokenId: createTokenId("tok-orphan"),
      size: 0,
    });
    const valid = makePosition({
      positionId: createPositionId("pos-valid"),
      tokenId: createTokenId("tok-valid"),
      size: 0,
      costBasisUsdc: 5,
    });

    const orphanMarket = makeMarket({
      tokenId: createTokenId("tok-orphan"),
      slug: "will-bitcoin-reach-200k-by-december",
    });
    const validMarket = makeMarket({
      tokenId: createTokenId("tok-valid"),
      slug: "bitcoin-above-100k",
      endDate: tomorrow.toISOString(),
    });

    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockReturnValue([orphan, valid]),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    };
    const marketRepo = {
      save: vi.fn(),
      findByTokenId: vi
        .fn()
        .mockImplementation((tid: TokenId) =>
          String(tid) === "tok-orphan" ? orphanMarket : validMarket,
        ),
      findByTokenIds: vi.fn().mockReturnValue([]),
      findByConditionId: vi.fn().mockReturnValue([]),
      findActive: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      deactivate: vi.fn(),
    } satisfies MarketRepository;

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo,
      lotRepo: makeLotRepo(),
      families: [makeFamily()],
      log: silentLog,
    });

    // Migration should close the orphan and return its ID for the caller
    // to trigger a full recompute via FamilyExposureCalculator
    expect(result.closedCount).toBe(1);
    expect(result.closedPositionIds).toContain("pos-orphan");
  });

  it("does NOT close position with non-zero size or open inventory lots — logs warning instead", () => {
    const pos = makePosition({
      positionId: createPositionId("pos-with-lots"),
      tokenId: createTokenId("tok-orphan"),
      size: 50,
    });
    const market = makeMarket({
      tokenId: createTokenId("tok-orphan"),
      slug: "will-bitcoin-reach-200k-by-december",
    });

    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockReturnValue([pos]),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    };
    const lotRepo = makeLotRepo([
      {
        positionId: "pos-with-lots",
        lots: [{ lotId: "lot-1", remainingSize: 50 }],
      },
    ]);

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => log,
      fatal: vi.fn(),
    } as any;

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo: makeMarketRepo(market),
      lotRepo,
      families: [makeFamily({ slugPattern: "bitcoin-above-*" })],
      log,
    });

    expect(result.closedCount).toBe(0);
    expect(positionRepo.save).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ positionId: "pos-with-lots" }),
      expect.stringContaining("skipping close"),
    );
  });

  it("does NOT close position with open lots when market not found", () => {
    const pos = makePosition({
      positionId: createPositionId("pos-no-market"),
      size: 25,
    });

    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockReturnValue([pos]),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      findOpenByEntryStyle: vi.fn().mockReturnValue([]),
    };
    const lotRepo = makeLotRepo([
      {
        positionId: "pos-no-market",
        lots: [{ lotId: "lot-1", remainingSize: 25 }],
      },
    ]);

    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: () => log,
      fatal: vi.fn(),
    } as any;

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo: makeMarketRepo(null),
      lotRepo,
      families: [makeFamily()],
      log,
    });

    expect(result.closedCount).toBe(0);
    expect(positionRepo.save).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ positionId: "pos-no-market" }),
      expect.stringContaining("skipping close"),
    );
  });
});
