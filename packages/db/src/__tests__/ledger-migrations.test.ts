import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { applySafeAddColumnStatements, runMigrations } from "../migrations/runner.js";

let tmpDir: string;
let dbPath: string;
let db: Database.Database;

function readMigration(filename: string): string {
  return readFileSync(path.join(import.meta.dirname, "..", "migrations", filename), "utf-8");
}

/**
 * Minimal positions table matching the pre-032 shape — enough to exercise
 * migration 032's repair + partial unique index without pulling in the full
 * legacy merged schema.
 */
function createMinimalPositionsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE positions (
      position_id        TEXT PRIMARY KEY,
      token_id           TEXT NOT NULL,
      family_id          TEXT,
      condition_id       TEXT NOT NULL DEFAULT '',
      side               TEXT NOT NULL,
      size               REAL NOT NULL DEFAULT 0,
      avg_entry_price    REAL NOT NULL DEFAULT 0,
      cost_basis_usdc    REAL NOT NULL DEFAULT 0,
      current_value_usdc REAL,
      realized_pnl       REAL NOT NULL DEFAULT 0,
      status             TEXT NOT NULL DEFAULT 'open',
      entry_style        TEXT,
      opened_at          TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at          TEXT,
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_positions_status ON positions(status);
    CREATE INDEX idx_positions_token ON positions(token_id);
  `);
}

function insertPosition(
  db: Database.Database,
  args: {
    positionId: string;
    tokenId: string;
    status: "open" | "dust" | "closed";
    openedAt: string;
    updatedAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO positions
       (position_id, token_id, side, status, opened_at, updated_at)
     VALUES (?, ?, 'buy', ?, ?, ?)`,
  ).run(args.positionId, args.tokenId, args.status, args.openedAt, args.updatedAt ?? args.openedAt);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-ledger-migr-"));
  dbPath = path.join(tmpDir, "ledger.db");
  db = new Database(dbPath);
  createMinimalPositionsTable(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("migration 032 — unique open position per token", () => {
  it("repairs pre-existing duplicate opens by closing the older row", () => {
    insertPosition(db, {
      positionId: "p-old",
      tokenId: "tok-1",
      status: "open",
      openedAt: "2026-01-01T00:00:00Z",
    });
    insertPosition(db, {
      positionId: "p-new",
      tokenId: "tok-1",
      status: "open",
      openedAt: "2026-01-02T00:00:00Z",
    });

    db.exec(readMigration("032_unique_open_position_per_token.sql"));

    const rows = db
      .prepare("SELECT position_id, status, closed_at FROM positions ORDER BY position_id")
      .all() as Array<{ position_id: string; status: string; closed_at: string | null }>;
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.position_id === "p-old")!;
    const newer = rows.find((r) => r.position_id === "p-new")!;
    expect(old.status).toBe("closed");
    expect(old.closed_at).not.toBeNull();
    expect(newer.status).toBe("open");
  });

  it("tie-breaks identical opened_at by position_id — lower position_id closed", () => {
    insertPosition(db, {
      positionId: "p-aaa",
      tokenId: "tok-1",
      status: "open",
      openedAt: "2026-01-01T00:00:00Z",
    });
    insertPosition(db, {
      positionId: "p-bbb",
      tokenId: "tok-1",
      status: "open",
      openedAt: "2026-01-01T00:00:00Z",
    });

    db.exec(readMigration("032_unique_open_position_per_token.sql"));

    const rows = db
      .prepare("SELECT position_id, status FROM positions ORDER BY position_id")
      .all() as Array<{ position_id: string; status: string }>;
    expect(rows.find((r) => r.position_id === "p-aaa")!.status).toBe("closed");
    expect(rows.find((r) => r.position_id === "p-bbb")!.status).toBe("open");
  });

  it("creates the partial unique index", () => {
    db.exec(readMigration("032_unique_open_position_per_token.sql"));

    const idx = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_positions_unique_open_per_token'",
      )
      .get();
    expect(idx).toBeDefined();
  });

  it("blocks a second open row on the same token via SQLITE_CONSTRAINT_UNIQUE", () => {
    db.exec(readMigration("032_unique_open_position_per_token.sql"));
    insertPosition(db, {
      positionId: "p-first",
      tokenId: "tok-1",
      status: "open",
      openedAt: "2026-01-01T00:00:00Z",
    });

    expect(() =>
      insertPosition(db, {
        positionId: "p-second",
        tokenId: "tok-1",
        status: "open",
        openedAt: "2026-01-02T00:00:00Z",
      }),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("allows open + dust coexistence for the same token (partial index excludes dust)", () => {
    db.exec(readMigration("032_unique_open_position_per_token.sql"));
    insertPosition(db, {
      positionId: "p-open",
      tokenId: "tok-1",
      status: "open",
      openedAt: "2026-01-01T00:00:00Z",
    });

    expect(() =>
      insertPosition(db, {
        positionId: "p-dust",
        tokenId: "tok-1",
        status: "dust",
        openedAt: "2026-01-02T00:00:00Z",
      }),
    ).not.toThrow();

    const rows = db
      .prepare("SELECT status FROM positions WHERE token_id = 'tok-1'")
      .all() as Array<{ status: string }>;
    expect(rows).toHaveLength(2);
  });

  it("is idempotent — applying twice does not error", () => {
    insertPosition(db, {
      positionId: "p-only",
      tokenId: "tok-1",
      status: "open",
      openedAt: "2026-01-01T00:00:00Z",
    });

    db.exec(readMigration("032_unique_open_position_per_token.sql"));
    expect(() => db.exec(readMigration("032_unique_open_position_per_token.sql"))).not.toThrow();
  });
});

describe("migration 071 — signal feed buckets", () => {
  it("creates the signal_feed_buckets table, primary key, and lookup indexes", () => {
    db.exec(readMigration("071_signal_feed_buckets.sql"));

    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signal_feed_buckets'",
      )
      .get();
    expect(table).toBeDefined();

    const columns = db.prepare("PRAGMA table_info(signal_feed_buckets)").all() as Array<{
      name: string;
      type: string;
      notnull: 0 | 1;
      pk: number;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      "token_id",
      "bucket_start_ms",
      "bucket_granularity_ms",
      "open_mid",
      "high_mid",
      "low_mid",
      "close_mid",
      "sample_count",
      "trade_count",
      "notional_sum",
      "created_at_ms",
    ]);
    expect(
      columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
    ).toEqual(["token_id", "bucket_granularity_ms", "bucket_start_ms"]);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all("signal_feed_buckets") as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_signal_feed_buckets_token_time",
        "idx_signal_feed_buckets_granularity_time",
      ]),
    );

    db.exec(readMigration("071_signal_feed_buckets.sql"));
  });
});

