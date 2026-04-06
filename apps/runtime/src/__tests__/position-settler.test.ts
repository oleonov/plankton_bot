import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createFamilyId, createPositionId } from "@plankton/domain";
import type { PositionRepository, InventoryLotRepository, Position } from "@plankton/domain";
import type { DetectedResolution, ResolutionCandidate } from "../modules/resolution/resolution-detector.js";
import { PositionSettler } from "../modules/resolution/position-settler.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const FAM = createFamilyId("fam-1");
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
    familyId: FAM,
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
    familyId: FAM,
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
    findByFamily: vi.fn().mockReturnValue([]),
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

    const posYes = makePosition({ positionId: POS_YES, tokenId: TOK_YES, avgEntryPrice: 0.3, size: 50 });
    const posNo = makePosition({ positionId: POS_NO, tokenId: TOK_NO, avgEntryPrice: 0.7, size: 50 });
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
      candidates: [
        makeCandidate(TOK_YES, "Yes", POS_YES),
        makeCandidate(TOK_NO, "No", POS_NO),
      ],
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

    const posYes = makePosition({ positionId: POS_YES, tokenId: TOK_YES, avgEntryPrice: 0.4, size: 20 });
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
});
