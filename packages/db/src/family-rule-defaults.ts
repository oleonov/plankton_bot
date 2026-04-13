import type Database from "better-sqlite3";
import type { FamilyRuleDefaultsConfig } from "@plankton/config";

export const FAMILY_RULE_DEFAULTS_SCOPE = "global";

const CREATE_FAMILY_RULE_DEFAULTS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS family_rule_defaults (
    scope                               TEXT PRIMARY KEY CHECK (scope = 'global'),
    min_entry_price                     REAL NOT NULL,
    max_entry_price                     REAL NOT NULL,
    high_price_threshold                REAL NOT NULL,
    require_proven_family_above_price   REAL NOT NULL,
    preferred_entry_band                TEXT,
    updated_at                          TEXT NOT NULL
  )
`;

export function ensureFamilyRuleDefaultsTable(db: Database.Database): void {
  db.exec(CREATE_FAMILY_RULE_DEFAULTS_TABLE_SQL);
}

export function readFamilyRuleDefaults(db: Database.Database): FamilyRuleDefaultsConfig {
  const row = db
    .prepare(
      `SELECT
         min_entry_price,
         max_entry_price,
         high_price_threshold,
         require_proven_family_above_price,
         preferred_entry_band
       FROM family_rule_defaults
       WHERE scope = ?`,
    )
    .get(FAMILY_RULE_DEFAULTS_SCOPE) as
    | {
        min_entry_price: number;
        max_entry_price: number;
        high_price_threshold: number;
        require_proven_family_above_price: number;
        preferred_entry_band: string | null;
      }
    | undefined;

  if (!row) {
    return { entry: null };
  }

  return {
    entry: {
      minEntryPrice: row.min_entry_price,
      maxEntryPrice: row.max_entry_price,
      highPriceThreshold: row.high_price_threshold,
      requireProvenFamilyAbovePrice: row.require_proven_family_above_price,
      preferredEntryBand: row.preferred_entry_band,
    },
  };
}

export function upsertFamilyRuleDefaults(
  db: Database.Database,
  defaults: FamilyRuleDefaultsConfig,
  updatedAt: string,
): void {
  if (defaults.entry == null) return;

  db.prepare(
    `INSERT INTO family_rule_defaults
       (scope, min_entry_price, max_entry_price, high_price_threshold,
        require_proven_family_above_price, preferred_entry_band, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       min_entry_price = excluded.min_entry_price,
       max_entry_price = excluded.max_entry_price,
       high_price_threshold = excluded.high_price_threshold,
       require_proven_family_above_price = excluded.require_proven_family_above_price,
       preferred_entry_band = excluded.preferred_entry_band,
       updated_at = excluded.updated_at`,
  ).run(
    FAMILY_RULE_DEFAULTS_SCOPE,
    defaults.entry.minEntryPrice,
    defaults.entry.maxEntryPrice,
    defaults.entry.highPriceThreshold,
    defaults.entry.requireProvenFamilyAbovePrice,
    defaults.entry.preferredEntryBand,
    updatedAt,
  );
}
