import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { LoadedFamilyRules } from "@plankton/config";
import type { FamilyConfig } from "@plankton/config";
import {
  createImportId,
  resolveFamilyDeploymentSeed,
  resolveFamilyLiveTradingPolicy,
} from "@plankton/domain";
import { ProfileId } from "@plankton/domain";

export function needsBootstrap(db: Database.Database): boolean {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM family_catalog").get() as { cnt: number };
  return row.cnt === 0;
}

const PROFILES: Array<{
  profileId: string;
  displayName: string;
  description: string;
}> = [
  {
    profileId: ProfileId.Simulation,
    displayName: "Simulation",
    description: "In-memory simulated execution",
  },
  {
    profileId: ProfileId.Paper,
    displayName: "Paper",
    description: "Live market data, simulated orders",
  },
  {
    profileId: ProfileId.LiveLite,
    displayName: "Live-Lite",
    description: "Real orders with envelope caps",
  },
];

export function bootstrapImport(db: Database.Database, loaded: LoadedFamilyRules): void {
  const now = new Date().toISOString();
  const importId = createImportId(randomUUID());

  const tx = db.transaction(() => {
    // 1. Profiles
    const insertProfile = db.prepare(
      "INSERT INTO profiles (profile_id, display_name, description, created_at) VALUES (?, ?, ?, ?)",
    );
    for (const p of PROFILES) {
      insertProfile.run(p.profileId, p.displayName, p.description, now);
    }

    // 2. Profile settings
    const insertSettings = db.prepare(
      `INSERT INTO profile_settings
         (profile_id, initial_balance_usdc, wallet_mode, min_order_usdc, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertSettings.run(ProfileId.Simulation, loaded.global.initialBalanceUsdc, null, null, now);
    insertSettings.run(ProfileId.Paper, loaded.global.initialBalanceUsdc, null, null, now);
    insertSettings.run(ProfileId.LiveLite, loaded.global.initialBalanceUsdc, "relayer", 1, now);

    // 3. Families
    const insertCatalog = db.prepare(`
      INSERT INTO family_catalog (
        family_id, family_key, primary_category, regime, horizon, cadence,
        strategy_profile, fee_tier, live_wallet_requirement, requires_post_only_for_live,
        source_type, topic_key, slug_pattern, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'yaml_import', ?, ?, ?, ?, ?)
    `);

    const insertRules = db.prepare(`
      INSERT INTO family_rules (
        family_id,
        enabled, action, priority_rank, allow_weekends, session_mode,
        entry_mode, min_entry_price, max_entry_price, max_initial_notional_usdc,
        allow_high_price_one_shot, high_price_threshold, require_proven_family_above_price,
        preferred_entry_band, max_probe_count_per_market, entry_cooldown_seconds,
        max_new_markets_per_session, probe_size_usdc, add_size_usdc,
        scale_mode, default_max_buys_per_leg, heavy_max_buys_per_leg,
        allow_heavy_campaigns, require_positive_recycle_history_for_scale,
        exit_mode, primary_profit_model, allow_runner_extension, prefer_fast_recycle,
        resolution_holding_allowed, resolution_buffer_minutes,
        target_roi_band_low, target_roi_band_high, max_unmoved_hold_hours, max_tail_hold_hours,
        allow_two_sided, two_sided_mode, min_activity_for_two_sided,
        max_open_value_usdc, max_active_markets, max_dust_positions,
        tail_quarantine_threshold_usdc, tail_quarantine_threshold_ratio,
        stale_tail_prune_enabled, threshold_cleanup_required, auto_settle_resolved_markets,
        active_windows_utc, reduced_windows_utc, weekday_bias, weekend_mode,
        updated_at
      ) VALUES (
        ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?
      )
    `);

    const insertDeployment = db.prepare(`
      INSERT INTO family_deployments (
        family_id, profile, enabled, operator_mode, strategy_stage,
        deployment_stage, priority, created_at, updated_at
      ) VALUES (?, ?, ?, 'active', 'probe-only', ?, 999, ?, ?)
    `);

    // Legacy compat: family_evidence baseline (repos and API routes still read this table)
    const insertEvidence = db.prepare(
      "INSERT INTO family_evidence (family_id, updated_at) VALUES (?, ?)",
    );

    for (const family of loaded.families) {
      insertFamily(family, insertCatalog, insertRules, insertDeployment, now);
      insertEvidence.run(family.identity.familyId, now);
    }

    // 4. Runtime control state
    db.prepare(
      `
      INSERT INTO runtime_control_state (
        id, desired_profile, paused, runtime_status, schema_version, updated_at
      ) VALUES (1, ?, 1, 'stopped', 1, ?)
    `,
    ).run(ProfileId.Simulation, now);

    // 5. Config imports record
    db.prepare(
      `
      INSERT INTO config_imports (
        import_id, source_checksum, families_added, families_updated,
        families_skipped, families_unchanged, imported_at, imported_by
      ) VALUES (?, 'bootstrap', ?, 0, 0, 0, ?, 'bootstrap')
    `,
    ).run(importId, loaded.families.length, now);
  });

  tx();
}

export function syncProfileInitialBalances(
  db: Database.Database,
  initialBalanceUsdc: number,
): void {
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO profile_settings
         (profile_id, initial_balance_usdc, wallet_mode, min_order_usdc, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         initial_balance_usdc = COALESCE(profile_settings.initial_balance_usdc, excluded.initial_balance_usdc),
         wallet_mode = COALESCE(profile_settings.wallet_mode, excluded.wallet_mode),
         min_order_usdc = COALESCE(profile_settings.min_order_usdc, excluded.min_order_usdc),
         updated_at = excluded.updated_at`,
    );

    upsert.run(ProfileId.Simulation, initialBalanceUsdc, null, null, now);
    upsert.run(ProfileId.Paper, initialBalanceUsdc, null, null, now);
    upsert.run(ProfileId.LiveLite, initialBalanceUsdc, "relayer", 1, now);
  });

  tx();
}

