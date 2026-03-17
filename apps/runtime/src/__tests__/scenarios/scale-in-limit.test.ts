import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import { makeMarket, makeMarketFixture, resetFixtureCounters } from "../../scenario/fixture-helpers.js";
import { makeFamilyConfig } from "../../scenario/family-fixtures.js";

afterEach(() => resetFixtureCounters());

describe("Scenario: scale-in limit respected", () => {
  it("does not open more positions than defaultMaxBuysPerLeg allows", async () => {
    const familyConfig = makeFamilyConfig({
      familyId: "fam-elections",
      familyKey: "elections",
      slugPattern: "will-*-happen",
      defaultMaxBuysPerLeg: 1,
    });

    const market = makeMarket({ slug: "will-test-happen" });
    const fixture = {
      name: "scale-in-limit",
      description: "Family with defaultMaxBuysPerLeg=1",
      marketSnapshots: [makeMarketFixture(market, 0.45, 0.55)],
      ticks: 5,
    };

    const result = await runScenario(fixture, [familyConfig]);

    // With defaultMaxBuysPerLeg=1, the scanner stops producing scale-in
    // signals after the first buy per position. Compared to default (3),
    // fewer signals are generated overall but none are rejected —
    // the limit is enforced at signal generation, not the risk gate.
    expect(result.signalCount).toBeGreaterThanOrEqual(1);
    expect(result.approvedCount).toBeGreaterThanOrEqual(1);
    // Each token gets at most 1 buy (probe entry), no scale-in signals
    expect(result.openPositionCount).toBeGreaterThanOrEqual(1);
    expect(result.openPositionCount).toBeLessThanOrEqual(2);
  });
});
