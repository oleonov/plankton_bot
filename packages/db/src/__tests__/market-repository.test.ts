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

function makeMarket(overrides?: Partial<Market>): Market {
  const now = new Date().toISOString();
  return {
    tokenId: createTokenId("tok-1"),
    conditionId: "cond-1",
    slug: "test-slug",
    eventSlug: null,
    question: "Will it rain?",
    outcome: "YES" as const,
    outcomeIndex: 0,
    regime: "threshold",
    horizon: "daily",
    endDate: null,
    active: true,
    tradable: true,
    tickSize: 0.01,
    negRisk: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  db = conn.db;
  repo = new SqliteMarketRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteMarketRepository", () => {
  it("save + findByTokenId round-trip", () => {
    const m = makeMarket();
    repo.save(m);

    const found = repo.findByTokenId(createTokenId("tok-1"));
    expect(found).not.toBeNull();
    expect(found!.tokenId).toBe("tok-1");
    expect(found!.conditionId).toBe("cond-1");
    expect(found!.slug).toBe("test-slug");
    expect(found!.question).toBe("Will it rain?");
    expect(found!.outcome).toBe("YES");
    expect(found!.regime).toBe("threshold");
    expect(found!.active).toBe(true);
    expect(found!.tickSize).toBe(0.01);
    expect(found!.negRisk).toBe(false);
  });

  it("findByConditionId returns YES/NO pair", () => {
    repo.save(makeMarket({ tokenId: createTokenId("tok-yes"), outcome: "YES" }));
    repo.save(makeMarket({ tokenId: createTokenId("tok-no"), outcome: "NO" }));

    const pair = repo.findByConditionId("cond-1");
    expect(pair).toHaveLength(2);

    const outcomes = pair.map((m) => m.outcome).sort();
    expect(outcomes).toEqual(["NO", "YES"]);
  });

  it("findActive filters correctly", () => {
    repo.save(makeMarket({ tokenId: createTokenId("active-1"), active: true }));
    repo.save(makeMarket({ tokenId: createTokenId("inactive-1"), active: false }));

    const active = repo.findActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.tokenId).toBe("active-1");
  });

  it("findAll returns everything", () => {
    repo.save(makeMarket({ tokenId: createTokenId("t1") }));
    repo.save(makeMarket({ tokenId: createTokenId("t2"), active: false }));

    expect(repo.findAll()).toHaveLength(2);
  });

  it("save updates existing market (upsert)", () => {
    repo.save(makeMarket({ question: "Version 1" }));
    repo.save(makeMarket({ question: "Version 2" }));

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.question).toBe("Version 2");
  });

  it("boolean mapping works for active and negRisk", () => {
    repo.save(makeMarket({ tokenId: createTokenId("b1"), active: false, negRisk: true }));

    const found = repo.findByTokenId(createTokenId("b1"));
    expect(found!.active).toBe(false);
    expect(found!.negRisk).toBe(true);
  });

  it("findByTokenId returns null for unknown token", () => {
    const found = repo.findByTokenId(createTokenId("nonexistent"));
    expect(found).toBeNull();
  });

  it("findTrackedForPricing returns tradable + positions + orders preserved", () => {
    // tradable market
    repo.save(makeMarket({ tokenId: createTokenId("t-trad"), active: true, tradable: true }));
    // market with open position, not tradable
    repo.save(makeMarket({ tokenId: createTokenId("t-pos"), active: true, tradable: false }));
    db.prepare(
      `INSERT INTO positions (position_id, token_id, condition_id, side, size, avg_entry_price, cost_basis_usdc, current_value_usdc, realized_pnl, status, entry_style, opened_at, closed_at, updated_at)
       VALUES ('p1','t-pos','c-pos','buy',1,0.5,0.5,0.5,0,'open','probe',datetime('now'),NULL,datetime('now'))`,
    ).run();
    // market with open order, not tradable, no position
    repo.save(makeMarket({ tokenId: createTokenId("t-ord"), active: true, tradable: false }));
    db.prepare(
      `INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type, price, size, size_usdc, status, exchange_order_id, signal_id, signal_reason, bot_run_id, created_at, updated_at)
       VALUES ('o1','co1','t-ord','c-ord','buy','GTC',0.5,1,0.5,'open',NULL,NULL,NULL,'br1',datetime('now'),datetime('now'))`,
    ).run();
    // market with nothing: excluded + no legs
    repo.save(makeMarket({ tokenId: createTokenId("t-dead"), active: true, tradable: false }));

    const rows = repo.findTrackedForPricing();
    const ids = rows.map((r) => r.tokenId).sort();
    expect(ids).toEqual(["t-ord", "t-pos", "t-trad"]);
  });

  it("saveBatch inserts all markets and upserts duplicates in a single transaction", () => {
    repo.saveBatch([
      makeMarket({ tokenId: createTokenId("b-1"), slug: "s-1" }),
      makeMarket({ tokenId: createTokenId("b-2"), slug: "s-2", outcome: "NO" }),
      makeMarket({ tokenId: createTokenId("b-3"), slug: "s-3" }),
    ]);
    expect(repo.findAll()).toHaveLength(3);

    repo.saveBatch([
      makeMarket({ tokenId: createTokenId("b-1"), slug: "s-1", question: "updated" }),
      makeMarket({ tokenId: createTokenId("b-4"), slug: "s-4" }),
    ]);
    expect(repo.findAll()).toHaveLength(4);
    expect(repo.findByTokenId(createTokenId("b-1"))!.question).toBe("updated");
  });

  it("saveBatch is a no-op for empty input", () => {
    repo.saveBatch([]);
    expect(repo.findAll()).toHaveLength(0);
  });

  it("findEventMarketCountBySlug reads event_market_count for the slug", () => {
    // Insert directly to set event_market_count since Market interface doesn't expose it
    db.prepare(
      `INSERT INTO markets (token_id, condition_id, slug, question, outcome, tick_size, neg_risk, event_market_count)
       VALUES ('t-a', 'c-a', 'bitcoin-up', 'Q?', 'YES', 0.01, 0, 7)`,
    ).run();
    db.prepare(
      `INSERT INTO markets (token_id, condition_id, slug, question, outcome, tick_size, neg_risk, event_market_count)
       VALUES ('t-b', 'c-b', 'bitcoin-up', 'Q?', 'NO', 0.01, 0, 7)`,
    ).run();
    db.prepare(
      `INSERT INTO markets (token_id, condition_id, slug, question, outcome, tick_size, neg_risk, event_market_count)
       VALUES ('t-c', 'c-c', 'something-else', 'Q2?', 'YES', 0.01, 0, 1)`,
    ).run();

    expect(repo.findEventMarketCountBySlug("bitcoin-up")).toBe(7);
    expect(repo.findEventMarketCountBySlug("something-else")).toBe(1);
    expect(repo.findEventMarketCountBySlug("ghost-slug")).toBeNull();
  });
});
