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
        `INSERT INTO profiles (profile_id, display_name)
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
