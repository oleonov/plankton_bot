import { describe, expect, it, vi } from "vitest";
import {
  createConditionId,
  createPositionId,
  createTokenId,
  type Fill,
  type FillRepository,
  type Market,
  type MarketRepository,
  type Position,
  type PositionRepository,
} from "@krabs/domain";
import type { PolymarketDataPosition, PolymarketPositionReader } from "@krabs/exchange";
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
    conditionId: String(CONDITION),
    size: 12,
    currentValueUsdc: 1.23,
    initialValueUsdc: 0.8,
    redeemable: false,
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
    eventMarketCount: 1,
    gammaCreatedAt: null,
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
    findByTokenId: vi.fn(
      (tokenId: string) =>
        positions.find((position) => String(position.tokenId) === tokenId) ?? null,
    ),
    save: vi.fn(),
    // Default: no conflicting open row for the token. Guard-conflict tests
    // override this to return the "other" open position that blocks a save.
    findActiveByTokenId: vi.fn().mockReturnValue([]),
  } as unknown as PositionRepository;
}

function makeFill(overrides: Partial<Fill> = {}): Fill {
  return {
    fillId: "fill-live" as Fill["fillId"],
    orderId: "order-live" as Fill["orderId"],
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    price: 0.06,
    size: 17.33,
    sizeUsdc: 1.0398,
    liquidityRole: "maker",
    fee: 0,
    feeRateBps: 0,
    signalId: null,
    decisionRuleId: null,
    signalTimestamp: null,
    filledAt: "2026-04-24T23:59:30.000Z",
    ...overrides,
  };
}

