import type Database from "better-sqlite3";
import type {
  MarketRepository,
  Market,
  MarketSignatureUpdate,
  MarketScoreUpdate,
  SignatureThresholds,
  TargetPricingRouteFact,
  TrackedForPricing,
  V4SelectionResult,
  V4AdmissionTelemetrySnapshot,
} from "@krabs/domain";
import type { TokenId } from "@krabs/domain";
import {
  createTokenId,
  createV4AdmissionTelemetrySnapshot,
  evaluateV4Selection,
  recordV4AdmissionTelemetry,
} from "@krabs/domain";
import type { Regime } from "@krabs/domain";
import { nowIso } from "../db-timestamp.js";

// Track B (§4.2d): tags persist as a JSON string array in `tags_json`. A
// corrupt string must not fail a market read — fall back to null.
function parseTagsJson(value: unknown): readonly string[] | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

// Rank for entry-candidate ordering: lower rank = higher priority.
// Only these three statuses are ever WS-subscribed as entry-candidates.
const SELECTION_STATUS_RANK: Record<string, number> = {
  matched_include: 0,
  step2_fallback_include: 1,
  unknown: 2,
};

// Step 3 (audit doc §D5/§F5): a non-null `score` only counts for ranking
// when its source snapshot is fresh (≤ 4h old). Stale scores are kept on
// the row but are *not* allowed to outrank a fresh lower score.
const FEATURE_FRESHNESS_MS = 4 * 60 * 60 * 1000;
const R30_HIGH_CONFIDENCE_SCORE = 0.3699;
const R30_ACTIVE_POOL_SCORE = 0.2529;
const V4_CATEGORY_PRIORITY_BIAS: Record<string, number> = {
  "crypto-btc": 1_200,
  "crypto-eth": 1_100,
  "crypto-sol": 950,
  "crypto-xrp": 900,
  geopolitics: 1_000,
  politics: 800,
  "price-binary": 700,
  stocks: 600,
  esports: 450,
  entertainment: 350,
  weather: 250,
  other: 100,
};

type SelectionFeatures = {
  liquidity: number | null;
  volume24h: number | null;
  bestBid: number | null;
  bestAsk: number | null;
};

type PricingCandidate = {
  market: Market;
  features: SelectionFeatures;
};
type MarketBatch = readonly Market[];
type SignatureBatch = readonly MarketSignatureUpdate[];

const MARKET_SIGNATURE_JOIN = "LEFT JOIN market_signature_features sf ON sf.token_id = m.token_id";
const MARKET_ROW_PROJECTION = `m.*,
  sf.sig_mid AS side_sig_mid,
  sf.sig_cheap_mid AS side_sig_cheap_mid,
  sf.sig_liquidity AS side_sig_liquidity,
  sf.sig_vol24h AS side_sig_vol24h,
  sf.sig_features_at AS side_sig_features_at,
  CASE WHEN sf.token_id IS NOT NULL AND (
    m.sig_features_at IS NULL OR (
      sf.sig_features_at IS NOT NULL AND sf.sig_features_at >= m.sig_features_at
    )
  ) THEN 1 ELSE 0 END AS use_side_signature,
  CASE WHEN sf.updated_at > m.updated_at THEN sf.updated_at ELSE m.updated_at END
    AS resolved_updated_at`;

// Reserved plankton-signature tier (spec 2026-07-01 §4.1/§4.2): fresh markets
// have no market_snapshots to rank from, so they carry their own Gamma-at-
// discovery features (`sig_*`) and get a live slot ahead of the V4 split.
const DEFAULT_SIGNATURE_RESERVE = 300;
const DEFAULT_SIGNATURE: SignatureThresholds = {
  minLiquidity: 500,
  minMid: 0.01,
  maxMid: 0.3,
  minRemainingDays: 14,
  minVol24h: 50,
  minTick: 0.001,
  featureTtlMs: 24 * 60 * 60 * 1000,
};

