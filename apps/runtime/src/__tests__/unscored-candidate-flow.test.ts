import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  bootstrapDatabase,
  SqliteFamilyCandidateRepository,
  SqliteFamilyEvidenceRepository,
  SqlitePromotionProposalRepository,
  SqliteOperatorCommandRepository,
  SqliteStateTransitionRepository,
  SqliteFamilyStateRepository,
} from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { FamilyRulesProvider } from "@plankton/domain";
import { FamilyEvidenceEngine } from "../modules/evidence/evidence-engine.js";
import type { ScoreComputer } from "../modules/evidence/score-computer.js";

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  vi.useFakeTimers();
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-unscored-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  vi.useRealTimers();
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Unscored candidate quick-check flow", () => {
  it("seeds unscored candidate, runs quick-check, verifies scores set", async () => {
    const candidateRepo = new SqliteFamilyCandidateRepository(conn.db);
    const evidenceRepo = new SqliteFamilyEvidenceRepository(conn.db);
    const proposalRepo = new SqlitePromotionProposalRepository(conn.db);
    const commandRepo = new SqliteOperatorCommandRepository(conn.db);
    const transitionRepo = new SqliteStateTransitionRepository(conn.db);
    const familyStateRepo = new SqliteFamilyStateRepository(conn.db);
    const bus = new InProcessEventBus();

    // Seed an unscored candidate (no scoresUpdatedAt)
    candidateRepo.upsert({
      candidateId: "cand-unscored-1",
      familyKey: "unscored-key",
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
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      reviewedAt: null,
      materializedAt: null,
    });

    // Verify it's unscored
    const unscored = candidateRepo.findUnscored();
    expect(unscored).toHaveLength(1);

    const mockSc: ScoreComputer = {
      computeRecurrenceMetrics: vi.fn().mockReturnValue({
        spanDays: 10,
        presenceDays: 8,
        totalDays: 10,
        cadenceMean: 1.2,
        cadenceStddev: 0.2,
        distinctConditions: 5,
      }),
      computeRecycleMetrics: vi.fn().mockReturnValue({
        tradeCount: 10,
        distinctMarkets: 3,
        tailAdjustedPnl: 5,
        repricingExits: 1,
        totalNonSettlementClosed: 3,
      }),
      computeLiveViabilityMetrics: vi.fn().mockReturnValue({
        activeMarketCount: 3,
        healthyEndDateFraction: 0.7,
        clusterVolume24h: 5000,
      }),
      computeToxicityMetrics: vi.fn().mockReturnValue({
        dustCount: 0,
        positionCount: 1,
        tailCostUsdc: 1,
        realizedPnlUsdc: 5,
        reduceOnlyCount: 0,
        weeksDeployed: 2,
        staleCount: 0,
        totalOpen: 1,
      }),
    } as any;

    const rulesProvider: FamilyRulesProvider = {
      getRule: vi.fn().mockReturnValue(null),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const engine = new FamilyEvidenceEngine({
      bus,
      log: silentLog,
      scoreComputer: mockSc,
      candidateRepo,
      evidenceRepo,
      proposalRepo,
      commandRepo,
      stateTransitionRepo: transitionRepo,
      familyStateRepo,
      rulesProvider,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    // After start(), recompute should have scored the candidate
    const updated = candidateRepo.findById("cand-unscored-1");
    expect(updated!.scoresUpdatedAt).not.toBeNull();
    expect(updated!.recurrenceScore).not.toBeNull();
    expect(updated!.liveViabilityScore).not.toBeNull();

    // No more unscored
    expect(candidateRepo.findUnscored()).toHaveLength(0);

    await engine.stop();
  });
});
