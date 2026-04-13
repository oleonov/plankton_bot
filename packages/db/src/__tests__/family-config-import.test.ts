import { describe, expect, it } from "vitest";
import { parseFamilyRulesYaml } from "@plankton/config";
import { bootstrapControlDb } from "../bootstrap.js";
import {
  applyFamilyConfigImport,
  computeConfigChecksum,
  getLatestConfigImportMeta,
} from "../family-config-import.js";

const YAML = `
version: 1
global:
  initial_balance_usdc: 100
families:
  - family_id: "test-fast:generic:daily"
    identity:
      family_key: "test-fast"
      primary_category: "crypto"
      regime: "generic"
      horizon: "daily"
      cadence: "daily-dated"
      strategy_profile: "scalp"
    evidence:
      evidence_status: "unknown"
      evidence_score: 0
      promotion_state: "probe-only"
      local_trade_count: 0
      local_market_count: 0
      local_realized_pnl_fifo: 0
      open_tail_cost_usdc: 0
      tail_adjusted_pnl: 0
      both_sided_eligible: false
      heavy_campaign_eligible: false
    rules:
      universe:
        enabled: true
        action: "trade"
        priority_rank: 1
        session_mode: "active-window"
      entry:
        entry_mode: "probe-first"
        min_entry_price: 0.01
        max_entry_price: 0.2
        max_initial_notional_usdc: 5
        allow_high_price_one_shot: false
        high_price_threshold: 0.2
        require_proven_family_above_price: 0.2
        probe_size_usdc: 5
        add_size_usdc: 4
      scale_in:
        scale_mode: "confirm-only"
        default_max_buys_per_leg: 3
        heavy_max_buys_per_leg: 5
        allow_heavy_campaigns: false
        require_positive_recycle_history_for_scale: true
      exit:
        exit_mode: "repricing-sell"
        primary_profit_model: "sell-into-strength"
        allow_runner_extension: false
        prefer_fast_recycle: true
        resolution_holding_allowed: false
        resolution_buffer_minutes: 60
      two_sided:
        allow_two_sided: false
        two_sided_mode: "disabled"
      throughput:
        max_concurrent_orders_per_family: 3
        max_probe_in_flight_per_token: 1
        max_entry_signals_per_tick_per_family: 1
        fast_lane_enabled: true
        dust_lane_enabled: true
      tail_suppression:
        max_open_value_usdc: 50
        max_active_markets: 5
        max_dust_positions: 3
        tail_quarantine_threshold_usdc: 50
        tail_quarantine_threshold_ratio: 1.0
        stale_tail_prune_enabled: false
        threshold_cleanup_required: false
        auto_settle_resolved_markets: true
      session:
        active_windows_utc:
          - start: "00:00"
            end: "23:59"
        reduced_windows_utc: []
        weekday_bias: "normal"
`;

const YAML_WITH_DEFAULTS = YAML.replace(
  "global:\n  initial_balance_usdc: 100\n",
  [
    "global:",
    "  initial_balance_usdc: 100",
    "defaults:",
    "  entry:",
    "    min_entry_price: 0.01",
    "    max_entry_price: 0.2",
    "    high_price_threshold: 0.2",
    "    require_proven_family_above_price: 0.2",
    '    preferred_entry_band: "0.01-0.20"',
    "",
  ].join("\n"),
).replace(/^\s*max_entry_price: 0\.2\n/m, "");

