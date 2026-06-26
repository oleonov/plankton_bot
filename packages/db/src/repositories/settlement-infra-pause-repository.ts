import type Database from "better-sqlite3";

export interface SettlementInfraPauseRecord {
  disabledUntilMs: number;
  code: string | null;
}

/**
 * Single-row persistence for the settlement-infra hard-pause window (table
 * `settlement_infra_pause`, id always 1). Backs SettlementInfraBreaker so a
 * restart re-arms an open pause instead of resetting it to "not paused".
 */
export class SqliteSettlementInfraPauseRepository {
  constructor(private readonly db: Database.Database) {}

  load(): SettlementInfraPauseRecord | null {
    const row = this.db
      .prepare(`SELECT disabled_until_ms, code FROM settlement_infra_pause WHERE id = 1`)
      .get() as { disabled_until_ms: number; code: string | null } | undefined;
    if (!row) return null;
    return { disabledUntilMs: row.disabled_until_ms, code: row.code };
  }

  save(disabledUntilMs: number, code: string | null): void {
    this.db
      .prepare(
        `INSERT INTO settlement_infra_pause (id, disabled_until_ms, code, updated_at)
         VALUES (1, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           disabled_until_ms = excluded.disabled_until_ms,
           code = excluded.code,
           updated_at = excluded.updated_at`,
      )
      .run(disabledUntilMs, code);
  }
}
