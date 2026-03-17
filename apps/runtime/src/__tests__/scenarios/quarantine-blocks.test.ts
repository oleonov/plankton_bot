import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import { makeMarket, makeMarketFixture, resetFixtureCounters } from "../../scenario/fixture-helpers.js";
import { makeFamilyConfig } from "../../scenario/family-fixtures.js";

afterEach(() => resetFixtureCounters());

describe("Scenario: quarantine blocks strategy", () => {
  it("does not produce signals when family is quarantined", async () => {
    const familyConfig = makeFamilyConfig({
      familyId: "fam-elections",
      familyKey: "elections",
      slugPattern: "will-*-happen",
    });

    const market = makeMarket({ slug: "will-test-happen" });
    const fixture = {
      name: "quarantine-blocks",
      description: "Family in quarantine",
      marketSnapshots: [makeMarketFixture(market, 0.45, 0.55)],
      familyStateOverrides: [
        { familyId: "fam-elections", runtimeMode: "quarantine", quarantineReason: "test-quarantine" },
      ],
      ticks: 3,
    };

    const result = await runScenario(fixture, [familyConfig]);

    // Strategy still produces signals, but the risk gate rejects them all
    // when the family is in quarantine mode
    expect(result.signalCount).toBeGreaterThan(0);
    expect(result.approvedCount).toBe(0);
    expect(result.rejectedCount).toBe(result.signalCount);
    expect(result.placedOrderCount).toBe(0);
    expect(result.openPositionCount).toBe(0);
  });
});
