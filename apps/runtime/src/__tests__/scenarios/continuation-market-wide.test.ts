/**
 * ADR-016 end-to-end scenario harness — continuation gate under `market_wide`.
 *
 * Drives the full module pipeline (Supervisor + AlgoDecisionModule + downstream)
 * against pre-seeded legs whose per-leg trade count is 2 and `firstTradePrice`
 * is 0.03 — the exact shape that ADR-010's leg-local continuation rejects (R1
 * fail: count<6; R2 fail: price<0.05). `lastTradeAt` is current so D4 does not
 * match the expensive binary side; this scenario isolates continuation behavior,
 * not the P1 SELL-on-STOP bypass.
 *
 * Two passes prove the gate flip end-to-end:
 *   1. `leg_local` (ADR-010, default) — continuation STOPs every tick and no
 *      SELL rule matches, so no SignalProduced events fire downstream.
 *   2. `market_wide` (ADR-016, opt-in) with a stub provider returning ≥6 —
 *      continuation passes, and the FALLBACK decision rule emits at least one
 *      SignalProduced through the runtime, exercising the same code path the
 *      production wiring uses (`fixture.controlDb`, `fixture.tradeCountProvider`
 *      → `runScenario` → `AlgoDecisionModule`).
 *
 * The downstream signal-to-order bridge / ExecutionModule still apply the
 * normal hard-liveness + price-ceiling guards; we assert only on signalCount
 * because order placement is exhaustively covered by sibling scenarios.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

import { setContinuationMode } from "@krabs/db";
import { createTokenId, type ConditionId, type MarketTradeCountProvider } from "@krabs/domain";

import { runScenario } from "../../scenario/runner.js";
import {
  makeMarket,
  makeMarketFixture,
  resetFixtureCounters,
} from "../../scenario/fixture-helpers.js";

afterEach(() => resetFixtureCounters());

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

function bootControlDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(CONTROL_SQL);
  db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
  return db;
}

function makeStubProvider(returnValue: number | null): MarketTradeCountProvider {
  return {
    countTrades: vi.fn(async (_id: ConditionId, _cap: number) => returnValue),
    prefetch: vi.fn(async (_ids: readonly ConditionId[], _cap: number) => {}),
  };
}

const YES_TOKEN = "yes-cm-test-token";
const NO_TOKEN = "no-cm-test-token";

/**
 * Pre-seed BOTH outcome legs at `buyCount=2, firstTradePrice=0.03` so neither
 * token can reach `evaluateDecision` via the no-leg eligibility path. With
 * a leg present on both sides, the only thing that varies between the two
 * runs is the continuation gate.
 */
function seedBothLegsForStop(repos: { legState: { upsert: (s: unknown) => void } }): void {
  const now = new Date().toISOString();
  for (const tok of [YES_TOKEN, NO_TOKEN]) {
    repos.legState.upsert({
      tokenId: createTokenId(tok),
      buyCount: 2,
      sellCount: 0,
      lastAction: "BUY",
      firstTradePrice: 0.03,
      firstTradeAt: now,
      lastTradeAt: now,
      updatedAt: now,
    });
  }
}

describe("Scenario: ADR-016 continuation_mode end-to-end", () => {
  it("leg_local (default) — pre-seeded leg with count=2 + firstTradePrice=0.03 → STOP every tick (no signals)", async () => {
    const controlDb = bootControlDb();
    // Default mode is `leg_local`; no flip needed.
    try {
      const market = makeMarket({
        slug: "cm-leg-local",
        yesTokenId: YES_TOKEN,
        noTokenId: NO_TOKEN,
      });
      const result = await runScenario({
        name: "continuation-leg-local",
        description: "ADR-010 default — continuation STOPs the pre-seeded leg",
        marketSnapshots: [makeMarketFixture(market, 0.14, 0.16)],
        ticks: 3,
        controlDb,
        // Provider returning 6 would PASS continuation if mode were market_wide;
        // under leg_local it must be ignored entirely.
        tradeCountProvider: makeStubProvider(6),
        setup: async ({ repos }) => seedBothLegsForStop(repos),
      });

      expect(result.signalCount).toBe(0);
      expect(result.placeOrderRequestedCount).toBe(0);
    } finally {
      controlDb.close();
    }
  });

  it("market_wide (ADR-016) — provider returns 6 → continuation passes, ≥1 SignalProduced fires", async () => {
    const controlDb = bootControlDb();
    const flip = setContinuationMode(controlDb, "market_wide");
    expect(flip).toEqual({ changed: true, version: 1 });

    try {
      const market = makeMarket({
        slug: "cm-market-wide",
        yesTokenId: YES_TOKEN,
        noTokenId: NO_TOKEN,
      });
      const result = await runScenario({
        name: "continuation-market-wide",
        description: "ADR-016 opt-in — provider unblocks the same pre-seeded leg",
        marketSnapshots: [makeMarketFixture(market, 0.14, 0.16)],
        ticks: 3,
        controlDb,
        tradeCountProvider: makeStubProvider(6),
        setup: async ({ repos }) => seedBothLegsForStop(repos),
      });

      // The legacy gate produces zero on the same fixture; ADR-016 must produce ≥1.
      expect(result.signalCount).toBeGreaterThanOrEqual(1);
    } finally {
      controlDb.close();
    }
  });
});
