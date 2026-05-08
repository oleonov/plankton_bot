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
    expect(names).toContain("merge_ledger");
    expect(names).toContain("settlement_ledger");
    expect(names).toContain("market_resolutions");
    expect(names).toContain("bot_runs");
    expect(names).toContain("runtime_metrics");
    expect(names).toContain("risk_events");
    expect(names).toContain("decision_signal_log");
    expect(names).toContain("algo_token_mode_state");
    // family_runtime_state and family_profile_runtime_state dropped by migration 035
    expect(names).not.toContain("family_runtime_state");
    expect(names).not.toContain("family_profile_runtime_state");
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

  it("family_runtime_state and family_profile_runtime_state are absent (dropped by migration 035)", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).not.toContain("family_runtime_state");
    expect(names).not.toContain("family_profile_runtime_state");
  });

  it("creates P0 telemetry columns", () => {
    const orderColumns = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>;
    expect(orderColumns.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "decision_rule_id",
        "signal_timestamp",
        "exchange_error_code",
        "exchange_error_message",
        "exchange_error_payload",
      ]),
    );

    const fillColumns = db.prepare("PRAGMA table_info(fills)").all() as Array<{ name: string }>;
    expect(fillColumns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["signal_id", "decision_rule_id", "signal_timestamp"]),
    );

    const observationColumns = db
      .prepare("PRAGMA table_info(execution_policy_observations)")
      .all() as Array<{ name: string }>;
    expect(observationColumns.map((c) => c.name)).toContain("decision_rule_id");
  });
});
