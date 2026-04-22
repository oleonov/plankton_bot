/**
 * Tests for SqliteMarketRepository.findTrackedForPricingTiered.
 *
 * Seed: 10 000 tradable markets + 5 execution-critical (3 open positions, 2 open orders)
 * where the critical tokens are NOT in the tradable set (tradable=0 but have exposure).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteMarketRepository } from "../repositories/market-repository.js";
import { createTokenId } from "@plankton/domain";
import type { Market } from "@plankton/domain";
import type Database from "better-sqlite3";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteMarketRepository;
let db: Database.Database;

const NOW_BASE = "2026-01-01T00:00:00.000Z";

function makeMarket(
  tokenId: string,
  overrides: Partial<Market> & { updatedAt?: string } = {},
): Market {
  const now = overrides.updatedAt ?? NOW_BASE;
  return {
    tokenId: createTokenId(tokenId),
    conditionId: `cond-${tokenId}`,
    slug: `slug-${tokenId}`,
    eventSlug: null,
    question: "Q?",
    outcome: "YES",
    outcomeIndex: 0,
    regime: "threshold",
    horizon: "daily",
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    createdAt: NOW_BASE,
    updatedAt: now,
    ...overrides,
  };
}

function insertPosition(tokenId: string, status: "open" | "dust" | "closed"): void {
  db.prepare(
    `INSERT INTO positions
       (position_id, token_id, condition_id, side, size, avg_entry_price,
        cost_basis_usdc, current_value_usdc, realized_pnl,
        status, entry_style, opened_at, closed_at, updated_at)
     VALUES (?,?,?,'buy',1,0.5,0.5,0.5,0,?,'probe',datetime('now'),NULL,datetime('now'))`,
  ).run(`pos-${tokenId}`, tokenId, `cond-${tokenId}`, status);
}

function insertOrder(tokenId: string, status: "pending" | "open" | "filled"): void {
  db.prepare(
    `INSERT INTO orders
       (order_id, client_order_id, token_id, condition_id, side,
        order_type, price, size, size_usdc, status,
        exchange_order_id, signal_id, signal_reason, bot_run_id,
        created_at, updated_at)
     VALUES (?,?,?,?,'buy','GTC',0.5,1,0.5,?,NULL,NULL,NULL,'br1',datetime('now'),datetime('now'))`,
  ).run(`ord-${tokenId}`, `cord-${tokenId}`, tokenId, `cond-${tokenId}`, status);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-tiered-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  db = conn.db;
  repo = new SqliteMarketRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Core tier tests ──────────────────────────────────────────────────────

describe("findTrackedForPricingTiered", () => {
  it("empty DB → all tiers empty", () => {
    const result = repo.findTrackedForPricingTiered({ maxTokens: 1000 });
    expect(result.executionCritical).toHaveLength(0);
    expect(result.entryCandidates).toHaveLength(0);
    expect(result.discoveryOnly).toHaveLength(0);
  });

  it("tradable markets with no positions/orders land in entryCandidates up to the cap", () => {
    for (let i = 0; i < 5; i++) {
      repo.save(
        makeMarket(`t-${i}`, {
          tradable: true,
          selectionStatus: "matched_include",
        }),
      );
    }
    const result = repo.findTrackedForPricingTiered({ maxTokens: 3 });
    expect(result.executionCritical).toHaveLength(0);
    expect(result.entryCandidates).toHaveLength(3);
    expect(result.discoveryOnly).toHaveLength(2);
  });

  it("executionCritical: markets with open positions are always included", () => {
    repo.save(makeMarket("crit-pos", { tradable: false }));
    insertPosition("crit-pos", "open");
    repo.save(makeMarket("crit-dust", { tradable: false }));
    insertPosition("crit-dust", "dust");
    repo.save(makeMarket("trad-only", { tradable: true }));

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    const critIds = new Set(result.executionCritical.map((m) => String(m.tokenId)));
    expect(critIds.has("crit-pos")).toBe(true);
    expect(critIds.has("crit-dust")).toBe(true);
    expect(critIds.has("trad-only")).toBe(false);
    expect(result.entryCandidates.map((m) => String(m.tokenId))).toContain("trad-only");
  });

  it("executionCritical: markets with open/pending orders are always included", () => {
    repo.save(makeMarket("crit-open-ord", { tradable: false }));
    insertOrder("crit-open-ord", "open");
    repo.save(makeMarket("crit-pend-ord", { tradable: false }));
    insertOrder("crit-pend-ord", "pending");
    repo.save(makeMarket("filled-ord", { tradable: false }));
    insertOrder("filled-ord", "filled");

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    const critIds = new Set(result.executionCritical.map((m) => String(m.tokenId)));
    expect(critIds.has("crit-open-ord")).toBe(true);
    expect(critIds.has("crit-pend-ord")).toBe(true);
    // filled order + not tradable → not tracked at all
    expect(critIds.has("filled-ord")).toBe(false);
    const allIds = [
      ...result.executionCritical,
      ...result.entryCandidates,
      ...result.discoveryOnly,
    ].map((m) => String(m.tokenId));
    expect(allIds).not.toContain("filled-ord");
  });

  it("executionCritical not truncated when size > maxTokens; entryCandidates becomes empty", () => {
    for (let i = 0; i < 5; i++) {
      repo.save(makeMarket(`crit-${i}`, { tradable: false }));
      insertPosition(`crit-${i}`, "open");
    }
    for (let i = 0; i < 10; i++) {
      repo.save(makeMarket(`trad-${i}`, { tradable: true }));
    }

    const result = repo.findTrackedForPricingTiered({ maxTokens: 3 });
    expect(result.executionCritical).toHaveLength(5); // never capped
    expect(result.entryCandidates).toHaveLength(0); // 3 - 5 < 0 → empty
    expect(result.discoveryOnly).toHaveLength(10); // all tradable go to discovery
  });

  it("execution-critical tokens are NOT duplicated in entryCandidates", () => {
    // tradable=true AND has open position → should be execution-critical only
    repo.save(makeMarket("both", { tradable: true }));
    insertPosition("both", "open");
    repo.save(makeMarket("trad-only-2", { tradable: true }));

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    const critIds = new Set(result.executionCritical.map((m) => String(m.tokenId)));
    const candIds = new Set(result.entryCandidates.map((m) => String(m.tokenId)));
    const discIds = new Set(result.discoveryOnly.map((m) => String(m.tokenId)));

    expect(critIds.has("both")).toBe(true);
    expect(candIds.has("both")).toBe(false);
    expect(discIds.has("both")).toBe(false);
  });

  it("entryCandidates ordered: matched_include (0) > step2_fallback_include (1) > unknown (2)", () => {
    repo.save(makeMarket("u-1", { selectionStatus: "unknown", updatedAt: "2026-01-03T00:00:00Z" }));
    repo.save(
      makeMarket("s2-1", {
        selectionStatus: "step2_fallback_include",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.save(
      makeMarket("mi-1", {
        selectionStatus: "matched_include",
        updatedAt: "2026-01-02T00:00:00Z",
      }),
    );

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    expect(result.entryCandidates).toHaveLength(3);
    expect(String(result.entryCandidates[0]!.tokenId)).toBe("mi-1"); // rank 0
    expect(String(result.entryCandidates[1]!.tokenId)).toBe("s2-1"); // rank 1
    expect(String(result.entryCandidates[2]!.tokenId)).toBe("u-1"); // rank 2
  });

  it("within same selection_status tier, newer updated_at wins", () => {
    repo.save(
      makeMarket("mi-old", {
        selectionStatus: "matched_include",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.save(
      makeMarket("mi-new", {
        selectionStatus: "matched_include",
        updatedAt: "2026-01-05T00:00:00Z",
      }),
    );
    repo.save(
      makeMarket("mi-mid", {
        selectionStatus: "matched_include",
        updatedAt: "2026-01-03T00:00:00Z",
      }),
    );

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    const ids = result.entryCandidates.map((m) => String(m.tokenId));
    expect(ids[0]).toBe("mi-new");
    expect(ids[1]).toBe("mi-mid");
    expect(ids[2]).toBe("mi-old");
  });

  it("discovery: no limit — returns all remaining tradable markets beyond cap", () => {
    for (let i = 0; i < 20; i++) {
      repo.save(makeMarket(`disc-${i}`, { tradable: true }));
    }
    const result = repo.findTrackedForPricingTiered({ maxTokens: 5 });
    expect(result.entryCandidates).toHaveLength(5);
    expect(result.discoveryOnly).toHaveLength(15);
  });

  it("inactive markets are never returned in any tier", () => {
    repo.save(makeMarket("inactive-trad", { active: false, tradable: true }));
    repo.save(makeMarket("active-trad", { active: true, tradable: true }));

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    const allIds = [
      ...result.executionCritical,
      ...result.entryCandidates,
      ...result.discoveryOnly,
    ].map((m) => String(m.tokenId));
    expect(allIds).not.toContain("inactive-trad");
    expect(allIds).toContain("active-trad");
  });

  it("matched_exclude and fallback_exclude markets are filtered out of the tradable universe entirely", () => {
    repo.save(makeMarket("excl-m", { selectionStatus: "matched_exclude", tradable: true }));
    repo.save(makeMarket("excl-f", { selectionStatus: "fallback_exclude", tradable: true }));
    repo.save(makeMarket("incl-m", { selectionStatus: "matched_include", tradable: true }));

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    // Per plan 1.1: excluded statuses must be removed by the SQL WHERE, not
    // merely given a lower rank. They must not consume entryCandidate or
    // discoveryOnly budget.
    const allIds = [
      ...result.executionCritical,
      ...result.entryCandidates,
      ...result.discoveryOnly,
    ].map((m) => String(m.tokenId));
    expect(allIds).not.toContain("excl-m");
    expect(allIds).not.toContain("excl-f");
    expect(allIds).toContain("incl-m");
  });

  it("matched_exclude markets with open positions are STILL kept in executionCritical (safety invariant)", () => {
    // If we somehow hold a position in a market that was later excluded, the
    // WS subscription must not drop — otherwise exit pricing goes dark.
    repo.save(makeMarket("held-excl", { selectionStatus: "matched_exclude", tradable: false }));
    insertPosition("held-excl", "open");

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    const criticalIds = result.executionCritical.map((m) => String(m.tokenId));
    expect(criticalIds).toContain("held-excl");
  });

  it("large-scale: 5 critical + 1000 tradable + maxTokens=1000 → correct split", () => {
    for (let i = 0; i < 5; i++) {
      repo.save(makeMarket(`crit-lg-${i}`, { tradable: false }));
      insertPosition(`crit-lg-${i}`, "open");
    }
    const batch: Market[] = [];
    for (let i = 0; i < 1000; i++) {
      batch.push(
        makeMarket(`trad-lg-${i}`, {
          tradable: true,
          selectionStatus: i < 500 ? "matched_include" : "unknown",
          updatedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        }),
      );
    }
    repo.saveBatch(batch);

    const result = repo.findTrackedForPricingTiered({ maxTokens: 1000 });
    expect(result.executionCritical).toHaveLength(5);
    // 1000 - 5 = 995 entry candidates
    expect(result.entryCandidates).toHaveLength(995);
    expect(result.discoveryOnly).toHaveLength(5);
    // Verify no token appears in more than one tier
    const critSet = new Set(result.executionCritical.map((m) => String(m.tokenId)));
    const candSet = new Set(result.entryCandidates.map((m) => String(m.tokenId)));
    const discSet = new Set(result.discoveryOnly.map((m) => String(m.tokenId)));
    expect([...critSet].filter((id) => candSet.has(id))).toHaveLength(0);
    expect([...critSet].filter((id) => discSet.has(id))).toHaveLength(0);
    expect([...candSet].filter((id) => discSet.has(id))).toHaveLength(0);
  });
});
