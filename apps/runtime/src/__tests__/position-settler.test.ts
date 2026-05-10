import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createPositionId } from "@krabs/domain";
import type {
  PositionRepository,
  InventoryLotRepository,
  MarketRepository,
  Market,
  Position,
  TokenId,
} from "@krabs/domain";
import type {
  DetectedResolution,
  ResolutionCandidate,
} from "../modules/resolution/resolution-detector.js";
import { PositionSettler } from "../modules/resolution/position-settler.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const TOK_UP = createTokenId("tok-up");
const TOK_DOWN = createTokenId("tok-down");
const POS_UP = createPositionId("pos-up");
const POS_DOWN = createPositionId("pos-down");
const CONDITION = "condition-abc";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: POS_UP,
    tokenId: TOK_UP,
    status: "open",
    side: "buy",
    size: 100,
    avgEntryPrice: 0.2,
    costBasisUsdc: 20,
    currentValueUsdc: 20,
    realizedPnl: 0,
    entryStyle: null,
    buyCount: 1,
    closedAt: null,
    createdAt: "2025-12-01T00:00:00Z",
    updatedAt: "2025-12-01T00:00:00Z",
    ...overrides,
  } as Position;
}

function makeCandidate(
  tokenId: ReturnType<typeof createTokenId>,
  outcome: string,
  positionId: ReturnType<typeof createPositionId>,
): ResolutionCandidate {
  return {
    tokenId,
    conditionId: CONDITION,
    slug: "some-market",
    outcome,
    endDate: "2026-01-01T00:00:00Z",
    positionId,
  };
}

function makeResolution(overrides?: Partial<DetectedResolution>): DetectedResolution {
  return {
    conditionId: CONDITION,
    resolution: "Up",
    winnerTokenId: TOK_UP,
    resolvedAt: "2026-01-01T01:00:00Z",
    source: "gamma-api",
    rawResponse: "{}",
    candidates: [makeCandidate(TOK_UP, "Up", POS_UP), makeCandidate(TOK_DOWN, "Down", POS_DOWN)],
    ...overrides,
  };
}

function createMockDb() {
  return {
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => {
      // Immediately execute the transaction function
      return () => fn();
    }),
    prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
  };
}

function createMockPositionRepo(positionMap: Map<string, Position>): PositionRepository {
  return {
    findByTokenId: vi.fn((tokenId) => positionMap.get(String(tokenId)) ?? null),
    save: vi.fn(),
    findOpen: vi.fn().mockReturnValue([]),
    findDust: vi.fn().mockReturnValue([]),
    findAll: vi.fn().mockReturnValue([]),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
  } as unknown as PositionRepository;
}

