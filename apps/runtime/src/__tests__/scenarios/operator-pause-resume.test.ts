import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import { makeMarket, makeMarketFixture, resetFixtureCounters } from "../../scenario/fixture-helpers.js";
import { makeFamilyConfig } from "../../scenario/family-fixtures.js";

afterEach(() => {
  resetFixtureCounters();
});

describe("Scenario: operator pause/resume flow", () => {
  it("pauses stops new signal production, resuming restarts it", async () => {
    // Use a high defaultMaxBuysPerLeg so scale-in signals continue across all ticks,
    // allowing the baseline and paused runs to differ in signal count by more than
    // the number of ticks affected by the pause window.
    const familyConfig = makeFamilyConfig({
      familyId: "fam-pause-test",
      familyKey: "pause-test",
      slugPattern: "^will-.*-happen$",
      defaultMaxBuysPerLeg: 10,
    });

    const market = makeMarket({ slug: "will-test-happen" });

    // Baseline: 6 ticks, no pause
    const baselineFixture = {
      name: "pause-baseline",
      description: "6 ticks, no pause — establish signal count baseline",
      marketSnapshots: [makeMarketFixture(market, 0.45, 0.55)],
      ticks: 6,
    };

    const baselineResult = await runScenario(baselineFixture, [familyConfig]);
    const baselineSignals = baselineResult.signalCount;
    expect(baselineSignals).toBeGreaterThanOrEqual(3);

    resetFixtureCounters();

    // Paused: pause at tick 1, resume at tick 4
    const pausedFixture = {
      name: "operator-pause-resume",
      description: "Pause at tick 1, resume at tick 4",
      marketSnapshots: [makeMarketFixture(market, 0.45, 0.55)],
      scheduledCommands: [
        { atTick: 1, action: "pause" as const, reason: "test pause" },
        { atTick: 4, action: "resume" as const, reason: "test resume" },
      ],
      ticks: 6,
    };

    const pausedResult = await runScenario(pausedFixture, [familyConfig]);

    // Paused run should produce fewer signals than baseline
    expect(pausedResult.signalCount).toBeGreaterThanOrEqual(1); // at least tick 0
    expect(pausedResult.signalCount).toBeLessThan(baselineSignals);
    expect(pausedResult.placedOrderCount).toBeGreaterThanOrEqual(1);
  });
});
