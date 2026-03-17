import type Database from "better-sqlite3";
import type { FamilyIdentity, FamilyId } from "@plankton/domain";
import { createFamilyId } from "@plankton/domain";
import type { Regime, StrategyProfile } from "@plankton/domain";

/**
 * Persistence for the family_catalog table.
 * This is a db-internal repository (no domain interface) that exists to
 * satisfy FK constraints from family_runtime_state, family_evidence, and
 * family_rules tables. The runtime seeds it at startup from FamilyIdentity
 * objects loaded via @plankton/family-rules.
 */
export class SqliteFamilyCatalogRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(identity: FamilyIdentity): void {
    this.db
      .prepare(
        `INSERT INTO family_catalog
           (family_id, family_key, primary_category, regime, horizon,
            cadence, strategy_profile, topic_key, slug_pattern, notes,
            updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(family_id) DO UPDATE SET
           family_key = excluded.family_key,
           primary_category = excluded.primary_category,
           regime = excluded.regime,
           horizon = excluded.horizon,
           cadence = excluded.cadence,
           strategy_profile = excluded.strategy_profile,
           topic_key = excluded.topic_key,
           slug_pattern = excluded.slug_pattern,
           notes = excluded.notes,
           updated_at = excluded.updated_at`,
      )
      .run(
        identity.familyId,
        identity.familyKey,
        identity.primaryCategory,
        identity.regime,
        identity.horizon,
        identity.cadence,
        identity.strategyProfile,
        identity.topicKey,
        identity.slugPattern,
        identity.notes,
      );
  }

  upsertAll(identities: FamilyIdentity[]): void {
    const upsertMany = this.db.transaction((items: FamilyIdentity[]) => {
      for (const identity of items) {
        this.upsert(identity);
      }
    });
    upsertMany(identities);
  }

  findById(familyId: FamilyId): FamilyIdentity | null {
    const row = this.db
      .prepare("SELECT * FROM family_catalog WHERE family_id = ?")
      .get(familyId) as Record<string, unknown> | undefined;
    return row ? this.rowToIdentity(row) : null;
  }

  findAll(): FamilyIdentity[] {
    const rows = this.db
      .prepare("SELECT * FROM family_catalog")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToIdentity(r));
  }

  private rowToIdentity(row: Record<string, unknown>): FamilyIdentity {
    return {
      familyId: createFamilyId(row.family_id as string),
      familyKey: row.family_key as string,
      primaryCategory: row.primary_category as string,
      regime: row.regime as Regime,
      horizon: row.horizon as string,
      cadence: row.cadence as string,
      strategyProfile: row.strategy_profile as StrategyProfile,
      topicKey: (row.topic_key as string) ?? null,
      slugPattern: (row.slug_pattern as string) ?? null,
      notes: (row.notes as string) ?? null,
    };
  }
}
