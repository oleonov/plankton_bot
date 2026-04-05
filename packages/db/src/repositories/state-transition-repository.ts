import type Database from "better-sqlite3";
import type { StateTransitionRepository, StateTransition } from "@plankton/domain";

interface TransitionRow {
  id: number;
  entity_type: string;
  entity_id: string;
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
           (entity_type, entity_id, from_state, to_state, trigger_type,
            initiator, reason, scores_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transition.entityType,
        transition.entityId,
        transition.fromState,
        transition.toState,
        transition.triggerType,
        transition.initiator,
        transition.reason,
        transition.scoresSnapshot,
      );
  }

  findLastTransitionTo(familyId: string, toState: string): StateTransition | null {
    const row = this.db
      .prepare(
        `SELECT * FROM state_transitions
         WHERE entity_type = 'family' AND entity_id = ? AND to_state = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(familyId, toState) as TransitionRow | undefined;
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
