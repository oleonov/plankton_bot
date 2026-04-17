import type Database from "better-sqlite3";
import type { FamilyProfileRollupRepository, FamilyProfileRollup } from "@plankton/domain";
import type { FamilyId, ProfileId } from "@plankton/domain";

export class SqliteFamilyProfileRollupRepository implements FamilyProfileRollupRepository {
  constructor(private readonly db: Database.Database) {}

  save(rollup: FamilyProfileRollup): void {
    this.db
      .prepare(
        `INSERT INTO family_profile_rollups
         (family_id, profile, open_value_usdc, open_positions, active_markets,
          realized_pnl, tail_cost_usdc, tail_adjusted_pnl,
          last_trade_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(family_id, profile) DO UPDATE SET
           open_value_usdc = excluded.open_value_usdc,
           open_positions = excluded.open_positions,
           active_markets = excluded.active_markets,
           realized_pnl = excluded.realized_pnl,
           tail_cost_usdc = excluded.tail_cost_usdc,
           tail_adjusted_pnl = excluded.tail_adjusted_pnl,
           last_trade_at = excluded.last_trade_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        rollup.familyId,
        rollup.profile,
        rollup.openValueUsdc,
        rollup.openPositions,
        rollup.activeMarkets,
        rollup.realizedPnl,
        rollup.tailCostUsdc,
        rollup.tailAdjustedPnl,
        rollup.lastTradeAt,
        rollup.updatedAt,
      );
  }

  findByProfile(profile: ProfileId): FamilyProfileRollup[] {
    const rows = this.db
      .prepare("SELECT * FROM family_profile_rollups WHERE profile = ?")
      .all(profile) as Record<string, unknown>[];
    return rows.map(rowToRollup);
  }

  find(familyId: FamilyId, profile: ProfileId): FamilyProfileRollup | null {
    const row = this.db
      .prepare("SELECT * FROM family_profile_rollups WHERE family_id = ? AND profile = ?")
      .get(familyId, profile) as Record<string, unknown> | undefined;
    return row ? rowToRollup(row) : null;
  }
}

function rowToRollup(row: Record<string, unknown>): FamilyProfileRollup {
  return {
    familyId: row.family_id as FamilyId,
    profile: row.profile as ProfileId,
    openValueUsdc: row.open_value_usdc as number,
    openPositions: row.open_positions as number,
    activeMarkets: row.active_markets as number,
    realizedPnl: row.realized_pnl as number,
    tailCostUsdc: row.tail_cost_usdc as number,
    tailAdjustedPnl: row.tail_adjusted_pnl as number,
    lastTradeAt: (row.last_trade_at as string) ?? null,
    updatedAt: row.updated_at as string,
  };
}
