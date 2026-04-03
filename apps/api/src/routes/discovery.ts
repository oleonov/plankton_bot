import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import {
  type DiscoveryRun,
  PROBE_DEFAULTS,
  resolveFamilyLiveTradingPolicy,
} from "@plankton/domain";
import { SqliteDiscoveryRunRepository } from "@plankton/db";
import { ok, ApiError } from "../errors.js";

interface DiscoveryOpts {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
}

interface CandidateRow {
  candidate_id: string;
  family_key: string;
  regime: string;
  horizon: string;
  cadence: string;
  pattern_confidence: string;
  primary_category: string;
  strategy_profile: string;
  slug_pattern: string | null;
  matched_family_id: string | null;
  active_market_count: number;
  nearest_end_date: string | null;
  cluster_volume_24h: number;
  recurrence_score: number | null;
  recycle_score: number | null;
  live_viability_score: number | null;
  toxicity_penalty: number | null;
  gate_recommendation: string;
  recommendation_reason: string | null;
  scores_updated_at: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  reviewed_at: string | null;
  materialized_at: string | null;
}

function toCandidateDto(row: CandidateRow) {
  return {
    candidateId: row.candidate_id,
    familyKey: row.family_key,
    regime: row.regime,
    horizon: row.horizon,
    cadence: row.cadence,
    patternConfidence: row.pattern_confidence,
    primaryCategory: row.primary_category,
    strategyProfile: row.strategy_profile,
    slugPattern: row.slug_pattern,
    matchedFamilyId: row.matched_family_id,
    activeMarketCount: row.active_market_count,
    nearestEndDate: row.nearest_end_date,
    clusterVolume24h: row.cluster_volume_24h,
    recurrenceScore: row.recurrence_score,
    recycleScore: row.recycle_score,
    liveViabilityScore: row.live_viability_score,
    toxicityPenalty: row.toxicity_penalty,
    gateRecommendation: row.gate_recommendation,
    recommendationReason: row.recommendation_reason,
    scoresUpdatedAt: row.scores_updated_at,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    reviewedAt: row.reviewed_at,
    materializedAt: row.materialized_at,
  };
}

function toObservationDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    candidateId: row.candidate_id,
    activeMarketCount: row.active_market_count,
    clusterVolume24h: row.cluster_volume_24h,
    nearestEndDate: row.nearest_end_date,
    observedAt: row.observed_at,
  };
}

function getCandidate(db: Database.Database, candidateId: string): CandidateRow {
  const row = db
    .prepare("SELECT * FROM family_candidates WHERE candidate_id = ?")
    .get(candidateId) as CandidateRow | undefined;
  if (!row) throw new ApiError(404, `candidate ${candidateId} not found`, "CANDIDATE_NOT_FOUND");
  return row;
}

function formatRun(run: DiscoveryRun | null) {
  if (!run) return null;
  return {
    id: run.id,
    triggerType: run.triggerType,
    status: run.status,
    requestedBy: run.requestedBy,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    heartbeatAt: run.heartbeatAt,
    stats: run.stats,
    error: run.error,
  };
}

const SCORE_EXPR = "(COALESCE(recurrence_score, 0) * COALESCE(live_viability_score, 0))";

// Multi-criteria sort: status → recommendation → confidence → score → freshness
const STATUS_RANK = `CASE status
  WHEN 'discovered' THEN 0 WHEN 'reviewed' THEN 1
  WHEN 'materialized' THEN 2 WHEN 'deployed' THEN 3
  WHEN 'rejected' THEN 4 ELSE 5 END`;

const REC_RANK = `CASE gate_recommendation
  WHEN 'scaled-candidate' THEN 0 WHEN 'probe-candidate' THEN 1
  WHEN 'monitor' THEN 2 WHEN 'pending' THEN 3
  WHEN 'ignore' THEN 4 ELSE 5 END`;

const CONF_RANK = `CASE pattern_confidence
  WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`;

const ORDER_BY = `${STATUS_RANK}, ${REC_RANK}, ${CONF_RANK}, ${SCORE_EXPR} DESC, last_seen_at DESC, candidate_id ASC`;

interface CursorData {
  sr: number; // status rank
  rr: number; // recommendation rank
  cr: number; // confidence rank
  sc: number; // score (positive, not negated)
  ls: string; // last_seen_at ISO string (full precision)
  id: string; // candidate_id
}

