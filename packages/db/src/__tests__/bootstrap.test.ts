import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertSizeRuleInvariants,
  bootstrapControlDb,
  bootstrapDatabase,
  bootstrapLedgerDb,
} from "../bootstrap.js";
import { RUNTIME_BUSY_TIMEOUT_MS, type DbConnection } from "../connection.js";

function readBusyTimeout(db: import("better-sqlite3").Database): number {
  const row = db.pragma("busy_timeout") as Array<{ timeout: number }>;
  return row[0]!.timeout;
}

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("bootstrapDatabase", () => {
  it("creates an empty DB with all expected tables", () => {
    const tables = conn.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);

    expect(names).toContain("markets");
    expect(names).toContain("orders");
    expect(names).toContain("fills");
    expect(names).toContain("positions");
    expect(names).toContain("inventory_lots");
    expect(names).toContain("family_catalog");
    // family_runtime_state is dropped by migration 035
    expect(names).not.toContain("family_runtime_state");
    expect(names).toContain("operator_commands");
    expect(names).toContain("operator_actions");
    expect(names).toContain("schema_migrations");
  });

  it("is idempotent -- running bootstrap twice does not error", () => {
    const dbPath = path.join(tmpDir, "test.db");
    // conn was already bootstrapped with this path; bootstrap again on same file
    conn.close();
    conn = bootstrapDatabase(dbPath);

    const tables = conn.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];

    expect(tables.length).toBeGreaterThan(0);
  });

  it("records the migration in schema_migrations", () => {
    const rows = conn.db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.name).toBe("001_initial.sql");
  });

  it("migration 035 drops family_runtime_state so the table does not appear after bootstrap", () => {
    // bootstrapDatabase applies all ledger migrations in order. Migration 035
    // drops family_runtime_state (created by migration 001).
    const tables = conn.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'family_runtime_state'",
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(0);
  });

  it("returns a connection at the runtime busy_timeout (not the bootstrap budget)", () => {
    // The bootstrap window opens at 600s for DDL/CREATE INDEX, but the
    // returned connection is reused for the entire process lifetime — leaving
    // 600s in place would let a runtime/API query stall the event loop for
    // 10 minutes behind a write lock.
    expect(readBusyTimeout(conn.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
  });
});

