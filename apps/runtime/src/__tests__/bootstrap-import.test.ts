import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabase, type DbConnection } from "@plankton/db";
import {
  needsBootstrap,
  bootstrapImport,
  syncProfileInitialBalances,
} from "../bootstrap-import.js";
import type { LoadedFamilyRules } from "@plankton/config";

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
      sprayCooldownSeconds: 5,
      sprayBudgetUsdc: 50,
      sprayMaxTotalPositions: 30,
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
            allowWeekends: true,
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
            weekendMode: "normal",
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
    expect(row.max_open_value_usdc).toBe(45.0);
    expect(row.stale_tail_prune_enabled).toBe(1);
    expect(JSON.parse(row.active_windows_utc as string)).toEqual([
      { start: "14:00", end: "21:00" },
    ]);
    expect(JSON.parse(row.reduced_windows_utc as string)).toEqual([]);
    expect(row.weekday_bias).toBe("preferred");
    expect(row.weekend_mode).toBe("normal");
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
});
