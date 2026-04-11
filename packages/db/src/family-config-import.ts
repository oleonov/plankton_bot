import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FamilyConfig } from "@plankton/config";
import {
  createImportId,
  ProfileId,
  resolveFamilyDeploymentSeed,
  resolveFamilyLiveTradingPolicy,
} from "@plankton/domain";
import { ensureControlProfiles } from "./control-profiles.js";

export interface FamilyConfigImportResult {
  added: string[];
  updated: string[];
  skipped: string[];
  conflicts: string[];
  unchanged: string[];
}

export interface ApplyFamilyConfigImportOptions {
  readonly dryRun: boolean;
  readonly sourcePath?: string | null;
  readonly sourceChecksum: string;
  readonly sourceVersion?: number | null;
  readonly importedBy: string;
}

export interface LatestConfigImportMeta {
  readonly importId: string;
  readonly sourcePath: string | null;
  readonly sourceChecksum: string;
  readonly sourceVersion: number | null;
  readonly importedAt: string;
  readonly importedBy: string | null;
}

const RULES_COLUMNS = [
  "family_id",
  "enabled",
  "action",
  "priority_rank",
  "allow_weekends",
  "session_mode",
  "entry_mode",
  "min_entry_price",
  "max_entry_price",
  "max_initial_notional_usdc",
  "allow_high_price_one_shot",
  "high_price_threshold",
  "require_proven_family_above_price",
  "preferred_entry_band",
  "max_probe_count_per_market",
  "entry_cooldown_seconds",
  "max_new_markets_per_session",
  "probe_size_usdc",
  "add_size_usdc",
  "scale_mode",
  "default_max_buys_per_leg",
  "heavy_max_buys_per_leg",
  "allow_heavy_campaigns",
  "require_positive_recycle_history_for_scale",
  "exit_mode",
  "primary_profit_model",
  "allow_runner_extension",
  "prefer_fast_recycle",
  "resolution_holding_allowed",
  "resolution_buffer_minutes",
  "target_roi_band_low",
  "target_roi_band_high",
  "max_unmoved_hold_hours",
  "max_tail_hold_hours",
  "allow_two_sided",
  "two_sided_mode",
  "min_activity_for_two_sided",
  "max_concurrent_orders_per_family",
  "max_probe_in_flight_per_token",
  "max_entry_signals_per_tick_per_family",
  "fast_lane_enabled",
  "max_open_value_usdc",
  "max_active_markets",
  "max_dust_positions",
  "tail_quarantine_threshold_usdc",
  "tail_quarantine_threshold_ratio",
  "stale_tail_prune_enabled",
  "threshold_cleanup_required",
  "auto_settle_resolved_markets",
  "active_windows_utc",
  "reduced_windows_utc",
  "weekday_bias",
  "weekend_mode",
  "updated_at",
] as const;

const RULES_MUTABLE_COLUMNS = RULES_COLUMNS.slice(1);

const RULES_INSERT_SQL = `
  INSERT INTO family_rules (
    ${RULES_COLUMNS.join(",\n    ")}
  ) VALUES (
    ${RULES_COLUMNS.map(() => "?").join(", ")}
  )
`;

const RULES_UPDATE_SQL = `
  UPDATE family_rules SET
    ${RULES_MUTABLE_COLUMNS.map((column) => `${column} = ?`).join(",\n    ")}
  WHERE family_id = ?
`;

export function computeConfigChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function getLatestConfigImportMeta(db: Database.Database): LatestConfigImportMeta | null {
  const row = db
    .prepare(
      `SELECT import_id, source_path, source_checksum, source_version, imported_at, imported_by
         FROM config_imports
        ORDER BY imported_at DESC
        LIMIT 1`,
    )
    .get() as
    | {
        import_id: string;
        source_path: string | null;
        source_checksum: string;
        source_version: number | null;
        imported_at: string;
        imported_by: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    importId: row.import_id,
    sourcePath: row.source_path,
    sourceChecksum: row.source_checksum,
    sourceVersion: row.source_version,
    importedAt: row.imported_at,
    importedBy: row.imported_by,
  };
}

