/**
 * Bootstrap Import — stub module.
 *
 * Family-rules YAML bootstrapping was removed in Phase 6 of the
 * "Selection Rules Replace Families" refactor. The control.db is now
 * seeded via selection rules, not family YAML.
 */

import type Database from "better-sqlite3";
import { ensureControlProfiles, upsertFamilyRuleDefaults } from "@plankton/db";
import { ProfileId } from "@plankton/domain";

export function needsBootstrap(db: Database.Database): boolean {
  const row = db.prepare("SELECT COUNT(*) as cnt FROM family_catalog").get() as { cnt: number };
  return row.cnt === 0;
}

export interface MaybeBootstrapResult {
  readonly bootstrapped: boolean;
  readonly importedFamilies: number;
}

/**
 * No-op — family YAML bootstrap removed in Phase 6.
 * Returns bootstrapped: false so callers don't log misleading messages.
 */
export function maybeBootstrapFromYaml(
  _db: Database.Database,
  _yamlPath: string,
): MaybeBootstrapResult {
  return { bootstrapped: false, importedFamilies: 0 };
}

export interface SyncProfileBalancesResult {
  synced: number;
}

/**
 * Sync initial_balance_usdc from global config into profile_settings.
 */
export function syncProfileInitialBalances(
  db: Database.Database,
  initialBalanceUsdc: number,
): SyncProfileBalancesResult {
  ensureControlProfiles(db);
  upsertFamilyRuleDefaults(db, { entry: null }, new Date().toISOString());
  let synced = 0;
  for (const profileId of [ProfileId.Simulation, ProfileId.Paper, ProfileId.LiveLite]) {
    const existing = db
      .prepare("SELECT initial_balance_usdc FROM profile_settings WHERE profile_id = ?")
      .get(profileId) as { initial_balance_usdc: number | null } | undefined;
    if (existing?.initial_balance_usdc != null) continue;
    db.prepare(
      `INSERT INTO profile_settings (profile_id, initial_balance_usdc, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(profile_id) DO UPDATE SET
         initial_balance_usdc = COALESCE(initial_balance_usdc, excluded.initial_balance_usdc),
         updated_at = excluded.updated_at`,
    ).run(profileId, initialBalanceUsdc);
    synced++;
  }
  return { synced };
}
