import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import path from "node:path";
import { openDatabase, type DbConnection } from "@plankton/db";
import {
  needsBootstrap,
  bootstrapImport,
  syncProfileInitialBalances,
  maybeBootstrapFromYaml,
} from "../bootstrap-import.js";
import { parseFamilyRulesYaml, type LoadedFamilyRules } from "@plankton/config";

const CONTROL_SQL = readFileSync(
  resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

function createControlDb(): DbConnection {
  const conn = openDatabase(":memory:");
  conn.db.exec(CONTROL_SQL);
  return conn;
}

function makeMockLoaded(): LoadedFamilyRules {
  return {
    global: {
      initialBalanceUsdc: 100,
      spraySizeUsdc: 0.15,
      sprayMaxMarketsPerTick: 10,
      dustLaneMaxMarketsPerTick: 100,
      sprayCooldownSeconds: 5,
      sprayBudgetUsdc: 50,
      sprayMaxTotalPositions: 30,
    },
    defaults: {
      entry: {
        minEntryPrice: 0.03,
        maxEntryPrice: 0.2,
        highPriceThreshold: 0.2,
        requireProvenFamilyAbovePrice: 0.2,
        preferredEntryBand: "0.03-0.20",
      },
    },
    families: [
      {
        identity: {
          familyId: "test-family:generic:daily",
          familyKey: "test-family",
          primaryCategory: "crypto-btc",
          regime: "generic",
          horizon: "daily",
          cadence: "daily-dated",
          strategyProfile: "scalp",
          topicKey: "bitcoin",
          slugPattern: "test-family-*",
          notes: "Test family for bootstrap",
        },
        evidence: {
          familyId: "test-family:generic:daily",
          evidenceStatus: "confirmed",
          evidenceScore: 120,
          promotionState: "scaled",
          localTradeCount: 500,
          localMarketCount: 20,
          localRealizedPnlFifo: 200,
          openTailCostUsdc: 10,
          tailAdjustedPnl: 190,
          remoteClosedRealizedPnl: null,
          openPositionCount: 0,
          openDustCount: 0,
          bothSidedEligible: false,
          heavyCampaignEligible: false,
          activeWindowEdgeScore: 1.0,
          lastValidatedAt: "2026-03-19T00:00:00Z",
        },
        rules: {
          familyId: "test-family:generic:daily",
          universe: {
            enabled: true,
            action: "trade",
            priorityRank: 1,
            sessionMode: "active-window",
          },
          entry: {
            entryMode: "probe-first",
            minEntryPrice: 0.03,
            maxEntryPrice: 0.2,
            maxInitialNotionalUsdc: 5.0,
            allowHighPriceOneShot: false,
            highPriceThreshold: 0.2,
            requireProvenFamilyAbovePrice: 0.2,
            preferredEntryBand: "0.05-0.20",
            maxProbeCountPerMarket: 1,
            entryCooldownSeconds: 30,
            maxNewMarketsPerSession: 10,
            probeSizeUsdc: 5.0,
            addSizeUsdc: 4.0,
          },
          scaleIn: {
            scaleMode: "confirm-only",
            defaultMaxBuysPerLeg: 3,
            heavyMaxBuysPerLeg: 4,
            allowHeavyCampaigns: false,
            requirePositiveRecycleHistoryForScale: true,
          },
          exit: {
            exitMode: "repricing-sell",
            primaryProfitModel: "sell-into-strength",
            allowRunnerExtension: true,
            preferFastRecycle: true,
            resolutionHoldingAllowed: false,
            resolutionBufferMinutes: 60,
            targetRoiBandLow: 20.0,
            targetRoiBandHigh: 50.0,
            maxUnmovedHoldHours: null,
            maxTailHoldHours: 24,
          },
          twoSided: {
            allowTwoSided: false,
            twoSidedMode: "disabled",
            minActivityForTwoSided: null,
          },
          throughput: {
            maxConcurrentOrdersPerFamily: 50,
            maxProbeInFlightPerToken: 3,
            maxEntrySignalsPerTickPerFamily: 20,
          },
          tailSuppression: {
            maxOpenValueUsdc: 45.0,
            maxActiveMarkets: 8,
            maxDustPositions: 3,
            tailQuarantineThresholdUsdc: 45.0,
            tailQuarantineThresholdRatio: 1.0,
            staleTailPruneEnabled: true,
            thresholdCleanupRequired: false,
            autoSettleResolvedMarkets: true,
          },
          session: {
            activeWindowsUtc: [{ start: "14:00", end: "21:00" }],
            reducedWindowsUtc: [],
            weekdayBias: "preferred",
          },
        },
      } as unknown as LoadedFamilyRules["families"][number],
    ],
  };
}

describe("bootstrap-import", () => {
  let conn: DbConnection;
  let db: import("better-sqlite3").Database;
  const loaded = makeMockLoaded();

  beforeEach(() => {
    conn = createControlDb();
    db = conn.db;
  });

  it("needsBootstrap returns true on empty DB", () => {
    expect(needsBootstrap(db)).toBe(true);
  });

  it("needsBootstrap returns false after seeding", () => {
    bootstrapImport(db, loaded);
    expect(needsBootstrap(db)).toBe(false);
  });

  it("creates all 3 profiles", () => {
    bootstrapImport(db, loaded);
    const rows = db.prepare("SELECT profile_id FROM profiles ORDER BY profile_id").all() as Array<{
      profile_id: string;
    }>;
    expect(rows.map((r) => r.profile_id)).toEqual(["live-lite", "paper", "simulation"]);
  });

  it("creates profile_settings with correct balances", () => {
    bootstrapImport(db, loaded);
    const rows = db
      .prepare("SELECT profile_id, initial_balance_usdc FROM profile_settings ORDER BY profile_id")
      .all() as Array<{ profile_id: string; initial_balance_usdc: number | null }>;

    expect(rows).toEqual([
      { profile_id: "live-lite", initial_balance_usdc: 100 },
      { profile_id: "paper", initial_balance_usdc: 100 },
      { profile_id: "simulation", initial_balance_usdc: 100 },
    ]);
  });

  it("fills missing initial balances for existing profile_settings rows", () => {
    bootstrapImport(db, loaded);
    db.prepare(
      "UPDATE profile_settings SET initial_balance_usdc = NULL WHERE profile_id = 'live-lite'",
    ).run();

    syncProfileInitialBalances(db, 100);

    const row = db
      .prepare("SELECT initial_balance_usdc FROM profile_settings WHERE profile_id = 'live-lite'")
      .get() as { initial_balance_usdc: number | null };

    expect(row.initial_balance_usdc).toBe(100);
  });

  it("does not overwrite explicit non-null balances", () => {
    bootstrapImport(db, loaded);
    db.prepare(
      "UPDATE profile_settings SET initial_balance_usdc = 250 WHERE profile_id = 'live-lite'",
    ).run();

    syncProfileInitialBalances(db, 100);

    const row = db
      .prepare("SELECT initial_balance_usdc FROM profile_settings WHERE profile_id = 'live-lite'")
      .get() as { initial_balance_usdc: number | null };

    expect(row.initial_balance_usdc).toBe(250);
  });

  it("creates family_catalog entries", () => {
    bootstrapImport(db, loaded);
    const rows = db
      .prepare("SELECT family_id, family_key, regime FROM family_catalog")
      .all() as Array<{
      family_id: string;
      family_key: string;
      regime: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.family_id).toBe("test-family:generic:daily");
    expect(rows[0]!.family_key).toBe("test-family");
    expect(rows[0]!.regime).toBe("generic");
  });

  it("creates family_rules entries with all columns", () => {
    bootstrapImport(db, loaded);
    const row = db
      .prepare("SELECT * FROM family_rules WHERE family_id = ?")
      .get("test-family:generic:daily") as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.enabled).toBe(1);
    expect(row.action).toBe("trade");
    expect(row.priority_rank).toBe(1);
    expect(row.entry_mode).toBe("probe-first");
    expect(row.min_entry_price).toBe(0.03);
    expect(row.scale_mode).toBe("confirm-only");
    expect(row.exit_mode).toBe("repricing-sell");
    expect(row.allow_two_sided).toBe(0);
    expect(row.max_concurrent_orders_per_family).toBe(50);
    expect(row.max_probe_in_flight_per_token).toBe(3);
    expect(row.max_entry_signals_per_tick_per_family).toBe(20);
    expect(row.max_open_value_usdc).toBe(45.0);
    expect(row.stale_tail_prune_enabled).toBe(1);
    expect(JSON.parse(row.active_windows_utc as string)).toEqual([
      { start: "14:00", end: "21:00" },
    ]);
    expect(JSON.parse(row.reduced_windows_utc as string)).toEqual([]);
    expect(row.weekday_bias).toBe("preferred");
  });

  it("materializes defaults.entry.max_entry_price before writing family_rules", () => {
    const yaml = `
version: 1
defaults:
  entry:
    min_entry_price: 0.03
    max_entry_price: 0.27
    high_price_threshold: 0.27
    require_proven_family_above_price: 0.27
    preferred_entry_band: "0.03-0.27"
families:
  - family_id: "defaulted-family:generic:daily"
    identity:
      family_key: "defaulted-family"
      primary_category: "crypto-btc"
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
        min_entry_price: 0.03
        max_initial_notional_usdc: 5
        allow_high_price_one_shot: false
        high_price_threshold: 0.27
        require_proven_family_above_price: 0.27
      scale_in:
        scale_mode: "confirm-only"
        default_max_buys_per_leg: 3
        heavy_max_buys_per_leg: 4
        allow_heavy_campaigns: false
        require_positive_recycle_history_for_scale: true
      exit:
        exit_mode: "repricing-sell"
        primary_profit_model: "sell-into-strength"
        allow_runner_extension: false
        prefer_fast_recycle: true
        resolution_holding_allowed: false
      two_sided:
        allow_two_sided: false
        two_sided_mode: "disabled"
      tail_suppression:
        max_open_value_usdc: 45
        max_active_markets: 8
        max_dust_positions: 3
        tail_quarantine_threshold_usdc: 45
        tail_quarantine_threshold_ratio: 1.0
        stale_tail_prune_enabled: true
        threshold_cleanup_required: false
        auto_settle_resolved_markets: true
      session:
        active_windows_utc:
          - start: "14:00"
            end: "21:00"
        reduced_windows_utc: []
        weekday_bias: "preferred"
`;

    const loadedWithDefaults = parseFamilyRulesYaml(yaml, "test");
    bootstrapImport(db, loadedWithDefaults);

    const row = db
      .prepare("SELECT max_entry_price FROM family_rules WHERE family_id = ?")
      .get("defaulted-family:generic:daily") as { max_entry_price: number };
    const defaultsRow = db
      .prepare(
        "SELECT min_entry_price, max_entry_price, preferred_entry_band FROM family_rule_defaults WHERE scope = 'global'",
      )
      .get() as {
      min_entry_price: number;
      max_entry_price: number;
      preferred_entry_band: string | null;
    };

    expect(row.max_entry_price).toBe(0.27);
    expect(defaultsRow).toEqual({
      min_entry_price: 0.03,
      max_entry_price: 0.27,
      preferred_entry_band: "0.03-0.27",
    });
  });

  it("creates family_deployments (sim/paper enabled, live-lite probe-enabled)", () => {
    bootstrapImport(db, loaded);
    const rows = db
      .prepare(
        "SELECT profile, enabled, deployment_stage FROM family_deployments WHERE family_id = ? ORDER BY profile",
      )
      .all("test-family:generic:daily") as Array<{
      profile: string;
      enabled: number;
      deployment_stage: string;
    }>;

    expect(rows).toEqual([
      { profile: "live-lite", enabled: 1, deployment_stage: "live-probe" },
      { profile: "paper", enabled: 1, deployment_stage: "disabled" },
      { profile: "simulation", enabled: 1, deployment_stage: "disabled" },
    ]);
  });

  it("creates runtime_control_state with desired_profile='simulation'", () => {
    bootstrapImport(db, loaded);
    const row = db.prepare("SELECT * FROM runtime_control_state WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    expect(row).toBeDefined();
    expect(row.desired_profile).toBe("simulation");
    expect(row.paused).toBe(1);
    expect(row.runtime_status).toBe("stopped");
    expect(row.schema_version).toBe(1);
  });

  it("creates config_imports record", () => {
    bootstrapImport(db, loaded);
    const row = db.prepare("SELECT * FROM config_imports").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.imported_by).toBe("bootstrap");
    expect(row.source_checksum).toBe("bootstrap");
    expect(row.families_added).toBe(1);
    expect(row.families_updated).toBe(0);
  });

  it("creates family_evidence baseline rows", () => {
    bootstrapImport(db, loaded);
    const rows = db.prepare("SELECT * FROM family_evidence").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.family_id).toBe("test-family:generic:daily");
    expect(rows[0]!.evidence_status).toBe("unknown");
    expect(rows[0]!.evidence_score).toBe(0);
  });

  it("records explicit source metadata when bootstrap import is given a checksum", () => {
    bootstrapImport(db, loaded, {
      sourcePath: "/tmp/family_rules.yaml",
      sourceChecksum: "sha256:test",
      sourceVersion: 1,
      importedBy: "bootstrap-test",
    });

    const row = db.prepare("SELECT * FROM config_imports").get() as Record<string, unknown>;
    expect(row.source_path).toBe("/tmp/family_rules.yaml");
    expect(row.source_checksum).toBe("sha256:test");
    expect(row.source_version).toBe(1);
    expect(row.imported_by).toBe("bootstrap-test");
  });
});

