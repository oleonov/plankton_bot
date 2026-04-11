import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import {
  createImportId,
  ProfileId,
  resolveFamilyDeploymentSeed,
  resolveFamilyLiveTradingPolicy,
} from "@plankton/domain";
import { parseFamilyRulesYaml, type FamilyConfig } from "@plankton/config";
import { stringify as yamlStringify } from "yaml";
import { ok, ApiError } from "../errors.js";

interface ConfigOpts {
  controlDb: Database.Database;
}

export interface ImportResult {
  added: string[];
  updated: string[];
  skipped: string[];
  conflicts: string[];
  unchanged: string[];
}

// ── Shared INSERT helpers (reuses bootstrap-import column order) ─────────

function insertCatalogRow(stmt: Database.Statement, family: FamilyConfig, now: string): void {
  const id = family.identity;
  const policy = resolveFamilyLiveTradingPolicy({
    primaryCategory: id.primaryCategory,
    feeTier: id.feeTier ?? null,
    liveWalletRequirement: id.liveWalletRequirement ?? null,
    requiresPostOnlyForLive: id.requiresPostOnlyForLive ?? null,
  });
  stmt.run(
    id.familyId,
    id.familyKey,
    id.primaryCategory,
    id.regime,
    id.horizon,
    id.cadence,
    id.strategyProfile,
    policy.feeTier,
    policy.liveWalletRequirement,
    policy.requiresPostOnlyForLive ? 1 : 0,
    id.topicKey ?? null,
    id.slugPattern ?? null,
    id.notes ?? null,
    now,
    now,
  );
}

function bindRulesParams(family: FamilyConfig, now: string): unknown[] {
  const { rules: r } = family;
  const {
    universe: u,
    entry: e,
    scaleIn: s,
    exit: x,
    twoSided: t,
    throughput: th,
    tailSuppression: ts,
    session: ss,
  } = r;
  return [
    family.identity.familyId,
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
    th?.maxConcurrentOrdersPerFamily ?? null,
    th?.maxProbeInFlightPerToken ?? null,
    th?.maxEntrySignalsPerTickPerFamily ?? null,
    th?.fastLaneEnabled == null ? null : th.fastLaneEnabled ? 1 : 0,
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
  ];
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

// ── Import diff logic ────────────────────────────────────────────────────

/** Build a deterministic fingerprint of catalog + rules for change detection. */
function familyFingerprint(family: FamilyConfig): string {
  const id = family.identity;
  const policy = resolveFamilyLiveTradingPolicy({
    primaryCategory: id.primaryCategory,
    feeTier: id.feeTier ?? null,
    liveWalletRequirement: id.liveWalletRequirement ?? null,
    requiresPostOnlyForLive: id.requiresPostOnlyForLive ?? null,
  });
  const catalogFields = [
    id.primaryCategory,
    id.regime,
    id.horizon,
    id.cadence,
    id.strategyProfile,
    policy.feeTier,
    policy.liveWalletRequirement,
    policy.requiresPostOnlyForLive ? 1 : 0,
    id.topicKey ?? null,
    id.slugPattern ?? null,
    id.notes ?? null,
  ];
  // Reuse bindRulesParams with a dummy timestamp (stripped before comparison)
  const rulesFields = bindRulesParams(family, "");
  // rulesFields[0] is family_id, last element is updated_at — exclude both
  const rulesCore = rulesFields.slice(1, -1);
  return JSON.stringify([...catalogFields, ...rulesCore]);
}

/** Build the same fingerprint from existing DB rows. */
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
  const r = rules;
  const rulesCore = [
    r["enabled"] ? 1 : 0,
    r["action"],
    r["priority_rank"],
    r["allow_weekends"] ? 1 : 0,
    r["session_mode"],
    r["entry_mode"],
    r["min_entry_price"],
    r["max_entry_price"],
    r["max_initial_notional_usdc"],
    r["allow_high_price_one_shot"] ? 1 : 0,
    r["high_price_threshold"],
    r["require_proven_family_above_price"],
    r["preferred_entry_band"] ?? null,
    r["max_probe_count_per_market"] ?? null,
    r["entry_cooldown_seconds"] ?? null,
    r["max_new_markets_per_session"] ?? null,
    r["probe_size_usdc"],
    r["add_size_usdc"],
    r["scale_mode"],
    r["default_max_buys_per_leg"],
    r["heavy_max_buys_per_leg"],
    r["allow_heavy_campaigns"] ? 1 : 0,
    r["require_positive_recycle_history_for_scale"] ? 1 : 0,
    r["exit_mode"],
    r["primary_profit_model"],
    r["allow_runner_extension"] ? 1 : 0,
    r["prefer_fast_recycle"] ? 1 : 0,
    r["resolution_holding_allowed"] ? 1 : 0,
    r["resolution_buffer_minutes"],
    r["target_roi_band_low"] ?? null,
    r["target_roi_band_high"] ?? null,
    r["max_unmoved_hold_hours"] ?? null,
    r["max_tail_hold_hours"] ?? null,
    r["allow_two_sided"] ? 1 : 0,
    r["two_sided_mode"],
    r["min_activity_for_two_sided"] ?? null,
    r["max_concurrent_orders_per_family"] ?? null,
    r["max_probe_in_flight_per_token"] ?? null,
    r["max_entry_signals_per_tick_per_family"] ?? null,
    r["fast_lane_enabled"] == null ? null : r["fast_lane_enabled"] ? 1 : 0,
    r["max_open_value_usdc"],
    r["max_active_markets"],
    r["max_dust_positions"],
    r["tail_quarantine_threshold_usdc"],
    r["tail_quarantine_threshold_ratio"],
    r["stale_tail_prune_enabled"] ? 1 : 0,
    r["threshold_cleanup_required"] ? 1 : 0,
    r["auto_settle_resolved_markets"] ? 1 : 0,
    r["active_windows_utc"],
    r["reduced_windows_utc"],
    r["weekday_bias"],
    r["weekend_mode"],
  ];
  return JSON.stringify([...catalogFields, ...rulesCore]);
}

