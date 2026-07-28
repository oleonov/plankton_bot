import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok, ApiError } from "../errors.js";
import { buildMarketMetaMap, getMetaOrEmpty, buildResolutionMap } from "../enrich-market.js";
import { buildLegStateMap, getLegStateOrEmpty } from "../enrich-leg-state.js";
import { toDto as orderToDto } from "./orders.js";
import { toDto as positionToDto } from "./positions.js";
import { toDto as fillToDto, buildPnlMap } from "./fills.js";
import type { LedgerPool } from "../ledger-pool.js";
import { getActor } from "../auth.js";
import { diffFields, recordHistory, type HistoryRow } from "../profile-settings-history.js";
import {
  DEFAULT_EXECUTION_POLICY,
  DEFAULT_OPPORTUNISTIC_TAKER_POLICY,
  DEFAULT_PROFIT_TARGET_POLICY,
  DEFAULT_DUST_ABANDONMENT_POLICY,
  DEFAULT_REPRICE_CHAIN_POLICY,
  DEFAULT_LOSS_EXIT_POLICY,
  DEFAULT_MAKER_ENTRY,
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
  type ExecutionPolicy,
} from "@krabs/domain";
import { readExecutionPolicyVersion } from "@krabs/db";

const TRACKED_COLUMNS =
  "initial_balance_usdc, envelope_json, risk_caps_json, wallet_mode, min_order_usdc, relayer_json, execution_policy_json";

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

    return ok({ profile, settings: settings ?? null });
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

    const heartbeats = controlDb
      .prepare("SELECT * FROM service_heartbeats ORDER BY last_heartbeat_at DESC")
      .all();

    return ok({
      profiles,
      runtimeState,
      activeSwitch,
      recentTransitions,
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
    Querystring: {
      status?: string;
      limit?: string;
      cursor?: string;
      page?: string;
    };
  }>("/profiles/:profileId/orders", async (request) => {
    const ledger = requireLedger(request.params.profileId);
    const { status, cursor } = request.query;
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const page = Math.max(Number(request.query.page) || 1, 1);
    const pageRequested = request.query.page != null;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (status) {
      const statuses = status.split(",").map((s) => s.trim());
      conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (!pageRequested && cursor) {
      conditions.push("created_at < ?");
      params.push(cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const totalCount = (
      ledger.prepare(`SELECT COUNT(*) as cnt FROM orders ${where}`).get(...params) as {
        cnt: number;
      }
    ).cnt;

    const offset = pageRequested ? (page - 1) * limit : 0;
    const queryParams = [...params, limit];
    const offsetClause = pageRequested ? " OFFSET ?" : "";
    if (pageRequested) queryParams.push(offset);

    const rows = ledger
      .prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ?${offsetClause}`)
      .all(...queryParams) as Record<string, unknown>[];

    const nextCursor =
      !pageRequested && rows.length === limit
        ? (rows[rows.length - 1]!.created_at as string)
        : null;

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(ledger, tokenIds);

    return ok({
      items: rows.map((r) => orderToDto(r, getMetaOrEmpty(metaMap, r.token_id as string))),
      nextCursor,
      totalCount,
      page: pageRequested ? page : undefined,
      pageSize: pageRequested ? limit : undefined,
      totalPages: pageRequested ? Math.max(1, Math.ceil(totalCount / limit)) : undefined,
    });
  });

  // ── GET /profiles/:profileId/positions ─────────────────────────────

  app.get<{
    Params: { profileId: string };
    Querystring: { status?: string; dust?: string; sort?: string };
  }>("/profiles/:profileId/positions", async (request) => {
    const ledger = requireLedger(request.params.profileId);
    const { dust, status, sort } = request.query;

    const conditions: string[] = [];
    const params: unknown[] = [];

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
    const legMap = buildLegStateMap(ledger, tokenIds);

    return ok(
      rows.map((r) => {
        const tokenId = r.token_id as string;
        const meta = getMetaOrEmpty(metaMap, tokenId);
        const resInfo = meta.conditionId ? resMap.get(meta.conditionId) : undefined;
        const leg = getLegStateOrEmpty(legMap, tokenId);
        return positionToDto(r, meta, resInfo, leg);
      }),
    );
  });

  // ── GET /profiles/:profileId/fills ─────────────────────────────────

  app.get<{
    Params: { profileId: string };
    Querystring: {
      since?: string;
      limit?: string;
      cursor?: string;
      page?: string;
    };
  }>("/profiles/:profileId/fills", async (request) => {
    const ledger = requireLedger(request.params.profileId);
    const { since, cursor } = request.query;
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const page = Math.max(Number(request.query.page) || 1, 1);
    const pageRequested = request.query.page != null;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (since) {
      conditions.push("filled_at >= ?");
      params.push(since);
    }
    if (!pageRequested && cursor) {
      conditions.push("filled_at < ?");
      params.push(cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const totalCount = (
      ledger.prepare(`SELECT COUNT(*) as cnt FROM fills ${where}`).get(...params) as { cnt: number }
    ).cnt;

    const offset = pageRequested ? (page - 1) * limit : 0;
    const queryParams = [...params, limit];
    const offsetClause = pageRequested ? " OFFSET ?" : "";
    if (pageRequested) queryParams.push(offset);

    const rows = ledger
      .prepare(`SELECT * FROM fills ${where} ORDER BY filled_at DESC LIMIT ?${offsetClause}`)
      .all(...queryParams) as Record<string, unknown>[];

    const nextCursor =
      !pageRequested && rows.length === limit ? (rows[rows.length - 1]!.filled_at as string) : null;

    const tokenIds = rows.map((r) => r.token_id as string);
    const metaMap = buildMarketMetaMap(ledger, tokenIds);
    const pnlMap = buildPnlMap(ledger, rows);

    return ok({
      items: rows.map((r) => fillToDto(r, getMetaOrEmpty(metaMap, r.token_id as string), pnlMap)),
      nextCursor,
      totalCount,
      page: pageRequested ? page : undefined,
      pageSize: pageRequested ? limit : undefined,
      totalPages: pageRequested ? Math.max(1, Math.ceil(totalCount / limit)) : undefined,
    });
  });

  // ── PUT /profiles/:profileId/settings ────────────────────────────────
  //
  // Each tracked column diff is appended to `profile_settings_history` so
  // every API-driven change is auditable. Operators changing values via
  // direct SQL UPDATE bypass this trail — see docs/runbooks/envelope_changes.md.
  app.put<{
    Params: { profileId: string };
    Body: {
      initialBalanceUsdc?: number;
      envelopeJson?: string;
      riskCapsJson?: string;
      walletMode?: "eoa" | "relayer";
      minOrderUsdc?: number;
      relayerJson?: string;
      reason?: string;
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
    if (
      body.initialBalanceUsdc !== undefined &&
      (!Number.isFinite(body.initialBalanceUsdc) || body.initialBalanceUsdc < 0)
    ) {
      throw new ApiError(
        400,
        "initialBalanceUsdc must be a finite non-negative number",
        "INVALID_INITIAL_BALANCE",
      );
    }

    const profileRow = controlDb
      .prepare("SELECT 1 FROM profiles WHERE profile_id = ?")
      .get(profileId);
    if (!profileRow) {
      throw new ApiError(404, `profile ${profileId} not found`, "PROFILE_NOT_FOUND");
    }

    const actor = getActor(request);
    const reason = typeof body.reason === "string" ? body.reason : null;

    const transaction = controlDb.transaction(() => {
      const before = (controlDb
        .prepare(`SELECT ${TRACKED_COLUMNS} FROM profile_settings WHERE profile_id = ?`)
        .get(profileId) ?? {}) as Record<string, string | number | null>;

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

      const after = (controlDb
        .prepare(`SELECT ${TRACKED_COLUMNS} FROM profile_settings WHERE profile_id = ?`)
        .get(profileId) ?? {}) as Record<string, string | number | null>;

      const diffs = diffFields(before, after);
      if (diffs.length > 0) {
        recordHistory(
          controlDb,
          diffs.map((d) => ({
            profileId,
            field: d.field,
            beforeValue: d.before,
            afterValue: d.after,
            actor,
            source: "api_put_settings",
            reason,
          })),
        );
      }
    });
    transaction();

    const updated = controlDb
      .prepare("SELECT * FROM profile_settings WHERE profile_id = ?")
      .get(profileId);
    return ok(updated);
  });

  // ── GET /profiles/:profileId/execution-policy ────────────────────────
  //
  // ADR-015 — returns the current policy snapshot + version. Invalid JSON
  // persisted by an earlier bad write still parses to defaults here so the
  // UI can always render a form; `issues` surfaces the validation output so
  // the caller can warn the operator.
  app.get<{ Params: { profileId: string } }>(
    "/profiles/:profileId/execution-policy",
    async (request) => {
      const { profileId } = request.params;
      const profileRow = controlDb
        .prepare("SELECT 1 FROM profiles WHERE profile_id = ?")
        .get(profileId) as { 1: number } | undefined;
      if (!profileRow) {
        throw new ApiError(404, `profile ${profileId} not found`, "PROFILE_NOT_FOUND");
      }
      const row = controlDb
        .prepare("SELECT execution_policy_json FROM profile_settings WHERE profile_id = ?")
        .get(profileId) as { execution_policy_json: string | null } | undefined;
      const { policy, issues } = parseExecutionPolicyJson(row?.execution_policy_json ?? null);
      const version = readExecutionPolicyVersion(controlDb);
      return ok({ policy, version, issues });
    },
  );

  // ── PATCH /profiles/:profileId/execution-policy ──────────────────────
  //
  // ADR-015 — accepts a full or partial policy object, merges on top of the
  // current stored payload, validates via `parseExecutionPolicyJson`, and
  // persists. On any validation issue the request is rejected with 400 so
  // the operator sees the problem instead of silently getting defaults.
  // The repository (runtime path) bumps `execution_policy_version` on byte
  // change; here we bump it inline to stay consistent.
  app.patch<{
    Params: { profileId: string };
    Body: Partial<ExecutionPolicy> & { reason?: string };
  }>("/profiles/:profileId/execution-policy", async (request) => {
    const { profileId } = request.params;
    const rawBody = (request.body ?? {}) as Record<string, unknown>;
    const reason = typeof rawBody.reason === "string" ? rawBody.reason : null;
    const { reason: _omitReason, ...patch } = rawBody;
    void _omitReason;

    const existsRow = controlDb
      .prepare("SELECT 1 FROM profile_settings WHERE profile_id = ?")
      .get(profileId) as { 1: number } | undefined;
    if (!existsRow) {
      throw new ApiError(404, `profile ${profileId} not found`, "PROFILE_NOT_FOUND");
    }

    const currentRow = controlDb
      .prepare("SELECT execution_policy_json FROM profile_settings WHERE profile_id = ?")
      .get(profileId) as { execution_policy_json: string | null } | undefined;
    const current = parseExecutionPolicyJson(currentRow?.execution_policy_json ?? null).policy;

    // Deep-merge: nested objects (deadSideGuard/pricing/telemetry) merge
    // field-by-field so a PATCH touching only `deadSideGuard.mode` preserves
    // `askCeiling` and `maxTimeToEndMs`. Unrelated top-level fields carry over
    // from `current`.
    const candidate: ExecutionPolicy = {
      ...DEFAULT_EXECUTION_POLICY,
      ...current,
      ...(patch as Partial<ExecutionPolicy>),
      marketSelection: {
        ...current.marketSelection,
        ...((patch.marketSelection as Partial<ExecutionPolicy["marketSelection"]> | undefined) ??
          {}),
      },
      buyCapacity: {
        ...current.buyCapacity,
        ...((patch.buyCapacity as Partial<ExecutionPolicy["buyCapacity"]> | undefined) ?? {}),
      },
      positionConcentration: {
        ...current.positionConcentration,
        ...((patch.positionConcentration as
          | Partial<ExecutionPolicy["positionConcentration"]>
          | undefined) ?? {}),
      },
      sellCapacity: {
        ...current.sellCapacity,
        ...((patch.sellCapacity as Partial<ExecutionPolicy["sellCapacity"]> | undefined) ?? {}),
      },
      orderCapacity: {
        ...current.orderCapacity,
        ...((patch.orderCapacity as Partial<ExecutionPolicy["orderCapacity"]> | undefined) ?? {}),
      },
      deadSideGuard: {
        ...current.deadSideGuard,
        ...((patch.deadSideGuard as Partial<ExecutionPolicy["deadSideGuard"]> | undefined) ?? {}),
      },
      pricing: {
        ...current.pricing,
        ...((patch.pricing as Partial<ExecutionPolicy["pricing"]> | undefined) ?? {}),
      },
      opportunisticTaker: {
        ...(current.opportunisticTaker ?? DEFAULT_OPPORTUNISTIC_TAKER_POLICY),
        ...((patch.opportunisticTaker as
          | Partial<ExecutionPolicy["opportunisticTaker"]>
          | undefined) ?? {}),
      },
      redeemSweep: {
        ...current.redeemSweep,
        ...((patch.redeemSweep as Partial<ExecutionPolicy["redeemSweep"]> | undefined) ?? {}),
      },
      raceProtection: {
        ...(current.raceProtection ?? DEFAULT_EXECUTION_POLICY.raceProtection),
        ...((patch.raceProtection as Partial<ExecutionPolicy["raceProtection"]> | undefined) ?? {}),
        redeemInFlight: {
          ...(current.raceProtection?.redeemInFlight ??
            DEFAULT_EXECUTION_POLICY.raceProtection.redeemInFlight),
          ...((patch.raceProtection as Partial<ExecutionPolicy["raceProtection"]> | undefined)
            ?.redeemInFlight ?? {}),
        },
      },
      orderLifetime: {
        ...current.orderLifetime,
        ...((patch.orderLifetime as Partial<ExecutionPolicy["orderLifetime"]> | undefined) ?? {}),
        burst: {
          ...current.orderLifetime.burst,
          ...((patch.orderLifetime as Partial<ExecutionPolicy["orderLifetime"]> | undefined)
            ?.burst ?? {}),
        },
        middle: {
          ...current.orderLifetime.middle,
          ...((patch.orderLifetime as Partial<ExecutionPolicy["orderLifetime"]> | undefined)
            ?.middle ?? {}),
        },
        passive: {
          ...current.orderLifetime.passive,
          ...((patch.orderLifetime as Partial<ExecutionPolicy["orderLifetime"]> | undefined)
            ?.passive ?? {}),
        },
      },
      repriceOnOutbid: {
        ...current.repriceOnOutbid,
        ...((patch.repriceOnOutbid as Partial<ExecutionPolicy["repriceOnOutbid"]> | undefined) ??
          {}),
      },
      exitRepriceOnDownprice: {
        ...current.exitRepriceOnDownprice,
        ...((patch.exitRepriceOnDownprice as
          | Partial<ExecutionPolicy["exitRepriceOnDownprice"]>
          | undefined) ?? {}),
      },
      dropTrigger: {
        ...current.dropTrigger,
        ...((patch.dropTrigger as Partial<ExecutionPolicy["dropTrigger"]> | undefined) ?? {}),
      },
      multiBuyLadder: {
        ...current.multiBuyLadder,
        ...((patch.multiBuyLadder as Partial<ExecutionPolicy["multiBuyLadder"]> | undefined) ?? {}),
      },
      telemetry: {
        ...current.telemetry,
        ...((patch.telemetry as Partial<ExecutionPolicy["telemetry"]> | undefined) ?? {}),
      },
      trackAAddThrottle: {
        ...(current.trackAAddThrottle ?? DEFAULT_EXECUTION_POLICY.trackAAddThrottle),
        ...((patch.trackAAddThrottle as
          | Partial<ExecutionPolicy["trackAAddThrottle"]>
          | undefined) ?? {}),
      },
      profitTarget: {
        ...(current.profitTarget ?? DEFAULT_PROFIT_TARGET_POLICY),
        ...((patch.profitTarget as Partial<ExecutionPolicy["profitTarget"]> | undefined) ?? {}),
      },
      dustAbandonment: {
        ...(current.dustAbandonment ?? DEFAULT_DUST_ABANDONMENT_POLICY),
        ...((patch.dustAbandonment as Partial<ExecutionPolicy["dustAbandonment"]> | undefined) ??
          {}),
      },
      repriceChain: {
        ...(current.repriceChain ?? DEFAULT_REPRICE_CHAIN_POLICY),
        ...((patch.repriceChain as Partial<ExecutionPolicy["repriceChain"]> | undefined) ?? {}),
      },
      lossExit: {
        ...(current.lossExit ?? DEFAULT_LOSS_EXIT_POLICY),
        ...((patch.lossExit as Partial<ExecutionPolicy["lossExit"]> | undefined) ?? {}),
        cohortGuard: {
          ...(current.lossExit?.cohortGuard ?? DEFAULT_LOSS_EXIT_POLICY.cohortGuard),
          ...(((patch.lossExit as Partial<ExecutionPolicy["lossExit"]> | undefined)?.cohortGuard as
            | Partial<ExecutionPolicy["lossExit"]["cohortGuard"]>
            | undefined) ?? {}),
        },
      },
      makerEntry: {
        ...(current.makerEntry ?? DEFAULT_MAKER_ENTRY),
        ...((patch.makerEntry as Partial<ExecutionPolicy["makerEntry"]> | undefined) ?? {}),
      },
    };

    const parsed = parseExecutionPolicyJson(serializeExecutionPolicy(candidate));
    if (parsed.issues.length > 0) {
      throw new ApiError(
        400,
        `invalid execution policy: ${parsed.issues.join("; ")}`,
        "INVALID_EXECUTION_POLICY",
      );
    }

    const nextJson = serializeExecutionPolicy(parsed.policy);
    const prevJson = currentRow?.execution_policy_json ?? null;

    const actor = getActor(request);
    const applyWrite = controlDb.transaction(() => {
      controlDb
        .prepare(
          `UPDATE profile_settings
              SET execution_policy_json = ?, updated_at = datetime('now')
            WHERE profile_id = ?`,
        )
        .run(nextJson, profileId);
      if (nextJson !== prevJson) {
        controlDb
          .prepare(
            `UPDATE runtime_control_state
                SET execution_policy_version = COALESCE(execution_policy_version, 0) + 1
              WHERE id = 1`,
          )
          .run();
        recordHistory(controlDb, [
          {
            profileId,
            field: "execution_policy_json",
            beforeValue: prevJson,
            afterValue: nextJson,
            actor,
            source: "api_patch_execution_policy",
            reason,
          },
        ]);
      }
    });
    applyWrite();

    const version = readExecutionPolicyVersion(controlDb);

    // Release A Phase 3 (P8 — owner-liveness drain reporting). Disabling bounce only
    // stops NEW bounce-owner assignment; EXISTING bounce owners keep being serviced
    // (owner-authoritative servicing — they are never stranded). Report the two states
    // separately, with an AUTHORITATIVE drain count taken under a ledger BEGIN IMMEDIATE
    // write-barrier so it cannot race a first-fill transaction that commits a new bounce
    // owner just after a plain SELECT. Irreducible dust (status='dust') is excluded — it
    // retires only at resolution and would otherwise block the count indefinitely.
    const bounceDisabled =
      parsed.policy.bounceExit.enabled !== true || parsed.policy.bounceExit.mode === "off";
    if (!bounceDisabled) {
      return ok({ policy: parsed.policy, version, issues: parsed.issues });
    }
    // Best-effort drain count — the policy change already committed above, so ANY
    // ledger error (bootstrap / prepare / transaction) must NOT fail the PATCH;
    // report bounceDraining=null and still return the committed 200.
    let bounceDraining: number | null = null;
    try {
      const ledger = opts.ledgerPool.get(profileId);
      if (ledger) {
        const drain = ledger
          .transaction(
            () =>
              ledger
                .prepare(
                  `SELECT COUNT(*) AS n FROM positions WHERE exit_owner = 'bounce' AND status = 'open'`,
                )
                .get() as { n: number },
          )
          .immediate();
        bounceDraining = drain.n;
      }
    } catch (err) {
      request.log.warn({ err, profileId }, "bounce drain count unavailable — reporting null");
    }
    return ok({
      policy: parsed.policy,
      version,
      issues: parsed.issues,
      bounceAssignment: "disabled",
      bounceDraining,
    });
  });

  // ── GET /profiles/:profileId/history ─────────────────────────────────
  //
  // Append-only audit log of profile_settings mutations. Filterable by field
  // (e.g. ?field=envelope_json) and capped at 500 rows.
  app.get<{
    Params: { profileId: string };
    Querystring: { field?: string; limit?: string };
  }>("/profiles/:profileId/history", async (request) => {
    const { profileId } = request.params;
    const { field } = request.query;
    const rawLimit = Number.parseInt(request.query.limit ?? "50", 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;

    const rows = field
      ? (controlDb
          .prepare(
            `SELECT id, profile_id, field, before_value, after_value, actor, source, reason, changed_at
               FROM profile_settings_history
              WHERE profile_id = ? AND field = ?
              ORDER BY changed_at DESC, id DESC
              LIMIT ?`,
          )
          .all(profileId, field, limit) as HistoryRow[])
      : (controlDb
          .prepare(
            `SELECT id, profile_id, field, before_value, after_value, actor, source, reason, changed_at
               FROM profile_settings_history
              WHERE profile_id = ?
              ORDER BY changed_at DESC, id DESC
              LIMIT ?`,
          )
          .all(profileId, limit) as HistoryRow[]);

    return ok({ profileId, field: field ?? null, limit, history: rows });
  });
};
