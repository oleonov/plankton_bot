import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqlitePromotionProposalRepository } from "../repositories/promotion-proposal-repository.js";
import { createFamilyId, ProfileId } from "@plankton/domain";

let conn: DbConnection;
let tmpDir: string;
let repo: SqlitePromotionProposalRepository;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  repo = new SqlitePromotionProposalRepository(conn.db);
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("SqlitePromotionProposalRepository", () => {
  const familyId = createFamilyId("fam-1");

  it("insert + findPending round-trip", () => {
    const id = repo.insert({
      familyId,
      currentState: "probe-only",
      proposedState: "scaled",
      reason: "strong recurrence",
      scoresSnapshot: '{"recurrence":0.8}',
      profile: null,
      sourceScorecardId: null,
    });

    expect(id).toBe(1);
    const pending = repo.findPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.familyId).toBe("fam-1");
    expect(pending[0]!.currentState).toBe("probe-only");
    expect(pending[0]!.proposedState).toBe("scaled");
    expect(pending[0]!.reason).toBe("strong recurrence");
    expect(pending[0]!.status).toBe("pending");
    expect(pending[0]!.resolvedAt).toBeNull();
    expect(pending[0]!.resolvedBy).toBeNull();
  });

  it("findByFamily returns proposals for specific family", () => {
    repo.insert({
      familyId,
      currentState: "probe-only",
      proposedState: "scaled",
      reason: "reason-1",
      scoresSnapshot: "{}",
      profile: null,
      sourceScorecardId: null,
    });
    repo.insert({
      familyId: createFamilyId("fam-2"),
      currentState: "probe-only",
      proposedState: "scaled",
      reason: "reason-2",
      scoresSnapshot: "{}",
      profile: null,
      sourceScorecardId: null,
    });

    const proposals = repo.findByFamily(familyId);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.reason).toBe("reason-1");
  });

  it("hasPending returns true when pending exists", () => {
    repo.insert({
      familyId,
      currentState: "probe-only",
      proposedState: "scaled",
      reason: "test",
      scoresSnapshot: "{}",
      profile: null,
      sourceScorecardId: null,
    });

    expect(repo.hasPending(familyId)).toBe(true);
    expect(repo.hasPending(createFamilyId("fam-2"))).toBe(false);
  });

  it("resolve marks proposal as approved", () => {
    const id = repo.insert({
      familyId,
      currentState: "probe-only",
      proposedState: "scaled",
      reason: "test",
      scoresSnapshot: "{}",
      profile: null,
      sourceScorecardId: null,
    });

    repo.resolve(id, "approved", "operator");

    const pending = repo.findPending();
    expect(pending).toHaveLength(0);

    const proposals = repo.findByFamily(familyId);
    expect(proposals[0]!.status).toBe("approved");
    expect(proposals[0]!.resolvedBy).toBe("operator");
    expect(proposals[0]!.resolvedAt).not.toBeNull();
  });

  it("hasPending returns false after resolution", () => {
    const id = repo.insert({
      familyId,
      currentState: "probe-only",
      proposedState: "scaled",
      reason: "test",
      scoresSnapshot: "{}",
      profile: null,
      sourceScorecardId: null,
    });
    repo.resolve(id, "rejected", "operator");

    expect(repo.hasPending(familyId)).toBe(false);
  });

  it("partial unique index enforces max one pending per family", () => {
    repo.insert({
      familyId,
      currentState: "probe-only",
      proposedState: "scaled",
      reason: "first",
      scoresSnapshot: "{}",
      profile: null,
      sourceScorecardId: null,
    });

    expect(() =>
      repo.insert({
        familyId,
        currentState: "probe-only",
        proposedState: "scaled",
        reason: "second",
        scoresSnapshot: "{}",
        profile: null,
        sourceScorecardId: null,
      }),
    ).toThrow();
  });

  it("allows new pending after previous is resolved", () => {
    const id = repo.insert({
      familyId,
      currentState: "probe-only",
      proposedState: "scaled",
      reason: "first",
      scoresSnapshot: "{}",
      profile: null,
      sourceScorecardId: null,
    });
    repo.resolve(id, "approved", "operator");

    // Second pending should succeed
    const id2 = repo.insert({
      familyId,
      currentState: "scaled",
      proposedState: "restricted",
      reason: "second",
      scoresSnapshot: "{}",
      profile: null,
      sourceScorecardId: null,
    });
    expect(id2).toBe(2);
  });

  it("tracks recent dismissals within a cutoff window", () => {
    const id = repo.insert({
      familyId,
      currentState: "probe-only",
      proposedState: "scaled",
      reason: "dismiss me",
      scoresSnapshot: "{}",
      profile: ProfileId.Paper,
      sourceScorecardId: null,
    });

    conn.db
      .prepare(
        `UPDATE promotion_proposals
         SET status = 'dismissed', resolved_at = ?, resolved_by = 'operator'
         WHERE id = ?`,
      )
      .run("2026-04-03T00:00:00.000Z", id);

    expect(repo.hasDismissedSince(familyId, "2026-04-02T23:00:00.000Z", ProfileId.Paper)).toBe(
      true,
    );
    expect(repo.hasDismissedSince(familyId, "2026-04-03T00:30:00.000Z", ProfileId.Paper)).toBe(
      false,
    );
    expect(repo.hasDismissedSince(familyId, "2026-04-02T23:00:00.000Z", ProfileId.LiveLite)).toBe(
      false,
    );
  });
});