function diffAndApply(
  db: Database.Database,
  families: FamilyConfig[],
  dryRun: boolean,
): ImportResult {
  const result: ImportResult = {
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
    const fid = family.identity.familyId;
    const existingCatalog = getCatalog.get(fid) as Record<string, unknown> | undefined;

    if (!existingCatalog) {
      result.added.push(fid);
      continue;
    }

    // family_key mismatch is a hard conflict that fails the entire import
    if (existingCatalog["family_key"] !== family.identity.familyKey) {
      result.conflicts.push(fid);
      continue;
    }

    const meta = getMeta.get(fid) as { last_operator_edit_at: string | null } | undefined;
    if (meta?.last_operator_edit_at) {
      result.skipped.push(fid);
      continue;
    }

    // Compare content to detect actual changes
    const existingRules = getRules.get(fid) as Record<string, unknown> | undefined;
    if (existingRules) {
      const incomingFp = familyFingerprint(family);
      const currentFp = dbFamilyFingerprint(existingCatalog, existingRules);
      if (incomingFp === currentFp) {
        result.unchanged.push(fid);
        continue;
      }
    }

    result.updated.push(fid);
  }

  // If there are hard conflicts (family_key mismatch), fail the entire import
  if (result.conflicts.length > 0) {
    return result;
  }

  if (dryRun) return result;

  // Apply changes
  const now = new Date().toISOString();

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

  const familyMap = new Map(families.map((f) => [f.identity.familyId, f]));

  for (const fid of result.added) {
    const family = familyMap.get(fid)!;
    insertCatalogRow(insertCatalog, family, now);
    insertRules.run(...bindRulesParams(family, now));
    for (const profile of [ProfileId.Simulation, ProfileId.Paper, ProfileId.LiveLite]) {
      const seed = resolveFamilyDeploymentSeed({
        profile,
        sourceType: "yaml_import",
      });
      insertDeployment.run(fid, profile, seed.enabled ? 1 : 0, seed.deploymentStage, now, now);
    }
    insertEvidence.run(fid, now);
    upsertMeta.run(fid, now);
  }

  for (const fid of result.updated) {
    const family = familyMap.get(fid)!;
    const id = family.identity;
    const policy = resolveFamilyLiveTradingPolicy({
      primaryCategory: id.primaryCategory,
      feeTier: id.feeTier ?? null,
      liveWalletRequirement: id.liveWalletRequirement ?? null,
      requiresPostOnlyForLive: id.requiresPostOnlyForLive ?? null,
    });
    updateCatalog.run(
      id.primaryCategory,
      id.regime,
      id.horizon,
      id.cadence,
      id.strategyProfile,
      policy.feeTier,
      policy.liveWalletRequirement,
      policy.requiresPostOnlyForLive ? 1 : 0,
      id.topicKey ?? null,
      id.slugPattern ?? null,
      id.notes ?? null,
      now,
      fid,
    );
    // updateRules: params without family_id prefix, then family_id at the end for WHERE
    const rulesParams = bindRulesParams(family, now);
    // rulesParams[0] is family_id; UPDATE needs values first, then WHERE family_id
    updateRules.run(...rulesParams.slice(1), fid);
    upsertMeta.run(fid, now);
  }

  // Record the import
  const importId = createImportId(randomUUID());
  db.prepare(
    `
    INSERT INTO config_imports (
      import_id, source_checksum, families_added, families_updated,
      families_skipped, families_unchanged, result_json, imported_at, imported_by
    ) VALUES (?, 'api_import', ?, ?, ?, ?, ?, ?, 'api')
  `,
  ).run(
    importId,
    result.added.length,
    result.updated.length,
    result.skipped.length,
    result.unchanged.length,
    JSON.stringify(result),
    now,
  );

  return result;
}

