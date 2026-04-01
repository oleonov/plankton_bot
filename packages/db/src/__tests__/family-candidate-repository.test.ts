import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteFamilyCandidateRepository } from "../repositories/family-candidate-repository.js";
import type { FamilyCandidate } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteFamilyCandidateRepository;

function makeCandidate(overrides?: Partial<FamilyCandidate>): FamilyCandidate {
  return {
    candidateId: "cand-1",
    familyKey: "test-key",
    regime: "threshold",
    horizon: "daily",
    cadence: "daily",
    patternConfidence: "medium",
    primaryCategory: "crypto",
    strategyProfile: "scalp",
    slugPattern: null,
    matchedFamilyId: null,
    activeMarketCount: 3,
    nearestEndDate: null,
    clusterVolume24h: 5000,
    recurrenceScore: null,
    recycleScore: null,
    liveViabilityScore: null,
    toxicityPenalty: null,
    gateRecommendation: "ignore",
    recommendationReason: null,
    scoresUpdatedAt: null,
    status: "discovered",
    firstSeenAt: "2026-01-01T00:00:00Z",
    lastSeenAt: "2026-01-01T00:00:00Z",
    reviewedAt: null,
    materializedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteFamilyCandidateRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteFamilyCandidateRepository", () => {
  it("upsert + findById round-trip", () => {
    repo.upsert(makeCandidate());

    const found = repo.findById("cand-1");
    expect(found).not.toBeNull();
    expect(found!.candidateId).toBe("cand-1");
    expect(found!.familyKey).toBe("test-key");
    expect(found!.regime).toBe("threshold");
    expect(found!.activeMarketCount).toBe(3);
    expect(found!.clusterVolume24h).toBe(5000);
    expect(found!.status).toBe("discovered");
    expect(found!.slugPattern).toBeNull();
    expect(found!.recurrenceScore).toBeNull();
  });

  it("upsert updates existing candidate", () => {
    repo.upsert(makeCandidate({ activeMarketCount: 1 }));
    repo.upsert(makeCandidate({ activeMarketCount: 5 }));

    const all = repo.findAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.activeMarketCount).toBe(5);
  });

  it("findAll returns all candidates", () => {
    repo.upsert(makeCandidate({ candidateId: "cand-1" }));
    repo.upsert(makeCandidate({ candidateId: "cand-2", familyKey: "key-2" }));

    expect(repo.findAll()).toHaveLength(2);
  });

  it("findByStatus filters correctly", () => {
    repo.upsert(makeCandidate({ candidateId: "cand-1", status: "discovered" }));
    repo.upsert(makeCandidate({ candidateId: "cand-2", status: "scored" }));
    repo.upsert(makeCandidate({ candidateId: "cand-3", status: "discovered" }));

    expect(repo.findByStatus("discovered")).toHaveLength(2);
    expect(repo.findByStatus("scored")).toHaveLength(1);
    expect(repo.findByStatus("nonexistent")).toHaveLength(0);
  });

  it("updateStatus changes status", () => {
    repo.upsert(makeCandidate());
    repo.updateStatus("cand-1", "scored");

    const found = repo.findById("cand-1");
    expect(found!.status).toBe("scored");
  });

  it("updateScores persists score fields", () => {
    repo.upsert(makeCandidate());
    repo.updateScores("cand-1", {
      recurrenceScore: 0.8,
      recycleScore: 0.6,
      liveViabilityScore: 0.7,
      toxicityPenalty: 0.1,
      gateRecommendation: "promote",
      recommendationReason: "strong recurrence",
      scoresUpdatedAt: "2026-01-02T00:00:00Z",
    });

    const found = repo.findById("cand-1");
    expect(found!.recurrenceScore).toBe(0.8);
    expect(found!.recycleScore).toBe(0.6);
    expect(found!.liveViabilityScore).toBe(0.7);
    expect(found!.toxicityPenalty).toBe(0.1);
    expect(found!.gateRecommendation).toBe("promote");
    expect(found!.recommendationReason).toBe("strong recurrence");
    expect(found!.scoresUpdatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("findById returns null for unknown candidate", () => {
    expect(repo.findById("nonexistent")).toBeNull();
  });

  it("findAll returns empty array on empty table", () => {
    expect(repo.findAll()).toHaveLength(0);
  });

  // ─── deleteStaleLowValueTail ────────────────────────────────────────

  describe("deleteStaleLowValueTail", () => {
    const lowValueTail = (id: string, lastSeenAt: string) =>
      makeCandidate({
        candidateId: id,
        status: "discovered",
        gateRecommendation: "ignore",
        patternConfidence: "low",
        matchedFamilyId: null,
        lastSeenAt,
      });

    it("deletes stale low-value tail candidates", () => {
      repo.upsert(lowValueTail("stale-1", "2026-01-01T00:00:00Z"));
      const deleted = repo.deleteStaleLowValueTail("2026-03-28T00:00:00Z");
      expect(deleted).toBe(1);
      expect(repo.findById("stale-1")).toBeNull();
    });

    it("does not delete recent low-value tail candidates", () => {
      repo.upsert(lowValueTail("recent-1", "2026-03-30T00:00:00Z"));
      const deleted = repo.deleteStaleLowValueTail("2026-03-28T00:00:00Z");
      expect(deleted).toBe(0);
      expect(repo.findById("recent-1")).not.toBeNull();
    });

    it("does not delete reviewed candidates even if old", () => {
      repo.upsert({ ...lowValueTail("rev-1", "2026-01-01T00:00:00Z"), status: "reviewed" });
      const deleted = repo.deleteStaleLowValueTail("2026-03-28T00:00:00Z");
      expect(deleted).toBe(0);
    });

    it("does not delete materialized candidates even if old", () => {
      repo.upsert({ ...lowValueTail("mat-1", "2026-01-01T00:00:00Z"), status: "materialized" });
      const deleted = repo.deleteStaleLowValueTail("2026-03-28T00:00:00Z");
      expect(deleted).toBe(0);
    });

    it("does not delete matched candidates even if old", () => {
      repo.upsert({
        ...lowValueTail("match-1", "2026-01-01T00:00:00Z"),
        matchedFamilyId: "fam-1" as any,
      });
      const deleted = repo.deleteStaleLowValueTail("2026-03-28T00:00:00Z");
      expect(deleted).toBe(0);
    });

    it("does not delete medium/high confidence candidates", () => {
      repo.upsert({
        ...lowValueTail("med-1", "2026-01-01T00:00:00Z"),
        patternConfidence: "medium",
      });
      const deleted = repo.deleteStaleLowValueTail("2026-03-28T00:00:00Z");
      expect(deleted).toBe(0);
    });

    it("does not delete candidates with non-ignore recommendation", () => {
      repo.upsert({
        ...lowValueTail("green-1", "2026-01-01T00:00:00Z"),
        gateRecommendation: "green",
      });
      const deleted = repo.deleteStaleLowValueTail("2026-03-28T00:00:00Z");
      expect(deleted).toBe(0);
    });

    it("does not delete candidate with pending proposal", () => {
      repo.upsert(lowValueTail("prop-1", "2026-01-01T00:00:00Z"));
      // Insert a pending proposal referencing the candidate_id as family_id
      conn.db
        .prepare(
          `INSERT INTO promotion_proposals (family_id, current_state, proposed_state, reason, scores_snapshot, status)
         VALUES ('prop-1', 'probe-only', 'scaled', 'test', '{}', 'pending')`,
        )
        .run();
      const deleted = repo.deleteStaleLowValueTail("2026-03-28T00:00:00Z");
      expect(deleted).toBe(0);
    });
  });
});
