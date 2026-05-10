import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { OperatorActionRepository } from "@krabs/domain";
import type { OperatorAction } from "@krabs/domain";
import type { OperatorActionType } from "@krabs/domain";

interface ActionRow {
  action_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  performed_at: string;
}

function rowToAction(row: ActionRow): OperatorAction {
  return {
    actionId: row.action_id,
    action: row.action as OperatorActionType,
    targetType: row.target_type as OperatorAction["targetType"],
    targetId: row.target_id,
    reason: row.reason ?? null,
    performedAt: row.performed_at,
  };
}

export class SqliteOperatorActionRepository implements OperatorActionRepository {
  constructor(private readonly db: Database.Database) {}

  insert(action: Omit<OperatorAction, "actionId">): void {
    const actionId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO operator_actions
           (action_id, action, target_type, target_id, reason, performed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        actionId,
        action.action,
        action.targetType,
        action.targetId,
        action.reason,
        action.performedAt,
      );
  }

  findRecent(limit: number): OperatorAction[] {
    const rows = this.db
      .prepare(`SELECT * FROM operator_actions ORDER BY performed_at DESC LIMIT ?`)
      .all(limit) as ActionRow[];
    return rows.map(rowToAction);
  }
}