function insertFamily(
  family: FamilyConfig,
  insertCatalog: Database.Statement,
  insertRules: Database.Statement,
  insertDeployment: Database.Statement,
  now: string,
): void {
  const { identity: id, rules } = family;
  const livePolicy = resolveFamilyLiveTradingPolicy({
    primaryCategory: id.primaryCategory,
    feeTier: id.feeTier ?? null,
    liveWalletRequirement: id.liveWalletRequirement ?? null,
    requiresPostOnlyForLive: id.requiresPostOnlyForLive ?? null,
  });
  const {
    universe: u,
    entry: e,
    scaleIn: s,
    exit: x,
    twoSided: t,
    tailSuppression: ts,
    session: ss,
  } = rules;

  insertCatalog.run(
    id.familyId,
    id.familyKey,
    id.primaryCategory,
    id.regime,
    id.horizon,
    id.cadence,
    id.strategyProfile,
    livePolicy.feeTier,
    livePolicy.liveWalletRequirement,
    livePolicy.requiresPostOnlyForLive ? 1 : 0,
    id.topicKey ?? null,
    id.slugPattern ?? null,
    id.notes ?? null,
    now,
    now,
  );

  insertRules.run(
    id.familyId,
    u.enabled ? 1 : 0,
    u.action,
    u.priorityRank,
    u.allowWeekends ? 1 : 0,
    u.sessionMode,
    e.entryMode,
    e.minEntryPrice,
    e.maxEntryPrice,
    e.maxInitialNotionalUsdc,
    e.allowHighPriceOneShot ? 1 : 0,
    e.highPriceThreshold,
    e.requireProvenFamilyAbovePrice,
    e.preferredEntryBand ?? null,
    e.maxProbeCountPerMarket ?? null,
    e.entryCooldownSeconds ?? null,
    e.maxNewMarketsPerSession ?? null,
    e.probeSizeUsdc,
    e.addSizeUsdc,
    s.scaleMode,
    s.defaultMaxBuysPerLeg,
    s.heavyMaxBuysPerLeg,
    s.allowHeavyCampaigns ? 1 : 0,
    s.requirePositiveRecycleHistoryForScale ? 1 : 0,
    x.exitMode,
    x.primaryProfitModel,
    x.allowRunnerExtension ? 1 : 0,
    x.preferFastRecycle ? 1 : 0,
    x.resolutionHoldingAllowed ? 1 : 0,
    x.resolutionBufferMinutes,
    x.targetRoiBandLow ?? null,
    x.targetRoiBandHigh ?? null,
    x.maxUnmovedHoldHours ?? null,
    x.maxTailHoldHours ?? null,
    t.allowTwoSided ? 1 : 0,
    t.twoSidedMode,
    t.minActivityForTwoSided ?? null,
    ts.maxOpenValueUsdc,
    ts.maxActiveMarkets,
    ts.maxDustPositions,
    ts.tailQuarantineThresholdUsdc,
    ts.tailQuarantineThresholdRatio,
    ts.staleTailPruneEnabled ? 1 : 0,
    ts.thresholdCleanupRequired ? 1 : 0,
    ts.autoSettleResolvedMarkets ? 1 : 0,
    JSON.stringify(ss.activeWindowsUtc),
    JSON.stringify(ss.reducedWindowsUtc),
    ss.weekdayBias,
    ss.weekendMode,
    now,
  );

  for (const profile of [ProfileId.Simulation, ProfileId.Paper, ProfileId.LiveLite]) {
    const seed = resolveFamilyDeploymentSeed({
      profile,
      sourceType: "yaml_import",
    });
    insertDeployment.run(
      id.familyId,
      profile,
      seed.enabled ? 1 : 0,
      seed.deploymentStage,
      now,
      now,
    );
  }
}