describe("maybeBootstrapFromYaml", () => {
  const MINIMAL_YAML = `
version: 1
defaults:
  entry:
    min_entry_price: 0.03
    max_entry_price: 0.2
    high_price_threshold: 0.2
    require_proven_family_above_price: 0.2
    preferred_entry_band: "0.03-0.20"
families:
  - family_id: "maybe-family:generic:daily"
    identity:
      family_key: "maybe-family"
      primary_category: "crypto-btc"
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
        min_entry_price: 0.03
        max_initial_notional_usdc: 5
        allow_high_price_one_shot: false
        high_price_threshold: 0.2
        require_proven_family_above_price: 0.2
      scale_in:
        scale_mode: "confirm-only"
        default_max_buys_per_leg: 3
        heavy_max_buys_per_leg: 4
        allow_heavy_campaigns: false
        require_positive_recycle_history_for_scale: true
      exit:
        exit_mode: "repricing-sell"
        primary_profit_model: "sell-into-strength"
        allow_runner_extension: false
        prefer_fast_recycle: true
        resolution_holding_allowed: false
      two_sided:
        allow_two_sided: false
        two_sided_mode: "disabled"
      tail_suppression:
        max_open_value_usdc: 45
        max_active_markets: 8
        max_dust_positions: 3
        tail_quarantine_threshold_usdc: 45
        tail_quarantine_threshold_ratio: 1.0
        stale_tail_prune_enabled: true
        threshold_cleanup_required: false
        auto_settle_resolved_markets: true
      session:
        active_windows_utc:
          - start: "14:00"
            end: "21:00"
        reduced_windows_utc: []
        weekday_bias: "preferred"
`;

  let conn: DbConnection;
  let db: import("better-sqlite3").Database;
  let tmpDir: string;
  let yamlPath: string;

  beforeEach(() => {
    conn = openDatabase(":memory:");
    const controlSql = readFileSync(
      resolve(import.meta.dirname, "../../../../packages/db/src/schemas/control.sql"),
      "utf-8",
    );
    conn.db.exec(controlSql);
    db = conn.db;

    tmpDir = mkdtempSync(path.join(os.tmpdir(), "plankton-bootstrap-"));
    yamlPath = path.join(tmpDir, "family_rules.yaml");
    writeFileSync(yamlPath, MINIMAL_YAML, "utf-8");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports from YAML when control.db is empty", () => {
    const result = maybeBootstrapFromYaml(db, yamlPath);

    expect(result.bootstrapped).toBe(true);
    expect(result.importedFamilies).toBe(1);
    expect(needsBootstrap(db)).toBe(false);
    const families = db.prepare("SELECT family_id FROM family_catalog").all() as Array<{
      family_id: string;
    }>;
    expect(families.map((f) => f.family_id)).toContain("maybe-family:generic:daily");
  });

  it("does NOT read YAML when control.db is already bootstrapped", () => {
    maybeBootstrapFromYaml(db, yamlPath);
    rmSync(yamlPath);

    const result = maybeBootstrapFromYaml(db, yamlPath);

    expect(result.bootstrapped).toBe(false);
    expect(result.importedFamilies).toBe(0);
  });

  it("throws a clear error when DB is empty and YAML file is missing", () => {
    const missingPath = path.join(tmpDir, "does-not-exist.yaml");
    expect(() => maybeBootstrapFromYaml(db, missingPath)).toThrow(/family rules/i);
  });

  it("records source metadata (path + sha256 checksum) for imported config", () => {
    maybeBootstrapFromYaml(db, yamlPath);

    const row = db.prepare("SELECT * FROM config_imports").get() as Record<string, unknown>;
    expect(row.source_path).toBe(yamlPath);
    expect(row.source_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(row.imported_by).toBe("bootstrap");
  });
});
