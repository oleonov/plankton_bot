import type Database from "better-sqlite3";
import type {
  ContinuationMode,
  RuntimeControlStateRepository,
  RuntimeControlState,
} from "@krabs/domain";
import { createSwitchId } from "@krabs/domain";
import type { ProfileId, RuntimeStatus } from "@krabs/domain";

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
    continuationMode: (row.continuation_mode as ContinuationMode) ?? "leg_local",
    continuationModeVersion: (row.continuation_mode_version as number) ?? 0,
    updatedAt: row.updated_at as string,
  };
}

/**
 * ADR-016: read-only helper paired with `readExecutionPolicyVersion` above.
 * Returns 0 when the column is absent so legacy DBs short-circuit to default.
 */
export function readContinuationModeVersion(db: import("better-sqlite3").Database): number {
  try {
    const row = db
      .prepare("SELECT continuation_mode_version AS v FROM runtime_control_state WHERE id = 1")
      .get() as { v: number } | undefined;
    return row?.v ?? 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such column") || msg.includes("no such table")) return 0;
    throw err;
  }
}

/**
 * ADR-016: read the current continuation mode. Falls back to 'leg_local' when
 * the column is missing (legacy DB) so the runtime preserves ADR-010 behavior.
 */
export function readContinuationMode(db: import("better-sqlite3").Database): ContinuationMode {
  try {
    const row = db
      .prepare("SELECT continuation_mode AS m FROM runtime_control_state WHERE id = 1")
      .get() as { m: string } | undefined;
    if (row?.m === "market_wide") return "market_wide";
    return "leg_local";
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("no such column") || msg.includes("no such table")) return "leg_local";
    throw err;
  }
}

/**
 * ADR-016: operator toggle. Updates the mode and bumps the version atomically
 * so polling consumers detect the change on their next tick. Idempotent: when
 * the requested mode equals the current one, the version is NOT bumped.
 */
export function setContinuationMode(
  db: import("better-sqlite3").Database,
  mode: ContinuationMode,
): { changed: boolean; version: number } {
  const tx = db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
    const before = db
      .prepare(
        "SELECT continuation_mode AS m, continuation_mode_version AS v FROM runtime_control_state WHERE id = 1",
      )
      .get() as { m: string; v: number };
    if (before.m === mode) {
      return { changed: false, version: before.v };
    }
    db.prepare(
      `UPDATE runtime_control_state
         SET continuation_mode = ?,
             continuation_mode_version = continuation_mode_version + 1,
             updated_at = datetime('now')
       WHERE id = 1`,
    ).run(mode);
    return { changed: true, version: before.v + 1 };
  });
  return tx();
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
