import type Database from "better-sqlite3";
import type { PositionRepository, Position } from "@krabs/domain";
import type { TokenId, PositionId, OrderSide, PositionStatus } from "@krabs/domain";
import { createPositionId, createTokenId, createConditionId } from "@krabs/domain";
import { ledgerInstant } from "../db-timestamp.js";

export class SqlitePositionRepository implements PositionRepository {
  constructor(private readonly db: Database.Database) {}

  save(position: Position): void {
    this.db
      .prepare(
        `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price,
          cost_basis_usdc, current_value_usdc, realized_pnl, status,
          entry_style, entry_lane, exit_owner, opened_at, closed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         -- NB: exit_owner is intentionally OMITTED from DO UPDATE — it is
         -- write-once on INSERT (sticky ownership, Release A). Never overwrite it.
         ON CONFLICT(position_id) DO UPDATE SET
           size = excluded.size,
           avg_entry_price = excluded.avg_entry_price,
           cost_basis_usdc = excluded.cost_basis_usdc,
           current_value_usdc = excluded.current_value_usdc,
           realized_pnl = excluded.realized_pnl,
           status = excluded.status,
           entry_style = excluded.entry_style,
           entry_lane = excluded.entry_lane,
           closed_at = excluded.closed_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        position.positionId,
        position.tokenId,
        position.conditionId,
        position.side,
        position.size,
        position.avgEntryPrice,
        position.costBasisUsdc,
        position.currentValueUsdc,
        position.realizedPnl,
        position.status,
        position.entryStyle,
        position.entryLane ?? null,
        position.exitOwner ?? null,
        position.openedAt,
        position.closedAt,
        position.updatedAt,
      );
  }

  // "Newest row wins" is decided in three places that must not disagree on a row they BOTH rank:
  // migration 032's repair UPDATE, `rebuildTokenPosition` in startup-position-adoption.ts, and
  // here. Their scopes differ deliberately — 032 ranks only 'open' × 'open' (the pairs its unique
  // index forbids going forward), the other two rank every non-closed row — so this is agreement on
  // the ordering, not on the population.
  //
  // All three rank by INSTANT (032 inlines `ledgerInstant()`, since migrations cannot import it):
  // ranking by raw text would pick a different winner for a same-day space-vs-ISO pair — ' ' (0x20)
  // sorts below 'T' (0x54), putting the chronologically newer space row last. `position_id DESC`
  // then makes ties deterministic instead of SQLite-implementation-defined, matching the other two.
  // Production `opened_at` is 100% canonical ISO today (680/680 measured 2026-08-06), but
  // `DEFAULT (datetime('now'))` survives on the production column and cannot be dropped without
  // recreating the table on the 18.38 GB live ledger.
  findByTokenId(tokenId: TokenId): Position | null {
    const row = this.db
      .prepare(
        `SELECT * FROM positions
         WHERE token_id = ? AND status != 'closed'
         ORDER BY ${ledgerInstant("opened_at")} DESC, position_id DESC LIMIT 1`,
      )
      .get(tokenId) as Record<string, unknown> | undefined;
    return row ? this.rowToPosition(row) : null;
  }

  findById(positionId: PositionId): Position | null {
    const row = this.db.prepare("SELECT * FROM positions WHERE position_id = ?").get(positionId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToPosition(row) : null;
  }

  // Unlike findByTokenId this returns every row, and all three callers are order-independent
  // (a Set of ids, a `.find()` by id, a `.length` check) — so the ordering is for consistency, not
  // a fix. It stays because the next caller to reach for `[0]` must get the same winner the three
  // ranking sites above pick, and sorting a handful of rows per token costs nothing. That is also
  // why `position_id DESC` is here: without the tie-breaker `[0]` would fall back to SQLite's
  // implementation-defined order on equal `opened_at` and disagree with the very sites it exists
  // to match.
  findActiveByTokenId(tokenId: TokenId): Position[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM positions
         WHERE token_id = ? AND status != 'closed'
         ORDER BY ${ledgerInstant("opened_at")} DESC, position_id DESC`,
      )
      .all(tokenId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToPosition(r));
  }

  findOpen(): Position[] {
    const rows = this.db.prepare("SELECT * FROM positions WHERE status = 'open'").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToPosition(r));
  }

  findDust(): Position[] {
    const rows = this.db.prepare("SELECT * FROM positions WHERE status = 'dust'").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToPosition(r));
  }

  findAll(): Position[] {
    const rows = this.db.prepare("SELECT * FROM positions").all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToPosition(r));
  }

  findOpenByEntryStyle(entryStyle: string): Position[] {
    const rows = this.db
      .prepare("SELECT * FROM positions WHERE status = 'open' AND entry_style = ?")
      .all(entryStyle) as Record<string, unknown>[];
    return rows.map((r) => this.rowToPosition(r));
  }

  private rowToPosition(row: Record<string, unknown>): Position {
    return {
      positionId: createPositionId(row.position_id as string),
      tokenId: createTokenId(row.token_id as string),
      conditionId: createConditionId(row.condition_id as string),
      side: row.side as OrderSide,
      size: row.size as number,
      avgEntryPrice: row.avg_entry_price as number,
      costBasisUsdc: row.cost_basis_usdc as number,
      currentValueUsdc: (row.current_value_usdc as number) ?? null,
      liquidationValueUsdc: (row.liquidation_value_usdc as number) ?? null,
      liquidationPrice: (row.liquidation_price as number) ?? null,
      liquidationDepthExhausted:
        row.liquidation_depth_exhausted == null ? null : row.liquidation_depth_exhausted === 1,
      liquidationValueUpdatedAt: (row.liquidation_value_updated_at as string) ?? null,
      realizedPnl: row.realized_pnl as number,
      status: row.status as PositionStatus,
      entryStyle: (row.entry_style as "probe" | "maker") ?? null,
      entryLane: (row.entry_lane as "GATE" | "R23") ?? null,
      exitOwner: (row.exit_owner as "profile" | "bounce") ?? null,
      openedAt: row.opened_at as string,
      closedAt: (row.closed_at as string) ?? null,
      updatedAt: row.updated_at as string,
    };
  }
}
