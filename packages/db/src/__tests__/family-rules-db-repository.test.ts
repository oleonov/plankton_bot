import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteFamilyRulesDbRepository } from "../repositories/family-rules-db-repository.js";
import type Database from "better-sqlite3";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteFamilyRulesDbRepository;

function seedFamily(db: Database.Database, familyId: string): void {
  db.prepare(
    `INSERT INTO family_catalog
       (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(familyId, "test-key", "crypto", "threshold", "daily", "daily", "scalp");

  db.prepare(
    `INSERT INTO family_evidence
       (family_id, evidence_status, evidence_score, promotion_state,
        local_trade_count, local_market_count, local_realized_pnl_fifo,
        open_tail_cost_usdc, tail_adjusted_pnl,
        both_sided_eligible, heavy_campaign_eligible)
     VALUES (?, 'confirmed', 80, 'probe-only', 10, 5, 15.5, 2.0, 13.5, 1, 0)`,
  ).run(familyId);

  db.prepare(
    `INSERT INTO family_rules
       (family_id, enabled, action, priority_rank, allow_weekends, session_mode,
        entry_mode, min_entry_price, max_entry_price, max_initial_notional_usdc,
        allow_high_price_one_shot, high_price_threshold, require_proven_family_above_price,
        scale_mode, default_max_buys_per_leg, heavy_max_buys_per_leg,
        allow_heavy_campaigns, require_positive_recycle_history_for_scale,
        exit_mode, primary_profit_model, allow_runner_extension, prefer_fast_recycle,
        resolution_holding_allowed,
        allow_two_sided, two_sided_mode,
        max_open_value_usdc, max_active_markets, max_dust_positions,
        tail_quarantine_threshold_usdc, tail_quarantine_threshold_ratio,
        stale_tail_prune_enabled, threshold_cleanup_required,
        active_windows_utc, reduced_windows_utc, weekday_bias, weekend_mode)
     VALUES (?, 1, 'trade', 1, 0, 'active-window',
             'probe-first', 0.05, 0.50, 10,
             0, 0.20, 0.20,
             'confirm-only', 3, 6,
             0, 1,
             'repricing-sell', 'sell-into-strength', 0, 1,
             0,
             0, 'disabled',
             50, 5, 3,
             50, 1.0,
             0, 0,
             '[{"start":"14:00","end":"22:00"}]', '[]', 'normal', 'reduced')`,
  ).run(familyId);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteFamilyRulesDbRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteFamilyRulesDbRepository", () => {
  it("loadAll returns empty array when no families exist", () => {
    expect(repo.loadAll()).toHaveLength(0);
  });

  it("loadAll returns correctly shaped FamilyConfig", () => {
    seedFamily(conn.db, "fam-1");

    const configs = repo.loadAll();
    expect(configs).toHaveLength(1);

    const cfg = configs[0]!;
    // Identity
    expect(cfg.identity.familyId).toBe("fam-1");
    expect(cfg.identity.familyKey).toBe("test-key");
    expect(cfg.identity.regime).toBe("threshold");
    expect(cfg.identity.strategyProfile).toBe("scalp");

    // Evidence
    expect(cfg.evidence.familyId).toBe("fam-1");
    expect(cfg.evidence.evidenceStatus).toBe("confirmed");
    expect(cfg.evidence.evidenceScore).toBe(80);
    expect(cfg.evidence.localTradeCount).toBe(10);
    expect(cfg.evidence.bothSidedEligible).toBe(true);
    expect(cfg.evidence.heavyCampaignEligible).toBe(false);

    // Rules - universe
    expect(cfg.rules.familyId).toBe("fam-1");
    expect(cfg.rules.universe.enabled).toBe(true);
    expect(cfg.rules.universe.action).toBe("trade");

    // Rules - entry
    expect(cfg.rules.entry.entryMode).toBe("probe-first");
    expect(cfg.rules.entry.minEntryPrice).toBe(0.05);
    expect(cfg.rules.entry.maxEntryPrice).toBe(0.50);

    // Rules - session (JSON parsed)
    expect(cfg.rules.session.activeWindowsUtc).toHaveLength(1);
    expect(cfg.rules.session.activeWindowsUtc[0]).toEqual({ start: "14:00", end: "22:00" });
    expect(cfg.rules.session.weekendMode).toBe("reduced");
  });

  it("loadAll returns multiple families", () => {
    seedFamily(conn.db, "fam-1");
    seedFamily(conn.db, "fam-2");

    const configs = repo.loadAll();
    expect(configs).toHaveLength(2);
  });

  it("overwriteRules updates rule columns", () => {
    seedFamily(conn.db, "fam-1");

    repo.overwriteRules(
      "fam-1" as FamilyId,
      JSON.stringify({
        enabled: false,
        action: "blocked",
        priorityRank: 999,
        allowWeekends: false,
        sessionMode: "active-window",
        entryMode: "disabled",
        minEntryPrice: 0,
        maxEntryPrice: 1,
        maxInitialNotionalUsdc: 5,
        allowHighPriceOneShot: false,
        highPriceThreshold: 0.20,
        requireProvenFamilyAbovePrice: 0.20,
        scaleMode: "disabled",
        defaultMaxBuysPerLeg: 3,
        heavyMaxBuysPerLeg: 6,
        allowHeavyCampaigns: false,
        requirePositiveRecycleHistoryForScale: true,
        exitMode: "disabled",
        primaryProfitModel: "sell-into-strength",
        allowRunnerExtension: false,
        preferFastRecycle: true,
        resolutionHoldingAllowed: false,
        allowTwoSided: false,
        twoSidedMode: "disabled",
        maxOpenValueUsdc: 25,
        maxActiveMarkets: 3,
        maxDustPositions: 2,
        tailQuarantineThresholdUsdc: 25,
        tailQuarantineThresholdRatio: 0.5,
        staleTailPruneEnabled: false,
        thresholdCleanupRequired: false,
        activeWindowsUtc: [],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
        weekendMode: "disabled",
      }),
    );

    const configs = repo.loadAll();
    const cfg = configs[0]!;
    expect(cfg.rules.universe.enabled).toBe(false);
    expect(cfg.rules.universe.action).toBe("blocked");
    expect(cfg.rules.entry.entryMode).toBe("disabled");
    expect(cfg.rules.tailSuppression.maxOpenValueUsdc).toBe(25);
    expect(cfg.rules.session.weekendMode).toBe("disabled");
  });
});

// Branded type import for overwriteRules call
import type { FamilyId } from "@plankton/domain";
