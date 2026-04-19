import { describe, expect, it } from "vitest";
import { createTokenId } from "@plankton/domain";
import type { NormalizedMarket, Regime } from "@plankton/domain";
import type { OutcomeSelectionBundle } from "../modules/strategy/outcome-selection.js";
import {
  rejectOutcomeCandidate,
  scoreOutcomeCandidate,
  selectFirstEntryOutcomeForCondition,
  selectFirstEntryTokenForCondition,
} from "../modules/strategy/outcome-selection.js";

function makeMarket(overrides?: Partial<NormalizedMarket>): NormalizedMarket {
  const bestBid = overrides?.bestBid ?? 0.03;
  const bestAsk = overrides?.bestAsk ?? 0.04;
  return {
    tokenId: createTokenId("tok-yes"),
    conditionId: "cond-1",
    slug: "will-btc-reach-100k",
    eventSlug: null,
    question: "Will BTC reach 100k?",
    outcome: "YES",
    outcomeIndex: 0,
    regime: "threshold" as Regime,
    horizon: "short",
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    acceptingOrders: true,
    enableOrderBook: true,
    bestBid,
    bestAsk,
    midPrice: (bestBid + bestAsk) / 2,
    spread: bestAsk - bestBid,
    volume24h: 50_000,
    liquidity: null,
    minOrderSize: 5,
    bookSource: "clob",
    snapshotTs: Date.now(),
    eventMarketCount: 1,
    ...overrides,
  };
}

function makeBundle(rulesOverrides?: {
  entry?: Partial<OutcomeSelectionBundle["rules"]["entry"]> & Record<string, unknown>;
  throughput?: Record<string, unknown>;
}): OutcomeSelectionBundle {
  return {
    rules: {
      entry: {
        minEntryPrice: 0.01,
        maxEntryPrice: 0.5,
        ...rulesOverrides?.entry,
      },
      throughput: rulesOverrides?.throughput,
    },
  };
}

describe("outcome selection", () => {
  it("selects the cheaper outcome when spread quality is comparable", () => {
    const bundle = makeBundle();
    const yes = makeMarket({ tokenId: createTokenId("tok-yes"), bestBid: 0.49, bestAsk: 0.5 });
    const no = makeMarket({
      tokenId: createTokenId("tok-no"),
      outcome: "NO",
      outcomeIndex: 1,
      bestBid: 0.04,
      bestAsk: 0.05,
    });

    expect(selectFirstEntryTokenForCondition([yes, no], bundle)).toBe("tok-no");
  });

  it("rejects explicit Gamma fallback books for live entry selection", () => {
    const bundle = makeBundle();
    const rejected = rejectOutcomeCandidate(makeMarket({ bookSource: "gamma-fallback" }), bundle);

    expect(rejected).toBe("gamma-fallback");
  });

  it("allows Gamma fallback books for dust-first micro entries with fresh trade context", () => {
    const bundle = makeBundle({
      entry: { entryMode: "spray-first" },
      throughput: {
        maxConcurrentOrdersPerFamily: 10,
        maxProbeInFlightPerToken: 2,
        maxEntrySignalsPerTickPerFamily: 10,
        dustLaneEnabled: true,
      },
    });
    const selection = selectFirstEntryOutcomeForCondition(
      [
        makeMarket({
          tokenId: createTokenId("tok-fallback"),
          bookSource: "gamma-fallback",
          bestBid: null,
          bestAsk: null,
          midPrice: 0.021,
          spread: null,
          lastTradePrice: 0.02,
          lastTradeAt: new Date().toISOString(),
        }),
      ],
      bundle,
      {
        allowGammaFallbackDust: true,
        dustSuggestedSizeUsdc: 0.15,
        nowMs: Date.now(),
      },
    );

    expect(selection.tokenId).toBe("tok-fallback");
  });

  it("does not allow Gamma fallback books above the hard $0.25 dust cap", () => {
    const bundle = makeBundle({
      entry: { entryMode: "spray-first" },
      throughput: {
        maxConcurrentOrdersPerFamily: 10,
        maxProbeInFlightPerToken: 2,
        maxEntrySignalsPerTickPerFamily: 10,
        dustLaneEnabled: true,
      },
    });
    const selection = selectFirstEntryOutcomeForCondition(
      [
        makeMarket({
          tokenId: createTokenId("tok-fallback-live-floor"),
          bookSource: "gamma-fallback",
          bestBid: null,
          bestAsk: null,
          midPrice: 0.021,
          spread: null,
          lastTradePrice: 0.02,
          lastTradeAt: new Date().toISOString(),
        }),
      ],
      bundle,
      {
        allowGammaFallbackDust: true,
        dustSuggestedSizeUsdc: 1,
        executionMinNotionalUsdc: 1,
        nowMs: Date.now(),
      },
    );

    expect(selection.tokenId).toBeNull();
  });

  it("does not let ultra-cheap tokens win when relative spread is broken", () => {
    const bundle = makeBundle();
    const brokenCheap = makeMarket({
      tokenId: createTokenId("tok-cheap"),
      bestBid: 0.01,
      bestAsk: 0.02,
    });
    const cleanCheap = makeMarket({
      tokenId: createTokenId("tok-clean"),
      bestBid: 0.045,
      bestAsk: 0.05,
    });

    expect(selectFirstEntryTokenForCondition([brokenCheap, cleanCheap], bundle)).toBe("tok-clean");
  });

  it("lets tighter liquidity beat a slightly cheaper but sloppy token", () => {
    const cheaperButSloppy = makeMarket({
      tokenId: createTokenId("tok-cheap"),
      bestBid: 0.02,
      bestAsk: 0.028,
      volume24h: 5_000,
    });
    const cleaner = makeMarket({
      tokenId: createTokenId("tok-clean"),
      bestBid: 0.045,
      bestAsk: 0.046,
      volume24h: 50_000,
    });

    expect(scoreOutcomeCandidate(cleaner)).toBeGreaterThan(scoreOutcomeCandidate(cheaperButSloppy));
  });

  it("rejects all candidates when every outcome is outside entry quality gates", () => {
    const bundle = makeBundle();
    const fallback = makeMarket({
      tokenId: createTokenId("tok-fallback"),
      bookSource: "gamma-fallback",
    });
    const wide = makeMarket({ tokenId: createTokenId("tok-wide"), bestBid: 0.1, bestAsk: 0.2 });

    expect(selectFirstEntryTokenForCondition([fallback, wide], bundle)).toBeNull();
  });
});
