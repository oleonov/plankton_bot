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
import { createTokenId } from "@krabs/domain";
import type { Market } from "@krabs/domain";
import type Database from "better-sqlite3";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteMarketRepository;
let db: Database.Database;

const NOW_BASE = "2026-01-01T00:00:00.000Z";

function makeMarket(
  tokenId: string,
  overrides: Partial<Market> & { createdAt?: string; updatedAt?: string } = {},
): Market {
  const createdAt = overrides.createdAt ?? NOW_BASE;
  const updatedAt = overrides.updatedAt ?? NOW_BASE;
  return {
    tokenId: createTokenId(tokenId),
    conditionId: `cond-${tokenId}`,
    slug: `bitcoin-${tokenId}`,
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
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt,
    updatedAt,
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

function insertSnapshot(
  tokenId: string,
  overrides: {
    liquidity?: number | null;
    volume24h?: number | null;
    bestBid?: number | null;
    bestAsk?: number | null;
  } = {},
): void {
  const liquidity = Object.hasOwn(overrides, "liquidity") ? overrides.liquidity : 100;
  const volume24h = Object.hasOwn(overrides, "volume24h") ? overrides.volume24h : 5;
  const bestBid = Object.hasOwn(overrides, "bestBid") ? overrides.bestBid : 0.1;
  const bestAsk = Object.hasOwn(overrides, "bestAsk") ? overrides.bestAsk : 0.2;
  db.prepare(
    `INSERT INTO market_snapshots
       (token_id, best_bid, best_ask, last_price, volume_24h, liquidity, captured_at)
     VALUES (?,?,?,?,?,?,datetime('now'))`,
  ).run(tokenId, bestBid, bestAsk, 0.15, volume24h, liquidity);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-tiered-test-"));
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
      insertSnapshot(`t-${i}`);
    }
    const result = repo.findTrackedForPricingTiered({ maxTokens: 3 });
    expect(result.executionCritical).toHaveLength(0);
    expect(result.entryCandidates).toHaveLength(3);
    expect(result.discoveryOnly).toHaveLength(2);
    expect(result.discoveryCapacityCount).toBe(2);
  });

  it("V4 priority pool excludes low-liquidity or low-volume markets from entryCandidates", () => {
    repo.save(makeMarket("good", { slug: "bitcoin-good" }));
    repo.save(makeMarket("low-liq", { slug: "bitcoin-low-liq" }));
    repo.save(makeMarket("low-vol", { slug: "bitcoin-low-vol" }));
    insertSnapshot("good", { liquidity: 100, volume24h: 5 });
    insertSnapshot("low-liq", { liquidity: 99.99, volume24h: 100 });
    insertSnapshot("low-vol", { liquidity: 100, volume24h: 4.99 });

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });

    expect(result.entryCandidates.map((m) => String(m.tokenId))).toEqual(["good"]);
    expect(result.discoveryOnly.map((m) => String(m.tokenId)).sort()).toEqual([
      "low-liq",
      "low-vol",
    ]);
    expect(result.discoveryCapacityCount).toBe(0);
  });

  it("exposes latest V4 admission telemetry from the tiered pricing scan", () => {
    repo.save(makeMarket("good", { slug: "bitcoin-good" }));
    repo.save(makeMarket("low-liq", { slug: "bitcoin-low-liq" }));
    repo.save(makeMarket("cold", { slug: "unclassified-cold-market" }));
    insertSnapshot("good", { liquidity: 100, volume24h: 5 });
    insertSnapshot("low-liq", { liquidity: 99, volume24h: 100 });
    insertSnapshot("cold", { liquidity: 100, volume24h: 100 });

    repo.findTrackedForPricingTiered({ maxTokens: 10 });
    const telemetry = repo.getV4AdmissionTelemetrySnapshot();

    expect(telemetry.evaluatedTotal).toBe(3);
    expect(telemetry.admitCountTotal).toBe(1);
    expect(telemetry.rejectCountTotal).toBe(2);
    expect(telemetry.admitRate).toBeCloseTo(1 / 3, 6);
    expect(telemetry.seenCountByCategory["crypto-btc"]).toBe(2);
    expect(telemetry.admitCountByCategory["crypto-btc"]).toBe(1);
    expect(telemetry.rejectCountByReason.rejected_liquidity_below_100).toBe(1);
    expect(telemetry.rejectCountByReason.rejected_category_not_in_hot_cats).toBe(1);
  });

  it("V4 priority pool rejects missing liquidity metadata for hot categories", () => {
    repo.save(makeMarket("missing-snapshot", { slug: "ethereum-missing-snapshot" }));

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });

    expect(result.entryCandidates.map((m) => String(m.tokenId))).toEqual([]);
    expect(result.discoveryOnly.map((m) => String(m.tokenId))).toEqual(["missing-snapshot"]);
  });

  it("attributes exact target routes without changing the trading tiers", () => {
    repo.save(makeMarket("critical", { tradable: false }));
    insertPosition("critical", "open");
    repo.save(makeMarket("admitted-first", { createdAt: "2026-01-03T00:00:00.000Z" }));
    repo.save(makeMarket("admitted-overflow", { createdAt: "2026-01-02T00:00:00.000Z" }));
    repo.save(makeMarket("rejected", { slug: "unclassified-market" }));
    repo.save(makeMarket("not-targeted", { createdAt: "2026-01-04T00:00:00.000Z" }));
    for (const tokenId of ["admitted-first", "admitted-overflow", "rejected", "not-targeted"]) {
      insertSnapshot(tokenId);
    }

    const baseline = repo.findTrackedForPricingTiered({ maxTokens: 3 });
    const capturedBefore = Date.now();
    const result = repo.findTrackedForPricingTiered({
      maxTokens: 3,
      targetTokenIds: new Set(["critical", "admitted-first", "admitted-overflow", "rejected"]),
    });

    expect({ ...result, targetRoutes: undefined }).toEqual({
      ...baseline,
      targetRoutes: undefined,
    });
    expect(result.targetRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tokenId: "critical", route: "execution_critical" }),
        expect.objectContaining({
          tokenId: "admitted-first",
          route: "entry_candidate",
          admissionRank: 2,
          capacitySlots: 2,
        }),
        expect.objectContaining({ tokenId: "admitted-overflow", route: "discovery_capacity" }),
        expect.objectContaining({
          tokenId: "rejected",
          route: "discovery_v4_reject",
          v4Reason: "category_not_hot",
        }),
      ]),
    );
    expect(result.targetRoutes).toHaveLength(4);
    expect(result.targetRoutes?.every((fact) => fact.capturedAtMs >= capturedBefore)).toBe(true);
    expect(result.targetRoutes?.some((fact) => fact.tokenId === "not-targeted")).toBe(false);
  });

  it("V4 priority pool admits null-liquidity markets through the orderbook proxy", () => {
    repo.save(makeMarket("proxy", { slug: "ethereum-orderbook-proxy" }));
    insertSnapshot("proxy", { liquidity: null, volume24h: null, bestBid: 0.4, bestAsk: 0.45 });

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });

    expect(result.entryCandidates.map((m) => String(m.tokenId))).toEqual(["proxy"]);
  });

  it("V4 telemetry exposes null-liquidity orderbook proxy rejection", () => {
    repo.save(makeMarket("valid", { slug: "ethereum-valid" }));
    insertSnapshot("valid", { liquidity: 100, volume24h: 5 });
    for (let i = 0; i < 5; i++) {
      repo.save(makeMarket(`missing-${i}`, { slug: `ethereum-missing-${i}` }));
    }

    repo.findTrackedForPricingTiered({ maxTokens: 10 });
    const telemetry = repo.getV4AdmissionTelemetrySnapshot();

    expect(telemetry.evaluatedTotal).toBe(6);
    expect(telemetry.admitCountTotal).toBe(1);
    expect(telemetry.rejectCountByReason.rejected_no_orderbook_proxy).toBe(5);
    expect(telemetry.admitRate).toBeCloseTo(1 / 6, 6);
  });

  it("executionCritical: markets with open positions are always included", () => {
    repo.save(makeMarket("crit-pos", { tradable: false }));
    insertPosition("crit-pos", "open");
    repo.save(makeMarket("crit-dust", { tradable: false }));
    insertPosition("crit-dust", "dust");
    repo.save(makeMarket("trad-only", { tradable: true }));
    insertSnapshot("trad-only");

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
    insertSnapshot("trad-only-2");

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
    for (const tokenId of ["u-1", "s2-1", "mi-1"]) insertSnapshot(tokenId);

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    expect(result.entryCandidates).toHaveLength(3);
    expect(String(result.entryCandidates[0]!.tokenId)).toBe("mi-1"); // rank 0
    expect(String(result.entryCandidates[1]!.tokenId)).toBe("s2-1"); // rank 1
    expect(String(result.entryCandidates[2]!.tokenId)).toBe("u-1"); // rank 2
  });

  it("within same selection_status tier, newer created_at wins", () => {
    repo.save(
      makeMarket("mi-old", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );
    repo.save(
      makeMarket("mi-new", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-01-05T00:00:00Z",
      }),
    );
    repo.save(
      makeMarket("mi-mid", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-03T00:00:00Z",
        updatedAt: "2026-01-03T00:00:00Z",
      }),
    );
    for (const tokenId of ["mi-old", "mi-new", "mi-mid"]) insertSnapshot(tokenId);

    const result = repo.findTrackedForPricingTiered({ maxTokens: 10 });
    const ids = result.entryCandidates.map((m) => String(m.tokenId));
    expect(ids[0]).toBe("mi-new");
    expect(ids[1]).toBe("mi-mid");
    expect(ids[2]).toBe("mi-old");
  });

  it("uses token_id as a deterministic tie-break when selection rank and timestamps match", () => {
    repo.save(
      makeMarket("mi-b", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
      }),
    );
    repo.save(
      makeMarket("mi-a", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
      }),
    );
    repo.save(
      makeMarket("mi-c", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-05T00:00:00Z",
        updatedAt: "2026-02-01T00:00:00Z",
      }),
    );
    for (const tokenId of ["mi-b", "mi-a", "mi-c"]) insertSnapshot(tokenId);

    const first = repo.findTrackedForPricingTiered({ maxTokens: 2 });
    const second = repo.findTrackedForPricingTiered({ maxTokens: 2 });

    expect(first.entryCandidates.map((m) => String(m.tokenId))).toEqual(["mi-a", "mi-b"]);
    expect(second.entryCandidates.map((m) => String(m.tokenId))).toEqual(["mi-a", "mi-b"]);
  });

  it("discovery: no limit — returns all remaining tradable markets beyond cap", () => {
    for (let i = 0; i < 20; i++) {
      repo.save(makeMarket(`disc-${i}`, { tradable: true }));
      insertSnapshot(`disc-${i}`);
    }
    const result = repo.findTrackedForPricingTiered({ maxTokens: 5 });
    expect(result.entryCandidates).toHaveLength(5);
    expect(result.discoveryOnly).toHaveLength(15);
  });

  it("inactive markets are never returned in any tier", () => {
    repo.save(makeMarket("inactive-trad", { active: false, tradable: true }));
    repo.save(makeMarket("active-trad", { active: true, tradable: true }));
    insertSnapshot("active-trad");

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
    insertSnapshot("incl-m");

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
          createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
          updatedAt: "2026-02-01T00:00:00Z",
        }),
      );
    }
    repo.saveBatch(batch);
    for (let i = 0; i < 1000; i++) insertSnapshot(`trad-lg-${i}`);

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
