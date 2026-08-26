/**
 * Market Scanner Module -- slow-cadence discovery of markets via Gamma API.
 *
 * Responsibilities:
 *  - Discover candidate markets from the exchange catalog
 *  - Evaluate each market against the SelectionRuleEngine (Phase 4+)
 *  - Upsert ALL discovered markets into the DB with selection_status populated
 *  - Run on startup (non-blocking) and on a configurable periodic interval
 *
 * Does NOT provide pricing -- that is MarketDataModule's job.
 * Family matching is NO LONGER performed here (Phase 6 will remove family symbols).
 */

import type {
  RuntimeModule,
  EventBus,
  MarketDiscoveryGateway,
  MarketRepository,
  Market,
  MarketSignatureUpdate,
  PositionRepository,
  OrderRepository,
  MarketSelectionPolicy,
  RuntimeControl,
} from "@krabs/domain";
import { evaluatePreEntry, createTokenId } from "@krabs/domain";
import type { Logger } from "../../logger.js";
import { findActivePositions } from "../../active-positions.js";
import { isTransientNetworkError } from "../../network-errors.js";
import {
  consumeWarnThrottle,
  createWarnThrottleState,
  type WarnThrottleState,
} from "../../warn-throttle.js";
import type { RefreshableSelectionRuleEngine } from "../../selection-rule-engine-factory.js";
import type { EffectiveResolutionGate } from "../../effective-resolution-service.js";

const HINT_SCAN_DEBOUNCE_MS = 250;
const DEFAULT_HINT_SCAN_MIN_INTERVAL_MS = 15 * 60 * 1000;
const TRANSIENT_SCAN_WARN_THROTTLE_MS = 15 * 60_000;
// Plankton-signature features (sig_*) are treated as stale after this window
// even when unchanged, forcing a refresh write (spec 2026-07-01 §4.3).
export const SIGNATURE_FEATURE_TTL_MS = 24 * 60 * 60 * 1000;

type MarketScanTrigger = "startup" | "periodic" | "hint" | "manual";

type MarketWriteDecision = "full_upsert" | "signature_update" | "unchanged" | "coalesce_noop";
type ScannerMarketRepository = MarketRepository &
  Required<Pick<MarketRepository, "saveBatchWithSignatureUpdates">>;

/**
 * Nearest-rank percentile (no interpolation). Stable for tiny samples and
 * trivially auditable in logs. `samples` is mutated (sorted in place).
 */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const idx = Math.min(samples.length - 1, Math.max(0, Math.ceil(p * samples.length) - 1));
  return samples[idx]!;
}

function computeLatencyAggregates(samples: readonly number[]): {
  p50: number | null;
  p90: number | null;
  max: number | null;
} {
  if (samples.length === 0) return { p50: null, p90: null, max: null };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted[sorted.length - 1]!,
  };
}

function roundedNonNegativeMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export interface MarketScannerModuleDeps {
  discoveryGateway: MarketDiscoveryGateway;
  marketRepo: ScannerMarketRepository;
  bus: EventBus;
  log: Logger;
  scanIntervalMs: number;
  selectionRuleEngine: RefreshableSelectionRuleEngine;
  marketSelectionPolicy?: () => MarketSelectionPolicy;
  /** When provided, tokens with open positions are preserved from deactivation. */
  positionRepo?: PositionRepository;
  /** When provided, tokens with open orders are preserved from deactivation. */
  orderRepo?: OrderRepository;
  runtimeMetrics?: {
    writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
  };
  effectiveResolution?: Pick<EffectiveResolutionGate, "toPreEntryFields">;
  runtimeControl?: RuntimeControl | undefined;
  /** Minimum age of a successful scan before a WS new-market hint may trigger a full rescan. */
  hintScanMinIntervalMs?: number | undefined;
}

export interface MarketScanResult {
  /** ClobMarkets seen from Gamma (market-level). */
  discoveredMarkets: number;
  /** Markets whose evaluatePreEntry resolved to INCLUDE (market-level). */
  includedMarkets: number;
  /** Token rows written to DB (token-level). */
  savedTokens: number;
  /** Token rows skipped because scanner-owned fields were unchanged. */
  skippedUnchangedTokens: number;
  /** Token rows skipped because incoming nulls would be no-ops under repository COALESCE semantics. */
  skippedCoalesceNoopTokens: number;
  /** Tokens preserved from deactivation via open positions/orders (token-level). */
  preservedTokens: number;
  /** Token rows deactivated (token-level). */
  deactivatedTokens: number;
  /**
   * Tokens preserved from deactivation that were ALSO fully missing from the
   * Gamma scan this cycle (D-B1 edge — ADR-021 §D-F). Subset of
   * `preservedTokens`; sustained non-zero readings indicate the bot is
   * holding open legs on tokens whose `tradable` flag survives via the
   * scanner UPSERT skipping them, which can leak BUY-eligibility until
   * tracked-set diffing or resolution sweeps it away.
   */
  preservedDisappearedTokens: number;
  /** Tokens persisted for the first time during this scan (token-level). */
  firstSeenTokens: number;
  /**
   * Discovery latency = `Date.now() - Date.parse(gammaCreatedAt)` evaluated for
   * every first-sighted token whose ClobMarket carried a non-null `gammaCreatedAt`.
   * Reported as p50/p90/max in milliseconds; null when no eligible samples in
   * this cycle. Step 0 §P2: validates scanner overhead, NOT spec §1.7 R14.
   */
  discoveryLatencyP50Ms: number | null;
  discoveryLatencyP90Ms: number | null;
  discoveryLatencyMaxMs: number | null;
  durationMs: number;
}

