import type Database from "better-sqlite3";
import type {
  MakerShadowFillKind,
  MakerShadowOrder,
  MakerShadowOrderRepository,
  MakerShadowStage,
  MakerShadowStageUpdate,
  TokenId,
} from "@krabs/domain";
import { createTokenId } from "@krabs/domain";

interface MakerShadowOrderRow {
  shadow_order_id: string;
  token_id: string;
  condition_id: string;
  buy_px: number;
  harvest_px: number;
  posted_at: string;
  fill_deadline: string;
  stage: string;
  fill_kind: string | null;
  fill_px: number | null;
  mark_px: number | null;
  net_mark: number | null;
  updated_at: string;
}

const OPEN_STAGES_PLACEHOLDER = "('pending','filled')";

function toModel(row: MakerShadowOrderRow): MakerShadowOrder {
  return {
    shadowOrderId: row.shadow_order_id,
    tokenId: createTokenId(row.token_id),
    conditionId: row.condition_id,
    buyPx: row.buy_px,
    harvestPx: row.harvest_px,
    postedAt: row.posted_at,
    fillDeadline: row.fill_deadline,
    stage: row.stage as MakerShadowStage,
    fillKind: (row.fill_kind as MakerShadowFillKind | null) ?? null,
    fillPx: row.fill_px,
    markPx: row.mark_px,
    netMark: row.net_mark,
    updatedAt: row.updated_at,
  };
}

export class SqliteMakerShadowOrderRepository implements MakerShadowOrderRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(order: MakerShadowOrder): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO maker_shadow_orders
           (shadow_order_id, token_id, condition_id, buy_px, harvest_px,
            posted_at, fill_deadline, stage, fill_kind, fill_px, mark_px, net_mark, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        order.shadowOrderId,
        String(order.tokenId),
        order.conditionId,
        order.buyPx,
        order.harvestPx,
        order.postedAt,
        order.fillDeadline,
        order.stage,
        order.fillKind ?? null,
        order.fillPx ?? null,
        order.markPx ?? null,
        order.netMark ?? null,
        order.updatedAt,
      );
  }

  findOpen(): MakerShadowOrder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM maker_shadow_orders
          WHERE stage IN ${OPEN_STAGES_PLACEHOLDER}
          ORDER BY posted_at ASC`,
      )
      .all() as MakerShadowOrderRow[];
    return rows.map(toModel);
  }

  findOpenByToken(tokenId: TokenId): MakerShadowOrder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM maker_shadow_orders
          WHERE stage IN ${OPEN_STAGES_PLACEHOLDER}
            AND token_id = ?
          ORDER BY posted_at ASC`,
      )
      .all(String(tokenId)) as MakerShadowOrderRow[];
    return rows.map(toModel);
  }

  updateStage(shadowOrderId: string, update: MakerShadowStageUpdate): void {
    this.db
      .prepare(
        `UPDATE maker_shadow_orders
            SET stage = ?,
                fill_kind = COALESCE(?, fill_kind),
                fill_px   = COALESCE(?, fill_px),
                mark_px   = COALESCE(?, mark_px),
                net_mark  = COALESCE(?, net_mark),
                updated_at = ?
          WHERE shadow_order_id = ?`,
      )
      .run(
        update.stage,
        update.fillKind ?? null,
        update.fillPx ?? null,
        update.markPx ?? null,
        update.netMark ?? null,
        update.updatedAt,
        shadowOrderId,
      );
  }

  pruneExpired(beforeIso: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM maker_shadow_orders
          WHERE stage = 'expired'
            AND updated_at < ?`,
      )
      .run(beforeIso);
    return result.changes;
  }
}
