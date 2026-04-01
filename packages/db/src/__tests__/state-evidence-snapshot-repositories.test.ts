import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteStateTransitionRepository } from "../repositories/state-transition-repository.js";
import { SqliteFamilyEvidenceRepository } from "../repositories/family-evidence-repository.js";
import { SqliteFamilyRulesSnapshotRepository } from "../repositories/family-rules-snapshot-repository.js";
import { createFamilyId } from "@plankton/domain";
import type Database from "better-sqlite3";

let conn: DbConnection;
let tmpDir: string;

function seedCatalogAndEvidence(db: Database.Database, familyId: string): void {
  db.prepare(
    `INSERT INTO family_catalog
       (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(familyId, "test-key", "crypto", "threshold", "daily", "daily", "scalp");

  db.prepare(
    `INSERT INTO family_evidence
       (family_id, evidence_status, evidence_score, promotion_state,
        local_trade_count, local_market_count, local_realized_pnl_fifo,
        open_tail_cost_usdc, tail_adjusted_pnl,
        both_sided_eligible, heavy_campaign_eligible)
     VALUES (?, 'confirmed', 80, 'probe-only', 10, 5, 15.5, 2.0, 13.5, 1, 0)`,
  ).run(familyId);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── StateTransitionRepository ──────────────────────────────────────────────

describe("SqliteStateTransitionRepository", () => {
  let repo: SqliteStateTransitionRepository;

  beforeEach(() => {
    repo = new SqliteStateTransitionRepository(conn.db);
  });

  it("insert + findByEntity round-trip", () => {
    repo.insert({
      entityType: "family",
      entityId: "fam-1",
      fromState: "probe-only",
      toState: "scaled",
      triggerType: "operator",
      initiator: "admin",
      reason: "manual promotion",
      scoresSnapshot: '{"recurrence":0.9}',
    });

    const transitions = repo.findByEntity("family", "fam-1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.entityType).toBe("family");
    expect(transitions[0]!.entityId).toBe("fam-1");
    expect(transitions[0]!.fromState).toBe("probe-only");
    expect(transitions[0]!.toState).toBe("scaled");
    expect(transitions[0]!.triggerType).toBe("operator");
    expect(transitions[0]!.initiator).toBe("admin");
    expect(transitions[0]!.reason).toBe("manual promotion");
    expect(transitions[0]!.scoresSnapshot).toBe('{"recurrence":0.9}');
    expect(transitions[0]!.createdAt).toBeTruthy();
  });

  it("findByEntity filters by type and id", () => {
    repo.insert({
      entityType: "family",
      entityId: "fam-1",
      fromState: "a",
      toState: "b",
      triggerType: "system",
      initiator: null,
      reason: "r1",
      scoresSnapshot: null,
    });
    repo.insert({
      entityType: "candidate",
      entityId: "cand-1",
      fromState: "c",
      toState: "d",
      triggerType: "system",
      initiator: null,
      reason: "r2",
      scoresSnapshot: null,
    });

    expect(repo.findByEntity("family", "fam-1")).toHaveLength(1);
    expect(repo.findByEntity("candidate", "cand-1")).toHaveLength(1);
    expect(repo.findByEntity("family", "cand-1")).toHaveLength(0);
  });

  it("findRecent returns newest first with limit", () => {
    // Use id DESC as tiebreaker since created_at defaults to same second
    for (let i = 0; i < 5; i++) {
      repo.insert({
        entityType: "family",
        entityId: `fam-${i}`,
        fromState: "a",
        toState: "b",
        triggerType: "system",
        initiator: null,
        reason: `reason-${i}`,
        scoresSnapshot: null,
      });
    }

    const recent = repo.findRecent(3);
    expect(recent).toHaveLength(3);
    // Newest by id (autoincrement) since created_at ties
    expect(recent[0]!.entityId).toBe("fam-4");
  });
});

// ─── FamilyEvidenceRepository ───────────────────────────────────────────────

describe("SqliteFamilyEvidenceRepository", () => {
  let repo: SqliteFamilyEvidenceRepository;
  const familyId = createFamilyId("fam-1");

  beforeEach(() => {
    repo = new SqliteFamilyEvidenceRepository(conn.db);
    seedCatalogAndEvidence(conn.db, "fam-1");
  });

  it("getEvidence returns seeded evidence", () => {
    const ev = repo.getEvidence(familyId);
    expect(ev).not.toBeNull();
    expect(ev!.familyId).toBe("fam-1");
    expect(ev!.evidenceStatus).toBe("confirmed");
    expect(ev!.evidenceScore).toBe(80);
    expect(ev!.promotionState).toBe("probe-only");
    expect(ev!.bothSidedEligible).toBe(true);
  });

  it("getEvidence returns null for unknown family", () => {
    expect(repo.getEvidence(createFamilyId("nonexistent"))).toBeNull();
  });

  it("updateScores persists score columns", () => {
    repo.updateScores(familyId, {
      recurrenceScore: 0.8,
      recycleScore: 0.6,
      liveViabilityScore: 0.7,
      toxicityPenalty: 0.1,
      repricingExitCount: 3,
      scoresUpdatedAt: "2026-01-15T00:00:00Z",
    });

    const ev = repo.getEvidence(familyId);
    // Score columns are added by migration 007; verify via raw SQL
    const row = conn.db
      .prepare(
        "SELECT recurrence_score, recycle_score, scores_updated_at FROM family_evidence WHERE family_id = ?",
      )
      .get("fam-1") as Record<string, unknown>;
    expect(row.recurrence_score).toBe(0.8);
    expect(row.recycle_score).toBe(0.6);
    expect(row.scores_updated_at).toBe("2026-01-15T00:00:00Z");
    expect(ev).not.toBeNull();
  });

  it("updatePromotionState changes promotion state", () => {
    repo.updatePromotionState(familyId, "scaled");

    const ev = repo.getEvidence(familyId);
    expect(ev!.promotionState).toBe("scaled");
  });
});

// ─── FamilyRulesSnapshotRepository ──────────────────────────────────────────

describe("SqliteFamilyRulesSnapshotRepository", () => {
  let repo: SqliteFamilyRulesSnapshotRepository;
  const familyId = createFamilyId("fam-1");

  beforeEach(() => {
    repo = new SqliteFamilyRulesSnapshotRepository(conn.db);
    seedCatalogAndEvidence(conn.db, "fam-1");
  });

  it("save + findLatest round-trip", () => {
    repo.save({
      familyId,
      snapshot: '{"rules":"v1"}',
      reason: "pre-promotion",
      capturedAt: "2026-01-01T00:00:00Z",
    });

    const latest = repo.findLatest(familyId);
    expect(latest).not.toBeNull();
    expect(latest!.familyId).toBe("fam-1");
    expect(latest!.snapshot).toBe('{"rules":"v1"}');
    expect(latest!.reason).toBe("pre-promotion");
    expect(latest!.capturedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("findLatest returns most recent snapshot", () => {
    repo.save({
      familyId,
      snapshot: '{"version":1}',
      reason: "first",
      capturedAt: "2026-01-01T00:00:00Z",
    });
    repo.save({
      familyId,
      snapshot: '{"version":2}',
      reason: "second",
      capturedAt: "2026-01-02T00:00:00Z",
    });

    const latest = repo.findLatest(familyId);
    expect(latest!.reason).toBe("second");
    expect(latest!.snapshot).toBe('{"version":2}');
  });

  it("findLatest returns null for unknown family", () => {
    expect(repo.findLatest(createFamilyId("nonexistent"))).toBeNull();
  });
});
