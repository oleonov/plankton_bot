import type Database from "better-sqlite3";
import type {
  ClientOrderId,
  LegPhase,
  LegStateTransition,
  LegStateTransitionAction,
  LegStateTransitionRepository,
  PositionId,
  TokenId,
} from "@plankton/domain";
import {
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
} from "@plankton/domain";

interface LegStateTransitionRow {
  id: number;
  token_id: string;
  position_id: string | null;
  fill_id: string | null;
  order_id: string | null;
  client_order_id: string | null;
  condition_id: string | null;
  from_phase: string;
  to_phase: string;
  action: string;
  price: number | null;
  size: number | null;
  size_usdc: number | null;
  from_buy_count: number;
  from_sell_count: number;
  to_buy_count: number;
  to_sell_count: number;
  reason: string;
  occurred_at: string;
  created_at: string;
}

function toModel(row: LegStateTransitionRow): LegStateTransition {
  return {
    id: row.id,
    tokenId: createTokenId(row.token_id),
    positionId: row.position_id ? createPositionId(row.position_id) : null,
    fillId: row.fill_id ? createFillId(row.fill_id) : null,
    orderId: row.order_id ? createOrderId(row.order_id) : null,
    clientOrderId: row.client_order_id ? (row.client_order_id as ClientOrderId) : null,
    conditionId: row.condition_id ? createConditionId(row.condition_id) : null,
    fromPhase: row.from_phase as LegPhase,
    toPhase: row.to_phase as LegPhase,
    action: row.action as LegStateTransitionAction,
    price: row.price,
    size: row.size,
    sizeUsdc: row.size_usdc,
    fromBuyCount: row.from_buy_count,
    fromSellCount: row.from_sell_count,
    toBuyCount: row.to_buy_count,
    toSellCount: row.to_sell_count,
    reason: row.reason,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

export class SqliteLegStateTransitionRepository implements LegStateTransitionRepository {
  constructor(private readonly db: Database.Database) {}

  insert(transition: Omit<LegStateTransition, "id" | "createdAt">): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO leg_state_transitions
           (token_id, position_id, fill_id, order_id, client_order_id, condition_id,
            from_phase, to_phase, action, price, size, size_usdc,
            from_buy_count, from_sell_count, to_buy_count, to_sell_count,
            reason, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        String(transition.tokenId),
        transition.positionId ? String(transition.positionId) : null,
        transition.fillId ? String(transition.fillId) : null,
        transition.orderId ? String(transition.orderId) : null,
        transition.clientOrderId ? String(transition.clientOrderId) : null,
        transition.conditionId ? String(transition.conditionId) : null,
        transition.fromPhase,
        transition.toPhase,
        transition.action,
        transition.price,
        transition.size,
        transition.sizeUsdc,
        transition.fromBuyCount,
        transition.fromSellCount,
        transition.toBuyCount,
        transition.toSellCount,
        transition.reason,
        transition.occurredAt,
      );
    return result.changes > 0;
  }

  findByTokenId(tokenId: TokenId, limit = 200): LegStateTransition[] {
    const rows = this.db
      .prepare(
        `SELECT *
           FROM leg_state_transitions
          WHERE token_id = ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT ?`,
      )
      .all(String(tokenId), limit) as LegStateTransitionRow[];
    return rows.map(toModel);
  }

  findByPositionId(positionId: PositionId, limit = 200): LegStateTransition[] {
    const rows = this.db
      .prepare(
        `SELECT *
           FROM leg_state_transitions
          WHERE position_id = ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT ?`,
      )
      .all(String(positionId), limit) as LegStateTransitionRow[];
    return rows.map(toModel);
  }
}
