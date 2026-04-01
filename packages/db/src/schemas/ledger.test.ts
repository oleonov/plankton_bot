import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("ledger.db schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "ledger.sql"),
      "utf-8",
    );
    db.exec(schema);
  });

  afterEach(() => db.close());

  it("creates all ledger tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("markets");
    expect(names).toContain("market_snapshots");
    expect(names).toContain("orders");
    expect(names).toContain("fills");
    expect(names).toContain("positions");
    expect(names).toContain("inventory_lots");
    expect(names).toContain("pnl_ledger");
    expect(names).toContain("settlement_ledger");
    expect(names).toContain("market_resolutions");
    expect(names).toContain("bot_runs");
    expect(names).toContain("runtime_metrics");
    expect(names).toContain("risk_events");
    expect(names).toContain("family_profile_runtime_state");
  });

  it("does NOT contain control tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).not.toContain("family_catalog");
    expect(names).not.toContain("family_rules");
    expect(names).not.toContain("family_deployments");
    expect(names).not.toContain("profiles");
    expect(names).not.toContain("operator_commands");
  });

  it("family_profile_runtime_state has no runtime_mode column", () => {
    const cols = db.prepare("PRAGMA table_info(family_profile_runtime_state)").all() as {
      name: string;
    }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("open_value_usdc");
    expect(names).toContain("effective_mode");
    expect(names).not.toContain("runtime_mode");
    expect(names).not.toContain("quarantine_reason");
  });
});
