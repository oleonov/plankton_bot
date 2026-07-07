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
  it("geopolitics tag -> PRIORITIZE, categorySource gamma_tag", () => {
    const fields = computeEntryCategoryGateSignalFields(
      makeInputs({ market: makeMarket({ tags: ["geopolitics"] }) }),
    );
    const payload = JSON.parse(fields.entryCategoryPayloadJson ?? "{}");

    expect(fields.entryCategory).toBe("geopolitics");
    expect(fields.entryCategoryGateClass).toBe("PRIORITIZE");
    expect(payload.categorySource).toBe("gamma_tag");
    expect(payload.gammaCategory).toBe("geopolitics");
  });

  it("crypto-btc slug with no matching tag -> derivedCategory crypto-btc, categorySource derived", () => {
    const fields = computeEntryCategoryGateSignalFields(
      makeInputs({
        market: makeMarket({ slug: "bitcoin-150k", tags: [] }),
      }),
    );
    const payload = JSON.parse(fields.entryCategoryPayloadJson ?? "{}");

    expect(fields.entryCategory).toBe("crypto-btc");
    expect(fields.entryCategoryGateClass).toBe("PRIORITIZE");
    expect(payload.derivedCategory).toBe("crypto-btc");
    expect(payload.categorySource).toBe("derived");
  });

  it("geopolitics tag on a politics-derived slug -> agreement disagree, category geopolitics", () => {
    const fields = computeEntryCategoryGateSignalFields(
      makeInputs({
        market: makeMarket({ slug: "trump-wins-2026", tags: ["geopolitics"] }),
      }),
    );
    const payload = JSON.parse(fields.entryCategoryPayloadJson ?? "{}");

    expect(fields.entryCategory).toBe("geopolitics");
    expect(payload.agreement).toBe("disagree");
    expect(payload.derivedCategory).toBe("politics");
    expect(payload.gammaCategory).toBe("geopolitics");
  });

  it("uncategorizable slug + no tags -> null, UNKNOWN, categorySource none, agreement none", () => {
    const fields = computeEntryCategoryGateSignalFields(
      makeInputs({
        market: makeMarket({ slug: "totally-unclassifiable-market-xyz", tags: null }),
      }),
    );
    const payload = JSON.parse(fields.entryCategoryPayloadJson ?? "{}");

    expect(fields.entryCategory).toBeNull();
    expect(fields.entryCategoryGateClass).toBe("UNKNOWN");
    expect(payload.categorySource).toBe("none");
    expect(payload.agreement).toBe("none");
  });

  it("buyCount 0 -> first_entry; buyCount 2 -> ladder_or_scale_in", () => {
    const first = JSON.parse(
      computeEntryCategoryGateSignalFields(makeInputs({ buyCount: 0 })).entryCategoryPayloadJson ??
        "{}",
    );
    const ladder = JSON.parse(
      computeEntryCategoryGateSignalFields(makeInputs({ buyCount: 2 })).entryCategoryPayloadJson ??
        "{}",
    );

    expect(first.entryKind).toBe("first_entry");
    expect(ladder.entryKind).toBe("ladder_or_scale_in");
  });

  it("entryCategoryPayloadJson round-trips as valid JSON", () => {
    const fields = computeEntryCategoryGateSignalFields(
      makeInputs({ market: makeMarket({ tags: ["politics"] }) }),
    );

    expect(() => JSON.parse(fields.entryCategoryPayloadJson ?? "")).not.toThrow();
    const payload = JSON.parse(fields.entryCategoryPayloadJson ?? "{}");
    expect(payload).toMatchObject({
      tokenId: expect.any(String),
      conditionId: expect.any(String),
      timestamp: expect.any(String),
      gateClass: expect.any(String),
    });
  });
});
