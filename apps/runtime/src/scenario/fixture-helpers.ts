/**
 * Helpers to build typed scenario fixtures without boilerplate.
 */

import type { ClobMarket, PriceLevel } from "@krabs/domain";
import type { MarketFixture } from "./types.js";

let marketCounter = 0;

function defaultEndDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

/** Create a minimal ClobMarket fixture with YES/NO tokens. */
export function makeMarket(overrides: {
  slug: string;
  conditionId?: string;
  yesTokenId?: string;
  noTokenId?: string;
  question?: string;
  endDate?: string;
  active?: boolean;
  negRisk?: boolean;
  tickSize?: number;
}): ClobMarket {
  marketCounter++;
  const conditionId = overrides.conditionId ?? `cond-${marketCounter}`;
  const yesTokenId = overrides.yesTokenId ?? `tok-yes-${marketCounter}`;
  const noTokenId = overrides.noTokenId ?? `tok-no-${marketCounter}`;

  return {
    conditionId,
    tokens: [
      { tokenId: yesTokenId, outcome: "Yes" },
      { tokenId: noTokenId, outcome: "No" },
    ],
    question: overrides.question ?? `Will ${overrides.slug} happen?`,
    slug: overrides.slug,
    endDate: overrides.endDate ?? defaultEndDate(),
    active: overrides.active ?? true,
    negRisk: overrides.negRisk ?? false,
    tickSize: overrides.tickSize ?? 0.01,
    volume24h: null,
    eventMarketCount: 1,
    gammaCreatedAt: null,
  };
}

/** Create a symmetric order book with given best bid/ask. */
export function makeOrderBook(
  bestBid: number,
  bestAsk: number,
  depth = 3,
  sizePerLevel = 100,
): { bids: PriceLevel[]; asks: PriceLevel[] } {
  const bids: PriceLevel[] = [];
  const asks: PriceLevel[] = [];
  const tick = 0.01;

  for (let i = 0; i < depth; i++) {
    bids.push({ price: bestBid - i * tick, size: sizePerLevel });
    asks.push({ price: bestAsk + i * tick, size: sizePerLevel });
  }

  return { bids, asks };
}

/** Create a MarketFixture from a market + order book per token. */
export function makeMarketFixture(
  market: ClobMarket,
  yesBid: number,
  yesAsk: number,
): MarketFixture {
  const yesToken = market.tokens[0]!;
  const noToken = market.tokens[1]!;
  const noBid = +(1 - yesAsk).toFixed(2);
  const noAsk = +(1 - yesBid).toFixed(2);

  return {
    market,
    orderBooks: {
      [yesToken.tokenId]: makeOrderBook(yesBid, yesAsk),
      [noToken.tokenId]: makeOrderBook(Math.max(noBid, 0.01), Math.max(noAsk, 0.02)),
    },
  };
}

/** Reset the market counter between tests. */
export function resetFixtureCounters(): void {
  marketCounter = 0;
}
