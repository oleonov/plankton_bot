import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok, ApiError } from "../errors.js";
import { buildMarketMetaMap, getMetaOrEmpty, buildResolutionMap } from "../enrich-market.js";
import { toDto as orderToDto } from "./orders.js";
import { toDto as positionToDto } from "./positions.js";
import { toDto as fillToDto } from "./fills.js";
import type { LedgerPool } from "../ledger-pool.js";

interface ProfilesOpts {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
  ledgerPool: LedgerPool;
}

export const profileRoutes: FastifyPluginAsync<ProfilesOpts> = async (app, opts) => {
  const { controlDb } = opts;

  // ── GET /profiles ────────────────────────────────────────────────────
  app.get("/profiles", async () => {
    const profiles = controlDb
      .prepare(
        `SELECT p.profile_id, p.display_name, p.description,
                ps.paused, ps.last_run_at, ps.open_orders, ps.open_positions,
                ps.total_exposure_usdc, ps.balance_usdc, ps.last_preflight_status, ps.updated_at
         FROM profiles p
         LEFT JOIN profile_summaries ps ON p.profile_id = ps.profile_id
         ORDER BY p.profile_id`,
      )
      .all();

    const rcs = controlDb
      .prepare(
        "SELECT current_profile, desired_profile, runtime_status FROM runtime_control_state WHERE id = 1",
      )
      .get();

    return ok({ profiles, runtimeState: rcs ?? null });
  });

  // ── GET /profiles/:profileId ─────────────────────────────────────────
  app.get<{ Params: { profileId: string } }>("/profiles/:profileId", async (request) => {
    const { profileId } = request.params;

    const profile = controlDb
      .prepare(
        `SELECT p.*, ps.paused, ps.last_run_at, ps.open_orders, ps.open_positions,
                ps.total_exposure_usdc, ps.balance_usdc, ps.last_preflight_status
         FROM profiles p
         LEFT JOIN profile_summaries ps ON p.profile_id = ps.profile_id
         WHERE p.profile_id = ?`,
      )
      .get(profileId);

    if (!profile) throw new ApiError(404, `profile ${profileId} not found`, "PROFILE_NOT_FOUND");

    const settings = controlDb
      .prepare("SELECT * FROM profile_settings WHERE profile_id = ?")
      .get(profileId);

    const deployedFamilies = controlDb
      .prepare(
        `SELECT fd.family_id, fd.enabled, fd.operator_mode, fd.strategy_stage,
                fd.deployment_stage, fd.priority,
                fc.family_key, fc.primary_category, fc.regime,
                fc.fee_tier, fc.live_wallet_requirement, fc.requires_post_only_for_live
         FROM family_deployments fd
         JOIN family_catalog fc ON fd.family_id = fc.family_id
         WHERE fd.profile = ?
         ORDER BY fd.priority, fc.family_key`,
      )
      .all(profileId);

    return ok({ profile, settings: settings ?? null, deployedFamilies });
  });

  // ── GET /profiles/:profileId/settings ────────────────────────────────
  app.get<{ Params: { profileId: string } }>("/profiles/:profileId/settings", async (request) => {
    const { profileId } = request.params;
    const settings = controlDb
      .prepare("SELECT * FROM profile_settings WHERE profile_id = ?")
      .get(profileId);
    return ok(settings ?? null);
  });

  // ── GET /control/overview ────────────────────────────────────────────
  app.get("/control/overview", async () => {
    const profiles = controlDb
      .prepare(
        `SELECT p.profile_id, p.display_name,
                ps.paused, ps.last_run_at, ps.open_orders, ps.open_positions,
                ps.total_exposure_usdc, ps.balance_usdc, ps.last_preflight_status
         FROM profiles p
         LEFT JOIN profile_summaries ps ON p.profile_id = ps.profile_id
         ORDER BY p.profile_id`,
      )
      .all();

    const runtimeState =
      controlDb
        .prepare(
          "SELECT current_profile, desired_profile, runtime_status, paused, current_run_id FROM runtime_control_state WHERE id = 1",
        )
        .get() ?? null;

    const activeSwitch =
      controlDb
        .prepare(
          "SELECT * FROM profile_switch_requests WHERE state NOT IN ('completed','failed','rolled_back') ORDER BY requested_at DESC LIMIT 1",
        )
        .get() ?? null;

    const recentTransitions = controlDb
      .prepare("SELECT * FROM state_transitions ORDER BY created_at DESC LIMIT 10")
      .all();

    const proposalCount = controlDb
      .prepare("SELECT COUNT(*) as cnt FROM promotion_proposals WHERE status = 'pending'")
      .get() as { cnt: number };

    const heartbeats = controlDb
      .prepare("SELECT * FROM service_heartbeats ORDER BY last_heartbeat_at DESC")
      .all();

    return ok({
      profiles,
      runtimeState,
      activeSwitch,
      recentTransitions,
      pendingProposals: proposalCount.cnt,
      heartbeats,
    });
  });

  // ── Profile-scoped ledger helper ─────────────────────────────────────

  function requireLedger(profileId: string): Database.Database {
    const ledger = opts.ledgerPool.get(profileId);
    if (!ledger) throw new ApiError(404, `No ledger for profile ${profileId}`, "LEDGER_NOT_FOUND");
    return ledger;
  }

  // ── GET /profiles/:profileId/orders ────────────────────────────────

  app.get<{
    Params: { profileId: string };
    Querystring: { status?: string; family_id?: string; limit?: string; cursor?: string };
  }>("/profiles/:profileId/orders", async (request) => {
    const ledger = requireLedger(request.params.profileId);
    const { status, family_id, cursor } = request.query;
    const limit = Math.min(Number(request.query.limit) || 50, 200);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      const statuses = status.split(",").map((s) => s.trim());
      conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (family_id) {
      conditions.push("family_id = ?");
      params.push(family_id);
    }
    if (cursor) {
      conditions.push("created_at < ?");
      params.push(cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = ledger
      .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];

    const nextCursor = rows.length === limit ? (rows[rows.length - 1]!.created_at as string) : null;

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(ledger, tokenIds);

    return ok({
      items: rows.map((r) => orderToDto(r, getMetaOrEmpty(metaMap, r.token_id as string))),
      nextCursor,
    });
  });

  // ── GET /profiles/:profileId/positions ─────────────────────────────

  app.get<{
    Params: { profileId: string };
    Querystring: { family_id?: string; status?: string; dust?: string; sort?: string };
  }>("/profiles/:profileId/positions", async (request) => {
    const ledger = requireLedger(request.params.profileId);
    const { family_id, dust, status, sort } = request.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (family_id) {
      conditions.push("family_id = ?");
      params.push(family_id);
    }
    if (dust === "true") {
      conditions.push("status = 'dust'");
    } else if (status) {
      const statuses = status.split(",").map((s) => s.trim());
      conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    } else {
      conditions.push("status IN ('open','dust')");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderBy =
      sort === "tail_cost" ? "ORDER BY cost_basis_usdc DESC" : "ORDER BY updated_at DESC";

    const rows = ledger
      .prepare(`SELECT * FROM positions ${where} ${orderBy}`)
      .all(...params) as Record<string, unknown>[];

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(ledger, tokenIds);
    const conditionIds = [...metaMap.values()]
      .map((m) => m.conditionId)
      .filter(Boolean) as string[];
    const resMap = buildResolutionMap(ledger, conditionIds);

    return ok(
      rows.map((r) => {
        const meta = getMetaOrEmpty(metaMap, r.token_id as string);
        const resInfo = meta.conditionId ? resMap.get(meta.conditionId) : undefined;
        return positionToDto(r, meta, resInfo);
      }),
    );
  });

  // ── GET /profiles/:profileId/fills ─────────────────────────────────

  app.get<{
    Params: { profileId: string };
    Querystring: { family_id?: string; since?: string; limit?: string; cursor?: string };
  }>("/profiles/:profileId/fills", async (request) => {
    const ledger = requireLedger(request.params.profileId);
    const { family_id, since, cursor } = request.query;
    const limit = Math.min(Number(request.query.limit) || 50, 200);

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (family_id) {
      conditions.push("family_id = ?");
      params.push(family_id);
    }
    if (since) {
      conditions.push("filled_at >= ?");
      params.push(since);
    }
    if (cursor) {
      conditions.push("filled_at < ?");
      params.push(cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = ledger
      .prepare(`SELECT * FROM fills ${where} ORDER BY filled_at DESC LIMIT ?`)
      .all(...params) as Record<string, unknown>[];

    const nextCursor = rows.length === limit ? (rows[rows.length - 1]!.filled_at as string) : null;

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(ledger, tokenIds);

    return ok({
      items: rows.map((r) => fillToDto(r, getMetaOrEmpty(metaMap, r.token_id as string))),
      nextCursor,
    });
  });

  // ── PUT /profiles/:profileId/settings ────────────────────────────────
  app.put<{
    Params: { profileId: string };
    Body: {
      initialBalanceUsdc?: number;
      envelopeJson?: string;
      riskCapsJson?: string;
      walletMode?: "eoa" | "relayer";
      minOrderUsdc?: number;
      relayerJson?: string;
    };
  }>("/profiles/:profileId/settings", async (request) => {
    const { profileId } = request.params;
    const body = request.body ?? {};

    if (
      body.walletMode !== undefined &&
      body.walletMode !== "eoa" &&
      body.walletMode !== "relayer"
    ) {
      throw new ApiError(400, "walletMode must be 'eoa' or 'relayer'", "INVALID_WALLET_MODE");
    }
    if (
      body.minOrderUsdc !== undefined &&
      (!Number.isFinite(body.minOrderUsdc) || body.minOrderUsdc <= 0)
    ) {
      throw new ApiError(400, "minOrderUsdc must be > 0", "INVALID_MIN_ORDER");
    }

    controlDb
      .prepare(
        `INSERT INTO profile_settings
           (profile_id, initial_balance_usdc, envelope_json, risk_caps_json, wallet_mode, min_order_usdc, relayer_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(profile_id) DO UPDATE SET
           initial_balance_usdc = COALESCE(excluded.initial_balance_usdc, profile_settings.initial_balance_usdc),
           envelope_json = COALESCE(excluded.envelope_json, profile_settings.envelope_json),
           risk_caps_json = COALESCE(excluded.risk_caps_json, profile_settings.risk_caps_json),
           wallet_mode = COALESCE(excluded.wallet_mode, profile_settings.wallet_mode),
           min_order_usdc = COALESCE(excluded.min_order_usdc, profile_settings.min_order_usdc),
           relayer_json = COALESCE(excluded.relayer_json, profile_settings.relayer_json),
           updated_at = excluded.updated_at`,
      )
      .run(
        profileId,
        body.initialBalanceUsdc ?? null,
        body.envelopeJson ?? null,
        body.riskCapsJson ?? null,
        body.walletMode ?? null,
        body.minOrderUsdc ?? null,
        body.relayerJson ?? null,
      );

    const updated = controlDb
      .prepare("SELECT * FROM profile_settings WHERE profile_id = ?")
      .get(profileId);
    return ok(updated);
  });
};
