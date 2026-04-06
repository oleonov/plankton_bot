import type Database from "better-sqlite3";
import type { MarketRepository, Market } from "@plankton/domain";
import type { TokenId, FamilyId } from "@plankton/domain";
import { createTokenId, createFamilyId } from "@plankton/domain";
import type { Regime } from "@plankton/domain";

export class SqliteMarketRepository implements MarketRepository {
  constructor(private readonly db: Database.Database) {}

  save(market: Market): void {
    this.db
      .prepare(
        `INSERT INTO markets
         (token_id, condition_id, slug, event_slug, question, outcome, family_id, family_key,
          regime, horizon, end_date, active, tick_size, neg_risk, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           condition_id = excluded.condition_id,
           slug = excluded.slug,
           event_slug = COALESCE(excluded.event_slug, markets.event_slug),
           question = excluded.question,
           outcome = excluded.outcome,
           family_id = excluded.family_id,
           family_key = excluded.family_key,
           regime = excluded.regime,
           horizon = excluded.horizon,
           end_date = excluded.end_date,
           active = excluded.active,
           tick_size = excluded.tick_size,
           neg_risk = excluded.neg_risk,
           updated_at = excluded.updated_at`,
      )
      .run(
        market.tokenId,
        market.conditionId,
        market.slug,
        market.eventSlug,
        market.question,
        market.outcome,
        market.familyId,
        market.familyKey,
        market.regime,
        market.horizon,
        market.endDate,
        market.active ? 1 : 0,
        market.tickSize,
        market.negRisk ? 1 : 0,
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

  findByFamily(familyId: FamilyId): Market[] {
    const rows = this.db
      .prepare("SELECT * FROM markets WHERE family_id = ?")
      .all(familyId) as Record<string, unknown>[];
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

  private rowToMarket(row: Record<string, unknown>): Market {
    return {
      tokenId: createTokenId(row.token_id as string),
      conditionId: row.condition_id as string,
      slug: row.slug as string,
      eventSlug: (row.event_slug as string) ?? null,
      question: row.question as string,
      outcome: row.outcome as string,
      familyId: row.family_id ? createFamilyId(row.family_id as string) : null,
      familyKey: (row.family_key as string) ?? null,
      regime: (row.regime as Regime) ?? null,
      horizon: (row.horizon as string) ?? null,
      endDate: (row.end_date as string) ?? null,
      active: row.active === 1,
      tickSize: row.tick_size as number,
      negRisk: row.neg_risk === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
