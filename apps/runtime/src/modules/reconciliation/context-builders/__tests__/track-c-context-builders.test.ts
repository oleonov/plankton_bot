import { describe, expect, it } from "vitest";
import {
  computeRepriceThreshold,
  createBotRunId,
  createConditionId,
  createOrderId,
  createPositionId,
  createTokenId,
  decideExitAction,
  isLiveBook,
  isStaleSell,
  type LegState,
  type Market,
  type NormalizedMarket,
  type Order,
  type Position,
  type ClientOrderId,
} from "@krabs/domain";
import {
  buildBookContext,
  buildExitDecisionContext,
  buildRepriceContext,
  buildStaleSellContext,
} from "../track-c-context-builders.js";

const TOKEN = createTokenId("tok-track-c-builder");
const CONDITION = createConditionId("cond-track-c-builder");
const NOW = Date.parse("2026-06-02T12:00:00.000Z");

describe("Track C context builders", () => {
  it("builds BookContext from live market data with capturedAt", () => {
    const ctx = buildBookContext({
      tokenId: TOKEN,
      market: makeNormalizedMarket({ bestBid: 0.04, bestAsk: 0.05, publicTradeCount24h: 2 }),
      bidPersistenceS: 12,
      bidMovement30m: 0.002,
      ts: NOW,
    });

    expect(ctx).toMatchObject({
      assetId: TOKEN,
      bestBid: 0.04,
      bestAsk: 0.05,
      bidPersistenceS: 12,
      bidMovement30m: 0.002,
      publicTradeCount1h: null,
      capturedAt: NOW - 60_000,
    });
    expect(isLiveBook(ctx)).toMatchObject({ verdict: "live" });
  });

  it("does not substitute publicTradeCount24h for the missing 1h signal", () => {
    const ctx = buildBookContext({
      tokenId: TOKEN,
      market: makeNormalizedMarket({ bestBid: 0.04, bestAsk: 0.05, publicTradeCount24h: 99 }),
      bidPersistenceS: 12,
      bidMovement30m: 0.002,
      ts: NOW,
    });

    expect(ctx.publicTradeCount1h).toBeNull();
    expect(isLiveBook(ctx)).toMatchObject({ verdict: "live" });
  });

  it("builds RepriceContext with liveness and fresh snapshot timestamp", () => {
    const ctx = buildRepriceContext({
      tokenId: TOKEN,
      subtype: "strike",
      market: makeNormalizedMarket({ bestBid: 0.04, bestAsk: 0.05, spread: 0.01, midPrice: 0.045 }),
      livenessVerdict: "live",
      ts: NOW,
    });

    expect(ctx).toMatchObject({
      assetId: TOKEN,
      subtype: "strike",
      currentSpread: 0.01,
      currentMid: 0.045,
      capturedAt: NOW - 60_000,
    });
    expect(computeRepriceThreshold(ctx)).toMatchObject({
      shouldReprice: true,
      tickThreshold: 3,
    });
  });

  it("builds StaleSellContext from order, market, position, and leg state", () => {
    const ctx = buildStaleSellContext({
      order: makeSellOrder({ price: 0.061, createdAt: new Date(NOW - 31 * 60_000).toISOString() }),
      market: makeNormalizedMarket({ bestBid: 0.04, bestAsk: 0.05 }),
      legState: makeLegState({ repriceChainCount24h: 13, sellCount: 0 }),
      position: makePosition({ openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString() }),
      livenessVerdict: "dead",
      ts: NOW,
    });

    expect(ctx).toMatchObject({
      assetId: TOKEN,
      sellPrice: 0.061,
      currentBid: 0.04,
      currentAsk: 0.05,
      repriceChainCount24h: 13,
      sellCount: 0,
      livenessVerdict: "dead",
    });
    expect(isStaleSell(ctx)).toEqual({ stale: true, reason: "chain+price" });
  });

  it("combines predicate outputs into ExitDecisionContext", () => {
    const staleVerdict = { stale: true, reason: "chain" } as const;
    const ctx = buildExitDecisionContext({
      order: makeSellOrder({ price: 0.03 }),
      market: makeMarket({ endDate: new Date(NOW + 2 * 24 * 60 * 60_000).toISOString() }),
      position: makePosition({
        avgEntryPrice: 0.06,
        costBasisUsdc: 12,
        currentValueUsdc: 5,
        openedAt: new Date(NOW - 18 * 60 * 60_000).toISOString(),
      }),
      livenessVerdict: "dead",
      staleVerdict,
      subtype: "strike",
      exitPnlPct: -0.5,
      ts: NOW,
    });

    expect(ctx).toMatchObject({
      tokenId: TOKEN,
      positionPnLRatio: 5 / 12,
      livenessVerdict: "dead",
      staleVerdict,
      positionAgeMs: 18 * 60 * 60_000,
      ttcResolutionMs: 2 * 24 * 60 * 60_000,
      subtype: "strike",
      exitPnlPct: -0.5,
    });
    expect(decideExitAction(ctx)).toMatchObject({
      action: "hold_resolution",
      holdResolutionRequest: {
        tokenId: TOKEN,
        expectedResolutionAt: NOW + 2 * 24 * 60 * 60_000,
      },
    });
  });

  it("degrades missing market data without throwing", () => {
    const ctx = buildBookContext({
      tokenId: TOKEN,
      market: null,
      bidPersistenceS: null,
      bidMovement30m: null,
      ts: NOW,
    });

    expect(ctx).toMatchObject({
      bestBid: null,
      bestAsk: null,
      capturedAt: null,
    });
    expect(isLiveBook(ctx)).toMatchObject({ verdict: "dead", reason: "missing_book" });
  });
});

function makeNormalizedMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId: TOKEN,
    conditionId: String(CONDITION),
    slug: "will-test-track-c",
    eventSlug: "test-event",
    eventMarketCount: 1,
    question: "Will this test pass?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: "2026-06-05T00:00:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.04,
    bestAsk: 0.05,
    midPrice: 0.045,
    spread: 0.01,
    publicTradeCount24h: 2,
    gammaCreatedAt: null,
    snapshotTs: NOW - 60_000,
    ...overrides,
  };
}

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    tokenId: TOKEN,
    conditionId: String(CONDITION),
    slug: "will-test-track-c",
    eventSlug: "test-event",
    question: "Will this test pass?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: "2026-06-05T00:00:00.000Z",
    active: true,
    tradable: true,
    tickSize: 0.001,
    negRisk: false,
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

function makeSellOrder(overrides: Partial<Order> = {}): Order {
  return {
    orderId: createOrderId("ord-track-c-builder"),
    clientOrderId: "client-track-c-builder" as ClientOrderId,
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "sell",
    orderType: "GTC",
    price: 0.06,
    size: 10,
    sizeUsdc: 0.6,
    status: "open",
    exchangeOrderId: "ex-track-c-builder",
    signalId: "sig-track-c-builder",
    signalReason: "D9_LOSS_EXIT",
    botRunId: createBotRunId("bot-track-c-builder"),
    createdAt: new Date(NOW - 35 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 35 * 60_000).toISOString(),
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    positionId: createPositionId("pos-track-c-builder"),
    tokenId: TOKEN,
    conditionId: CONDITION,
    side: "buy",
    size: 100,
    avgEntryPrice: 0.06,
    costBasisUsdc: 6,
    currentValueUsdc: 4,
    realizedPnl: 0,
    status: "open",
    entryStyle: null,
    openedAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
    closedAt: null,
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

function makeLegState(overrides: Partial<LegState> = {}): LegState {
  return {
    tokenId: TOKEN,
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    firstTradePrice: 0.06,
    firstTradeAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
    lastTradeAt: new Date(NOW - 13 * 60 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}