function matchesSignature(market: Market, thr: SignatureThresholds, nowMs: number): boolean {
  if (market.sigFeaturesAt == null) return false;
  const capMs = Date.parse(market.sigFeaturesAt);
  if (!Number.isFinite(capMs) || nowMs - capMs > thr.featureTtlMs) return false;
  if (market.tickSize !== thr.minTick) return false;
  const liq = market.sigLiquidity;
  if (liq == null || liq < thr.minLiquidity) return false;
  const vol = market.sigVol24h;
  if (vol == null || vol < thr.minVol24h) return false;
  const cheap = market.sigCheapMid;
  if (cheap == null || cheap <= thr.minMid || cheap > thr.maxMid) return false;
  const remainingDays = horizonDaysFromNow(market.endDate, nowMs);
  if (remainingDays == null || remainingDays < thr.minRemainingDays) return false;
  // R9 category gate: use the V4 category classifier — an unrecognized (null)
  // category is treated as blocked (junk categories map to null).
  const category = evaluateV4Selection({
    slug: market.slug,
    eventSlug: market.eventSlug,
    question: market.question,
    liquidity: market.sigLiquidity ?? null,
    volume24h: market.sigVol24h ?? null,
    bestBid: null,
    bestAsk: null,
  }).category;
  return category != null;
}

// Step 3 (audit doc §D3/§P2) **score-column ownership invariant**.
// `score`, `score_model_version`, `scored_at`, `features_captured_at` are
// written exclusively by `updateScoresBatch`. The market-upsert path below
// must NOT mention these columns in either the INSERT column list or the
// ON CONFLICT DO UPDATE SET clause. SQLite's UPSERT semantic preserves
// columns omitted from SET, so saveBatch will not clobber a previously
// written score. The market-repository-score test suite enforces this by
// scanning UPSERT_MARKET_SQL for any of the four column names.
//
// `gamma_created_at` is null-preserving via COALESCE: once captured from a
// Gamma response it must not be wiped if a later upsert (e.g. CLOB-side path
// or a Gamma response missing the field) carries null. Repair flows that
// need to overwrite go through an explicit admin path, not saveBatch.
const UPSERT_MARKET_SQL = `INSERT INTO markets
         (token_id, condition_id, slug, event_slug, question, outcome, outcome_index,
          regime, horizon, end_date, active, tradable, tick_size, neg_risk,
          event_market_count, selection_status, selection_winning_rule_id,
          gamma_created_at, group_item_title, group_item_threshold, tags_json,
          sig_mid, sig_cheap_mid, sig_liquidity, sig_vol24h, sig_features_at,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           group_item_title = excluded.group_item_title,
           group_item_threshold = excluded.group_item_threshold,
           tags_json = excluded.tags_json,
           updated_at = excluded.updated_at`;

const UPSERT_SIGNATURE_SQL = `INSERT INTO market_signature_features
  (token_id, sig_mid, sig_cheap_mid, sig_liquidity, sig_vol24h, sig_features_at, updated_at)
SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM markets WHERE token_id = ?)
ON CONFLICT(token_id) DO UPDATE SET
  sig_mid = excluded.sig_mid,
  sig_cheap_mid = excluded.sig_cheap_mid,
  sig_liquidity = excluded.sig_liquidity,
  sig_vol24h = excluded.sig_vol24h,
  sig_features_at = excluded.sig_features_at,
  updated_at = excluded.updated_at`;

export class SqliteMarketRepository implements MarketRepository {
  private upsertStmt: Database.Statement | null = null;
  private signatureUpdateStmt: Database.Statement | null = null;
  private writeBatchTx:
    | ((fullUpserts: MarketBatch, signatureUpdates: SignatureBatch) => void)
    | null = null;
  private v4AdmissionTelemetry = createV4AdmissionTelemetrySnapshot();

  constructor(private readonly db: Database.Database) {}

  getV4AdmissionTelemetrySnapshot(): V4AdmissionTelemetrySnapshot {
    return this.v4AdmissionTelemetry;
  }

  private getUpsertStmt(): Database.Statement {
    if (!this.upsertStmt) this.upsertStmt = this.db.prepare(UPSERT_MARKET_SQL);
    return this.upsertStmt;
  }

