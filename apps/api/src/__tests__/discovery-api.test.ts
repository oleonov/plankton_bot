import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

function json(res: { json: () => unknown }): any {
  return res.json();
}

const TEST_API_KEY = "test-key-disc";

function testConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    runtimeMode: "simulation",
    logLevel: "error",
    dbPath: "",
    familyRulesPath: "",
    marketDataPollIntervalMs: 30_000,
    marketDataStaleThresholdMs: 120_000,
    strategyScanIntervalMs: 5_000,
    fillPollIntervalMs: 5_000,
    executionMaxConcurrency: 4,
    polyApiKey: undefined,
    polyApiSecret: undefined,
    polyPassphrase: undefined,
    polyPrivateKey: undefined,
    planktonApiKey: TEST_API_KEY,
    planktonApiPort: 0,
    planktonAuthUsername: undefined,
    planktonAuthPassword: undefined,
    planktonSessionSecret: undefined,
    trustProxy: false,
    ...overrides,
  };
}

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  // Add service_heartbeats table (Phase 1 control schema) to legacy monolithic DB
  conn.db.exec(`
    CREATE TABLE IF NOT EXISTS service_heartbeats (
      service_name      TEXT NOT NULL,
      instance_id       TEXT NOT NULL,
      profile           TEXT,
      run_id            TEXT,
      last_heartbeat_at TEXT NOT NULL,
      status_json       TEXT,
      PRIMARY KEY (service_name, instance_id)
    );
    CREATE TABLE IF NOT EXISTS family_deployments (
      family_id         TEXT NOT NULL,
      profile           TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      operator_mode     TEXT NOT NULL DEFAULT 'active',
      strategy_stage    TEXT NOT NULL DEFAULT 'probe-only',
      deployment_stage  TEXT NOT NULL DEFAULT 'disabled',
      priority          INTEGER NOT NULL DEFAULT 999,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (family_id, profile)
    )
  `);
  app = await buildServer({ config: testConfig(), controlDb: conn.db, ledgerDb: conn.db, ledgerPool: stubLedgerPool() });
});

afterAll(async () => {
  await app.close();
  conn.close();
});

// ─── Status ─────────────────────────────────────────────────────────────

describe("GET /discovery/status", () => {
  it("returns worker state and last scan info", async () => {
    const db = conn.db;

    // Seed a succeeded discovery_run
    db.prepare(
      `INSERT INTO discovery_runs (trigger_type, status, requested_by, finished_at, stats_json)
       VALUES ('schedule', 'succeeded', 'worker', datetime('now'), ?)`,
    ).run(JSON.stringify({ marketsFound: 50, clustersCreated: 8, candidatesUpserted: 3, matched: 2, pruned: 1 }));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discovery/status",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.lastSuccessfulRun).not.toBeNull();
    expect(body.data.lastSuccessfulRun.status).toBe("succeeded");
    expect(body.data.lastSuccessfulRun.stats.marketsFound).toBe(50);
    // No heartbeat in test → worker is offline
    expect(body.data.workerState).toBe("offline");
  });
});

// ─── Scan trigger ───────────────────────────────────────────────────────

describe("POST /discovery/scan", () => {
  it("enqueues a new run when none active", async () => {
    // Clear any active runs from prior tests
    conn.db.prepare("DELETE FROM discovery_runs WHERE status IN ('queued', 'running')").run();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/scan",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("queued");
    expect(body.data.alreadyActive).toBe(false);
    expect(body.data.runId).toBeGreaterThan(0);
  });

  it("returns existing active run instead of duplicating", async () => {
    const db = conn.db;

    // Clear and seed an active (queued) run
    db.prepare("DELETE FROM discovery_runs WHERE status IN ('queued', 'running')").run();
    db.prepare(
      "INSERT INTO discovery_runs (trigger_type, status, requested_by) VALUES ('manual', 'queued', 'operator')",
    ).run();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/scan",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.alreadyActive).toBe(true);
  });
});

// ─── Runs history ───────────────────────────────────────────────────────

describe("GET /discovery/runs", () => {
  it("returns recent runs, newest first, respects limit", async () => {
    const db = conn.db;

    // Clean existing runs from previous tests
    db.prepare("DELETE FROM discovery_runs").run();

    // Seed 3 runs
    for (const trigger of ["startup", "schedule", "manual"]) {
      db.prepare(
        "INSERT INTO discovery_runs (trigger_type, status, requested_by) VALUES (?, 'succeeded', 'worker')",
      ).run(trigger);
    }

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discovery/runs?limit=2",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    // Newest first (highest id)
    expect(body.data[0].id).toBeGreaterThan(body.data[1].id);
  });
});

