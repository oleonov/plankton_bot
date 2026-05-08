import type Database from "better-sqlite3";
import type { OrderPriceCooldown, OrderPriceCooldownRepository } from "@plankton/domain";
import type { OrderSide, TokenId } from "@plankton/domain";
import { createTokenId } from "@plankton/domain";

interface OrderPriceCooldownRow {
  token_id: string;
  side: OrderSide;
  price_x10000: number;
  stale_cancel_count: number;
  cooldown_until_ts_utc: number;
  last_event_ts_utc: number;
}

export class SqliteOrderPriceCooldownRepository implements OrderPriceCooldownRepository {
  constructor(private readonly db: Database.Database) {}

  get(tokenId: TokenId, side: OrderSide, priceX10000: number): OrderPriceCooldown | null {
    const row = this.db
      .prepare(
        `SELECT * FROM order_price_cooldowns
         WHERE token_id = ? AND side = ? AND price_x10000 = ?`,
      )
      .get(String(tokenId), side, priceX10000) as OrderPriceCooldownRow | undefined;
    return row ? toModel(row) : null;
  }

  upsert(cooldown: OrderPriceCooldown): void {
    this.db
      .prepare(
        `INSERT INTO order_price_cooldowns
         (token_id, side, price_x10000, stale_cancel_count,
          cooldown_until_ts_utc, last_event_ts_utc)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id, side, price_x10000) DO UPDATE SET
           stale_cancel_count = excluded.stale_cancel_count,
           cooldown_until_ts_utc = excluded.cooldown_until_ts_utc,
           last_event_ts_utc = excluded.last_event_ts_utc`,
      )
      .run(
        String(cooldown.tokenId),
        cooldown.side,
        cooldown.priceX10000,
        cooldown.staleCancelCount,
        cooldown.cooldownUntilTsUtc,
        cooldown.lastEventTsUtc,
      );
  }

  delete(tokenId: TokenId, side: OrderSide, priceX10000: number): void {
    this.db
      .prepare(
        `DELETE FROM order_price_cooldowns
         WHERE token_id = ? AND side = ? AND price_x10000 = ?`,
      )
      .run(String(tokenId), side, priceX10000);
  }

  deleteByTokenId(tokenId: TokenId): number {
    const result = this.db
      .prepare("DELETE FROM order_price_cooldowns WHERE token_id = ?")
      .run(String(tokenId));
    return Number(result.changes);
  }

  findAll(): OrderPriceCooldown[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM order_price_cooldowns
         ORDER BY cooldown_until_ts_utc DESC, token_id ASC, side ASC, price_x10000 ASC`,
      )
      .all() as OrderPriceCooldownRow[];
    return rows.map(toModel);
  }
}

function toModel(row: OrderPriceCooldownRow): OrderPriceCooldown {
  return {
    tokenId: createTokenId(row.token_id),
    side: row.side,
    priceX10000: row.price_x10000,
    staleCancelCount: row.stale_cancel_count,
    cooldownUntilTsUtc: row.cooldown_until_ts_utc,
    lastEventTsUtc: row.last_event_ts_utc,
  };
}
