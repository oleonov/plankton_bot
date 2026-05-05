/**
 * Shared helper: resolve the ledger DB for the currently active profile.
 *
 * Looks up `runtime_control_state.current_profile` and asks the `LedgerPool`
 * for the matching ledger. Falls back to the server's startup-fixed ledger
 * when control.db or the pool aren't available (legacy/test paths) or when
 * `runtime_control_state` doesn't exist yet.
 *
 * Used by routes that surface profile-scoped ledger state and must not return
 * stale data after a post-startup profile switch (`status`, `scanner`, …).
 */

import type Database from "better-sqlite3";
import type { LedgerPool } from "./ledger-pool.js";

export interface ResolvedLedger {
  readonly db: Database.Database;
  readonly profile: string | null;
}

export function resolveActiveLedger(
  fallback: Database.Database,
  controlDb?: Database.Database,
  ledgerPool?: LedgerPool,
): ResolvedLedger {
  if (!controlDb || !ledgerPool) return { db: fallback, profile: null };
  try {
    const row = controlDb
      .prepare("SELECT current_profile FROM runtime_control_state WHERE id = 1")
      .get() as { current_profile: string | null } | undefined;
    if (row?.current_profile) {
      const ledger = ledgerPool.get(row.current_profile);
      if (ledger) return { db: ledger, profile: row.current_profile };
    }
  } catch {
    // runtime_control_state may not exist in legacy/test DBs — fall through.
  }
  return { db: fallback, profile: null };
}
