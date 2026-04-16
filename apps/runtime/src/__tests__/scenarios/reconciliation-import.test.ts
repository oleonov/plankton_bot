import { describe, it, expect, afterEach } from "vitest";
import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";
import { makeFamilyConfig } from "../../scenario/family-fixtures.js";

afterEach(() => {
  resetFixtureCounters();
});

describe("Scenario: reconciliation imports missing fill", () => {
  it("imports a fill that exists on exchange but not in local DB", async () => {
    const familyConfig = makeFamilyConfig({
      familyId: "fam-recon-test",
      familyKey: "recon-test",
      slugPattern: "will-*-happen",
    });

    const market = makeMarket({ slug: "will-test-happen" });

    const fixture = {
      name: "reconciliation-import",
      description: "Pre-seed order + exchange fill, verify reconciliation imports it",
      marketSnapshots: [makeMarketFixture(market, 0.44, 0.46)],
      ticks: 2,
      setup: async (ctx: { db: any; exchangeGateway: any; repos: any }) => {
        const now = new Date().toISOString();
        const tokenId = market.tokens[0]!.tokenId;

        // Place order through gateway (auto-fill in immediate mode)
        const placeResult = await ctx.exchangeGateway.placeOrder({
          clientOrderId: "co-recon-1",
          tokenId,
          side: "buy",
          size: 10,
          price: 0.45,
          orderType: "GTC",
          tickSize: 0.01,
          negRisk: false,
        });

        // Insert same order into local DB as "open" — local DB doesn't know about the fill
        ctx.db
          .prepare(
            "INSERT INTO orders (order_id, client_order_id, token_id, condition_id, family_id, side, order_type, price, size, size_usdc, status, bot_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            placeResult.orderId,
            "co-recon-1",
            tokenId,
            market.conditionId,
            "fam-recon-test",
            "buy",
            "GTC",
            0.45,
            10,
            4.5,
            "open",
            "prev-run",
            now,
            now,
          );
      },
    };

    const result = await runScenario(fixture, [familyConfig]);

    expect(result.reconciliationRan).toBe(true);
    // Position should have been created from the imported fill
    expect(result.openPositionCount).toBeGreaterThanOrEqual(1);
  });
});
