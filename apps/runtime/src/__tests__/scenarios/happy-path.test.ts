import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";
import { formatRunSummary } from "../../scenario/run-summary.js";

afterEach(() => {
  resetFixtureCounters();
});

describe("Scenario: probe entry happy path", () => {
  it("produces a signal, gets approved, places order, receives fill, creates position", async () => {
    const market = makeMarket({ slug: "will-test-happen" });
    const fixture = {
      name: "probe-entry-happy-path",
      description: "Single market, probe entry fires and fills",
      marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
      ticks: 3,
    };

    const result = await runScenario(fixture);
    console.log(formatRunSummary(fixture.name, result));

    expect(result.signalCount).toBeGreaterThanOrEqual(1);
    expect(result.approvedCount).toBeGreaterThanOrEqual(1);
    expect(result.placedOrderCount).toBeGreaterThanOrEqual(1);
    expect(result.fillCount).toBeGreaterThanOrEqual(1);
    expect(result.openPositionCount).toBeGreaterThanOrEqual(1);
  });
});
