import type Database from "better-sqlite3";
import type { FamilyProfileRuntimeStateRepository } from "@plankton/domain";
import type { FamilyProfileRuntimeState, FamilyId } from "@plankton/domain";
import { createFamilyId } from "@plankton/domain";

interface Row {
  family_id: string;
  open_value_usdc: number;
  open_position_count: number;
  open_dust_count: number;
  active_market_count: number;
  current_tail_cost_usdc: number;
  tail_adjusted_pnl_live: number;
  last_entry_ts: string | null;
  last_exit_ts: string | null;
  effective_mode: string | null;
  derived_mode_reason: string | null;
  first_negative_tail_at: string | null;
  updated_at: string;
}

function rowToState(row: Row): FamilyProfileRuntimeState {
  return {
    familyId: createFamilyId(row.family_id),
    openValueUsdc: row.open_value_usdc,
    openPositionCount: row.open_position_count,
    openDustCount: row.open_dust_count,
    activeMarketCount: row.active_market_count,
    currentTailCostUsdc: row.current_tail_cost_usdc,
    tailAdjustedPnlLive: row.tail_adjusted_pnl_live,
    lastEntryTs: row.last_entry_ts ?? null,
    lastExitTs: row.last_exit_ts ?? null,
    effectiveMode: row.effective_mode ?? null,
    derivedModeReason: row.derived_mode_reason ?? null,
    firstNegativeTailAt: row.first_negative_tail_at ?? null,
    updatedAt: row.updated_at,
  };
}

export class SqliteFamilyProfileRuntimeStateRepository implements FamilyProfileRuntimeStateRepository {
  constructor(private readonly db: Database.Database) {}

  get(familyId: FamilyId): FamilyProfileRuntimeState | null {
    const row = this.db
      .prepare(`SELECT * FROM family_profile_runtime_state WHERE family_id = ?`)
      .get(familyId) as Row | undefined;
    return row ? rowToState(row) : null;
  }

  save(state: FamilyProfileRuntimeState): void {
    this.db
      .prepare(
        `INSERT INTO family_profile_runtime_state
           (family_id, open_value_usdc, open_position_count,
            open_dust_count, active_market_count, current_tail_cost_usdc,
            tail_adjusted_pnl_live, last_entry_ts, last_exit_ts,
            effective_mode, derived_mode_reason,
            first_negative_tail_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(family_id) DO UPDATE SET
           open_value_usdc = excluded.open_value_usdc,
           open_position_count = excluded.open_position_count,
           open_dust_count = excluded.open_dust_count,
           active_market_count = excluded.active_market_count,
           current_tail_cost_usdc = excluded.current_tail_cost_usdc,
           tail_adjusted_pnl_live = excluded.tail_adjusted_pnl_live,
           last_entry_ts = excluded.last_entry_ts,
           last_exit_ts = excluded.last_exit_ts,
           effective_mode = excluded.effective_mode,
           derived_mode_reason = excluded.derived_mode_reason,
           first_negative_tail_at = excluded.first_negative_tail_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.familyId,
        state.openValueUsdc,
        state.openPositionCount,
        state.openDustCount,
        state.activeMarketCount,
        state.currentTailCostUsdc,
        state.tailAdjustedPnlLive,
        state.lastEntryTs,
        state.lastExitTs,
        state.effectiveMode,
        state.derivedModeReason,
        state.firstNegativeTailAt,
        state.updatedAt,
      );
  }

  findAll(): FamilyProfileRuntimeState[] {
    const rows = this.db.prepare(`SELECT * FROM family_profile_runtime_state`).all() as Row[];
    return rows.map(rowToState);
  }
}
