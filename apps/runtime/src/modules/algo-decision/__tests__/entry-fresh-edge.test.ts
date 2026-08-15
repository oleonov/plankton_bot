import { describe, expect, it } from "vitest";
import {
  createConditionId,
  createEntryFreshEdgeAttribution,
  createTokenId,
  parseEntryFreshEdgeAttribution,
  type NormalizedMarket,
} from "@krabs/domain";
import {
  computeEntryFreshEdgeSignalFields,
  type EntryFreshEdgeInputs,
} from "../entry-fresh-edge.js";

function makeMarket(overrides: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    tokenId: createTokenId("tok-fresh-edge"),
    conditionId: createConditionId("cond-fresh-edge"),
    slug: "fresh-edge-market",
    eventSlug: null,
    eventMarketCount: 1,
    question: "Fresh edge?",
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

function makeInputs(overrides: Partial<EntryFreshEdgeInputs> = {}): EntryFreshEdgeInputs {
  const nowMs = Date.parse("2026-06-06T01:00:00.000Z");
  return {
    market: makeMarket(),
    nowMs,
    decisionRuleId: "R23_DIP_TRIGGER",
    signalReason: "probe-entry",
    buyCount: 0,
    marketAgeSeconds: 3600,
    marketAgeThresholdSeconds: 2504,
    marketAgeGatePassed: true,
    windowStats: {
      "1h": {
        minMidpoint: 0.2,
        maxMidpoint: 0.6,
        minAtMs: nowMs - 15 * 60_000,
        maxAtMs: nowMs - 50 * 60_000,
        firstMidpoint: 0.25,
        lastMidpoint: 0.3,
        sampleCount: 5,
      },
      "6h": null,
      "24h": null,
    },
    ...overrides,
  };
}

describe("entry fresh-edge telemetry", () => {
  it("constructs and strictly parses only the stable v1 initial-R23 contract", () => {
    const attribution = createEntryFreshEdgeAttribution({
      signalId: "sig-r23",
      side: "buy",
      decisionRuleId: "R23_DIP_TRIGGER",
      entryKind: "first_entry",
      shadowClass: "FALLING_WITHOUT_RECOVERY",
    });

    expect(attribution).toEqual({
      version: 1,
      originSignalId: "sig-r23",
      originDecisionRuleId: "R23_DIP_TRIGGER",
      entryKind: "first_entry",
      shadowClass: "FALLING_WITHOUT_RECOVERY",
    });
    expect(parseEntryFreshEdgeAttribution(attribution)).toEqual(attribution);
    expect(parseEntryFreshEdgeAttribution({ ...attribution, version: 2 })).toBeNull();
    expect(parseEntryFreshEdgeAttribution({ ...attribution, extra: true })).toBeNull();
    expect(parseEntryFreshEdgeAttribution({ ...attribution, originSignalId: "   " })).toBeNull();
    expect(
      createEntryFreshEdgeAttribution({
        signalId: "sig-add",
        side: "buy",
        decisionRuleId: "R23_DIP_TRIGGER",
        entryKind: "ladder_or_scale_in",
        shadowClass: "PLAUSIBLE_DIP",
      }),
    ).toBeNull();
  });

  it("computes percentile and tags first-entry BUY diagnostics without changing signal data", () => {
    const fields = computeEntryFreshEdgeSignalFields(makeInputs());
    const payload = JSON.parse(fields.entryFreshEdgePayloadJson ?? "{}");

    expect(fields.entryFreshEdgeKind).toBe("first_entry");
    expect(fields.entryFreshEdgeShadowClass).toBe("PLAUSIBLE_DIP");
    expect(payload.current).toMatchObject({
      bid: 0.29,
      ask: 0.31,
      mid: 0.3,
      spread: 0.02,
      liquidity: 120,
      publicTradeCount24h: 44,
    });
    expect(payload.windows["1h"].midpointPercentile).toBeCloseTo(0.25, 8);
    expect(payload.windows["1h"].currentVsPeak).toBeCloseTo(0.5, 8);
    expect(payload.marketAge).toMatchObject({
      seconds: 3600,
      thresholdSeconds: 2504,
      gatePassed: true,
    });
  });

  it("records range-data-unavailable when historical midpoint windows are missing", () => {
    const fields = computeEntryFreshEdgeSignalFields(
      makeInputs({ windowStats: { "1h": null, "6h": null, "24h": null } }),
    );
    const payload = JSON.parse(fields.entryFreshEdgePayloadJson ?? "{}");

    expect(fields.entryFreshEdgeShadowClass).toBe("RANGE_DATA_UNAVAILABLE");
    expect(payload.windows["1h"]).toMatchObject({
      midpointMin: null,
      midpointMax: null,
      midpointPercentile: null,
      sampleCount: 0,
    });
  });

  it("tags ladder and scale-in BUY rows separately from first entries", () => {
    const fields = computeEntryFreshEdgeSignalFields(makeInputs({ buyCount: 2 }));
    const payload = JSON.parse(fields.entryFreshEdgePayloadJson ?? "{}");

    expect(fields.entryFreshEdgeKind).toBe("ladder_or_scale_in");
    expect(payload.entryKind).toBe("ladder_or_scale_in");
  });

  it("classifies falling-without-recovery and after-pump shapes", () => {
    const nowMs = Date.parse("2026-06-06T01:00:00.000Z");
    const falling = computeEntryFreshEdgeSignalFields(
      makeInputs({
        market: makeMarket({ midPrice: 0.22, bestBid: 0.21, bestAsk: 0.23 }),
        windowStats: {
          "1h": {
            minMidpoint: 0.2,
            maxMidpoint: 0.6,
            minAtMs: nowMs - 50 * 60_000,
            maxAtMs: nowMs - 10 * 60_000,
            firstMidpoint: 0.6,
            lastMidpoint: 0.22,
            sampleCount: 5,
          },
          "6h": null,
          "24h": null,
        },
      }),
    );
    const afterPump = computeEntryFreshEdgeSignalFields(
      makeInputs({
        market: makeMarket({ midPrice: 0.58, bestBid: 0.57, bestAsk: 0.59 }),
      }),
    );

    expect(falling.entryFreshEdgeShadowClass).toBe("FALLING_WITHOUT_RECOVERY");
    expect(afterPump.entryFreshEdgeShadowClass).toBe("AFTER_PUMP_EXPENSIVE");
  });
});
