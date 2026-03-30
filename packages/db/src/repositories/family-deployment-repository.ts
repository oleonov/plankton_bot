import type Database from "better-sqlite3";
import type { FamilyDeploymentRepository, FamilyDeployment } from "@plankton/domain";
import type { FamilyId } from "@plankton/domain";
import { createScorecardId } from "@plankton/domain";
import type { ProfileId, OperatorMode, DeploymentStage, StrategyStage } from "@plankton/domain";

export class SqliteFamilyDeploymentRepository implements FamilyDeploymentRepository {
  constructor(private readonly db: Database.Database) {}

  find(familyId: FamilyId, profile: ProfileId): FamilyDeployment | null {
    const row = this.db
      .prepare("SELECT * FROM family_deployments WHERE family_id = ? AND profile = ?")
      .get(familyId, profile) as Record<string, unknown> | undefined;
    return row ? rowToDeployment(row) : null;
  }

  findByProfile(profile: ProfileId): FamilyDeployment[] {
    const rows = this.db
      .prepare("SELECT * FROM family_deployments WHERE profile = ?")
      .all(profile) as Record<string, unknown>[];
    return rows.map(rowToDeployment);
  }

  findEnabled(profile: ProfileId): FamilyDeployment[] {
    const rows = this.db
      .prepare("SELECT * FROM family_deployments WHERE profile = ? AND enabled = 1")
      .all(profile) as Record<string, unknown>[];
    return rows.map(rowToDeployment);
  }

  save(deployment: FamilyDeployment): void {
    this.db
      .prepare(
        `INSERT INTO family_deployments
         (family_id, profile, enabled, operator_mode, strategy_stage, probe_substate,
          deployment_stage, approved_snapshot_id, approved_scorecard_id, operator_reason,
          priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(family_id, profile) DO UPDATE SET
           enabled = excluded.enabled,
           operator_mode = excluded.operator_mode,
           strategy_stage = excluded.strategy_stage,
           probe_substate = excluded.probe_substate,
           deployment_stage = excluded.deployment_stage,
           approved_snapshot_id = excluded.approved_snapshot_id,
           approved_scorecard_id = excluded.approved_scorecard_id,
           operator_reason = excluded.operator_reason,
           priority = excluded.priority,
           updated_at = excluded.updated_at`,
      )
      .run(
        deployment.familyId,
        deployment.profile,
        deployment.enabled ? 1 : 0,
        deployment.operatorMode,
        deployment.strategyStage,
        deployment.probeSubstate,
        deployment.deploymentStage,
        deployment.approvedSnapshotId,
        deployment.approvedScorecardId,
        deployment.operatorReason,
        deployment.priority,
        deployment.createdAt,
        deployment.updatedAt,
      );
  }

  updateOperatorMode(
    familyId: FamilyId,
    profile: ProfileId,
    mode: OperatorMode,
    reason: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE family_deployments
         SET operator_mode = ?, operator_reason = ?, updated_at = datetime('now')
         WHERE family_id = ? AND profile = ?`,
      )
      .run(mode, reason, familyId, profile);
  }

  updateDeploymentStage(familyId: FamilyId, profile: ProfileId, stage: DeploymentStage): void {
    this.db
      .prepare(
        `UPDATE family_deployments
         SET deployment_stage = ?, updated_at = datetime('now')
         WHERE family_id = ? AND profile = ?`,
      )
      .run(stage, familyId, profile);
  }
}

function rowToDeployment(row: Record<string, unknown>): FamilyDeployment {
  return {
    familyId: row.family_id as FamilyId,
    profile: row.profile as ProfileId,
    enabled: row.enabled === 1,
    operatorMode: row.operator_mode as OperatorMode,
    strategyStage: row.strategy_stage as StrategyStage,
    probeSubstate: (row.probe_substate as string) ?? null,
    deploymentStage: row.deployment_stage as DeploymentStage,
    approvedSnapshotId: (row.approved_snapshot_id as number) ?? null,
    approvedScorecardId: row.approved_scorecard_id
      ? createScorecardId(row.approved_scorecard_id as string)
      : null,
    operatorReason: (row.operator_reason as string) ?? null,
    priority: row.priority as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
