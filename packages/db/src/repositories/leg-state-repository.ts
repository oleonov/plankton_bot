import type Database from "better-sqlite3";
import type { LegStateRepository } from "@krabs/domain";
import type { LegState, TokenId } from "@krabs/domain";
import { createTokenId } from "@krabs/domain";

interface LegStateRow {
  token_id: string;
  buy_count: number;
  sell_count: number;
  last_action: string;
  first_trade_price: number;
  first_trade_at: string;
  last_trade_at: string;
  updated_at: string;
  cumulative_buy_size: number | null;
  cumulative_buy_notional: number | null;
  cumulative_sell_size: number | null;
  consecutive_sell_residual_rejects: number | null;
  abandoned_at_price: number | null;
  abandoned_at_ts: string | null;
  reprice_chain_count_24h: number | null;
  reprice_chain_window_start_ts: string | null;
  reprice_chain_events_24h_json: string | null;
}

function toModel(row: LegStateRow): LegState {
  return {
    tokenId: createTokenId(row.token_id),
    buyCount: row.buy_count,
    sellCount: row.sell_count,
    lastAction: row.last_action as "BUY" | "SELL",
    firstTradePrice: row.first_trade_price,
    firstTradeAt: row.first_trade_at,
    lastTradeAt: row.last_trade_at,
    updatedAt: row.updated_at,
    cumulativeBuySize: row.cumulative_buy_size ?? 0,
    cumulativeBuyNotional: row.cumulative_buy_notional ?? 0,
    cumulativeSellSize: row.cumulative_sell_size ?? 0,
    consecutiveSellResidualRejects: row.consecutive_sell_residual_rejects ?? 0,
    abandonedAtPrice: row.abandoned_at_price ?? null,
    abandonedAtTs: row.abandoned_at_ts ?? null,
    repriceChainCount24h: row.reprice_chain_count_24h ?? 0,
    repriceChainWindowStartTs: row.reprice_chain_window_start_ts ?? null,
    repriceChainEvents24hJson: row.reprice_chain_events_24h_json ?? null,
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
        `INSERT INTO leg_states (
           token_id, buy_count, sell_count, last_action,
           first_trade_price, first_trade_at, last_trade_at, updated_at,
           cumulative_buy_size, cumulative_buy_notional, cumulative_sell_size,
           consecutive_sell_residual_rejects, abandoned_at_price, abandoned_at_ts,
           reprice_chain_count_24h, reprice_chain_window_start_ts,
           reprice_chain_events_24h_json
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           buy_count = excluded.buy_count,
           sell_count = excluded.sell_count,
           last_action = excluded.last_action,
           first_trade_price = excluded.first_trade_price,
           first_trade_at = excluded.first_trade_at,
           last_trade_at = excluded.last_trade_at,
           updated_at = excluded.updated_at,
           cumulative_buy_size = excluded.cumulative_buy_size,
           cumulative_buy_notional = excluded.cumulative_buy_notional,
           cumulative_sell_size = excluded.cumulative_sell_size,
           consecutive_sell_residual_rejects = excluded.consecutive_sell_residual_rejects,
           abandoned_at_price = excluded.abandoned_at_price,
           abandoned_at_ts = excluded.abandoned_at_ts,
           reprice_chain_count_24h = excluded.reprice_chain_count_24h,
           reprice_chain_window_start_ts = excluded.reprice_chain_window_start_ts,
           reprice_chain_events_24h_json = excluded.reprice_chain_events_24h_json`,
      )
      .run(
        String(state.tokenId),
        state.buyCount,
        state.sellCount,
        state.lastAction,
        state.firstTradePrice,
        state.firstTradeAt,
        state.lastTradeAt,
        state.updatedAt,
        state.cumulativeBuySize ?? 0,
        state.cumulativeBuyNotional ?? 0,
        state.cumulativeSellSize ?? 0,
        state.consecutiveSellResidualRejects ?? 0,
        state.abandonedAtPrice ?? null,
        state.abandonedAtTs ?? null,
        state.repriceChainCount24h ?? 0,
        state.repriceChainWindowStartTs ?? null,
        state.repriceChainEvents24hJson ?? null,
      );
  }

  delete(tokenId: TokenId): void {
    this.db.prepare("DELETE FROM leg_states WHERE token_id = ?").run(String(tokenId));
  }

  getAll(): LegState[] {
    const rows = this.db.prepare("SELECT * FROM leg_states").all() as LegStateRow[];
    return rows.map(toModel);
  }

  incrementSellResidualReject(
    tokenId: TokenId,
    nowIso: string,
    abandon?: { threshold: number; price: number },
  ): { count: number; markedAbandoned: boolean } {
    const run = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `UPDATE leg_states
           SET consecutive_sell_residual_rejects = COALESCE(consecutive_sell_residual_rejects, 0) + 1,
               updated_at = ?
           WHERE token_id = ?
           RETURNING consecutive_sell_residual_rejects AS count`,
        )
        .get(nowIso, String(tokenId)) as { count: number } | undefined;
      const count = row?.count ?? 0;
      if (!abandon || count < abandon.threshold) return { count, markedAbandoned: false };

      const marked = this.db
        .prepare(
          `UPDATE leg_states
           SET abandoned_at_price = ?,
               abandoned_at_ts = ?,
               updated_at = ?
           WHERE token_id = ?
             AND abandoned_at_ts IS NULL
           RETURNING 1 AS marked`,
        )
        .get(abandon.price, nowIso, nowIso, String(tokenId)) as { marked: number } | undefined;
      return { count, markedAbandoned: marked != null };
    });

    return run();
  }

  markAbandoned(tokenId: TokenId, price: number, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE leg_states
         SET abandoned_at_price = ?,
             abandoned_at_ts = ?,
             updated_at = ?
         WHERE token_id = ?`,
      )
      .run(price, nowIso, nowIso, String(tokenId));
  }

  resetAbandoned(tokenId: TokenId, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE leg_states
         SET abandoned_at_price = NULL,
             abandoned_at_ts = NULL,
             consecutive_sell_residual_rejects = 0,
             updated_at = ?
         WHERE token_id = ?`,
      )
      .run(nowIso, String(tokenId));
  }

  applyRepriceChainEvent(
    tokenId: TokenId,
    eventsJson: string,
    count: number,
    windowStartIso: string,
    nowIso: string,
  ): void {
    this.db
      .prepare(
        `UPDATE leg_states
         SET reprice_chain_events_24h_json = ?,
             reprice_chain_count_24h = ?,
             reprice_chain_window_start_ts = ?,
             updated_at = ?
         WHERE token_id = ?`,
      )
      .run(eventsJson, count, windowStartIso, nowIso, String(tokenId));
  }
}
