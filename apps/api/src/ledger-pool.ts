import { existsSync } from "node:fs";
import { bootstrapLedgerDb, type DbConnection } from "@plankton/db";
import type Database from "better-sqlite3";

/**
 * Lazily opens ledger DBs by profile ID.
 * Caches open connections for reuse. Closes all on shutdown.
 */
export class LedgerPool {
  private readonly pool = new Map<string, DbConnection>();
  private readonly controlDbPath: string;

  constructor(controlDbPath: string) {
    this.controlDbPath = controlDbPath;
  }

  /** Get ledger DB for a profile. Returns null if the file doesn't exist. */
  get(profileId: string): Database.Database | null {
    const cached = this.pool.get(profileId);
    if (cached) return cached.db;

    const ledgerPath = this.controlDbPath.replace("control.db", `ledger-${profileId}.db`);
    if (!existsSync(ledgerPath)) return null;

    const conn = bootstrapLedgerDb(ledgerPath);
    this.pool.set(profileId, conn);
    return conn.db;
  }

  closeAll(): void {
    for (const conn of this.pool.values()) conn.close();
    this.pool.clear();
  }
}
