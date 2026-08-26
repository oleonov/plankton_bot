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
    eventMarketCount: 1,
    gammaCreatedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
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

  it("atomically mixes full upserts with narrow signature-only updates", () => {
    repo.save(makeMarket({ tokenId: createTokenId("sig-existing"), sigLiquidity: 100 }));
    db.prepare(
      "UPDATE markets SET score = 0.42, score_model_version = 'v1' WHERE token_id = 'sig-existing'",
    ).run();
    db.exec(`CREATE TABLE broad_update_audit (hits INTEGER NOT NULL DEFAULT 0);
      INSERT INTO broad_update_audit DEFAULT VALUES;
      CREATE TRIGGER audit_broad_market_update AFTER UPDATE OF condition_id, slug, event_slug,
        question, outcome, outcome_index, regime, horizon, end_date, active, tradable, tick_size,
        neg_risk, event_market_count, selection_status, selection_winning_rule_id, gamma_created_at,
        group_item_title, group_item_threshold, tags_json, score, score_model_version ON markets
      BEGIN UPDATE broad_update_audit SET hits = hits + 1; END;`);

    const signatureUpdate = {
      tokenId: createTokenId("sig-existing"),
      sigMid: 0.2,
      sigCheapMid: 0.1,
      sigLiquidity: 900,
      sigVol24h: 300,
      sigFeaturesAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:01.000Z",
    };
    repo.saveBatchWithSignatureUpdates(
      [makeMarket({ tokenId: createTokenId("full-new"), question: "full path" })],
      [signatureUpdate],
    );

    expect(repo.findByTokenId(createTokenId("full-new"))!.question).toBe("full path");
    expect(repo.findByTokenId(createTokenId("sig-existing"))).toMatchObject({
      question: "Will it rain?",
      score: 0.42,
      scoreModelVersion: "v1",
      sigMid: 0.2,
      sigCheapMid: 0.1,
      sigLiquidity: 900,
      sigVol24h: 300,
      sigFeaturesAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:01.000Z",
    });
    expect(db.prepare("SELECT hits FROM broad_update_audit").pluck().get()).toBe(0);

    expect(() =>
      repo.saveBatchWithSignatureUpdates(
        [makeMarket({ tokenId: createTokenId("invalid"), conditionId: null as never })],
        [{ ...signatureUpdate, sigLiquidity: 1_000, updatedAt: "2026-08-26T00:00:02.000Z" }],
      ),
    ).toThrow();
    expect(repo.findByTokenId(createTokenId("sig-existing"))!.sigLiquidity).toBe(900);
  });

  // Step 0 §P1.7: when a later scan returns gammaCreatedAt=null (e.g. CLOB-only path
  // or transient Gamma omission), we MUST NOT overwrite the previously captured
  // ISO timestamp. The upsert uses COALESCE(markets.col, excluded.col).
  it("saveBatch is null-preserving for gammaCreatedAt on subsequent upsert", () => {
    repo.saveBatch([
      makeMarket({ tokenId: createTokenId("g-1"), gammaCreatedAt: "2026-04-01T12:00:00.000Z" }),
    ]);
    expect(repo.findByTokenId(createTokenId("g-1"))!.gammaCreatedAt).toBe(
      "2026-04-01T12:00:00.000Z",
    );

    // Upsert with null — must not clobber the existing ISO timestamp.
    repo.saveBatch([makeMarket({ tokenId: createTokenId("g-1"), gammaCreatedAt: null })]);
    expect(repo.findByTokenId(createTokenId("g-1"))!.gammaCreatedAt).toBe(
      "2026-04-01T12:00:00.000Z",
    );
  });

  it("saveBatch backfills gammaCreatedAt when previously null", () => {
    repo.saveBatch([makeMarket({ tokenId: createTokenId("g-2"), gammaCreatedAt: null })]);
    expect(repo.findByTokenId(createTokenId("g-2"))!.gammaCreatedAt).toBeNull();

    repo.saveBatch([
      makeMarket({ tokenId: createTokenId("g-2"), gammaCreatedAt: "2026-04-15T08:30:00.000Z" }),
    ]);
    expect(repo.findByTokenId(createTokenId("g-2"))!.gammaCreatedAt).toBe(
      "2026-04-15T08:30:00.000Z",
    );
  });

  // Track B §4.1 / §9.1 — group-item + tags persistence round-trip.
  describe("Track B strike-classifier fields", () => {
    it("migration 060 creates the three columns", () => {
      const cols = (db.prepare(`PRAGMA table_info(markets)`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).toContain("group_item_title");
      expect(cols).toContain("group_item_threshold");
      expect(cols).toContain("tags_json");
    });

    it("round-trips groupItemTitle, groupItemThreshold, and tags (JSON)", () => {
      repo.save(
        makeMarket({
          tokenId: createTokenId("tb-1"),
          groupItemTitle: "Spain",
          groupItemThreshold: "21",
          tags: ["sports", "soccer"],
        }),
      );

      const found = repo.findByTokenId(createTokenId("tb-1"));
      expect(found!.groupItemTitle).toBe("Spain");
      expect(found!.groupItemThreshold).toBe("21");
      expect(found!.tags).toEqual(["sports", "soccer"]);
    });

    it("defaults the three fields to null when omitted", () => {
      repo.save(makeMarket({ tokenId: createTokenId("tb-2") }));

      const found = repo.findByTokenId(createTokenId("tb-2"));
      expect(found!.groupItemTitle).toBeNull();
      expect(found!.groupItemThreshold).toBeNull();
      expect(found!.tags).toBeNull();
    });

    it("round-trips an empty tags array as an empty array", () => {
      repo.save(makeMarket({ tokenId: createTokenId("tb-3"), tags: [] }));

      const found = repo.findByTokenId(createTokenId("tb-3"));
      expect(found!.tags).toEqual([]);
    });
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
