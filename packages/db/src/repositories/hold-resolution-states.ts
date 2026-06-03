import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConditionId, OrderId, PositionId, TokenId } from "@krabs/domain";
import { createConditionId, createOrderId, createPositionId, createTokenId } from "@krabs/domain";

export type HoldResolutionStatus =
  | "active"
  | "resolved_zero_loss"
  | "recovered"
  | "cancelled"
  | "superseded";

export interface HoldResolutionState {
  readonly id: string;
  readonly tokenId: TokenId;
  readonly conditionId: ConditionId | null;
  readonly positionId: PositionId | null;
  readonly sourceOrderId: OrderId | null;
  readonly sourceSignalId: string | null;
  readonly status: HoldResolutionStatus;
  readonly markerCreatedAt: string;
  readonly expectedResolutionAt: string | null;
  readonly attemptCountForRedeem: number;
  readonly exitPnlPct: number | null;
  readonly staleReason: string;
  readonly livenessVerdict: string;
  readonly metadata: Record<string, unknown> | null;
}

export interface HoldResolutionInsertInput {
  readonly tokenId: TokenId;
  readonly conditionId?: ConditionId | null;
  readonly positionId?: PositionId | null;
  readonly sourceOrderId?: OrderId | null;
  readonly sourceSignalId?: string | null;
  readonly markerCreatedAt: string;
  readonly expectedResolutionAt?: string | null;
  readonly attemptCountForRedeem?: number;
  readonly exitPnlPct?: number | null;
  readonly staleReason: string;
  readonly livenessVerdict: string;
  readonly metadata?: Record<string, unknown> | null;
}

export interface HoldResolutionInsertResult {
  readonly inserted: boolean;
  readonly state: HoldResolutionState;
}

export class SqliteHoldResolutionStateRepository {
  constructor(private readonly db: Database.Database) {}

  insertActive(input: HoldResolutionInsertInput): HoldResolutionInsertResult {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO hold_resolution_states
           (id, token_id, condition_id, position_id, source_order_id, source_signal_id,
            status, marker_created_at, expected_resolution_at, attempt_count_for_redeem,
            exit_pnl_pct, stale_reason, liveness_verdict, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(input.tokenId),
        input.conditionId == null ? null : String(input.conditionId),
        input.positionId == null ? null : String(input.positionId),
        input.sourceOrderId == null ? null : String(input.sourceOrderId),
        input.sourceSignalId ?? null,
        input.markerCreatedAt,
        input.expectedResolutionAt ?? null,
        input.attemptCountForRedeem ?? 0,
        input.exitPnlPct ?? null,
        input.staleReason,
        input.livenessVerdict,
        input.metadata == null ? null : JSON.stringify(input.metadata),
      );

    const state = this.findActiveByTokenId(input.tokenId);
    if (!state) {
      throw new Error(`failed to insert or load active hold_resolution_state for ${input.tokenId}`);
    }
    return { inserted: result.changes > 0, state };
  }

  findActiveByTokenId(tokenId: TokenId): HoldResolutionState | null {
    const row = this.db
      .prepare(
        `SELECT *
           FROM hold_resolution_states
          WHERE token_id = ?
            AND status = 'active'
          ORDER BY marker_created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(String(tokenId)) as HoldResolutionRow | undefined;
    return row ? mapHoldResolutionState(row) : null;
  }

  transitionActive(
    tokenId: TokenId,
    input: {
      readonly status: Exclude<HoldResolutionStatus, "active">;
      readonly clearedAt?: string | null;
      readonly clearReason?: string | null;
    },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE hold_resolution_states
            SET status = ?,
                cleared_at = ?,
                clear_reason = ?
          WHERE token_id = ?
            AND status = 'active'`,
      )
      .run(input.status, input.clearedAt ?? null, input.clearReason ?? null, String(tokenId));
    return result.changes > 0;
  }
}

interface HoldResolutionRow {
  readonly id: string;
  readonly token_id: string;
  readonly condition_id: string | null;
  readonly position_id: string | null;
  readonly source_order_id: string | null;
  readonly source_signal_id: string | null;
  readonly status: HoldResolutionStatus;
  readonly marker_created_at: string;
  readonly expected_resolution_at: string | null;
  readonly attempt_count_for_redeem: number;
  readonly exit_pnl_pct: number | null;
  readonly stale_reason: string;
  readonly liveness_verdict: string;
  readonly metadata_json: string | null;
}

function mapHoldResolutionState(row: HoldResolutionRow): HoldResolutionState {
  return {
    id: row.id,
    tokenId: createTokenId(row.token_id),
    conditionId: row.condition_id == null ? null : createConditionId(row.condition_id),
    positionId: row.position_id == null ? null : createPositionId(row.position_id),
    sourceOrderId: row.source_order_id == null ? null : createOrderId(row.source_order_id),
    sourceSignalId: row.source_signal_id,
    status: row.status,
    markerCreatedAt: row.marker_created_at,
    expectedResolutionAt: row.expected_resolution_at,
    attemptCountForRedeem: row.attempt_count_for_redeem,
    exitPnlPct: row.exit_pnl_pct,
    staleReason: row.stale_reason,
    livenessVerdict: row.liveness_verdict,
    metadata: parseMetadata(row.metadata_json),
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (raw == null || raw.trim() === "") return null;
  const parsed = JSON.parse(raw) as unknown;
  return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}