describe("migration 090 — signal_feed_buckets age index", () => {
  /**
   * The retention sweep's own tests hand-create `signal_feed_buckets`, so they stay green whether
   * or not this migration exists — and on production the missing index is not a correctness bug
   * but a 2.3–3.9 s synchronous stall per sweep on a 35.1M-row table. So run the REAL migration
   * set end-to-end and check the plan, not just the presence of a file.
   */
  it("makes the age-only retention sweep a range seek instead of a full scan + sort", () => {
    const migrated = new Database(":memory:");
    try {
      runMigrations(migrated);

      const indexed = migrated
        .prepare("PRAGMA index_info(idx_signal_feed_buckets_start_ms)")
        .all() as Array<{ name: string }>;
      expect(indexed.map((column) => column.name)).toEqual(["bucket_start_ms"]);

      // The shape `LedgerRetentionModule.deleteOlderThanTask` builds for this table: age-only
      // predicate, deliberately NOT pinned to a bucket_granularity_ms (a fixed granularity is
      // what made signal-feed-manager's own prune match zero rows for 44 days), so neither
      // existing index — both lead with another column — can serve it.
      const plan = migrated
        .prepare(
          `EXPLAIN QUERY PLAN
           DELETE FROM signal_feed_buckets
           WHERE rowid IN (
             SELECT rowid FROM signal_feed_buckets
             WHERE bucket_start_ms < ?
             ORDER BY bucket_start_ms ASC, rowid ASC
             LIMIT ?
           )`,
        )
        .all(0, 1) as Array<{ detail: string }>;
      const details = plan.map((step) => step.detail);

      expect(details).toEqual(
        expect.arrayContaining([
          expect.stringContaining("SEARCH signal_feed_buckets"),
          expect.stringContaining("idx_signal_feed_buckets_start_ms"),
        ]),
      );
      // Without the index the planner falls back to a full covering scan of
      // idx_signal_feed_buckets_granularity_time plus a temp sort — the 3898 ms measured case.
      expect(details.join(" | ")).not.toContain("TEMP B-TREE");
    } finally {
      migrated.close();
    }
  });
});

