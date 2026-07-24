import type Database from "better-sqlite3";
import type { PositionRepository, Position } from "@krabs/domain";
import type { TokenId, OrderSide, PositionStatus } from "@krabs/domain";
import { createPositionId, createTokenId, createConditionId } from "@krabs/domain";

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

  findByTokenId(tokenId: TokenId): Position | null {
    const row = this.db
      .prepare(
        `SELECT * FROM positions
         WHERE token_id = ? AND status != 'closed'
         ORDER BY opened_at DESC LIMIT 1`,
      )
      .get(tokenId) as Record<string, unknown> | undefined;
    return row ? this.rowToPosition(row) : null;
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
