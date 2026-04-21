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
  it("does not emit SignalProduced or place an order when acceptingOrders=false on a new-entry market", async () => {
    // End-to-end invariant: acceptingOrders=false must never produce a live order.
    //
    // As of the shared-`isAlive` upstream gate, this short-circuits at
    // algo-decision (no SignalProduced) rather than at the signal-to-order
    // bridge. The bridge's own hard-liveness guard is still covered by the
    // unit tests in signal-to-order-bridge.test.ts (defense-in-depth), so
    // this scenario now asserts the end-to-end effect only.
    const market = makeMarket({ slug: "hard-liveness-test" });
    const yesTokenId = market.tokens[0]!.tokenId;
    const noTokenId = market.tokens[1]!.tokenId;

    const result = await runScenario({
      name: "hard-liveness-skip",
      description: "acceptingOrders=false on a new-entry market must not produce a signal or order",
      marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
      ticks: 3,
      setup: async ({ marketDataGateway }) => {
        const gateway = marketDataGateway as SimulationMarketDataGateway;
        gateway.setLivenessOverride(createTokenId(yesTokenId), { acceptingOrders: false });
        gateway.setLivenessOverride(createTokenId(noTokenId), { acceptingOrders: false });
      },
    });

    expect(result.signalCount).toBe(0);
    expect(result.conversionSkippedCount).toBe(0);
    expect(result.placeOrderRequestedCount).toBe(0);
    expect(result.placedOrderCount).toBe(0);
  }, 15_000);
});