describe("migration 074 — dust auto close state", () => {
  it("creates the dust_auto_close_state table, retry index, and status check", () => {
    db.exec(readMigration("074_dust_auto_close_state.sql"));

    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dust_auto_close_state'",
      )
      .get();
    expect(table).toBeDefined();

    const columns = db.prepare("PRAGMA table_info(dust_auto_close_state)").all() as Array<{
      name: string;
      type: string;
      notnull: 0 | 1;
      pk: number;
      dflt_value: string | null;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      "token_id",
      "status",
      "last_attempt_at_ms",
      "last_attempt_reason",
      "next_retry_at_ms",
      "consecutive_attempts",
      "created_at_ms",
      "updated_at_ms",
    ]);
    expect(columns.find((column) => column.name === "token_id")?.pk).toBe(1);
    expect(columns.find((column) => column.name === "consecutive_attempts")?.dflt_value).toBe("0");

    const retryIndex = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dust_auto_close_state_next_retry'",
      )
      .get();
    expect(retryIndex).toBeDefined();

    expect(() =>
      db
        .prepare(
          `INSERT INTO dust_auto_close_state
             (token_id, status, last_attempt_at_ms, next_retry_at_ms, created_at_ms, updated_at_ms)
           VALUES ('tok', 'invalid', 1, 2, 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});

describe("migration 072 — profile ladder state", () => {
  it("creates profile_ladder_state with primary key, lifecycle columns, and lookup indexes", () => {
    db.exec(readMigration("072_profile_ladder_state.sql"));

    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profile_ladder_state'",
      )
      .get();
    expect(table).toBeDefined();

    const columns = db.prepare("PRAGMA table_info(profile_ladder_state)").all() as Array<{
      name: string;
      type: string;
      notnull: 0 | 1;
      pk: number;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      "token_id",
      "condition_id",
      "ladder_id",
      "band",
      "phase",
      "status",
      "active_rungs_json",
      "filled_rungs_json",
      "last_avg_entry",
      "last_cost_basis_usdc",
      "last_mode",
      "last_bbo_reference_json",
      "last_rebuild_at_ms",
      "last_fill_at_ms",
      "stale_checked_at_ms",
      "qd_handoff_at_ms",
      "closed_at_ms",
      "created_at_ms",
      "updated_at_ms",
      "metadata_json",
    ]);
    expect(columns.find((column) => column.name === "token_id")?.pk).toBe(1);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all("profile_ladder_state") as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_profile_ladder_state_status",
        "idx_profile_ladder_state_band_status",
        "idx_profile_ladder_state_updated",
      ]),
    );

    expect(() => db.exec(readMigration("072_profile_ladder_state.sql"))).not.toThrow();
  });
});

describe("migration 073 — execution profile abandoned dormant state", () => {
  it("widens execution_profile_state state CHECK to accept ABANDONED_DORMANT", () => {
    db.exec(readMigration("069_execution_profile_state.sql"));
    db.exec(
      applySafeAddColumnStatements(db, readMigration("070_execution_profile_scale_in_columns.sql")),
    );

    expect(() =>
      db
        .prepare(
          `INSERT INTO execution_profile_state
             (token_id, condition_id, profile, state, assumed_at, last_avg_entry,
              last_transition_at, created_at, updated_at)
           VALUES ('tok-before', 'cond-before', 'cheap', 'ABANDONED_DORMANT',
                   '2026-06-15T00:00:00.000Z', 0.04,
                   '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z',
                   '2026-06-15T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    db.exec(readMigration("073_abandoned_dormant_state.sql"));

    expect(() =>
      db
        .prepare(
          `INSERT INTO execution_profile_state
             (token_id, condition_id, profile, state, assumed_at, last_avg_entry,
              last_transition_at, created_at, updated_at)
           VALUES ('tok-after', 'cond-after', 'cheap', 'ABANDONED_DORMANT',
                   '2026-06-15T00:00:00.000Z', 0.04,
                   '2026-06-15T00:00:00.000Z', '2026-06-15T00:00:00.000Z',
                   '2026-06-15T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow();
  });
});

describe("migration 076 — execution profile harvesting state", () => {
  it("widens execution_profile_state state CHECK to accept HARVESTING and preserves rows/indexes", () => {
    db.exec(readMigration("069_execution_profile_state.sql"));
    db.exec(
      applySafeAddColumnStatements(db, readMigration("070_execution_profile_scale_in_columns.sql")),
    );
    db.exec(readMigration("073_abandoned_dormant_state.sql"));

    db.prepare(
      `INSERT INTO execution_profile_state
         (token_id, condition_id, profile, state, assumed_at, last_avg_entry,
          last_transition_at, metadata_json, created_at, updated_at)
       VALUES ('tok-existing', 'cond-existing', 'cheap', 'ACCUMULATING',
               '2026-06-21T00:00:00.000Z', 0.04,
               '2026-06-21T00:00:00.000Z', '{"kept":true}',
               '2026-06-21T00:00:00.000Z', '2026-06-21T00:00:00.000Z')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO execution_profile_state
             (token_id, condition_id, profile, state, assumed_at, last_avg_entry,
              last_transition_at, created_at, updated_at)
           VALUES ('tok-before', 'cond-before', 'cheap', 'HARVESTING',
                   '2026-06-21T00:00:00.000Z', 0.04,
                   '2026-06-21T00:00:00.000Z', '2026-06-21T00:00:00.000Z',
                   '2026-06-21T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    db.exec(readMigration("076_harvesting_state.sql"));

    expect(() =>
      db
        .prepare(
          `INSERT INTO execution_profile_state
             (token_id, condition_id, profile, state, assumed_at, last_avg_entry,
              last_transition_at, created_at, updated_at)
           VALUES ('tok-after', 'cond-after', 'cheap', 'HARVESTING',
                   '2026-06-21T00:00:00.000Z', 0.04,
                   '2026-06-21T00:00:00.000Z', '2026-06-21T00:00:00.000Z',
                   '2026-06-21T00:00:00.000Z')`,
        )
        .run(),
    ).not.toThrow();

    const existing = db
      .prepare("SELECT state, metadata_json FROM execution_profile_state WHERE token_id = ?")
      .get("tok-existing") as { state: string; metadata_json: string };
    expect(existing).toEqual({ state: "ACCUMULATING", metadata_json: '{"kept":true}' });

    expect(() =>
      db
        .prepare(
          `INSERT INTO execution_profile_state
             (token_id, condition_id, profile, state, assumed_at, last_avg_entry,
              last_transition_at, created_at, updated_at)
           VALUES ('tok-bad', 'cond-bad', 'cheap', 'NOT_A_STATE',
                   '2026-06-21T00:00:00.000Z', 0.04,
                   '2026-06-21T00:00:00.000Z', '2026-06-21T00:00:00.000Z',
                   '2026-06-21T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    const indexes = db.prepare("PRAGMA index_list('execution_profile_state')").all() as Array<{
      name: string;
    }>;
    expect(indexes.map((row) => row.name).sort()).toEqual(
      expect.arrayContaining([
        "idx_execution_profile_state_ladder",
        "idx_execution_profile_state_profile",
        "idx_execution_profile_state_state",
      ]),
    );
  });
});

describe("migration 067 — Track R liquidation reporting columns", () => {
  beforeEach(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile TEXT NOT NULL,
        equity_usdc REAL NOT NULL,
        wallet_usdc REAL,
        position_value_usdc REAL NOT NULL,
        realized_pnl_usdc REAL NOT NULL,
        open_value_usdc REAL NOT NULL,
        captured_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  it("adds nullable liquidation fields without backfilling existing rows", () => {
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
       VALUES ('pos-r7', 'tok-r7', 'cond-r7', 'buy', 100, 0.1, 10, 50, 0, 'open',
               '2026-06-12T00:00:00.000Z', '2026-06-12T00:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO portfolio_snapshots
         (profile, equity_usdc, wallet_usdc, position_value_usdc,
          realized_pnl_usdc, open_value_usdc, captured_at)
       VALUES ('live-lite', 100, 50, 50, 0, 10, '2026-06-12T00:00:00.000Z')`,
    ).run();

    db.exec(applySafeAddColumnStatements(db, readMigration("067_track_r_liquidation_values.sql")));

    const position = db
      .prepare(
        `SELECT liquidation_value_usdc, liquidation_price, liquidation_depth_exhausted,
                liquidation_value_updated_at
         FROM positions WHERE position_id = 'pos-r7'`,
      )
      .get() as Record<string, unknown>;
    expect(position).toEqual({
      liquidation_value_usdc: null,
      liquidation_price: null,
      liquidation_depth_exhausted: 0,
      liquidation_value_updated_at: null,
    });

    const snapshot = db
      .prepare(
        `SELECT liquidation_value_usdc, unrealized_pnl_mid_usdc,
                unrealized_pnl_liquidation_usdc, total_equity_liquidation_usdc
         FROM portfolio_snapshots WHERE profile = 'live-lite'`,
      )
      .get() as Record<string, unknown>;
    expect(snapshot).toEqual({
      liquidation_value_usdc: null,
      unrealized_pnl_mid_usdc: null,
      unrealized_pnl_liquidation_usdc: null,
      total_equity_liquidation_usdc: null,
    });
  });

  it("is idempotent under safe_add_column replay", () => {
    const sql = readMigration("067_track_r_liquidation_values.sql");

    db.exec(applySafeAddColumnStatements(db, sql));
    db.exec(applySafeAddColumnStatements(db, sql));

    const positionColumns = db.prepare("PRAGMA table_info(positions)").all() as Array<{
      name: string;
    }>;
    expect(
      positionColumns.filter((column) => column.name === "liquidation_value_usdc"),
    ).toHaveLength(1);
  });
});

describe("migration 053 — taker BUY gross fill sizes", () => {
  beforeEach(() => {
    db.exec(`
      CREATE TABLE fills (
        fill_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        condition_id TEXT NOT NULL DEFAULT '',
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        size_usdc REAL NOT NULL,
        liquidity_role TEXT NOT NULL,
        fee REAL NOT NULL DEFAULT 0,
        fee_rate_bps REAL NOT NULL DEFAULT 0,
        filled_at TEXT NOT NULL
      );
      CREATE TABLE inventory_lots (
        lot_id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        size REAL NOT NULL,
        remaining_size REAL NOT NULL,
        entry_price REAL NOT NULL,
        cost_usdc REAL NOT NULL,
        fill_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE leg_states (
        token_id TEXT PRIMARY KEY,
        buy_count INTEGER NOT NULL DEFAULT 0,
        sell_count INTEGER NOT NULL DEFAULT 0,
        last_action TEXT NOT NULL,
        first_trade_price REAL NOT NULL,
        first_trade_at TEXT NOT NULL,
        last_trade_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cumulative_buy_size REAL NOT NULL DEFAULT 0,
        cumulative_buy_notional REAL NOT NULL DEFAULT 0,
        cumulative_sell_size REAL NOT NULL DEFAULT 0
      );
    `);
  });

  it("repairs open taker BUY fills, lots, positions, and leg state to gross shares", () => {
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, status, opened_at, updated_at)
       VALUES ('pos-open', 'tok-open', 'cond-1', 'buy', 19.7211, ?, 2.73, 2.73,
               'open', '2026-05-11T00:00:00Z', '2026-05-11T00:00:00Z')`,
    ).run(2.73 / 19.7211);
    db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size,
          size_usdc, liquidity_role, fee, filled_at)
       VALUES ('fill-open', 'ord-1', 'tok-open', 'cond-1', 'buy', 0.13, 19.7211,
               2.73, 'taker', 0.166257, '2026-05-11T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size,
          entry_price, cost_usdc, fill_id, created_at)
       VALUES ('lot-open', 'pos-open', 'tok-open', 'buy', 19.7211, 19.7211,
               ?, 2.73, 'fill-open', '2026-05-11T00:00:00Z')`,
    ).run(2.73 / 19.7211);
    db.prepare(
      `INSERT INTO leg_states
         (token_id, buy_count, sell_count, last_action, first_trade_price,
          first_trade_at, last_trade_at, updated_at, cumulative_buy_size,
          cumulative_buy_notional, cumulative_sell_size)
       VALUES ('tok-open', 1, 0, 'BUY', 0.13, '2026-05-11T00:00:00Z',
               '2026-05-11T00:00:00Z', '2026-05-11T00:00:00Z', 19.7211, 2.73, 0)`,
    ).run();

    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, status, opened_at, updated_at)
       VALUES ('pos-closed', 'tok-closed', 'cond-2', 'buy', 0, 0, 0, 0,
               'closed', '2026-05-10T00:00:00Z', '2026-05-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size,
          size_usdc, liquidity_role, fee, filled_at)
       VALUES ('fill-closed', 'ord-2', 'tok-closed', 'cond-2', 'buy', 0.45,
               17.882648, 8.379, 'taker', 0.3318084, '2026-05-10T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size,
          entry_price, cost_usdc, fill_id, created_at)
       VALUES ('lot-closed', 'pos-closed', 'tok-closed', 'buy', 17.882648, 0,
               ?, 8.379, 'fill-closed', '2026-05-10T00:00:00Z')`,
    ).run(8.379 / 17.882648);

    db.exec(readMigration("053_taker_buy_gross_fill_sizes.sql"));

    const openFill = db.prepare("SELECT size FROM fills WHERE fill_id = 'fill-open'").get() as {
      size: number;
    };
    expect(openFill.size).toBeCloseTo(21, 9);

    const openLot = db
      .prepare(
        "SELECT size, remaining_size, entry_price FROM inventory_lots WHERE lot_id = 'lot-open'",
      )
      .get() as { size: number; remaining_size: number; entry_price: number };
    expect(openLot.size).toBeCloseTo(21, 9);
    expect(openLot.remaining_size).toBeCloseTo(21, 9);
    expect(openLot.entry_price).toBeCloseTo(2.73 / 21, 9);

    const openPosition = db
      .prepare(
        "SELECT size, avg_entry_price, cost_basis_usdc FROM positions WHERE position_id = 'pos-open'",
      )
      .get() as { size: number; avg_entry_price: number; cost_basis_usdc: number };
    expect(openPosition.size).toBeCloseTo(21, 9);
    expect(openPosition.avg_entry_price).toBeCloseTo(2.73 / 21, 9);
    expect(openPosition.cost_basis_usdc).toBeCloseTo(2.73, 9);

    const legState = db
      .prepare(
        "SELECT cumulative_buy_size, cumulative_buy_notional FROM leg_states WHERE token_id = 'tok-open'",
      )
      .get() as { cumulative_buy_size: number; cumulative_buy_notional: number };
    expect(legState.cumulative_buy_size).toBeCloseTo(21, 9);
    expect(legState.cumulative_buy_notional).toBeCloseTo(2.73, 9);

    const closedLot = db
      .prepare("SELECT remaining_size FROM inventory_lots WHERE lot_id = 'lot-closed'")
      .get() as { remaining_size: number };
    expect(closedLot.remaining_size).toBe(0);

    const beforeReplay = db.prepare("SELECT total_changes() AS count").get() as { count: number };
    db.exec(readMigration("053_taker_buy_gross_fill_sizes.sql"));
    const afterReplay = db.prepare("SELECT total_changes() AS count").get() as { count: number };
    expect(afterReplay.count - beforeReplay.count).toBe(0);
  });
});

describe("migration 039 — retention indexes", () => {
  it("creates date indexes used by retention cleanup", () => {
    db.exec(`
      DROP TABLE positions;
      CREATE TABLE market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );
      CREATE TABLE runtime_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        value REAL NOT NULL,
        labels TEXT,
        captured_at TEXT NOT NULL
      );
      CREATE TABLE execution_policy_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE risk_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE portfolio_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );
    `);

    db.exec(readMigration("039_retention_indexes.sql"));

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{
      name: string;
    }>;
    expect(indexes.map((idx) => idx.name)).toEqual(
      expect.arrayContaining([
        "idx_market_snapshots_captured_at",
        "idx_runtime_metrics_captured_at",
        "idx_execution_policy_observations_created_at",
        "idx_risk_events_created_at",
        "idx_portfolio_snapshots_captured_at",
      ]),
    );
  });
});

describe("migration 058 — market snapshot public trade count", () => {
  it("adds nullable public_trade_count_24h to market_snapshots", () => {
    db.exec(`
      CREATE TABLE market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL,
        captured_at TEXT NOT NULL
      );
    `);
    const sql = readMigration("058_market_snapshots_public_trade_count_24h.sql");
    db.exec(applySafeAddColumnStatements(db, sql));

    const columns = db.prepare("PRAGMA table_info(market_snapshots)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain("public_trade_count_24h");
  });
});

describe("migration 064 — SELL shadow execution policy observations", () => {
  it("adds nullable observe-only SELL pricing columns idempotently", () => {
    db.exec(`
      CREATE TABLE execution_policy_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL
      );
    `);
    const sql = readMigration("064_sell_shadow_execution_policy_observations.sql");
    db.exec(applySafeAddColumnStatements(db, sql));
    expect(() => db.exec(applySafeAddColumnStatements(db, sql))).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(execution_policy_observations)").all() as Array<{
      name: string;
      notnull: number;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "sell_shadow_avg_entry",
        "sell_shadow_avg_entry_source",
        "sell_shadow_signal_price",
        "sell_shadow_execution_price",
        "sell_shadow_execution_vs_signal_ratio",
        "sell_shadow_execution_vs_avg_entry_ratio",
        "sell_shadow_cap5_violation",
        "sell_shadow_cap10_violation",
        "sell_shadow_exit_pricing_mode",
        "sell_shadow_exit_anchor_mode",
      ]),
    );
    for (const column of columns.filter((c) => c.name.startsWith("sell_shadow_"))) {
      expect(column.notnull).toBe(0);
    }
  });
});

describe("migration 051 — algo token mode state", () => {
  it("creates additive mode-state storage and indexes", () => {
    db.exec(readMigration("051_algo_token_mode_state.sql"));

    const columns = db.prepare("PRAGMA table_info(algo_token_mode_state)").all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "token_id",
        "condition_id",
        "mode",
        "mode_confidence",
        "mode_status",
        "ttl_stage",
        "median_gap_ms",
        "last_fill_timestamps_json",
      ]),
    );

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'algo_token_mode_state'",
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((idx) => idx.name)).toEqual(
      expect.arrayContaining([
        "idx_algo_token_mode_state_condition",
        "idx_algo_token_mode_state_mode",
        "idx_algo_token_mode_state_updated",
      ]),
    );
  });
});

describe("migration 055 — redeem_log unique in-flight", () => {
  it("retires pre-index append-only active rows that already have a later outcome", () => {
    db.exec(readMigration("054_redeem_log.sql"));
    db.prepare(
      `INSERT INTO redeem_log (condition_id, token_ids, attempt_ts, status)
       VALUES (?, ?, ?, ?)`,
    ).run("cond-1", JSON.stringify(["tok-1"]), 1_000, "attempting");
    db.prepare(
      `INSERT INTO redeem_log (condition_id, token_ids, attempt_ts, status)
       VALUES (?, ?, ?, ?)`,
    ).run("cond-1", JSON.stringify(["tok-1"]), 2_000, "success");

    db.exec(readMigration("055_redeem_log_unique_in_flight.sql"));

    const rows = db
      .prepare("SELECT status FROM redeem_log WHERE condition_id = ? ORDER BY attempt_ts")
      .all("cond-1") as Array<{ status: string }>;
    expect(rows.map((row) => row.status)).toEqual(["failed_orphaned", "success"]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO redeem_log (condition_id, token_ids, attempt_ts, status)
           VALUES (?, ?, ?, ?)`,
        )
        .run("cond-1", JSON.stringify(["tok-1"]), 3_000, "attempting"),
    ).not.toThrow();
  });
});

