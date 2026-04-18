import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrapControlDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { createScorecardId } from "@plankton/domain";
import type { ValidationScorecard } from "@plankton/domain";
import type { ProfileId } from "@plankton/domain";
import { SqliteValidationScorecardRepository } from "../repositories/validation-scorecard-repository.js";

const PROFILE = "simulation" as ProfileId;
const NOW = "2026-03-31T10:00:00.000Z";

function makeScorecard(scorecardId: string, evidenceScore = 80): ValidationScorecard {
  return {
    scorecardId: createScorecardId(scorecardId),
    profile: PROFILE,
    evidenceStatus: "confirmed",
    evidenceScore,
    recurrenceScore: 0.8,
    recycleScore: 0.6,
    liveViabilityScore: null,
    toxicityPenalty: null,
    tradeCount: 40,
    marketCount: 8,
    realizedPnl: 100.0,
    tailAdjustedPnl: 90.0,
    bothSidedEligible: true,
    heavyCampaignEligible: false,
    activeWindowEdgeScore: null,
    summaryJson: null,
    validatedAt: NOW,
  };
}

let conn: DbConnection;

beforeEach(() => {
  conn = bootstrapControlDb(":memory:");
  conn.db
    .prepare(
      "INSERT OR IGNORE INTO profiles (profile_id, display_name, created_at) VALUES (?, ?, ?)",
    )
    .run(PROFILE, "Simulation", NOW);
});

afterEach(() => {
  conn.db.close();
});

describe("SqliteValidationScorecardRepository atomicity", () => {
  it("save() writes scorecard row", () => {
    const repo = new SqliteValidationScorecardRepository(conn.db);
    const scorecard = makeScorecard("sc-atom-1");

    repo.save(scorecard);

    const inScorecard = conn.db
      .prepare("SELECT scorecard_id FROM family_validation_scorecards WHERE scorecard_id = ?")
      .get(scorecard.scorecardId) as { scorecard_id: string } | undefined;
    expect(inScorecard?.scorecard_id).toBe("sc-atom-1");
  });

  it("save() with same scorecard_id updates existing row", () => {
    const repo = new SqliteValidationScorecardRepository(conn.db);
    const original = makeScorecard("sc-atom-2", 70);
    repo.save(original);

    const updated = makeScorecard("sc-atom-2", 95);
    repo.save(updated);

    const scorecardCount = conn.db
      .prepare("SELECT COUNT(*) as c FROM family_validation_scorecards WHERE scorecard_id = ?")
      .get("sc-atom-2") as { c: number };
    expect(scorecardCount.c).toBe(1);

    const row = conn.db
      .prepare("SELECT evidence_score FROM family_validation_scorecards WHERE scorecard_id = ?")
      .get("sc-atom-2") as { evidence_score: number } | undefined;
    expect(row?.evidence_score).toBe(95);
  });

  it("save() with new scorecard_id creates additional row", () => {
    const repo = new SqliteValidationScorecardRepository(conn.db);
    repo.save(makeScorecard("sc-atom-3a"));
    repo.save({ ...makeScorecard("sc-atom-3b", 95), validatedAt: "2026-03-31T11:00:00.000Z" });

    const allScorecards = conn.db
      .prepare("SELECT scorecard_id FROM family_validation_scorecards")
      .all() as { scorecard_id: string }[];
    expect(allScorecards).toHaveLength(2);
  });
});
