/**
 * Soft-Ranking Score Module — Step 3 (audit doc §D4 / §P3).
 *
 * Subscribes to `NormalizedMarketUpdated`. For each Step2-included market in
 * the batch, builds the standardized feature row, runs logistic-regression
 * inference, and writes (score, modelVersion, scoredAt, featuresCapturedAt)
 * back to the `markets` row via `MarketRepository.updateScoresBatch`.
 *
 * The module is the sole owner of the four score columns (audit doc §D3
 * ownership invariant — enforced by repository test).
 *
 * Disabled-state contract (audit doc §F1): if the artifact is missing or
 * fails validation, callers pass `model = null`; the module enters a no-op
 * state and `healthCheck` reports `disabled`. Runtime startup never fails
 * because of a missing artifact — the rollback story (§F14) keys on this.
 *
 * Telemetry (audit doc §D7) is intentionally out-of-band: the module triggers
 * a debounced DB-aggregated snapshot via the optional
 * `recomputeScoreDistribution` hook. Counts are derived from a single SQL
 * query against `markets`, not from in-memory state — this keeps stale-score
 * counts honest under restarts and event lulls.
 */

import type {
  EventBus,
  LogisticModel,
  MarketRepository,
  MarketScoreUpdate,
  NormalizedMarket,
  RuntimeModule,
} from "@plankton/domain";
import { buildFeatureRow, predictScore } from "@plankton/domain";
import type { Logger } from "../../logger.js";

/**
 * Subset of the score-distribution snapshot surfaced via healthCheck (audit
 * doc §F7). The hook returns it (or void) so a snapshot writer can both
 * persist the row AND let this module reflect the freshest aggregates.
 */
export interface SoftRankingHealthSnapshot {
  readonly modelVersion: string | null;
  readonly scoredMarkets: number;
  readonly staleMarkets: number;
  readonly mean: number | null;
  readonly capturedAt: string;
}

