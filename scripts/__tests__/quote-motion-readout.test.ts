import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeQuoteMotion } from "../measurement/quote-motion-readout.js";

const START = "2026-08-21T00:00:00.000Z";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("quote-motion aggregate readout", () => {
  it("separates sample and order denominators and reports BID/ASK distributions", () => {
    const fixture = makeFixture();
    insert(
      fixture.db,
      sample("private-buy", "r23_capture", "buy-up-opportunity", {
        currentPrice: 0.1,
        candidatePrice: 0.12,
        tickSize: 0.01,
      }),
    );
    insert(fixture.db, sample("private-buy", "r23_capture", "buy-hold"));
    insert(
      fixture.db,
      sample("private-sell", "bounce_exit_target", "sell-below-target", {
        currentPrice: 0.2,
        candidatePrice: 0.18,
        priceGiveUp: 0.02,
        tickSize: 0.01,
        lotFacts: availableLots(0.12),
      }),
    );
    insert(
      fixture.db,
      sample("private-sell-2", "bounce_exit_target", "sell-at-target", {
        currentPrice: 0.2,
        candidatePrice: 0.2,
        priceGiveUp: 0,
        tickSize: 0.01,
        lotFacts: { status: "unavailable" },
      }),
    );

    const report = analyzeQuoteMotion({ ledger: fixture.path, cohortStart: START });

    expect(report.status).toBe("DESCRIPTIVE_ONLY");
    expect(report.coverage).toEqual({
      rowsRead: 4,
      validSamples: 4,
      invalidSamples: 0,
      distinctOrders: 3,
      buyOrders: 1,
      sellOrders: 2,
      identityConflictSamples: 0,
    });
    expect(report.buy).toMatchObject({
      ordersEverUpOpportunity: 1,
      upOpportunitySamples: 1,
      improvementTicks: { count: 1, median: 2 },
    });
    expect(report.sell).toMatchObject({
      ordersEverBelowTarget: 1,
      belowTargetSamples: 1,
      fifoAvailableSamples: 1,
      fifoUnavailableSamples: 1,
      giveUpTicks: { count: 2, median: 1 },
      giveUpPctOfTarget: { count: 2, median: 5 },
      grossCandidateVsMaxLotPct: { count: 1, median: 50 },
    });
    fixture.close();
  });

  it("fails closed on malformed direction/time/provenance and conflicting identities", () => {
    const fixture = makeFixture();
    insert(fixture.db, "not-json");
    insert(
      fixture.db,
      sample("old", "r23_capture", "buy-hold", {
        sampledAt: "2026-08-20T23:59:59.000Z",
      }),
    );
    insert(
      fixture.db,
      sample("timezone-less", "r23_capture", "buy-hold", {
        sampledAt: "2026-08-21T01:00:00.000",
      }),
    );
    insert(
      fixture.db,
      sample("down", "r23_capture", "buy-up-opportunity", {
        currentPrice: 0.12,
        candidatePrice: 0.11,
        tickSize: 0.01,
      }),
    );
    insert(
      fixture.db,
      sample("bad-give-up", "bounce_exit_target", "sell-below-target", {
        candidatePrice: 0.18,
        priceGiveUp: 0.01,
        tickSize: 0.01,
      }),
    );
    insert(
      fixture.db,
      sample("bad-lots", "bounce_exit_target", "sell-at-target", {
        candidatePrice: 0.2,
        priceGiveUp: 0,
        tickSize: 0.01,
        lotFacts: { status: "available", maxEntryPrice: 0.1 },
      }),
    );
    insert(
      fixture.db,
      sample("wrong-direction", "bounce_exit_target", "sell-below-target", {
        candidatePrice: 0.22,
        priceGiveUp: -0.02,
        tickSize: 0.01,
      }),
    );
    insert(fixture.db, sample("conflict", "r23_capture", "buy-hold"));
    insert(
      fixture.db,
      sample("conflict", "r23_capture", "buy-hold", {
        conditionId: "different-condition",
      }),
    );
    insert(
      fixture.db,
      sample("target-conflict", "bounce_exit_target", "sell-below-target", {
        candidatePrice: 0.18,
        priceGiveUp: 0.02,
        tickSize: 0.01,
      }),
    );
    insert(
      fixture.db,
      sample("target-conflict", "bounce_exit_target", "sell-below-target", {
        candidatePrice: 0.18,
        priceGiveUp: 0.04,
        tickSize: 0.01,
        origin: {
          version: 1,
          kind: "bounce_exit_target",
          cohortId: "private-cohort",
          originalTargetPrice: 0.22,
        },
      }),
    );

    const report = analyzeQuoteMotion({ ledger: fixture.path, cohortStart: START });

    expect(report.status).toBe("NO_SAMPLES");
    expect(report.coverage).toMatchObject({
      rowsRead: 11,
      validSamples: 0,
      invalidSamples: 11,
      identityConflictSamples: 4,
    });
    fixture.close();
  });

  it("the real CLI emits aggregate-only JSON without durable identifiers", () => {
    const fixture = makeFixture();
    insert(
      fixture.db,
      sample("private-order-id", "r23_capture", "buy-up-opportunity", {
        candidatePrice: 0.11,
        tickSize: 0.01,
      }),
    );
    fixture.db.close();
    const script = resolve(import.meta.dirname, "../measurement/quote-motion-readout.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", script, "--ledger", fixture.path, "--cohort-start", START],
      { encoding: "utf8", timeout: 15_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "DESCRIPTIVE_ONLY",
      aggregateOnly: true,
      coverage: { distinctOrders: 1 },
    });
    expect(result.stdout).not.toContain("private-order-id");
    expect(result.stdout).not.toContain("private-token");
  });
});

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "quote-motion-readout-"));
  dirs.push(dir);
  const path = join(dir, "ledger.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE risk_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_risk_events_type ON risk_events(event_type, created_at DESC);
  `);
  return { db, path, close: () => db.close() };
}

function insert(db: Database.Database, payload: Record<string, unknown> | string): void {
  db.prepare("INSERT INTO risk_events(event_type,payload,created_at) VALUES (?,?,?)").run(
    "quote_motion_shadow_sample",
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "2026-08-21 01:00:00",
  );
}

function sample(
  orderId: string,
  kind: "r23_capture" | "bounce_exit_target",
  classification: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const sell = kind === "bounce_exit_target";
  return {
    version: 1,
    sampledAt: "2026-08-21T01:00:00.000Z",
    orderId,
    tokenId: "private-token",
    conditionId: "private-condition",
    cohortId: "private-cohort",
    kind,
    side: sell ? "sell" : "buy",
    currentPrice: sell ? 0.2 : 0.1,
    classification,
    candidatePrice: null,
    priceGiveUp: null,
    tickSize: null,
    origin: {
      version: 1,
      kind,
      cohortId: "private-cohort",
      originalTargetPrice: sell ? 0.2 : null,
    },
    lotFacts: sell ? { status: "inconsistent" } : null,
    ...overrides,
  };
}

function availableLots(maxEntryPrice: number): Record<string, unknown> {
  return {
    status: "available",
    count: 1,
    remainingSize: 5,
    remainingCostUsdc: 0.6,
    maxEntryPrice,
    avgEntryPrice: maxEntryPrice,
  };
}