// ── Routes ──────────────────────────────────────────────────────────────

export const configRoutes: FastifyPluginAsync<ConfigOpts> = async (app, opts) => {
  const db = opts.controlDb;

  // ── POST /config/import ─────────────────────────────────────────────
  app.post<{ Body: { yaml: string; dryRun?: boolean } }>("/config/import", async (request) => {
    const body = (request.body ?? {}) as { yaml?: string; dryRun?: boolean };
    if (!body.yaml || typeof body.yaml !== "string") {
      throw new ApiError(400, "yaml field is required", "MISSING_FIELD");
    }

    let loaded;
    try {
      loaded = parseFamilyRulesYaml(body.yaml, "import");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError(400, msg, "YAML_PARSE_ERROR");
    }

    const dryRun = body.dryRun === true;

    const result = dryRun
      ? diffAndApply(db, loaded.families, true)
      : db.transaction(() => diffAndApply(db, loaded.families, false))();

    if (result.conflicts.length > 0) {
      throw new ApiError(
        409,
        `family_key mismatch for: ${result.conflicts.join(", ")}`,
        "FAMILY_KEY_CONFLICT",
      );
    }

    return ok({ ...result, dryRun, familyCount: loaded.families.length });
  });

  // ── GET /config/export ──────────────────────────────────────────────
  app.get<{ Querystring: { format?: string } }>("/config/export", async (request, reply) => {
    const format = (request.query as { format?: string }).format ?? "json";

    if (format === "yaml") {
      const families = db
        .prepare("SELECT * FROM family_catalog ORDER BY family_id")
        .all() as Record<string, unknown>[];

      const rules = db.prepare("SELECT * FROM family_rules ORDER BY family_id").all() as Record<
        string,
        unknown
      >[];

      const rulesMap = new Map(rules.map((r) => [r["family_id"] as string, r]));

      const yamlFamilies = families.map((f) => ({
        family_id: f["family_id"],
        identity: {
          family_key: f["family_key"],
          primary_category: f["primary_category"],
          regime: f["regime"],
          horizon: f["horizon"],
          cadence: f["cadence"],
          strategy_profile: f["strategy_profile"],
          fee_tier: f["fee_tier"] ?? null,
          live_wallet_requirement: f["live_wallet_requirement"] ?? null,
          requires_post_only_for_live:
            f["requires_post_only_for_live"] == null
              ? null
              : Boolean(f["requires_post_only_for_live"]),
          topic_key: f["topic_key"] ?? null,
          slug_pattern: f["slug_pattern"] ?? null,
          notes: f["notes"] ?? null,
        },
        rules: buildRulesExport(rulesMap.get(f["family_id"] as string)),
      }));

      const yamlDoc = { version: 1, families: yamlFamilies };
      const yamlStr = yamlStringify(yamlDoc, { lineWidth: 120 });

      return reply.type("text/yaml; charset=utf-8").send(yamlStr);
    }

    // JSON: full control snapshot
    const catalog = db.prepare("SELECT * FROM family_catalog ORDER BY family_id").all();
    const rules = db.prepare("SELECT * FROM family_rules ORDER BY family_id").all();
    const deployments = db
      .prepare("SELECT * FROM family_deployments ORDER BY family_id, profile")
      .all();
    const profiles = db.prepare("SELECT * FROM profiles ORDER BY profile_id").all();

    return ok({ catalog, rules, deployments, profiles });
  });
};

