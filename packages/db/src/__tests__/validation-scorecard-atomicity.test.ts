import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrapControlDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { createFamilyId, createScorecardId } from "@plankton/domain";
import type { ValidationScorecard } from "@plankton/domain";
import type { ProfileId } from "@plankton/domain";
import { SqliteValidationScorecardRepository } from "../repositories/validation-scorecard-repository.js";

const PROFILE = "simulation" as ProfileId;
const FAMILY = createFamilyId("fam-atomicity");
const NOW = "2026-03-31T10:00:00.000Z";

function makeScorecard(scorecardId: string, evidenceScore = 80): ValidationScorecard {
  return {
    scorecardId: createScorecardId(scorecardId),
    familyId: FAMILY,
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
    .prepare("INSERT OR IGNORE INTO profiles (profile_id, display_name, created_at) VALUES (?, ?, ?)")
    .run(PROFILE, "Simulation", NOW);
  conn.db
    .prepare(
      `INSERT INTO family_catalog
     (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(FAMILY, "atomicity-family", "crypto", "threshold", "daily", "ad-hoc", "scalp", NOW, NOW);
});

afterEach(() => {
  conn.db.close();
});

describe("SqliteValidationScorecardRepository atomicity", () => {
  it("save() writes to both scorecards and latest tables", () => {
    const repo = new SqliteValidationScorecardRepository(conn.db);
    const scorecard = makeScorecard("sc-atom-1");

    repo.save(scorecard);

    const inScorecard = conn.db
      .prepare("SELECT scorecard_id FROM family_validation_scorecards WHERE scorecard_id = ?")
      .get(scorecard.scorecardId) as { scorecard_id: string } | undefined;
    expect(inScorecard?.scorecard_id).toBe("sc-atom-1");

    const inLatest = conn.db
      .prepare(
        "SELECT scorecard_id FROM family_validation_latest WHERE family_id = ? AND profile = ?",
      )
      .get(FAMILY, PROFILE) as { scorecard_id: string } | undefined;
    expect(inLatest?.scorecard_id).toBe("sc-atom-1");
  });

  it("save() with same scorecard_id updates scorecard and keeps latest pointer current", () => {
    const repo = new SqliteValidationScorecardRepository(conn.db);
    const original = makeScorecard("sc-atom-2", 70);
    repo.save(original);

    const updated = makeScorecard("sc-atom-2", 95);
    repo.save(updated);

    const found = repo.findLatest(FAMILY, PROFILE);
    expect(found?.scorecardId).toBe("sc-atom-2");
    expect(found?.evidenceScore).toBe(95);

    const scorecardCount = conn.db
      .prepare("SELECT COUNT(*) as c FROM family_validation_scorecards WHERE scorecard_id = ?")
      .get("sc-atom-2") as { c: number };
    expect(scorecardCount.c).toBe(1);
  });

  it("save() with new scorecard_id advances the latest pointer", () => {
    const repo = new SqliteValidationScorecardRepository(conn.db);
    repo.save(makeScorecard("sc-atom-3a"));
    repo.save({ ...makeScorecard("sc-atom-3b", 95), validatedAt: "2026-03-31T11:00:00.000Z" });

    const inLatest = conn.db
      .prepare(
        "SELECT scorecard_id FROM family_validation_latest WHERE family_id = ? AND profile = ?",
      )
      .get(FAMILY, PROFILE) as { scorecard_id: string } | undefined;
    expect(inLatest?.scorecard_id).toBe("sc-atom-3b");

    const allScorecards = conn.db
      .prepare("SELECT scorecard_id FROM family_validation_scorecards WHERE family_id = ?")
      .all(FAMILY) as { scorecard_id: string }[];
    expect(allScorecards).toHaveLength(2);
  });
});
