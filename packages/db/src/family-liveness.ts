import type Database from "better-sqlite3";
import {
  emptyFamilyLivenessSnapshot,
  toFamilyLivenessSnapshot,
  type FamilyLivenessSnapshot,
} from "@plankton/domain";

interface FamilyLivenessRow {
  family_id: string;
  active_market_count: number;
  known_market_count: number;
  last_market_seen_at: string | null;
}

export function readFamilyLiveness(
  db: Database.Database,
  familyIds: string[],
): Map<string, FamilyLivenessSnapshot> {
  const result = new Map<string, FamilyLivenessSnapshot>();
  if (familyIds.length === 0) return result;

  const uniqueFamilyIds = Array.from(new Set(familyIds));
  const placeholders = uniqueFamilyIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT
         family_id,
         COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active_market_count,
         COUNT(*) AS known_market_count,
         MAX(updated_at) AS last_market_seen_at
       FROM markets
       WHERE family_id IN (${placeholders})
       GROUP BY family_id`,
    )
    .all(...uniqueFamilyIds) as FamilyLivenessRow[];

  for (const familyId of uniqueFamilyIds) {
    result.set(familyId, emptyFamilyLivenessSnapshot());
  }

  for (const row of rows) {
    result.set(
      row.family_id,
      toFamilyLivenessSnapshot({
        activeMarketCount: Number(row.active_market_count ?? 0),
        knownMarketCount: Number(row.known_market_count ?? 0),
        lastMarketSeenAt: row.last_market_seen_at ?? null,
      }),
    );
  }

  return result;
}
