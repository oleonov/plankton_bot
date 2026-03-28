import type Database from "better-sqlite3";
import type { OperatorCommandRepository } from "@plankton/domain";
import type { OperatorCommand } from "@plankton/domain";
import type { OperatorActionType, CommandStatus } from "@plankton/domain";

interface CommandRow {
  id: number;
  action: string;
  target_id: string | null;
  reason: string | null;
  status: string;
  created_at: string;
  applied_at: string | null;
  initiator_type: string;
  initiator: string | null;
}

function rowToCommand(row: CommandRow): OperatorCommand {
  return {
    id: row.id,
    action: row.action as OperatorActionType,
    targetId: row.target_id ?? null,
    reason: row.reason ?? null,
    status: row.status as CommandStatus,
    createdAt: row.created_at,
    appliedAt: row.applied_at ?? null,
    initiatorType: (row.initiator_type as "operator" | "system") ?? "operator",
    initiator: row.initiator ?? null,
  };
}

export class SqliteOperatorCommandRepository implements OperatorCommandRepository {
  constructor(private readonly db: Database.Database) {}

  insert(cmd: Omit<OperatorCommand, "id" | "status" | "appliedAt">): number {
    const info = this.db
      .prepare(
        `INSERT INTO operator_commands
           (action, target_id, reason, status, created_at, applied_at, initiator_type, initiator)
         VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?)`,
      )
      .run(
        cmd.action,
        cmd.targetId,
        cmd.reason,
        cmd.createdAt,
        cmd.initiatorType ?? "operator",
        cmd.initiator ?? null,
      );
    return Number(info.lastInsertRowid);
  }

  getPending(): OperatorCommand[] {
    const rows = this.db
      .prepare(`SELECT * FROM operator_commands WHERE status = 'pending' ORDER BY created_at ASC`)
      .all() as CommandRow[];
    return rows.map(rowToCommand);
  }

  updateStatus(id: number, status: "applied" | "rejected", appliedAt: string): void {
    this.db
      .prepare(`UPDATE operator_commands SET status = ?, applied_at = ? WHERE id = ?`)
      .run(status, appliedAt, id);
  }
}
