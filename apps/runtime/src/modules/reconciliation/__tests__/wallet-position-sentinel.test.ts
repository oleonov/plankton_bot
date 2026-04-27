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

  it("detects active local inventory whose size diverges from Polymarket", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 1135.84424, currentValueUsdc: 1.7037 })]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 1220,
            costBasisUsdc: 2.62,
            currentValueUsdc: 2.44,
            realizedPnl: 0,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(1);
    expect(result.details[0]).toContain("wallet-live-position-size-mismatch");
  });

  it("does not flag a 4-decimal data-api rounding gap as size mismatch", async () => {
    // Observed in prod 2026-04-27: local 17.882648 vs remote 17.8826,
    // remoteCurrentValueUsdc=$0.0089. The 0.000048 gap is data-api
    // truncating to 4 decimals — must not surface as drift.
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 17.8826, currentValueUsdc: 0.0089 })]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 17.882648,
            costBasisUsdc: 1,
            currentValueUsdc: 0.0089,
            realizedPnl: 0,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.activePositionDrifts).toHaveLength(0);
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

  it("flags an open local position whose token is absent from Polymarket positions", async () => {
    // Local DB still believes we own shares; wallet returns no row at all.
    // Without this branch, the loop would skip the token and the drift would
    // remain invisible — matching the production gap in finding #2.
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 50,
            costBasisUsdc: 5,
            currentValueUsdc: 4.5,
            realizedPnl: 0,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(1);
    expect(result.missingRemotePositions).toHaveLength(1);
    expect(result.missingRemotePositions[0]!.localStatus).toBe("open");
    expect(result.missingRemotePositions[0]!.localSize).toBe(50);
    expect(result.missingRemotePositions[0]!.remoteSize).toBe(0);
    expect(result.details[0]).toContain("wallet-local-position-missing-remote");
  });

  it("flags a dust local position absent from Polymarket while market is live", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([makePosition({ status: "dust", size: 0.5, closedAt: null })]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(1);
    expect(result.missingRemotePositions[0]!.localStatus).toBe("dust");
  });

  it("treats a remote dust row (size <= MIN_REMOTE_SIZE) as missing for inverse-direction drift", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 1e-12, currentValueUsdc: 0 })]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 30,
            costBasisUsdc: 3,
            currentValueUsdc: 2.7,
            realizedPnl: 0,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(1);
    expect(result.missingRemotePositions).toHaveLength(1);
    expect(result.activePositionDrifts).toHaveLength(0);
  });

  it("does not flag a missing-remote local position once market endDate has passed", async () => {
    // Past-endDate non-zero local balance is the redeem path's job, not the
    // wallet sentinel's: surfacing it here would double-count drift on every
    // resolved market until the redeem ledger row clears it.
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 10,
            costBasisUsdc: 1,
            currentValueUsdc: 0.9,
            realizedPnl: 0,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket({ endDate: "2026-04-24T00:00:00.000Z" })),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.missingRemotePositions).toHaveLength(0);
  });

  it("does not flag a closed-locally position when remote also has nothing", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([makePosition()]),
        marketRepo: marketRepo(makeMarket()),
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
