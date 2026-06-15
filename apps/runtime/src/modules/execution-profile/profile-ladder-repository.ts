import type Database from "better-sqlite3";
import {
  createConditionId,
  createTokenId,
  type LadderRung,
  type LadderState,
  type ProfileLadderBand,
  type ProfileLadderMode,
  type ProfileLadderStatus,
  type TokenId,
} from "@krabs/domain";

export interface ProfileLadderRepository {
  upsertLadder(state: LadderState): void;
  getLadder(tokenId: TokenId): LadderState | null;
  findActive(): LadderState[];
  deleteLadder(tokenId: TokenId): void;
  runInTransaction<T>(fn: () => T): T;
}

export class SqliteProfileLadderRepository implements ProfileLadderRepository {
  constructor(private readonly db: Database.Database) {}

  upsertLadder(state: LadderState): void {
    this.db
      .prepare(
        `INSERT INTO ladder_state
         (token_id, condition_id, ladder_id, band, phase, status, active_rungs_json,
          filled_rungs_json, last_avg_entry, last_cost_basis_usdc, last_mode,
          last_bbo_reference_json, last_rebuild_at_ms, last_fill_at_ms,
          stale_checked_at_ms, qd_handoff_at_ms, created_at_ms, updated_at_ms, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           condition_id = excluded.condition_id,
           ladder_id = excluded.ladder_id,
           band = excluded.band,
           phase = excluded.phase,
           status = excluded.status,
           active_rungs_json = excluded.active_rungs_json,
           filled_rungs_json = excluded.filled_rungs_json,
           last_avg_entry = excluded.last_avg_entry,
           last_cost_basis_usdc = excluded.last_cost_basis_usdc,
           last_mode = excluded.last_mode,
           last_bbo_reference_json = excluded.last_bbo_reference_json,
           last_rebuild_at_ms = excluded.last_rebuild_at_ms,
           last_fill_at_ms = excluded.last_fill_at_ms,
           stale_checked_at_ms = excluded.stale_checked_at_ms,
           qd_handoff_at_ms = excluded.qd_handoff_at_ms,
           updated_at_ms = excluded.updated_at_ms,
           metadata_json = excluded.metadata_json`,
      )
      .run(
        state.tokenId,
        state.conditionId,
        state.ladderId,
        state.band,
        state.phase,
        state.status,
        JSON.stringify(state.activeRungs),
        JSON.stringify(state.filledRungs),
        state.lastAvgEntry,
        state.lastCostBasisUsdc,
        state.lastMode,
        state.lastBboReferenceJson,
        state.lastRebuildAtMs,
        state.lastFillAtMs,
        state.staleCheckedAtMs,
        state.qdHandoffAtMs,
        state.createdAtMs,
        state.updatedAtMs,
        state.metadataJson,
      );
  }

  getLadder(tokenId: TokenId): LadderState | null {
    const row = this.db.prepare(`SELECT * FROM ladder_state WHERE token_id = ?`).get(tokenId) as
      | LadderStateRow
      | undefined;
    return row == null ? null : toLadderState(row);
  }

  findActive(): LadderState[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ladder_state
         WHERE status NOT IN ('closed', 'cancelled')
         ORDER BY updated_at_ms DESC`,
      )
      .all() as LadderStateRow[];
    return rows.map(toLadderState);
  }

  deleteLadder(tokenId: TokenId): void {
    this.db.prepare(`DELETE FROM ladder_state WHERE token_id = ?`).run(tokenId);
  }

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

interface LadderStateRow {
  token_id: string;
  condition_id: string;
  ladder_id: string;
  band: ProfileLadderBand;
  phase: number;
  status: ProfileLadderStatus;
  active_rungs_json: string;
  filled_rungs_json: string;
  last_avg_entry: number;
  last_cost_basis_usdc: number;
  last_mode: ProfileLadderMode;
  last_bbo_reference_json: string | null;
  last_rebuild_at_ms: number | null;
  last_fill_at_ms: number | null;
  stale_checked_at_ms: number | null;
  qd_handoff_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  metadata_json: string;
}

function toLadderState(row: LadderStateRow): LadderState {
  return {
    tokenId: createTokenId(row.token_id),
    conditionId: createConditionId(row.condition_id),
    ladderId: row.ladder_id,
    band: row.band,
    phase: row.phase,
    status: row.status,
    activeRungs: parseRungs(row.active_rungs_json),
    filledRungs: parseRungs(row.filled_rungs_json),
    lastAvgEntry: row.last_avg_entry,
    lastCostBasisUsdc: row.last_cost_basis_usdc,
    lastMode: row.last_mode,
    lastBboReferenceJson: row.last_bbo_reference_json,
    lastRebuildAtMs: row.last_rebuild_at_ms,
    lastFillAtMs: row.last_fill_at_ms,
    staleCheckedAtMs: row.stale_checked_at_ms,
    qdHandoffAtMs: row.qd_handoff_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    metadataJson: row.metadata_json,
  };
}

function parseRungs(raw: string): LadderRung[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as LadderRung[]) : [];
  } catch {
    return [];
  }
}
