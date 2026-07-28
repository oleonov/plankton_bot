import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createPositionId } from "@krabs/domain";
import type {
  PositionRepository,
  MarketRepository,
  MarketResolutionRepository,
  Position,
} from "@krabs/domain";
import type { GammaResolutionClient, GammaMarketInfo } from "@krabs/exchange";
import { ResolutionDetector } from "../modules/resolution/resolution-detector.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const TOK_YES = createTokenId("tok-yes");
const POS = createPositionId("pos-1");
const CONDITION = "condition-abc";
const SLUG = "will-x-happen";
const PAST_END_DATE = "2026-01-01T00:00:00Z"; // well in the past

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function makePosition(overrides?: Partial<Position>): Position {
  return {
    positionId: POS,
    tokenId: TOK_YES,
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

function makeMarket(overrides?: Record<string, unknown>) {
  return {
    tokenId: TOK_YES,
    conditionId: CONDITION,
    slug: SLUG,
    outcome: "YES",
    endDate: PAST_END_DATE,
    active: true,
    ...overrides,
  };
}

function makeGammaInfo(overrides?: Partial<GammaMarketInfo>): GammaMarketInfo {
  return {
    conditionId: CONDITION,
    slug: SLUG,
    closed: true,
    closedTime: "2026-01-01T01:00:00Z",
    umaResolutionStatus: "resolved",
    endDate: PAST_END_DATE,
    rawPayload: {
      tokens: [
        { outcome: "Yes", winner: true },
        { outcome: "No", winner: false },
      ],
    },
    ...overrides,
  };
}

function createMockPositionRepo(): PositionRepository {
  return {
    findOpen: vi.fn().mockReturnValue([makePosition()]),
    findDust: vi.fn().mockReturnValue([]),
    findById: vi.fn(() => null),
    findActiveByTokenId: vi.fn(() => []),
    findByTokenId: vi.fn(),
    save: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
  } as unknown as PositionRepository;
}

function createMockMarketRepo(): MarketRepository {
  return {
    findByTokenIds: vi.fn().mockReturnValue([makeMarket()]),
    deactivate: vi.fn(),
    iterateActiveTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    iterateAllTokenIds: vi.fn().mockReturnValue([][Symbol.iterator]()),
    deactivateMissing: vi.fn().mockReturnValue(0),
    findTrackedForPricing: vi.fn().mockReturnValue([]),
    findEventMarketCountBySlug: vi.fn().mockReturnValue(null),
    updateScoresBatch: vi.fn(),
  } as unknown as MarketRepository;
}

function createMockResolutionRepo(): MarketResolutionRepository {
  return {
    save: vi.fn(),
    findByConditionId: vi.fn().mockReturnValue(null),
    findAll: vi.fn().mockReturnValue([]),
    markSettled: vi.fn(),
  } as unknown as MarketResolutionRepository;
}

function createMockGammaClient(): GammaResolutionClient {
  return {
    getMarketBySlug: vi.fn<(slug: string) => Promise<GammaMarketInfo | null>>(),
    getMarketById: vi.fn<(id: string) => Promise<GammaMarketInfo | null>>(),
  } as unknown as GammaResolutionClient;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ResolutionDetector", () => {
  let positionRepo: ReturnType<typeof createMockPositionRepo>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let resolutionRepo: ReturnType<typeof createMockResolutionRepo>;
  let gammaClient: ReturnType<typeof createMockGammaClient>;
  let detector: ResolutionDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    positionRepo = createMockPositionRepo();
    marketRepo = createMockMarketRepo();
    resolutionRepo = createMockResolutionRepo();
    gammaClient = createMockGammaClient();
    detector = new ResolutionDetector(
      positionRepo as unknown as PositionRepository,
      marketRepo as unknown as MarketRepository,
      resolutionRepo as unknown as MarketResolutionRepository,
      gammaClient as unknown as GammaResolutionClient,
      log as any,
    );
  });

  // ─── Slug miss + ID hit ─────────────────────────────────────────────────

  it("falls back to getMarketById when slug returns null", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(null);
    (gammaClient.getMarketById as any).mockResolvedValue(makeGammaInfo());

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("gamma-api");
    expect(results[0]!.resolution).toBe("Yes");
    expect(results[0]!.winnerTokenId).toBeNull();
    expect(gammaClient.getMarketById as any).toHaveBeenCalledWith(CONDITION);
  });

  it("returns gamma-api source when ID lookup finds closed market", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(null);
    (gammaClient.getMarketById as any).mockResolvedValue(makeGammaInfo({ closed: true }));

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("gamma-api");
  });

  it("skips when ID lookup finds open market", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(null);
    (gammaClient.getMarketById as any).mockResolvedValue(makeGammaInfo({ closed: false }));

    const results = await detector.detect(0);
    expect(results).toHaveLength(0);
  });

  // ─── Transient Gamma errors → no settlement ────────────────────────────

  it("skips market when slug lookup throws transport error", async () => {
    (gammaClient.getMarketBySlug as any).mockRejectedValue(new Error("ECONNRESET"));

    const results = await detector.detect(0);

    expect(results).toHaveLength(0);
    expect(gammaClient.getMarketById as any).not.toHaveBeenCalled();
  });

  it("skips market when slug returns null but ID lookup throws", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(null);
    (gammaClient.getMarketById as any).mockRejectedValue(new Error("socket hang up"));

    const results = await detector.detect(0);

    expect(results).toHaveLength(0);
  });

  // ─── Real delisted market → unknown resolution ─────────────────────────

  it("marks as gamma-delisted only when both lookups return null", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(null);
    (gammaClient.getMarketById as any).mockResolvedValue(null);

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.source).toBe("gamma-delisted");
    expect(results[0]!.resolution).toBe("unknown");
    expect(results[0]!.winnerTokenId).toBeNull();
  });

  // ─── Normal resolution flow ─────────────────────────────────────────────

  it("detects resolved market via Gamma slug lookup", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(makeGammaInfo());

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("Yes");
    expect(results[0]!.winnerTokenId).toBeNull();
    expect(results[0]!.source).toBe("gamma-api");
    expect(results[0]!.conditionId).toBe(CONDITION);
  });

  it("skips market not yet closed on Gamma", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(makeGammaInfo({ closed: false }));

    const results = await detector.detect(0);
    expect(results).toHaveLength(0);
  });

  it("skips settled conditionId", async () => {
    (resolutionRepo.findByConditionId as any).mockReturnValue({
      conditionId: CONDITION,
      status: "settled",
    });

    const results = await detector.detect(0);

    expect(results).toHaveLength(0);
    expect(gammaClient.getMarketBySlug as any).not.toHaveBeenCalled();
  });

  it("returns detected (non-settled) conditionId for retry", async () => {
    (resolutionRepo.findByConditionId as any).mockReturnValue({
      conditionId: CONDITION,
      status: "detected",
    });
    (gammaClient.getMarketBySlug as any).mockResolvedValue(makeGammaInfo());

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.conditionId).toBe(CONDITION);
  });

  it("includes dust positions in detection", async () => {
    (positionRepo.findOpen as any).mockReturnValue([]);
    (positionRepo.findDust as any).mockReturnValue([makePosition({ status: "dust" as any })]);
    (gammaClient.getMarketBySlug as any).mockResolvedValue(makeGammaInfo());

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.candidates).toHaveLength(1);
  });

  it("respects grace period", async () => {
    // Market ended 10 minutes ago, grace is 30 minutes → should be skipped
    const recentEnd = new Date(Date.now() - 10 * 60_000).toISOString();
    (marketRepo.findByTokenIds as any).mockReturnValue([makeMarket({ endDate: recentEnd })]);

    const results = await detector.detect(30);

    expect(results).toHaveLength(0);
  });

  // ─── Resolution inference from outcomePrices ────────────────────────

  it("infers Yes resolution from outcomePrices field", async () => {
    // Gamma /markets/slug/ returns outcomes and outcomePrices as stringified arrays
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        rawPayload: {
          outcomes: '["Yes", "No"]',
          outcomePrices: '["1", "0"]',
        },
      }),
    );

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("Yes");
    expect(results[0]!.winnerTokenId).toBeNull();
  });

  it("infers No resolution from outcomePrices field", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        rawPayload: {
          outcomes: '["Yes", "No"]',
          outcomePrices: '["0", "1"]',
        },
      }),
    );

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("No");
    expect(results[0]!.winnerTokenId).toBeNull();
  });

  it("returns unknown when outcomePrices has no winner (no price=1)", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        umaResolutionStatus: null,
        rawPayload: {
          outcomes: '["Yes", "No"]',
          outcomePrices: '["0.5", "0.5"]',
        },
      }),
    );

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("unknown");
    expect(results[0]!.winnerTokenId).toBeNull();
  });

  it("prefers tokens.winner over outcomePrices when both present", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        rawPayload: {
          tokens: [
            { outcome: "Yes", winner: true },
            { outcome: "No", winner: false },
          ],
          outcomes: '["Yes", "No"]',
          outcomePrices: '["0", "1"]', // says NO won
        },
      }),
    );

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("Yes"); // tokens.winner takes priority
    expect(results[0]!.winnerTokenId).toBeNull();
  });

  it("handles numeric outcomePrices (non-stringified JSON array)", async () => {
    // Gamma sometimes returns outcomePrices as "[1,0]" where values parse to numbers, not strings
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        rawPayload: {
          outcomes: '["Yes", "No"]',
          outcomePrices: "[1, 0]",
        },
      }),
    );

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("Yes");
    expect(results[0]!.winnerTokenId).toBeNull();
  });

  // ─── Non-binary outcome resolution ──────────────────────────────────

  it("infers Up winner from tokens[].winner flag", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        rawPayload: {
          tokens: [
            { outcome: "Up", winner: true },
            { outcome: "Down", winner: false },
          ],
          clobTokenIds: '["tok-up", "tok-down"]',
        },
      }),
    );

    const results = await detector.detect(0);
    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("Up");
    expect(String(results[0]!.winnerTokenId)).toBe("tok-up");
  });

  it("uses tokens[].token_id as winnerTokenId when clobTokenIds are absent", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        rawPayload: {
          tokens: [
            { token_id: "tok-up-direct", outcome: "Up", winner: true },
            { token_id: "tok-down-direct", outcome: "Down", winner: false },
          ],
        },
      }),
    );

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("Up");
    expect(String(results[0]!.winnerTokenId)).toBe("tok-up-direct");
  });

  it("falls back to outcomes[] when winner token row lacks an outcome label", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        rawPayload: {
          tokens: [
            { token_id: "tok-up-direct", winner: true },
            { token_id: "tok-down-direct", outcome: "Down", winner: false },
          ],
          outcomes: '["Up", "Down"]',
        },
      }),
    );

    const results = await detector.detect(0);

    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("Up");
    expect(String(results[0]!.winnerTokenId)).toBe("tok-up-direct");
  });

  it("infers Down winner from outcomePrices", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        rawPayload: {
          outcomes: '["Up", "Down"]',
          outcomePrices: '["0", "1"]',
          clobTokenIds: '["tok-up", "tok-down"]',
        },
      }),
    );

    const results = await detector.detect(0);
    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("Down");
    expect(String(results[0]!.winnerTokenId)).toBe("tok-down");
  });

  it("binary Yes/No still works with winnerTokenId — regression", async () => {
    (gammaClient.getMarketBySlug as any).mockResolvedValue(
      makeGammaInfo({
        rawPayload: {
          tokens: [
            { outcome: "Yes", winner: true },
            { outcome: "No", winner: false },
          ],
          clobTokenIds: '["tok-yes", "tok-no"]',
        },
      }),
    );

    const results = await detector.detect(0);
    expect(results).toHaveLength(1);
    expect(results[0]!.resolution).toBe("Yes");
    expect(String(results[0]!.winnerTokenId)).toBe("tok-yes");
  });
});