function encodeCursor(row: CandidateRow): string {
  const data: CursorData = {
    sr: statusRank(row.status),
    rr: recRank(row.gate_recommendation),
    cr: confRank(row.pattern_confidence),
    sc: (row.recurrence_score ?? 0) * (row.live_viability_score ?? 0),
    ls: row.last_seen_at || "2000-01-01T00:00:00Z",
    id: row.candidate_id,
  };
  return Buffer.from(JSON.stringify(data)).toString("base64");
}

function decodeCursor(raw: string): CursorData | null {
  try {
    const json = Buffer.from(raw, "base64").toString("utf-8");
    const data = JSON.parse(json) as CursorData;
    if (
      typeof data.sr !== "number" ||
      typeof data.rr !== "number" ||
      typeof data.cr !== "number" ||
      typeof data.sc !== "number" ||
      typeof data.ls !== "string" ||
      typeof data.id !== "string"
    )
      return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Build keyset WHERE clause for multi-criteria pagination.
 * Equivalent to: "row sorts after cursor in the ORDER BY"
 * For ASC columns: col > val. For DESC columns: col < val.
 */
function buildKeysetClause(c: CursorData): { sql: string; params: unknown[] } {
  // SR ASC, RR ASC, CR ASC, SCORE DESC, LS DESC, ID ASC
  // Expand: (sr > ?) OR (sr = ? AND rr > ?) OR (sr = ? AND rr = ? AND cr > ?)
  //         OR (sr = ? AND rr = ? AND cr = ? AND score < ?)
  //         OR (sr = ? AND rr = ? AND cr = ? AND score = ? AND ls < ?)
  //         OR (sr = ? AND rr = ? AND cr = ? AND score = ? AND ls = ? AND id > ?)
  const sql = `(
    (${STATUS_RANK}) > ? OR
    ((${STATUS_RANK}) = ? AND (${REC_RANK}) > ?) OR
    ((${STATUS_RANK}) = ? AND (${REC_RANK}) = ? AND (${CONF_RANK}) > ?) OR
    ((${STATUS_RANK}) = ? AND (${REC_RANK}) = ? AND (${CONF_RANK}) = ? AND (${SCORE_EXPR}) < ?) OR
    ((${STATUS_RANK}) = ? AND (${REC_RANK}) = ? AND (${CONF_RANK}) = ? AND (${SCORE_EXPR}) = ? AND COALESCE(last_seen_at, '2000-01-01') < ?) OR
    ((${STATUS_RANK}) = ? AND (${REC_RANK}) = ? AND (${CONF_RANK}) = ? AND (${SCORE_EXPR}) = ? AND COALESCE(last_seen_at, '2000-01-01') = ? AND candidate_id > ?)
  )`;
  const params = [
    c.sr,
    c.sr,
    c.rr,
    c.sr,
    c.rr,
    c.cr,
    c.sr,
    c.rr,
    c.cr,
    c.sc,
    c.sr,
    c.rr,
    c.cr,
    c.sc,
    c.ls,
    c.sr,
    c.rr,
    c.cr,
    c.sc,
    c.ls,
    c.id,
  ];
  return { sql, params };
}

function statusRank(s: string): number {
  switch (s) {
    case "discovered":
      return 0;
    case "reviewed":
      return 1;
    case "materialized":
      return 2;
    case "deployed":
      return 3;
    case "rejected":
      return 4;
    default:
      return 5;
  }
}

function recRank(r: string): number {
  switch (r) {
    case "scaled-candidate":
      return 0;
    case "probe-candidate":
      return 1;
    case "monitor":
      return 2;
    case "pending":
      return 3;
    case "ignore":
      return 4;
    default:
      return 5;
  }
}

function confRank(c: string): number {
  switch (c) {
    case "high":
      return 0;
    case "medium":
      return 1;
    default:
      return 2;
  }
}

export const discoveryRoutes: FastifyPluginAsync<DiscoveryOpts> = async (app, opts) => {
  const { controlDb, ledgerDb } = opts;
  // Most discovery tables live in control DB; ledger is only needed for materialization
  const db = controlDb;

  // ── GET /discovery/status ───────────────────────────────────────────────
  app.get("/discovery/status", async () => {
    const runRepo = new SqliteDiscoveryRunRepository(db);
    const lastRun = runRepo.findRecent(1)[0] ?? null;
    const lastSuccessfulRun = runRepo.findLastSuccessful();
    const activeRun = runRepo.findActive();

    // Discovery worker writes to service_heartbeats (moved from runtime_metrics in Phase 1)
    const heartbeatRow = db
      .prepare(
        "SELECT MAX(last_heartbeat_at) as ts FROM service_heartbeats WHERE service_name = 'discovery'",
      )
      .get() as { ts: string | null } | undefined;
    const heartbeatAt = heartbeatRow?.ts ?? null;
    const workerState =
      heartbeatAt && Date.now() - new Date(heartbeatAt).getTime() < 90_000 ? "healthy" : "offline";

    return ok({
      lastRun: formatRun(lastRun),
      lastSuccessfulRun: formatRun(lastSuccessfulRun),
      activeRun: formatRun(activeRun),
      workerState,
    });
  });

  // ── POST /discovery/scan ────────────────────────────────────────────────
  app.post("/discovery/scan", async () => {
    const runRepo = new SqliteDiscoveryRunRepository(db);
    const active = runRepo.findActive();
    if (active) {
      return ok({ runId: active.id, status: active.status, alreadyActive: true });
    }

    try {
      const id = runRepo.enqueue("manual", "operator");
      return ok({ runId: id, status: "queued", alreadyActive: false });
    } catch (err) {
      // Only handle the expected "active run exists" race condition
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Active discovery run already exists")) {
        const nowActive = runRepo.findActive();
        if (nowActive) {
          return ok({ runId: nowActive.id, status: nowActive.status, alreadyActive: true });
        }
      }
      throw new ApiError(500, msg);
    }
  });

  // ── GET /discovery/runs ─────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: string } }>("/discovery/runs", async (req) => {
    const runRepo = new SqliteDiscoveryRunRepository(db);
    const limit = Math.min(parseInt(req.query.limit ?? "20", 10) || 20, 100);
    const runs = runRepo.findRecent(limit);
    return ok(runs.map(formatRun));
  });

  // ── GET /discovery/candidates ──────────────────────────────────────────
  app.get<{
    Querystring: {
      status?: string;
      confidence?: string;
      cadence?: string;
      recommendation?: string;
      limit?: string;
      cursor?: string;
    };
  }>("/discovery/candidates", async (request) => {
    const { status, confidence, cadence, recommendation, cursor } = request.query;
    const rawLimit = parseInt(request.query.limit ?? "50", 10);
    const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 50, 200);

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (confidence) {
      clauses.push("pattern_confidence = ?");
      params.push(confidence);
    }
    if (cadence) {
      clauses.push("cadence = ?");
      params.push(cadence);
    }
    if (recommendation) {
      clauses.push("gate_recommendation = ?");
      params.push(recommendation);
    }
    if (cursor) {
      const parsed = decodeCursor(cursor);
      if (!parsed) throw new ApiError(400, "invalid cursor format", "INVALID_CURSOR");
      const keyset = buildKeysetClause(parsed);
      clauses.push(keyset.sql);
      params.push(...keyset.params);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM family_candidates ${where}
      ORDER BY ${ORDER_BY}
      LIMIT ?`;
    params.push(limit + 1);

    const rows = db.prepare(sql).all(...params) as CandidateRow[];
    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const last = rows[rows.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last) : null;

    return ok({ items: rows.map(toCandidateDto), nextCursor });
  });

  // ── GET /discovery/candidates/:candidateId ─────────────────────────────
  app.get<{ Params: { candidateId: string } }>(
    "/discovery/candidates/:candidateId",
    async (request) => {
      const row = getCandidate(db, request.params.candidateId);
      const observations = db
        .prepare(
          "SELECT * FROM candidate_observations WHERE candidate_id = ? ORDER BY observed_at DESC LIMIT 10",
        )
        .all(row.candidate_id) as Record<string, unknown>[];
      return ok({
        ...toCandidateDto(row),
        recentObservations: observations.map(toObservationDto),
      });
    },
  );

  // ── GET /discovery/candidates/:candidateId/observations ────────────────
  app.get<{ Params: { candidateId: string } }>(
    "/discovery/candidates/:candidateId/observations",
    async (request) => {
      getCandidate(db, request.params.candidateId);
      const rows = db
        .prepare(
          "SELECT * FROM candidate_observations WHERE candidate_id = ? ORDER BY observed_at DESC",
        )
        .all(request.params.candidateId) as Record<string, unknown>[];
      return ok(rows.map(toObservationDto));
    },
  );

  // ── POST /discovery/candidates/:candidateId/review ─────────────────────
  app.post<{ Params: { candidateId: string } }>(
    "/discovery/candidates/:candidateId/review",
    async (request) => {
      const row = getCandidate(db, request.params.candidateId);
      if (row.status !== "discovered") {
        throw new ApiError(
          409,
          `candidate status is '${row.status}', expected 'discovered'`,
          "INVALID_STATUS",
        );
      }
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE family_candidates SET status = 'reviewed', reviewed_at = ? WHERE candidate_id = ?",
      ).run(now, row.candidate_id);
      return ok({ ...toCandidateDto(row), status: "reviewed", reviewedAt: now });
    },
  );

  // ── POST /discovery/candidates/:candidateId/accept ─────────────────────
  app.post<{
    Params: { candidateId: string };
    Body: { maxOpenValueUsdc?: number; maxActiveMarkets?: number; maxDustPositions?: number };
  }>("/discovery/candidates/:candidateId/accept", async (request) => {
    const row = getCandidate(db, request.params.candidateId);
    const familyId = row.candidate_id;
    const now = new Date().toISOString();
    const body = (request.body ?? {}) as {
      maxOpenValueUsdc?: number;
      maxActiveMarkets?: number;
      maxDustPositions?: number;
    };
    const caps = {
      maxOpenValue: body.maxOpenValueUsdc ?? PROBE_DEFAULTS.maxOpenValueUsdc,
      maxMarkets: body.maxActiveMarkets ?? PROBE_DEFAULTS.maxActiveMarkets,
      maxDust: body.maxDustPositions ?? PROBE_DEFAULTS.maxDustPositions,
    };

    if (!Number.isFinite(caps.maxOpenValue) || caps.maxOpenValue < 1) {
      throw new ApiError(400, "maxOpenValueUsdc must be >= 1", "INVALID_CAPS");
    }
    if (!Number.isInteger(caps.maxMarkets) || caps.maxMarkets < 1) {
      throw new ApiError(400, "maxActiveMarkets must be integer >= 1", "INVALID_CAPS");
    }
    if (!Number.isInteger(caps.maxDust) || caps.maxDust < 0) {
      throw new ApiError(400, "maxDustPositions must be integer >= 0", "INVALID_CAPS");
    }

    // Control DB transaction: all control-side inserts are atomic
    const materializeControl = controlDb.transaction(() => {
      // Read current status before updating (for audit trail)
      const current = controlDb
        .prepare("SELECT status FROM family_candidates WHERE candidate_id = ?")
        .get(row.candidate_id) as { status: string } | undefined;
      const fromStatus = current?.status ?? "unknown";

      // Atomically guard + update candidate status (race-safe)
      const result = controlDb
        .prepare(
          `UPDATE family_candidates
           SET status = 'materialized', materialized_at = ?
           WHERE candidate_id = ? AND status IN ('discovered', 'reviewed')`,
        )
        .run(now, row.candidate_id);
      if (result.changes === 0) return false;

      // 1. INSERT family_catalog
      const policy = resolveFamilyLiveTradingPolicy({
        primaryCategory: row.primary_category,
      });
      controlDb
        .prepare(
          `INSERT INTO family_catalog
             (family_id, family_key, primary_category, regime, horizon, cadence,
              strategy_profile, fee_tier, live_wallet_requirement,
              requires_post_only_for_live, slug_pattern, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          familyId,
          row.family_key,
          row.primary_category,
          row.regime,
          row.horizon,
          row.cadence,
          row.strategy_profile,
          policy.feeTier,
          policy.liveWalletRequirement,
          policy.requiresPostOnlyForLive ? 1 : 0,
          row.slug_pattern,
          now,
          now,
        );

      // 2. INSERT family_rules with probe-only defaults (overridable via request body)
      controlDb
        .prepare(
          `INSERT INTO family_rules
             (family_id, enabled, action, entry_mode, scale_mode, exit_mode,
              allow_heavy_campaigns, max_open_value_usdc, max_active_markets,
              max_dust_positions, updated_at)
           VALUES (?, 1, 'trade', 'probe-first', 'disabled', 'repricing-sell',
                   0, ?, ?, ?, ?)`,
        )
        .run(familyId, caps.maxOpenValue, caps.maxMarkets, caps.maxDust, now);

      // 3. INSERT family_deployments for sim + paper (enabled), live-lite (disabled)
      const insertDep = controlDb.prepare(
        `INSERT INTO family_deployments
             (family_id, profile, enabled, operator_mode, strategy_stage,
              deployment_stage, priority, created_at, updated_at)
           VALUES (?, ?, ?, 'active', 'probe-only', 'disabled', 999, ?, ?)`,
      );
      insertDep.run(familyId, "simulation", 1, now, now);
      insertDep.run(familyId, "paper", 1, now, now);
      insertDep.run(familyId, "live-lite", 0, now, now);

      // 4. INSERT family_evidence with zeros + probe warming-up substate
      controlDb
        .prepare(
          "INSERT INTO family_evidence (family_id, probe_substate, updated_at) VALUES (?, 'warming-up', ?)",
        )
        .run(familyId, now);

      // 5. INSERT family_rules_snapshot
      const rulesRow = controlDb
        .prepare("SELECT * FROM family_rules WHERE family_id = ?")
        .get(familyId) as Record<string, unknown>;
      controlDb
        .prepare(
          `INSERT INTO family_rules_snapshot (family_id, snapshot, reason, captured_at)
           VALUES (?, ?, 'probe-baseline', ?)`,
        )
        .run(familyId, JSON.stringify(rulesRow), now);

      // 6. INSERT operator_commands (rules_reload, deduped)
      const pending = controlDb
        .prepare(
          "SELECT 1 FROM operator_commands WHERE action = 'rules_reload' AND status = 'pending' LIMIT 1",
        )
        .get();
      if (!pending) {
        controlDb
          .prepare(
            `INSERT INTO operator_commands
               (action, target_id, reason, status, initiator_type, created_at)
             VALUES ('rules_reload', NULL, ?, 'pending', 'system', ?)`,
          )
          .run(`materialized candidate ${familyId}`, now);
      }

      // 7. INSERT state_transitions
      controlDb
        .prepare(
          `INSERT INTO state_transitions
             (entity_type, entity_id, from_state, to_state, trigger_type, initiator, reason)
           VALUES ('candidate', ?, ?, 'materialized', 'operator', 'api', ?)`,
        )
        .run(row.candidate_id, fromStatus, `accepted via API`);

      return true;
    });

    const applied = materializeControl();
    if (!applied) {
      throw new ApiError(
        409,
        `candidate was concurrently modified (no longer 'reviewed')`,
        "CONCURRENT_MODIFICATION",
      );
    }

    // Ledger DB: insert family_runtime_state baseline (separate DB, not transactional with control)
    ledgerDb
      .prepare(
        `INSERT INTO family_runtime_state
           (family_id, runtime_mode, open_value_usdc, open_position_count,
            open_dust_count, active_market_count, current_tail_cost_usdc,
            tail_adjusted_pnl_live, effective_mode, derived_mode_reason, updated_at)
         VALUES (?, 'active', 0, 0, 0, 0, 0, 0, 'active',
                 'baseline: zero exposure, probe-only gated by entry rules', ?)`,
      )
      .run(familyId, now);

    return ok({
      ...toCandidateDto(row),
      status: "materialized",
      materializedAt: now,
    });
  });

  // ── GET /discovery/candidates/:candidateId/transitions ────────────────
  app.get<{ Params: { candidateId: string } }>(
    "/discovery/candidates/:candidateId/transitions",
    async (request) => {
      getCandidate(db, request.params.candidateId);
      const rows = db
        .prepare(
          `SELECT * FROM state_transitions
           WHERE entity_type = 'candidate' AND entity_id = ?
           ORDER BY created_at DESC, id DESC`,
        )
        .all(request.params.candidateId) as Array<Record<string, unknown>>;
      return ok(
        rows.map((r) => ({
          id: r.id,
          entityType: r.entity_type,
          entityId: r.entity_id,
          fromState: r.from_state,
          toState: r.to_state,
          triggerType: r.trigger_type,
          initiator: r.initiator,
          reason: r.reason,
          scoresSnapshot: r.scores_snapshot,
          createdAt: r.created_at,
        })),
      );
    },
  );

  // ── POST /discovery/candidates/:candidateId/reject ─────────────────────
  app.post<{ Params: { candidateId: string } }>(
    "/discovery/candidates/:candidateId/reject",
    async (request) => {
      const row = getCandidate(db, request.params.candidateId);
      if (row.status !== "discovered" && row.status !== "reviewed") {
        throw new ApiError(
          409,
          `candidate status is '${row.status}', expected 'discovered' or 'reviewed'`,
          "INVALID_STATUS",
        );
      }
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE family_candidates SET status = 'rejected', reviewed_at = ? WHERE candidate_id = ?",
      ).run(now, row.candidate_id);
      return ok({ ...toCandidateDto(row), status: "rejected", reviewedAt: now });
    },
  );
};