  private bindSignatureUpsert(
    stmt: Database.Statement,
    update: Market | MarketSignatureUpdate,
  ): void {
    stmt.run(
      update.tokenId,
      update.sigMid ?? null,
      update.sigCheapMid ?? null,
      update.sigLiquidity ?? null,
      update.sigVol24h ?? null,
      update.sigFeaturesAt ?? null,
      update.updatedAt,
      update.tokenId,
    );
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
      market.eventMarketCount,
      market.selectionStatus ?? "unknown",
      market.selectionWinningRuleId ?? null,
      market.gammaCreatedAt ?? null,
      market.groupItemTitle ?? null,
      market.groupItemThreshold ?? null,
      market.tags != null ? JSON.stringify(market.tags) : null,
      market.sigMid ?? null,
      market.sigCheapMid ?? null,
      market.sigLiquidity ?? null,
      market.sigVol24h ?? null,
      market.sigFeaturesAt ?? null,
      market.createdAt,
      market.updatedAt,
    );
  }

  save(market: Market): void {
    this.saveBatch([market]);
  }

  saveBatch(markets: readonly Market[]): void {
    this.saveBatchWithSignatureUpdates(markets, []);
  }

  saveBatchWithSignatureUpdates(
    fullUpserts: readonly Market[],
    signatureUpdates: readonly MarketSignatureUpdate[],
  ): void {
    if (fullUpserts.length === 0 && signatureUpdates.length === 0) return;
    if (!this.signatureUpdateStmt) this.signatureUpdateStmt = this.db.prepare(UPSERT_SIGNATURE_SQL);
    const signatureStmt = this.signatureUpdateStmt;
    const upsertStmt = this.getUpsertStmt();
    if (!this.writeBatchTx) {
      this.writeBatchTx = this.db.transaction((full: MarketBatch, signatures: SignatureBatch) => {
        for (const update of signatures) this.bindSignatureUpsert(signatureStmt, update);
        for (const market of full) {
          this.bindUpsert(upsertStmt, market);
          this.bindSignatureUpsert(signatureStmt, market);
        }
      });
    }
    this.writeBatchTx(fullUpserts, signatureUpdates);
  }

  findByTokenId(tokenId: TokenId): Market | null {
    const row = this.db
      .prepare(
        `SELECT ${MARKET_ROW_PROJECTION} FROM markets m ${MARKET_SIGNATURE_JOIN}
          WHERE m.token_id = ?`,
      )
      .get(tokenId) as Record<string, unknown> | undefined;
    return row ? this.rowToMarket(row) : null;
  }

  findByTokenIds(tokenIds: TokenId[]): Market[] {
    if (tokenIds.length === 0) return [];
    const placeholders = tokenIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT ${MARKET_ROW_PROJECTION} FROM markets m ${MARKET_SIGNATURE_JOIN}
          WHERE m.token_id IN (${placeholders})`,
      )
      .all(...tokenIds) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMarket(r));
  }

  findByConditionId(conditionId: string): Market[] {
    const rows = this.db
      .prepare(
        `SELECT ${MARKET_ROW_PROJECTION} FROM markets m ${MARKET_SIGNATURE_JOIN}
          WHERE m.condition_id = ?`,
      )
      .all(conditionId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToMarket(r));
  }

  findActive(): Market[] {
    const rows = this.db
      .prepare(
        `SELECT ${MARKET_ROW_PROJECTION} FROM markets m ${MARKET_SIGNATURE_JOIN}
          WHERE m.active = 1`,
      )
      .all() as Record<string, unknown>[];
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
    const rows = this.db
      .prepare(`SELECT ${MARKET_ROW_PROJECTION} FROM markets m ${MARKET_SIGNATURE_JOIN}`)
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMarket(r));
  }

  deactivate(tokenId: TokenId): void {
    this.db
      .prepare(`UPDATE markets SET active = 0, updated_at = ? WHERE token_id = ?`)
      .run(nowIso(), tokenId);
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
        `SELECT ${MARKET_ROW_PROJECTION} FROM markets m ${MARKET_SIGNATURE_JOIN}
         WHERE m.active = 1
           AND (
             m.tradable = 1
             OR EXISTS (SELECT 1 FROM positions
                        WHERE positions.token_id = m.token_id
                          AND positions.status IN ('open','dust'))
             OR EXISTS (SELECT 1 FROM orders
                        WHERE orders.token_id = m.token_id
                          AND orders.status IN ('pending','open'))
           )
         ORDER BY m.token_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMarket(r));
  }

  findTrackedForPricingTiered(opts: {
    maxTokens: number;
    signatureReserve?: number;
    signature?: SignatureThresholds;
    reserveSignature?: boolean;
    targetTokenIds?: ReadonlySet<string>;
  }): TrackedForPricing {
    // Single SQL scan: pull every market that is either execution-critical
    // (open position/order, regardless of selection_status — safety invariant)
    // or an active+tradable entry candidate with a non-excluded selection status.
    // `matched_exclude` / `fallback_exclude` are intentionally kept out of the
    // tradable universe so they cannot consume entryCandidates/discoveryOnly
    // budget.
    const rows = this.db
      .prepare(
        `SELECT ${MARKET_ROW_PROJECTION},
                latest.liquidity AS latest_liquidity,
                latest.volume_24h AS latest_volume_24h,
                latest.best_bid AS latest_best_bid,
                latest.best_ask AS latest_best_ask,
                CASE WHEN (
                  EXISTS (SELECT 1 FROM positions
                          WHERE positions.token_id = m.token_id
                            AND positions.status IN ('open','dust'))
                  OR EXISTS (SELECT 1 FROM orders
                             WHERE orders.token_id = m.token_id
                               AND orders.status IN ('pending','open'))
                ) THEN 1 ELSE 0 END AS is_critical
         FROM markets m
         ${MARKET_SIGNATURE_JOIN}
         LEFT JOIN market_snapshots latest
           ON latest.id = (
             SELECT ms.id
               FROM market_snapshots ms
              WHERE ms.token_id = m.token_id
              ORDER BY ms.captured_at DESC
              LIMIT 1
           )
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
    const tradableOnly: PricingCandidate[] = [];

    for (const row of rows) {
      const market = this.rowToMarket(row);
      if (row.is_critical === 1) {
        executionCritical.push(market);
      } else {
        tradableOnly.push({
          market,
          features: {
            liquidity: readNullableNumber(row.latest_liquidity),
            volume24h: readNullableNumber(row.latest_volume_24h),
            bestBid: readNullableNumber(row.latest_best_bid),
            bestAsk: readNullableNumber(row.latest_best_ask),
          },
        });
      }
    }

    // Deduplicate: execution-critical markets may also be tradable.
    const criticalIds = new Set(executionCritical.map((m) => String(m.tokenId)));

    // Sort tradable-only by Plankton-priority composite score (ADR-035):
    // R30 score tiers first, then tick/horizon/category tie-breaks, then
    // existing operator selection rank. Execution-critical markets were
    // already pulled out above and always keep hard priority over this list.
    // Scanner rewrites updated_at on every full scan pass, so using updated_at
    // here would churn the WS tier even when the universe itself is stable,
    // forcing the pricing loop to repoll a new unknown set every few seconds.
    //
    // `effectiveScore` treats stale scores (features_captured_at < now − 4h)
    // as null so a stale non-null score never outranks a fresh lower score.
    const candidates = tradableOnly.filter((candidate) => {
      return !criticalIds.has(String(candidate.market.tokenId));
    });
    const nowMs = Date.now();

    // Reserved plankton-signature tier (spec 2026-07-01 §4.1, gated by
    // opts.reserveSignature since 2026-07-02): computed BEFORE the V4
    // admit/reject split so signature-matching markets get a live slot
    // regardless of V4 outcome. In live mode (reserveSignature !== false,
    // the default) the matched set is removed from the V4 pool so it is never
    // double-counted or re-evaluated by V4 admission. In shadow mode
    // (reserveSignature === false) reservation is disabled entirely:
    // `planktonSignature` becomes a measurement projection only — matched
    // markets stay in the V4 pool so entryCandidates/discoveryOnly come back
    // byte-for-byte identical to a call without the signature feature.
    const reserveSignature = opts.reserveSignature !== false;
    const sigThr = opts.signature ?? DEFAULT_SIGNATURE;
    const sigReserve = opts.signatureReserve ?? DEFAULT_SIGNATURE_RESERVE;
    const remainingAfterCritical = Math.max(0, opts.maxTokens - executionCritical.length);
    const sigMatched = candidates
      .filter((c) => matchesSignature(c.market, sigThr, nowMs))
      .sort((a, b) => {
        const ga = a.market.gammaCreatedAt ?? "";
        const gb = b.market.gammaCreatedAt ?? "";
        if (ga !== gb) return ga < gb ? 1 : -1; // DESC: newest first
        return String(a.market.tokenId).localeCompare(String(b.market.tokenId));
      });
    const sigSlots = Math.min(sigReserve, remainingAfterCritical);
    const planktonSignature = sigMatched.slice(0, sigSlots).map((c) => c.market);
    const sigIds = new Set(planktonSignature.map((mk) => String(mk.tokenId)));
    const v4Pool = reserveSignature
      ? candidates.filter((c) => !sigIds.has(String(c.market.tokenId)))
      : candidates;

    const admittedCandidates: PricingCandidate[] = [];
    const rejectedCandidates: PricingCandidate[] = [];
    const v4ResultByToken = new Map<string, V4SelectionResult>();
    let v4AdmissionTelemetry = createV4AdmissionTelemetrySnapshot(new Date(nowMs).toISOString());
    for (const candidate of v4Pool) {
      const result = evaluateV4Selection({
        slug: candidate.market.slug,
        eventSlug: candidate.market.eventSlug,
        question: candidate.market.question,
        liquidity: candidate.features.liquidity,
        volume24h: candidate.features.volume24h,
        bestBid: candidate.features.bestBid,
        bestAsk: candidate.features.bestAsk,
      });
      v4ResultByToken.set(String(candidate.market.tokenId), result);
      v4AdmissionTelemetry = recordV4AdmissionTelemetry(v4AdmissionTelemetry, result);
      if (result.admit) admittedCandidates.push(candidate);
      else rejectedCandidates.push(candidate);
    }
    this.v4AdmissionTelemetry = v4AdmissionTelemetry;
    const planktonPriorityByToken = new Map(
      admittedCandidates.map((candidate) => [
        String(candidate.market.tokenId),
        planktonPriorityScore(candidate.market, candidate.features, nowMs),
      ]),
    );
    admittedCandidates.sort((a, b) => {
      const pa = planktonPriorityByToken.get(String(a.market.tokenId)) ?? 0;
      const pb = planktonPriorityByToken.get(String(b.market.tokenId)) ?? 0;
      if (pa !== pb) return pb - pa;
      const rankA = SELECTION_STATUS_RANK[a.market.selectionStatus ?? "unknown"] ?? 99;
      const rankB = SELECTION_STATUS_RANK[b.market.selectionStatus ?? "unknown"] ?? 99;
      if (rankA !== rankB) return rankA - rankB;
      const sa = effectiveScore(a.market, nowMs);
      const sb = effectiveScore(b.market, nowMs);
      if (sa !== sb) {
        if (sa === null) return 1;
        if (sb === null) return -1;
        return sb - sa;
      }
      if (a.market.createdAt !== b.market.createdAt) {
        return a.market.createdAt < b.market.createdAt ? 1 : -1;
      }
      return String(a.market.tokenId).localeCompare(String(b.market.tokenId));
    });

    // In shadow mode planktonSignature never consumed a slot from the V4 pool,
    // so it must not shrink the entryCandidates budget either — the split has
    // to match a baseline call with no signature feature at all.
    const remaining = Math.max(
      0,
      opts.maxTokens - executionCritical.length - (reserveSignature ? planktonSignature.length : 0),
    );
    const entryCandidates = admittedCandidates.slice(0, remaining).map((c) => c.market);
    const discoveryOnly = [
      ...admittedCandidates.slice(remaining).map((c) => c.market),
      ...rejectedCandidates.map((c) => c.market),
    ];

    // signatureOverflow in live mode must reflect the FINAL live set (spec
    // 2026-07-01 §4.5): a sigMatched market that missed its reserved signature
    // slot may still win a live entryCandidate slot via V4 admission, so it is
    // covered and must not be double-counted as overflow. In shadow mode there
    // is no reserved/live set to compare against — this is simply a projection
    // of what live mode would overflow, for the coverage metric.
    let signatureOverflow: number;
    if (reserveSignature) {
      const liveIds = new Set([
        ...executionCritical.map((m) => String(m.tokenId)),
        ...planktonSignature.map((m) => String(m.tokenId)),
        ...entryCandidates.map((m) => String(m.tokenId)),
      ]);
      signatureOverflow = sigMatched.filter((c) => !liveIds.has(String(c.market.tokenId))).length;
    } else {
      signatureOverflow = Math.max(0, sigMatched.length - planktonSignature.length);
    }

    const result: TrackedForPricing = {
      executionCritical,
      planktonSignature,
      entryCandidates,
      discoveryOnly,
      discoveryCapacityCount: Math.max(0, admittedCandidates.length - remaining),
      signatureOverflow,
    };
    if (opts.targetTokenIds) {
      const admittedRankByToken = new Map(
        admittedCandidates.map((candidate, index) => [String(candidate.market.tokenId), index + 1]),
      );
      const signatureMatchedIds = new Set(
        sigMatched.map((candidate) => String(candidate.market.tokenId)),
      );
      result.targetRoutes = [
        ...executionCritical,
        ...candidates.map((candidate) => candidate.market),
      ]
        .filter((market) => opts.targetTokenIds!.has(String(market.tokenId)))
        .map((market) =>
          buildTargetRouteFact(market, {
            nowMs,
            remaining,
            reserveSignature,
            criticalIds,
            sigIds,
            signatureMatchedIds,
            admittedRankByToken,
            v4ResultByToken,
          }),
        );
    }
    return result;
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
      eventMarketCount: row.event_market_count as number,
      selectionStatus:
        (row.selection_status as import("@krabs/domain").SelectionStatus) ?? "unknown",
      selectionWinningRuleId: (row.selection_winning_rule_id as string) ?? null,
      gammaCreatedAt: (row.gamma_created_at as string | null) ?? null,
      groupItemTitle: (row.group_item_title as string | null) ?? null,
      groupItemThreshold: (row.group_item_threshold as string | null) ?? null,
      tags: parseTagsJson(row.tags_json),
      score: (row.score as number | null) ?? null,
      scoreModelVersion: (row.score_model_version as string | null) ?? null,
      scoredAt: (row.scored_at as string | null) ?? null,
      featuresCapturedAt: (row.features_captured_at as string | null) ?? null,
      sigMid:
        (row[row.use_side_signature === 1 ? "side_sig_mid" : "sig_mid"] as number | null) ?? null,
      sigCheapMid:
        (row[row.use_side_signature === 1 ? "side_sig_cheap_mid" : "sig_cheap_mid"] as
          | number
          | null) ?? null,
      sigLiquidity:
        (row[row.use_side_signature === 1 ? "side_sig_liquidity" : "sig_liquidity"] as
          | number
          | null) ?? null,
      sigVol24h:
        (row[row.use_side_signature === 1 ? "side_sig_vol24h" : "sig_vol24h"] as number | null) ??
        null,
      sigFeaturesAt:
        (row[row.use_side_signature === 1 ? "side_sig_features_at" : "sig_features_at"] as
          | string
          | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: (row.resolved_updated_at as string | undefined) ?? (row.updated_at as string),
    };
  }

  // Step 3 (audit doc §P2). Single transaction, prepared statement, owns
  // the four score columns exclusively. Rows whose token_id is unknown are
  // silently skipped via UPDATE ... WHERE token_id = ?.
  private updateScoreStmt: Database.Statement | null = null;
  private updateScoresTx:
    | ((batch: readonly MarketScoreUpdate[], stmt: Database.Statement) => void)
    | null = null;

  updateScoresBatch(updates: Iterable<MarketScoreUpdate>): void {
    const batch = Array.isArray(updates) ? updates : Array.from(updates);
    if (batch.length === 0) return;
    if (!this.updateScoreStmt) {
      this.updateScoreStmt = this.db.prepare(
        `UPDATE markets
            SET score = ?,
                score_model_version = ?,
                scored_at = ?,
                features_captured_at = ?
          WHERE token_id = ?`,
      );
    }
    if (!this.updateScoresTx) {
      this.updateScoresTx = this.db.transaction(
        (rows: readonly MarketScoreUpdate[], stmt: Database.Statement) => {
          for (const u of rows) {
            stmt.run(u.score, u.modelVersion, u.scoredAt, u.featuresCapturedAt, u.tokenId);
          }
        },
      );
    }
    this.updateScoresTx(batch, this.updateScoreStmt);
  }

  // Narrow tick-size correction. Touches ONLY tick_size + updated_at so the
  // broad saveBatch ownership invariant for score columns is not disturbed.
  private updateTickSizeStmt: Database.Statement | null = null;

  updateTickSize(conditionId: string, tickSize: number): void {
    if (!this.updateTickSizeStmt) {
      this.updateTickSizeStmt = this.db.prepare(
        `UPDATE markets SET tick_size = ?, updated_at = ? WHERE condition_id = ?`,
      );
    }
    const updatedAt = new Date().toISOString();
    this.updateTickSizeStmt.run(tickSize, updatedAt, conditionId);
  }
}

type TargetRouteContext = Readonly<{
  nowMs: number;
  remaining: number;
  reserveSignature: boolean;
  criticalIds: ReadonlySet<string>;
  sigIds: ReadonlySet<string>;
  signatureMatchedIds: ReadonlySet<string>;
  admittedRankByToken: ReadonlyMap<string, number>;
  v4ResultByToken: ReadonlyMap<string, V4SelectionResult>;
}>;

function buildTargetRouteFact(market: Market, ctx: TargetRouteContext): TargetPricingRouteFact {
  const tokenId = String(market.tokenId);
  const selection = ctx.v4ResultByToken.get(tokenId) ?? null;
  const admissionRank = ctx.admittedRankByToken.get(tokenId) ?? null;
  const route = ctx.criticalIds.has(tokenId)
    ? "execution_critical"
    : ctx.reserveSignature && ctx.sigIds.has(tokenId)
      ? "signature_live"
      : selection?.admit === true && admissionRank != null && admissionRank <= ctx.remaining
        ? "entry_candidate"
        : selection?.admit === true
          ? "discovery_capacity"
          : "discovery_v4_reject";
  return {
    tokenId,
    conditionId: String(market.conditionId),
    outcome: market.outcome,
    outcomeIndex: market.outcomeIndex ?? null,
    capturedAtMs: ctx.nowMs,
    basis: "post_detection_route_evaluation",
    route,
    v4Category: selection?.category ?? null,
    v4Reason: selection?.reason ?? null,
    admissionRank,
    capacitySlots: selection?.admit === true ? ctx.remaining : null,
    signatureMatched: ctx.signatureMatchedIds.has(tokenId),
  };
}

function effectiveScore(market: Market, nowMs: number): number | null {
  if (market.score == null) return null;
  if (!market.featuresCapturedAt) return null;
  const capturedMs = Date.parse(market.featuresCapturedAt);
  if (!Number.isFinite(capturedMs)) return null;
  if (nowMs - capturedMs > FEATURE_FRESHNESS_MS) return null;
  return market.score;
}

function planktonPriorityScore(market: Market, features: SelectionFeatures, nowMs: number): number {
  const score = effectiveScore(market, nowMs);
  const v4 = evaluateV4Selection({
    slug: market.slug,
    eventSlug: market.eventSlug,
    question: market.question,
    liquidity: features.liquidity,
    volume24h: features.volume24h,
    bestBid: features.bestBid,
    bestAsk: features.bestAsk,
  });
  const horizonDays = horizonDaysFromNow(market.endDate, nowMs);
  let priority = 0;

  if (score != null) {
    priority += score * 100_000;
    if (score >= R30_HIGH_CONFIDENCE_SCORE) {
      priority += 1_000_000;
    } else if (score >= R30_ACTIVE_POOL_SCORE) {
      priority += 500_000;
    }
  }

  if (market.tickSize === 0.001) priority += 50_000;
  if (horizonDays != null && horizonDays > 30) priority += 25_000;
  if (v4.category) priority += V4_CATEGORY_PRIORITY_BIAS[v4.category] ?? 0;

  return priority;
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function horizonDaysFromNow(endDate: string | null, nowMs: number): number | null {
  if (!endDate) return null;
  const endMs = Date.parse(endDate);
  if (!Number.isFinite(endMs)) return null;
  return (endMs - nowMs) / 86_400_000;
}
