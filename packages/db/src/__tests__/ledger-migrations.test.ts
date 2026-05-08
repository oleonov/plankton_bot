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
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-ledger-migr-"));
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
