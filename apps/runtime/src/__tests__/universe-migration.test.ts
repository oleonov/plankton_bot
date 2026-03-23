import { describe, it, expect, vi } from "vitest";
import type {
  PositionRepository,
  MarketRepository,
  FamilyStateRepository,
  FamilyIdentity,
  FamilyState,
  Position,
  Market,
  FamilyId,
  TokenId,
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

function makeFamilyState(overrides?: Partial<FamilyState>): FamilyState {
  return {
    familyId: createFamilyId("fam-btc"),
    runtimeMode: "active",
    openValueUsdc: 75,
    openPositionCount: 10,
    openDustCount: 0,
    activeMarketCount: 10,
    currentTailCostUsdc: 0,
    tailAdjustedPnlLive: 0,
    lastEntryTs: null,
    lastExitTs: null,
    quarantineReason: null,
    updatedAt: "2026-03-14T00:00:00Z",
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("migrateOrphanedPositions", () => {
  it("closes positions whose market slug no longer matches family pattern", () => {
    const oldPosition = makePosition({
      tokenId: createTokenId("tok-old"),
    });
    const oldMarket = makeMarket({
      tokenId: createTokenId("tok-old"),
      slug: "will-bitcoin-reach-190000-by-december-31-2026",
    });

    const saved: Position[] = [];
    const findByFamilyCalls: number[] = [];
    const positionRepo: PositionRepository = {
      save: vi.fn((p: Position) => { saved.push(p); }),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockImplementation(() => {
        findByFamilyCalls.push(1);
        // First call returns the orphan, second call (recompute) returns empty
        return findByFamilyCalls.length === 1 ? [oldPosition] : [];
      }),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
    };
    const marketRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(oldMarket),
      findByTokenIds: vi.fn().mockReturnValue([]),
      findByConditionId: vi.fn().mockReturnValue([]),
      findActive: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      deactivate: vi.fn(),
    } satisfies MarketRepository;
    const familyStateRepo = {
      get: vi.fn().mockReturnValue(makeFamilyState()),
      save: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      findByMode: vi.fn().mockReturnValue([]),
      findQuarantined: vi.fn().mockReturnValue([]),
    } satisfies FamilyStateRepository;

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo,
      familyStateRepo,
      families: [makeFamily({ slugPattern: "bitcoin-above-*" })],
      log: silentLog,
    });

    expect(result.closedCount).toBe(1);
    expect(saved[0]!.status).toBe("closed");
    expect(saved[0]!.closedAt).toBeTruthy();
    // Family state should be recomputed with zeroed caps
    expect(familyStateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ openValueUsdc: 0, openPositionCount: 0 }),
    );
  });

  it("closes positions whose market has long-dated endDate for daily horizon", () => {
    const longEndDate = new Date(Date.now() + 270 * 24 * 60 * 60 * 1000).toISOString();
    const pos = makePosition();
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
    };
    const marketRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(market),
      findByTokenIds: vi.fn().mockReturnValue([]),
      findByConditionId: vi.fn().mockReturnValue([]),
      findActive: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      deactivate: vi.fn(),
    } satisfies MarketRepository;
    const familyStateRepo = {
      get: vi.fn().mockReturnValue(makeFamilyState()),
      save: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      findByMode: vi.fn().mockReturnValue([]),
      findQuarantined: vi.fn().mockReturnValue([]),
    } satisfies FamilyStateRepository;

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo,
      familyStateRepo,
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
    };
    const marketRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(market),
      findByTokenIds: vi.fn().mockReturnValue([]),
      findByConditionId: vi.fn().mockReturnValue([]),
      findActive: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      deactivate: vi.fn(),
    } satisfies MarketRepository;
    const familyStateRepo = {
      get: vi.fn().mockReturnValue(makeFamilyState()),
      save: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      findByMode: vi.fn().mockReturnValue([]),
      findQuarantined: vi.fn().mockReturnValue([]),
    } satisfies FamilyStateRepository;

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo,
      familyStateRepo,
      families: [makeFamily()],
      log: silentLog,
    });

    expect(result.closedCount).toBe(0);
    expect(positionRepo.save).not.toHaveBeenCalled();
  });

  it("closes positions when market not found in DB", () => {
    const pos = makePosition();

    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockReturnValue([pos]),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
    };
    const marketRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null), // market not found
      findByTokenIds: vi.fn().mockReturnValue([]),
      findByConditionId: vi.fn().mockReturnValue([]),
      findActive: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      deactivate: vi.fn(),
    } satisfies MarketRepository;
    const familyStateRepo = {
      get: vi.fn().mockReturnValue(makeFamilyState()),
      save: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      findByMode: vi.fn().mockReturnValue([]),
      findQuarantined: vi.fn().mockReturnValue([]),
    } satisfies FamilyStateRepository;

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo,
      familyStateRepo,
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
    };
    const marketRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByTokenIds: vi.fn().mockReturnValue([]),
      findByConditionId: vi.fn().mockReturnValue([]),
      findActive: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      deactivate: vi.fn(),
    } satisfies MarketRepository;
    const familyStateRepo = {
      get: vi.fn().mockReturnValue(null),
      save: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      findByMode: vi.fn().mockReturnValue([]),
      findQuarantined: vi.fn().mockReturnValue([]),
    } satisfies FamilyStateRepository;

    const result = migrateOrphanedPositions({
      positionRepo,
      marketRepo,
      familyStateRepo,
      families: [makeFamily()],
      log: silentLog,
    });

    expect(result.closedCount).toBe(0);
  });

  it("recomputes family state after closing orphans", () => {
    // Two positions: one orphaned, one valid
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const orphan = makePosition({ positionId: createPositionId("pos-orphan"), tokenId: createTokenId("tok-orphan") });
    const valid = makePosition({ positionId: createPositionId("pos-valid"), tokenId: createTokenId("tok-valid"), costBasisUsdc: 5 });

    const orphanMarket = makeMarket({ tokenId: createTokenId("tok-orphan"), slug: "will-bitcoin-reach-200k-by-december" });
    const validMarket = makeMarket({ tokenId: createTokenId("tok-valid"), slug: "bitcoin-above-100k", endDate: tomorrow.toISOString() });

    // After closing orphan, findByFamily returns only valid
    const findByFamilyCalls: number[] = [];
    const positionRepo: PositionRepository = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockReturnValue(null),
      findByFamily: vi.fn().mockImplementation(() => {
        findByFamilyCalls.push(1);
        // First call returns both, second call (recompute) returns only valid
        return findByFamilyCalls.length === 1 ? [orphan, valid] : [valid];
      }),
      findOpen: vi.fn().mockReturnValue([]),
      findDust: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
    };
    const marketRepo = {
      save: vi.fn(),
      findByTokenId: vi.fn().mockImplementation((tid: TokenId) =>
        String(tid) === "tok-orphan" ? orphanMarket : validMarket,
      ),
      findByTokenIds: vi.fn().mockReturnValue([]),
      findByConditionId: vi.fn().mockReturnValue([]),
      findActive: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      findAll: vi.fn().mockReturnValue([]),
      deactivate: vi.fn(),
    } satisfies MarketRepository;

    const savedStates: FamilyState[] = [];
    const familyStateRepo = {
      get: vi.fn().mockReturnValue(makeFamilyState()),
      save: vi.fn((s: FamilyState) => { savedStates.push(s); }),
      findAll: vi.fn().mockReturnValue([]),
      findByMode: vi.fn().mockReturnValue([]),
      findQuarantined: vi.fn().mockReturnValue([]),
    } satisfies FamilyStateRepository;

    migrateOrphanedPositions({
      positionRepo,
      marketRepo,
      familyStateRepo,
      families: [makeFamily()],
      log: silentLog,
    });

    // State should reflect only the remaining valid position
    expect(savedStates.length).toBe(1);
    expect(savedStates[0]!.openValueUsdc).toBe(5);
    expect(savedStates[0]!.openPositionCount).toBe(1);
    expect(savedStates[0]!.activeMarketCount).toBe(1);
  });
});
