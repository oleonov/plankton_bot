import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";
import { makeFamilyConfig } from "../../scenario/family-fixtures.js";

afterEach(() => resetFixtureCounters());

describe("Scenario: reduce-only blocks new entry", () => {
  it("does not allow new positions when family is reduce-only", async () => {
    const familyConfig = makeFamilyConfig({
      familyId: "fam-elections",
      familyKey: "elections",
      slugPattern: "will-*-happen",
    });

    const market = makeMarket({ slug: "will-test-happen" });
    const fixture = {
      name: "reduce-only-blocks",
      description: "Family in reduce-only mode",
      marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
      familyStateOverrides: [{ familyId: "fam-elections", runtimeMode: "reduce-only" }],
      ticks: 3,
    };

    const result = await runScenario(fixture, [familyConfig]);

    // Strategy still produces signals, but risk gate rejects all entry signals
    // when the family is in reduce-only mode
    expect(result.signalCount).toBeGreaterThan(0);
    expect(result.approvedCount).toBe(0);
    expect(result.rejectedCount).toBe(result.signalCount);
    expect(result.placedOrderCount).toBe(0);
    expect(result.openPositionCount).toBe(0);
  });
});
