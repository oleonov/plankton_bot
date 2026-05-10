import type Database from "better-sqlite3";
import type { AlgoTokenModeState, AlgoTokenModeStateRepository } from "@krabs/domain";
import { createConditionId, createTokenId } from "@krabs/domain";

export class SqliteAlgoTokenModeStateRepository implements AlgoTokenModeStateRepository {
  constructor(private readonly db: Database.Database) {}

  get(tokenId: import("@krabs/domain").TokenId): AlgoTokenModeState | null {
    const row = this.db
      .prepare("SELECT * FROM algo_token_mode_state WHERE token_id = ?")
      .get(tokenId) as Record<string, unknown> | undefined;
    return row ? this.rowToState(row) : null;
  }

  upsert(state: AlgoTokenModeState): void {
    this.db
      .prepare(
        `INSERT INTO algo_token_mode_state
         (token_id, condition_id, outcome_index, mode, mode_confidence, mode_status,
          mode_since, mode_assessed_at, ttl_stage, last_fill_at, last_order_at,
          last_stale_cancel_at, fill_count_window, order_count_window,
          first_fill_latency_ms, median_gap_ms, p75_gap_ms, span_ms,
          last_fill_timestamps_json, transition_count_day, transition_day,
          reset_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           condition_id = excluded.condition_id,
           outcome_index = excluded.outcome_index,
           mode = excluded.mode,
           mode_confidence = excluded.mode_confidence,
           mode_status = excluded.mode_status,
           mode_since = excluded.mode_since,
           mode_assessed_at = excluded.mode_assessed_at,
           ttl_stage = excluded.ttl_stage,
           last_fill_at = excluded.last_fill_at,
           last_order_at = excluded.last_order_at,
           last_stale_cancel_at = excluded.last_stale_cancel_at,
           fill_count_window = excluded.fill_count_window,
           order_count_window = excluded.order_count_window,
           first_fill_latency_ms = excluded.first_fill_latency_ms,
           median_gap_ms = excluded.median_gap_ms,
           p75_gap_ms = excluded.p75_gap_ms,
           span_ms = excluded.span_ms,
           last_fill_timestamps_json = excluded.last_fill_timestamps_json,
           transition_count_day = excluded.transition_count_day,
           transition_day = excluded.transition_day,
           reset_reason = excluded.reset_reason,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.tokenId,
        state.conditionId,
        state.outcomeIndex,
        state.mode,
        state.modeConfidence,
        state.modeStatus,
        state.modeSince,
        state.modeAssessedAt,
        state.ttlStage,
        state.lastFillAt,
        state.lastOrderAt,
        state.lastStaleCancelAt,
        state.fillCountWindow,
        state.orderCountWindow,
        state.firstFillLatencyMs,
        state.medianGapMs,
        state.p75GapMs,
        state.spanMs,
        state.lastFillTimestampsJson,
        state.transitionCountDay,
        state.transitionDay,
        state.resetReason,
        state.updatedAt,
      );
  }

  delete(tokenId: import("@krabs/domain").TokenId): void {
    this.db.prepare("DELETE FROM algo_token_mode_state WHERE token_id = ?").run(tokenId);
  }

  findAll(): AlgoTokenModeState[] {
    const rows = this.db
      .prepare("SELECT * FROM algo_token_mode_state ORDER BY updated_at DESC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.rowToState(row));
  }

  private rowToState(row: Record<string, unknown>): AlgoTokenModeState {
    return {
      tokenId: createTokenId(row.token_id as string),
      conditionId: createConditionId(row.condition_id as string),
      outcomeIndex: (row.outcome_index as number | null) ?? null,
      mode: row.mode as AlgoTokenModeState["mode"],
      modeConfidence: row.mode_confidence as AlgoTokenModeState["modeConfidence"],
      modeStatus: row.mode_status as AlgoTokenModeState["modeStatus"],
      modeSince: row.mode_since as string,
      modeAssessedAt: row.mode_assessed_at as string,
      ttlStage: row.ttl_stage as number,
      lastFillAt: (row.last_fill_at as string | null) ?? null,
      lastOrderAt: (row.last_order_at as string | null) ?? null,
      lastStaleCancelAt: (row.last_stale_cancel_at as string | null) ?? null,
      fillCountWindow: row.fill_count_window as number,
      orderCountWindow: row.order_count_window as number,
      firstFillLatencyMs: (row.first_fill_latency_ms as number | null) ?? null,
      medianGapMs: (row.median_gap_ms as number | null) ?? null,
      p75GapMs: (row.p75_gap_ms as number | null) ?? null,
      spanMs: (row.span_ms as number | null) ?? null,
      lastFillTimestampsJson: (row.last_fill_timestamps_json as string | null) ?? null,
      transitionCountDay: row.transition_count_day as number,
      transitionDay: (row.transition_day as string | null) ?? null,
      resetReason: (row.reset_reason as string | null) ?? null,
      updatedAt: row.updated_at as string,
    };
  }
}
