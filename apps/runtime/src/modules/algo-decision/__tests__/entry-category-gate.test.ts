import { describe, expect, it } from "vitest";
import { createConditionId, createTokenId, type NormalizedMarket } from "@krabs/domain";
import {
  computeEntryCategoryGateSignalFields,
  type EntryCategoryGateInputs,
} from "../entry-category-gate.js";

function makeMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId: createTokenId("tok-cat-gate"),
    conditionId: createConditionId("cond-cat-gate"),
    slug: "cat-gate-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Category gate?",
    outcome: "Yes",
    regime: null,
    horizon: null,
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid: 0.29,
    bestAsk: 0.31,
    midPrice: 0.3,
    spread: 0.02,
    liquidity: 120,
    volume24h: 300,
    volume24hr: 12,
    publicTradeCount24h: 44,
    gammaCreatedAt: "2026-06-06T00:00:00.000Z",
    snapshotTs: Date.parse("2026-06-06T01:00:00.000Z"),
    ...overrides,
  };
}

function makeInputs(overrides: Partial<EntryCategoryGateInputs> = {}): EntryCategoryGateInputs {
  return {
    market: makeMarket(),
    nowMs: Date.parse("2026-06-06T01:00:00.000Z"),
    decisionRuleId: "R23_DIP_TRIGGER",
    signalReason: "probe-entry",
    buyCount: 0,
    ...overrides,
  };
}

describe("entry category-gate telemetry", () => {
  it("keeps category attribution without constructing a payload", () => {
    const fields = computeEntryCategoryGateSignalFields(
      makeInputs({ market: makeMarket({ tags: ["geopolitics"] }) }),
    );

    expect(fields.entryCategory).toBe("geopolitics");
    expect(fields.entryCategoryGateClass).toBe("PRIORITIZE");
    expect(fields.entryCategoryPayloadJson).toBeNull();
  });

  it("keeps derived category attribution without constructing a payload", () => {
    const fields = computeEntryCategoryGateSignalFields(
      makeInputs({
        market: makeMarket({ slug: "bitcoin-150k", tags: [] }),
      }),
    );

    expect(fields.entryCategory).toBe("crypto-btc");
    expect(fields.entryCategoryGateClass).toBe("PRIORITIZE");
    expect(fields.entryCategoryPayloadJson).toBeNull();
  });

  it("preserves gamma-tag precedence over a derived category", () => {
    const fields = computeEntryCategoryGateSignalFields(
      makeInputs({
        market: makeMarket({ slug: "trump-wins-2026", tags: ["geopolitics"] }),
      }),
    );

    expect(fields.entryCategory).toBe("geopolitics");
    expect(fields.entryCategoryGateClass).toBe("PRIORITIZE");
    expect(fields.entryCategoryPayloadJson).toBeNull();
  });

  it("keeps UNKNOWN attribution for an uncategorizable market", () => {
    const fields = computeEntryCategoryGateSignalFields(
      makeInputs({
        market: makeMarket({ slug: "totally-unclassifiable-market-xyz", tags: null }),
      }),
    );

    expect(fields.entryCategory).toBeNull();
    expect(fields.entryCategoryGateClass).toBe("UNKNOWN");
    expect(fields.entryCategoryPayloadJson).toBeNull();
  });
});