function createMockLotRepo(): InventoryLotRepository {
  return {
    settleAll: vi.fn(),
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockReturnValue([]),
    consumeFifo: vi.fn().mockReturnValue([]),
  } as unknown as InventoryLotRepository;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PositionSettler", () => {
  let lotRepo: ReturnType<typeof createMockLotRepo>;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    lotRepo = createMockLotRepo();
    db = createMockDb();
  });

  it("settles Up as winner and Down as loser for non-binary market", () => {
    const posUp = makePosition({
      positionId: POS_UP,
      tokenId: TOK_UP,
      avgEntryPrice: 0.18,
      size: 82.16,
    });
    const posDown = makePosition({
      positionId: POS_DOWN,
      tokenId: TOK_DOWN,
      avgEntryPrice: 0.82,
      size: 10,
    });
    const positionMap = new Map([
      ["tok-up", posUp],
      ["tok-down", posDown],
    ]);
    const positionRepo = createMockPositionRepo(positionMap);
    const settler = new PositionSettler(positionRepo, lotRepo, db as any);

    const resolution = makeResolution({ winnerTokenId: TOK_UP });
    const results = settler.settle(resolution);

    expect(results).toHaveLength(2);

    const upResult = results.find((r) => String(r.tokenId) === "tok-up")!;
    const downResult = results.find((r) => String(r.tokenId) === "tok-down")!;

    expect(upResult.settlementPrice).toBe(1.0);
    expect(downResult.settlementPrice).toBe(0.0);

    // Up PnL: (1.0 - 0.18) * 82.16 ≈ +67.37
    expect(upResult.realizedPnl).toBeCloseTo(67.37, 1);
    // Down PnL: (0.0 - 0.82) * 10 = -8.20
    expect(downResult.realizedPnl).toBeCloseTo(-8.2, 5);
  });

  it("still settles binary Yes/No correctly — regression", () => {
    const TOK_YES = createTokenId("tok-yes");
    const TOK_NO = createTokenId("tok-no");
    const POS_YES = createPositionId("pos-yes");
    const POS_NO = createPositionId("pos-no");

    const posYes = makePosition({
      positionId: POS_YES,
      tokenId: TOK_YES,
      avgEntryPrice: 0.3,
      size: 50,
    });
    const posNo = makePosition({
      positionId: POS_NO,
      tokenId: TOK_NO,
      avgEntryPrice: 0.7,
      size: 50,
    });
    const positionMap = new Map([
      ["tok-yes", posYes],
      ["tok-no", posNo],
    ]);
    const positionRepo = createMockPositionRepo(positionMap);
    const settler = new PositionSettler(positionRepo, lotRepo, db as any);

    const resolution: DetectedResolution = {
      conditionId: CONDITION,
      resolution: "Yes",
      winnerTokenId: TOK_YES,
      resolvedAt: "2026-01-01T01:00:00Z",
      source: "gamma-api",
      rawResponse: "{}",
      candidates: [makeCandidate(TOK_YES, "Yes", POS_YES), makeCandidate(TOK_NO, "No", POS_NO)],
    };

    const results = settler.settle(resolution);

    expect(results).toHaveLength(2);
    const yesResult = results.find((r) => String(r.tokenId) === "tok-yes")!;
    const noResult = results.find((r) => String(r.tokenId) === "tok-no")!;

    expect(yesResult.settlementPrice).toBe(1.0);
    expect(noResult.settlementPrice).toBe(0.0);
  });

  it("falls back to outcome string match when winnerTokenId is null", () => {
    const TOK_YES = createTokenId("tok-yes-b");
    const POS_YES = createPositionId("pos-yes-b");

    const posYes = makePosition({
      positionId: POS_YES,
      tokenId: TOK_YES,
      avgEntryPrice: 0.4,
      size: 20,
    });
    const positionMap = new Map([["tok-yes-b", posYes]]);
    const positionRepo = createMockPositionRepo(positionMap);
    const settler = new PositionSettler(positionRepo, lotRepo, db as any);

    const resolution: DetectedResolution = {
      conditionId: CONDITION,
      resolution: "Yes",
      winnerTokenId: null,
      resolvedAt: "2026-01-01T01:00:00Z",
      source: "gamma-delisted",
      rawResponse: null,
      candidates: [makeCandidate(TOK_YES, "Yes", POS_YES)],
    };

    const results = settler.settle(resolution);

    expect(results).toHaveLength(1);
    expect(results[0]!.settlementPrice).toBe(1.0);
    // PnL: (1.0 - 0.4) * 20 = 12
    expect(results[0]!.realizedPnl).toBeCloseTo(12.0, 5);
  });

  describe("settleAlgoRedeem", () => {
    function makeMarket(
      tokenId: TokenId,
      conditionId: string,
      overrides: Partial<Market> = {},
    ): Market {
      return {
        tokenId,
        conditionId,
        slug: "some-market",
        outcome: "YES",
        tickSize: 0.01,
        negRisk: false,
        gammaCreatedAt: null,
        endDate: "2026-01-01T00:00:00Z",
        active: true,
        updatedAt: "2026-01-01T00:00:00Z",
        ...overrides,
      } as unknown as Market;
    }

    function createMockMarketRepo(marketsByCondition: Map<string, Market[]>): MarketRepository {
      return {
        findByConditionId: vi.fn((cid: string) => marketsByCondition.get(cid) ?? []),
        findByTokenId: vi.fn().mockReturnValue(null),
        findByTokenIds: vi.fn().mockReturnValue([]),
        findActive: vi.fn().mockReturnValue([]),
        findAll: vi.fn().mockReturnValue([]),
        deactivate: vi.fn(),
        iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
        iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
        deactivateMissing: vi.fn().mockReturnValue(0),
        findTrackedForPricing: vi.fn().mockReturnValue([]),
        findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
        updateScoresBatch: vi.fn(),
        save: vi.fn(),
      } as unknown as MarketRepository;
    }

    it("throws when constructed without marketRepo", () => {
      const positionRepo = createMockPositionRepo(new Map());
      const settler = new PositionSettler(positionRepo, lotRepo, db as any);
      expect(() => settler.settleAlgoRedeem(["c1"])).toThrow(
        /settleAlgoRedeem requires marketRepo/,
      );
    });

    it("closes open position at price 0 and returns SettledPosition", () => {
      const pos = makePosition({
        positionId: POS_UP,
        tokenId: TOK_UP,
        avgEntryPrice: 0.12,
        size: 50,
        realizedPnl: 1.5,
      });
      const positionMap = new Map([["tok-up", pos]]);
      const positionRepo = createMockPositionRepo(positionMap);
      const marketRepo = createMockMarketRepo(
        new Map([[CONDITION, [makeMarket(TOK_UP, CONDITION)]]]),
      );
      const settler = new PositionSettler(positionRepo, lotRepo, db as any, marketRepo);

      const results = settler.settleAlgoRedeem([CONDITION]);

      expect(results).toHaveLength(1);
      const [r] = results;
      expect(r!.settlementPrice).toBe(0);
      expect(r!.resolution).toBe("algo-redeem");
      expect(r!.size).toBe(50);
      // realized PnL = (0 - 0.12) * 50 = -6
      expect(r!.realizedPnl).toBeCloseTo(-6, 5);
      expect(r!.tokenId).toBe(TOK_UP);

      expect((positionRepo.save as any).mock.calls.length).toBe(1);
      const saved = (positionRepo.save as any).mock.calls[0][0] as Position;
      expect(saved.status).toBe("closed");
      expect(saved.size).toBe(0);
      expect(saved.currentValueUsdc).toBe(0);
      // realized PnL accumulates prior + settlement delta
      expect(saved.realizedPnl).toBeCloseTo(1.5 + -6, 5);
      expect((lotRepo.settleAll as any).mock.calls.length).toBe(1);
    });

    it("does not algo-redeem positions before market endDate", () => {
      const pos = makePosition({
        positionId: POS_UP,
        tokenId: TOK_UP,
        avgEntryPrice: 0.027,
        size: 67.28,
        realizedPnl: 0,
      });
      const positionMap = new Map([["tok-up", pos]]);
      const positionRepo = createMockPositionRepo(positionMap);
      const marketRepo = createMockMarketRepo(
        new Map([
          [
            CONDITION,
            [
              makeMarket(TOK_UP, CONDITION, {
                endDate: new Date(Date.now() + 86_400_000).toISOString(),
              }),
            ],
          ],
        ]),
      );
      const settler = new PositionSettler(positionRepo, lotRepo, db as any, marketRepo);

      const results = settler.settleAlgoRedeem([CONDITION]);

      expect(results).toHaveLength(0);
      expect((positionRepo.save as any).mock.calls.length).toBe(0);
      expect((lotRepo.settleAll as any).mock.calls.length).toBe(0);
    });

    it("skips closed positions idempotently", () => {
      const closedPos = makePosition({
        positionId: POS_UP,
        tokenId: TOK_UP,
        status: "closed",
        size: 0,
      });
      const positionMap = new Map([["tok-up", closedPos]]);
      const positionRepo = createMockPositionRepo(positionMap);
      const marketRepo = createMockMarketRepo(
        new Map([[CONDITION, [makeMarket(TOK_UP, CONDITION)]]]),
      );
      const settler = new PositionSettler(positionRepo, lotRepo, db as any, marketRepo);

      const results = settler.settleAlgoRedeem([CONDITION]);

      expect(results).toHaveLength(0);
      expect((positionRepo.save as any).mock.calls.length).toBe(0);
      expect((lotRepo.settleAll as any).mock.calls.length).toBe(0);
    });

    it("skips conditions with no markets or no open positions", () => {
      const positionRepo = createMockPositionRepo(new Map());
      const marketRepo = createMockMarketRepo(new Map());
      const settler = new PositionSettler(positionRepo, lotRepo, db as any, marketRepo);

      const results = settler.settleAlgoRedeem(["unknown-condition"]);

      expect(results).toHaveLength(0);
    });
  });

  it("matches outcome labels case-insensitively when winnerTokenId is null", () => {
    const TOK_UP_CASE = createTokenId("tok-up-case");
    const POS_UP_CASE = createPositionId("pos-up-case");

    const posUp = makePosition({
      positionId: POS_UP_CASE,
      tokenId: TOK_UP_CASE,
      avgEntryPrice: 0.25,
      size: 10,
    });
    const positionMap = new Map([["tok-up-case", posUp]]);
    const positionRepo = createMockPositionRepo(positionMap);
    const settler = new PositionSettler(positionRepo, lotRepo, db as any);

    const resolution: DetectedResolution = {
      conditionId: CONDITION,
      resolution: "up",
      winnerTokenId: null,
      resolvedAt: "2026-01-01T01:00:00Z",
      source: "gamma-delisted",
      rawResponse: null,
      candidates: [makeCandidate(TOK_UP_CASE, " Up ", POS_UP_CASE)],
    };

    const results = settler.settle(resolution);

    expect(results).toHaveLength(1);
    expect(results[0]!.settlementPrice).toBe(1.0);
    expect(results[0]!.realizedPnl).toBeCloseTo(7.5, 5);
  });
});
