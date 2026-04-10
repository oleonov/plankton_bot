/**
 * Prepare control.db for Ultimate Plankton hard-mode rollout.
 *
 * Usage:
 *   npx tsx scripts/prepare-hard-mode-db.ts
 *   npx tsx scripts/prepare-hard-mode-db.ts --apply
 *   npx tsx scripts/prepare-hard-mode-db.ts --profile live-lite --control apps/runtime/data/control.db --ledger apps/runtime/data/ledger-live-lite.db
 *
 * Default is dry-run. This script intentionally does not force-close ledger
 * positions: local-only closure would desync accounting from exchange reality.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import type { FamilyConfig } from "../packages/config/src/schemas.ts";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const Database = require("better-sqlite3") as typeof import("better-sqlite3").default;

const CORE_FAMILY_KEYS = new Set([
  "bitcoin-price",
  "btc-updown-4h",
  "who-will-be-next-supreme-leader-of-iran",
  "us-next-strikes-iran-on",
]);

const REDUCED_FAMILY_KEYS = new Set([
  "bitcoin-above",
  "ethereum-price",
  "will-bitcoin-reach",
  "will-ethereum-reach",
]);

const ENABLED_FAMILY_KEYS = new Set([...CORE_FAMILY_KEYS, ...REDUCED_FAMILY_KEYS]);
const PROFILE_IDS = ["simulation", "paper", "live-lite"] as const;
const STALE_TAIL_DAYS = 7;

const CATALOG_COLUMNS = [
  "family_key",
  "primary_category",
  "regime",
  "horizon",
  "cadence",
  "strategy_profile",
  "fee_tier",
  "live_wallet_requirement",
  "requires_post_only_for_live",
  "source_type",
  "topic_key",
  "slug_pattern",
  "notes",
  "updated_at",
] as const;

const EVIDENCE_COLUMNS = [
  "evidence_status",
  "evidence_score",
  "promotion_state",
  "local_trade_count",
  "local_market_count",
  "local_realized_pnl_fifo",
  "open_tail_cost_usdc",
  "tail_adjusted_pnl",
  "remote_closed_realized_pnl",
  "open_position_count",
  "open_dust_count",
  "both_sided_eligible",
  "heavy_campaign_eligible",
  "active_window_edge_score",
  "last_validated_at",
  "recurrence_score",
  "recycle_score",
  "live_viability_score",
  "toxicity_penalty",
  "probe_substate",
  "repricing_exit_count",
  "updated_at",
] as const;

const RULE_COLUMNS = [
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

interface TailBlockerRow {
  position_id: string;
  token_id: string;
  family_id: string;
  status: string;
  opened_at: string;
  cost_basis_usdc: number;
  slug: string | null;
}

interface LoadedFamilyRules {
  families: FamilyConfig[];
}

type FamilyRulesLoader = (filePath: string) => LoadedFamilyRules;

async function loadRules(filePath: string): Promise<LoadedFamilyRules> {
  const distUrl = new URL("../packages/config/dist/index.js", import.meta.url);
  const srcUrl = new URL("../packages/config/src/loader.ts", import.meta.url);
  const loaderUrl = existsSync(distUrl) ? distUrl.href : srcUrl.href;
  const loader = (await import(loaderUrl)) as { loadFamilyRulesYaml: FamilyRulesLoader };
  return loader.loadFamilyRulesYaml(filePath);
}

function argValue(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? (process.argv[idx + 1] ?? fallback) : fallback;
}

function hasTable(db: InstanceType<typeof Database>, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name: string } | undefined;
  return row != null;
}

function insertSql(table: string, pkColumn: string, columns: readonly string[]): string {
  const names = [pkColumn, ...columns];
  return `
    INSERT INTO ${table} (${names.join(", ")})
    VALUES (${names.map((name) => `@${name}`).join(", ")})
    ON CONFLICT(${pkColumn}) DO UPDATE SET
      ${columns.map((name) => `${name} = excluded.${name}`).join(",\n      ")}
  `;
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function catalogParams(family: FamilyConfig, now: string): Record<string, unknown> {
  const { identity } = family;
  return {
    family_id: identity.familyId,
    family_key: identity.familyKey,
    primary_category: identity.primaryCategory,
    regime: identity.regime,
    horizon: identity.horizon,
    cadence: identity.cadence,
    strategy_profile: identity.strategyProfile,
    fee_tier: identity.feeTier ?? "unknown",
    live_wallet_requirement: identity.liveWalletRequirement ?? "relayer-required",
    requires_post_only_for_live:
      identity.requiresPostOnlyForLive == null ? 1 : bool(identity.requiresPostOnlyForLive),
    source_type: "yaml_import",
    topic_key: identity.topicKey,
    slug_pattern: identity.slugPattern,
    notes: identity.notes,
    updated_at: now,
  };
}

function evidenceParams(family: FamilyConfig, now: string): Record<string, unknown> {
  const { evidence } = family;
  const optionalEvidence = evidence as typeof evidence & {
    probeSubstate?: string | null;
    repricingExitCount?: number | null;
  };
  return {
    family_id: evidence.familyId,
    evidence_status: evidence.evidenceStatus,
    evidence_score: evidence.evidenceScore,
    promotion_state: evidence.promotionState,
    local_trade_count: evidence.localTradeCount,
    local_market_count: evidence.localMarketCount,
    local_realized_pnl_fifo: evidence.localRealizedPnlFifo,
    open_tail_cost_usdc: evidence.openTailCostUsdc,
    tail_adjusted_pnl: evidence.tailAdjustedPnl,
    remote_closed_realized_pnl: evidence.remoteClosedRealizedPnl,
    open_position_count: evidence.openPositionCount,
    open_dust_count: evidence.openDustCount,
    both_sided_eligible: bool(evidence.bothSidedEligible),
    heavy_campaign_eligible: bool(evidence.heavyCampaignEligible),
    active_window_edge_score: evidence.activeWindowEdgeScore,
    last_validated_at: evidence.lastValidatedAt,
    recurrence_score: evidence.recurrenceScore,
    recycle_score: evidence.recycleScore,
    live_viability_score: evidence.liveViabilityScore,
    toxicity_penalty: evidence.toxicityPenalty,
    probe_substate: optionalEvidence.probeSubstate ?? null,
    repricing_exit_count: optionalEvidence.repricingExitCount ?? 0,
    updated_at: now,
  };
}

function ruleParams(family: FamilyConfig, now: string): Record<string, unknown> {
  const { rules } = family;
  return {
    family_id: rules.familyId,
    enabled: bool(rules.universe.enabled),
    action: rules.universe.action,
    priority_rank: rules.universe.priorityRank,
    allow_weekends: bool(rules.universe.allowWeekends),
    session_mode: rules.universe.sessionMode,
    entry_mode: rules.entry.entryMode,
    min_entry_price: rules.entry.minEntryPrice,
    max_entry_price: rules.entry.maxEntryPrice,
    max_initial_notional_usdc: rules.entry.maxInitialNotionalUsdc,
    allow_high_price_one_shot: bool(rules.entry.allowHighPriceOneShot),
    high_price_threshold: rules.entry.highPriceThreshold,
    require_proven_family_above_price: rules.entry.requireProvenFamilyAbovePrice,
    preferred_entry_band: rules.entry.preferredEntryBand,
    max_probe_count_per_market: rules.entry.maxProbeCountPerMarket,
    entry_cooldown_seconds: rules.entry.entryCooldownSeconds,
    max_new_markets_per_session: rules.entry.maxNewMarketsPerSession,
    probe_size_usdc: rules.entry.probeSizeUsdc,
    add_size_usdc: rules.entry.addSizeUsdc,
    scale_mode: rules.scaleIn.scaleMode,
    default_max_buys_per_leg: rules.scaleIn.defaultMaxBuysPerLeg,
    heavy_max_buys_per_leg: rules.scaleIn.heavyMaxBuysPerLeg,
    allow_heavy_campaigns: bool(rules.scaleIn.allowHeavyCampaigns),
    require_positive_recycle_history_for_scale: bool(
      rules.scaleIn.requirePositiveRecycleHistoryForScale,
    ),
    exit_mode: rules.exit.exitMode,
    primary_profit_model: rules.exit.primaryProfitModel,
    allow_runner_extension: bool(rules.exit.allowRunnerExtension),
    prefer_fast_recycle: bool(rules.exit.preferFastRecycle),
    resolution_holding_allowed: bool(rules.exit.resolutionHoldingAllowed),
    resolution_buffer_minutes: rules.exit.resolutionBufferMinutes,
    target_roi_band_low: rules.exit.targetRoiBandLow,
    target_roi_band_high: rules.exit.targetRoiBandHigh,
    max_unmoved_hold_hours: rules.exit.maxUnmovedHoldHours,
    max_tail_hold_hours: rules.exit.maxTailHoldHours,
    allow_two_sided: bool(rules.twoSided.allowTwoSided),
    two_sided_mode: rules.twoSided.twoSidedMode,
    min_activity_for_two_sided: rules.twoSided.minActivityForTwoSided,
    max_concurrent_orders_per_family: rules.throughput?.maxConcurrentOrdersPerFamily ?? null,
    max_probe_in_flight_per_token: rules.throughput?.maxProbeInFlightPerToken ?? null,
    max_entry_signals_per_tick_per_family:
      rules.throughput?.maxEntrySignalsPerTickPerFamily ?? null,
    max_open_value_usdc: rules.tailSuppression.maxOpenValueUsdc,
    max_active_markets: rules.tailSuppression.maxActiveMarkets,
    max_dust_positions: rules.tailSuppression.maxDustPositions,
    tail_quarantine_threshold_usdc: rules.tailSuppression.tailQuarantineThresholdUsdc,
    tail_quarantine_threshold_ratio: rules.tailSuppression.tailQuarantineThresholdRatio,
    stale_tail_prune_enabled: bool(rules.tailSuppression.staleTailPruneEnabled),
    threshold_cleanup_required: bool(rules.tailSuppression.thresholdCleanupRequired),
    auto_settle_resolved_markets: bool(rules.tailSuppression.autoSettleResolvedMarkets),
    active_windows_utc: JSON.stringify(rules.session.activeWindowsUtc),
    reduced_windows_utc: JSON.stringify(rules.session.reducedWindowsUtc),
    weekday_bias: rules.session.weekdayBias,
    weekend_mode: rules.session.weekendMode,
    updated_at: now,
  };
}

function ensureProfiles(db: InstanceType<typeof Database>, now: string): void {
  const insertProfile = db.prepare(
    `INSERT OR IGNORE INTO profiles (profile_id, display_name, description, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  insertProfile.run("simulation", "Simulation", "In-memory simulated execution", now);
  insertProfile.run("paper", "Paper", "Live market data, simulated orders", now);
  insertProfile.run("live-lite", "Live-Lite", "Real orders with envelope caps", now);
}

function syncControlDb(
  db: InstanceType<typeof Database>,
  families: FamilyConfig[],
  profile: string,
  apply: boolean,
): { enabled: string[]; disabled: number } {
  const now = new Date().toISOString();
  const enabledFamilyIds = families
    .filter((family) => ENABLED_FAMILY_KEYS.has(family.identity.familyKey))
    .map((family) => family.identity.familyId);

  if (!apply) {
    return { enabled: enabledFamilyIds, disabled: 0 };
  }

  ensureProfiles(db, now);

  const upsertCatalog = db.prepare(insertSql("family_catalog", "family_id", CATALOG_COLUMNS));
  const upsertEvidence = db.prepare(insertSql("family_evidence", "family_id", EVIDENCE_COLUMNS));
  const upsertRules = db.prepare(insertSql("family_rules", "family_id", RULE_COLUMNS));
  const upsertDeployment = db.prepare(
    `INSERT INTO family_deployments (
       family_id, profile, enabled, operator_mode, strategy_stage, deployment_stage,
       priority, created_at, updated_at
     ) VALUES (
       @family_id, @profile, @enabled, 'active', @strategy_stage, @deployment_stage,
       @priority, @now, @now
     )
     ON CONFLICT(family_id, profile) DO UPDATE SET
       enabled = excluded.enabled,
       operator_mode = 'active',
       strategy_stage = excluded.strategy_stage,
       deployment_stage = excluded.deployment_stage,
       priority = excluded.priority,
       updated_at = excluded.updated_at`,
  );
  const disableNotAllowed = db.prepare(
    `UPDATE family_deployments
     SET enabled = 0, updated_at = datetime('now')
     WHERE profile = ?
       AND family_id NOT IN (${enabledFamilyIds.map(() => "?").join(", ")})`,
  );

  const tx = db.transaction(() => {
    for (const family of families) {
      upsertCatalog.run(catalogParams(family, now));
      upsertEvidence.run(evidenceParams(family, now));
      upsertRules.run(ruleParams(family, now));

      const enabled =
        ENABLED_FAMILY_KEYS.has(family.identity.familyKey) &&
        family.rules.universe.action === "trade";
      upsertDeployment.run({
        family_id: family.identity.familyId,
        profile,
        enabled: enabled ? 1 : 0,
        strategy_stage: enabled ? "scaled" : "probe-only",
        deployment_stage: enabled ? "live-probe" : "disabled",
        priority: family.rules.universe.priorityRank,
        now,
      });
    }

    let disabled = 0;
    if (enabledFamilyIds.length > 0) {
      const result = disableNotAllowed.run(profile, ...enabledFamilyIds);
      disabled = Number(result.changes);
    }
    return disabled;
  });

  return { enabled: enabledFamilyIds, disabled: tx() };
}

function auditTailBlockers(ledgerPath: string, enabledFamilyIds: string[]): TailBlockerRow[] {
  if (!existsSync(ledgerPath)) return [];
  const ledger = new Database(ledgerPath, { readonly: true });
  try {
    if (!hasTable(ledger, "positions")) return [];
    const cutoff = new Date(Date.now() - STALE_TAIL_DAYS * 24 * 60 * 60_000).toISOString();
    const enabledPlaceholders = enabledFamilyIds.map(() => "?").join(", ");
    const sql = `
      SELECT
        p.position_id,
        p.token_id,
        p.family_id,
        p.status,
        p.opened_at,
        p.cost_basis_usdc,
        m.slug
      FROM positions p
      LEFT JOIN markets m ON m.token_id = p.token_id
      WHERE p.status IN ('open', 'dust')
        AND (
          p.opened_at < ?
          OR p.family_id NOT IN (${enabledPlaceholders})
        )
      ORDER BY p.opened_at ASC
      LIMIT 200
    `;
    return ledger.prepare(sql).all(cutoff, ...enabledFamilyIds) as TailBlockerRow[];
  } finally {
    ledger.close();
  }
}

function printTailBlockers(blockers: TailBlockerRow[]): void {
  if (blockers.length === 0) {
    console.log("Tail audit: no stale/non-enabled open positions found.");
    return;
  }
  console.error(
    `Tail audit: ${blockers.length} stale/non-enabled open positions need operator cleanup.`,
  );
  for (const row of blockers.slice(0, 25)) {
    console.error(
      `  ${row.family_id} | ${row.status} | opened=${row.opened_at} | cost=$${row.cost_basis_usdc.toFixed(2)} | ${row.slug ?? row.token_id}`,
    );
  }
  if (blockers.length > 25) {
    console.error(`  ... ${blockers.length - 25} more`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const allowTailBlockers = args.includes("--allow-tail-blockers");
  const rulesPath = argValue("--rules", "config/family_rules.yaml");
  const controlPath = argValue("--control", "apps/runtime/data/control.db");
  const ledgerPath = argValue("--ledger", "apps/runtime/data/ledger-live-lite.db");
  const profile = argValue("--profile", "live-lite");

  if (!PROFILE_IDS.includes(profile as (typeof PROFILE_IDS)[number])) {
    throw new Error(`unsupported profile '${profile}'`);
  }

  const loaded = await loadRules(rulesPath);
  const controlDb = new Database(
    controlPath,
    apply ? undefined : { readonly: true, fileMustExist: true },
  );
  try {
    controlDb.pragma("foreign_keys = ON");
    const result = syncControlDb(controlDb, loaded.families, profile, apply);
    const blockers = auditTailBlockers(ledgerPath, result.enabled);

    console.log(`${apply ? "Applied" : "Dry-run"} hard-mode DB sync for profile '${profile}'.`);
    console.log(`Enabled families: ${result.enabled.join(", ")}`);
    console.log(`Disabled non-allowlisted deployment rows: ${result.disabled}`);
    printTailBlockers(blockers);

    if (blockers.length > 0 && !allowTailBlockers) {
      console.error(
        "Refusing hard-mode signoff until tail blockers are cleaned or --allow-tail-blockers is provided.",
      );
      process.exitCode = 2;
    }
  } finally {
    controlDb.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
