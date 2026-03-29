import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import type { DiscoveryRun } from "@plankton/domain";
import { SqliteDiscoveryRunRepository } from "@plankton/db";
import { ok, ApiError } from "../errors.js";

interface DiscoveryOpts {
  db: Database.Database;
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

export const discoveryRoutes: FastifyPluginAsync<DiscoveryOpts> = async (app, opts) => {
  const { db } = opts;

  // ── GET /discovery/status ───────────────────────────────────────────────
  app.get("/discovery/status", async () => {
    const runRepo = new SqliteDiscoveryRunRepository(db);
    const lastRun = runRepo.findRecent(1)[0] ?? null;
    const lastSuccessfulRun = runRepo.findLastSuccessful();
    const activeRun = runRepo.findActive();

    const heartbeatRow = db
      .prepare(
        "SELECT MAX(captured_at) as ts FROM runtime_metrics WHERE metric_name = 'discovery_worker_heartbeat'",
      )
      .get() as { ts: string | null } | undefined;
    const heartbeatAt = heartbeatRow?.ts ?? null;
    const workerState =
      heartbeatAt && Date.now() - new Date(heartbeatAt).getTime() < 90_000
        ? "healthy"
        : "offline";

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
    } catch {
      const nowActive = runRepo.findActive();
      return ok({
        runId: nowActive?.id ?? 0,
        status: nowActive?.status ?? "unknown",
        alreadyActive: true,
      });
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
    };
  }>("/discovery/candidates", async (request) => {
    const { status, confidence, cadence, recommendation } = request.query;

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

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM family_candidates ${where}
      ORDER BY (COALESCE(recurrence_score, 0) * COALESCE(live_viability_score, 0)) DESC`;

    const rows = db.prepare(sql).all(...params) as CandidateRow[];
    return ok(rows.map(toCandidateDto));
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
  app.post<{ Params: { candidateId: string } }>(
    "/discovery/candidates/:candidateId/accept",
    async (request) => {
      const row = getCandidate(db, request.params.candidateId);
      const familyId = row.candidate_id;
      const now = new Date().toISOString();

      const materialize = db.transaction(() => {
        // Atomically guard + update candidate status (race-safe)
        const result = db.prepare(
          `UPDATE family_candidates
           SET status = 'materialized', materialized_at = ?
           WHERE candidate_id = ? AND status = 'reviewed'`,
        ).run(now, row.candidate_id);
        if (result.changes === 0) return false;

        // 1. INSERT family_catalog
        db.prepare(
          `INSERT INTO family_catalog
             (family_id, family_key, primary_category, regime, horizon, cadence,
              strategy_profile, slug_pattern, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          familyId,
          row.family_key,
          row.primary_category,
          row.regime,
          row.horizon,
          row.cadence,
          row.strategy_profile,
          row.slug_pattern,
          now,
          now,
        );

        // 2. INSERT family_rules with probe-only defaults
        db.prepare(
          `INSERT INTO family_rules
             (family_id, enabled, action, entry_mode, scale_mode, exit_mode,
              allow_heavy_campaigns, max_open_value_usdc, max_active_markets,
              max_dust_positions, updated_at)
           VALUES (?, 1, 'trade', 'probe-first', 'disabled', 'repricing-sell',
                   0, 10.0, 3, 2, ?)`,
        ).run(familyId, now);

        // 3. INSERT family_evidence with zeros + probe warming-up substate
        db.prepare(
          "INSERT INTO family_evidence (family_id, probe_substate, updated_at) VALUES (?, 'warming-up', ?)",
        ).run(familyId, now);

        // 4. INSERT family_runtime_state baseline
        db.prepare(
          `INSERT INTO family_runtime_state
             (family_id, runtime_mode, open_value_usdc, open_position_count,
              open_dust_count, active_market_count, current_tail_cost_usdc,
              tail_adjusted_pnl_live, effective_mode, derived_mode_reason, updated_at)
           VALUES (?, 'active', 0, 0, 0, 0, 0, 0, 'active',
                   'baseline: zero exposure, probe-only gated by entry rules', ?)`,
        ).run(familyId, now);

        // 5. INSERT family_rules_snapshot
        const rulesRow = db
          .prepare("SELECT * FROM family_rules WHERE family_id = ?")
          .get(familyId) as Record<string, unknown>;
        db.prepare(
          `INSERT INTO family_rules_snapshot (family_id, snapshot, reason, captured_at)
           VALUES (?, ?, 'probe-baseline', ?)`,
        ).run(familyId, JSON.stringify(rulesRow), now);

        // 6. INSERT operator_commands (rules_reload, deduped)
        const pending = db
          .prepare(
            "SELECT 1 FROM operator_commands WHERE action = 'rules_reload' AND status = 'pending' LIMIT 1",
          )
          .get();
        if (!pending) {
          db.prepare(
            `INSERT INTO operator_commands
               (action, target_id, reason, status, initiator_type, created_at)
             VALUES ('rules_reload', NULL, ?, 'pending', 'system', ?)`,
          ).run(`materialized candidate ${familyId}`, now);
        }

        // 7. INSERT state_transitions
        db.prepare(
          `INSERT INTO state_transitions
             (entity_type, entity_id, from_state, to_state, trigger_type, initiator, reason)
           VALUES ('candidate', ?, 'reviewed', 'materialized', 'operator', 'api', ?)`,
        ).run(row.candidate_id, `accepted via API`);

        return true;
      });

      const applied = materialize();
      if (!applied) {
        throw new ApiError(
          409,
          `candidate was concurrently modified (no longer 'reviewed')`,
          "CONCURRENT_MODIFICATION",
        );
      }

      return ok({
        ...toCandidateDto(row),
        status: "materialized",
        materializedAt: now,
      });
    },
  );

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