function buildRulesExport(r: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!r) return null;

  return {
    universe: {
      enabled: !!r["enabled"],
      action: r["action"],
      priority_rank: r["priority_rank"],
      allow_weekends: !!r["allow_weekends"],
      session_mode: r["session_mode"],
    },
    entry: {
      entry_mode: r["entry_mode"],
      min_entry_price: r["min_entry_price"],
      max_entry_price: r["max_entry_price"],
      max_initial_notional_usdc: r["max_initial_notional_usdc"],
      allow_high_price_one_shot: !!r["allow_high_price_one_shot"],
      high_price_threshold: r["high_price_threshold"],
      require_proven_family_above_price: r["require_proven_family_above_price"],
      preferred_entry_band: r["preferred_entry_band"],
      max_probe_count_per_market: r["max_probe_count_per_market"],
      entry_cooldown_seconds: r["entry_cooldown_seconds"],
      max_new_markets_per_session: r["max_new_markets_per_session"],
      probe_size_usdc: r["probe_size_usdc"],
      add_size_usdc: r["add_size_usdc"],
    },
    scale_in: {
      scale_mode: r["scale_mode"],
      default_max_buys_per_leg: r["default_max_buys_per_leg"],
      heavy_max_buys_per_leg: r["heavy_max_buys_per_leg"],
      allow_heavy_campaigns: !!r["allow_heavy_campaigns"],
      require_positive_recycle_history_for_scale: !!r["require_positive_recycle_history_for_scale"],
    },
    exit: {
      exit_mode: r["exit_mode"],
      primary_profit_model: r["primary_profit_model"],
      allow_runner_extension: !!r["allow_runner_extension"],
      prefer_fast_recycle: !!r["prefer_fast_recycle"],
      resolution_holding_allowed: !!r["resolution_holding_allowed"],
      resolution_buffer_minutes: r["resolution_buffer_minutes"],
      target_roi_band_low: r["target_roi_band_low"],
      target_roi_band_high: r["target_roi_band_high"],
      max_unmoved_hold_hours: r["max_unmoved_hold_hours"],
      max_tail_hold_hours: r["max_tail_hold_hours"],
    },
    two_sided: {
      allow_two_sided: !!r["allow_two_sided"],
      two_sided_mode: r["two_sided_mode"],
      min_activity_for_two_sided: r["min_activity_for_two_sided"],
    },
    throughput: {
      max_concurrent_orders_per_family: r["max_concurrent_orders_per_family"],
      max_probe_in_flight_per_token: r["max_probe_in_flight_per_token"],
      max_entry_signals_per_tick_per_family: r["max_entry_signals_per_tick_per_family"],
      fast_lane_enabled:
        r["fast_lane_enabled"] == null ? null : !!r["fast_lane_enabled"],
    },
    tail_suppression: {
      max_open_value_usdc: r["max_open_value_usdc"],
      max_active_markets: r["max_active_markets"],
      max_dust_positions: r["max_dust_positions"],
      tail_quarantine_threshold_usdc: r["tail_quarantine_threshold_usdc"],
      tail_quarantine_threshold_ratio: r["tail_quarantine_threshold_ratio"],
      stale_tail_prune_enabled: !!r["stale_tail_prune_enabled"],
      threshold_cleanup_required: !!r["threshold_cleanup_required"],
      auto_settle_resolved_markets: !!r["auto_settle_resolved_markets"],
    },
    session: {
      active_windows_utc: safeJsonParse(r["active_windows_utc"]),
      reduced_windows_utc: safeJsonParse(r["reduced_windows_utc"]),
      weekday_bias: r["weekday_bias"],
      weekend_mode: r["weekend_mode"],
    },
  };
}

function safeJsonParse(val: unknown): unknown {
  if (typeof val !== "string") return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}
