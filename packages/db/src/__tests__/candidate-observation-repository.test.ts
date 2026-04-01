import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteCandidateObservationRepository } from "../repositories/candidate-observation-repository.js";
import { SqliteFamilyCandidateRepository } from "../repositories/family-candidate-repository.js";
import type { FamilyCandidate, CandidateObservationMarket } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqliteCandidateObservationRepository;
let candidateRepo: SqliteFamilyCandidateRepository;

function makeCandidate(id: string): FamilyCandidate {
  return {
    candidateId: id,
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
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqliteCandidateObservationRepository(conn.db);
  candidateRepo = new SqliteFamilyCandidateRepository(conn.db);
  // Seed parent candidate for FK
  candidateRepo.upsert(makeCandidate("cand-1"));
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqliteCandidateObservationRepository", () => {
  it("insertObservation + findObservations round-trip", () => {
    repo.insertObservation({
      candidateId: "cand-1",
      activeMarketCount: 5,
      clusterVolume24h: 10000,
      nearestEndDate: "2026-02-01T00:00:00Z",
      observedAt: "2026-01-01T12:00:00Z",
    });

    const obs = repo.findObservations("cand-1", 10);
    expect(obs).toHaveLength(1);
    expect(obs[0]!.candidateId).toBe("cand-1");
    expect(obs[0]!.activeMarketCount).toBe(5);
    expect(obs[0]!.clusterVolume24h).toBe(10000);
    expect(obs[0]!.nearestEndDate).toBe("2026-02-01T00:00:00Z");
    expect(obs[0]!.observedAt).toBe("2026-01-01T12:00:00Z");
  });

  it("findObservations returns newest first with limit", () => {
    for (let i = 1; i <= 5; i++) {
      repo.insertObservation({
        candidateId: "cand-1",
        activeMarketCount: i,
        clusterVolume24h: 1000,
        nearestEndDate: null,
        observedAt: `2026-01-0${i}T00:00:00Z`,
      });
    }

    const obs = repo.findObservations("cand-1", 3);
    expect(obs).toHaveLength(3);
    expect(obs[0]!.observedAt).toBe("2026-01-05T00:00:00Z");
    expect(obs[2]!.observedAt).toBe("2026-01-03T00:00:00Z");
  });

  it("insertMarkets + findMarkets round-trip", () => {
    const markets: CandidateObservationMarket[] = [
      {
        candidateId: "cand-1",
        observedAt: "2026-01-01T12:00:00Z",
        conditionId: "cond-a",
        slug: "will-x-happen",
        endDate: "2026-03-01T00:00:00Z",
        volume24h: 5000,
      },
      {
        candidateId: "cand-1",
        observedAt: "2026-01-01T12:00:00Z",
        conditionId: "cond-b",
        slug: "will-y-happen",
        endDate: null,
        volume24h: null,
      },
    ];
    repo.insertMarkets(markets);

    const found = repo.findMarkets("cand-1", "2026-01-01T12:00:00Z");
    expect(found).toHaveLength(2);
    expect(found[0]!.conditionId).toBe("cond-a");
    expect(found[0]!.volume24h).toBe(5000);
    expect(found[1]!.conditionId).toBe("cond-b");
    expect(found[1]!.volume24h).toBeNull();
  });

  it("insertMarkets handles empty array", () => {
    repo.insertMarkets([]);
    // No error thrown
  });

  it("countDistinctConditions counts unique conditions", () => {
    const ts = "2026-01-01T12:00:00Z";
    repo.insertMarkets([
      {
        candidateId: "cand-1",
        observedAt: ts,
        conditionId: "cond-a",
        slug: "s1",
        endDate: null,
        volume24h: null,
      },
      {
        candidateId: "cand-1",
        observedAt: ts,
        conditionId: "cond-b",
        slug: "s2",
        endDate: null,
        volume24h: null,
      },
    ]);
    // Same condition at different observation time
    repo.insertMarkets([
      {
        candidateId: "cand-1",
        observedAt: "2026-01-02T12:00:00Z",
        conditionId: "cond-a",
        slug: "s1",
        endDate: null,
        volume24h: null,
      },
    ]);

    expect(repo.countDistinctConditions("cand-1")).toBe(2);
  });

  // ─── pruneLowValueTail ─────────────────────────────────────────────

  it("pruneLowValueTail removes old observations for low-value tail candidates", () => {
    // cand-1 is already: discovered, ignore, low=medium → NOT low-value (medium confidence)
    // Create a true low-value tail candidate
    candidateRepo.upsert({ ...makeCandidate("lv-1"), patternConfidence: "low" });
    repo.insertObservation({
      candidateId: "lv-1",
      activeMarketCount: 1,
      clusterVolume24h: 100,
      nearestEndDate: null,
      observedAt: "2026-01-01T00:00:00Z",
    });
    repo.insertMarkets([
      {
        candidateId: "lv-1",
        observedAt: "2026-01-01T00:00:00Z",
        conditionId: "c1",
        slug: "s1",
        endDate: null,
        volume24h: null,
      },
    ]);
    repo.insertObservation({
      candidateId: "lv-1",
      activeMarketCount: 2,
      clusterVolume24h: 200,
      nearestEndDate: null,
      observedAt: "2026-03-30T00:00:00Z",
    });

    const pruned = repo.pruneLowValueTail("2026-03-29T00:00:00Z");
    expect(pruned).toBe(1); // old observation deleted
    expect(repo.findObservations("lv-1", 10)).toHaveLength(1); // recent kept
    expect(repo.findMarkets("lv-1", "2026-01-01T00:00:00Z")).toHaveLength(0); // markets cleaned
  });

  it("pruneLowValueTail does not prune recent observations", () => {
    candidateRepo.upsert({ ...makeCandidate("lv-2"), patternConfidence: "low" });
    repo.insertObservation({
      candidateId: "lv-2",
      activeMarketCount: 1,
      clusterVolume24h: 100,
      nearestEndDate: null,
      observedAt: "2026-03-31T00:00:00Z",
    });

    const pruned = repo.pruneLowValueTail("2026-03-30T00:00:00Z");
    expect(pruned).toBe(0);
    expect(repo.findObservations("lv-2", 10)).toHaveLength(1);
  });

  it("pruneLowValueTail does not prune reviewed candidates", () => {
    candidateRepo.upsert({
      ...makeCandidate("rev-1"),
      patternConfidence: "low",
      status: "reviewed",
    });
    repo.insertObservation({
      candidateId: "rev-1",
      activeMarketCount: 1,
      clusterVolume24h: 100,
      nearestEndDate: null,
      observedAt: "2026-01-01T00:00:00Z",
    });

    const pruned = repo.pruneLowValueTail("2026-03-30T00:00:00Z");
    expect(pruned).toBe(0);
  });

  it("pruneLowValueTail does not prune materialized candidates", () => {
    candidateRepo.upsert({
      ...makeCandidate("mat-1"),
      patternConfidence: "low",
      status: "materialized",
    });
    repo.insertObservation({
      candidateId: "mat-1",
      activeMarketCount: 1,
      clusterVolume24h: 100,
      nearestEndDate: null,
      observedAt: "2026-01-01T00:00:00Z",
    });

    const pruned = repo.pruneLowValueTail("2026-03-30T00:00:00Z");
    expect(pruned).toBe(0);
  });

  it("pruneLowValueTail does not prune matched candidates", () => {
    candidateRepo.upsert({
      ...makeCandidate("match-1"),
      patternConfidence: "low",
      matchedFamilyId: "fam-1" as any,
    });
    repo.insertObservation({
      candidateId: "match-1",
      activeMarketCount: 1,
      clusterVolume24h: 100,
      nearestEndDate: null,
      observedAt: "2026-01-01T00:00:00Z",
    });

    const pruned = repo.pruneLowValueTail("2026-03-30T00:00:00Z");
    expect(pruned).toBe(0);
  });

  it("pruneLowValueTail does not prune medium/high confidence candidates", () => {
    // cand-1 is medium confidence — should be protected
    repo.insertObservation({
      candidateId: "cand-1",
      activeMarketCount: 1,
      clusterVolume24h: 100,
      nearestEndDate: null,
      observedAt: "2026-01-01T00:00:00Z",
    });

    const pruned = repo.pruneLowValueTail("2026-03-30T00:00:00Z");
    expect(pruned).toBe(0);
  });

  // ─── prune (global, existing) ─────────────────────────────────────

  it("prune removes old observations and their markets", () => {
    repo.insertObservation({
      candidateId: "cand-1",
      activeMarketCount: 1,
      clusterVolume24h: 100,
      nearestEndDate: null,
      observedAt: "2026-01-01T00:00:00Z",
    });
    repo.insertMarkets([
      {
        candidateId: "cand-1",
        observedAt: "2026-01-01T00:00:00Z",
        conditionId: "cond-a",
        slug: "s1",
        endDate: null,
        volume24h: null,
      },
    ]);
    repo.insertObservation({
      candidateId: "cand-1",
      activeMarketCount: 2,
      clusterVolume24h: 200,
      nearestEndDate: null,
      observedAt: "2026-01-10T00:00:00Z",
    });

    const pruned = repo.prune("2026-01-05T00:00:00Z");
    expect(pruned).toBe(1);
    expect(repo.findObservations("cand-1", 10)).toHaveLength(1);
    expect(repo.findMarkets("cand-1", "2026-01-01T00:00:00Z")).toHaveLength(0);
  });
});
