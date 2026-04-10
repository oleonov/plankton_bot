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
