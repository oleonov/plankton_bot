import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapDatabase } from "@plankton/db";
import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";
afterEach(() => {
  resetFixtureCounters();
});

describe("Scenario: restart/recovery on existing DB", () => {
  it("preserves positions across restarts", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "restart-test-"));
    const dbPath = join(tmpDir, "shared.db");

    try {
      const market = makeMarket({ slug: "will-test-happen" });

      const run1 = await runScenario({
        name: "restart-run-1",
        description: "First run — creates positions",
        marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
        ticks: 3,
        dbPath,
      });

      expect(run1.placedOrderCount).toBeGreaterThanOrEqual(1);
      expect(run1.openPositionCount).toBeGreaterThanOrEqual(1);

      resetFixtureCounters();

      const run2 = await runScenario({
        name: "restart-run-2",
        description: "Second run — verify state preserved",
        marketSnapshots: [makeMarketFixture(market, 0.1, 0.12)],
        ticks: 2,
        dbPath,
      });

      // Positions from run 1 should still be open
      expect(run2.openPositionCount).toBeGreaterThanOrEqual(run1.openPositionCount);

      // Verify new bot_run entry was created
      const conn = bootstrapDatabase(dbPath);
      const botRuns = conn.db.prepare("SELECT COUNT(*) as cnt FROM bot_runs").get() as {
        cnt: number;
      };
      expect(botRuns.cnt).toBeGreaterThanOrEqual(2);
      conn.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
