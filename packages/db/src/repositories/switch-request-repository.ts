import type Database from "better-sqlite3";
import type { SwitchRequestRepository, SwitchRequest } from "@plankton/domain";
import { createSwitchId } from "@plankton/domain";
import type { SwitchId, ProfileId, SwitchState, LedgerResetPolicy } from "@plankton/domain";

export class SqliteSwitchRequestRepository implements SwitchRequestRepository {
  constructor(private readonly db: Database.Database) {}

  save(request: SwitchRequest): void {
    this.db
      .prepare(
        `INSERT INTO profile_switch_requests
         (switch_id, from_profile, to_profile, ledger_reset_policy, deploy_plan_json,
          state, error_message, archive_path, requested_by, requested_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(switch_id) DO UPDATE SET
           from_profile = excluded.from_profile,
           to_profile = excluded.to_profile,
           ledger_reset_policy = excluded.ledger_reset_policy,
           deploy_plan_json = excluded.deploy_plan_json,
           state = excluded.state,
           error_message = excluded.error_message,
           archive_path = excluded.archive_path,
           requested_by = excluded.requested_by,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at`,
      )
      .run(
        request.switchId,
        request.fromProfile,
        request.toProfile,
        request.ledgerResetPolicy,
        request.deployPlanJson,
        request.state,
        request.errorMessage,
        request.archivePath,
        request.requestedBy,
        request.requestedAt,
        request.startedAt,
        request.completedAt,
      );
  }

  findById(switchId: SwitchId): SwitchRequest | null {
    const row = this.db
      .prepare("SELECT * FROM profile_switch_requests WHERE switch_id = ?")
      .get(switchId) as Record<string, unknown> | undefined;
    return row ? rowToRequest(row) : null;
  }

  findActive(): SwitchRequest | null {
    const row = this.db
      .prepare(
        `SELECT * FROM profile_switch_requests
         WHERE state NOT IN ('completed', 'failed', 'rolled_back')
         ORDER BY requested_at DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return row ? rowToRequest(row) : null;
  }

  updateState(switchId: SwitchId, state: SwitchState, error?: string | null): void {
    this.db
      .prepare(
        `UPDATE profile_switch_requests
         SET state = ?, error_message = COALESCE(?, error_message),
             started_at = CASE WHEN ? = 'pausing' AND started_at IS NULL THEN datetime('now') ELSE started_at END,
             completed_at = CASE WHEN ? IN ('completed', 'failed', 'rolled_back') THEN datetime('now') ELSE completed_at END
         WHERE switch_id = ?`,
      )
      .run(state, error ?? null, state, state, switchId);
  }
}

function rowToRequest(row: Record<string, unknown>): SwitchRequest {
  return {
    switchId: createSwitchId(row.switch_id as string),
    fromProfile: row.from_profile as ProfileId,
    toProfile: row.to_profile as ProfileId,
    ledgerResetPolicy: row.ledger_reset_policy as LedgerResetPolicy,
    deployPlanJson: (row.deploy_plan_json as string) ?? null,
    state: row.state as SwitchState,
    errorMessage: (row.error_message as string) ?? null,
    archivePath: (row.archive_path as string) ?? null,
    requestedBy: (row.requested_by as string) ?? null,
    requestedAt: row.requested_at as string,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
  };
}
