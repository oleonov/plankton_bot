import type Database from "better-sqlite3";
import type { MarketRepository, Market, TrackedForPricing } from "@plankton/domain";
import type { TokenId } from "@plankton/domain";
import { createTokenId } from "@plankton/domain";
import type { Regime } from "@plankton/domain";

// Rank for entry-candidate ordering: lower rank = higher priority.
// Only these three statuses are ever WS-subscribed as entry-candidates.
const SELECTION_STATUS_RANK: Record<string, number> = {
  matched_include: 0,
  step2_fallback_include: 1,
  unknown: 2,
};

// `gamma_created_at` is null-preserving via COALESCE: once captured from a
// Gamma response it must not be wiped if a later upsert (e.g. CLOB-side path
// or a Gamma response missing the field) carries null. Repair flows that
// need to overwrite go through an explicit admin path, not saveBatch.
const UPSERT_MARKET_SQL = `INSERT INTO markets
         (token_id, condition_id, slug, event_slug, question, outcome, outcome_index,
          regime, horizon, end_date, active, tradable, tick_size, neg_risk,
          event_market_count, selection_status, selection_winning_rule_id,
          gamma_created_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           gamma_created_at = COALESCE(markets.gamma_created_at, excluded.gamma_created_at),
           updated_at = excluded.updated_at`;

export class SqliteMarketRepository implements MarketRepository {
  private upsertStmt: Database.Statement | null = null;
  private upsertManyTx:
    | ((
        markets: readonly Market[],
        bind: (stmt: Database.Statement, market: Market) => void,
      ) => void)
    | null = null;

  constructor(private readonly db: Database.Database) {}

  private getUpsertStmt(): Database.Statement {
    if (!this.upsertStmt) this.upsertStmt = this.db.prepare(UPSERT_MARKET_SQL);
    return this.upsertStmt;
  }

  private bindUpsert(stmt: Database.Statement, market: Market): void {
    stmt.run(
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
      market.gammaCreatedAt ?? null,
      market.createdAt,
      market.updatedAt,
    );
  }

  save(market: Market): void {
    this.bindUpsert(this.getUpsertStmt(), market);
  }

  saveBatch(markets: readonly Market[]): void {
    if (markets.length === 0) return;
    const stmt = this.getUpsertStmt();
    if (!this.upsertManyTx) {
      this.upsertManyTx = this.db.transaction(
        (batch: readonly Market[], bind: (stmt: Database.Statement, market: Market) => void) => {
          for (const m of batch) bind(stmt, m);
        },
      );
    }
    this.upsertManyTx(markets, this.bindUpsert.bind(this));
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

  *iterateActiveTokenIds(): IterableIterator<TokenId> {
    const stmt = this.db.prepare("SELECT token_id FROM markets WHERE active = 1");
    for (const row of stmt.iterate() as Iterable<{ token_id: string }>) {
      yield createTokenId(row.token_id);
    }
  }

  *iterateAllTokenIds(): IterableIterator<TokenId> {
    const stmt = this.db.prepare("SELECT token_id FROM markets");
    for (const row of stmt.iterate() as Iterable<{ token_id: string }>) {
      yield createTokenId(row.token_id);
    }
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

  deactivateMissing(
    discoveredTokenIds: ReadonlySet<string>,
    preservedTokenIds: ReadonlySet<string>,
    updatedAt: string,
  ): number {
    const staleTokenIds: string[] = [];
    for (const tokenId of this.iterateActiveTokenIds()) {
      const key = String(tokenId);
      if (discoveredTokenIds.has(key)) continue;
      if (preservedTokenIds.has(key)) continue;
      staleTokenIds.push(key);
    }
    if (staleTokenIds.length === 0) return 0;

    const updateStmt = this.db.prepare(
      `UPDATE markets SET active = 0, updated_at = ? WHERE token_id = ?`,
    );
    const tx = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) {
        updateStmt.run(updatedAt, id);
      }
    });
    tx(staleTokenIds);
    return staleTokenIds.length;
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

  findTrackedForPricingTiered(opts: { maxTokens: number }): TrackedForPricing {
    // Single SQL scan: pull every market that is either execution-critical
    // (open position/order, regardless of selection_status — safety invariant)
    // or an active+tradable entry candidate with a non-excluded selection status.
    // `matched_exclude` / `fallback_exclude` are intentionally kept out of the
    // tradable universe so they cannot consume entryCandidates/discoveryOnly
    // budget.
    const rows = this.db
      .prepare(
        `SELECT m.*,
                CASE WHEN (
                  EXISTS (SELECT 1 FROM positions
                          WHERE positions.token_id = m.token_id
                            AND positions.status IN ('open','dust'))
                  OR EXISTS (SELECT 1 FROM orders
                             WHERE orders.token_id = m.token_id
                               AND orders.status IN ('pending','open'))
                ) THEN 1 ELSE 0 END AS is_critical
         FROM markets m
         WHERE m.active = 1
           AND (
             (
               m.tradable = 1
               AND (
                 m.selection_status IS NULL
                 OR m.selection_status NOT IN ('matched_exclude','fallback_exclude')
               )
             )
             OR EXISTS (SELECT 1 FROM positions
                        WHERE positions.token_id = m.token_id
                          AND positions.status IN ('open','dust'))
             OR EXISTS (SELECT 1 FROM orders
                        WHERE orders.token_id = m.token_id
                          AND orders.status IN ('pending','open'))
           )
         ORDER BY m.created_at DESC, m.token_id ASC`,
      )
      .all() as (Record<string, unknown> & { is_critical: number })[];

    const executionCritical: Market[] = [];
    const tradableOnly: Market[] = [];

    for (const row of rows) {
      if (row.is_critical === 1) {
        executionCritical.push(this.rowToMarket(row));
      } else {
        tradableOnly.push(this.rowToMarket(row));
      }
    }

    // Deduplicate: execution-critical markets may also be tradable.
    const criticalIds = new Set(executionCritical.map((m) => String(m.tokenId)));

    // Sort tradable-only by selection_status rank ASC, then created_at DESC,
    // then token_id ASC. Scanner rewrites updated_at on every full scan pass,
    // so using updated_at here would churn the WS tier even when the universe
    // itself is stable, forcing the pricing loop to repoll a new unknown set
    // every few seconds.
    const candidates = tradableOnly.filter((m) => !criticalIds.has(String(m.tokenId)));
    candidates.sort((a, b) => {
      const rankA = SELECTION_STATUS_RANK[a.selectionStatus ?? "unknown"] ?? 99;
      const rankB = SELECTION_STATUS_RANK[b.selectionStatus ?? "unknown"] ?? 99;
      if (rankA !== rankB) return rankA - rankB;
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return String(a.tokenId).localeCompare(String(b.tokenId));
    });

    const remaining = Math.max(0, opts.maxTokens - executionCritical.length);
    const entryCandidates = candidates.slice(0, remaining);
    const discoveryOnly = candidates.slice(remaining);

    return { executionCritical, entryCandidates, discoveryOnly };
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
      selectionStatus:
        (row.selection_status as import("@plankton/domain").SelectionStatus) ?? "unknown",
      selectionWinningRuleId: (row.selection_winning_rule_id as string) ?? null,
      gammaCreatedAt: (row.gamma_created_at as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
