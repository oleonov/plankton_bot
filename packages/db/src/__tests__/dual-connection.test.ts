import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapControlDb, bootstrapLedgerDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";

let tmpDir: string;
const conns: DbConnection[] = [];

afterEach(() => {
  for (const c of conns) c.close();
  conns.length = 0;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("dual-connection infrastructure", () => {
  it("bootstrapControlDb creates control tables from schema", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-ctrl-"));
    const conn = bootstrapControlDb(path.join(tmpDir, "control.db"));
    conns.push(conn);
    const tables = conn.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("profiles");
    expect(names).toContain("family_catalog");
    expect(names).toContain("family_deployments");
    expect(names).toContain("runtime_control_state");
    expect(names).toContain("operator_commands");
    expect(names).not.toContain("orders");
    expect(names).not.toContain("fills");
  });

  it("bootstrapLedgerDb creates ledger tables from schema", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-ledger-"));
    const conn = bootstrapLedgerDb(path.join(tmpDir, "ledger-sim.db"));
    conns.push(conn);
    const tables = conn.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("markets");
    expect(names).toContain("orders");
    expect(names).toContain("fills");
    expect(names).toContain("positions");
    expect(names).toContain("family_profile_runtime_state");
    expect(names).not.toContain("profiles");
    expect(names).not.toContain("family_catalog");
  });

  it("bootstrapControlDb is idempotent", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-ctrl-idem-"));
    const dbPath = path.join(tmpDir, "control.db");
    const conn1 = bootstrapControlDb(dbPath);
    conn1.close();
    const conn2 = bootstrapControlDb(dbPath);
    conns.push(conn2);
    const tables = conn2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
  });

  it("bootstrapControlDb adds throughput columns to legacy control DBs", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-ctrl-throughput-"));
    const dbPath = path.join(tmpDir, "control.db");
    const conn1 = bootstrapControlDb(dbPath);
    conn1.db.prepare("ALTER TABLE family_rules DROP COLUMN max_concurrent_orders_per_family").run();
    conn1.db.prepare("ALTER TABLE family_rules DROP COLUMN max_probe_in_flight_per_token").run();
    conn1.db
      .prepare("ALTER TABLE family_rules DROP COLUMN max_entry_signals_per_tick_per_family")
      .run();
    conn1.close();

    const conn2 = bootstrapControlDb(dbPath);
    conns.push(conn2);

    const columns = conn2.db.prepare("PRAGMA table_info(family_rules)").all() as { name: string }[];
    const names = columns.map((column) => column.name);
    expect(names).toContain("max_concurrent_orders_per_family");
    expect(names).toContain("max_probe_in_flight_per_token");
    expect(names).toContain("max_entry_signals_per_tick_per_family");
  });

  it("bootstrapControlDb backfills legacy discovery directional-updown families without touching tuned rows", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-ctrl-directional-"));
    const dbPath = path.join(tmpDir, "control.db");
    const conn1 = bootstrapControlDb(dbPath);

    conn1.db
      .prepare(
        `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, source_type)
       VALUES
         ('legacy-fast:directional-updown:deadline', 'legacy-fast', 'stocks', 'directional-updown', 'deadline', 'daily', 'scalp', 'discovery'),
         ('manual-fast:directional-updown:deadline', 'manual-fast', 'stocks', 'directional-updown', 'deadline', 'daily', 'scalp', 'discovery'),
         ('yaml-fast:directional-updown:deadline', 'yaml-fast', 'stocks', 'directional-updown', 'deadline', 'daily', 'scalp', 'yaml_import')`,
      )
      .run();
    conn1.db
      .prepare(
        `INSERT OR IGNORE INTO profiles (profile_id, display_name)
       VALUES ('simulation', 'Simulation'), ('paper', 'Paper'), ('live-lite', 'Live Lite')`,
      )
      .run();

    conn1.db
      .prepare(
        `INSERT INTO family_rules
         (family_id, min_entry_price, max_entry_price, high_price_threshold,
          require_proven_family_above_price, preferred_entry_band, fast_lane_enabled)
       VALUES
         ('legacy-fast:directional-updown:deadline', 0, 1, 0.2, 0.2, NULL, NULL),
         ('manual-fast:directional-updown:deadline', 0.02, 0.3, 0.3, 0.3, '0.02-0.30', NULL),
         ('yaml-fast:directional-updown:deadline', 0, 1, 0.2, 0.2, NULL, NULL)`,
      )
      .run();
    conn1.close();

    const conn2 = bootstrapControlDb(dbPath);
    conns.push(conn2);

    const rows = conn2.db
      .prepare(
        `SELECT family_id, min_entry_price, max_entry_price, high_price_threshold,
              require_proven_family_above_price, preferred_entry_band, fast_lane_enabled
         FROM family_rules
        WHERE family_id IN (
          'legacy-fast:directional-updown:deadline',
          'manual-fast:directional-updown:deadline',
          'yaml-fast:directional-updown:deadline'
        )
        ORDER BY family_id`,
      )
      .all() as Array<{
      family_id: string;
      min_entry_price: number;
      max_entry_price: number;
      high_price_threshold: number;
      require_proven_family_above_price: number;
      preferred_entry_band: string | null;
      fast_lane_enabled: number | null;
    }>;

    expect(rows).toEqual([
      {
        family_id: "legacy-fast:directional-updown:deadline",
        min_entry_price: 0.03,
        max_entry_price: 0.35,
        high_price_threshold: 0.35,
        require_proven_family_above_price: 0.35,
        preferred_entry_band: "0.05-0.35",
        fast_lane_enabled: 1,
      },
      {
        family_id: "manual-fast:directional-updown:deadline",
        min_entry_price: 0.02,
        max_entry_price: 0.3,
        high_price_threshold: 0.3,
        require_proven_family_above_price: 0.3,
        preferred_entry_band: "0.02-0.30",
        fast_lane_enabled: null,
      },
      {
        family_id: "yaml-fast:directional-updown:deadline",
        min_entry_price: 0,
        max_entry_price: 1,
        high_price_threshold: 0.2,
        require_proven_family_above_price: 0.2,
        preferred_entry_band: null,
        fast_lane_enabled: null,
      },
    ]);
  });

  it("bootstrapControlDb applies one-time family limit backfill and refreshes latest snapshots", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-ctrl-family-limits-"));
    const dbPath = path.join(tmpDir, "control.db");
    const conn1 = bootstrapControlDb(dbPath);

    conn1.db
      .prepare(
        `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, source_type)
         VALUES ('legacy-fam', 'legacy-fam', 'crypto', 'threshold', 'daily', 'daily', 'scalp', 'yaml_import')`,
      )
      .run();
    conn1.db
      .prepare(
        `INSERT INTO family_evidence
         (family_id, evidence_status, evidence_score, promotion_state,
          local_trade_count, local_market_count, local_realized_pnl_fifo,
          open_tail_cost_usdc, tail_adjusted_pnl, both_sided_eligible, heavy_campaign_eligible)
         VALUES ('legacy-fam', 'confirmed', 1, 'probe-only', 0, 0, 0, 0, 0, 0, 0)`,
      )
      .run();
    conn1.db
      .prepare(
        `INSERT INTO family_rules
         (family_id, max_active_markets, max_dust_positions,
          tail_quarantine_threshold_usdc, tail_quarantine_threshold_ratio)
         VALUES ('legacy-fam', 2, 1, 25, 5.0)`,
      )
      .run();
    conn1.db
      .prepare(
        `INSERT INTO family_rules_snapshot (family_id, snapshot, reason, captured_at)
         VALUES ('legacy-fam', ?, 'probe-baseline', datetime('now', '-1 minute'))`,
      )
      .run(
        JSON.stringify({
          maxActiveMarkets: 2,
          maxDustPositions: 1,
          tailQuarantineThresholdUsdc: 25,
          tailQuarantineThresholdRatio: 5.0,
          scaleMode: "disabled",
        }),
      );
    conn1.close();

    const conn2 = bootstrapControlDb(dbPath);
    conns.push(conn2);

    const rules = conn2.db
      .prepare(
        `SELECT max_active_markets, max_dust_positions,
                tail_quarantine_threshold_usdc, tail_quarantine_threshold_ratio
           FROM family_rules
          WHERE family_id = 'legacy-fam'`,
      )
      .get() as Record<string, unknown>;
    expect(rules.max_active_markets).toBe(100);
    expect(rules.max_dust_positions).toBe(50);
    expect(rules.tail_quarantine_threshold_usdc).toBe(1000);
    expect(rules.tail_quarantine_threshold_ratio).toBe(1000);

    const snapshot = conn2.db
      .prepare(
        `SELECT snapshot, reason FROM family_rules_snapshot
          WHERE family_id = 'legacy-fam'
          ORDER BY captured_at DESC
          LIMIT 1`,
      )
      .get() as { snapshot: string; reason: string };
    const parsed = JSON.parse(snapshot.snapshot) as Record<string, unknown>;
    expect(parsed.maxActiveMarkets).toBe(100);
    expect(parsed.maxDustPositions).toBe(50);
    expect(parsed.tailQuarantineThresholdUsdc).toBe(1000);
    expect(parsed.tailQuarantineThresholdRatio).toBe(1000);
    expect(snapshot.reason).toContain("family-limit-unification-backfill");
  });

  it("bootstrapControlDb fixes legacy-inverted BUY size priorities on existing rules (spec v2.2)", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-ctrl-buy-prec-"));
    const dbPath = path.join(tmpDir, "control.db");

    // Simulate a control.db seeded under the pre-v2.2 precedence contract:
    // nth_buy rules (B5/B6/B7) at priorities 10/20/30, state+price (B1..B4) at 40..70.
    const conn1 = bootstrapControlDb(dbPath);
    conn1.db.exec("DELETE FROM algo_size_rules WHERE action_type = 'BUY'");
    conn1.db.exec("DELETE FROM bootstrap_backfills WHERE name LIKE '%buy-size-precedence%'");
    const insert = conn1.db.prepare(
      `INSERT INTO algo_size_rules (action_type, priority, rule_id, state_condition, price_operator, price_value, nth_buy, buy_count_min, buy_count_max, size_usdc)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("BUY", 10, "B5", "ANY", null, null, 1, null, null, 2.1);
    insert.run("BUY", 20, "B6", "ANY", null, null, 2, null, null, 1.17);
    insert.run("BUY", 30, "B7", "ANY", null, null, 3, null, null, 0.92);
    insert.run("BUY", 40, "B1", "OTHER", ">=", 0.2, null, null, null, 8.38);
    insert.run("BUY", 50, "B2", "S1", ">=", 0.2, null, null, null, 4.17);
    insert.run("BUY", 60, "B3", "S3", "<", 0.05, null, null, null, 0.76);
    insert.run("BUY", 70, "B4", "S2", "<", 0.05, null, null, null, 0.12);
    conn1.close();

    // Re-bootstrap should detect the legacy ordering and re-priority in place.
    const conn2 = bootstrapControlDb(dbPath);
    conns.push(conn2);

    const rows = conn2.db
      .prepare(
        "SELECT rule_id, priority FROM algo_size_rules WHERE action_type = 'BUY' AND rule_id IN ('B1','B2','B3','B4','B5','B6','B7') ORDER BY priority",
      )
      .all() as { rule_id: string; priority: number }[];

    expect(rows.map((r) => r.rule_id)).toEqual(["B1", "B2", "B3", "B4", "B5", "B6", "B7"]);
    expect(rows.map((r) => r.priority)).toEqual([10, 20, 30, 40, 50, 60, 70]);

    // And the backfill marker is recorded, so a third bootstrap is a no-op.
    const marker = conn2.db
      .prepare("SELECT name FROM bootstrap_backfills WHERE name LIKE '%buy-size-precedence%'")
      .get() as { name: string } | undefined;
    expect(marker).toBeDefined();
  });

  it("bootstrapLedgerDb is idempotent", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-ledger-idem-"));
    const dbPath = path.join(tmpDir, "ledger.db");
    const conn1 = bootstrapLedgerDb(dbPath);
    conn1.close();
    const conn2 = bootstrapLedgerDb(dbPath);
    conns.push(conn2);
    const tables = conn2.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThan(0);
  });
});
