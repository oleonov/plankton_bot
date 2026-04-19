import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";
import type { SimulationMarketDataGateway } from "@plankton/exchange";
import { createTokenId } from "@plankton/domain";

afterEach(() => {
  resetFixtureCounters();
});

describe("scenario: hard-liveness skip", () => {
  it(
    "publishes SignalConversionSkipped { stage: 'hard-liveness' } and no PlaceOrderRequested when acceptingOrders=false",
    async () => {
      // Arrange a market at a price that triggers a probe-entry signal (same as happy-path).
      // The YES token will have acceptingOrders=false injected via setLivenessOverride so
      // that the signal-to-order bridge short-circuits at the hard-liveness guard.
      const market = makeMarket({ slug: "hard-liveness-test" });
      const yesTokenId = market.tokens[0]!.tokenId;
      const noTokenId = market.tokens[1]!.tokenId;

      const result = await runScenario({
        name: "hard-liveness-skip",
        description:
          "acceptingOrders=false should short-circuit the bridge before order placement",
        marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
        ticks: 3,
        setup: async ({ marketDataGateway }) => {
          // Override liveness on both YES and NO tokens — market data gateway will return
          // acceptingOrders=false in getMarketPricing, which flows into NormalizedMarket
          // and is checked by SignalToOrderBridge before emitting PlaceOrderRequested.
          const gateway = marketDataGateway as SimulationMarketDataGateway;
          gateway.setLivenessOverride(createTokenId(yesTokenId), { acceptingOrders: false });
          gateway.setLivenessOverride(createTokenId(noTokenId), { acceptingOrders: false });
        },
      });

      expect(result.conversionSkippedCount).toBeGreaterThanOrEqual(1);
      expect(result.skippedConversions[0]!.stage).toBe("hard-liveness");
      expect(result.skippedConversions[0]!.reasons).toContain("not_accepting_orders");
      expect(result.skippedConversions[0]!.diagnostics).toMatchObject({
        acceptingOrders: false,
        enableOrderBook: true,
      });
      expect(result.placeOrderRequestedCount).toBe(0);
      expect(result.placedOrderCount).toBe(0);
    },
    15_000,
  );
});
