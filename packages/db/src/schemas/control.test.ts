import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

describe("control.db schema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    const schema = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "control.sql"),
      "utf-8",
    );
    db.exec(schema);
  });

  afterEach(() => db.close());

  it("creates all control tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("profiles");
    expect(names).toContain("profile_settings");
    expect(names).toContain("profile_summaries");
    // family_ tables dropped by migration 036
    expect(names).not.toContain("family_catalog");
    expect(names).not.toContain("family_rules");
    expect(names).not.toContain("family_rules_snapshot");
    expect(names).not.toContain("family_deployments");
    expect(names).not.toContain("family_validation_scorecards");
    expect(names).not.toContain("family_validation_latest");
    expect(names).not.toContain("family_profile_rollups");
    expect(names).not.toContain("family_config_meta");
    expect(names).not.toContain("family_evidence");
    expect(names).toContain("runtime_control_state");
    expect(names).toContain("operator_commands");
    expect(names).toContain("operator_actions");
    expect(names).toContain("state_transitions");
    expect(names).toContain("service_heartbeats");
    expect(names).toContain("config_imports");
    expect(names).toContain("profile_switch_requests");
    expect(names).toContain("preflight_reports");
  });

  it("enforces profile_settings FK to profiles", () => {
    db.prepare(
      "INSERT INTO profiles (profile_id, display_name) VALUES ('simulation', 'Simulation')",
    ).run();

    // Valid FK
    expect(() => {
      db.prepare(
        "INSERT INTO profile_settings (profile_id) VALUES ('simulation')",
      ).run();
    }).not.toThrow();

    // Invalid FK
    expect(() => {
      db.prepare(
        "INSERT INTO profile_settings (profile_id) VALUES ('nonexistent')",
      ).run();
    }).toThrow(/FOREIGN KEY/);
  });

  it("enforces runtime_control_state singleton", () => {
    db.prepare(
      "INSERT INTO profiles (profile_id, display_name) VALUES ('simulation', 'Simulation')",
    ).run();
    db.prepare(
      "INSERT INTO runtime_control_state (id, desired_profile) VALUES (1, 'simulation')",
    ).run();

    expect(() => {
      db.prepare(
        "INSERT INTO runtime_control_state (id, desired_profile) VALUES (2, 'simulation')",
      ).run();
    }).toThrow(); // CHECK constraint: id = 1
  });

  it("enforces selection_rules UNIQUE constraint on (profile_id, rule_type, pattern)", () => {
    db.prepare(
      "INSERT INTO profiles (profile_id, display_name) VALUES ('simulation', 'Simulation')",
    ).run();
    db.prepare(
      "INSERT INTO selection_rules (rule_id, profile_id, rule_type, pattern) VALUES ('r1', 'simulation', 'include_prefix', 'elon-')",
    ).run();

    expect(() => {
      db.prepare(
        "INSERT INTO selection_rules (rule_id, profile_id, rule_type, pattern) VALUES ('r2', 'simulation', 'include_prefix', 'elon-')",
      ).run();
    }).toThrow(/UNIQUE/);
  });
});
