import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

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