describe("migration 061 — redeem quarantine fields", () => {
  it("adds idempotent STATE_FAILED quarantine fields and indexes", () => {
    const sql = readMigration("061_redeem_quarantine_fields.sql");
    db.exec(applySafeAddColumnStatements(db, sql));
    expect(() => db.exec(applySafeAddColumnStatements(db, sql))).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(positions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "consecutive_state_failed_count",
        "redeem_quarantine_until_ts",
        "last_state_failed_ts",
      ]),
    );

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'positions'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_positions_redeem_quarantine_until",
        "idx_positions_condition_redeem_quarantine",
      ]),
    );
  });
});

describe("migration 066 — orphan fill correction (token 34928863…)", () => {
  const TOKEN = "34928863542604747577136069195537517831839938618288352858238947625130728675067";
  const POSITION_ID = `pos-${TOKEN}-1779091115233`;
  const ORPHAN_FILL = "212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0";
  const LOT_NEWEST = "lot-3f38410b-a321-45d3-be92-cc0badf86292#maker:0";
  const LOT_MID = "lot-1ff2d9ae-2563-494b-90b8-69c66ccd9bc1#maker:0";
  const LOT_PARTIAL = "lot-c6bd9df0-55cb-4556-9e9d-f84b8631470f#maker:0";
  const LOT_OLD = "lot-00000000-0000-0000-0000-fullyconsumed#maker:0";
  const SYNTH_ORDER = "synthetic-orphan-adoption-order";

  beforeEach(() => {
    db.exec(`
      CREATE TABLE fills (
        fill_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        size_usdc REAL NOT NULL,
        liquidity_role TEXT NOT NULL DEFAULT 'unknown',
        reconciled INTEGER NOT NULL DEFAULT 0,
        filled_at TEXT NOT NULL
      );
      CREATE TABLE inventory_lots (
        lot_id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        size REAL NOT NULL,
        remaining_size REAL NOT NULL,
        entry_price REAL NOT NULL,
        cost_usdc REAL NOT NULL,
        fill_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE leg_states (
        token_id TEXT PRIMARY KEY,
        buy_count INTEGER NOT NULL DEFAULT 0,
        sell_count INTEGER NOT NULL DEFAULT 0,
        last_action TEXT NOT NULL,
        first_trade_price REAL NOT NULL,
        first_trade_at TEXT NOT NULL,
        last_trade_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cumulative_buy_size REAL NOT NULL DEFAULT 0,
        cumulative_buy_notional REAL NOT NULL DEFAULT 0,
        cumulative_sell_size REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE orders (
        order_id TEXT PRIMARY KEY,
        client_order_id TEXT,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        signal_reason TEXT,
        created_at TEXT,
        updated_at TEXT
      );
    `);
  });

  function insertLot(lotId: string, size: number, remaining: number, createdAt: string): void {
    db.prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
       VALUES (?, ?, ?, 'buy', ?, ?, 0.006, ?, ?, ?)`,
    ).run(lotId, POSITION_ID, TOKEN, size, remaining, size * 0.006, `f-${lotId}`, createdAt);
  }

  function seedBrokenState(): void {
    // Over-consumed open position (lots drained to sub-epsilon dust by the loop).
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, realized_pnl, status, opened_at, updated_at)
       VALUES (?, ?, 'cond-1', 'buy', 0.0009999, 0.006, 0.0000059994, 0.0000061,
               0.778664, 'open', '2026-05-01T00:00:00Z', '2026-06-05T00:00:00Z')`,
    ).run(POSITION_ID, TOKEN);
    // Orphan repricing-exit SELL fill that filled on-chain after local cancel — unreconciled.
    db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, side, price, size, size_usdc, liquidity_role, reconciled, filled_at)
       VALUES (?, ?, ?, 'sell', 0.023, 7.43, 0.17089, 'maker', 0, '2026-06-05T03:48:51Z')`,
    ).run(ORPHAN_FILL, SYNTH_ORDER, TOKEN);
    // Synthetic startup-adoption order created during re-adoption of the orphan.
    db.prepare(
      `INSERT INTO orders (order_id, client_order_id, token_id, side, signal_reason, created_at, updated_at)
       VALUES (?, 'coid-orphan', ?, 'sell', 'startup-adoption', '2026-06-05T03:48:51Z', '2026-06-05T03:48:51Z')`,
    ).run(SYNTH_ORDER, TOKEN);
    // 8 buy lots in reality; the 3 newest carry the surviving net, the rest stay 0.
    insertLot(LOT_OLD, 82.681, 0, "2026-05-01T00:00:00Z");
    insertLot(LOT_PARTIAL, 13, 0, "2026-05-20T00:00:00Z");
    insertLot(LOT_MID, 7, 0, "2026-05-25T00:00:00Z");
    insertLot(LOT_NEWEST, 13, 0.0009999, "2026-05-30T00:00:00Z");
    // Leg state with the orphan sell NOT yet counted (5 of 6; 93.251 = the 5 reconciled sells).
    db.prepare(
      `INSERT INTO leg_states
         (token_id, buy_count, sell_count, last_action, first_trade_price, first_trade_at,
          last_trade_at, updated_at, cumulative_buy_size, cumulative_buy_notional, cumulative_sell_size)
       VALUES (?, 8, 5, 'SELL', 0.006, '2026-05-01T00:00:00Z', '2026-06-07T00:00:00Z',
               '2026-06-07T00:00:00Z', 122.972, 0.737832, 93.251)`,
    ).run(TOKEN);
  }

  it("reconciles the orphan sell-fill and restores inventory, position, and leg state to the wallet-confirmed net", () => {
    seedBrokenState();

    // Pre-state assertion — confirm the broken shape the migration is correcting.
    expect(
      (
        db
          .prepare("SELECT size, realized_pnl FROM positions WHERE position_id = ?")
          .get(POSITION_ID) as {
          size: number;
          realized_pnl: number;
        }
      ).size,
    ).toBeCloseTo(0.0009999, 7);
    expect(
      (
        db.prepare("SELECT reconciled FROM fills WHERE fill_id = ?").get(ORPHAN_FILL) as {
          reconciled: number;
        }
      ).reconciled,
    ).toBe(0);
    expect(
      (
        db
          .prepare("SELECT sell_count, cumulative_sell_size FROM leg_states WHERE token_id = ?")
          .get(TOKEN) as {
          sell_count: number;
          cumulative_sell_size: number;
        }
      ).sell_count,
    ).toBe(5);
    expect(
      (
        db.prepare("SELECT signal_reason FROM orders WHERE order_id = ?").get(SYNTH_ORDER) as {
          signal_reason: string;
        }
      ).signal_reason,
    ).toBe("startup-adoption");

    db.exec(readMigration("066_orphan_fill_correction_token_34928863.sql"));

    // Inventory restored to net 22.291 across the 3 newest lots; older lot untouched.
    const lots = db.prepare("SELECT lot_id, remaining_size FROM inventory_lots").all() as Array<{
      lot_id: string;
      remaining_size: number;
    }>;
    const remaining = new Map(lots.map((l) => [l.lot_id, l.remaining_size]));
    expect(remaining.get(LOT_NEWEST)).toBeCloseTo(13.0, 6);
    expect(remaining.get(LOT_MID)).toBeCloseTo(7.0, 6);
    expect(remaining.get(LOT_PARTIAL)).toBeCloseTo(2.291, 6);
    expect(remaining.get(LOT_OLD)).toBeCloseTo(0, 9);
    const totalRemaining = lots.reduce((sum, l) => sum + l.remaining_size, 0);
    expect(totalRemaining).toBeCloseTo(22.291, 6);

    const position = db
      .prepare(
        "SELECT size, avg_entry_price, cost_basis_usdc, current_value_usdc, realized_pnl, status FROM positions WHERE position_id = ?",
      )
      .get(POSITION_ID) as {
      size: number;
      avg_entry_price: number;
      cost_basis_usdc: number;
      current_value_usdc: number;
      realized_pnl: number;
      status: string;
    };
    expect(position.size).toBeCloseTo(22.291, 6);
    expect(position.avg_entry_price).toBeCloseTo(0.006, 9);
    expect(position.cost_basis_usdc).toBeCloseTo(0.133746, 6);
    expect(position.current_value_usdc).toBeCloseTo(0.4123, 6);
    expect(position.realized_pnl).toBeCloseTo(0.904974, 6);
    expect(position.status).toBe("open");

    expect(
      (
        db.prepare("SELECT reconciled FROM fills WHERE fill_id = ?").get(ORPHAN_FILL) as {
          reconciled: number;
        }
      ).reconciled,
    ).toBe(1);

    const legState = db
      .prepare("SELECT sell_count, cumulative_sell_size FROM leg_states WHERE token_id = ?")
      .get(TOKEN) as { sell_count: number; cumulative_sell_size: number };
    expect(legState.sell_count).toBe(6);
    expect(legState.cumulative_sell_size).toBeCloseTo(100.681, 6);

    expect(
      (
        db.prepare("SELECT signal_reason FROM orders WHERE order_id = ?").get(SYNTH_ORDER) as {
          signal_reason: string;
        }
      ).signal_reason,
    ).toBe("orphan-reconciled-20260610");
  });

  it("is idempotent — replaying the migration writes nothing and does not corrupt the corrected state", () => {
    seedBrokenState();
    db.exec(readMigration("066_orphan_fill_correction_token_34928863.sql"));

    const beforeReplay = db.prepare("SELECT total_changes() AS count").get() as { count: number };
    db.exec(readMigration("066_orphan_fill_correction_token_34928863.sql"));
    const afterReplay = db.prepare("SELECT total_changes() AS count").get() as { count: number };
    expect(afterReplay.count - beforeReplay.count).toBe(0);

    // Corrected values survive the replay unchanged (no double-write).
    const position = db
      .prepare("SELECT size, realized_pnl FROM positions WHERE position_id = ?")
      .get(POSITION_ID) as { size: number; realized_pnl: number };
    expect(position.size).toBeCloseTo(22.291, 6);
    expect(position.realized_pnl).toBeCloseTo(0.904974, 6);
    const legState = db
      .prepare("SELECT cumulative_sell_size FROM leg_states WHERE token_id = ?")
      .get(TOKEN) as { cumulative_sell_size: number };
    expect(legState.cumulative_sell_size).toBeCloseTo(100.681, 6);
    expect(
      (
        db
          .prepare("SELECT remaining_size FROM inventory_lots WHERE lot_id = ?")
          .get(LOT_NEWEST) as {
          remaining_size: number;
        }
      ).remaining_size,
    ).toBeCloseTo(13.0, 6);
  });

  it("is a no-op on ledgers without the orphan fill (sim/paper safety)", () => {
    // An unrelated open position + an unrelated startup-adoption order for a different
    // token, and no orphan fill at all — mirrors a sim/paper ledger.
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, status, opened_at, updated_at)
       VALUES ('pos-other', 'tok-other', 'cond-x', 'buy', 50, 'open',
               '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO orders (order_id, client_order_id, token_id, side, signal_reason, created_at, updated_at)
       VALUES ('ord-other', 'coid-other', 'tok-other', 'sell', 'startup-adoption',
               '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')`,
    ).run();

    const before = db.prepare("SELECT total_changes() AS count").get() as { count: number };
    db.exec(readMigration("066_orphan_fill_correction_token_34928863.sql"));
    const after = db.prepare("SELECT total_changes() AS count").get() as { count: number };
    expect(after.count - before.count).toBe(0);

    expect(
      (
        db.prepare("SELECT size FROM positions WHERE position_id = 'pos-other'").get() as {
          size: number;
        }
      ).size,
    ).toBe(50);
    expect(
      (
        db.prepare("SELECT signal_reason FROM orders WHERE order_id = 'ord-other'").get() as {
          signal_reason: string;
        }
      ).signal_reason,
    ).toBe("startup-adoption");
  });
});