/**
 * v5.11 admission breakdown — cumulative counters surfaced for healthcheck and
 * dashboards. The legacy `marketsStep2FallbackInclude` field is retained for
 * API compatibility and should stay zero under hard-filter admission.
 *
 * R64: short-horizon strike rejections are counted both in aggregate and
 * split by `pattern` (strike slug shape) + `horizonHoursBucket` so we can
 * tell whether the threshold is over- or under-blocking after 7-14 days.
 */
export interface Step2BreakdownSnapshot {
  scannedMarketsTotal: number;
  marketsStep1MatchedInclude: number;
  marketsStep1MatchedExclude: number;
  marketsStep2FallbackInclude: number;
  marketsFinalExclude: number;
  scannedEventsTotal: number;
  eventsSingleMarketTotal: number;
  eventsMultiMarketTotal: number;
  /** R64 — number of markets rejected by the strike-short-horizon filter. */
  strikeShortHorizonRejectedTotal: number;
  /** R64 — rejection counts keyed by `StrikePatternKind` (`between` / `greater_or_less_than` / `above`). */
  strikeShortHorizonByPattern: Record<string, number>;
  /** R64 — rejection counts keyed by horizon bucket (`lt_1h` / `1_to_6h` / `6_to_12h` / `12_to_24h` / `negative` / `unknown`). */
  strikeShortHorizonByHorizonBucket: Record<string, number>;
}

/**
 * R64 metric bucketing for short-horizon strike rejections. Bucket edges are
 * coarse on purpose so the breakdown stays readable on a healthcheck line
 * and so individual buckets accumulate enough samples for a meaningful
 * profit comparison.
 */
function horizonHoursBucket(horizonHours: number | null | undefined): string {
  if (horizonHours == null || !Number.isFinite(horizonHours)) return "unknown";
  if (horizonHours < 0) return "negative";
  if (horizonHours < 1) return "lt_1h";
  if (horizonHours < 6) return "1_to_6h";
  if (horizonHours < 12) return "6_to_12h";
  return "12_to_24h";
}

function createEmptyStep2Breakdown(): Step2BreakdownSnapshot {
  return {
    scannedMarketsTotal: 0,
    marketsStep1MatchedInclude: 0,
    marketsStep1MatchedExclude: 0,
    marketsStep2FallbackInclude: 0,
    marketsFinalExclude: 0,
    scannedEventsTotal: 0,
    eventsSingleMarketTotal: 0,
    eventsMultiMarketTotal: 0,
    strikeShortHorizonRejectedTotal: 0,
    strikeShortHorizonByPattern: {},
    strikeShortHorizonByHorizonBucket: {},
  };
}

