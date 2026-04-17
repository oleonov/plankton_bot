import type Database from "better-sqlite3";
import type { FamilyDeploymentRepository, FamilyDeployment } from "@plankton/domain";
import type { FamilyId, ProfileId } from "@plankton/domain";

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
         (family_id, profile, enabled, disabled_at, disabled_reason, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(family_id, profile) DO UPDATE SET
           enabled = excluded.enabled,
           disabled_at = excluded.disabled_at,
           disabled_reason = excluded.disabled_reason,
           priority = excluded.priority,
           updated_at = excluded.updated_at`,
      )
      .run(
        deployment.familyId,
        deployment.profile,
        deployment.enabled ? 1 : 0,
        deployment.disabledAt,
        deployment.disabledReason,
        deployment.priority,
        deployment.createdAt,
        deployment.updatedAt,
      );
  }

  enable(familyId: FamilyId, profile: ProfileId): void {
    this.db
      .prepare(
        `UPDATE family_deployments
         SET enabled = 1, disabled_at = NULL, disabled_reason = NULL,
             updated_at = datetime('now')
         WHERE family_id = ? AND profile = ?`,
      )
      .run(familyId, profile);
  }

  disable(familyId: FamilyId, profile: ProfileId, reason: string | null): void {
    this.db
      .prepare(
        `UPDATE family_deployments
         SET enabled = 0, disabled_at = datetime('now'), disabled_reason = ?,
             updated_at = datetime('now')
         WHERE family_id = ? AND profile = ?`,
      )
      .run(reason, familyId, profile);
  }
}

function rowToDeployment(row: Record<string, unknown>): FamilyDeployment {
  return {
    familyId: row.family_id as FamilyId,
    profile: row.profile as ProfileId,
    enabled: row.enabled === 1,
    disabledAt: (row.disabled_at as string) ?? null,
    disabledReason: (row.disabled_reason as string) ?? null,
    priority: row.priority as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}
