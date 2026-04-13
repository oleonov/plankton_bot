import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import {
  applyFamilyConfigImport,
  computeConfigChecksum,
  readFamilyRuleDefaults,
} from "@plankton/db";
import { parseFamilyRulesYaml } from "@plankton/config";
import { stringify as yamlStringify } from "yaml";
import { ok, ApiError } from "../errors.js";

interface ConfigOpts {
  controlDb: Database.Database;
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
    const yaml = body.yaml;

    let loaded;
    try {
      loaded = parseFamilyRulesYaml(yaml, "import");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ApiError(400, msg, "YAML_PARSE_ERROR");
    }

    const dryRun = body.dryRun === true;

    const result = dryRun
      ? applyFamilyConfigImport(db, loaded, {
          dryRun: true,
          sourcePath: null,
          sourceChecksum: computeConfigChecksum(yaml),
          importedBy: "api",
        })
      : db.transaction(() =>
          applyFamilyConfigImport(db, loaded, {
            dryRun: false,
            sourcePath: null,
            sourceChecksum: computeConfigChecksum(yaml),
            importedBy: "api",
          }),
        )();

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
      const defaults = readFamilyRuleDefaults(db);
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

      const yamlDoc = {
        version: 1,
        ...(defaults.entry == null
          ? {}
          : {
              defaults: {
                entry: {
                  min_entry_price: defaults.entry.minEntryPrice,
                  max_entry_price: defaults.entry.maxEntryPrice,
                  high_price_threshold: defaults.entry.highPriceThreshold,
                  require_proven_family_above_price: defaults.entry.requireProvenFamilyAbovePrice,
                  preferred_entry_band: defaults.entry.preferredEntryBand,
                },
              },
            }),
        families: yamlFamilies,
      };
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
      fast_lane_enabled: r["fast_lane_enabled"] == null ? null : !!r["fast_lane_enabled"],
      dust_lane_enabled: r["dust_lane_enabled"] == null ? null : !!r["dust_lane_enabled"],
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