export class MarketScannerModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private hintTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubs: Array<() => void> = [];
  private scanning = false;
  private lastSuccessfulScanMs = 0;
  private wsHintConsumed = 0;
  /**
   * Step 0 §P2 — most-recent discovery-latency aggregates (ms) from the last
   * scan that produced at least one first-sighted token with a non-null
   * `gammaCreatedAt`. Surfaced via `healthCheck()` so operators see the live
   * scanner overhead without grepping logs. Null while no eligible sample
   * exists.
   */
  private lastLatencyP50Ms: number | null = null;
  private lastLatencyP90Ms: number | null = null;
  private lastLatencyMaxMs: number | null = null;
  /**
   * ADR-021 §D-F — last successful scan's watch-set gauges (preserved /
   * deactivated / firstSeen / preservedDisappeared) cached for `healthCheck`.
   * Null until the first successful scan.
   */
  private lastScanResult: MarketScanResult | null = null;
  /**
   * v5.11 admission breakdown — cumulative counters across all scan cycles
   * (mutated incrementally to keep memory flat). See Step2BreakdownSnapshot.
   */
  private readonly step2Breakdown: Step2BreakdownSnapshot = createEmptyStep2Breakdown();
  private readonly log: Logger;
  private readonly scanDegradeWarn: WarnThrottleState = createWarnThrottleState();

  constructor(private readonly deps: MarketScannerModuleDeps) {
    this.log = deps.log.child({ module: "market-scanner" });
  }

  async start(): Promise<void> {
    this.log.info({ intervalMs: this.deps.scanIntervalMs }, "starting market-scanner module");
    this.unsubs.push(
      this.deps.bus.subscribe("NewMarketDiscoveredHint", async () => {
        this.wsHintConsumed++;
        this.scheduleHintScan();
      }),
    );
    // Fire the first background scan only when startup didn't already complete
    // a fresh blocking scan immediately beforehand.
    if (!this.hasFreshSuccessfulScan()) {
      this.scan("startup").catch((err) => this.log.error({ err }, "initial scan failed"));
    }
    this.timer = setInterval(() => {
      this.scan("periodic").catch((err) => this.log.error({ err }, "scan cycle error"));
    }, this.deps.scanIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.hintTimer) {
      clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
    this.log.info("market-scanner module stopped");
  }

  getHintMetricsSnapshot(): { readonly discoveryWsHintsConsumed: number } {
    return {
      discoveryWsHintsConsumed: this.wsHintConsumed,
    };
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (this.lastSuccessfulScanMs === 0) {
      return { ok: false, detail: "no successful scan yet" };
    }
    const ageMs = Date.now() - this.lastSuccessfulScanMs;
    // Consider unhealthy if last scan was more than 3x the interval ago
    const stale = ageMs > this.deps.scanIntervalMs * 3;
    const freshness = stale
      ? `stale: last scan ${Math.round(ageMs / 1000)}s ago`
      : `fresh: last scan ${Math.round(ageMs / 1000)}s ago`;
    const latency =
      this.lastLatencyP50Ms === null
        ? "discoveryLatency=n/a"
        : `discoveryLatencyMs p50=${this.lastLatencyP50Ms} p90=${this.lastLatencyP90Ms} max=${this.lastLatencyMaxMs}`;
    const b = this.step2Breakdown;
    const shortHorizonSuffix =
      b.strikeShortHorizonRejectedTotal === 0
        ? ""
        : ` strikeShortHorizonRejected=${b.strikeShortHorizonRejectedTotal}`;
    const breakdown =
      b.scannedMarketsTotal === 0
        ? ""
        : ` step2Breakdown markets=${b.scannedMarketsTotal} step1Include=${b.marketsStep1MatchedInclude} step1Exclude=${b.marketsStep1MatchedExclude} step2Fallback=${b.marketsStep2FallbackInclude} finalExclude=${b.marketsFinalExclude} events=${b.scannedEventsTotal} singleMarket=${b.eventsSingleMarketTotal} multiMarket=${b.eventsMultiMarketTotal}${shortHorizonSuffix}`;
    const r = this.lastScanResult;
    const watchSet =
      r === null
        ? ""
        : ` watchSet preserved=${r.preservedTokens} deactivated=${r.deactivatedTokens} firstSeen=${r.firstSeenTokens} preservedDisappeared=${r.preservedDisappearedTokens}`;
    return {
      ok: !stale,
      detail: `${freshness} ${latency}${breakdown}${watchSet}`,
    };
  }

  /**
   * Step 0 §P2 — read-only accessor for the latest discovery-latency aggregates,
   * intended for ops dashboards / API surfaces. Each value is the millisecond
   * delta between `Date.now()` at scan time and the token's `gammaCreatedAt`,
   * computed across all first-sighted tokens in the most recent qualifying
   * scan. Null until at least one such sample is observed.
   */
  getDiscoveryLatencySnapshot(): {
    readonly p50Ms: number | null;
    readonly p90Ms: number | null;
    readonly maxMs: number | null;
  } {
    return {
      p50Ms: this.lastLatencyP50Ms,
      p90Ms: this.lastLatencyP90Ms,
      maxMs: this.lastLatencyMaxMs,
    };
  }

  /**
   * v5.11 admission breakdown — read-only snapshot of cumulative counters.
   * Returns a defensive copy so callers cannot mutate internal state.
   */
  getStep2BreakdownSnapshot(): Step2BreakdownSnapshot {
    return {
      ...this.step2Breakdown,
      strikeShortHorizonByPattern: { ...this.step2Breakdown.strikeShortHorizonByPattern },
      strikeShortHorizonByHorizonBucket: {
        ...this.step2Breakdown.strikeShortHorizonByHorizonBucket,
      },
    };
  }

  /** Exposed for testing -- in production driven by the interval timer. */
  async scan(trigger: MarketScanTrigger = "manual"): Promise<void> {
    await this.runScan(false, trigger);
  }

  /** Blocking startup helper — throws on discovery failures. */
  async scanOrThrow(): Promise<MarketScanResult> {
    let result: MarketScanResult | null;
    try {
      result = await this.runScan(true, "startup");
    } catch (err) {
      const cachedTokens = this.countCachedTokens();
      if (cachedTokens > 0 && isTransientNetworkError(err)) {
        return this.useCachedCatalogAfterStartupScanFailure(err, cachedTokens);
      }
      throw err;
    }
    if (!result) {
      throw new Error("market scan skipped unexpectedly");
    }
    return result;
  }

  private async runScan(
    throwOnError: boolean,
    trigger: MarketScanTrigger,
  ): Promise<MarketScanResult | null> {
    if (this.scanning) return null;
    if (!throwOnError && trigger !== "startup" && this.deps.runtimeControl?.isPaused()) {
      this.log.debug({ scanTrigger: trigger }, "market scan skipped while runtime is paused");
      return null;
    }
    this.scanning = true;
    const startMs = Date.now();
    const scanStartedAtMs = performance.now();
    let gammaCallbackMs = 0;
    let evaluationMs = 0;
    let writePlanMs = 0;
    let sqliteSaveMs = 0;
    let deactivateMs = 0;
    let scanPages = 0;

    try {
      this.log.debug("scan cycle starting");

      // Refresh selection rules if the DB version has advanced since last tick.
      this.deps.selectionRuleEngine.refreshIfStale();
      const engine = this.deps.selectionRuleEngine.current;
      const marketSelectionPolicy = this.deps.marketSelectionPolicy?.();

      let discoveredMarkets = 0;
      let includedMarkets = 0;
      let savedTokens = 0;
      let fullUpsertedTokens = 0;
      let signatureUpdatedTokens = 0;
      let sqliteWriteBatches = 0;
      let sqliteMaxBatchMs = 0;
      let skippedUnchangedTokens = 0;
      let skippedCoalesceNoopTokens = 0;
      const now = new Date().toISOString();
      // Captured once per scan cycle so all markets — across paginated pages
      // — are evaluated against the same reference time. Late pages see a
      // slightly stale clock (scan duration is typically <60s); the R64 24h
      // horizon threshold is far enough above that drift to be safe.
      const nowMs = Date.now();
      const discoveredTokenIds = new Set<string>();

      // Snapshot of token IDs already persisted to detect first-sighting
      // for the discovery-latency telemetry (Step 0 §P2). Includes inactive
      // rows so re-discovery of a deactivated token is NOT counted as new.
      const knownTokenIds = new Set<string>();
      for (const tokenId of this.deps.marketRepo.iterateAllTokenIds()) {
        knownTokenIds.add(String(tokenId));
      }
      const discoveryLatencySamplesMs: number[] = [];
      let firstSeenTokens = 0;

      // Build set of tokens with open positions/orders for preservation
      const activeTokenIds = new Set<string>();
      if (this.deps.positionRepo) {
        for (const pos of findActivePositions(this.deps.positionRepo)) {
          activeTokenIds.add(String(pos.tokenId));
        }
      }
      if (this.deps.orderRepo) {
        for (const ord of this.deps.orderRepo.findOpen()) {
          activeTokenIds.add(String(ord.tokenId));
        }
      }

      // Accumulate admission counters into a local delta so a partial /
      // failed scan does not leak skewed counts into `this.step2Breakdown`
      // (Gamma pagination is order-biased — early pages alone are not
      // representative). Merged into the cumulative snapshot only after the
      // full scan completes successfully.
      const pendingStep2Delta: Step2BreakdownSnapshot = createEmptyStep2Breakdown();

      const gammaStartedAtMs = performance.now();
      const prepareMs = gammaStartedAtMs - scanStartedAtMs;
      await this.deps.discoveryGateway.forEachMarketPage((pageMarkets, eventStats) => {
        const pageStartedAtMs = performance.now();
        scanPages++;
        discoveredMarkets += pageMarkets.length;
        pendingStep2Delta.scannedEventsTotal += eventStats.events;
        pendingStep2Delta.eventsSingleMarketTotal += eventStats.singleMarket;
        pendingStep2Delta.eventsMultiMarketTotal += eventStats.multiMarket;
        const pageBatch: Market[] = [];
        for (const clobMarket of pageMarkets) {
          const tokenEvalResults = clobMarket.tokens.map((token) =>
            evaluatePreEntry(
              engine,
              {
                eventSlug: clobMarket.eventSlug ?? null,
                slug: clobMarket.slug,
                eventMarketCount: clobMarket.eventMarketCount,
                question: clobMarket.question,
                midPrice: token.midPrice ?? null,
                liquidity: clobMarket.liquidity ?? null,
                endDate: clobMarket.endDate ?? null,
                groupItemTitle: clobMarket.groupItemTitle ?? null,
                groupItemThreshold: clobMarket.groupItemThreshold ?? null,
                tags: clobMarket.tags ?? null,
                ...this.deps.effectiveResolution?.toPreEntryFields({
                  slug: clobMarket.slug,
                  eventSlug: clobMarket.eventSlug ?? null,
                  question: clobMarket.question,
                  endDate: clobMarket.endDate ?? null,
                  groupItemTitle: clobMarket.groupItemTitle ?? null,
                  tags: clobMarket.tags ?? null,
                }),
              },
              marketSelectionPolicy,
              nowMs,
            ),
          );
          const marketEvalResult =
            tokenEvalResults.find((r) => r.finalStatus === "INCLUDE") ?? tokenEvalResults[0];

          if (marketEvalResult == null) continue;

          // v5.11 admission breakdown — increment per-market counter by status.
          pendingStep2Delta.scannedMarketsTotal++;
          switch (marketEvalResult.selectionStatus) {
            case "matched_include":
              pendingStep2Delta.marketsStep1MatchedInclude++;
              break;
            case "matched_exclude":
              pendingStep2Delta.marketsStep1MatchedExclude++;
              break;
            case "step2_fallback_include":
              pendingStep2Delta.marketsStep2FallbackInclude++;
              break;
            case "fallback_exclude":
              pendingStep2Delta.marketsFinalExclude++;
              break;
          }

          // Track B D1 — split strike rejections by pattern + horizon bucket so
          // dashboards can tell whether the thresholds are over-blocking. Only
          // crypto-form slugs carry a non-null `strikePattern` (see
          // evaluatePreEntry); non-crypto strike rejects are counted in the
          // total reject path via `selectionRejectReasons`. Counter names keep
          // the `strikeShortHorizon*` prefix (internal) to minimize the diff.
          if (
            (marketEvalResult.rejectReason === "strike_min_horizon" ||
              marketEvalResult.rejectReason === "strike_yes_tail_short_runway") &&
            marketEvalResult.strikePattern != null
          ) {
            pendingStep2Delta.strikeShortHorizonRejectedTotal++;
            const pattern = marketEvalResult.strikePattern;
            pendingStep2Delta.strikeShortHorizonByPattern[pattern] =
              (pendingStep2Delta.strikeShortHorizonByPattern[pattern] ?? 0) + 1;
            const bucket = horizonHoursBucket(marketEvalResult.horizonHours);
            pendingStep2Delta.strikeShortHorizonByHorizonBucket[bucket] =
              (pendingStep2Delta.strikeShortHorizonByHorizonBucket[bucket] ?? 0) + 1;
          }

          const marketHasAnyIncludedLeg = marketEvalResult.finalStatus === "INCLUDE";
          if (marketHasAnyIncludedLeg) includedMarkets++;

          const hasActiveLeg = clobMarket.tokens.some((t) => activeTokenIds.has(t.tokenId));

          for (const [index, token] of clobMarket.tokens.entries()) {
            const tokenEval = tokenEvalResults[index]!;
            this.recordBuyGuardReject(tokenEval.rejectReason);
            const tokenId = createTokenId(token.tokenId);
            const tokenIdStr = String(tokenId);
            const isExecutionCriticalLeg = activeTokenIds.has(tokenIdStr);
            const shouldPersistToken =
              tokenEval.finalStatus === "INCLUDE" || isExecutionCriticalLeg;
            // Persist only admitted legs plus existing inventory/order legs. A
            // full-v5.11 scan sees many excluded legs; keeping them active in
            // SQLite bloats the pricing universe without adding tradeability.
            if (!shouldPersistToken) continue;

            discoveredTokenIds.add(tokenIdStr);
            if (!knownTokenIds.has(tokenIdStr)) {
              firstSeenTokens++;
              if (clobMarket.gammaCreatedAt !== null) {
                const createdMs = Date.parse(clobMarket.gammaCreatedAt);
                if (Number.isFinite(createdMs)) {
                  discoveryLatencySamplesMs.push(nowMs - createdMs);
                }
              }
            }
            // Plankton-signature ranking features captured at discovery
            // (spec 2026-07-01 §4.3) — fresh markets have no market_snapshots
            // to rank from, so these ride along on the markets row itself.
            const mids = clobMarket.tokens
              .map((t) => (typeof t.midPrice === "number" ? t.midPrice : null))
              .filter((m): m is number => m !== null);
            const cheapMid = mids.length > 0 ? Math.min(...mids) : null;
            const tokenMid = typeof token.midPrice === "number" ? token.midPrice : null;
            pageBatch.push({
              tokenId,
              conditionId: clobMarket.conditionId,
              slug: clobMarket.slug,
              eventSlug: clobMarket.eventSlug ?? null,
              question: clobMarket.question,
              outcome: token.outcome,
              outcomeIndex: token.outcomeIndex ?? null,
              regime: null,
              horizon: null,
              endDate: clobMarket.endDate || null,
              active: clobMarket.active || hasActiveLeg,
              // Preserved or v5.11-filtered markets persist with tradable=false
              // so MarketSelectionCache stops signalling new BUYs while exits
              // for existing inventory can still observe lifecycle/pricing.
              tradable: clobMarket.active && tokenEval.finalStatus === "INCLUDE",
              tickSize: clobMarket.tickSize,
              negRisk: clobMarket.negRisk,
              eventMarketCount: clobMarket.eventMarketCount,
              selectionStatus: tokenEval.selectionStatus,
              selectionWinningRuleId: tokenEval.winningRuleId,
              gammaCreatedAt: clobMarket.gammaCreatedAt,
              groupItemTitle: clobMarket.groupItemTitle ?? null,
              groupItemThreshold: clobMarket.groupItemThreshold ?? null,
              tags: clobMarket.tags ?? null,
              sigMid: tokenMid,
              sigCheapMid: cheapMid,
              sigLiquidity: clobMarket.liquidity ?? null,
              sigVol24h: clobMarket.volume24hr ?? null,
              sigFeaturesAt: now,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
        const evaluationFinishedAtMs = performance.now();
        evaluationMs += evaluationFinishedAtMs - pageStartedAtMs;
        if (pageBatch.length > 0) {
          const writePlanStartedAtMs = performance.now();
          const writePlan = this.planPageWrites(pageBatch);
          writePlanMs += performance.now() - writePlanStartedAtMs;
          skippedUnchangedTokens += writePlan.skippedUnchanged;
          skippedCoalesceNoopTokens += writePlan.skippedCoalesceNoop;
          const writes = writePlan.fullUpserts.length + writePlan.signatureUpdates.length;
          if (writes > 0) {
            const sqliteSaveStartedAtMs = performance.now();
            this.deps.marketRepo.saveBatchWithSignatureUpdates(
              writePlan.fullUpserts,
              writePlan.signatureUpdates,
            );
            const batchMs = performance.now() - sqliteSaveStartedAtMs;
            sqliteSaveMs += batchMs;
            sqliteMaxBatchMs = Math.max(sqliteMaxBatchMs, batchMs);
            sqliteWriteBatches++;
            fullUpsertedTokens += writePlan.fullUpserts.length;
            signatureUpdatedTokens += writePlan.signatureUpdates.length;
            savedTokens += writes;
          }
        }
        gammaCallbackMs += performance.now() - pageStartedAtMs;
      });
      const gammaMs = performance.now() - gammaStartedAtMs - gammaCallbackMs;

      // Deactivate tracked markets not in latest scan AND without open positions/orders.
      // Uses repo-side cursor + batch update to avoid materialising the full active
      // Market slice (~75 MB peak under full universe) alongside discoveredTokenIds.
      const deactivateStartedAtMs = performance.now();
      const deactivatedCount = this.deps.marketRepo.deactivateMissing(
        discoveredTokenIds,
        activeTokenIds,
        now,
      );
      deactivateMs = performance.now() - deactivateStartedAtMs;

      // ADR-021 §D-F #3 — D-B1 observability. Count preserved tokens (open
      // position/order legs) that were fully absent from this Gamma scan.
      // |activeTokenIds| is bounded by open positions + open orders (small),
      // so a Set lookup loop is cheap.
      let preservedDisappearedTokens = 0;
      for (const tokenId of activeTokenIds) {
        if (!discoveredTokenIds.has(tokenId)) preservedDisappearedTokens++;
      }

      // Scan succeeded end-to-end — merge pending admission delta into the
      // cumulative snapshot. Failed/degraded scans drop the delta by virtue
      // of falling through to the catch / finally without reaching this line.
      this.step2Breakdown.scannedMarketsTotal += pendingStep2Delta.scannedMarketsTotal;
      this.step2Breakdown.marketsStep1MatchedInclude +=
        pendingStep2Delta.marketsStep1MatchedInclude;
      this.step2Breakdown.marketsStep1MatchedExclude +=
        pendingStep2Delta.marketsStep1MatchedExclude;
      this.step2Breakdown.marketsStep2FallbackInclude +=
        pendingStep2Delta.marketsStep2FallbackInclude;
      this.step2Breakdown.marketsFinalExclude += pendingStep2Delta.marketsFinalExclude;
      this.step2Breakdown.scannedEventsTotal += pendingStep2Delta.scannedEventsTotal;
      this.step2Breakdown.eventsSingleMarketTotal += pendingStep2Delta.eventsSingleMarketTotal;
      this.step2Breakdown.eventsMultiMarketTotal += pendingStep2Delta.eventsMultiMarketTotal;
      this.step2Breakdown.strikeShortHorizonRejectedTotal +=
        pendingStep2Delta.strikeShortHorizonRejectedTotal;
      for (const [pattern, count] of Object.entries(
        pendingStep2Delta.strikeShortHorizonByPattern,
      )) {
        this.step2Breakdown.strikeShortHorizonByPattern[pattern] =
          (this.step2Breakdown.strikeShortHorizonByPattern[pattern] ?? 0) + count;
      }
      for (const [bucket, count] of Object.entries(
        pendingStep2Delta.strikeShortHorizonByHorizonBucket,
      )) {
        this.step2Breakdown.strikeShortHorizonByHorizonBucket[bucket] =
          (this.step2Breakdown.strikeShortHorizonByHorizonBucket[bucket] ?? 0) + count;
      }

      this.lastSuccessfulScanMs = Date.now();
      const durationMs = this.lastSuccessfulScanMs - startMs;
      const latencyAggregates = computeLatencyAggregates(discoveryLatencySamplesMs);
      // Cache for healthCheck telemetry. We only refresh when at least one
      // first-sighted token contributed a sample (p50!=null), otherwise we
      // keep the previous reading so the dashboard doesn't oscillate to null
      // every cycle that produces zero new tokens.
      if (latencyAggregates.p50 !== null) {
        this.lastLatencyP50Ms = latencyAggregates.p50;
        this.lastLatencyP90Ms = latencyAggregates.p90;
        this.lastLatencyMaxMs = latencyAggregates.max;
      }
      const result: MarketScanResult = {
        discoveredMarkets,
        includedMarkets,
        savedTokens,
        skippedUnchangedTokens,
        skippedCoalesceNoopTokens,
        preservedTokens: activeTokenIds.size,
        deactivatedTokens: deactivatedCount,
        preservedDisappearedTokens,
        firstSeenTokens,
        discoveryLatencyP50Ms: latencyAggregates.p50,
        discoveryLatencyP90Ms: latencyAggregates.p90,
        discoveryLatencyMaxMs: latencyAggregates.max,
        durationMs,
      };
      this.lastScanResult = result;

      const scanPhasesMs = {
        prepare: roundedNonNegativeMs(prepareMs),
        gamma: roundedNonNegativeMs(gammaMs),
        evaluation: roundedNonNegativeMs(evaluationMs),
        writePlan: roundedNonNegativeMs(writePlanMs),
        sqliteSave: roundedNonNegativeMs(sqliteSaveMs),
        deactivate: roundedNonNegativeMs(deactivateMs),
        other: 0,
      };
      const accountedPhaseMs = Object.values(scanPhasesMs).reduce(
        (sum, phaseMs) => sum + phaseMs,
        0,
      );
      scanPhasesMs.other = Math.max(
        0,
        roundedNonNegativeMs(performance.now() - scanStartedAtMs) - accountedPhaseMs,
      );

      this.log.info(
        {
          discoveredMarkets,
          includedMarkets,
          savedTokens,
          fullUpsertedTokens,
          signatureUpdatedTokens,
          sqliteWriteBatches,
          sqliteMaxBatchMs: roundedNonNegativeMs(sqliteMaxBatchMs),
          skippedUnchangedTokens,
          skippedCoalesceNoopTokens,
          preservedTokens: activeTokenIds.size,
          deactivatedTokens: deactivatedCount,
          preservedDisappearedTokens,
          firstSeenTokens,
          discoveryLatencyP50Ms: latencyAggregates.p50,
          discoveryLatencyP90Ms: latencyAggregates.p90,
          discoveryLatencyMaxMs: latencyAggregates.max,
          scanTrigger: trigger,
          scanPages,
          scanPhasesMs,
          durationMs,
        },
        "scan cycle complete",
      );
      return result;
    } catch (err) {
      if (!throwOnError && this.lastSuccessfulScanMs > 0 && isTransientNetworkError(err)) {
        this.logScanDegraded(err);
        return null;
      }
      if (!(throwOnError && isTransientNetworkError(err) && this.countCachedTokens() > 0)) {
        this.log.error({ err }, "scan cycle failed");
      }
      if (throwOnError) {
        throw err;
      }
      return null;
    } finally {
      this.scanning = false;
    }
  }

  private recordBuyGuardReject(reason: string | undefined): void {
    if (reason !== "buy_guard_short_lifetime") return;
    this.deps.runtimeMetrics?.writeCounter?.(
      "buy_guard_short_lifetime_rejected_total",
      1,
      JSON.stringify({ source: "scanner" }),
    );
  }

  private scheduleHintScan(): void {
    if (this.hasFreshSuccessfulScan()) return;
    if (this.hintTimer) return;
    this.hintTimer = setTimeout(() => {
      this.hintTimer = null;
      if (this.hasFreshSuccessfulScan()) return;
      void this.scan("hint").catch((err) => this.log.error({ err }, "hint-triggered scan failed"));
    }, HINT_SCAN_DEBOUNCE_MS);
  }

  private logScanDegraded(err: unknown): void {
    const suppressedCount = consumeWarnThrottle(
      this.scanDegradeWarn,
      Date.now(),
      TRANSIENT_SCAN_WARN_THROTTLE_MS,
    );
    if (suppressedCount == null) return;
    this.log.warn({ err, suppressedCount }, "scan cycle degraded — keeping existing catalog");
  }

  private planPageWrites(markets: readonly Market[]): {
    fullUpserts: Market[];
    signatureUpdates: MarketSignatureUpdate[];
    skippedUnchanged: number;
    skippedCoalesceNoop: number;
  } {
    const existingRows = this.deps.marketRepo.findByTokenIds(markets.map((m) => m.tokenId));
    const existingByTokenId = new Map(existingRows.map((m) => [String(m.tokenId), m]));
    const fullUpserts: Market[] = [];
    const signatureUpdates: MarketSignatureUpdate[] = [];
    let skippedUnchanged = 0;
    let skippedCoalesceNoop = 0;
    const nowMs = Date.now();

    for (const market of markets) {
      const existing = existingByTokenId.get(String(market.tokenId));
      const decision = classifyMarketWrite(market, existing ?? null, nowMs);
      if (decision === "full_upsert") {
        fullUpserts.push(market);
      } else if (decision === "signature_update") {
        signatureUpdates.push({
          tokenId: market.tokenId,
          sigMid: market.sigMid ?? null,
          sigCheapMid: market.sigCheapMid ?? null,
          sigLiquidity: market.sigLiquidity ?? null,
          sigVol24h: market.sigVol24h ?? null,
          sigFeaturesAt: market.sigFeaturesAt ?? null,
          updatedAt: market.updatedAt,
        });
      } else if (decision === "coalesce_noop") {
        skippedCoalesceNoop++;
      } else {
        skippedUnchanged++;
      }
    }

    return { fullUpserts, signatureUpdates, skippedUnchanged, skippedCoalesceNoop };
  }

  private hasFreshSuccessfulScan(nowMs = Date.now()): boolean {
    const minIntervalMs = this.deps.hintScanMinIntervalMs ?? DEFAULT_HINT_SCAN_MIN_INTERVAL_MS;
    return this.lastSuccessfulScanMs > 0 && nowMs - this.lastSuccessfulScanMs < minIntervalMs;
  }

  private countCachedTokens(): number {
    let count = 0;
    for (const _tokenId of this.deps.marketRepo.iterateAllTokenIds()) count++;
    return count;
  }

  private useCachedCatalogAfterStartupScanFailure(
    err: unknown,
    cachedTokens: number,
  ): MarketScanResult {
    const nowMs = Date.now();
    const result: MarketScanResult = {
      discoveredMarkets: 0,
      includedMarkets: 0,
      savedTokens: 0,
      skippedUnchangedTokens: 0,
      skippedCoalesceNoopTokens: 0,
      preservedTokens: this.countActiveTokens(),
      deactivatedTokens: 0,
      preservedDisappearedTokens: 0,
      firstSeenTokens: 0,
      discoveryLatencyP50Ms: null,
      discoveryLatencyP90Ms: null,
      discoveryLatencyMaxMs: null,
      durationMs: 0,
    };
    this.lastSuccessfulScanMs = nowMs;
    this.lastScanResult = result;
    this.log.warn(
      { err, cachedTokens },
      "startup scan degraded — using existing catalog until next scanner cycle",
    );
    return result;
  }

  private countActiveTokens(): number {
    const activeTokenIds = new Set<string>();
    if (this.deps.positionRepo) {
      for (const pos of findActivePositions(this.deps.positionRepo)) {
        activeTokenIds.add(String(pos.tokenId));
      }
    }
    if (this.deps.orderRepo) {
      for (const ord of this.deps.orderRepo.findOpen()) {
        activeTokenIds.add(String(ord.tokenId));
      }
    }
    return activeTokenIds.size;
  }
}

export function classifyMarketWrite(
  next: Market,
  existing: Market | null,
  nowMs: number,
): MarketWriteDecision {
  if (existing === null) return "full_upsert";

  const coalesceNoop =
    next.eventSlug == null && existing.eventSlug != null
      ? "eventSlug"
      : next.gammaCreatedAt == null && existing.gammaCreatedAt != null
        ? "gammaCreatedAt"
        : null;

  const effectiveNextEventSlug = next.eventSlug == null ? existing.eventSlug : next.eventSlug;
  const effectiveNextGammaCreatedAt = existing.gammaCreatedAt ?? next.gammaCreatedAt ?? null;

  // Refresh changed features and stale capture timestamps so the signature TTL remains meaningful.
  const sigStale =
    existing.sigFeaturesAt == null ||
    !Number.isFinite(Date.parse(existing.sigFeaturesAt)) ||
    nowMs - Date.parse(existing.sigFeaturesAt) > SIGNATURE_FEATURE_TTL_MS;
  const sigEqual =
    (next.sigMid ?? null) === (existing.sigMid ?? null) &&
    (next.sigCheapMid ?? null) === (existing.sigCheapMid ?? null) &&
    (next.sigLiquidity ?? null) === (existing.sigLiquidity ?? null) &&
    (next.sigVol24h ?? null) === (existing.sigVol24h ?? null);

  const metadataEqual =
    String(next.conditionId) === String(existing.conditionId) &&
    next.slug === existing.slug &&
    effectiveNextEventSlug === existing.eventSlug &&
    next.question === existing.question &&
    next.outcome === existing.outcome &&
    next.outcomeIndex === existing.outcomeIndex &&
    next.regime === existing.regime &&
    next.horizon === existing.horizon &&
    next.endDate === existing.endDate &&
    next.active === existing.active &&
    next.tradable === existing.tradable &&
    next.tickSize === existing.tickSize &&
    next.negRisk === existing.negRisk &&
    next.eventMarketCount === existing.eventMarketCount &&
    next.selectionStatus === existing.selectionStatus &&
    next.selectionWinningRuleId === existing.selectionWinningRuleId &&
    effectiveNextGammaCreatedAt === existing.gammaCreatedAt &&
    // Track B strike-signal fields (§4.2e) — group-item is stable over a
    // market's life but included for correctness (cost is negligible).
    (next.groupItemTitle ?? null) === (existing.groupItemTitle ?? null) &&
    (next.groupItemThreshold ?? null) === (existing.groupItemThreshold ?? null) &&
    tagsEqual(next.tags ?? null, existing.tags ?? null);

  if (!metadataEqual) return "full_upsert";
  if (!sigEqual || sigStale) return "signature_update";
  return coalesceNoop === null ? "unchanged" : "coalesce_noop";
}

// Order-sensitive equality for the persisted Gamma tag list (Track B §4.2e).
function tagsEqual(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (a.length !== b.length) return false;
  return a.every((tag, i) => tag === b[i]);
}