describe("bootstrapControlDb busy_timeout scoping", () => {
  it("returns a connection at the runtime busy_timeout after bootstrap DDL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-control-bootstrap-"));
    try {
      const c = bootstrapControlDb(path.join(dir, "control.db"));
      try {
        expect(readBusyTimeout(c.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
      } finally {
        c.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bootstrapLedgerDb busy_timeout scoping", () => {
  it("returns a connection at the runtime busy_timeout after bootstrap DDL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-ledger-bootstrap-"));
    try {
      const c = bootstrapLedgerDb(path.join(dir, "ledger.db"));
      try {
        expect(readBusyTimeout(c.db)).toBe(RUNTIME_BUSY_TIMEOUT_MS);
      } finally {
        c.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bootstrapLedgerDb split-ledger migration runner", () => {
  it("creates a clean ledger and records replay-safe migrations through 060", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-ledger-runner-clean-"));
    try {
      const c = bootstrapLedgerDb(path.join(dir, "ledger.db"));
      try {
        const migrations = c.db
          .prepare("SELECT name FROM schema_migrations ORDER BY name")
          .all() as Array<{ name: string }>;
        const names = migrations.map((row) => row.name);
        expect(names).toContain("037_position_drifts.sql");
        expect(names).toContain("050_leg_states_cumulative_sizes.sql");
        expect(names).toContain("053_taker_buy_gross_fill_sizes.sql");
        expect(names).toContain("054_redeem_log.sql");
        expect(names).toContain("055_redeem_log_unique_in_flight.sql");
        expect(names).toContain("060_exit_taker_fallback_log.sql");
        expect(
          c.db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='redeem_log'")
            .get(),
        ).toBeTruthy();
        expect(
          c.db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='exit_taker_fallback_log'",
            )
            .get(),
        ).toBeTruthy();
      } finally {
        c.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("continues a ledger whose schema_migrations stopped at 040", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-ledger-runner-partial-"));
    try {
      const dbPath = path.join(dir, "ledger.db");
      const first = bootstrapLedgerDb(dbPath);
      try {
        first.db
          .prepare("DELETE FROM schema_migrations WHERE name > ?")
          .run("040_leg_state_transitions.sql");
      } finally {
        first.close();
      }

      const second = bootstrapLedgerDb(dbPath);
      try {
        const row = second.db
          .prepare("SELECT name FROM schema_migrations WHERE name = ?")
          .get("060_exit_taker_fallback_log.sql");
        expect(row).toBeTruthy();
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when ledger migrations are already at the latest version", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-ledger-runner-noop-"));
    try {
      const dbPath = path.join(dir, "ledger.db");
      const first = bootstrapLedgerDb(dbPath);
      const before = first.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
        count: number;
      };
      first.close();

      const second = bootstrapLedgerDb(dbPath);
      try {
        const after = second.db
          .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
          .get() as { count: number };
        expect(after.count).toBe(before.count);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repairs the current live-lite shape with ad-hoc columns but no late migration rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-ledger-runner-prod-shape-"));
    try {
      const dbPath = path.join(dir, "ledger.db");
      const first = bootstrapLedgerDb(dbPath);
      try {
        first.db
          .prepare("DELETE FROM schema_migrations WHERE name >= ?")
          .run("037_position_drifts.sql");
      } finally {
        first.close();
      }

      const second = bootstrapLedgerDb(dbPath);
      try {
        const rows = second.db
          .prepare("SELECT name FROM schema_migrations WHERE name >= ? ORDER BY name")
          .all("037_position_drifts.sql") as Array<{ name: string }>;
        expect(rows.map((row) => row.name)).toContain("055_redeem_log_unique_in_flight.sql");
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bootstrapLedgerDb leg_state cumulative_* backfill (ADR-027 §D-C)", () => {
  it("backfills existing leg_states from fills history on the split-ledger path", () => {
    // Simulate a deployed bot: pre-existing leg_state rows + fills, columns
    // not yet added. bootstrapLedgerDb must add the columns AND backfill.
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-ledger-bf-"));
    try {
      const dbPath = path.join(dir, "ledger.db");
      // First boot creates the schema + cumulative_* columns at DEFAULT 0.
      const first = bootstrapLedgerDb(dbPath);
      // FK enforcement is on globally; turn it off only for this test
      // setup so we can stage fills without a matching orders row.
      first.db.pragma("foreign_keys = OFF");
      first.db
        .prepare(
          `INSERT INTO leg_states
             (token_id, buy_count, sell_count, last_action, first_trade_price,
              first_trade_at, last_trade_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "tok-bf",
          2,
          0,
          "BUY",
          0.1,
          "2026-01-01T00:00:00Z",
          "2026-01-02T00:00:00Z",
          "2026-01-02T00:00:00Z",
        );
      const insertFill = first.db.prepare(
        `INSERT INTO fills
           (fill_id, order_id, token_id, side, price, size, size_usdc, filled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertFill.run("f1", "ord-bf", "tok-bf", "buy", 0.1, 100, 10, "2026-01-01T00:00:00Z");
      insertFill.run("f2", "ord-bf", "tok-bf", "buy", 0.2, 50, 11, "2026-01-02T00:00:00Z");
      // Pre-leg fill must be excluded by `filled_at >= first_trade_at`.
      insertFill.run("f0", "ord-bf", "tok-bf", "buy", 0.05, 999, 100, "2025-12-31T23:59:59Z");
      // Manually zero out cumulative_* to simulate the pre-backfill state
      // that a freshly-deployed bot encounters when columns were just added
      // by safeAddColumn (DEFAULT 0).
      first.db
        .prepare(
          `UPDATE leg_states SET cumulative_buy_size = 0,
                                cumulative_buy_notional = 0,
                                cumulative_sell_size = 0
            WHERE token_id = ?`,
        )
        .run("tok-bf");
      first.db
        .prepare("DELETE FROM schema_migrations WHERE name = ?")
        .run("050_leg_states_cumulative_sizes.sql");
      first.close();

      // Second boot: bootstrapLedgerDb must run migration 050 via the standard runner.
      const second = bootstrapLedgerDb(dbPath);
      try {
        const row = second.db
          .prepare(
            `SELECT cumulative_buy_size, cumulative_buy_notional, cumulative_sell_size
               FROM leg_states WHERE token_id = ?`,
          )
          .get("tok-bf") as Record<string, number>;
        expect(row.cumulative_buy_size).toBe(150); // 100 + 50; pre-leg 999 excluded
        expect(row.cumulative_buy_notional).toBeCloseTo(10 + 11, 10); // sizeUsdc, not price*size
        expect(row.cumulative_sell_size).toBe(0);

        // Idempotency: a third boot must NOT clobber non-zero values that
        // were accumulated by live fills since the last bootstrap.
        second.db
          .prepare(
            `UPDATE leg_states SET cumulative_buy_size = 999,
                                  cumulative_buy_notional = 99,
                                  cumulative_sell_size = 11
              WHERE token_id = ?`,
          )
          .run("tok-bf");
      } finally {
        second.close();
      }
      const third = bootstrapLedgerDb(dbPath);
      try {
        const row = third.db
          .prepare(
            `SELECT cumulative_buy_size, cumulative_buy_notional, cumulative_sell_size
               FROM leg_states WHERE token_id = ?`,
          )
          .get("tok-bf") as Record<string, number>;
        // Guard `WHERE cumulative_buy_size = 0` keeps these intact.
        expect(row.cumulative_buy_size).toBe(999);
        expect(row.cumulative_buy_notional).toBe(99);
        expect(row.cumulative_sell_size).toBe(11);
      } finally {
        third.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bootstrapLedgerDb taker BUY gross-size repair (R60)", () => {
  it("repairs old net-sized taker BUY fills on the split-ledger path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-ledger-taker-buy-bf-"));
    try {
      const dbPath = path.join(dir, "ledger.db");
      const first = bootstrapLedgerDb(dbPath);
      const grossSize = 21;
      const oldNetSize = 20.7261;
      const costUsdc = 2.73;
      try {
        first.db
          .prepare(
            `INSERT INTO orders
               (order_id, client_order_id, token_id, condition_id, side, order_type,
                post_only, price, size, size_usdc, status, bot_run_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "ord-r60",
            "client-r60",
            "tok-r60",
            "cond-r60",
            "buy",
            "limit",
            0,
            0.13,
            oldNetSize,
            costUsdc,
            "filled",
            "run-r60",
          );
        first.db
          .prepare(
            `INSERT INTO fills
               (fill_id, order_id, token_id, condition_id, side, price, size,
                size_usdc, liquidity_role, fee, fee_rate_bps, filled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "fill-r60",
            "ord-r60",
            "tok-r60",
            "cond-r60",
            "buy",
            0.13,
            oldNetSize,
            costUsdc,
            "taker",
            0.003561,
            60,
            "2026-05-11T00:00:00Z",
          );
        first.db
          .prepare(
            `INSERT INTO positions
               (position_id, token_id, condition_id, side, size, avg_entry_price,
                cost_basis_usdc, status, opened_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "pos-r60",
            "tok-r60",
            "cond-r60",
            "yes",
            oldNetSize,
            costUsdc / oldNetSize,
            costUsdc,
            "open",
            "2026-05-11T00:00:00Z",
            "2026-05-11T00:00:00Z",
          );
        first.db
          .prepare(
            `INSERT INTO inventory_lots
               (lot_id, position_id, token_id, side, size, remaining_size,
                entry_price, cost_usdc, fill_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "lot-r60",
            "pos-r60",
            "tok-r60",
            "yes",
            oldNetSize,
            oldNetSize,
            costUsdc / oldNetSize,
            costUsdc,
            "fill-r60",
            "2026-05-11T00:00:00Z",
          );
        first.db
          .prepare(
            `INSERT INTO leg_states
               (token_id, buy_count, sell_count, last_action, first_trade_price,
                first_trade_at, last_trade_at, cumulative_buy_size,
                cumulative_buy_notional, cumulative_sell_size, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "tok-r60",
            1,
            0,
            "BUY",
            0.13,
            "2026-05-11T00:00:00Z",
            "2026-05-11T00:00:00Z",
            oldNetSize,
            costUsdc,
            0,
            "2026-05-11T00:00:00Z",
          );
        // First boot represents the old split-ledger bootstrap path, which
        // did not run migration 053. Drop the schema migration row so the
        // second boot exercises the standard runner repair.
        first.db
          .prepare("DELETE FROM schema_migrations WHERE name = ?")
          .run("053_taker_buy_gross_fill_sizes.sql");
      } finally {
        first.close();
      }

      const second = bootstrapLedgerDb(dbPath);
      try {
        const fill = second.db
          .prepare("SELECT size FROM fills WHERE fill_id = ?")
          .get("fill-r60") as { size: number };
        const lot = second.db
          .prepare("SELECT size, remaining_size, entry_price FROM inventory_lots WHERE lot_id = ?")
          .get("lot-r60") as Record<string, number>;
        const position = second.db
          .prepare(
            "SELECT size, avg_entry_price, cost_basis_usdc FROM positions WHERE position_id = ?",
          )
          .get("pos-r60") as Record<string, number>;
        const leg = second.db
          .prepare(
            `SELECT cumulative_buy_size, cumulative_buy_notional, cumulative_sell_size
               FROM leg_states WHERE token_id = ?`,
          )
          .get("tok-r60") as Record<string, number>;
        const marker = second.db
          .prepare("SELECT name FROM schema_migrations WHERE name = ?")
          .get("053_taker_buy_gross_fill_sizes.sql");

        expect(fill.size).toBeCloseTo(grossSize, 10);
        expect(lot.size).toBeCloseTo(grossSize, 10);
        expect(lot.remaining_size).toBeCloseTo(grossSize, 10);
        expect(lot.entry_price).toBeCloseTo(0.13, 10);
        expect(position.size).toBeCloseTo(grossSize, 10);
        expect(position.cost_basis_usdc).toBeCloseTo(costUsdc, 10);
        expect(position.avg_entry_price).toBeCloseTo(0.13, 10);
        expect(leg.cumulative_buy_size).toBeCloseTo(grossSize, 10);
        expect(leg.cumulative_buy_notional).toBeCloseTo(costUsdc, 10);
        expect(leg.cumulative_sell_size).toBe(0);
        expect(marker).toBeTruthy();
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assertSizeRuleInvariants (ADR-024 §D-B)", () => {
  it("passes after bootstrap default seed (1 BUY + 1 SELL FALLBACK row)", () => {
    expect(() => assertSizeRuleInvariants(conn.db)).not.toThrow();
  });

  it("returns quietly when algo_size_rules table is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "krabs-no-sizerules-"));
    try {
      const empty = bootstrapLedgerDb(path.join(dir, "ledger.db"));
      try {
        expect(() => assertSizeRuleInvariants(empty.db)).not.toThrow();
      } finally {
        empty.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the BUY FALLBACK row is missing", () => {
    conn.db
      .prepare("DELETE FROM algo_size_rules WHERE action_type = 'BUY' AND rule_id = 'FALLBACK'")
      .run();
    expect(() => assertSizeRuleInvariants(conn.db)).toThrow(/BUY=0 SELL=1/);
  });

  it("throws when a duplicate BUY FALLBACK row exists", () => {
    conn.db
      .prepare(
        `INSERT INTO algo_size_rules
         (action_type, priority, rule_id, state_condition, price_operator, price_value,
          nth_buy, buy_count_min, buy_count_max, size_usdc)
         VALUES ('BUY', 999, 'FALLBACK', 'ANY', NULL, NULL, NULL, NULL, NULL, 1.0)`,
      )
      .run();
    expect(() => assertSizeRuleInvariants(conn.db)).toThrow(/BUY=2 SELL=1/);
  });

  it("throws when the BUY FALLBACK row carries a state_condition other than ANY", () => {
    conn.db
      .prepare(
        `UPDATE algo_size_rules SET state_condition = 'S1'
         WHERE action_type = 'BUY' AND rule_id = 'FALLBACK'`,
      )
      .run();
    expect(() => assertSizeRuleInvariants(conn.db)).toThrow(
      /FALLBACK rows must be unconditional catch-alls/,
    );
  });

  it("throws when the SELL FALLBACK row has a price filter set", () => {
    conn.db
      .prepare(
        `UPDATE algo_size_rules SET price_operator = '>=', price_value = 0.5
         WHERE action_type = 'SELL' AND rule_id = 'FALLBACK'`,
      )
      .run();
    expect(() => assertSizeRuleInvariants(conn.db)).toThrow(
      /FALLBACK rows must be unconditional catch-alls/,
    );
  });

  it("throws when the BUY FALLBACK row has nth_buy or buy_count filters set", () => {
    conn.db
      .prepare(
        `UPDATE algo_size_rules SET nth_buy = 1
         WHERE action_type = 'BUY' AND rule_id = 'FALLBACK'`,
      )
      .run();
    expect(() => assertSizeRuleInvariants(conn.db)).toThrow(
      /FALLBACK rows must be unconditional catch-alls/,
    );
  });

  it("throws when the BUY FALLBACK row sits ahead of a non-FALLBACK BUY rule", () => {
    // Re-priority the FALLBACK row before B1 (priority 10) — evaluateSize
    // reads ORDER BY priority ASC, so this would hijack every BUY evaluation.
    conn.db
      .prepare(
        `UPDATE algo_size_rules SET priority = 5
         WHERE action_type = 'BUY' AND rule_id = 'FALLBACK'`,
      )
      .run();
    expect(() => assertSizeRuleInvariants(conn.db)).toThrow(
      /FALLBACK rows must sit at the highest priority value/,
    );
  });

  it("throws when the BUY FALLBACK ties with another BUY rule's priority", () => {
    // A tie still leaves rule-resolution order undefined (ORDER BY priority
    // ASC doesn't guarantee FALLBACK lands after the other row), so the
    // invariant requires *strictly* greater priority on the FALLBACK row.
    conn.db
      .prepare(
        `UPDATE algo_size_rules SET priority = (
           SELECT MAX(priority) FROM algo_size_rules
            WHERE action_type = 'BUY' AND rule_id != 'FALLBACK'
         )
         WHERE action_type = 'BUY' AND rule_id = 'FALLBACK'`,
      )
      .run();
    expect(() => assertSizeRuleInvariants(conn.db)).toThrow(
      /FALLBACK rows must sit at the highest priority value/,
    );
  });

  it("does NOT throw when an operator tunes the FALLBACK priority above the seed default", () => {
    // The invariant asserts *order*, not the seed value 999 — operators can
    // bump the FALLBACK priority arbitrarily high without re-bootstrapping.
    conn.db
      .prepare(
        `UPDATE algo_size_rules SET priority = 1500
         WHERE action_type = 'BUY' AND rule_id = 'FALLBACK'`,
      )
      .run();
    expect(() => assertSizeRuleInvariants(conn.db)).not.toThrow();
  });
});
