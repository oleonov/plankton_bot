import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";
afterEach(() => resetFixtureCounters());

describe("Scenario: probe entry on single market", () => {
  it("produces a probe-entry signal that gets approved and opens a position", async () => {
    const market = makeMarket({ slug: "will-test-happen" });
    const fixture = {
      name: "scale-in-limit",
      description: "Single market, probe entry fires through algo decision rules",
      marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
      ticks: 5,
    };

    const result = await runScenario(fixture);

    expect(result.signalCount).toBeGreaterThanOrEqual(1);
    expect(result.approvedCount).toBeGreaterThanOrEqual(1);
    expect(result.openPositionCount).toBeGreaterThanOrEqual(1);
    expect(result.openPositionCount).toBeLessThanOrEqual(2);
  });
});
