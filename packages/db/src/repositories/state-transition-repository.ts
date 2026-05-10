import type Database from "better-sqlite3";
import type { StateTransitionRepository, StateTransition, ProfileId } from "@krabs/domain";

interface TransitionRow {
  id: number;
  entity_type: string;
  entity_id: string;
  profile: ProfileId | null;
  from_state: string;
  to_state: string;
  trigger_type: string;
  initiator: string | null;
  reason: string;
  scores_snapshot: string | null;
  created_at: string;
}

function rowToTransition(row: TransitionRow): StateTransition {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    profile: row.profile,
    fromState: row.from_state,
    toState: row.to_state,
    triggerType: row.trigger_type,
    initiator: row.initiator,
    reason: row.reason,
    scoresSnapshot: row.scores_snapshot,
    createdAt: row.created_at,
  };
}

export class SqliteStateTransitionRepository implements StateTransitionRepository {
  constructor(private readonly db: Database.Database) {}

  insert(transition: Omit<StateTransition, "id" | "createdAt">): void {
    this.db
      .prepare(
        `INSERT INTO state_transitions
           (entity_type, entity_id, profile, from_state, to_state, trigger_type,
            initiator, reason, scores_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transition.entityType,
        transition.entityId,
        transition.profile,
        transition.fromState,
        transition.toState,
        transition.triggerType,
        transition.initiator,
        transition.reason,
        transition.scoresSnapshot,
      );
  }

  findLastTransitionTo(
    familyId: string,
    toState: string,
    profile?: string | null,
  ): StateTransition | null {
    const row = this.db
      .prepare(
        `SELECT * FROM state_transitions
         WHERE entity_type = 'family' AND entity_id = ? AND to_state = ?
           AND (
             ? IS NULL
             OR profile = ?
             OR (
               profile IS NULL
               AND NOT EXISTS (
                 SELECT 1
                 FROM state_transitions st2
                 WHERE st2.entity_type = 'family'
                   AND st2.entity_id = ?
                   AND st2.to_state = ?
                   AND st2.profile = ?
               )
             )
           )
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(
        familyId,
        toState,
        profile ?? null,
        profile ?? null,
        familyId,
        toState,
        profile ?? null,
      ) as TransitionRow | undefined;
    return row ? rowToTransition(row) : null;
  }

  findByEntity(entityType: string, entityId: string): StateTransition[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM state_transitions
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY created_at DESC, id DESC`,
      )
      .all(entityType, entityId) as TransitionRow[];
    return rows.map(rowToTransition);
  }

  findRecent(limit: number): StateTransition[] {
    const rows = this.db
      .prepare("SELECT * FROM state_transitions ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as TransitionRow[];
    return rows.map(rowToTransition);
  }
}
