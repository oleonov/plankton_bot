import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openDatabaseWithSchema, type DbConnection } from "@plankton/db";
import { createFamilyId } from "@plankton/domain";
import { DbFamilyRulesProvider } from "../db-family-rules-provider.js";

const CONTROL_SQL = readFileSync(
  resolve(__dirname, "../../../../packages/db/src/schemas/control.sql"),
  "utf-8",
);

function seedTestData(db: DbConnection["db"], opts?: { enabled?: number }) {
  const enabled = opts?.enabled ?? 1;

  db.exec(`
    INSERT INTO profiles (profile_id, display_name)
    VALUES ('paper', 'Paper Trading');

    INSERT INTO family_catalog (
      family_id, family_key, primary_category, regime, horizon, cadence,
      strategy_profile, topic_key, slug_pattern, notes
    ) VALUES (
      'fam-001', 'btc-weekly', 'crypto', 'threshold', 'weekly', 'weekly',
      'scalp', 'bitcoin', 'btc-*', 'test notes'
    );

    INSERT INTO family_rules (
      family_id,
      enabled, action, priority_rank, allow_weekends, session_mode,
      entry_mode, min_entry_price, max_entry_price, max_initial_notional_usdc,
      allow_high_price_one_shot, high_price_threshold,
      require_proven_family_above_price, preferred_entry_band,
      max_probe_count_per_market, entry_cooldown_seconds,
      max_new_markets_per_session, probe_size_usdc, add_size_usdc,
      scale_mode, default_max_buys_per_leg, heavy_max_buys_per_leg,
      allow_heavy_campaigns, require_positive_recycle_history_for_scale,
      exit_mode, primary_profit_model, allow_runner_extension,
      prefer_fast_recycle, resolution_holding_allowed,
      resolution_buffer_minutes, target_roi_band_low, target_roi_band_high,
      max_unmoved_hold_hours, max_tail_hold_hours,
      allow_two_sided, two_sided_mode, min_activity_for_two_sided,
      max_concurrent_orders_per_family, max_probe_in_flight_per_token,
      max_entry_signals_per_tick_per_family,
      max_open_value_usdc, max_active_markets, max_dust_positions,
      tail_quarantine_threshold_usdc, tail_quarantine_threshold_ratio,
      stale_tail_prune_enabled, threshold_cleanup_required,
      auto_settle_resolved_markets,
      active_windows_utc, reduced_windows_utc, weekday_bias, weekend_mode
    ) VALUES (
      'fam-001',
      1, 'trade', 10, 1, 'active-window',
      'probe-first', 0.05, 0.85, 25,
      1, 0.20,
      0.15, 'low',
      3, 300,
      5, 5, 4,
      'confirm-only', 4, 8,
      1, 0,
      'repricing-sell', 'sell-into-strength', 1,
      0, 1,
      45, 0.15, 0.40,
      72, 168,
      1, 'selective', 5,
      50, 3, 20,
      100, 10, 5,
      80, 1.5,
      1, 0,
      1,
      '[{"start":"08:00","end":"20:00"}]',
      '[{"start":"20:00","end":"23:00"}]',
      'preferred', 'reduced'
    );

    INSERT INTO family_deployments (family_id, profile, enabled)
    VALUES ('fam-001', 'paper', ${enabled});
  `);
}

let db: DbConnection["db"];

beforeEach(() => {
  const conn = openDatabaseWithSchema(":memory:", CONTROL_SQL);
  db = conn.db;
});

