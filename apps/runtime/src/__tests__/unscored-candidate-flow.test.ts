import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessEventBus } from "@plankton/event-bus";
import { bootstrapDatabase, SqliteFamilyEvidenceRepository } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import { createFamilyId } from "@plankton/domain";
import type { FamilyRulesProvider } from "@plankton/domain";
import { FamilyEvidenceEngine } from "../modules/evidence/evidence-engine.js";
import type { ScoreComputer } from "../modules/evidence/score-computer.js";

const FAM_ID = createFamilyId("fam-deployed-1");

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
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-evidence-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  vi.useRealTimers();
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Evidence engine deployed family scoring", () => {
  it("scores deployed families and writes to family_evidence", async () => {
    const evidenceRepo = new SqliteFamilyEvidenceRepository(conn.db);
    const bus = new InProcessEventBus();

    // Seed FK parent and family_evidence row
    conn.db
      .prepare("INSERT INTO family_catalog (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(String(FAM_ID), "deployed-fam", "crypto", "threshold", "daily", "daily", "scalp");
    conn.db
      .prepare("INSERT INTO family_evidence (family_id) VALUES (?)")
      .run(String(FAM_ID));

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
      getAllFamilies: vi.fn().mockReturnValue([
        {
          familyId: FAM_ID,
          familyKey: "deployed-fam",
          primaryCategory: "crypto",
          regime: "threshold",
          horizon: "daily",
          cadence: "daily",
          strategyProfile: "scalp",
          topicKey: null,
          slugPattern: null,
          notes: null,
        },
      ]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const engine = new FamilyEvidenceEngine({
      bus,
      log: silentLog,
      scoreComputer: mockSc,
      evidenceRepo,
      rulesProvider,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    // After start(), recompute should have scored the deployed family
    const evidence = evidenceRepo.getEvidence(FAM_ID);
    expect(evidence).not.toBeNull();
    expect(evidence!.recycleScore).not.toBeNull();
    expect(evidence!.toxicityPenalty).not.toBeNull();

    await engine.stop();
  });
});