describe("family-config-import", () => {
  it("applies YAML families and records checksum metadata", () => {
    const conn = bootstrapControlDb(":memory:");
    try {
      const loaded = parseFamilyRulesYaml(YAML, "test");
      const checksum = computeConfigChecksum(YAML);
      const result = conn.db.transaction(() =>
        applyFamilyConfigImport(conn.db, loaded, {
          dryRun: false,
          sourcePath: "/tmp/family_rules.yaml",
          sourceChecksum: checksum,
          sourceVersion: 1,
          importedBy: "test",
        }),
      )();

      expect(result.added).toEqual(["test-fast:generic:daily"]);
      expect(result.updated).toEqual([]);

      const latest = getLatestConfigImportMeta(conn.db);
      expect(latest?.sourceChecksum).toBe(checksum);
      expect(latest?.sourcePath).toBe("/tmp/family_rules.yaml");
      expect(latest?.importedBy).toBe("test");
      const row = conn.db
        .prepare(
          "SELECT fast_lane_enabled, dust_lane_enabled FROM family_rules WHERE family_id = ?",
        )
        .get("test-fast:generic:daily") as {
        fast_lane_enabled: number | null;
        dust_lane_enabled: number | null;
      };
      expect(row.fast_lane_enabled).toBe(1);
      expect(row.dust_lane_enabled).toBe(1);
    } finally {
      conn.close();
    }
  });

  it("re-syncs family deployments for updated families", () => {
    const conn = bootstrapControlDb(":memory:");
    try {
      const loaded = parseFamilyRulesYaml(YAML, "test");
      const checksum = computeConfigChecksum(YAML);
      conn.db.transaction(() =>
        applyFamilyConfigImport(conn.db, loaded, {
          dryRun: false,
          sourcePath: "/tmp/family_rules.yaml",
          sourceChecksum: checksum,
          sourceVersion: 1,
          importedBy: "test",
        }),
      )();

      conn.db
        .prepare(
          "UPDATE family_deployments SET enabled = 0, deployment_stage = 'disabled' WHERE family_id = ? AND profile = 'live-lite'",
        )
        .run("test-fast:generic:daily");

      const updatedYaml = YAML.replace("priority_rank: 1", "priority_rank: 2");
      const updated = parseFamilyRulesYaml(updatedYaml, "test");
      conn.db.transaction(() =>
        applyFamilyConfigImport(conn.db, updated, {
          dryRun: false,
          sourcePath: "/tmp/family_rules.yaml",
          sourceChecksum: computeConfigChecksum(updatedYaml),
          sourceVersion: 2,
          importedBy: "test",
        }),
      )();

      const deployment = conn.db
        .prepare(
          "SELECT enabled, deployment_stage FROM family_deployments WHERE family_id = ? AND profile = 'live-lite'",
        )
        .get("test-fast:generic:daily") as {
        enabled: number;
        deployment_stage: string;
      };

      expect(deployment.enabled).toBe(1);
      expect(deployment.deployment_stage).toBe("live-probe");
    } finally {
      conn.close();
    }
  });

  it("materializes defaults-based max_entry_price and treats equivalent explicit config as unchanged", () => {
    const conn = bootstrapControlDb(":memory:");
    try {
      const loadedWithDefaults = parseFamilyRulesYaml(YAML_WITH_DEFAULTS, "test");
      conn.db.transaction(() =>
        applyFamilyConfigImport(conn.db, loadedWithDefaults, {
          dryRun: false,
          sourcePath: "/tmp/family_rules.yaml",
          sourceChecksum: computeConfigChecksum(YAML_WITH_DEFAULTS),
          sourceVersion: 1,
          importedBy: "test",
        }),
      )();

      const row = conn.db
        .prepare("SELECT max_entry_price FROM family_rules WHERE family_id = ?")
        .get("test-fast:generic:daily") as {
        max_entry_price: number;
      };
      expect(row.max_entry_price).toBe(0.2);
      const defaultsRow = conn.db
        .prepare(
          "SELECT min_entry_price, max_entry_price, preferred_entry_band FROM family_rule_defaults WHERE scope = 'global'",
        )
        .get() as {
        min_entry_price: number;
        max_entry_price: number;
        preferred_entry_band: string | null;
      };
      expect(defaultsRow).toEqual({
        min_entry_price: 0.01,
        max_entry_price: 0.2,
        preferred_entry_band: "0.01-0.20",
      });

      const loadedExplicit = parseFamilyRulesYaml(YAML, "test");
      const result = conn.db.transaction(() =>
        applyFamilyConfigImport(conn.db, loadedExplicit, {
          dryRun: false,
          sourcePath: "/tmp/family_rules.yaml",
          sourceChecksum: computeConfigChecksum(YAML),
          sourceVersion: 2,
          importedBy: "test",
        }),
      )();

      expect(result.unchanged).toEqual(["test-fast:generic:daily"]);
      expect(result.updated).toEqual([]);
    } finally {
      conn.close();
    }
  });
});
