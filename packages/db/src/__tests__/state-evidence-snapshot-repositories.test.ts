import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import { SqliteStateTransitionRepository } from "../repositories/state-transition-repository.js";

let conn: DbConnection;
let tmpDir: string;

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
      profile: "paper",
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
    expect(transitions[0]!.profile).toBe("paper");
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
      profile: "paper",
      fromState: "a",
      toState: "b",
      triggerType: "system",
      initiator: null,
      reason: "r1",
      scoresSnapshot: null,
    });
    repo.insert({
      entityType: "deployment",
      entityId: "dep-1",
      profile: null,
      fromState: "c",
      toState: "d",
      triggerType: "system",
      initiator: null,
      reason: "r2",
      scoresSnapshot: null,
    });

    expect(repo.findByEntity("family", "fam-1")).toHaveLength(1);
    expect(repo.findByEntity("deployment", "dep-1")).toHaveLength(1);
    expect(repo.findByEntity("family", "dep-1")).toHaveLength(0);
  });

  it("findRecent returns newest first with limit", () => {
    // Use id DESC as tiebreaker since created_at defaults to same second
    for (let i = 0; i < 5; i++) {
      repo.insert({
        entityType: "family",
        entityId: `fam-${i}`,
        profile: "paper",
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

  it("findLastTransitionTo can scope by profile", () => {
    repo.insert({
      entityType: "family",
      entityId: "fam-1",
      profile: "paper",
      fromState: "probe-only",
      toState: "reduce-only",
      triggerType: "system",
      initiator: "paper-worker",
      reason: "paper demotion",
      scoresSnapshot: null,
    });
    repo.insert({
      entityType: "family",
      entityId: "fam-1",
      profile: "live-lite",
      fromState: "scaled",
      toState: "reduce-only",
      triggerType: "system",
      initiator: "live-worker",
      reason: "live demotion",
      scoresSnapshot: null,
    });

    const paperTransition = repo.findLastTransitionTo("fam-1", "reduce-only", "paper");
    const liveTransition = repo.findLastTransitionTo("fam-1", "reduce-only", "live-lite");

    expect(paperTransition?.initiator).toBe("paper-worker");
    expect(liveTransition?.initiator).toBe("live-worker");
  });

  it("findLastTransitionTo falls back to legacy NULL-profile row when scoped row is absent", () => {
    conn.db.exec(`
      INSERT INTO state_transitions (
        entity_type, entity_id, profile, from_state, to_state, trigger_type, initiator, reason
      ) VALUES (
        'family', 'fam-legacy', NULL, 'probe-only', 'reduce-only', 'system', 'legacy-worker', 'legacy demotion'
      )
    `);

    const transition = repo.findLastTransitionTo("fam-legacy", "reduce-only", "live-lite");

    expect(transition?.initiator).toBe("legacy-worker");
    expect(transition?.profile).toBeNull();
  });

  it("findLastTransitionTo prefers scoped row over legacy NULL-profile row", () => {
    conn.db.exec(`
      INSERT INTO state_transitions (
        entity_type, entity_id, profile, from_state, to_state, trigger_type, initiator, reason
      ) VALUES
        ('family', 'fam-prefer', NULL, 'probe-only', 'reduce-only', 'system', 'legacy-worker', 'legacy demotion'),
        ('family', 'fam-prefer', 'live-lite', 'probe-only', 'reduce-only', 'system', 'live-worker', 'live demotion')
    `);

    const transition = repo.findLastTransitionTo("fam-prefer", "reduce-only", "live-lite");

    expect(transition?.initiator).toBe("live-worker");
    expect(transition?.profile).toBe("live-lite");
  });
});
