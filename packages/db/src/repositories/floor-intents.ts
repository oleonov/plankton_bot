import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConditionId, OrderId, PositionId, TokenId } from "@krabs/domain";
import { createConditionId, createOrderId, createPositionId, createTokenId } from "@krabs/domain";

export type FloorIntentStatus = "active" | "consumed" | "superseded" | "cancelled";

export interface FloorIntent {
  readonly id: string;
  readonly tokenId: TokenId;
  readonly conditionId: ConditionId | null;
  readonly positionId: PositionId | null;
  readonly sourceOrderId: OrderId | null;
  readonly sourceSignalId: string | null;
  readonly status: FloorIntentStatus;
  readonly targetPrice: number;
  readonly floorRatioApplied: number | null;
  readonly normalSignalFloorWouldHaveBlocked: boolean | null;
  readonly normalSignalFloorPrice: number | null;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly consumedAt: string | null;
  readonly consumingOrderId: OrderId | null;
  readonly clearedAt: string | null;
  readonly clearReason: string | null;
  readonly metadata: Record<string, unknown> | null;
}

export interface FloorIntentInsertInput {
  readonly tokenId: TokenId;
  readonly conditionId?: ConditionId | null;
  readonly positionId?: PositionId | null;
  readonly sourceOrderId?: OrderId | null;
  readonly sourceSignalId?: string | null;
  readonly targetPrice: number;
  readonly floorRatioApplied?: number | null;
  readonly normalSignalFloorWouldHaveBlocked?: boolean | null;
  readonly normalSignalFloorPrice?: number | null;
  readonly attemptCount?: number;
  readonly createdAt: string;
  readonly expiresAt?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

export interface FloorIntentInsertResult {
  readonly inserted: boolean;
  readonly intent: FloorIntent;
}

export class SqliteFloorIntentRepository {
  constructor(private readonly db: Database.Database) {}

  insertActive(input: FloorIntentInsertInput): FloorIntentInsertResult {
    const id = randomUUID();
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO floor_intents
           (id, token_id, condition_id, position_id, source_order_id, source_signal_id,
            status, target_price, floor_ratio_applied, normal_signal_floor_would_have_blocked,
            normal_signal_floor_price, attempt_count, created_at, expires_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        String(input.tokenId),
        input.conditionId == null ? null : String(input.conditionId),
        input.positionId == null ? null : String(input.positionId),
        input.sourceOrderId == null ? null : String(input.sourceOrderId),
        input.sourceSignalId ?? null,
        input.targetPrice,
        input.floorRatioApplied ?? null,
        input.normalSignalFloorWouldHaveBlocked == null
          ? null
          : input.normalSignalFloorWouldHaveBlocked
            ? 1
            : 0,
        input.normalSignalFloorPrice ?? null,
        input.attemptCount ?? 0,
        input.createdAt,
        input.expiresAt ?? null,
        input.metadata == null ? null : JSON.stringify(input.metadata),
      );

    const intent = this.findActiveByTokenId(input.tokenId);
    if (!intent) {
      throw new Error(`failed to insert or load active floor_intent for ${input.tokenId}`);
    }
    return { inserted: result.changes > 0, intent };
  }

  findActiveByTokenId(tokenId: TokenId): FloorIntent | null {
    const row = this.db
      .prepare(
        `SELECT *
           FROM floor_intents
          WHERE token_id = ?
            AND status = 'active'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get(String(tokenId)) as FloorIntentRow | undefined;
    return row ? mapFloorIntent(row) : null;
  }

  consumeActive(
    tokenId: TokenId,
    input: {
      readonly consumedAt: string;
      readonly consumingOrderId?: OrderId | null;
    },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE floor_intents
            SET status = 'consumed',
                consumed_at = ?,
                consuming_order_id = ?
          WHERE token_id = ?
            AND status = 'active'`,
      )
      .run(input.consumedAt, input.consumingOrderId ?? null, String(tokenId));
    return result.changes > 0;
  }

  clearActive(
    tokenId: TokenId,
    input: {
      readonly status: "superseded" | "cancelled";
      readonly clearedAt?: string | null;
      readonly clearReason?: string | null;
    },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE floor_intents
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

interface FloorIntentRow {
  readonly id: string;
  readonly token_id: string;
  readonly condition_id: string | null;
  readonly position_id: string | null;
  readonly source_order_id: string | null;
  readonly source_signal_id: string | null;
  readonly status: FloorIntentStatus;
  readonly target_price: number;
  readonly floor_ratio_applied: number | null;
  readonly normal_signal_floor_would_have_blocked: number | null;
  readonly normal_signal_floor_price: number | null;
  readonly attempt_count: number;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly consumed_at: string | null;
  readonly consuming_order_id: string | null;
  readonly cleared_at: string | null;
  readonly clear_reason: string | null;
  readonly metadata_json: string | null;
}

function mapFloorIntent(row: FloorIntentRow): FloorIntent {
  return {
    id: row.id,
    tokenId: createTokenId(row.token_id),
    conditionId: row.condition_id == null ? null : createConditionId(row.condition_id),
    positionId: row.position_id == null ? null : createPositionId(row.position_id),
    sourceOrderId: row.source_order_id == null ? null : createOrderId(row.source_order_id),
    sourceSignalId: row.source_signal_id,
    status: row.status,
    targetPrice: row.target_price,
    floorRatioApplied: row.floor_ratio_applied,
    normalSignalFloorWouldHaveBlocked:
      row.normal_signal_floor_would_have_blocked == null
        ? null
        : row.normal_signal_floor_would_have_blocked === 1,
    normalSignalFloorPrice: row.normal_signal_floor_price,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    consumingOrderId:
      row.consuming_order_id == null ? null : createOrderId(row.consuming_order_id),
    clearedAt: row.cleared_at,
    clearReason: row.clear_reason,
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