describe("DbFamilyRulesProvider", () => {
  it("getAllFamilies returns only deployed families for profile", () => {
    seedTestData(db);

    // Add a second family NOT deployed to this profile
    db.exec(`
      INSERT INTO family_catalog (
        family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile
      ) VALUES ('fam-002', 'eth-daily', 'crypto', 'price-range', 'daily', 'daily', 'scalp');

      INSERT INTO family_rules (family_id) VALUES ('fam-002');
    `);

    const provider = new DbFamilyRulesProvider(db, "paper");
    const families = provider.getAllFamilies();

    expect(families).toHaveLength(1);
    expect(families[0]!.familyId).toBe(createFamilyId("fam-001"));
    expect(families[0]!.familyKey).toBe("btc-weekly");
  });

  it("getRule returns full rule bundle with all sub-types populated", () => {
    seedTestData(db);
    const provider = new DbFamilyRulesProvider(db, "paper");
    const bundle = provider.getRule(createFamilyId("fam-001"));

    expect(bundle).not.toBeNull();
    const { identity, rules } = bundle!;

    // identity
    expect(identity.familyId).toBe(createFamilyId("fam-001"));
    expect(identity.familyKey).toBe("btc-weekly");
    expect(identity.primaryCategory).toBe("crypto");
    expect(identity.regime).toBe("threshold");
    expect(identity.horizon).toBe("weekly");
    expect(identity.cadence).toBe("weekly");
    expect(identity.strategyProfile).toBe("scalp");
    expect(identity.topicKey).toBe("bitcoin");
    expect(identity.slugPattern).toBe("btc-*");
    expect(identity.notes).toBe("test notes");

    // universe
    expect(rules.universe.enabled).toBe(true);
    expect(rules.universe.action).toBe("trade");
    expect(rules.universe.priorityRank).toBe(10);
    expect(rules.universe.allowWeekends).toBe(true);
    expect(rules.universe.sessionMode).toBe("active-window");

    // entry
    expect(rules.entry.entryMode).toBe("probe-first");
    expect(rules.entry.minEntryPrice).toBe(0.05);
    expect(rules.entry.maxEntryPrice).toBe(0.85);
    expect(rules.entry.maxInitialNotionalUsdc).toBe(25);
    expect(rules.entry.allowHighPriceOneShot).toBe(true);
    expect(rules.entry.highPriceThreshold).toBe(0.2);
    expect(rules.entry.requireProvenFamilyAbovePrice).toBe(0.15);
    expect(rules.entry.preferredEntryBand).toBe("low");
    expect(rules.entry.maxProbeCountPerMarket).toBe(3);
    expect(rules.entry.entryCooldownSeconds).toBe(300);
    expect(rules.entry.maxNewMarketsPerSession).toBe(5);
    expect(rules.entry.probeSizeUsdc).toBe(5);
    expect(rules.entry.addSizeUsdc).toBe(4);

    // scaleIn
    expect(rules.scaleIn.scaleMode).toBe("confirm-only");
    expect(rules.scaleIn.defaultMaxBuysPerLeg).toBe(4);
    expect(rules.scaleIn.heavyMaxBuysPerLeg).toBe(8);
    expect(rules.scaleIn.allowHeavyCampaigns).toBe(true);
    expect(rules.scaleIn.requirePositiveRecycleHistoryForScale).toBe(false);

    // exit
    expect(rules.exit.exitMode).toBe("repricing-sell");
    expect(rules.exit.primaryProfitModel).toBe("sell-into-strength");
    expect(rules.exit.allowRunnerExtension).toBe(true);
    expect(rules.exit.preferFastRecycle).toBe(false);
    expect(rules.exit.resolutionHoldingAllowed).toBe(true);
    expect(rules.exit.resolutionBufferMinutes).toBe(45);
    expect(rules.exit.targetRoiBandLow).toBe(0.15);
    expect(rules.exit.targetRoiBandHigh).toBe(0.4);
    expect(rules.exit.maxUnmovedHoldHours).toBe(72);
    expect(rules.exit.maxTailHoldHours).toBe(168);

    // twoSided
    expect(rules.twoSided.allowTwoSided).toBe(true);
    expect(rules.twoSided.twoSidedMode).toBe("selective");
    expect(rules.twoSided.minActivityForTwoSided).toBe(5);
    expect(rules.throughput).toEqual({
      maxConcurrentOrdersPerFamily: 50,
      maxProbeInFlightPerToken: 3,
      maxEntrySignalsPerTickPerFamily: 20,
      fastLaneEnabled: null,
    });

    // tailSuppression
    expect(rules.tailSuppression.maxOpenValueUsdc).toBe(100);
    expect(rules.tailSuppression.maxActiveMarkets).toBe(10);
    expect(rules.tailSuppression.maxDustPositions).toBe(5);
    expect(rules.tailSuppression.tailQuarantineThresholdUsdc).toBe(80);
    expect(rules.tailSuppression.tailQuarantineThresholdRatio).toBe(1.5);
    expect(rules.tailSuppression.staleTailPruneEnabled).toBe(true);
    expect(rules.tailSuppression.thresholdCleanupRequired).toBe(false);
    expect(rules.tailSuppression.autoSettleResolvedMarkets).toBe(true);

    // session
    expect(rules.session.activeWindowsUtc).toEqual([{ start: "08:00", end: "20:00" }]);
    expect(rules.session.reducedWindowsUtc).toEqual([{ start: "20:00", end: "23:00" }]);
    expect(rules.session.weekdayBias).toBe("preferred");
    expect(rules.session.weekendMode).toBe("reduced");

    // evidence is omitted
    expect(bundle!.evidence).toBeUndefined();

    // familyId on rules
    expect(rules.familyId).toBe(createFamilyId("fam-001"));
  });

  it("getRule returns null for non-deployed family", () => {
    seedTestData(db);
    const provider = new DbFamilyRulesProvider(db, "paper");
    expect(provider.getRule(createFamilyId("fam-999"))).toBeNull();
  });

  it("isEnabled returns false for disabled deployment", () => {
    seedTestData(db, { enabled: 0 });
    const provider = new DbFamilyRulesProvider(db, "paper");
    expect(provider.isEnabled(createFamilyId("fam-001"))).toBe(false);
  });

  it("reload clears cache and re-reads from DB", () => {
    seedTestData(db);
    const provider = new DbFamilyRulesProvider(db, "paper");

    expect(provider.getAllFamilies()).toHaveLength(1);

    // Disable the deployment after initial load
    db.exec(`UPDATE family_deployments SET enabled = 0 WHERE family_id = 'fam-001'`);

    // Still cached
    expect(provider.getAllFamilies()).toHaveLength(1);

    // After reload, picks up the change
    provider.reload();
    expect(provider.getAllFamilies()).toHaveLength(0);
  });

  it("getRulesForRegime filters by regime", () => {
    seedTestData(db);

    // Add a second family with different regime
    db.exec(`
      INSERT INTO family_catalog (
        family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile
      ) VALUES ('fam-003', 'sports-daily', 'sports', 'price-range', 'daily', 'daily', 'scalp');

      INSERT INTO family_rules (family_id, probe_size_usdc, add_size_usdc)
      VALUES ('fam-003', 5, 4);

      INSERT INTO family_deployments (family_id, profile, enabled)
      VALUES ('fam-003', 'paper', 1);
    `);

    const provider = new DbFamilyRulesProvider(db, "paper");

    const threshold = provider.getRulesForRegime("threshold" as any);
    expect(threshold).toHaveLength(1);
    expect(threshold[0]!.identity.familyId).toBe(createFamilyId("fam-001"));

    const priceRange = provider.getRulesForRegime("price-range" as any);
    expect(priceRange).toHaveLength(1);
    expect(priceRange[0]!.identity.familyId).toBe(createFamilyId("fam-003"));
  });
});