// ─── Accept ──────────────────────────────────────────────────────────────

describe("POST /discovery/candidates/:id/accept", () => {
  it("materializes candidate and enqueues rules_reload", async () => {
    const db = conn.db;
    const now = new Date().toISOString();

    // Seed a candidate with status='reviewed'
    db.prepare(
      `INSERT INTO family_candidates
         (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
          primary_category, strategy_profile, slug_pattern, active_market_count,
          cluster_volume_24h, gate_recommendation, status, first_seen_at, last_seen_at,
          reviewed_at)
       VALUES ('cand-accept-1', 'test-accept-key', 'standard', 'daily', 'daily', 'high',
               'crypto', 'scalp', 'bitcoin-above-*', 3, 5000, 'promote', 'reviewed',
               ?, ?, ?)`,
    ).run(now, now, now);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/candidates/cand-accept-1/accept",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("materialized");

    // Verify family_catalog row exists
    const catalog = db
      .prepare("SELECT * FROM family_catalog WHERE family_id = ?")
      .get("cand-accept-1") as Record<string, unknown>;
    expect(catalog).toBeDefined();
    expect(catalog.family_key).toBe("test-accept-key");

    // Verify family_rules row exists with probe-only defaults
    const rules = db
      .prepare("SELECT * FROM family_rules WHERE family_id = ?")
      .get("cand-accept-1") as Record<string, unknown>;
    expect(rules).toBeDefined();
    expect(rules.scale_mode).toBe("disabled");
    expect(rules.entry_mode).toBe("probe-first");

    // Verify family_runtime_state row exists
    const state = db
      .prepare("SELECT * FROM family_runtime_state WHERE family_id = ?")
      .get("cand-accept-1") as Record<string, unknown>;
    expect(state).toBeDefined();
    expect(state.runtime_mode).toBe("active");

    // Verify candidate status updated
    const candidate = db
      .prepare("SELECT * FROM family_candidates WHERE candidate_id = ?")
      .get("cand-accept-1") as Record<string, unknown>;
    expect(candidate.status).toBe("materialized");

    // Verify pending rules_reload command exists
    const cmd = db
      .prepare(
        "SELECT * FROM operator_commands WHERE action = 'rules_reload' AND status = 'pending'",
      )
      .get() as Record<string, unknown>;
    expect(cmd).toBeDefined();

    // Verify family_deployments created for all profiles
    const deps = db
      .prepare("SELECT profile, enabled FROM family_deployments WHERE family_id = 'cand-accept-1' ORDER BY profile")
      .all() as { profile: string; enabled: number }[];
    expect(deps).toHaveLength(3);
    expect(deps.find((d: any) => d.profile === "paper")!.enabled).toBe(1);
    expect(deps.find((d: any) => d.profile === "simulation")!.enabled).toBe(1);
    expect(deps.find((d: any) => d.profile === "live-lite")!.enabled).toBe(0);
  });

  it("returns 409 for rejected candidate", async () => {
    const db = conn.db;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO family_candidates
         (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
          primary_category, strategy_profile, active_market_count,
          cluster_volume_24h, gate_recommendation, status, first_seen_at, last_seen_at)
       VALUES ('cand-rejected', 'test-rejected-key', 'standard', 'daily', 'daily', 'low',
               'crypto', 'scalp', 2, 1000, 'ignore', 'rejected', ?, ?)`,
    ).run(now, now);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/candidates/cand-rejected/accept",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
  });
});

// ─── Evidence endpoint ──────────────────────────────────────────────────

describe("GET /families/:familyId/evidence", () => {
  it("returns probeSubstate and repricingExitCount", async () => {
    const db = conn.db;
    const familyId = "fam-ev-1";
    const now = new Date().toISOString();

    // Seed family catalog
    db.prepare(
      `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
       VALUES (?, 'ev-key', 'crypto', 'standard', 'daily', 'daily', 'scalp')`,
    ).run(familyId);

    // Seed evidence with probe_substate and repricing_exit_count
    db.prepare(
      `INSERT INTO family_evidence
         (family_id, evidence_status, evidence_score, promotion_state,
          local_trade_count, local_market_count, local_realized_pnl_fifo,
          open_tail_cost_usdc, tail_adjusted_pnl, both_sided_eligible,
          heavy_campaign_eligible, probe_substate, repricing_exit_count, updated_at)
       VALUES (?, 'confirmed', 1, 'probe-only', 15, 4, 5.0, 2.0, 3.0, 0, 0,
               'warming-up', 2, ?)`,
    ).run(familyId, now);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/families/${familyId}/evidence`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.probeSubstate).toBe("warming-up");
    expect(body.data.repricingExitCount).toBe(2);
  });

  it("returns promotion blockers array", async () => {
    const db = conn.db;
    const familyId = "fam-ev-blockers";
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
       VALUES (?, 'ev-block-key', 'crypto', 'standard', 'daily', 'daily', 'scalp')`,
    ).run(familyId);

    db.prepare(
      `INSERT INTO family_evidence
         (family_id, evidence_status, evidence_score, promotion_state,
          local_trade_count, local_market_count, local_realized_pnl_fifo,
          open_tail_cost_usdc, tail_adjusted_pnl, both_sided_eligible,
          heavy_campaign_eligible, repricing_exit_count, recycle_score,
          toxicity_penalty, updated_at)
       VALUES (?, 'confirmed', 1, 'probe-only', 25, 6, 10.0, 2.0, 5.0, 0, 0,
               4, 0.7, 0.1, ?)`,
    ).run(familyId, now);

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/families/${familyId}/evidence`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.promotionBlockers).toBeDefined();
    expect(Array.isArray(body.data.promotionBlockers)).toBe(true);
    expect(body.data.promotionBlockers.length).toBe(6);

    // All should pass with these values
    const allPassed = body.data.promotionBlockers.every((b: any) => b.passed);
    expect(allPassed).toBe(true);
  });
});

