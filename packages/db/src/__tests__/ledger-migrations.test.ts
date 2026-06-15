import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { applySafeAddColumnStatements } from "../migrations/runner.js";

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
    db.exec(applySafeAddColumnStatements(db, readMigration("070_execution_profile_scale_in_columns.sql")));

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