describe("migration 079 — legacy accounting warning backfill", () => {
  const LEADER_TOKEN =
    "34928863542604747577136069195537517831839938618288352858238947625130728675067";
  const LEADER_CONDITION = "0x84a45609bfdb644a15be71d679fbb4f115dea9109d9bac96e1bc049853e002f6";
  const LEADER_POSITION = `pos-${LEADER_TOKEN}-1779091115233`;
  const LEADER_FILL = "212af2ee-9b5f-430d-be71-bfa9b99bc3a8#maker:0";
  const DOGE_TOKEN =
    "83537444247216274574034531285415887826691018030217949635658894281737339757145";
  const DOGE_CONDITION = "0x63acbf4e10da74f77c5fde2ba04607af499531b5960cc879c4d6ee03ad66a07f";
  const DOGE_POSITION = `pos-${DOGE_TOKEN}-1776980204052`;
  const DOGE_SETTLEMENT = "legacy-backfill-doge-20260630-pos-1776980204052";

  beforeEach(() => {
    db.exec(`
      CREATE TABLE fills (
        fill_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        family_id TEXT,
        condition_id TEXT NOT NULL DEFAULT '',
        side TEXT NOT NULL,
        price REAL NOT NULL,
        size REAL NOT NULL,
        size_usdc REAL NOT NULL,
        reconciled INTEGER NOT NULL DEFAULT 1,
        filled_at TEXT NOT NULL
      );
      CREATE TABLE pnl_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fill_id TEXT NOT NULL,
        position_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        delta REAL NOT NULL,
        filled_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE inventory_lots (
        lot_id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        size REAL NOT NULL,
        remaining_size REAL NOT NULL,
        entry_price REAL NOT NULL,
        cost_usdc REAL NOT NULL,
        fill_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE market_resolutions (
        condition_id TEXT PRIMARY KEY,
        resolution TEXT NOT NULL,
        resolved_at TEXT NOT NULL,
        detected_at TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'settled'
      );
      CREATE TABLE settlement_ledger (
        settlement_id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        position_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        family_id TEXT,
        resolution TEXT NOT NULL,
        settlement_price REAL NOT NULL,
        size REAL NOT NULL,
        delta REAL NOT NULL,
        settled_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  });

  function seedLeaderCase(): void {
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, realized_pnl, status, opened_at, closed_at, updated_at)
       VALUES (?, ?, ?, 'buy', 0, 0.006, 0.000006, 1.105584, 'closed',
               '2026-05-18T07:58:35.233Z', '2026-06-12T04:08:58.639Z',
               '2026-06-12T04:08:58.639Z')`,
    ).run(LEADER_POSITION, LEADER_TOKEN, LEADER_CONDITION);
    db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
       VALUES (?, '0xe43fd65351bf7015', ?, ?, 'sell', 0.023, 7.43, 0.17089,
               '2026-06-05T03:48:51.000Z')`,
    ).run(LEADER_FILL, LEADER_TOKEN, LEADER_CONDITION);
  }

  function seedDogeCase(): void {
    db.prepare(
      `INSERT INTO market_resolutions
         (condition_id, resolution, resolved_at, detected_at, source, status)
       VALUES (?, 'algo-redeem', '2026-04-23T21:35:24.618Z',
               '2026-04-23T21:35:24.618Z', 'algo', 'detected')`,
    ).run(DOGE_CONDITION);
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, realized_pnl, status, opened_at, closed_at, updated_at)
       VALUES (?, ?, ?, 'buy', 0, 0.01, 0.525, -0.525, 'closed',
               '2026-04-23T21:36:44.052Z', '2026-04-23T21:39:24.426Z',
               '2026-04-23T21:39:24.426Z')`,
    ).run(DOGE_POSITION, DOGE_TOKEN, DOGE_CONDITION);
    db.prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size, entry_price,
          cost_usdc, fill_id, created_at)
       VALUES ('lot-doge-second', ?, ?, 'buy', 52.5, 0, 0.01, 0.525,
               'eac8228d-75fb-457a-834-test#maker:0', '2026-04-23T21:36:39.000Z')`,
    ).run(DOGE_POSITION, DOGE_TOKEN);
  }

  function run079Migration(): void {
    db.exec(
      applySafeAddColumnStatements(
        db,
        readMigration("079_legacy_accounting_backfill_20260630.sql"),
      ),
    );
  }

  it("inserts the two exact missing accounting rows and is idempotent", () => {
    seedLeaderCase();
    seedDogeCase();
    db.prepare(
      `INSERT INTO pnl_ledger (fill_id, position_id, family_id, delta, filled_at)
       VALUES ('leader-existing-fill', ?, 'legacy', 0.979274, '2026-06-04T00:00:00Z')`,
    ).run(LEADER_POSITION);
    db.prepare(
      `INSERT INTO pnl_ledger (fill_id, position_id, family_id, delta, filled_at)
       VALUES ('unrelated-fill', 'unrelated-position', 'unrelated-family', 9,
               '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO settlement_ledger
         (settlement_id, condition_id, position_id, token_id, resolution,
          settlement_price, size, delta, settled_at)
       VALUES ('unrelated-settlement', 'cond-other', 'pos-other', 'tok-other',
               'algo-redeem', 0, 1, -1, '2026-01-01T00:00:00Z')`,
    ).run();

    run079Migration();
    run079Migration();

    const leaderRows = db
      .prepare("SELECT delta, family_id FROM pnl_ledger WHERE fill_id = ? AND position_id = ?")
      .all(LEADER_FILL, LEADER_POSITION) as Array<{ delta: number; family_id: string }>;
    expect(leaderRows).toHaveLength(1);
    expect(leaderRows[0]!.delta).toBeCloseTo(0.12631, 6);
    expect(leaderRows[0]!.family_id).toBe("legacy");

    const dogeRows = db
      .prepare(
        "SELECT settlement_price, size, delta FROM settlement_ledger WHERE settlement_id = ?",
      )
      .all(DOGE_SETTLEMENT) as Array<{ settlement_price: number; size: number; delta: number }>;
    expect(dogeRows).toHaveLength(1);
    expect(dogeRows[0]!.settlement_price).toBe(0);
    expect(dogeRows[0]!.size).toBeCloseTo(52.5, 6);
    expect(dogeRows[0]!.delta).toBeCloseTo(-0.525, 6);

    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM pnl_ledger").get() as { count: number }).count,
    ).toBe(3);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM settlement_ledger").get() as { count: number })
        .count,
    ).toBe(2);
  });

  it("does nothing when exact forensic guards do not match", () => {
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, realized_pnl, status, opened_at, updated_at)
       VALUES ('pos-near-miss', ?, ?, 'buy', 0, 1.105584, 'closed',
               '2026-05-18T07:58:35.233Z', '2026-06-12T04:08:58.639Z')`,
    ).run(LEADER_TOKEN, LEADER_CONDITION);
    db.prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc, filled_at)
       VALUES (?, '0xe43fd65351bf7015', ?, ?, 'sell', 0.023, 7.43, 0.17089,
               '2026-06-05T03:48:51.000Z')`,
    ).run(LEADER_FILL, LEADER_TOKEN, LEADER_CONDITION);

    run079Migration();

    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM pnl_ledger").get() as { count: number }).count,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM settlement_ledger").get() as { count: number })
        .count,
    ).toBe(0);
  });
});

describe("migration 080 — redeem sweep zero-return P&L backfill", () => {
  // Two exact affected rows from closed_zero_return_pnl_affected_2026-06-30.csv.
  // NO_MR has no market_resolutions row (37/40 affected); HAS_MR already has a
  // gamma-delisted detection row (3/40).
  const NO_MR_TOKEN =
    "70781911088713239237748492025950997105300640174486237821499168939935120968223";
  const NO_MR_CONDITION = "0x835c0ca9914b5c6e3ce4b77e448b70c0808c30fabf39b64e6799a79c178a772e";
  const NO_MR_POSITION = `pos-${NO_MR_TOKEN}-1782187061889`;
  const NO_MR_SETTLEMENT = `redeem-sweep-backfill-080-${NO_MR_TOKEN}`;

  const HAS_MR_TOKEN =
    "8793371545582822810690698136612044556737147618554458155782168291347570682358";
  const HAS_MR_CONDITION = "0x1d4f707bfc4d4737a1063f8770e37f03098745e9b28202a29f093d3524ba34e9";
  const HAS_MR_POSITION = `pos-${HAS_MR_TOKEN}-1779034215486`;
  const HAS_MR_SETTLEMENT = `redeem-sweep-backfill-080-${HAS_MR_TOKEN}`;

  beforeEach(() => {
    // Real prod schema: settlement_ledger carries the condition_id FK to
    // market_resolutions, so the migration MUST seed a marker before settling
    // conditions that lack a resolution. foreign_keys ON exercises that path.
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE market_resolutions (
        condition_id TEXT PRIMARY KEY,
        resolution   TEXT NOT NULL,
        resolved_at  TEXT NOT NULL,
        detected_at  TEXT NOT NULL,
        source       TEXT NOT NULL,
        raw_response TEXT,
        status       TEXT NOT NULL DEFAULT 'settled'
      );
      CREATE TABLE settlement_ledger (
        settlement_id    TEXT PRIMARY KEY,
        condition_id     TEXT NOT NULL REFERENCES market_resolutions(condition_id),
        position_id      TEXT NOT NULL REFERENCES positions(position_id),
        token_id         TEXT NOT NULL,
        resolution       TEXT NOT NULL,
        settlement_price REAL NOT NULL,
        size             REAL NOT NULL,
        delta            REAL NOT NULL,
        settled_at       TEXT NOT NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE pnl_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fill_id TEXT NOT NULL,
        position_id TEXT NOT NULL,
        delta REAL NOT NULL,
        filled_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE inventory_lots (
        lot_id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        size REAL NOT NULL,
        remaining_size REAL NOT NULL,
        entry_price REAL NOT NULL,
        cost_usdc REAL NOT NULL,
        fill_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  });

  function seedAffected(args: {
    positionId: string;
    tokenId: string;
    conditionId: string;
    costBasis: number;
    avgEntry: number;
    shares: number;
    realizedPnl?: number;
    remainingLot?: number;
  }): void {
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, realized_pnl, status,
          opened_at, closed_at, updated_at)
       VALUES (?, ?, ?, 'buy', 0, ?, ?, 0, ?, 'closed',
               '2026-06-23T03:57:41.889Z', '2026-06-23T06:02:35.104Z',
               '2026-06-23T06:02:35.104Z')`,
    ).run(
      args.positionId,
      args.tokenId,
      args.conditionId,
      args.avgEntry,
      args.costBasis,
      args.realizedPnl ?? 0,
    );
    db.prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size, entry_price,
          cost_usdc, fill_id, created_at)
       VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?, '2026-06-23T03:57:41.000Z')`,
    ).run(
      `lot-${args.tokenId}`,
      args.positionId,
      args.tokenId,
      args.shares,
      args.remainingLot ?? 0,
      args.avgEntry,
      args.costBasis,
      `fill-${args.tokenId}`,
    );
  }

  function settlementRow(settlementId: string) {
    return db
      .prepare(
        "SELECT condition_id, settlement_price, size, delta, resolution FROM settlement_ledger WHERE settlement_id = ?",
      )
      .get(settlementId) as
      | {
          condition_id: string;
          settlement_price: number;
          size: number;
          delta: number;
          resolution: string;
        }
      | undefined;
  }

  function realizedPnl(positionId: string): number {
    return (
      db.prepare("SELECT realized_pnl FROM positions WHERE position_id = ?").get(positionId) as {
        realized_pnl: number;
      }
    ).realized_pnl;
  }

  it("settles a no-resolution zero-return loss (marker + settlement + realized_pnl) and is idempotent", () => {
    seedAffected({
      positionId: NO_MR_POSITION,
      tokenId: NO_MR_TOKEN,
      conditionId: NO_MR_CONDITION,
      costBasis: 0.99,
      avgEntry: 0.006,
      shares: 165,
    });

    const sql = readMigration("080_redeem_sweep_zero_return_pnl_backfill_20260630.sql");
    db.exec(sql);
    db.exec(sql);

    const marker = db
      .prepare("SELECT source, status FROM market_resolutions WHERE condition_id = ?")
      .get(NO_MR_CONDITION) as { source: string; status: string } | undefined;
    expect(marker?.source).toBe("redeem-sweep-backfill");

    const settlement = settlementRow(NO_MR_SETTLEMENT);
    expect(settlement?.settlement_price).toBe(0);
    expect(settlement?.size).toBeCloseTo(165, 6);
    expect(settlement?.delta).toBeCloseTo(-0.99, 6);
    expect(realizedPnl(NO_MR_POSITION)).toBeCloseTo(-0.99, 6);

    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM settlement_ledger").get() as { c: number }).c,
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM market_resolutions").get() as { c: number }).c,
    ).toBe(1);
  });

  it("reuses an existing market_resolutions row without overwriting it", () => {
    db.prepare(
      `INSERT INTO market_resolutions
         (condition_id, resolution, resolved_at, detected_at, source, status)
       VALUES (?, 'No', '2026-05-18T12:00:00Z', '2026-05-18T12:00:00Z',
               'gamma-delisted', 'detected')`,
    ).run(HAS_MR_CONDITION);
    seedAffected({
      positionId: HAS_MR_POSITION,
      tokenId: HAS_MR_TOKEN,
      conditionId: HAS_MR_CONDITION,
      costBasis: 0.25431,
      avgEntry: 0.01,
      shares: 25.431,
    });

    db.exec(readMigration("080_redeem_sweep_zero_return_pnl_backfill_20260630.sql"));

    const mr = db
      .prepare("SELECT source, status FROM market_resolutions WHERE condition_id = ?")
      .get(HAS_MR_CONDITION) as { source: string; status: string };
    expect(mr.source).toBe("gamma-delisted");
    expect(mr.status).toBe("detected");

    const settlement = settlementRow(HAS_MR_SETTLEMENT);
    expect(settlement?.delta).toBeCloseTo(-0.25431, 6);
    expect(realizedPnl(HAS_MR_POSITION)).toBeCloseTo(-0.25431, 6);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM market_resolutions").get() as { c: number }).c,
    ).toBe(1);
  });

  it("skips an allow-listed row that fails the zero-return guards", () => {
    // Same exact IDs as the screenshot row, but it already has a sell fill and
    // a nonzero realized_pnl, so it is NOT a clean zero-return loss.
    seedAffected({
      positionId: NO_MR_POSITION,
      tokenId: NO_MR_TOKEN,
      conditionId: NO_MR_CONDITION,
      costBasis: 0.99,
      avgEntry: 0.006,
      shares: 165,
      realizedPnl: -0.4,
    });
    db.prepare(
      `INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at)
       VALUES ('sell-fill-1', ?, 0.2, '2026-06-23T05:00:00Z')`,
    ).run(NO_MR_POSITION);

    db.exec(readMigration("080_redeem_sweep_zero_return_pnl_backfill_20260630.sql"));

    expect(settlementRow(NO_MR_SETTLEMENT)).toBeUndefined();
    expect(realizedPnl(NO_MR_POSITION)).toBeCloseTo(-0.4, 6);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM settlement_ledger").get() as { c: number }).c,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM market_resolutions").get() as { c: number }).c,
    ).toBe(0);
  });

  it("leaves unrelated closed positions and ledgers untouched", () => {
    const otherToken = "111122223333";
    const otherCondition = "0xunrelated";
    const otherPosition = `pos-${otherToken}-1`;
    db.prepare(
      `INSERT INTO market_resolutions
         (condition_id, resolution, resolved_at, detected_at, source, status)
       VALUES (?, 'Yes', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'gamma-api', 'settled')`,
    ).run(otherCondition);
    db.prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, realized_pnl, status, opened_at, updated_at)
       VALUES (?, ?, ?, 'buy', 0, 0.5, 5, 5, 'closed',
               '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')`,
    ).run(otherPosition, otherToken, otherCondition);
    db.prepare(
      `INSERT INTO settlement_ledger
         (settlement_id, condition_id, position_id, token_id, resolution,
          settlement_price, size, delta, settled_at)
       VALUES ('unrelated-settlement', ?, ?, ?, 'Yes', 1, 10, 5, '2026-01-02T00:00:00Z')`,
    ).run(otherCondition, otherPosition, otherToken);

    db.exec(readMigration("080_redeem_sweep_zero_return_pnl_backfill_20260630.sql"));

    expect(realizedPnl(otherPosition)).toBeCloseTo(5, 6);
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM settlement_ledger").get() as { c: number }).c,
    ).toBe(1);
  });
});

