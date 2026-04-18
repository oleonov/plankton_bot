import type Database from "better-sqlite3";
import type { MarketRepository, Market } from "@plankton/domain";
import type { TokenId } from "@plankton/domain";
import { createTokenId } from "@plankton/domain";
import type { Regime } from "@plankton/domain";

export class SqliteMarketRepository implements MarketRepository {
  constructor(private readonly db: Database.Database) {}

  save(market: Market): void {
    this.db
      .prepare(
        `INSERT INTO markets
         (token_id, condition_id, slug, event_slug, question, outcome, outcome_index,
          regime, horizon, end_date, active, tradable, tick_size, neg_risk,
          event_market_count, selection_status, selection_winning_rule_id,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           condition_id = excluded.condition_id,
           slug = excluded.slug,
           event_slug = COALESCE(excluded.event_slug, markets.event_slug),
           question = excluded.question,
           outcome = excluded.outcome,
           outcome_index = excluded.outcome_index,
           regime = excluded.regime,
           horizon = excluded.horizon,
           end_date = excluded.end_date,
           active = excluded.active,
           tradable = excluded.tradable,
           tick_size = excluded.tick_size,
           neg_risk = excluded.neg_risk,
           event_market_count = excluded.event_market_count,
           selection_status = excluded.selection_status,
           selection_winning_rule_id = excluded.selection_winning_rule_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        market.tokenId,
        market.conditionId,
        market.slug,
        market.eventSlug,
        market.question,
        market.outcome,
        market.outcomeIndex,
        market.regime,
        market.horizon,
        market.endDate,
        market.active ? 1 : 0,
        market.tradable ? 1 : 0,
        market.tickSize,
        market.negRisk ? 1 : 0,
        market.eventMarketCount ?? 1,
        market.selectionStatus ?? "unknown",
        market.selectionWinningRuleId ?? null,
        market.createdAt,
        market.updatedAt,
      );
  }

  findByTokenId(tokenId: TokenId): Market | null {
    const row = this.db.prepare("SELECT * FROM markets WHERE token_id = ?").get(tokenId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToMarket(row) : null;
  }

  findByTokenIds(tokenIds: TokenId[]): Market[] {
    if (tokenIds.length === 0) return [];
    const placeholders = tokenIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM markets WHERE token_id IN (${placeholders})`)
      .all(...tokenIds) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMarket(r));
  }

  findByConditionId(conditionId: string): Market[] {
    const rows = this.db
      .prepare("SELECT * FROM markets WHERE condition_id = ?")
      .all(conditionId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMarket(r));
  }

  findActive(): Market[] {
    const rows = this.db.prepare("SELECT * FROM markets WHERE active = 1").all() as Record<
      string,
      unknown
    >[];
    return rows.map((r) => this.rowToMarket(r));
  }

  findAll(): Market[] {
    const rows = this.db.prepare("SELECT * FROM markets").all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMarket(r));
  }

  deactivate(tokenId: TokenId): void {
    this.db
      .prepare(`UPDATE markets SET active = 0, updated_at = datetime('now') WHERE token_id = ?`)
      .run(tokenId);
  }

  findTrackedForPricing(): Market[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM markets
         WHERE active = 1
           AND (
             tradable = 1
             OR EXISTS (SELECT 1 FROM positions
                        WHERE positions.token_id = markets.token_id
                          AND positions.status IN ('open','dust'))
             OR EXISTS (SELECT 1 FROM orders
                        WHERE orders.token_id = markets.token_id
                          AND orders.status IN ('pending','open'))
           )
         ORDER BY markets.token_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMarket(r));
  }

  findEventMarketCountBySlug(slug: string): number | null {
    const row = this.db
      .prepare(`SELECT event_market_count FROM markets WHERE slug = ? LIMIT 1`)
      .get(slug) as { event_market_count: number } | undefined;
    return row?.event_market_count ?? null;
  }

  private rowToMarket(row: Record<string, unknown>): Market {
    return {
      tokenId: createTokenId(row.token_id as string),
      conditionId: row.condition_id as string,
      slug: row.slug as string,
      eventSlug: (row.event_slug as string) ?? null,
      question: row.question as string,
      outcome: row.outcome as string,
      outcomeIndex: (row.outcome_index as number) ?? null,
      regime: (row.regime as Regime) ?? null,
      horizon: (row.horizon as string) ?? null,
      endDate: (row.end_date as string) ?? null,
      active: row.active === 1,
      tradable: row.tradable == null ? row.active === 1 : row.tradable === 1,
      tickSize: row.tick_size as number,
      negRisk: row.neg_risk === 1,
      eventMarketCount: (row.event_market_count as number | null) ?? 1,
      selectionStatus: (row.selection_status as import("@plankton/domain").SelectionStatus) ?? "unknown",
      selectionWinningRuleId: (row.selection_winning_rule_id as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