// ─── Promote ─────────────────────────────────────────────────────────────

describe("POST /actions/family/:id/promote", () => {
  it("approves proposal and enqueues command", async () => {
    const db = conn.db;
    const familyId = "fam-promote-1";
    const now = new Date().toISOString();

    // Seed family
    db.prepare(
      `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
       VALUES (?, 'promote-key', 'crypto', 'standard', 'daily', 'daily', 'scalp')`,
    ).run(familyId);

    // Seed pending proposal
    db.prepare(
      `INSERT INTO promotion_proposals
         (family_id, current_state, proposed_state, reason, scores_snapshot, status, created_at)
       VALUES (?, 'probe-only', 'scaled', 'auto-promo', '{}', 'pending', ?)`,
    ).run(familyId, now);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/actions/family/${familyId}/promote`,
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: { reason: "looks good" },
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.commandId).toBeDefined();
    expect(body.data.proposalId).toBeDefined();

    // Verify proposal status changed to approved
    const proposal = db
      .prepare("SELECT * FROM promotion_proposals WHERE family_id = ? AND status = 'approved'")
      .get(familyId) as Record<string, unknown>;
    expect(proposal).toBeDefined();
    expect(proposal.applied_command_id).toBe(body.data.commandId);

    // Verify command enqueued
    const cmd = db
      .prepare("SELECT * FROM operator_commands WHERE id = ?")
      .get(body.data.commandId) as Record<string, unknown>;
    expect(cmd.action).toBe("family_promote_scaled");
    expect(cmd.target_id).toBe(familyId);
    expect(cmd.status).toBe("pending");
  });

  it("returns 409 when no pending proposal", async () => {
    const db = conn.db;
    const familyId = "fam-no-proposal";

    db.prepare(
      `INSERT INTO family_catalog
         (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
       VALUES (?, 'no-prop-key', 'crypto', 'standard', 'daily', 'daily', 'scalp')`,
    ).run(familyId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/actions/family/${familyId}/promote`,
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NO_PENDING_PROPOSAL");
  });

  it("returns 404 for unknown family", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/actions/family/nonexistent/promote",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── Candidates pagination ──────────────────────────────────────────────

function seedCandidate(
  db: ReturnType<typeof bootstrapDatabase>["db"],
  id: string,
  recurrence: number,
  viability: number,
  status = "discovered",
) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO family_candidates
       (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
        primary_category, strategy_profile, active_market_count, cluster_volume_24h,
        recurrence_score, live_viability_score, gate_recommendation, status,
        first_seen_at, last_seen_at, scores_updated_at)
     VALUES (?, ?, 'standard', 'daily', 'daily', 'high', 'crypto', 'scalp',
             3, 5000, ?, ?, 'monitor', ?, ?, ?, ?)`,
  ).run(id, `key-${id}`, recurrence, viability, status, now, now, now); // 8 params for 8 ?-placeholders
}

describe("GET /discovery/candidates pagination", () => {
  it("returns { items, nextCursor } with limit", async () => {
    const db = conn.db;
    db.prepare("DELETE FROM family_candidates").run();

    for (let i = 0; i < 5; i++) {
      seedCandidate(db, `pag-${i}`, 0.5 + i * 0.05, 0.8);
    }

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discovery/candidates?limit=2",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.nextCursor).not.toBeNull();
  });

  it("cursor pagination walks through all candidates without duplicates", async () => {
    const db = conn.db;
    db.prepare("DELETE FROM family_candidates").run();

    // 3 candidates with same score (0.5 * 0.7 = 0.35)
    seedCandidate(db, "tie-a", 0.5, 0.7);
    seedCandidate(db, "tie-b", 0.5, 0.7);
    seedCandidate(db, "tie-c", 0.5, 0.7);
    // 2 with different scores
    seedCandidate(db, "high-1", 0.9, 0.9);
    seedCandidate(db, "low-1", 0.1, 0.1);

    const allIds: string[] = [];
    let nextCursor: string | null = null;

    for (let page = 0; page < 5; page++) {
      const url = nextCursor
        ? `/api/v1/discovery/candidates?limit=2&cursor=${encodeURIComponent(nextCursor)}`
        : "/api/v1/discovery/candidates?limit=2";

      const res = await app.inject({ method: "GET", url, headers: authHeaders() });
      const body = json(res);
      expect(body.ok).toBe(true);
      allIds.push(...body.data.items.map((c: any) => c.candidateId));
      nextCursor = body.data.nextCursor;
      if (!nextCursor) break;
    }

    expect(allIds).toHaveLength(5);
    expect(new Set(allIds).size).toBe(5);
    // Within tied scores, candidateIds should be in ASC order
    const tieIds = allIds.filter((id) => id.startsWith("tie-"));
    expect(tieIds).toEqual([...tieIds].sort());
  });

  it("returns 400 on invalid cursor format", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discovery/candidates?cursor=invalid",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(400);
    const body = json(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("INVALID_CURSOR");
  });

  it("returns 400 on structurally incomplete cursor (missing fields)", async () => {
    // Valid base64 JSON but missing required fields (rr, cr, sc, ls)
    const partial = Buffer.from(JSON.stringify({ sr: 0, id: "x" })).toString("base64");
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/discovery/candidates?cursor=${encodeURIComponent(partial)}`,
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(400);
    expect(json(res).error.code).toBe("INVALID_CURSOR");
  });

  it("multi-criteria sort: status → recommendation → confidence → score", async () => {
    const db = conn.db;
    db.prepare("DELETE FROM family_candidates").run();
    const now = new Date().toISOString();

    // Helper: seed with explicit recommendation, confidence, status
    const seed = (id: string, status: string, rec: string, conf: string, recScore: number, viab: number) => {
      db.prepare(
        `INSERT INTO family_candidates
           (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
            primary_category, strategy_profile, active_market_count, cluster_volume_24h,
            recurrence_score, live_viability_score, gate_recommendation, status,
            first_seen_at, last_seen_at, scores_updated_at)
         VALUES (?, ?, 'standard', 'daily', 'daily', ?, 'crypto', 'scalp',
                 3, 5000, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, `key-${id}`, conf, recScore, viab, rec, status, now, now, now);
    };

    // Mix of statuses, recommendations, confidences
    seed("d-scaled-high", "discovered", "scaled-candidate", "high", 0.9, 0.9); // should be 1st
    seed("d-probe-high", "discovered", "probe-candidate", "high", 0.9, 0.9);   // 2nd
    seed("d-probe-med", "discovered", "probe-candidate", "medium", 0.9, 0.9);  // 3rd
    seed("d-monitor-high", "discovered", "monitor", "high", 0.8, 0.8);         // 4th
    seed("d-pending-high", "discovered", "pending", "high", 0.0, 0.0);         // 5th (pending before ignore)
    seed("d-ignore-high", "discovered", "ignore", "high", 0.5, 0.5);           // 6th
    seed("r-scaled-high", "reviewed", "scaled-candidate", "high", 0.9, 0.9);   // 7th (reviewed after all discovered)

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discovery/candidates?limit=10",
      headers: authHeaders(),
    });
    const body = json(res);
    const ids = body.data.items.map((c: any) => c.candidateId);

    expect(ids[0]).toBe("d-scaled-high");
    expect(ids[1]).toBe("d-probe-high");
    expect(ids[2]).toBe("d-probe-med");
    expect(ids[3]).toBe("d-monitor-high");
    expect(ids[4]).toBe("d-pending-high");
    expect(ids[5]).toBe("d-ignore-high");
    expect(ids[6]).toBe("r-scaled-high");
  });

  it("pending candidates sort between monitor and ignore", async () => {
    const db = conn.db;
    db.prepare("DELETE FROM family_candidates").run();
    const now = new Date().toISOString();

    const seed = (id: string, rec: string) => {
      db.prepare(
        `INSERT INTO family_candidates
           (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
            primary_category, strategy_profile, active_market_count, cluster_volume_24h,
            recurrence_score, live_viability_score, gate_recommendation, status,
            first_seen_at, last_seen_at)
         VALUES (?, ?, 'standard', 'daily', 'daily', 'high', 'crypto', 'scalp',
                 3, 5000, 0.5, 0.5, ?, 'discovered', ?, ?)`,
      ).run(id, `key-${id}`, rec, now, now);
    };

    seed("ignore-1", "ignore");
    seed("pending-1", "pending");
    seed("monitor-1", "monitor");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/discovery/candidates?limit=10",
      headers: authHeaders(),
    });
    const ids = json(res).data.items.map((c: any) => c.candidateId);
    expect(ids).toEqual(["monitor-1", "pending-1", "ignore-1"]);
  });

  it("cursor handles sub-second timestamp differences correctly", async () => {
    const db = conn.db;
    db.prepare("DELETE FROM family_candidates").run();

    // Three candidates: same status/rec/conf/score, different sub-second timestamps
    for (const [id, ts] of [
      ["sub-a", "2026-03-31T12:00:00.100Z"],
      ["sub-b", "2026-03-31T12:00:00.500Z"],
      ["sub-c", "2026-03-31T12:00:00.900Z"],
    ] as const) {
      db.prepare(
        `INSERT INTO family_candidates
           (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
            primary_category, strategy_profile, active_market_count, cluster_volume_24h,
            recurrence_score, live_viability_score, gate_recommendation, status,
            first_seen_at, last_seen_at, scores_updated_at)
         VALUES (?, ?, 'standard', 'daily', 'daily', 'high', 'crypto', 'scalp',
                 3, 5000, 0.5, 0.5, 'monitor', 'discovered', ?, ?, ?)`,
      ).run(id, `key-${id}`, ts, ts, ts);
    }

    // Page 1: get first 2 (sub-c, sub-b — DESC by last_seen_at)
    const res1 = await app.inject({
      method: "GET",
      url: "/api/v1/discovery/candidates?limit=2",
      headers: authHeaders(),
    });
    const body1 = json(res1);
    expect(body1.data.items).toHaveLength(2);
    expect(body1.data.items[0].candidateId).toBe("sub-c");
    expect(body1.data.items[1].candidateId).toBe("sub-b");
    expect(body1.data.nextCursor).not.toBeNull();

    // Page 2: should get sub-a (not skip it)
    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/discovery/candidates?limit=2&cursor=${encodeURIComponent(body1.data.nextCursor)}`,
      headers: authHeaders(),
    });
    const body2 = json(res2);
    expect(body2.data.items).toHaveLength(1);
    expect(body2.data.items[0].candidateId).toBe("sub-a");
    expect(body2.data.nextCursor).toBeNull();
  });

  it("filters work together with cursor", async () => {
    const db = conn.db;
    db.prepare("DELETE FROM family_candidates").run();

    seedCandidate(db, "filt-d1", 0.9, 0.8, "discovered");
    seedCandidate(db, "filt-d2", 0.7, 0.8, "discovered");
    seedCandidate(db, "filt-d3", 0.5, 0.8, "discovered");
    seedCandidate(db, "filt-r1", 0.8, 0.8, "reviewed");
    seedCandidate(db, "filt-r2", 0.6, 0.8, "reviewed");

    // Page 1: reviewed only, limit 1
    const res1 = await app.inject({
      method: "GET",
      url: "/api/v1/discovery/candidates?status=reviewed&limit=1",
      headers: authHeaders(),
    });
    const body1 = json(res1);
    expect(body1.data.items).toHaveLength(1);
    expect(body1.data.items[0].status).toBe("reviewed");
    expect(body1.data.nextCursor).not.toBeNull();

    // Page 2 — last page, no phantom extra page
    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/discovery/candidates?status=reviewed&limit=1&cursor=${encodeURIComponent(body1.data.nextCursor)}`,
      headers: authHeaders(),
    });
    const body2 = json(res2);
    expect(body2.data.items).toHaveLength(1);
    expect(body2.data.items[0].status).toBe("reviewed");
    expect(body2.data.nextCursor).toBeNull();
  });
});