describe("migration 088 — orders.position_id", () => {
  it("adds position_id (idempotently) to an orders table that lacks it", () => {
    db.exec(`
      CREATE TABLE orders (
        order_id        TEXT PRIMARY KEY,
        client_order_id TEXT NOT NULL,
        token_id        TEXT NOT NULL,
        side            TEXT NOT NULL,
        order_type      TEXT NOT NULL,
        price           REAL NOT NULL,
        size            REAL NOT NULL,
        size_usdc       REAL NOT NULL,
        bot_run_id      TEXT NOT NULL
      );
    `);
    const sql = readMigration("088_orders_position_id.sql");
    db.exec(applySafeAddColumnStatements(db, sql));
    const cols = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "position_id")).toBe(true);
    // Idempotent replay must not throw (split-ledger double-apply).
    expect(() => db.exec(applySafeAddColumnStatements(db, sql))).not.toThrow();
    db.prepare(
      `INSERT INTO orders (order_id, client_order_id, token_id, side, order_type,
         price, size, size_usdc, bot_run_id, position_id)
       VALUES ('o1', 'c1', 'tok', 'sell', 'GTC', 0.5, 10, 5, 'run', 'pos-tok-1')`,
    ).run();
    const row = db.prepare("SELECT position_id FROM orders WHERE order_id = 'o1'").get() as {
      position_id: string;
    };
    expect(row.position_id).toBe("pos-tok-1");
  });
});

