import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";
afterEach(() => {
  resetFixtureCounters();
});

describe("Scenario: operator pause/resume flow", () => {
  it("pauses stops new signal production, resuming restarts it", async () => {
    const market = makeMarket({ slug: "will-test-happen" });

    const baselineFixture = {
      name: "pause-baseline",
      description: "6 ticks, no pause — establish signal count baseline",
      marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
      ticks: 6,
    };

    const baselineResult = await runScenario(baselineFixture);
    const baselineSignals = baselineResult.signalCount;
    expect(baselineSignals).toBeGreaterThanOrEqual(3);

    resetFixtureCounters();

    const pausedFixture = {
      name: "operator-pause-resume",
      description: "Pause at tick 1, resume at tick 4",
      marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
      scheduledCommands: [
        { atTick: 1, action: "pause" as const, reason: "test pause" },
        { atTick: 4, action: "resume" as const, reason: "test resume" },
      ],
      ticks: 6,
    };

    const pausedResult = await runScenario(pausedFixture);

    // Paused run should produce fewer signals than baseline
    expect(pausedResult.signalCount).toBeGreaterThanOrEqual(1); // at least tick 0
    expect(pausedResult.signalCount).toBeLessThan(baselineSignals);
    expect(pausedResult.placedOrderCount).toBeGreaterThanOrEqual(1);
  });
});