export interface SoftRankingScoreModuleDeps {
  bus: EventBus;
  marketRepo: MarketRepository;
  log: Logger;
  model: LogisticModel | null;
  /**
   * Optional hook fired (debounced) after a batch was scored. Wires up the
   * DB-aggregated snapshot writer (audit doc §D7 / §P4). May return a
   * `SoftRankingHealthSnapshot` so healthCheck can echo the latest aggregates.
   * Errors thrown here are caught and logged at warn level — they must never
   * break the score-update path.
   */
  recomputeScoreDistribution?: () =>
    | void
    | SoftRankingHealthSnapshot
    | Promise<void | SoftRankingHealthSnapshot>;
  /** Override the debounce window (ms). Defaults to 60_000. */
  flushIntervalMs?: number;
  /** Override the now() source — used by tests. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 60_000;

const STEP2_INCLUDED = new Set<string>(["matched_include", "step2_fallback_include"]);

interface SummaryCounters {
  events: number;
  scoredRows: number;
  skippedNonStep2Included: number;
  missingFeatures: number;
  scoringErrors: number;
}

function emptyCounters(): SummaryCounters {
  return {
    events: 0,
    scoredRows: 0,
    skippedNonStep2Included: 0,
    missingFeatures: 0,
    scoringErrors: 0,
  };
}

export class SoftRankingScoreModule implements RuntimeModule {
  private readonly bus: EventBus;
  private readonly marketRepo: MarketRepository;
  private readonly log: Logger;
  private readonly model: LogisticModel | null;
  private readonly recomputeScoreDistribution:
    | (() =>
        | void
        | SoftRankingHealthSnapshot
        | Promise<void | SoftRankingHealthSnapshot>)
    | null;
  private readonly flushIntervalMs: number;
  private readonly now: () => number;

  private unsubscribe: (() => void) | null = null;
  private lastFlushAtMs = 0;
  private flushPending = false;
  private summary: SummaryCounters = emptyCounters();
  private summaryLastResetAtMs = 0;
  private lastSnapshot: SoftRankingHealthSnapshot | null = null;

  constructor(deps: SoftRankingScoreModuleDeps) {
    this.bus = deps.bus;
    this.marketRepo = deps.marketRepo;
    this.log = deps.log.child({ module: "soft-ranking-score" });
    this.model = deps.model;
    this.recomputeScoreDistribution = deps.recomputeScoreDistribution ?? null;
    this.flushIntervalMs = deps.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    if (!this.model) {
      this.log.warn("soft-ranking model artifact unavailable — module disabled");
      return;
    }
    this.summaryLastResetAtMs = this.now();
    this.unsubscribe = this.bus.subscribe("NormalizedMarketUpdated", async (payload) => {
      await this.handleBatch(payload.markets);
    });
    this.log.info(
      {
        modelVersion: this.model.modelVersion,
        modelKind: this.model.modelKind,
        validationAuc: this.model.validationAuc,
      },
      "soft-ranking score module started",
    );
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.log.info("soft-ranking score module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.model) {
      return { ok: true, detail: "disabled (artifact missing or invalid)" };
    }
    if (this.unsubscribe === null) {
      return { ok: false, detail: "not started" };
    }
    const snap = this.lastSnapshot;
    const snapshotPart =
      snap && snap.scoredMarkets > 0
        ? ` scored=${snap.scoredMarkets} stale=${snap.staleMarkets} mean=${
            snap.mean == null ? "null" : snap.mean.toFixed(4)
          }`
        : "";
    return {
      ok: true,
      detail:
        `subscribed modelVersion=${this.model.modelVersion}` +
        ` events=${this.summary.events}` +
        ` scoredRows=${this.summary.scoredRows}` +
        ` skippedNonStep2Included=${this.summary.skippedNonStep2Included}` +
        ` missingFeatures=${this.summary.missingFeatures}` +
        ` scoringErrors=${this.summary.scoringErrors}` +
        snapshotPart,
    };
  }

  private async handleBatch(markets: readonly NormalizedMarket[]): Promise<void> {
    const model = this.model;
    if (!model) return;

    const updates: MarketScoreUpdate[] = [];
    let skippedNonStep2 = 0;
    let missingFeatures = 0;
    let scoringErrors = 0;

    const scoredAt = new Date(this.now()).toISOString();

    for (const market of markets) {
      if (!isStep2Included(market)) {
        skippedNonStep2++;
        continue;
      }
      // Step 3 audit §D7: a market that has only ever been touched by the CLOB
      // stream carries `featuresCapturedTs == null` (no REST/Gamma refresh has
      // populated `liquidity`/`volume24hr`). Treat these as missing features —
      // we have no honest freshness to record.
      const featuresCapturedTs = market.featuresCapturedTs ?? null;
      if (featuresCapturedTs == null) {
        missingFeatures++;
        continue;
      }
      const featureRow = buildFeatureRow({
        liquidity: market.liquidity ?? null,
        midPrice: market.midPrice,
        volume24hr: market.volume24hr ?? null,
        endDate: market.endDate,
        tickSize: market.tickSize,
        eventMarketCount: market.eventMarketCount,
        snapshotTs: market.snapshotTs,
        slug: market.slug,
        eventSlug: market.eventSlug,
        categories: model.categories,
      });
      if (featureRow === null) {
        missingFeatures++;
        continue;
      }
      let score: number;
      try {
        score = predictScore(model, featureRow);
      } catch (err) {
        scoringErrors++;
        this.log.warn(
          { err, tokenId: market.tokenId, slug: market.slug },
          "soft-ranking score: predictScore threw — skipping market",
        );
        continue;
      }
      updates.push({
        tokenId: market.tokenId,
        score,
        modelVersion: model.modelVersion,
        scoredAt,
        featuresCapturedAt: new Date(featuresCapturedTs).toISOString(),
      });
    }

    this.summary.events++;
    this.summary.skippedNonStep2Included += skippedNonStep2;
    this.summary.missingFeatures += missingFeatures;
    this.summary.scoringErrors += scoringErrors;

    if (updates.length > 0) {
      try {
        this.marketRepo.updateScoresBatch(updates);
        this.summary.scoredRows += updates.length;
      } catch (err) {
        this.log.error(
          { err, batchSize: updates.length },
          "soft-ranking score: updateScoresBatch failed",
        );
        return;
      }
    }

    await this.maybeRecomputeSnapshot();
  }

  private async maybeRecomputeSnapshot(): Promise<void> {
    if (!this.recomputeScoreDistribution) return;
    const nowMs = this.now();
    if (this.lastFlushAtMs !== 0 && nowMs - this.lastFlushAtMs < this.flushIntervalMs) {
      return;
    }
    if (this.flushPending) return;
    this.flushPending = true;
    try {
      const snapshot = await this.recomputeScoreDistribution();
      if (snapshot && typeof snapshot === "object") {
        this.lastSnapshot = snapshot;
      }
      this.lastFlushAtMs = nowMs;
    } catch (err) {
      this.log.warn({ err }, "soft-ranking score: recomputeScoreDistribution failed");
    } finally {
      this.flushPending = false;
    }
  }
}

function isStep2Included(market: NormalizedMarket): boolean {
  return market.selectionStatus != null && STEP2_INCLUDED.has(market.selectionStatus);
}