describe("migration 089 — exit_owner allowed-values enforcement (upgrade path)", () => {
  beforeEach(() => {
    // Upgrade path: exit_owner arrives CHECK-less via 087, then 089 adds the
    // allowed-values triggers (SQLite cannot ALTER-ADD a CHECK).
    db.exec(applySafeAddColumnStatements(db, readMigration("087_positions_exit_owner.sql")));
    db.exec(readMigration("089_positions_exit_owner_allowed_values.sql"));
  });

  function insertOwner(positionId: string, tokenId: string, owner: string | null): void {
    db.prepare(
      `INSERT INTO positions (position_id, token_id, side, status, exit_owner, opened_at, updated_at)
       VALUES (?, ?, 'buy', 'open', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run(positionId, tokenId, owner);
  }

  it("accepts bounce / profile / NULL", () => {
    expect(() => insertOwner("p-b", "t-b", "bounce")).not.toThrow();
    expect(() => insertOwner("p-p", "t-p", "profile")).not.toThrow();
    expect(() => insertOwner("p-n", "t-n", null)).not.toThrow();
  });

  it("aborts an INSERT with an out-of-range exit_owner", () => {
    expect(() => insertOwner("p-x", "t-x", "garbage")).toThrow(
      /exit_owner must be bounce, profile, or NULL/,
    );
  });

  it("aborts an UPDATE that sets an out-of-range exit_owner (NULL → invalid)", () => {
    insertOwner("p-u", "t-u", null);
    expect(() =>
      db.prepare("UPDATE positions SET exit_owner = 'garbage' WHERE position_id = 'p-u'").run(),
    ).toThrow(/exit_owner must be bounce, profile, or NULL/);
  });
});
