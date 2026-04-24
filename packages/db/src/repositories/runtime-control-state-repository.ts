import type Database from "better-sqlite3";
import type { RuntimeControlStateRepository, RuntimeControlState } from "@plankton/domain";
import { createSwitchId } from "@plankton/domain";
import type { ProfileId, RuntimeStatus } from "@plankton/domain";

export class SqliteRuntimeControlStateRepository implements RuntimeControlStateRepository {
  constructor(private readonly db: Database.Database) {}

  get(): RuntimeControlState | null {
    const row = this.db.prepare("SELECT * FROM runtime_control_state WHERE id = 1").get() as
      | Record<string, unknown>
      | undefined;
    return row ? rowToState(row) : null;
  }

  save(state: RuntimeControlState): void {
    this.db
      .prepare(
        `INSERT INTO runtime_control_state
         (id, current_profile, desired_profile, current_switch_id, current_run_id,
          current_instance_id, runtime_status, paused, schema_version, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           current_profile = excluded.current_profile,
           desired_profile = excluded.desired_profile,
           current_switch_id = excluded.current_switch_id,
           current_run_id = excluded.current_run_id,
           current_instance_id = excluded.current_instance_id,
           runtime_status = excluded.runtime_status,
           paused = excluded.paused,
           schema_version = excluded.schema_version,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.currentProfile,
        state.desiredProfile,
        state.currentSwitchId,
        state.currentRunId,
        state.currentInstanceId,
        state.runtimeStatus,
        state.paused ? 1 : 0,
        state.schemaVersion,
        state.updatedAt,
      );
  }
}

function rowToState(row: Record<string, unknown>): RuntimeControlState {
  return {
    currentProfile: (row.current_profile as ProfileId) ?? null,
    desiredProfile: (row.desired_profile as ProfileId) ?? null,
    currentSwitchId: row.current_switch_id ? createSwitchId(row.current_switch_id as string) : null,
    currentRunId: (row.current_run_id as string) ?? null,
    currentInstanceId: (row.current_instance_id as string) ?? null,
    runtimeStatus: row.runtime_status as RuntimeStatus,
    paused: row.paused === 1,
    schemaVersion: row.schema_version as number,
    executionPolicyVersion: (row.execution_policy_version as number) ?? 0,
    updatedAt: row.updated_at as string,
  };
}

/**
 * ADR-015: read-only helper used by the execution-policy provider. Colocated
 * with the control-state repo since the version column lives on the same
 * singleton row. Returns 0 when the column is missing on legacy DBs.
 */
export function readExecutionPolicyVersion(db: import("better-sqlite3").Database): number {
  try {
    const row = db
      .prepare("SELECT execution_policy_version AS v FROM runtime_control_state WHERE id = 1")
      .get() as { v: number } | undefined;
    return row?.v ?? 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such column") || msg.includes("no such table")) return 0;
    throw err;
  }
}
