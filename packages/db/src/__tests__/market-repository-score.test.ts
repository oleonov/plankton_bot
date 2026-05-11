/**
 * Step 3 (audit doc §P2 / §F3 / §F5) — soft-ranking score columns.
 *
 * Covers:
 *  - bootstrapLedgerDb upgrades a pre-043 ledger DB (no score columns) without
 *    errors, and the four score columns + `idx_markets_score` partial index
 *    are present afterwards.
 *  - runMigrations (legacy merged DB) is idempotent against 043 — running it
 *    twice on the same DB is a no-op even though the SQL file itself uses
 *    raw `ALTER TABLE ADD COLUMN`.
 *  - updateScoresBatch writes correct rows; nullable defaults survive when
 *    nothing has been written.
 *  - Score-column ownership invariant: the saveBatch upsert path does NOT
 *    touch any of the four columns — verified by string-scanning the
 *    UPSERT_MARKET_SQL constant and by behavioural test (write score, then
 *    saveBatch the same token, assert score survives unchanged).
 *  - findTrackedForPricingTiered comparator orders entry candidates by
 *    selection_status rank → effective-score DESC NULLS LAST → created_at DESC
 *    → token_id ASC; stale scores (features_captured_at < now − 4h) are
 *    treated as null so they cannot outrank a fresh lower score.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { bootstrapDatabase, bootstrapLedgerDb } from "../bootstrap.js";
import { runMigrations } from "../migrations/runner.js";
import type { DbConnection } from "../connection.js";
import { SqliteMarketRepository } from "../repositories/market-repository.js";
import { createTokenId } from "@krabs/domain";
import type { Market } from "@krabs/domain";

let tmpDir: string;

function makeMarket(
  tokenId: string,
  overrides: Partial<Market> & { createdAt?: string; updatedAt?: string } = {},
): Market {
  const createdAt = overrides.createdAt ?? "2026-01-01T00:00:00.000Z";
  const updatedAt = overrides.updatedAt ?? "2026-01-01T00:00:00.000Z";
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
    eventMarketCount: 1,
    selectionStatus: "matched_include",
    selectionWinningRuleId: null,
    gammaCreatedAt: null,
    createdAt,
    updatedAt,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-score-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── F3 — schema present after bootstrap / migration ──────────────────────

describe("ledger schema — score columns (audit §F3)", () => {
  it("bootstrapDatabase creates markets with all four score columns (nullable)", () => {
    const conn = bootstrapDatabase(path.join(tmpDir, "fresh.db"));
    try {
      const cols = conn.db.prepare("PRAGMA table_info(markets)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }>;
      const byName = new Map(cols.map((c) => [c.name, c]));

      for (const name of ["score", "score_model_version", "scored_at", "features_captured_at"]) {
        const col = byName.get(name);
        expect(col, `missing column ${name}`).toBeDefined();
        expect(col!.notnull).toBe(0);
        expect(col!.dflt_value).toBeNull();
      }
      expect(byName.get("score")!.type.toUpperCase()).toBe("REAL");
      expect(byName.get("score_model_version")!.type.toUpperCase()).toBe("TEXT");

      const indexes = conn.db.prepare("PRAGMA index_list(markets)").all() as Array<{
        name: string;
      }>;
      expect(indexes.some((i) => i.name === "idx_markets_score")).toBe(true);
    } finally {
      conn.close();
    }
  });

  it("bootstrapLedgerDb upgrades a pre-043 ledger DB without errors", () => {
    const dbPath = path.join(tmpDir, "ledger.db");
    // Pre-043 markets shape — none of the score columns. Includes the columns
    // ledger.sql already declares so the schema re-exec inside bootstrapLedgerDb
    // doesn't trip on missing-column index builds.
    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE markets (
        token_id            TEXT PRIMARY KEY,
        condition_id        TEXT NOT NULL,
        slug                TEXT NOT NULL,
        event_slug          TEXT,
        question            TEXT NOT NULL,
        outcome             TEXT NOT NULL,
        outcome_index       INTEGER,
        regime              TEXT,
        horizon             TEXT,
        end_date            TEXT,
        active              INTEGER NOT NULL,
        tradable            INTEGER NOT NULL DEFAULT 1,
        tick_size           REAL NOT NULL,
        neg_risk            INTEGER NOT NULL,
        event_market_count  INTEGER NOT NULL DEFAULT 1,
        selection_status    TEXT NOT NULL DEFAULT 'unknown'
          CHECK (selection_status IN
            ('unknown','matched_include','matched_exclude','step2_fallback_include','fallback_exclude')),
        selection_winning_rule_id TEXT,
        gamma_created_at    TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE runtime_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE risk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE portfolio_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE orders (
        order_id TEXT PRIMARY KEY,
        client_order_id TEXT,
        token_id TEXT,
        status TEXT,
        exchange_order_id TEXT,
        bot_run_id TEXT
      );

      CREATE TABLE fills (
        fill_id TEXT PRIMARY KEY,
        order_id TEXT,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL,
        size_usdc REAL,
        filled_at TEXT NOT NULL,
        liquidity_role TEXT,
        reconciled INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE leg_states (
        token_id TEXT PRIMARY KEY,
        first_trade_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE positions (
        position_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL,
        size REAL NOT NULL DEFAULT 0,
        cost_basis_usdc REAL NOT NULL DEFAULT 0,
        avg_entry_price REAL,
        opened_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE inventory_lots (
        lot_id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        fill_id TEXT NOT NULL,
        size REAL NOT NULL DEFAULT 0,
        remaining_size REAL NOT NULL DEFAULT 0,
        entry_price REAL NOT NULL DEFAULT 0,
        cost_usdc REAL NOT NULL DEFAULT 0
      );
    `);
    seed
      .prepare(
        `INSERT INTO markets
         (token_id, condition_id, slug, question, outcome, active, tradable, tick_size, neg_risk)
       VALUES ('tok-pre', 'cond', 'slug', 'Q?', 'YES', 1, 1, 0.01, 0)`,
      )
      .run();
    seed.close();

    const conn = bootstrapLedgerDb(dbPath);
    try {
      const cols = conn.db.prepare("PRAGMA table_info(markets)").all() as Array<{
        name: string;
      }>;
      const names = new Set(cols.map((c) => c.name));
      for (const n of ["score", "score_model_version", "scored_at", "features_captured_at"]) {
        expect(names.has(n)).toBe(true);
      }
      const indexes = conn.db.prepare("PRAGMA index_list(markets)").all() as Array<{
        name: string;
      }>;
      expect(indexes.some((i) => i.name === "idx_markets_score")).toBe(true);

      // Pre-existing row survived intact, score-column slots default to NULL.
      const row = conn.db
        .prepare(
          "SELECT score, score_model_version, scored_at, features_captured_at FROM markets WHERE token_id = 'tok-pre'",
        )
        .get() as Record<string, unknown>;
      expect(row.score).toBeNull();
      expect(row.score_model_version).toBeNull();
      expect(row.scored_at).toBeNull();
      expect(row.features_captured_at).toBeNull();
    } finally {
      conn.close();
    }
  });

  it("runMigrations is idempotent against 043 (re-run is a no-op)", () => {
    // Build the legacy merged DB via bootstrapDatabase, then re-invoke
    // runMigrations a second time on the same connection. The runner skips
    // already-applied filenames via schema_migrations even though the SQL
    // file itself uses raw ALTER TABLE ADD COLUMN (not self-replayable).
    const conn = bootstrapDatabase(path.join(tmpDir, "merged.db"));
    try {
      const beforeRow = conn.db
        .prepare("SELECT name FROM schema_migrations WHERE name = ?")
        .get("043_markets_score_columns.sql") as { name: string } | undefined;
      expect(beforeRow?.name).toBe("043_markets_score_columns.sql");
      const beforeCount = (
        conn.db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }
      ).c;

      // Second pass — should not re-apply the migration nor error.
      runMigrations(conn.db, path.join(import.meta.dirname, "..", "migrations"));

      const afterCount = (
        conn.db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }
      ).c;
      expect(afterCount).toBe(beforeCount);

      // Markets table still has exactly one of each score column.
      const cols = conn.db.prepare("PRAGMA table_info(markets)").all() as Array<{
        name: string;
      }>;
      const counts = new Map<string, number>();
      for (const c of cols) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
      for (const n of ["score", "score_model_version", "scored_at", "features_captured_at"]) {
        expect(counts.get(n)).toBe(1);
      }
    } finally {
      conn.close();
    }
  });
});

// ─── Score-column ownership invariant (audit §P2.4) ────────────────────────

describe("score-column ownership invariant", () => {
  it("UPSERT_MARKET_SQL never mentions any score column", () => {
    // Static guard — read the source of market-repository.ts and verify
    // the upsert constant does not name any of the four score columns.
    // A future contributor changing this would have to break this test.
    const repoSrc = readFileSync(
      path.join(import.meta.dirname, "..", "repositories", "market-repository.ts"),
      "utf-8",
    );
    const startIdx = repoSrc.indexOf("const UPSERT_MARKET_SQL = ");
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = repoSrc.indexOf("`;", startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const upsertBlock = repoSrc.slice(startIdx, endIdx);
    for (const forbidden of ["score", "score_model_version", "scored_at", "features_captured_at"]) {
      // `score_model_version` etc. must not appear at all in the upsert SQL
      // block; for the bare token `score` we test against the column-list /
      // SET-clause grammar by requiring the substring to be absent entirely.
      // (The block has no comments, so this is unambiguous.)
      expect(
        upsertBlock.includes(forbidden),
        `UPSERT_MARKET_SQL must not mention ${forbidden}`,
      ).toBe(false);
    }
  });

  it("saveBatch preserves a previously written score (does not clobber on conflict)", () => {
    const conn = bootstrapDatabase(path.join(tmpDir, "preserve.db"));
    try {
      const repo = new SqliteMarketRepository(conn.db);
      const market = makeMarket("tok-1");
      repo.save(market);

      repo.updateScoresBatch([
        {
          tokenId: market.tokenId,
          score: 0.7321,
          modelVersion: "v1.0.0-2026-05-05",
          scoredAt: "2026-05-05T12:00:00.000Z",
          featuresCapturedAt: "2026-05-05T11:59:30.000Z",
        },
      ]);

      // Re-upsert via the normal market write path with a fresh updatedAt.
      repo.saveBatch([{ ...market, updatedAt: "2026-05-05T13:00:00.000Z" }]);

      const after = repo.findByTokenId(market.tokenId)!;
      expect(after.score).toBe(0.7321);
      expect(after.scoreModelVersion).toBe("v1.0.0-2026-05-05");
      expect(after.scoredAt).toBe("2026-05-05T12:00:00.000Z");
      expect(after.featuresCapturedAt).toBe("2026-05-05T11:59:30.000Z");
      expect(after.updatedAt).toBe("2026-05-05T13:00:00.000Z");
    } finally {
      conn.close();
    }
  });
});

// ─── updateScoresBatch behaviour ───────────────────────────────────────────

describe("updateScoresBatch", () => {
  let conn: DbConnection;
  let repo: SqliteMarketRepository;

  beforeEach(() => {
    conn = bootstrapDatabase(path.join(tmpDir, "scores.db"));
    repo = new SqliteMarketRepository(conn.db);
  });

  afterEach(() => {
    conn.close();
  });

  it("writes all four columns for each row in a single transaction", () => {
    repo.saveBatch([makeMarket("tok-a"), makeMarket("tok-b"), makeMarket("tok-c")]);

    repo.updateScoresBatch([
      {
        tokenId: createTokenId("tok-a"),
        score: 0.91,
        modelVersion: "v1",
        scoredAt: "2026-05-05T10:00:00.000Z",
        featuresCapturedAt: "2026-05-05T09:59:55.000Z",
      },
      {
        tokenId: createTokenId("tok-b"),
        score: 0.13,
        modelVersion: "v1",
        scoredAt: "2026-05-05T10:00:00.000Z",
        featuresCapturedAt: "2026-05-05T09:59:55.000Z",
      },
    ]);

    const a = repo.findByTokenId(createTokenId("tok-a"))!;
    const b = repo.findByTokenId(createTokenId("tok-b"))!;
    const c = repo.findByTokenId(createTokenId("tok-c"))!;

    expect(a.score).toBe(0.91);
    expect(a.scoreModelVersion).toBe("v1");
    expect(a.scoredAt).toBe("2026-05-05T10:00:00.000Z");
    expect(a.featuresCapturedAt).toBe("2026-05-05T09:59:55.000Z");
    expect(b.score).toBe(0.13);
    // Rows not in the batch retain NULL.
    expect(c.score).toBeNull();
    expect(c.scoredAt).toBeNull();
  });

  it("silently skips updates for unknown token_ids (UPDATE WHERE no-match)", () => {
    repo.saveBatch([makeMarket("tok-known")]);
    expect(() =>
      repo.updateScoresBatch([
        {
          tokenId: createTokenId("tok-missing"),
          score: 0.5,
          modelVersion: "v1",
          scoredAt: "2026-05-05T10:00:00.000Z",
          featuresCapturedAt: "2026-05-05T09:59:55.000Z",
        },
      ]),
    ).not.toThrow();

    const known = repo.findByTokenId(createTokenId("tok-known"))!;
    expect(known.score).toBeNull();
    expect(repo.findByTokenId(createTokenId("tok-missing"))).toBeNull();
  });

  it("empty batch is a no-op", () => {
    repo.saveBatch([makeMarket("tok-x")]);
    repo.updateScoresBatch([]);
    const x = repo.findByTokenId(createTokenId("tok-x"))!;
    expect(x.score).toBeNull();
  });

  it("re-running an update overwrites the previous score", () => {
    repo.saveBatch([makeMarket("tok-a")]);
    repo.updateScoresBatch([
      {
        tokenId: createTokenId("tok-a"),
        score: 0.1,
        modelVersion: "v1",
        scoredAt: "2026-05-05T10:00:00.000Z",
        featuresCapturedAt: "2026-05-05T09:59:55.000Z",
      },
    ]);
    repo.updateScoresBatch([
      {
        tokenId: createTokenId("tok-a"),
        score: 0.9,
        modelVersion: "v1",
        scoredAt: "2026-05-05T10:01:00.000Z",
        featuresCapturedAt: "2026-05-05T10:00:55.000Z",
      },
    ]);
    const after = repo.findByTokenId(createTokenId("tok-a"))!;
    expect(after.score).toBe(0.9);
    expect(after.scoredAt).toBe("2026-05-05T10:01:00.000Z");
    expect(after.featuresCapturedAt).toBe("2026-05-05T10:00:55.000Z");
  });
});

// ─── findTrackedForPricingTiered comparator (audit §F5) ────────────────────

describe("findTrackedForPricingTiered — score-aware comparator", () => {
  let conn: DbConnection;
  let repo: SqliteMarketRepository;

  beforeEach(() => {
    conn = bootstrapDatabase(path.join(tmpDir, "tier.db"));
    repo = new SqliteMarketRepository(conn.db);
  });

  afterEach(() => {
    conn.close();
  });

  it("orders same-tier markets by fresh score DESC NULLS LAST", () => {
    const now = new Date();
    const fresh = new Date(now.getTime() - 60_000).toISOString(); // 1 min ago
    repo.saveBatch([
      makeMarket("low", { selectionStatus: "matched_include" }),
      makeMarket("high", { selectionStatus: "matched_include" }),
      makeMarket("nil", { selectionStatus: "matched_include" }),
    ]);
    repo.updateScoresBatch([
      {
        tokenId: createTokenId("low"),
        score: 0.2,
        modelVersion: "v1",
        scoredAt: fresh,
        featuresCapturedAt: fresh,
      },
      {
        tokenId: createTokenId("high"),
        score: 0.8,
        modelVersion: "v1",
        scoredAt: fresh,
        featuresCapturedAt: fresh,
      },
    ]);

    const result = repo.findTrackedForPricingTiered({ maxTokens: 100 });
    const ids = result.entryCandidates.map((m) => String(m.tokenId));
    // high (0.8) > low (0.2) > nil (NULL) — null sorts last.
    expect(ids).toEqual(["high", "low", "nil"]);
  });

  it("treats stale scores (>4h old) as null so they cannot outrank a fresh lower score", () => {
    const now = new Date();
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    const stale = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(); // 5h ago

    repo.saveBatch([
      makeMarket("stale-high", { selectionStatus: "matched_include" }),
      makeMarket("fresh-low", { selectionStatus: "matched_include" }),
    ]);
    repo.updateScoresBatch([
      {
        tokenId: createTokenId("stale-high"),
        score: 0.99,
        modelVersion: "v1",
        scoredAt: stale,
        featuresCapturedAt: stale,
      },
      {
        tokenId: createTokenId("fresh-low"),
        score: 0.05,
        modelVersion: "v1",
        scoredAt: fresh,
        featuresCapturedAt: fresh,
      },
    ]);

    const result = repo.findTrackedForPricingTiered({ maxTokens: 100 });
    const ids = result.entryCandidates.map((m) => String(m.tokenId));
    // Fresh 0.05 must outrank stale 0.99.
    expect(ids).toEqual(["fresh-low", "stale-high"]);
  });

  it("selection_status rank dominates score ordering across tiers", () => {
    const now = new Date();
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    repo.saveBatch([
      makeMarket("step2", { selectionStatus: "step2_fallback_include" }),
      makeMarket("matched", { selectionStatus: "matched_include" }),
    ]);
    repo.updateScoresBatch([
      // step2 has an absurdly high score, but matched_include rank wins.
      {
        tokenId: createTokenId("step2"),
        score: 0.99,
        modelVersion: "v1",
        scoredAt: fresh,
        featuresCapturedAt: fresh,
      },
      {
        tokenId: createTokenId("matched"),
        score: 0.01,
        modelVersion: "v1",
        scoredAt: fresh,
        featuresCapturedAt: fresh,
      },
    ]);

    const result = repo.findTrackedForPricingTiered({ maxTokens: 100 });
    const ids = result.entryCandidates.map((m) => String(m.tokenId));
    expect(ids).toEqual(["matched", "step2"]);
  });

  it("ties on (rank, effectiveScore) fall back to created_at DESC then token_id ASC", () => {
    const now = new Date();
    const fresh = new Date(now.getTime() - 60_000).toISOString();
    repo.saveBatch([
      makeMarket("zzz", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeMarket("aaa", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-02T00:00:00.000Z", // newer
      }),
      makeMarket("bbb", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-02T00:00:00.000Z", // ties with aaa on createdAt
      }),
    ]);
    // All same fresh score → comparator drops to created_at then token_id.
    repo.updateScoresBatch(
      ["zzz", "aaa", "bbb"].map((id) => ({
        tokenId: createTokenId(id),
        score: 0.5,
        modelVersion: "v1",
        scoredAt: fresh,
        featuresCapturedAt: fresh,
      })),
    );

    const result = repo.findTrackedForPricingTiered({ maxTokens: 100 });
    const ids = result.entryCandidates.map((m) => String(m.tokenId));
    // newer createdAt first; aaa < bbb lex; zzz oldest goes last.
    expect(ids).toEqual(["aaa", "bbb", "zzz"]);
  });

  it("all-null scores in the same tier degenerate to created_at DESC + token_id ASC", () => {
    repo.saveBatch([
      makeMarket("a", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeMarket("b", {
        selectionStatus: "matched_include",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);
    const result = repo.findTrackedForPricingTiered({ maxTokens: 100 });
    expect(result.entryCandidates.map((m) => String(m.tokenId))).toEqual(["b", "a"]);
  });
});
