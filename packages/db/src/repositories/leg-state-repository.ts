import type Database from "better-sqlite3";
import type { LegStateRepository } from "@plankton/domain";
import type { LegState, TokenId } from "@plankton/domain";
import { createTokenId } from "@plankton/domain";

interface LegStateRow {
  token_id: string;
  buy_count: number;
  sell_count: number;
  last_action: string;
  first_trade_price: number;
  first_trade_at: string;
  last_trade_at: string;
  updated_at: string;
}

function toModel(row: LegStateRow): LegState {
  return {
    tokenId: createTokenId(row.token_id),
    buyCount: row.buy_count,
    sellCount: row.sell_count,
    lastAction: row.last_action as "BUY" | "SELL",
    firstEntryFillPrice: row.first_trade_price,
    firstTradeAt: row.first_trade_at,
    lastTradeAt: row.last_trade_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteLegStateRepository implements LegStateRepository {
  constructor(private readonly db: Database.Database) {}

  get(tokenId: TokenId): LegState | null {
    const row = this.db
      .prepare("SELECT * FROM leg_states WHERE token_id = ?")
      .get(String(tokenId)) as LegStateRow | undefined;
    return row ? toModel(row) : null;
  }

  upsert(state: LegState): void {
    this.db
      .prepare(
        `INSERT INTO leg_states (token_id, buy_count, sell_count, last_action, first_trade_price, first_trade_at, last_trade_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           buy_count = excluded.buy_count,
           sell_count = excluded.sell_count,
           last_action = excluded.last_action,
           first_trade_price = excluded.first_trade_price,
           first_trade_at = excluded.first_trade_at,
           last_trade_at = excluded.last_trade_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        String(state.tokenId),
        state.buyCount,
        state.sellCount,
        state.lastAction,
        state.firstEntryFillPrice,
        state.firstTradeAt,
        state.lastTradeAt,
        state.updatedAt,
      );
  }

  delete(tokenId: TokenId): void {
    this.db.prepare("DELETE FROM leg_states WHERE token_id = ?").run(String(tokenId));
  }

  getAll(): LegState[] {
    const rows = this.db.prepare("SELECT * FROM leg_states").all() as LegStateRow[];
    return rows.map(toModel);
  }
}
