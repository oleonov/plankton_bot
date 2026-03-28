import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";

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
  app = await buildServer({ config: testConfig(), conn });
});

afterAll(async () => {
  await app.close();
  conn.close();
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
  });

  it("returns 409 for non-reviewed candidate", async () => {
    const db = conn.db;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO family_candidates
         (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
          primary_category, strategy_profile, active_market_count,
          cluster_volume_24h, gate_recommendation, status, first_seen_at, last_seen_at)
       VALUES ('cand-disc-only', 'test-disc-key', 'standard', 'daily', 'daily', 'low',
               'crypto', 'scalp', 2, 1000, 'ignore', 'discovered', ?, ?)`,
    ).run(now, now);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/discovery/candidates/cand-disc-only/accept",
      headers: { ...authHeaders(), "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
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