export function applyFamilyConfigImport(
  db: Database.Database,
  families: FamilyConfig[],
  opts: ApplyFamilyConfigImportOptions,
): FamilyConfigImportResult {
  const result: FamilyConfigImportResult = {
    added: [],
    updated: [],
    skipped: [],
    conflicts: [],
    unchanged: [],
  };

  const getCatalog = db.prepare("SELECT * FROM family_catalog WHERE family_id = ?");
  const getRules = db.prepare("SELECT * FROM family_rules WHERE family_id = ?");
  const getMeta = db.prepare(
    "SELECT last_operator_edit_at FROM family_config_meta WHERE family_id = ?",
  );

  for (const family of families) {
    const familyId = family.identity.familyId;
    const existingCatalog = getCatalog.get(familyId) as Record<string, unknown> | undefined;

    if (!existingCatalog) {
      result.added.push(familyId);
      continue;
    }

    if (existingCatalog["family_key"] !== family.identity.familyKey) {
      result.conflicts.push(familyId);
      continue;
    }

    const meta = getMeta.get(familyId) as { last_operator_edit_at: string | null } | undefined;
    if (meta?.last_operator_edit_at) {
      result.skipped.push(familyId);
      continue;
    }

    const existingRules = getRules.get(familyId) as Record<string, unknown> | undefined;
    if (existingRules) {
      const incomingFingerprint = familyFingerprint(family);
      const currentFingerprint = dbFamilyFingerprint(existingCatalog, existingRules);
      if (incomingFingerprint === currentFingerprint) {
        result.unchanged.push(familyId);
        continue;
      }
    }

    result.updated.push(familyId);
  }

  if (result.conflicts.length > 0 || opts.dryRun) {
    return result;
  }

  const now = new Date().toISOString();
  ensureControlProfiles(db, now);
  const insertCatalog = db.prepare(`
    INSERT INTO family_catalog (
      family_id, family_key, primary_category, regime, horizon, cadence,
      strategy_profile, fee_tier, live_wallet_requirement, requires_post_only_for_live,
      source_type, topic_key, slug_pattern, notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'yaml_import', ?, ?, ?, ?, ?)
  `);
  const insertRules = db.prepare(RULES_INSERT_SQL);
  const updateRules = db.prepare(RULES_UPDATE_SQL);
  const insertDeployment = db.prepare(`
    INSERT INTO family_deployments (
      family_id, profile, enabled, operator_mode, strategy_stage,
      deployment_stage, priority, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', 'probe-only', ?, 999, ?, ?)
  `);
  const insertEvidence = db.prepare(
    "INSERT INTO family_evidence (family_id, updated_at) VALUES (?, ?)",
  );
  const upsertMeta = db.prepare(`
    INSERT INTO family_config_meta (family_id, last_imported_at)
    VALUES (?, ?)
    ON CONFLICT(family_id) DO UPDATE SET last_imported_at = excluded.last_imported_at
  `);
  const updateCatalog = db.prepare(`
    UPDATE family_catalog SET
      primary_category = ?, regime = ?, horizon = ?, cadence = ?,
      strategy_profile = ?, fee_tier = ?, live_wallet_requirement = ?,
      requires_post_only_for_live = ?, topic_key = ?, slug_pattern = ?, notes = ?,
      updated_at = ?
    WHERE family_id = ?
  `);

  const familyMap = new Map(families.map((family) => [family.identity.familyId, family]));

  for (const familyId of result.added) {
    const family = familyMap.get(familyId)!;
    insertCatalogRow(insertCatalog, family, now);
    insertRules.run(...bindRulesParams(family, now));
    for (const profile of [ProfileId.Simulation, ProfileId.Paper, ProfileId.LiveLite]) {
      const seed = resolveFamilyDeploymentSeed({
        profile,
        sourceType: "yaml_import",
      });
      insertDeployment.run(familyId, profile, seed.enabled ? 1 : 0, seed.deploymentStage, now, now);
    }
    insertEvidence.run(familyId, now);
    upsertMeta.run(familyId, now);
  }

  for (const familyId of result.updated) {
    const family = familyMap.get(familyId)!;
    const identity = family.identity;
    const policy = resolveFamilyLiveTradingPolicy({
      primaryCategory: identity.primaryCategory,
      feeTier: identity.feeTier ?? null,
      liveWalletRequirement: identity.liveWalletRequirement ?? null,
      requiresPostOnlyForLive: identity.requiresPostOnlyForLive ?? null,
    });
    updateCatalog.run(
      identity.primaryCategory,
      identity.regime,
      identity.horizon,
      identity.cadence,
      identity.strategyProfile,
      policy.feeTier,
      policy.liveWalletRequirement,
      policy.requiresPostOnlyForLive ? 1 : 0,
      identity.topicKey ?? null,
      identity.slugPattern ?? null,
      identity.notes ?? null,
      now,
      familyId,
    );
    const rulesParams = bindRulesParams(family, now);
    updateRules.run(...rulesParams.slice(1), familyId);
    upsertMeta.run(familyId, now);
  }

  db.prepare(
    `
      INSERT INTO config_imports (
        import_id, source_path, source_checksum, source_version,
        families_added, families_updated, families_skipped, families_unchanged,
        result_json, imported_at, imported_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    createImportId(randomUUID()),
    opts.sourcePath ?? null,
    opts.sourceChecksum,
    opts.sourceVersion ?? null,
    result.added.length,
    result.updated.length,
    result.skipped.length,
    result.unchanged.length,
    JSON.stringify(result),
    now,
    opts.importedBy,
  );

  return result;
}

function insertCatalogRow(stmt: Database.Statement, family: FamilyConfig, now: string): void {
  const identity = family.identity;
  const policy = resolveFamilyLiveTradingPolicy({
    primaryCategory: identity.primaryCategory,
    feeTier: identity.feeTier ?? null,
    liveWalletRequirement: identity.liveWalletRequirement ?? null,
    requiresPostOnlyForLive: identity.requiresPostOnlyForLive ?? null,
  });
  stmt.run(
    identity.familyId,
    identity.familyKey,
    identity.primaryCategory,
    identity.regime,
    identity.horizon,
    identity.cadence,
    identity.strategyProfile,
    policy.feeTier,
    policy.liveWalletRequirement,
    policy.requiresPostOnlyForLive ? 1 : 0,
    identity.topicKey ?? null,
    identity.slugPattern ?? null,
    identity.notes ?? null,
    now,
    now,
  );
}

function bindRulesParams(family: FamilyConfig, now: string): unknown[] {
  const { rules } = family;
  const { universe, entry, scaleIn, exit, twoSided, throughput, tailSuppression, session } = rules;
  return [
    family.identity.familyId,
    universe.enabled ? 1 : 0,
    universe.action,
    universe.priorityRank,
    universe.allowWeekends ? 1 : 0,
    universe.sessionMode,
    entry.entryMode,
    entry.minEntryPrice,
    entry.maxEntryPrice,
    entry.maxInitialNotionalUsdc,
    entry.allowHighPriceOneShot ? 1 : 0,
    entry.highPriceThreshold,
    entry.requireProvenFamilyAbovePrice,
    entry.preferredEntryBand ?? null,
    entry.maxProbeCountPerMarket ?? null,
    entry.entryCooldownSeconds ?? null,
    entry.maxNewMarketsPerSession ?? null,
    entry.probeSizeUsdc,
    entry.addSizeUsdc,
    scaleIn.scaleMode,
    scaleIn.defaultMaxBuysPerLeg,
    scaleIn.heavyMaxBuysPerLeg,
    scaleIn.allowHeavyCampaigns ? 1 : 0,
    scaleIn.requirePositiveRecycleHistoryForScale ? 1 : 0,
    exit.exitMode,
    exit.primaryProfitModel,
    exit.allowRunnerExtension ? 1 : 0,
    exit.preferFastRecycle ? 1 : 0,
    exit.resolutionHoldingAllowed ? 1 : 0,
    exit.resolutionBufferMinutes,
    exit.targetRoiBandLow ?? null,
    exit.targetRoiBandHigh ?? null,
    exit.maxUnmovedHoldHours ?? null,
    exit.maxTailHoldHours ?? null,
    twoSided.allowTwoSided ? 1 : 0,
    twoSided.twoSidedMode,
    twoSided.minActivityForTwoSided ?? null,
    throughput?.maxConcurrentOrdersPerFamily ?? null,
    throughput?.maxProbeInFlightPerToken ?? null,
    throughput?.maxEntrySignalsPerTickPerFamily ?? null,
    throughput?.fastLaneEnabled == null ? null : throughput.fastLaneEnabled ? 1 : 0,
    tailSuppression.maxOpenValueUsdc,
    tailSuppression.maxActiveMarkets,
    tailSuppression.maxDustPositions,
    tailSuppression.tailQuarantineThresholdUsdc,
    tailSuppression.tailQuarantineThresholdRatio,
    tailSuppression.staleTailPruneEnabled ? 1 : 0,
    tailSuppression.thresholdCleanupRequired ? 1 : 0,
    tailSuppression.autoSettleResolvedMarkets ? 1 : 0,
    JSON.stringify(session.activeWindowsUtc),
    JSON.stringify(session.reducedWindowsUtc),
    session.weekdayBias,
    session.weekendMode,
    now,
  ];
}

function familyFingerprint(family: FamilyConfig): string {
  const identity = family.identity;
  const policy = resolveFamilyLiveTradingPolicy({
    primaryCategory: identity.primaryCategory,
    feeTier: identity.feeTier ?? null,
    liveWalletRequirement: identity.liveWalletRequirement ?? null,
    requiresPostOnlyForLive: identity.requiresPostOnlyForLive ?? null,
  });
  const catalogFields = [
    identity.primaryCategory,
    identity.regime,
    identity.horizon,
    identity.cadence,
    identity.strategyProfile,
    policy.feeTier,
    policy.liveWalletRequirement,
    policy.requiresPostOnlyForLive ? 1 : 0,
    identity.topicKey ?? null,
    identity.slugPattern ?? null,
    identity.notes ?? null,
  ];
  const rulesFields = bindRulesParams(family, "");
  const rulesCore = rulesFields.slice(1, -1);
  return JSON.stringify([...catalogFields, ...rulesCore]);
}

function dbFamilyFingerprint(
  catalog: Record<string, unknown>,
  rules: Record<string, unknown>,
): string {
  const catalogFields = [
    catalog["primary_category"],
    catalog["regime"],
    catalog["horizon"],
    catalog["cadence"],
    catalog["strategy_profile"],
    catalog["fee_tier"] ?? null,
    catalog["live_wallet_requirement"] ?? null,
    catalog["requires_post_only_for_live"] == null
      ? null
      : catalog["requires_post_only_for_live"]
        ? 1
        : 0,
    catalog["topic_key"] ?? null,
    catalog["slug_pattern"] ?? null,
    catalog["notes"] ?? null,
  ];
  const rulesCore = [
    rules["enabled"] ? 1 : 0,
    rules["action"],
    rules["priority_rank"],
    rules["allow_weekends"] ? 1 : 0,
    rules["session_mode"],
    rules["entry_mode"],
    rules["min_entry_price"],
    rules["max_entry_price"],
    rules["max_initial_notional_usdc"],
    rules["allow_high_price_one_shot"] ? 1 : 0,
    rules["high_price_threshold"],
    rules["require_proven_family_above_price"],
    rules["preferred_entry_band"] ?? null,
    rules["max_probe_count_per_market"] ?? null,
    rules["entry_cooldown_seconds"] ?? null,
    rules["max_new_markets_per_session"] ?? null,
    rules["probe_size_usdc"],
    rules["add_size_usdc"],
    rules["scale_mode"],
    rules["default_max_buys_per_leg"],
    rules["heavy_max_buys_per_leg"],
    rules["allow_heavy_campaigns"] ? 1 : 0,
    rules["require_positive_recycle_history_for_scale"] ? 1 : 0,
    rules["exit_mode"],
    rules["primary_profit_model"],
    rules["allow_runner_extension"] ? 1 : 0,
    rules["prefer_fast_recycle"] ? 1 : 0,
    rules["resolution_holding_allowed"] ? 1 : 0,
    rules["resolution_buffer_minutes"],
    rules["target_roi_band_low"] ?? null,
    rules["target_roi_band_high"] ?? null,
    rules["max_unmoved_hold_hours"] ?? null,
    rules["max_tail_hold_hours"] ?? null,
    rules["allow_two_sided"] ? 1 : 0,
    rules["two_sided_mode"],
    rules["min_activity_for_two_sided"] ?? null,
    rules["max_concurrent_orders_per_family"] ?? null,
    rules["max_probe_in_flight_per_token"] ?? null,
    rules["max_entry_signals_per_tick_per_family"] ?? null,
    rules["fast_lane_enabled"] == null ? null : rules["fast_lane_enabled"] ? 1 : 0,
    rules["max_open_value_usdc"],
    rules["max_active_markets"],
    rules["max_dust_positions"],
    rules["tail_quarantine_threshold_usdc"],
    rules["tail_quarantine_threshold_ratio"],
    rules["stale_tail_prune_enabled"] ? 1 : 0,
    rules["threshold_cleanup_required"] ? 1 : 0,
    rules["auto_settle_resolved_markets"] ? 1 : 0,
    rules["active_windows_utc"],
    rules["reduced_windows_utc"],
    rules["weekday_bias"],
    rules["weekend_mode"],
  ];
  return JSON.stringify([...catalogFields, ...rulesCore]);
}
