import { describe, expect, it, vi } from "vitest";
import {
  createConditionId,
  createPositionId,
  createTokenId,
  type Market,
  type MarketRepository,
  type Position,
  type PositionRepository,
} from "@plankton/domain";
import type { PolymarketDataPosition, PolymarketPositionReader } from "@plankton/exchange";
import { runWalletPositionSentinel } from "../wallet-position-sentinel.js";

const TOKEN = createTokenId("tok-live");
const CONDITION = createConditionId("cond-live");
const NOW = Date.parse("2026-04-25T00:00:00.000Z");

const log = {
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: () => log,
} as any;

function makeRemote(overrides: Partial<PolymarketDataPosition> = {}): PolymarketDataPosition {
  return {
    tokenId: String(TOKEN),
    size: 12,
    currentValueUsdc: 1.23,
    initialValueUsdc: 0.8,
    slug: null,
    marketSlug: null,
    outcome: "Yes",
    raw: {},
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("pos-live"),
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    size: 0,
    avgEntryPrice: 0.1,
    costBasisUsdc: 0,
    currentValueUsdc: 0,
    realizedPnl: -1,
    status: "closed",
    entryStyle: "probe",
    openedAt: "2026-04-24T00:00:00.000Z",
    closedAt: "2026-04-24T01:00:00.000Z",
    updatedAt: "2026-04-24T01:00:00.000Z",
    ...overrides,
  };
}

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    tokenId: TOKEN,
    conditionId: String(CONDITION),
    slug: "live-market",
    eventSlug: "live-event",
    question: "Live market?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: "2026-04-26T00:00:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    ...overrides,
  };
}

function reader(positions: PolymarketDataPosition[] | null): PolymarketPositionReader {
  return { read: vi.fn().mockResolvedValue(positions) };
}

function positionRepo(positions: Position[]): PositionRepository {
  return {
    findAll: vi.fn().mockReturnValue(positions),
  } as unknown as PositionRepository;
}

function marketRepo(market: Market | null): MarketRepository {
  return {
    findByTokenId: vi.fn().mockReturnValue(market),
  } as unknown as MarketRepository;
}

describe("runWalletPositionSentinel", () => {
  it("detects a remote live wallet position that is locally closed before endDate", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote()]),
        positionRepo: positionRepo([makePosition()]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(1);
    expect(result.closedLivePositions[0]!.localStatus).toBe("closed");
    expect(result.closedLivePositions[0]!.remoteSize).toBe(12);
    expect(result.details[0]).toContain("wallet-live-position-closed-locally");
  });

  it("does not flag dust/open local inventory", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote()]),
        positionRepo: positionRepo([makePosition({ status: "dust", size: 12, closedAt: null })]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
  });

  it("does not flag closed positions after market endDate", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote()]),
        positionRepo: positionRepo([makePosition()]),
        marketRepo: marketRepo(makeMarket({ endDate: "2026-04-24T00:00:00.000Z" })),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
  });

  it("fails open on Polymarket read errors", async () => {
    const failingReader: PolymarketPositionReader = {
      read: vi.fn().mockRejectedValue(new Error("network")),
    };

    const result = await runWalletPositionSentinel(
      {
        reader: failingReader,
        positionRepo: positionRepo([makePosition()]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });
});
