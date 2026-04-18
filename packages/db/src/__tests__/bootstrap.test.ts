import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
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

  it("one-time backfills legacy family limit rows and latest snapshots", () => {
    conn.db
      .prepare(
        `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, source_type)
         VALUES ('legacy-fam', 'legacy-fam', 'crypto', 'threshold', 'daily', 'daily', 'scalp', 'yaml_import')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT INTO family_evidence
         (family_id, evidence_status, evidence_score, promotion_state,
          local_trade_count, local_market_count, local_realized_pnl_fifo,
          open_tail_cost_usdc, tail_adjusted_pnl, both_sided_eligible, heavy_campaign_eligible)
         VALUES ('legacy-fam', 'confirmed', 1, 'probe-only', 0, 0, 0, 0, 0, 0, 0)`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT INTO family_rules
         (family_id, max_active_markets, max_dust_positions,
          tail_quarantine_threshold_usdc, tail_quarantine_threshold_ratio)
         VALUES ('legacy-fam', 3, 2, 50, 1.0)`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT INTO family_rules_snapshot (family_id, snapshot, reason, captured_at)
         VALUES ('legacy-fam', ?, 'probe-baseline', datetime('now', '-1 minute'))`,
      )
      .run(
        JSON.stringify({
          maxActiveMarkets: 3,
          maxDustPositions: 2,
          tailQuarantineThresholdUsdc: 50,
          tailQuarantineThresholdRatio: 1.0,
          scaleMode: "disabled",
        }),
      );

    conn.close();
    conn = bootstrapDatabase(path.join(tmpDir, "test.db"));

    const rules = conn.db
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

    const snapshot = conn.db
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
});