function fillRepo(fills: Fill[]): FillRepository {
  return {
    findByTokenId: vi.fn().mockReturnValue(fills),
    findRecentByTokenId: vi.fn().mockReturnValue([...fills].reverse()),
  } as unknown as FillRepository;
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

  it("does not flag closed live positions while Polymarket data-api lags a fresh fill", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote()]),
        positionRepo: positionRepo([makePosition()]),
        fillRepo: fillRepo([makeFill({ filledAt: "2026-04-24T23:59:30.000Z" })]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.closedLivePositions).toHaveLength(0);
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

  it("updates active local mark and status from Polymarket data-api", async () => {
    const repo = positionRepo([
      makePosition({
        status: "dust",
        size: 205,
        costBasisUsdc: 2.05,
        currentValueUsdc: 0.615,
        realizedPnl: 0,
        closedAt: null,
      }),
    ]);

    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 205, currentValueUsdc: 12.5049 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.markUpdateCount).toBe(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        currentValueUsdc: 12.5049,
        status: "open",
        size: 205,
        updatedAt: "2026-04-25T00:00:00.000Z",
      }),
    );
  });

  it("does not revert sellable low-notional positions to dust", async () => {
    const repo = positionRepo([
      makePosition({
        status: "open",
        size: 23.94,
        costBasisUsdc: 1,
        currentValueUsdc: 1.2,
        realizedPnl: 0,
        closedAt: null,
      }),
    ]);

    await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 23.94, currentValueUsdc: 0.34 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
        latestMinOrderSize: () => 5,
      },
      NOW,
    );

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        currentValueUsdc: 0.34,
        status: "open",
        size: 23.94,
      }),
    );
  });

  it("publishes PositionUpdated when a real below-min position transitions open to dust", async () => {
    const repo = positionRepo([
      makePosition({
        status: "open",
        size: 2,
        costBasisUsdc: 0.5,
        currentValueUsdc: 0.5,
        realizedPnl: 0,
        closedAt: null,
      }),
    ]);
    const bus = { publish: vi.fn().mockResolvedValue(undefined) };

    await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 2, currentValueUsdc: 0.2 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
        bus,
        latestMinOrderSize: () => 5,
      },
      NOW,
    );

    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ status: "dust", size: 2 }));
    expect(bus.publish).toHaveBeenCalledWith("PositionUpdated", {
      position: expect.objectContaining({ status: "dust", size: 2 }),
    });
  });

  it("does not rewrite active marks that already match Polymarket", async () => {
    const repo = positionRepo([
      makePosition({
        status: "open",
        size: 12,
        costBasisUsdc: 0.8,
        currentValueUsdc: 1.23,
        realizedPnl: 0,
        closedAt: null,
      }),
    ]);

    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote()]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.markUpdateCount).toBe(0);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("drops impossible remote currentValueUsdc above local position size", async () => {
    const repo = positionRepo([
      makePosition({
        status: "open",
        size: 0.01,
        costBasisUsdc: 0.0037,
        currentValueUsdc: 0.0033,
        realizedPnl: 0,
        closedAt: null,
      }),
    ]);

    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 0.01, currentValueUsdc: 8 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.markUpdateCount).toBe(0);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("allows remote currentValueUsdc exactly equal to local position size", async () => {
    const repo = positionRepo([
      makePosition({
        status: "dust",
        size: 5,
        costBasisUsdc: 2.5,
        currentValueUsdc: 0.49,
        realizedPnl: 0,
        closedAt: null,
      }),
    ]);

    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 5, currentValueUsdc: 5 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.markUpdateCount).toBe(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        currentValueUsdc: 5,
        status: "open",
        size: 5,
      }),
    );
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

  it("does not flag active size drift while Polymarket data-api lags a fresh fill", async () => {
    const repo = positionRepo([
      makePosition({
        status: "open",
        size: 50.88,
        costBasisUsdc: 3.069,
        currentValueUsdc: 3.05,
        realizedPnl: 0,
        closedAt: null,
      }),
    ]);

    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 33.55, currentValueUsdc: 2.0297 })]),
        positionRepo: repo,
        fillRepo: fillRepo([makeFill({ filledAt: "2026-04-24T23:59:15.000Z" })]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.activePositionDrifts).toHaveLength(0);
    expect(result.markUpdateCount).toBe(1);
  });

  it("flags active size drift after the fresh-fill data-api grace expires", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 33.55, currentValueUsdc: 2.0297 })]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 50.88,
            costBasisUsdc: 3.069,
            currentValueUsdc: 3.05,
            realizedPnl: 0,
            closedAt: null,
          }),
        ]),
        fillRepo: fillRepo([makeFill({ filledAt: "2026-04-24T23:55:00.000Z" })]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(1);
    expect(result.activePositionDrifts[0]).toMatchObject({
      localSize: 50.88,
      remoteSize: 33.55,
    });
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

  it("does not flag a freshly opened local position before data-api catches up", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 42.05,
            costBasisUsdc: 8.41,
            currentValueUsdc: 8.41,
            realizedPnl: 0,
            closedAt: null,
            openedAt: "2026-04-24T23:59:30.000Z",
            updatedAt: "2026-04-24T23:59:30.000Z",
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.missingRemotePositions).toHaveLength(0);
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

  it("does not flag missing-remote micro-dust below one cent", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            status: "dust",
            size: 0.009999999999999787,
            costBasisUsdc: 0.0037,
            currentValueUsdc: 0.0033,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(0);
    expect(result.missingRemotePositions).toHaveLength(0);
  });

  it("still flags same-size missing-remote open inventory even when value is tiny", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 0.01,
            costBasisUsdc: 0.0037,
            currentValueUsdc: 0.0033,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(1);
    expect(result.missingRemotePositions[0]!.localStatus).toBe("open");
  });

  it("still flags missing-remote dust above the micro-dust share threshold", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            status: "dust",
            size: 0.010_001,
            costBasisUsdc: 0.0037,
            currentValueUsdc: 0.0033,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(1);
    expect(result.missingRemotePositions[0]!.localStatus).toBe("dust");
  });

  it("does not let newer micro-dust hide an older meaningful open position", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            positionId: createPositionId("pos-older-open"),
            status: "open",
            size: 50,
            costBasisUsdc: 5,
            currentValueUsdc: 4.5,
            realizedPnl: 0,
            closedAt: null,
            updatedAt: "2026-04-24T02:00:00.000Z",
          }),
          makePosition({
            positionId: createPositionId("pos-newer-micro-dust"),
            status: "dust",
            size: 0.01,
            costBasisUsdc: 0.0037,
            currentValueUsdc: 0.0033,
            closedAt: null,
            updatedAt: "2026-04-24T03:00:00.000Z",
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );

    expect(result.driftCount).toBe(1);
    expect(result.missingRemotePositions[0]).toMatchObject({
      positionId: "pos-older-open",
      localStatus: "open",
      localSize: 50,
    });
  });

  it("still flags same-size missing-remote dust when remaining value is meaningful", async () => {
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            status: "dust",
            size: 0.01,
            costBasisUsdc: 0.5,
            currentValueUsdc: 0.49,
            closedAt: null,
          }),
        ]),
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

  it("does not flag a sub-epsilon local position absent from Polymarket as inverse drift", async () => {
    // Mirror of the v138 direct-loop fix on the inverse path: data-api can
    // round/omit balances under 1e-3, so a tiny local-active row without a
    // remote row must not surface as drift.
    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 0.0005,
            costBasisUsdc: 0.0001,
            currentValueUsdc: 0.0001,
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
    expect(result.missingRemotePositions).toHaveLength(0);
  });

  it("revalues a missing-remote local position from latest usable snapshot price", async () => {
    const repo = positionRepo([
      makePosition({
        status: "open",
        size: 0.003,
        costBasisUsdc: 0.0037,
        currentValueUsdc: 3.21,
        closedAt: null,
      }),
    ]);
    const findUsablePrice = vi.fn().mockReturnValue(0.015);

    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        latestUsablePriceLookup: { findUsablePrice },
        log,
      },
      NOW,
    );

    expect(findUsablePrice).toHaveBeenCalledWith(TOKEN, NOW);
    expect(result.missingRemoteRevaluedCount).toBe(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        currentValueUsdc: 0.003 * 0.015,
        updatedAt: "2026-04-25T00:00:00.000Z",
      }),
    );
  });

  it("writes explicit null when a missing-remote local position has no usable snapshot price", async () => {
    const repo = positionRepo([
      makePosition({
        status: "open",
        size: 0.003,
        costBasisUsdc: 0.0037,
        currentValueUsdc: 3.21,
        closedAt: null,
      }),
    ]);

    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        latestUsablePriceLookup: { findUsablePrice: vi.fn().mockReturnValue(null) },
        log,
      },
      NOW,
    );

    expect(result.missingRemoteRevaluedCount).toBe(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        currentValueUsdc: null,
        status: "open",
        updatedAt: "2026-04-25T00:00:00.000Z",
      }),
    );
  });

  it("does not invoke Tier 3 revaluation when the token is present remotely", async () => {
    const findUsablePrice = vi.fn().mockReturnValue(0.015);

    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 0.003, currentValueUsdc: 0.000045 })]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 0.003,
            currentValueUsdc: 0.000045,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        latestUsablePriceLookup: { findUsablePrice },
        log,
      },
      NOW,
    );

    expect(result.missingRemoteRevaluedCount).toBe(0);
    expect(findUsablePrice).not.toHaveBeenCalled();
  });

  it("does not invoke Tier 3 revaluation for sub-epsilon local positions", async () => {
    const findUsablePrice = vi.fn().mockReturnValue(0.015);

    const result = await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: positionRepo([
          makePosition({
            status: "open",
            size: 0.0005,
            costBasisUsdc: 0.0001,
            currentValueUsdc: 0.0001,
            closedAt: null,
          }),
        ]),
        marketRepo: marketRepo(makeMarket()),
        latestUsablePriceLookup: { findUsablePrice },
        log,
      },
      NOW,
    );

    expect(result.missingRemoteRevaluedCount).toBe(0);
    expect(findUsablePrice).not.toHaveBeenCalled();
  });

  it("uses latestMinOrderSize when resolving missing-remote revaluation status", async () => {
    const repo = positionRepo([
      makePosition({
        status: "open",
        size: 0.003,
        costBasisUsdc: 0.0037,
        currentValueUsdc: 3.21,
        closedAt: null,
      }),
    ]);

    await runWalletPositionSentinel(
      {
        reader: reader([]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        latestUsablePriceLookup: { findUsablePrice: vi.fn().mockReturnValue(0.015) },
        latestMinOrderSize: vi.fn().mockReturnValue(0.01),
        log,
      },
      NOW,
    );

    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        currentValueUsdc: 0.003 * 0.015,
        status: "dust",
      }),
    );
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

  // Migration 032's partial unique index allows only one `open` row per token.
  // applyRemoteMark and applyMissingRemoteRevaluation both promote a local row
  // toward "open" from a fresh Polymarket read; if a different open row already
  // exists for the token they must skip the write (return null) rather than
  // risk a raw SQLITE_CONSTRAINT — the sentinel re-runs every cycle, so a
  // skipped mark is just one cycle of staleness, not a lost fact.
  describe("open-position-conflict guard", () => {
    it("preserves dust status but refreshes its value when an open sibling blocks promotion (D)", async () => {
      const repo = positionRepo([
        makePosition({
          status: "dust",
          size: 205,
          costBasisUsdc: 2.05,
          currentValueUsdc: 0.615,
          realizedPnl: 0,
          closedAt: null,
        }),
      ]);
      const conflicting = makePosition({
        positionId: createPositionId("pos-live-open-conflict"),
        status: "open",
        size: 10,
        closedAt: null,
      });
      (repo.findActiveByTokenId as ReturnType<typeof vi.fn>).mockReturnValue([conflicting]);
      log.error.mockClear();

      const result = await runWalletPositionSentinel(
        {
          reader: reader([makeRemote({ size: 205, currentValueUsdc: 12.5049 })]),
          positionRepo: repo,
          marketRepo: marketRepo(makeMarket()),
          log,
        },
        NOW,
      );

      expect(result.markUpdateCount).toBe(1);
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ status: "dust" }));
      expect(log.error).toHaveBeenCalled();
    });

    it("skips applyMissingRemoteRevaluation when a different open position already exists for the token (E)", async () => {
      // The local row starts as `dust`, not `open`: migration 032's partial unique index allows only
      // one `open` row per token, so a fixture with two simultaneously-open rows for the same token
      // is unreachable. The realistic conflict this guard defends is a dust row about to be promoted
      // (via revaluation) while a *different* row already holds `open` for the token.
      const repo = positionRepo([
        makePosition({
          status: "dust",
          size: 0.003,
          costBasisUsdc: 0.0037,
          currentValueUsdc: 3.21,
          closedAt: null,
        }),
      ]);
      const conflicting = makePosition({
        positionId: createPositionId("pos-missing-remote-conflict"),
        status: "open",
        size: 5,
        closedAt: null,
      });
      (repo.findActiveByTokenId as ReturnType<typeof vi.fn>).mockReturnValue([conflicting]);
      log.error.mockClear();

      const result = await runWalletPositionSentinel(
        {
          reader: reader([]),
          positionRepo: repo,
          marketRepo: marketRepo(makeMarket()),
          latestUsablePriceLookup: { findUsablePrice: vi.fn().mockReturnValue(0.015) },
          log,
        },
        NOW,
      );

      expect(result.missingRemoteRevaluedCount).toBe(0);
      expect(repo.save).not.toHaveBeenCalled();
      expect(log.error).toHaveBeenCalled();
    });

    it("marks every non-closed row at the shared remote price while keeping a blocked dust sibling dust (D)", async () => {
      const openRow = makePosition({
        positionId: createPositionId("pos-open"),
        status: "open",
        size: 10,
        costBasisUsdc: 1,
        currentValueUsdc: 1,
        realizedPnl: 0,
        closedAt: null,
        updatedAt: "2026-04-24T01:00:00.000Z",
      });
      const dustRow = makePosition({
        positionId: createPositionId("pos-dust"),
        status: "dust",
        size: 205,
        costBasisUsdc: 2.05,
        currentValueUsdc: 0.615,
        realizedPnl: 0,
        closedAt: null,
        updatedAt: "2026-04-24T05:00:00.000Z",
      });
      const repo = positionRepo([openRow, dustRow]);
      (repo.findActiveByTokenId as ReturnType<typeof vi.fn>).mockReturnValue([openRow, dustRow]);
      log.error.mockClear();

      const result = await runWalletPositionSentinel(
        {
          reader: reader([makeRemote({ size: 10, currentValueUsdc: 5 })]),
          positionRepo: repo,
          marketRepo: marketRepo(makeMarket()),
          log,
        },
        NOW,
      );

      expect(result.markUpdateCount).toBe(2);
      expect(repo.save).toHaveBeenCalledTimes(2);
      const saved = (repo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
      expect(String(saved.positionId)).toBe("pos-open");
      expect(saved.status).toBe("open");
      expect(saved.currentValueUsdc).toBe(5);
      const savedDust = (repo.save as ReturnType<typeof vi.fn>).mock.calls[1]![0] as Position;
      expect(savedDust).toMatchObject({
        positionId: dustRow.positionId,
        status: "dust",
        currentValueUsdc: 102.5,
      });
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ positionId: dustRow.positionId }),
        expect.any(String),
      );
    });

    // Negative controls: the pre-existing "updates active local mark and status
    // from Polymarket data-api" (D) and "revalues a missing-remote local
    // position from latest usable snapshot price" (E) tests above already cover
    // the no-conflict path with the same positionRepo() factory used here — both
    // still pass unchanged, confirming the added findActiveByTokenId default
    // ([] = no conflict) doesn't alter unblocked behavior.
  });

  it("T6 — a single matching row keeps its full remote value", async () => {
    const repo = positionRepo([
      makePosition({ status: "open", size: 40, currentValueUsdc: 1, closedAt: null }),
    ]);
    await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 40, currentValueUsdc: 20 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ currentValueUsdc: 20 }));
  });

  it("T7 — shared-token rows are valued at one price per share without drift", async () => {
    const repo = positionRepo([
      makePosition({
        positionId: createPositionId("t7-open"),
        status: "open",
        size: 40,
        closedAt: null,
      }),
      makePosition({
        positionId: createPositionId("t7-dust"),
        status: "dust",
        size: 3,
        closedAt: null,
      }),
    ]);
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 43, currentValueUsdc: 21.5 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );
    expect(result.activePositionDrifts).toEqual([]);
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ currentValueUsdc: 20 }));
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ currentValueUsdc: 1.5 }));
  });

  it("T8 — aggregate local size, not one selected row, drives wallet drift", async () => {
    const repo = positionRepo([
      makePosition({
        positionId: createPositionId("t8-open"),
        status: "open",
        size: 40,
        closedAt: null,
      }),
      makePosition({
        positionId: createPositionId("t8-dust"),
        status: "dust",
        size: 3,
        closedAt: null,
      }),
    ]);
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 50, currentValueUsdc: 25 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );
    expect(result.activePositionDrifts[0]).toMatchObject({ localSize: 43, remoteSize: 50 });
  });

  it("T9 — per-share values above one dollar are rejected", async () => {
    const repo = positionRepo([makePosition({ status: "open", size: 1, closedAt: null })]);
    const result = await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 1, currentValueUsdc: 1.01 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );
    expect(result.markUpdateCount).toBe(0);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it("T19 — a divergent single local size receives only its proportional mark", async () => {
    const repo = positionRepo([makePosition({ status: "open", size: 40, closedAt: null })]);
    await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 43, currentValueUsdc: 21.5 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );
    expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ currentValueUsdc: 20 }));
  });

  it("T22 — a blocked dust promotion retains dust status while persisting its mark", async () => {
    const open = makePosition({
      positionId: createPositionId("t22-open"),
      status: "open",
      size: 40,
      closedAt: null,
    });
    const dust = makePosition({
      positionId: createPositionId("t22-dust"),
      status: "dust",
      size: 3,
      closedAt: null,
    });
    const repo = positionRepo([open, dust]);
    (repo.findActiveByTokenId as ReturnType<typeof vi.fn>).mockReturnValue([open]);
    await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 43, currentValueUsdc: 21.5 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        positionId: dust.positionId,
        status: "dust",
        currentValueUsdc: 1.5,
      }),
    );
  });

  it("T24 — only the deterministic dust winner promotes when no open sibling exists", async () => {
    const older = makePosition({
      positionId: createPositionId("t24-old"),
      status: "dust",
      size: 3,
      openedAt: "2026-04-20T00:00:00.000Z",
      closedAt: null,
    });
    const newer = makePosition({
      positionId: createPositionId("t24-new"),
      status: "dust",
      size: 3,
      openedAt: "2026-04-21T00:00:00.000Z",
      closedAt: null,
    });
    const repo = positionRepo([newer, older]);
    (repo.findByTokenId as ReturnType<typeof vi.fn>).mockReturnValue(older);
    (repo.findActiveByTokenId as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([])
      .mockReturnValue([older]);
    await runWalletPositionSentinel(
      {
        reader: reader([makeRemote({ size: 6, currentValueUsdc: 3 })]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
        latestMinOrderSize: () => 1,
      },
      NOW,
    );
    const saved = (repo.save as ReturnType<typeof vi.fn>).mock.calls.map(
      ([row]) => row as Position,
    );
    expect(saved.filter((row) => row.status === "open")).toHaveLength(1);
    expect(saved.map((row) => row.currentValueUsdc)).toEqual([1.5, 1.5]);
  });

  it("T25 — invalid remote or local monetary inputs skip only their token", async () => {
    const healthyToken = createTokenId("t25-healthy");
    const invalid = makePosition({ status: "open", size: 5, closedAt: null });
    const healthy = makePosition({
      positionId: createPositionId("t25-healthy"),
      tokenId: healthyToken,
      status: "open",
      size: 2,
      closedAt: null,
    });
    const repo = positionRepo([invalid, healthy]);
    const result = await runWalletPositionSentinel(
      {
        reader: reader([
          makeRemote({ size: Number.NaN }),
          makeRemote({ tokenId: String(healthyToken), size: 2, currentValueUsdc: 1 }),
        ]),
        positionRepo: repo,
        marketRepo: marketRepo(makeMarket()),
        log,
      },
      NOW,
    );
    expect(result.skippedInvalidInputTokens).toBe(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ positionId: healthy.positionId, currentValueUsdc: 1 }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: String(TOKEN) }),
      expect.any(String),
    );
  });
});
