import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { createFamilyId, ProfileId as Profiles } from "@plankton/domain";
import type { ProfileId } from "@plankton/domain";
import { bootstrapControlDb, type DbConnection } from "@plankton/db";
import { ControlEvaluator } from "../control-evaluator.js";
import { DISMISSED_PROPOSAL_COOLDOWN_MS } from "../promotion-policy.js";

const PROFILE_SIM = "simulation" as ProfileId;
const PROFILE_PAPER = Profiles.Paper;
const PROFILE_LIVE = Profiles.LiveLite;
const FAMILY_1 = createFamilyId("fam-1");
const CANDIDATE_ID = "cand-fam-1";
const NOW = "2026-03-30T12:00:00.000Z";

const silentLogger = pino({ level: "silent" });

function seedProfile(
  conn: DbConnection,
  profileId: ProfileId = PROFILE_SIM,
  displayName: string = "Simulation",
): void {
  conn.db
    .prepare(
      "INSERT INTO profiles (profile_id, display_name, description, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(profileId, displayName, `${displayName} profile`, NOW);
}

function seedFamily(conn: DbConnection): void {
  conn.db
    .prepare(
      `INSERT INTO family_catalog
     (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(FAMILY_1, "test-family", "crypto", "threshold", "daily", "ad-hoc", "scalp", NOW, NOW);
}

function seedCandidate(conn: DbConnection, matched: boolean = false): void {
  conn.db
    .prepare(
      `INSERT INTO family_candidates
     (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
      primary_category, strategy_profile, active_market_count, cluster_volume_24h,
      status, first_seen_at, last_seen_at, matched_family_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      CANDIDATE_ID,
      "test-family",
      "threshold",
      "daily",
      "ad-hoc",
      "medium",
      "crypto",
      "scalp",
      5,
      30000,
      "discovered",
      NOW,
      NOW,
      matched ? String(FAMILY_1) : null,
    );
}

function seedObservations(conn: DbConnection): void {
  const dates = [
    "2026-03-20T12:00:00.000Z",
    "2026-03-21T12:00:00.000Z",
    "2026-03-23T12:00:00.000Z",
    "2026-03-25T12:00:00.000Z",
    "2026-03-27T12:00:00.000Z",
    "2026-03-29T12:00:00.000Z",
    "2026-03-30T12:00:00.000Z",
  ];
  const insertObs = conn.db.prepare(
    `INSERT INTO candidate_observations
     (candidate_id, active_market_count, cluster_volume_24h, nearest_end_date, observed_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertMarket = conn.db.prepare(
    `INSERT INTO candidate_observation_markets
     (candidate_id, observed_at, condition_id, slug, end_date, volume_24h)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  for (let i = 0; i < dates.length; i++) {
    insertObs.run(CANDIDATE_ID, 3 + i, 25000 + i * 1000, "2026-04-01T00:00:00Z", dates[i]);
    insertMarket.run(
      CANDIDATE_ID,
      dates[i]!,
      `cond-${i}`,
      `slug-${i}`,
      "2026-04-01T00:00:00Z",
      10000 + i * 500,
    );
  }
}

function seedDeployment(
  conn: DbConnection,
  stage: string = "probe-only",
  profile: ProfileId = PROFILE_SIM,
): void {
  conn.db
    .prepare(
      `INSERT INTO family_deployments
     (family_id, profile, enabled, operator_mode, strategy_stage, deployment_stage, priority, created_at, updated_at)
     VALUES (?, ?, 1, 'active', ?, 'live-probe', 1, ?, ?)`,
    )
    .run(FAMILY_1, profile, stage, NOW, NOW);
}

function seedScorecard(
  conn: DbConnection,
  overrides?: Partial<{
    recycleScore: number;
    toxicityPenalty: number;
    tradeCount: number;
    marketCount: number;
    tailAdjustedPnl: number;
    summaryJson: string | null;
  }>,
  profile: ProfileId = PROFILE_SIM,
): string {
  const scorecardId = `sc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const defaults = {
    recycleScore: 0.7,
    toxicityPenalty: 0.1,
    tradeCount: 30,
    marketCount: 8,
    tailAdjustedPnl: 5.0,
    summaryJson: JSON.stringify({
      repricingExits: 3,
      executionTelemetry24h: {
        totalFills: 12,
        volumeUsdc: 25,
        makerFills: 12,
        takerFills: 0,
        unknownFills: 0,
        makerRatio: 1,
        takerRatio: 0,
        explicitFeesUsdc: 0,
        feeLeakageRatio: 0,
        lastFillAt: NOW,
      },
      executionCanary24h: {
        required: true,
        eligible: true,
        minTotalFills: 10,
        blockers: [],
      },
    }),
  };
  const vals = { ...defaults, ...overrides };

  conn.db
    .prepare(
      `INSERT INTO family_validation_scorecards
     (scorecard_id, family_id, profile, evidence_status, evidence_score,
      recurrence_score, recycle_score, live_viability_score, toxicity_penalty,
      trade_count, market_count, realized_pnl, tail_adjusted_pnl,
      both_sided_eligible, heavy_campaign_eligible, summary_json, validated_at)
     VALUES (?, ?, ?, 'confirmed', 0.8, 0.6, ?, 0.5, ?, ?, ?, 10.0, ?, 0, 0, ?, ?)`,
    )
    .run(
      scorecardId,
      FAMILY_1,
      profile,
      vals.recycleScore,
      vals.toxicityPenalty,
      vals.tradeCount,
      vals.marketCount,
      vals.tailAdjustedPnl,
      vals.summaryJson,
      NOW,
    );

  conn.db
    .prepare(
      `INSERT INTO family_validation_latest (family_id, profile, scorecard_id)
     VALUES (?, ?, ?)
     ON CONFLICT(family_id, profile) DO UPDATE SET scorecard_id = excluded.scorecard_id`,
    )
    .run(FAMILY_1, profile, scorecardId);

  return scorecardId;
}

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-eval-"));
  conn = bootstrapControlDb(path.join(tmpDir, "test.db"));
  seedProfile(conn);
  seedFamily(conn);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ControlEvaluator", () => {
  describe("candidate scoring", () => {
    it("scores candidate based on observations", async () => {
      seedCandidate(conn);
      seedObservations(conn);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.run();

      expect(stats.candidatesScored).toBe(1);

      const row = conn.db
        .prepare("SELECT * FROM family_candidates WHERE candidate_id = ?")
        .get(CANDIDATE_ID) as Record<string, unknown>;

      expect(row.recurrence_score).toBeTypeOf("number");
      expect(row.recurrence_score as number).toBeGreaterThan(0);
      expect(row.live_viability_score).toBeTypeOf("number");
      expect(row.live_viability_score as number).toBeGreaterThan(0);
      expect(row.scores_updated_at).not.toBeNull();
      expect(row.gate_recommendation).not.toBe("ignore");
    });

    it("reads recycle score from published scorecard when candidate has matched family", async () => {
      seedCandidate(conn, true);
      seedObservations(conn);
      seedScorecard(conn, { recycleScore: 0.8, tailAdjustedPnl: 10.0 });

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      await evaluator.run();

      const row = conn.db
        .prepare("SELECT * FROM family_candidates WHERE candidate_id = ?")
        .get(CANDIDATE_ID) as Record<string, unknown>;

      expect(row.recycle_score).toBeTypeOf("number");
      expect(row.recycle_score as number).toBeGreaterThan(0);
    });
  });

  describe("promotion evaluation", () => {
    it("creates promotion proposal when scorecard meets thresholds", async () => {
      seedCandidate(conn);
      seedDeployment(conn, "probe-only");
      seedScorecard(conn, {
        recycleScore: 0.7,
        toxicityPenalty: 0.1,
        tradeCount: 30,
        marketCount: 8,
        tailAdjustedPnl: 5.0,
      });

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.run();

      expect(stats.proposalsCreated).toBe(1);

      const proposals = conn.db
        .prepare("SELECT * FROM promotion_proposals WHERE status = 'pending'")
        .all() as Record<string, unknown>[];

      expect(proposals).toHaveLength(1);
      expect(proposals[0]!.family_id).toBe(String(FAMILY_1));
      expect(proposals[0]!.profile).toBe(PROFILE_SIM);
      expect(proposals[0]!.proposed_state).toBe("scaled");
      expect(proposals[0]!.source_scorecard_id).not.toBeNull();
    });

    it("does not create duplicate proposals for same family+profile", async () => {
      seedCandidate(conn);
      seedDeployment(conn, "probe-only");
      seedScorecard(conn, {
        recycleScore: 0.7,
        toxicityPenalty: 0.1,
        tradeCount: 30,
        marketCount: 8,
        tailAdjustedPnl: 5.0,
      });

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });

      const stats1 = await evaluator.run();
      expect(stats1.proposalsCreated).toBe(1);

      const stats2 = await evaluator.run();
      expect(stats2.proposalsCreated).toBe(0);

      const proposals = conn.db
        .prepare("SELECT * FROM promotion_proposals WHERE status = 'pending'")
        .all();
      expect(proposals).toHaveLength(1);
    });

    it("does not propose when scorecard below thresholds", async () => {
      seedCandidate(conn);
      seedDeployment(conn, "probe-only");
      seedScorecard(conn, {
        recycleScore: 0.3,
        toxicityPenalty: 0.5,
        tradeCount: 5,
        marketCount: 2,
        tailAdjustedPnl: -1.0,
      });

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.run();

      expect(stats.proposalsCreated).toBe(0);
    });

    it("still proposes in paper mode when execution canary fails", async () => {
      seedCandidate(conn);
      seedProfile(conn, PROFILE_PAPER, "Paper");
      seedDeployment(conn, "probe-only", PROFILE_PAPER);
      seedScorecard(
        conn,
        {
          summaryJson: JSON.stringify({
            repricingExits: 3,
            executionTelemetry24h: {
              totalFills: 12,
              volumeUsdc: 18,
              makerFills: 10,
              takerFills: 2,
              unknownFills: 0,
              makerRatio: 10 / 12,
              takerRatio: 2 / 12,
              explicitFeesUsdc: 0.1,
              feeLeakageRatio: 0.0055,
              lastFillAt: NOW,
            },
            executionCanary24h: {
              required: true,
              eligible: false,
              minTotalFills: 10,
              blockers: [
                { metric: "Taker fills", current: 2, required: 0, passed: false },
                { metric: "Explicit fees (USDC)", current: 0.1, required: 0, passed: false },
              ],
            },
          }),
        },
        PROFILE_PAPER,
      );

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.run();

      expect(stats.proposalsCreated).toBe(1);
    });

    it("does not propose in live-lite when execution canary fails", async () => {
      seedCandidate(conn);
      seedProfile(conn, PROFILE_LIVE, "Live-Lite");
      seedDeployment(conn, "probe-only", PROFILE_LIVE);
      seedScorecard(
        conn,
        {
          summaryJson: JSON.stringify({
            repricingExits: 3,
            executionTelemetry24h: {
              totalFills: 12,
              volumeUsdc: 18,
              makerFills: 10,
              takerFills: 2,
              unknownFills: 0,
              makerRatio: 10 / 12,
              takerRatio: 2 / 12,
              explicitFeesUsdc: 0.1,
              feeLeakageRatio: 0.0055,
              lastFillAt: NOW,
            },
            executionCanary24h: {
              required: true,
              eligible: false,
              minTotalFills: 10,
              blockers: [
                { metric: "Taker fills", current: 2, required: 0, passed: false },
                { metric: "Explicit fees (USDC)", current: 0.1, required: 0, passed: false },
              ],
            },
          }),
        },
        PROFILE_LIVE,
      );

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.run();

      expect(stats.proposalsCreated).toBe(0);
    });

    it("does not propose for already-scaled deployment", async () => {
      seedCandidate(conn);
      seedDeployment(conn, "scaled");
      seedScorecard(conn);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.run();

      expect(stats.proposalsCreated).toBe(0);
    });

    it("does not propose when no scorecard exists", async () => {
      seedCandidate(conn);
      seedDeployment(conn, "probe-only");

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.run();

      expect(stats.proposalsCreated).toBe(0);
    });

    it("suppresses recently dismissed proposals until cooldown expires", async () => {
      seedProfile(conn, PROFILE_PAPER, "Paper");
      seedDeployment(conn, "probe-only", PROFILE_PAPER);
      seedScorecard(conn, undefined, PROFILE_PAPER);

      const firstRun = new ControlEvaluator({
        db: conn.db,
        log: silentLogger,
        now: () => new Date("2026-03-30T12:00:00.000Z"),
        dismissCooldownMs: DISMISSED_PROPOSAL_COOLDOWN_MS,
      });
      expect((await firstRun.run()).proposalsCreated).toBe(1);

      const proposal = conn.db
        .prepare("SELECT id FROM promotion_proposals WHERE family_id = ? AND profile = ?")
        .get(FAMILY_1, PROFILE_PAPER) as { id: number };
      conn.db
        .prepare(
          `UPDATE promotion_proposals
           SET status = 'dismissed', resolved_at = ?, resolved_by = 'operator'
           WHERE id = ?`,
        )
        .run("2026-03-30T12:05:00.000Z", proposal.id);

      const withinCooldown = new ControlEvaluator({
        db: conn.db,
        log: silentLogger,
        now: () => new Date("2026-03-30T12:30:00.000Z"),
        dismissCooldownMs: DISMISSED_PROPOSAL_COOLDOWN_MS,
      });
      expect((await withinCooldown.run()).proposalsCreated).toBe(0);

      const afterCooldown = new ControlEvaluator({
        db: conn.db,
        log: silentLogger,
        now: () => new Date("2026-03-30T13:10:00.000Z"),
        dismissCooldownMs: DISMISSED_PROPOSAL_COOLDOWN_MS,
      });
      expect((await afterCooldown.run()).proposalsCreated).toBe(1);
    });
  });

  describe("atomicity", () => {
    it("run() writes all scores in a single transaction", async () => {
      seedCandidate(conn);
      conn.db
        .prepare(
          `INSERT INTO family_candidates
         (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
          primary_category, strategy_profile, active_market_count,
          cluster_volume_24h, gate_recommendation, status, first_seen_at, last_seen_at)
         VALUES ('cand-2', 'test-family-2', 'threshold', 'daily', 'ad-hoc', 'high',
                 'crypto', 'scalp', 3, 500, 'pending', 'discovered', ?, ?)`,
        )
        .run(NOW, NOW);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.run();
      expect(stats.candidatesScored).toBe(2);

      const c1 = conn.db
        .prepare("SELECT scores_updated_at FROM family_candidates WHERE candidate_id = ?")
        .get(CANDIDATE_ID) as { scores_updated_at: string | null };
      const c2 = conn.db
        .prepare("SELECT scores_updated_at FROM family_candidates WHERE candidate_id = ?")
        .get("cand-2") as { scores_updated_at: string | null };
      expect(c1.scores_updated_at).not.toBeNull();
      expect(c2.scores_updated_at).not.toBeNull();
    });

    it("rolls back all score updates if write phase fails mid-way", async () => {
      seedCandidate(conn);
      conn.db
        .prepare(
          `INSERT INTO family_candidates
         (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
          primary_category, strategy_profile, active_market_count,
          cluster_volume_24h, gate_recommendation, status, first_seen_at, last_seen_at)
         VALUES ('cand-bomb', 'bomb-family', 'threshold', 'daily', 'ad-hoc', 'high',
                 'crypto', 'scalp', 3, 500, 'pending', 'discovered', ?, ?)`,
        )
        .run(NOW, NOW);

      // Install trigger that explodes on the second updateScores write
      conn.db.exec(`
        CREATE TRIGGER IF NOT EXISTS bomb_on_cand_bomb
        BEFORE UPDATE OF recurrence_score ON family_candidates
        WHEN NEW.candidate_id = 'cand-bomb'
        BEGIN
          SELECT RAISE(ABORT, 'bomb triggered');
        END
      `);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      await expect(evaluator.run()).rejects.toThrow("bomb triggered");

      // Neither candidate should have updated scores — transaction rolled back
      const c1 = conn.db
        .prepare("SELECT scores_updated_at FROM family_candidates WHERE candidate_id = ?")
        .get(CANDIDATE_ID) as { scores_updated_at: string | null };
      const cBomb = conn.db
        .prepare("SELECT scores_updated_at FROM family_candidates WHERE candidate_id = ?")
        .get("cand-bomb") as { scores_updated_at: string | null };
      expect(c1.scores_updated_at).toBeNull();
      expect(cBomb.scores_updated_at).toBeNull();

      // Cleanup trigger
      conn.db.exec("DROP TRIGGER IF EXISTS bomb_on_cand_bomb");
    });
  });

  describe("split cadence", () => {
    it("recomputeScores updates scores without touching proposals", async () => {
      seedCandidate(conn);
      seedObservations(conn);
      seedDeployment(conn);
      seedScorecard(conn);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.recomputeScores();

      expect(stats.candidatesScored).toBe(1);

      const proposalCount = (
        conn.db.prepare("SELECT COUNT(*) AS v FROM promotion_proposals").get() as { v: number }
      ).v;
      expect(proposalCount).toBe(0);
    });

    it("evaluatePromotions creates proposals without rescoring candidates", async () => {
      seedCandidate(conn, true);
      seedObservations(conn);
      seedDeployment(conn);
      seedScorecard(conn);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.evaluatePromotions();

      expect(stats.proposalsCreated).toBeGreaterThanOrEqual(1);

      const cand = conn.db
        .prepare("SELECT scores_updated_at FROM family_candidates WHERE candidate_id = ?")
        .get(CANDIDATE_ID) as { scores_updated_at: string | null };
      expect(cand.scores_updated_at).toBeNull();
    });

    it("recomputeScores and evaluatePromotions use independent locks", async () => {
      // Regression guard: a shared lock would silently drop the rescore
      // call while evaluatePromotions is mid-await on autoAcceptAndPromote.
      seedCandidate(conn, true);
      seedObservations(conn);
      seedDeployment(conn);
      seedScorecard(conn);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      // Force the promoting lock on.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (evaluator as any).promoting = true;
      try {
        const stats = await evaluator.recomputeScores();
        expect(stats.candidatesScored).toBe(1);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (evaluator as any).promoting = false;
      }
    });

    it("getLastRescoreCompletedAt advances only when recomputeScores actually runs", async () => {
      seedCandidate(conn);
      seedObservations(conn);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      expect(evaluator.getLastRescoreCompletedAt()).toBe(0);

      const before = Date.now();
      await evaluator.recomputeScores();
      const afterReal = evaluator.getLastRescoreCompletedAt();
      expect(afterReal).toBeGreaterThanOrEqual(before);

      // Force the rescoring lock and call again — must not advance the
      // timestamp, because no actual recompute happened.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (evaluator as any).rescoring = true;
      try {
        const stats = await evaluator.recomputeScores();
        expect(stats.candidatesScored).toBe(0);
        expect(evaluator.getLastRescoreCompletedAt()).toBe(afterReal);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (evaluator as any).rescoring = false;
      }
    });

    it("recomputeScores does not re-update candidates whose scores are unchanged", async () => {
      seedCandidate(conn);
      seedObservations(conn);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });

      // First pass: scores are written.
      await evaluator.recomputeScores();
      const firstUpdatedAt = (
        conn.db
          .prepare("SELECT scores_updated_at FROM family_candidates WHERE candidate_id = ?")
          .get(CANDIDATE_ID) as { scores_updated_at: string }
      ).scores_updated_at;

      // Second pass with no observation changes: scores_updated_at must
      // not move forward (we skipped the UPDATE).
      await new Promise((r) => setTimeout(r, 5));
      await evaluator.recomputeScores();
      const secondUpdatedAt = (
        conn.db
          .prepare("SELECT scores_updated_at FROM family_candidates WHERE candidate_id = ?")
          .get(CANDIDATE_ID) as { scores_updated_at: string }
      ).scores_updated_at;

      expect(secondUpdatedAt).toBe(firstUpdatedAt);
    });

    it("recomputeScores skips low-value tail (ignore + low + unmatched + discovered)", async () => {
      // Seed: one scorable candidate (default seedCandidate) + one tail candidate.
      seedCandidate(conn);
      seedObservations(conn);
      conn.db
        .prepare(
          `INSERT INTO family_candidates
           (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
            primary_category, strategy_profile, active_market_count, cluster_volume_24h,
            status, first_seen_at, last_seen_at, gate_recommendation, matched_family_id)
           VALUES ('tail-cand', 'tail-key', 'threshold', 'daily', 'ad-hoc', 'low',
                   'crypto', 'scalp', 1, 0, 'discovered', ?, ?, 'ignore', NULL)`,
        )
        .run(NOW, NOW);

      const evaluator = new ControlEvaluator({ db: conn.db, log: silentLogger });
      const stats = await evaluator.recomputeScores();

      // Only the scorable seed candidate is touched; tail is skipped entirely.
      expect(stats.candidatesScored).toBe(1);
      const tailScored = (
        conn.db
          .prepare("SELECT scores_updated_at FROM family_candidates WHERE candidate_id = ?")
          .get("tail-cand") as { scores_updated_at: string | null }
      ).scores_updated_at;
      expect(tailScored).toBeNull();
    });
  });
});
