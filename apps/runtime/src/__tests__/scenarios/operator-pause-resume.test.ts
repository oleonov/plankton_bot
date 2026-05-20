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
  it("pause at tick 0 blocks initial signal production; resume unblocks it", async () => {
    // Baseline: no pause → FALLBACK BUY fires at tick 0 for both YES and NO
    // tokens (OTHER state), producing the natural signal volume.
    const baselineMarket = makeMarket({ slug: "will-test-happen" });
    const baselineFixture = {
      name: "pause-baseline",
      description: "3 ticks, no pause — establish signal count baseline",
      marketSnapshots: [makeMarketFixture(baselineMarket, 0.1, 0.12)],
      ticks: 3,
    };
    const baselineResult = await runScenario(baselineFixture);
    expect(baselineResult.signalCount).toBeGreaterThanOrEqual(1);
    expect(baselineResult.placedOrderCount).toBeGreaterThanOrEqual(1);

    resetFixtureCounters();

    // Pause *before* tick 0 evaluation: command is polled before evaluateTokens
    // runs, so no signals fire during ticks 0-1. No resume → stays paused.
    const pausedMarket = makeMarket({ slug: "will-test-happen" });
    const fullyPausedFixture = {
      name: "operator-pause",
      description: "Pause at tick 0, stay paused for all 3 ticks",
      marketSnapshots: [makeMarketFixture(pausedMarket, 0.1, 0.12)],
      scheduledCommands: [{ atTick: 0, action: "pause" as const, reason: "test pause" }],
      ticks: 3,
    };
    const fullyPausedResult = await runScenario(fullyPausedFixture);
    expect(fullyPausedResult.signalCount).toBe(0);
    expect(fullyPausedResult.placedOrderCount).toBe(0);

    resetFixtureCounters();

    // Pause at 0, resume at 1 → tick 0 produces nothing, tick 1+ matches baseline.
    const resumedMarket = makeMarket({ slug: "will-test-happen" });
    const resumedFixture = {
      name: "operator-pause-resume",
      description: "Pause at tick 0, resume at tick 1",
      marketSnapshots: [makeMarketFixture(resumedMarket, 0.1, 0.12)],
      scheduledCommands: [
        { atTick: 0, action: "pause" as const, reason: "test pause" },
        { atTick: 1, action: "resume" as const, reason: "test resume" },
      ],
      ticks: 3,
    };
    const resumedResult = await runScenario(resumedFixture);
    expect(resumedResult.signalCount).toBeGreaterThanOrEqual(1);
    expect(resumedResult.placedOrderCount).toBeGreaterThanOrEqual(1);
  });
});
