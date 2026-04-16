import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";
import { makeFamilyConfig } from "../../scenario/family-fixtures.js";

afterEach(() => resetFixtureCounters());

describe("Scenario: quarantine family state does not block algo signals", () => {
  it("produces signals and places orders even when family is quarantined", async () => {
    const familyConfig = makeFamilyConfig({
      familyId: "fam-elections",
      familyKey: "elections",
      slugPattern: "will-*-happen",
    });

    const market = makeMarket({ slug: "will-test-happen" });
    const fixture = {
      name: "quarantine-no-block",
      description: "Family in quarantine — algo path ignores family-level mode",
      marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
      familyStateOverrides: [
        {
          familyId: "fam-elections",
          runtimeMode: "quarantine",
          quarantineReason: "test-quarantine",
        },
      ],
      ticks: 3,
    };

    const result = await runScenario(fixture, [familyConfig]);

    // Family quarantine no longer blocks the algo signal path.
    // Signals are produced, approved, and orders placed.
    expect(result.signalCount).toBeGreaterThan(0);
    expect(result.approvedCount).toBeGreaterThanOrEqual(1);
    expect(result.placedOrderCount).toBeGreaterThanOrEqual(1);
  });
});
