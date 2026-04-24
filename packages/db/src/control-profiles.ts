import type Database from "better-sqlite3";
import {
  DEFAULT_EXECUTION_POLICY,
  ProfileId,
  serializeExecutionPolicy,
  type DeadSideGuardMode,
} from "@plankton/domain";

export interface ControlProfileSeed {
  readonly profileId: string;
  readonly displayName: string;
  readonly description: string;
  /**
   * ADR-015: default dead-side guard posture seeded into
   * `profile_settings.execution_policy_json` on bootstrap. Live-lite ships
   * in `enforce` so real-money placements respect the guard immediately;
   * paper/sim ship in `observe` so canary metrics run without blocking
   * dev/CI flow.
   */
  readonly defaultDeadSideGuardMode: DeadSideGuardMode;
}

export const CONTROL_PROFILES: readonly ControlProfileSeed[] = [
  {
    profileId: ProfileId.Simulation,
    displayName: "Simulation",
    description: "In-memory simulated execution",
    defaultDeadSideGuardMode: "observe",
  },
  {
    profileId: ProfileId.Paper,
    displayName: "Paper",
    description: "Live market data, simulated orders",
    defaultDeadSideGuardMode: "observe",
  },
  {
    profileId: ProfileId.LiveLite,
    displayName: "Live-Lite",
    description: "Real orders with envelope caps",
    defaultDeadSideGuardMode: "enforce",
  },
];

function defaultExecutionPolicyJson(mode: DeadSideGuardMode): string {
  return serializeExecutionPolicy({
    ...DEFAULT_EXECUTION_POLICY,
    deadSideGuard: { ...DEFAULT_EXECUTION_POLICY.deadSideGuard, mode },
  });
}

export function ensureControlProfiles(db: Database.Database, now = new Date().toISOString()): void {
  const insertProfile = db.prepare(
    "INSERT OR IGNORE INTO profiles (profile_id, display_name, description, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const profile of CONTROL_PROFILES) {
    insertProfile.run(profile.profileId, profile.displayName, profile.description, now);
  }
}

/**
 * Ensures every seeded profile has a `profile_settings` row with a non-null
 * `execution_policy_json`. Fresh installs skip migration 038 via the baseline
 * (columns already exist), so this helper replaces the migration's UPDATE
 * path and also backfills legacy DBs where the row pre-dates ADR-015.
 *
 * Runs only when `execution_policy_json` column exists — bootstrap adds it
 * via `safeAddColumn` before calling us, so in practice it always does.
 */
export function ensureDefaultExecutionPolicy(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(profile_settings)`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === "execution_policy_json")) return;

  const insertSettings = db.prepare(
    `INSERT OR IGNORE INTO profile_settings (profile_id, execution_policy_json, updated_at)
       VALUES (?, ?, datetime('now'))`,
  );
  const fillMissing = db.prepare(
    `UPDATE profile_settings
        SET execution_policy_json = ?, updated_at = datetime('now')
      WHERE profile_id = ? AND execution_policy_json IS NULL`,
  );
  for (const profile of CONTROL_PROFILES) {
    const json = defaultExecutionPolicyJson(profile.defaultDeadSideGuardMode);
    insertSettings.run(profile.profileId, json);
    fillMissing.run(json, profile.profileId);
  }
}
