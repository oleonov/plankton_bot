/**
 * ResolutionModule — detects resolved markets and settles positions.
 *
 * Polling loop:
 *  1. Find open/dust positions on markets past endDate + grace period
 *  2. Confirm resolution via Gamma API
 *  3. Close positions, record settlement PnL
 *  4. Publish MarketResolved + PositionSettled events
 */

import type Database from "better-sqlite3";
import type {
  EventBus,
  ExchangeGateway,
  RuntimeControl,
  RuntimeEventMap,
  RuntimeModule,
  FillRepository,
  MarketRepository,
  MarketResolutionRepository,
  OrderRepository,
  InventoryLotRepository,
  PositionRepository,
  TokenId,
} from "@krabs/domain";
import { createCommandId } from "@krabs/domain";
import type { GammaResolutionClient } from "@krabs/exchange";
import type {
  ResolutionDetector,
  ResolutionCandidate,
  DetectedResolution,
} from "./resolution-detector.js";
import { inferResolution, parseTokenIds } from "./resolution-detector.js";
import type { PositionSettler } from "./position-settler.js";
import type { Logger } from "../../logger.js";
import { buildCancelTelemetry } from "../reconciliation/cancel-telemetry.js";
import type { SettlementInfraBreaker } from "../settlement-infra-breaker.js";
import { isZeroBalancePrecheckSkipError } from "../settlement-infra-breaker.js";

function normalizeOutcomeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function summarizeError(err: unknown): { errorName?: string; errorMessage: string } {
  if (err instanceof Error) {
    return { errorName: err.name, errorMessage: err.message };
  }
  return { errorMessage: String(err) };
}

const SETTLEMENT_BALANCE_DUST_THRESHOLD = 1 / 1_000_000;

// Per-conditionId circuit-breaker for the algo-triggered on-chain redeem path.
// Baseline was up to 14 consecutive gateway calls per failing conditionId per
// window (see audit B8/2); this table caps that at 3 attempts before the
// circuit opens fully for an hour.
//
// Back-off grows with failureCount; at count >= 3 the circuit is considered
// open and further gateway calls are suppressed entirely until
// CIRCUIT_OPEN_COOLDOWN_MS has passed since the last failure.
const REDEEM_BACKOFF_MS_BY_COUNT: readonly number[] = [
  0, // count=0 (no prior failure) — no back-off
  60_000, // count=1 — 1 min
  5 * 60_000, // count=2 — 5 min
];
const REDEEM_CIRCUIT_OPEN_COOLDOWN_MS = 60 * 60_000;
const REDEEM_CIRCUIT_OPEN_THRESHOLD = 3;
const RESOLUTION_REDEEM_RETRY_COOLDOWN_MS = 60 * 60_000;
const RESOLUTION_ZERO_BALANCE_QUARANTINE_TTL_MS = 24 * 60 * 60_000;
const ASYNC_RESOLUTION_QUEUE_MAX_DEPTH = 32;

interface RedeemFailureEntry {
  readonly failedAt: number;
  readonly failureCount: number;
}

type AlgoRedeemDeferralReason = "before_end_date" | "gamma_unresolved" | "gamma_lookup_failed";

type AsyncResolutionJob =
  | {
      readonly kind: "market-resolved-hint";
      readonly hint: RuntimeEventMap["MarketResolvedHint"];
      readonly enqueuedAt: number;
    }
  | {
      readonly kind: "redeem-requested";
      readonly conditionIds: readonly string[];
      readonly enqueuedAt: number;
    };

interface ResolutionRuntimeMetrics {
  writeEvent: (
    metricName: string,
    value?: number,
    labels?: string | null,
    capturedAt?: string,
  ) => void;
  writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
  writeLatest?: (
    metricName: string,
    value?: number,
    labels?: string | null,
    capturedAt?: string,
  ) => void;
}

interface ResolutionRedeemQuarantineState {
  readonly consecutiveStateFailedCount: number;
  readonly redeemQuarantineUntilTs: number | null;
}

interface ResolutionRedeemQuarantineStore {
  findByConditionIds(conditionIds: readonly string[]): Map<string, ResolutionRedeemQuarantineState>;
  recordBenignZeroBalanceSkip(input: { conditionId: string; nowTs: number; ttlMs: number }): {
    readonly enteredQuarantine: boolean;
    readonly redeemQuarantineUntilTs: number | null;
  };
  clearExpired(conditionId: string): { readonly reset: boolean };
}

type RedeemQuarantineReason = "state_failed_quarantine" | "zero_balance_quarantine";

export interface ResolutionModuleDeps {
  detector: ResolutionDetector;
  settler: PositionSettler;
  marketRepo: MarketRepository;
  resolutionRepo: MarketResolutionRepository;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  gammaClient: GammaResolutionClient;
  lotRepo: InventoryLotRepository;
  positionRepo: PositionRepository;
  db: Database.Database;
  bus: EventBus;
  log: Logger;
  checkIntervalMs: number;
  graceMinutes: number;
  /**
   * Optional exchange gateway for pre-settlement balance verification.
   * When provided, each candidate's on-chain token balance is checked
   * before settlement. Only candidates with zero balance are settled.
   * When absent, settlement proceeds without balance verification.
   */
  gateway?: ExchangeGateway;
  /**
   * Optional pause gate. When the runtime is paused, periodic and
   * hint/bus-triggered resolution sweeps are skipped so the bot does not
   * write settlements, deactivate markets, cancel orders, or submit redeems.
   */
  runtimeControl?: RuntimeControl;
  runtimeMetrics?: ResolutionRuntimeMetrics;
  settlementInfraBreaker?: SettlementInfraBreaker | undefined;
  redeemQuarantineRepo?: ResolutionRedeemQuarantineStore | undefined;
}

export class ResolutionModule implements RuntimeModule {
  private intervalHandle: NodeJS.Timeout | null = null;
  private unsubs: Array<() => void> = [];
  private readonly pendingHintConditionIds = new Set<string>();
  private readonly hintedCancelledOrderIds = new Set<string>();
  private readonly redeemFailures = new Map<string, RedeemFailureEntry>();
  private running = false;
  private wsHintConsumed = 0;
  private recoveryPending = true;
  private readonly asyncResolutionQueue: AsyncResolutionJob[] = [];
  private asyncResolutionWorkerRunning = false;

  constructor(private readonly deps: ResolutionModuleDeps) {}

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("MarketResolvedHint", async (hint) => {
        this.enqueueAsyncResolutionJob({
          kind: "market-resolved-hint",
          hint,
          enqueuedAt: Date.now(),
        });
      }),
    );
    this.unsubs.push(
      this.deps.bus.subscribe("RedeemRequested", async (payload) => {
        this.enqueueAsyncResolutionJob({
          kind: "redeem-requested",
          conditionIds: [...payload.conditionIds],
          enqueuedAt: Date.now(),
        });
      }),
    );
    // Run once at startup (non-blocking)
    this.runCheck().catch((err) => this.deps.log.error(err, "startup resolution check failed"));
    this.tryRecoverUnresolved("startup");

    this.intervalHandle = setInterval(() => {
      this.runCheck().catch((err) => this.deps.log.error(err, "resolution check failed"));
    }, this.deps.checkIntervalMs);
  }

  private tryRecoverUnresolved(source: string): void {
    if (!this.recoveryPending) return;
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug({ source }, "resolution recovery deferred while runtime is paused");
      return;
    }
    this.recoveryPending = false;
    this.recoverUnresolved().catch((err) => {
      this.recoveryPending = true;
      this.deps.log.error(err, "resolution recovery failed");
    });
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    for (const unsub of this.unsubs) {
      unsub();
    }
    this.unsubs = [];
    this.asyncResolutionQueue.length = 0;
  }

  private enqueueAsyncResolutionJob(job: AsyncResolutionJob): void {
    if (this.asyncResolutionQueue.length >= ASYNC_RESOLUTION_QUEUE_MAX_DEPTH) {
      this.deps.log.error(
        {
          kind: job.kind,
          queueDepth: this.asyncResolutionQueue.length,
          maxDepth: ASYNC_RESOLUTION_QUEUE_MAX_DEPTH,
        },
        "resolution async queue overflow — dropping trigger",
      );
      this.writeResolutionCounter("resolution_async_queue_overflow_total", 1, job.kind);
      return;
    }

    this.asyncResolutionQueue.push(job);
    this.writeResolutionCounter("resolution_async_enqueued_total", 1, job.kind);
    this.writeResolutionLatest("resolution_async_queue_depth", this.asyncResolutionQueue.length);
    this.ensureAsyncResolutionWorker();
  }

  private ensureAsyncResolutionWorker(): void {
    if (this.asyncResolutionWorkerRunning) return;
    this.asyncResolutionWorkerRunning = true;
    void this.processAsyncResolutionQueue()
      .catch((err) => {
        this.deps.log.error({ err }, "resolution async worker crashed");
        this.writeResolutionCounter("resolution_async_worker_crashed_total");
      })
      .finally(() => {
        this.asyncResolutionWorkerRunning = false;
        this.writeResolutionLatest(
          "resolution_async_queue_depth",
          this.asyncResolutionQueue.length,
        );
        if (this.asyncResolutionQueue.length > 0) {
          this.ensureAsyncResolutionWorker();
        }
      });
  }

  private async processAsyncResolutionQueue(): Promise<void> {
    while (this.asyncResolutionQueue.length > 0) {
      const job = this.asyncResolutionQueue.shift()!;
      const startedAt = Date.now();
      try {
        if (job.kind === "market-resolved-hint") {
          await this.handleMarketResolvedHint(job.hint);
        } else {
          await this.handleAlgoRedeem(job.conditionIds);
        }
        this.writeResolutionCounter("resolution_async_completed_total", 1, job.kind);
        this.writeResolutionEvent(
          "resolution_async_latency_ms",
          Date.now() - job.enqueuedAt,
          job.kind,
        );
      } catch (err) {
        this.deps.log.error(
          { err, kind: job.kind, runtimeMs: Date.now() - startedAt },
          "resolution async job failed",
        );
        this.writeResolutionCounter("resolution_async_failed_total", 1, job.kind);
      } finally {
        this.writeResolutionLatest(
          "resolution_async_queue_depth",
          this.asyncResolutionQueue.length,
        );
      }
    }
  }

  private writeResolutionCounter(metricName: string, value = 1, kind?: string): void {
    const labels = kind ? JSON.stringify({ kind }) : null;
    this.writeResolutionCounterWithLabels(metricName, value, labels);
  }

  private writeResolutionCounterWithLabels(
    metricName: string,
    value = 1,
    labels: string | null = null,
  ): void {
    try {
      if (this.deps.runtimeMetrics?.writeCounter) {
        this.deps.runtimeMetrics.writeCounter(metricName, value, labels);
      } else {
        this.deps.runtimeMetrics?.writeEvent(metricName, value, labels);
      }
    } catch (err) {
      this.deps.log.debug({ err, metricName }, "resolution async metric write failed");
    }
  }

  private writeResolutionEvent(metricName: string, value: number, kind?: string): void {
    const labels = kind ? JSON.stringify({ kind }) : null;
    try {
      this.deps.runtimeMetrics?.writeEvent(metricName, value, labels);
    } catch (err) {
      this.deps.log.debug({ err, metricName }, "resolution async metric write failed");
    }
  }

  private writeResolutionLatest(metricName: string, value: number): void {
    try {
      if (this.deps.runtimeMetrics?.writeLatest) {
        this.deps.runtimeMetrics.writeLatest(metricName, value);
      } else {
        this.deps.runtimeMetrics?.writeEvent(metricName, value);
      }
    } catch (err) {
      this.deps.log.debug({ err, metricName }, "resolution async metric write failed");
    }
  }

  private async handleAlgoRedeem(conditionIds: readonly string[]): Promise<void> {
    if (conditionIds.length === 0) return;
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug({ conditionIds }, "algo redeem skipped while runtime is paused");
      return;
    }
    this.deps.log.info({ conditionIds }, "algo-triggered redeem requested");

    let settleableConditionIds = [...conditionIds];

    if (this.deps.gateway) {
      const now = Date.now();
      const { gatewayTargets, suppressed } = this.partitionRedeemTargets(conditionIds, now);

      if (suppressed.length > 0) {
        this.deps.log.warn(
          { conditionIds: suppressed, cooldownMs: REDEEM_CIRCUIT_OPEN_COOLDOWN_MS },
          "algo_redeem_circuit_open",
        );
      }

      // Local endDate pre-gate. A transiently-zero on-chain balance on a
      // still-live market (endDate in future) must never promote a condition
      // into alreadyRedeemed and thereby into an `algo-redeem` settlement row
      // — later fills re-grow the balance and the drift detector then treats
      // the live position as drift forever. Gamma check is left to the full
      // filterConfirmedRedeemable call below (for post-endDate targets only).
      const { live: deferredByEndDate, pastEndDate: eligibleByEndDate } = this.partitionByEndDate(
        gatewayTargets,
        now,
      );
      for (const entry of deferredByEndDate) {
        this.deps.log.info(entry, "algo_redeem_deferred_not_redeemable");
      }
      // Phase 3.B: drop already-redeemed conditions before calling the gateway.
      // The root-cause of many `algo-triggered on-chain redeem failed` events
      // is a prior tx that already drained the balance; re-submitting triggers
      // a revert. Drift detector (Phase 3.A) is the primary safety net for
      // any missed case.
      const { targetsNeedingRedeem, alreadyRedeemed } =
        await this.filterAlreadyRedeemed(eligibleByEndDate);
      if (this.deps.runtimeControl?.isPaused()) {
        this.deps.log.debug({ conditionIds }, "algo redeem aborted after pause flip mid-await");
        return;
      }
      // Gamma-gate BOTH paths before promoting to settlement. A transiently-
      // zero on-chain balance on a post-endDate market whose Gamma status is
      // still unresolved (UMA lag, dispute, …) must not create an algo-redeem
      // ledger row: later fills re-grow the balance and the drift detector
      // then treats the live position as drift forever. Running
      // filterConfirmedRedeemable across the combined set keeps the Gamma
      // check single-pass without leaking either branch.
      const combinedForGamma = [...targetsNeedingRedeem, ...alreadyRedeemed];
      const { redeemableTargets, deferred } = await this.filterConfirmedRedeemable(
        combinedForGamma,
        now,
      );
      if (this.deps.runtimeControl?.isPaused()) {
        this.deps.log.debug({ conditionIds }, "algo redeem aborted after pause flip mid-await");
        return;
      }
      for (const entry of deferred) {
        this.deps.log.info(entry, "algo_redeem_deferred_not_redeemable");
      }
      const redeemableSet = new Set(redeemableTargets);
      const gammaConfirmedNeedsRedeem = targetsNeedingRedeem.filter((c) => redeemableSet.has(c));
      const gammaConfirmedAlreadyRedeemed = alreadyRedeemed.filter((c) => redeemableSet.has(c));
      const successfullyRedeemed: string[] = [];

      // Invoke the gateway one conditionId at a time. The underlying
      // settlementExecute is a single relayer call per request, so wrapping a
      // multi-condition batch in one try/catch would record a failure against
      // every id in the batch when only one actually reverted — poisoning the
      // per-conditionId circuit for innocent markets. Submitting per condition
      // keeps success/failure strictly scoped to its own id.
      for (const conditionId of gammaConfirmedNeedsRedeem) {
        if (this.deps.runtimeControl?.isPaused()) {
          this.deps.log.debug(
            { remaining: gammaConfirmedNeedsRedeem.length - successfullyRedeemed.length },
            "algo redeem loop aborted after pause flip — remaining conditions deferred",
          );
          break;
        }
        if (this.skipIfActiveRedeemQuarantine(conditionId, Date.now(), "algo")) {
          continue;
        }
        const result = await this.submitRedeemAttempt(conditionId);
        if (result.ok) {
          this.deps.log.info(
            { conditionIds: [conditionId] },
            "algo-triggered on-chain redeem submitted",
          );
          successfullyRedeemed.push(conditionId);
        } else if (result.zeroBalanceQuarantined) {
          this.deps.log.info(
            { conditionIds: [conditionId] },
            "algo-triggered on-chain redeem zero-balance precheck skip quarantined",
          );
        } else {
          this.deps.log.error(
            { err: result.err, conditionIds: [conditionId] },
            "algo-triggered on-chain redeem failed",
          );
        }
      }

      settleableConditionIds = [...gammaConfirmedAlreadyRedeemed, ...successfullyRedeemed];

      const skippedLocalSettlement = conditionIds.filter(
        (conditionId) => !settleableConditionIds.includes(conditionId),
      );
      if (skippedLocalSettlement.length > 0) {
        // info, not warn: deferred (before_end_date / gamma_unresolved) is the
        // common case; true problems already surface via algo_redeem_circuit_open
        // (warn) and algo-triggered on-chain redeem failed (error).
        this.deps.log.info(
          { conditionIds: skippedLocalSettlement },
          "algo-triggered redeem skipped local settlement until on-chain redeem succeeds",
        );
      }
    }

    // Cancel any open orders on tokens we're about to settle so they don't
    // fill after the leg terminates. Mirrors cancelOpenOrders in the normal
    // resolution path. These cancels are reality-following protective cleanup
    // tied to the upcoming settlement writes — skipping them on a pause flip
    // would leave open orders against settled positions (fills after
    // settlement would re-grow the local balance and trip the drift detector).
    // ExecutionModule's handleCancel proceeds even under pause, so the
    // published CancelOrderRequested events do get executed; we must publish
    // all of them. No pause break inside this loop.
    for (const conditionId of settleableConditionIds) {
      const markets = this.deps.marketRepo.findByConditionId(conditionId);
      for (const market of markets) {
        await this.cancelOpenOrders(market.tokenId);
      }
    }

    // settlement_ledger.condition_id FK references market_resolutions. On the
    // normal resolution path the row is written by processDetectedResolutions;
    // on the algo-redeem path there is no Gamma-detected resolution, so we
    // must upsert a row marked source="algo" before settleAlgoRedeem or the
    // FK will reject the settlement write. ON CONFLICT DO NOTHING preserves
    // any pre-existing row written by a later market resolution.
    if (settleableConditionIds.length === 0) {
      return;
    }
    // Settlement here is reality-following: settleableConditionIds contains
    // either fresh on-chain submissions (successfullyRedeemed) or markets that
    // filterAlreadyRedeemed found already-redeemed on-chain. Skipping
    // settlement under pause would leak inventory (on-chain redeemed, local
    // ledger still open) and is the very leak this fix is supposed to prevent.
    // Pre-on-chain pause gates above already block FRESH submissions; once we
    // have settleable IDs, the local writes must follow.

    const now = new Date().toISOString();
    for (const conditionId of settleableConditionIds) {
      this.deps.resolutionRepo.save({
        conditionId,
        resolution: "algo-redeem",
        resolvedAt: now,
        detectedAt: now,
        source: "algo",
        rawResponse: null,
        status: "detected",
      });
    }

    const settled = this.deps.settler.settleAlgoRedeem(settleableConditionIds);
    for (const s of settled) {
      await this.deps.bus.publish("PositionSettled", s);
    }

    if (settled.length > 0) {
      this.deps.log.info(
        { conditionIds: settleableConditionIds, settledCount: settled.length },
        "algo-triggered redeem settled local positions",
      );
    }
  }

  getHintMetricsSnapshot(): { readonly resolutionWsHintsConsumed: number } {
    return {
      resolutionWsHintsConsumed: this.wsHintConsumed,
    };
  }

  /**
   * Phase 3.B — skip conditions whose outcome-token balances are already zero
   * on-chain. A previous redeem succeeded (or there was nothing to redeem);
   * re-submitting would revert and trip the circuit. On balance-check error,
   * fall through to the gateway so the circuit still records real failures.
   */
  private async filterAlreadyRedeemed(
    conditionIds: readonly string[],
  ): Promise<{ targetsNeedingRedeem: string[]; alreadyRedeemed: string[] }> {
    if (conditionIds.length === 0) {
      return { targetsNeedingRedeem: [], alreadyRedeemed: [] };
    }
    const gateway = this.deps.gateway!;
    const needsRedeem: string[] = [];
    const alreadyRedeemed: string[] = [];
    for (const conditionId of conditionIds) {
      // Per-iteration pause gate: each conditionId triggers up to N
      // getOutcomeTokenBalance() gateway calls. Stop issuing new ones the
      // moment pause flips. Caller's post-helper pause check aborts the rest
      // of the algo-redeem flow before any on-chain submission.
      if (this.deps.runtimeControl?.isPaused()) {
        this.deps.log.debug(
          { processed: needsRedeem.length + alreadyRedeemed.length, total: conditionIds.length },
          "filterAlreadyRedeemed aborted after pause flip mid-loop",
        );
        break;
      }
      const markets = this.deps.marketRepo.findByConditionId(conditionId);
      if (markets.length === 0) {
        needsRedeem.push(conditionId);
        continue;
      }
      let allZero = true;
      let abortedByPause = false;
      for (const market of markets) {
        // Inner-loop pause gate: each market issues another
        // getOutcomeTokenBalance() call. Stop issuing new ones the moment
        // pause flips, and treat the condition as "not yet proven redeemed"
        // (allZero=false) so it does not fall into the alreadyRedeemed bucket
        // on incomplete data. Caller's post-helper pause check aborts the
        // rest of the algo-redeem flow before any on-chain submission.
        if (this.deps.runtimeControl?.isPaused()) {
          allZero = false;
          abortedByPause = true;
          break;
        }
        try {
          const balance = await gateway.getOutcomeTokenBalance(market.tokenId);
          if (balance !== 0n) {
            allZero = false;
            break;
          }
        } catch (err) {
          this.deps.log.warn(
            { conditionId, tokenId: String(market.tokenId), err },
            "algo_redeem_precheck_failed",
          );
          allZero = false;
          break;
        }
      }
      if (abortedByPause) {
        this.deps.log.debug(
          { conditionId },
          "filterAlreadyRedeemed inner balance loop aborted after pause flip",
        );
        break;
      }
      if (allZero) {
        this.deps.log.info({ conditionId }, "algo_redeem_skipped_already_redeemed");
        this.redeemFailures.delete(conditionId);
        alreadyRedeemed.push(conditionId);
      } else {
        needsRedeem.push(conditionId);
      }
    }
    return { targetsNeedingRedeem: needsRedeem, alreadyRedeemed };
  }

  private async filterConfirmedRedeemable(
    conditionIds: readonly string[],
    now: number,
  ): Promise<{
    redeemableTargets: string[];
    deferred: Array<{
      readonly conditionId: string;
      readonly reason: AlgoRedeemDeferralReason;
      readonly slug?: string;
      readonly endDate?: string;
    }>;
  }> {
    if (conditionIds.length === 0) {
      return { redeemableTargets: [], deferred: [] };
    }

    const redeemableTargets: string[] = [];
    const deferred: Array<{
      readonly conditionId: string;
      readonly reason: AlgoRedeemDeferralReason;
      readonly slug?: string;
      readonly endDate?: string;
    }> = [];

    for (const conditionId of conditionIds) {
      // Per-iteration pause gate: each conditionId may trigger a Gamma API
      // lookup. Stop issuing new ones the moment pause flips. Caller's
      // post-helper pause check aborts the rest of the algo-redeem flow
      // before any on-chain submission.
      if (this.deps.runtimeControl?.isPaused()) {
        this.deps.log.debug(
          { processed: redeemableTargets.length + deferred.length, total: conditionIds.length },
          "filterConfirmedRedeemable aborted after pause flip mid-loop",
        );
        break;
      }
      const markets = this.deps.marketRepo.findByConditionId(conditionId);
      if (markets.length === 0) {
        redeemableTargets.push(conditionId);
        continue;
      }

      const datedMarkets = markets
        .map((market) => ({
          slug: market.slug,
          endDate: market.endDate,
          endMs: market.endDate ? new Date(market.endDate).getTime() : NaN,
        }))
        .filter((market) => Number.isFinite(market.endMs));
      const latestEnd = datedMarkets.reduce<{
        readonly slug: string;
        readonly endDate: string;
        readonly endMs: number;
      } | null>((latest, current) => {
        if (!current.endDate) return latest;
        if (!latest || current.endMs > latest.endMs) {
          return {
            slug: current.slug,
            endDate: current.endDate,
            endMs: current.endMs,
          };
        }
        return latest;
      }, null);

      if (latestEnd && latestEnd.endMs > now) {
        deferred.push({
          conditionId,
          reason: "before_end_date",
          slug: latestEnd.slug,
          endDate: latestEnd.endDate,
        });
        continue;
      }

      const slug = markets[0]!.slug;
      try {
        const info = await this.deps.gammaClient.getMarketBySlug(slug);
        if (!info?.closed) {
          deferred.push({ conditionId, reason: "gamma_unresolved", slug });
          continue;
        }
      } catch (err) {
        this.deps.log.warn({ conditionId, slug, err }, "algo_redeem_gamma_lookup_failed");
        deferred.push({ conditionId, reason: "gamma_lookup_failed", slug });
        continue;
      }

      redeemableTargets.push(conditionId);
    }

    return { redeemableTargets, deferred };
  }

  /**
   * Local-only endDate partition. Does not call Gamma. If a market for the
   * condition has its `endDate` still in the future, the condition cannot be
   * redeemed on-chain, AND its on-chain balance (zero or otherwise) must not
   * drive a local algo-redeem settlement — those rows later mislead the drift
   * detector when new fills re-grow the balance.
   */
  private partitionByEndDate(
    conditionIds: readonly string[],
    now: number,
  ): {
    live: Array<{
      readonly conditionId: string;
      readonly reason: AlgoRedeemDeferralReason;
      readonly slug?: string;
      readonly endDate?: string;
    }>;
    pastEndDate: string[];
  } {
    const live: Array<{
      readonly conditionId: string;
      readonly reason: AlgoRedeemDeferralReason;
      readonly slug?: string;
      readonly endDate?: string;
    }> = [];
    const pastEndDate: string[] = [];
    for (const conditionId of conditionIds) {
      const markets = this.deps.marketRepo.findByConditionId(conditionId);
      if (markets.length === 0) {
        pastEndDate.push(conditionId);
        continue;
      }
      let liveEntry: { slug: string; endDate: string } | null = null;
      for (const market of markets) {
        if (!market.endDate) continue;
        const endMs = new Date(market.endDate).getTime();
        if (Number.isFinite(endMs) && endMs > now) {
          liveEntry = { slug: market.slug, endDate: market.endDate };
          break;
        }
      }
      if (liveEntry) {
        live.push({
          conditionId,
          reason: "before_end_date",
          slug: liveEntry.slug,
          endDate: liveEntry.endDate,
        });
      } else {
        pastEndDate.push(conditionId);
      }
    }
    return { live, pastEndDate };
  }

  private partitionRedeemTargets(
    conditionIds: readonly string[],
    now: number,
  ): { gatewayTargets: string[]; suppressed: string[] } {
    const gatewayTargets: string[] = [];
    const suppressed: string[] = [];
    for (const conditionId of conditionIds) {
      if (this.isRedeemCircuitOpen(conditionId, now)) suppressed.push(conditionId);
      else gatewayTargets.push(conditionId);
    }
    return { gatewayTargets, suppressed };
  }

  private isRedeemCircuitOpen(conditionId: string, now: number): boolean {
    const entry = this.redeemFailures.get(conditionId);
    if (!entry) return false;
    const sinceFailure = now - entry.failedAt;
    if (entry.failureCount >= REDEEM_CIRCUIT_OPEN_THRESHOLD) {
      return sinceFailure < REDEEM_CIRCUIT_OPEN_COOLDOWN_MS;
    }
    const backoff = REDEEM_BACKOFF_MS_BY_COUNT[entry.failureCount] ?? 0;
    return sinceFailure < backoff;
  }

  private recordRedeemFailure(conditionIds: readonly string[], now: number): void {
    for (const conditionId of conditionIds) {
      const prev = this.redeemFailures.get(conditionId);
      this.redeemFailures.set(conditionId, {
        failedAt: now,
        failureCount: (prev?.failureCount ?? 0) + 1,
      });
    }
  }

  /** Exposed for testing. */
  async runCheck(): Promise<number> {
    if (this.running) return 0;
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug("resolution check skipped while runtime is paused");
      return 0;
    }
    if (this.recoveryPending) {
      this.tryRecoverUnresolved("runCheck");
    }
    this.running = true;

    try {
      const resolutions = await this.deps.detector.detect(this.deps.graceMinutes);
      if (this.deps.runtimeControl?.isPaused()) {
        this.deps.log.debug(
          { detectedCount: resolutions.length },
          "resolution processing aborted after pause flip mid-await",
        );
        return 0;
      }
      return await this.processDetectedResolutions(resolutions);
    } finally {
      this.running = false;
      if (!this.deps.runtimeControl?.isPaused()) {
        void this.flushPendingHintConditions();
      }
    }
  }

  private async handleMarketResolvedHint(
    hint: import("@krabs/domain").RuntimeEventMap["MarketResolvedHint"],
  ): Promise<void> {
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug(
        { conditionId: hint.conditionId },
        "resolution hint skipped while runtime is paused",
      );
      return;
    }
    this.wsHintConsumed++;
    for (const tokenId of hint.tokenIds) {
      await this.cancelOpenOrders(tokenId, {
        rememberCancelledOrderIds: this.hintedCancelledOrderIds,
      });
    }
    this.pendingHintConditionIds.add(hint.conditionId);
    if (!this.running) {
      await this.flushPendingHintConditions();
    }
  }

  private async flushPendingHintConditions(): Promise<void> {
    if (this.running || this.pendingHintConditionIds.size === 0) return;
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug(
        { queued: this.pendingHintConditionIds.size },
        "resolution hint flush deferred while runtime is paused",
      );
      return;
    }
    this.running = true;
    try {
      const conditionIds = [...this.pendingHintConditionIds];
      this.pendingHintConditionIds.clear();
      const resolutions: DetectedResolution[] = [];
      for (const conditionId of conditionIds) {
        const detected = await this.deps.detector.detectCondition(conditionId);
        if (detected) {
          resolutions.push(detected);
        }
      }
      if (this.deps.runtimeControl?.isPaused()) {
        // Pause flipped mid-detection: re-queue any conditions we already
        // detected (they were drained above) so the next non-paused flush picks
        // them up. Avoid losing work silently.
        for (const detected of resolutions) {
          this.pendingHintConditionIds.add(detected.conditionId);
        }
        this.deps.log.debug(
          { queued: this.pendingHintConditionIds.size },
          "resolution hint flush aborted after pause flip mid-await",
        );
        return;
      }
      await this.processDetectedResolutions(resolutions);
    } finally {
      this.hintedCancelledOrderIds.clear();
      this.running = false;
      if (this.pendingHintConditionIds.size > 0 && !this.deps.runtimeControl?.isPaused()) {
        void this.flushPendingHintConditions();
      }
    }
  }

  private async processDetectedResolutions(
    resolutions: readonly DetectedResolution[],
  ): Promise<number> {
    let totalSettled = 0;

    for (const resolution of resolutions) {
      if (this.deps.runtimeControl?.isPaused()) {
        this.deps.log.debug(
          { conditionId: resolution.conditionId },
          "resolution processing aborted after pause flip mid-loop",
        );
        return totalSettled;
      }
      const isRetry = !!this.deps.resolutionRepo.findByConditionId(resolution.conditionId);

      if (!isRetry) {
        this.deps.resolutionRepo.save({
          conditionId: resolution.conditionId,
          resolution: resolution.resolution,
          resolvedAt: resolution.resolvedAt,
          detectedAt: new Date().toISOString(),
          source: resolution.source,
          rawResponse: resolution.rawResponse,
          status: "detected",
        });
      }

      if (!isRetry) {
        for (const candidate of resolution.candidates) {
          this.deps.marketRepo.deactivate(candidate.tokenId);
          await this.cancelOpenOrders(candidate.tokenId, {
            skipOrderIds: this.hintedCancelledOrderIds,
          });
        }
      }

      if (resolution.resolution === "unknown") {
        this.deps.log.warn(
          { conditionId: resolution.conditionId, source: resolution.source },
          "resolution unknown — requires manual review",
        );

        if (!isRetry) {
          await this.publishMarketResolved(resolution);
        }
        continue;
      }

      let eligibleCandidates: ResolutionCandidate[] = [...resolution.candidates];

      const preFilterCount = eligibleCandidates.length;
      let allVerified = !this.deps.gateway;
      if (this.deps.gateway && eligibleCandidates.length > 0) {
        const { winningCandidates, losingCandidates } = this.partitionCandidatesByResolution(
          resolution,
          eligibleCandidates,
        );
        eligibleCandidates = [...losingCandidates];
        allVerified = winningCandidates.length === 0;

        if (winningCandidates.length > 0) {
          // Pause re-check before initiating a NEW on-chain action. The
          // cancelOpenOrders loop above awaits; if pause flips during those
          // awaits we must not call submitResolutionRedeem (which submits an
          // on-chain redeem). Settlement is deferred to a future runCheck.
          // The earlier deactivate + cancel writes are reality-following
          // (they reflect Gamma-confirmed resolution) and remain committed.
          if (this.deps.runtimeControl?.isPaused()) {
            this.deps.log.debug(
              { conditionId: resolution.conditionId },
              "resolution on-chain redeem aborted after pause flip pre-submission",
            );
            return totalSettled;
          }
          const redeemStatus = await this.submitResolutionRedeem(
            resolution.conditionId,
            winningCandidates.map((candidate) => candidate.tokenId),
          );
          // submitResolutionRedeem may submit an on-chain redeem before pause
          // flips. The downstream settler.settle() writes mirror the on-chain
          // state and MUST follow even under pause; otherwise we'd leak
          // inventory (on-chain says redeemed, local ledger still open).
          if (redeemStatus === "ready") {
            const verifiedWinningCandidates = await this.filterByZeroBalance(
              winningCandidates,
              resolution.conditionId,
            );
            eligibleCandidates = [...eligibleCandidates, ...verifiedWinningCandidates];
            allVerified = verifiedWinningCandidates.length === winningCandidates.length;
          }
        }
      }

      const settleable = { ...resolution, candidates: eligibleCandidates };
      const settled = settleable.candidates.length > 0 ? this.deps.settler.settle(settleable) : [];
      totalSettled += settled.length;

      if (allVerified && settled.length === preFilterCount) {
        this.deps.resolutionRepo.markSettled(resolution.conditionId);
      }

      if (!isRetry) {
        await this.publishMarketResolved(resolution);
      }

      for (const settledPosition of settled) {
        await this.deps.bus.publish("PositionSettled", settledPosition);
      }

      this.deps.log.info(
        {
          conditionId: resolution.conditionId,
          resolution: resolution.resolution,
          settledCount: settled.length,
        },
        `resolved market — settled ${settled.length} positions`,
      );
    }

    return totalSettled;
  }

  private partitionCandidatesByResolution(
    resolution: DetectedResolution,
    candidates: readonly ResolutionCandidate[],
  ): {
    readonly winningCandidates: ResolutionCandidate[];
    readonly losingCandidates: ResolutionCandidate[];
  } {
    const winningCandidates: ResolutionCandidate[] = [];
    const losingCandidates: ResolutionCandidate[] = [];

    for (const candidate of candidates) {
      if (this.isWinningCandidate(resolution, candidate)) {
        winningCandidates.push(candidate);
      } else {
        losingCandidates.push(candidate);
      }
    }

    return { winningCandidates, losingCandidates };
  }

  private isWinningCandidate(
    resolution: DetectedResolution,
    candidate: ResolutionCandidate,
  ): boolean {
    if (resolution.winnerTokenId) {
      return String(candidate.tokenId) === String(resolution.winnerTokenId);
    }
    return (
      normalizeOutcomeLabel(candidate.outcome) === normalizeOutcomeLabel(resolution.resolution)
    );
  }

  private async submitResolutionRedeem(
    conditionId: string,
    redeemTokenIds: readonly TokenId[],
  ): Promise<"ready" | "deferred"> {
    const now = Date.now();
    if (this.skipIfActiveRedeemQuarantine(conditionId, now, "resolution")) {
      return "deferred";
    }

    const failure = this.redeemFailures.get(conditionId);
    if (failure && now - failure.failedAt < RESOLUTION_REDEEM_RETRY_COOLDOWN_MS) {
      this.deps.log.debug(
        {
          conditionId,
          failureCount: failure.failureCount,
          cooldownMs: RESOLUTION_REDEEM_RETRY_COOLDOWN_MS,
        },
        "resolution on-chain redeem retry suppressed by back-off",
      );
      return "deferred";
    }

    const infraPause = this.deps.settlementInfraBreaker?.current();
    if (infraPause) {
      this.deps.log.warn(
        { conditionId, code: infraPause.code, until: infraPause.until },
        "resolution on-chain redeem suppressed by settlement infra breaker",
      );
      return "deferred";
    }

    const result = await this.submitRedeemAttempt(conditionId, redeemTokenIds);
    if (!result.ok) {
      if (result.zeroBalanceQuarantined) {
        this.deps.log.info(
          { conditionId },
          "resolution on-chain redeem zero-balance precheck skip quarantined",
        );
        return "deferred";
      }
      const err = summarizeError(result.err);
      this.deps.log.warn(
        { conditionId, ...err },
        "resolution on-chain redeem failed — settlement deferred",
      );
      return "deferred";
    }

    if (this.deps.gateway?.hasPendingRedeemSubmission?.(conditionId) ?? false) {
      this.deps.log.info(
        { conditionId },
        "redeem submitted — deferring settlement verification until relayer confirms",
      );
      return "deferred";
    }

    return "ready";
  }

  private async submitRedeemAttempt(
    conditionId: string,
    redeemTokenIds?: readonly TokenId[],
  ): Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly err: unknown; readonly zeroBalanceQuarantined?: boolean }
  > {
    const infraPause = this.deps.settlementInfraBreaker?.current();
    if (infraPause) {
      this.deps.log.warn(
        { conditionId, code: infraPause.code, until: infraPause.until },
        "resolution on-chain redeem suppressed by settlement infra breaker",
      );
      return {
        ok: false,
        err: new Error(`settlement infra breaker open: ${infraPause.code}`),
      };
    }
    try {
      const options = redeemTokenIds
        ? { redeemTokenIdsByCondition: { [conditionId]: redeemTokenIds } }
        : undefined;
      if (options) {
        await this.deps.gateway!.redeemPositions([conditionId], options);
      } else {
        await this.deps.gateway!.redeemPositions([conditionId]);
      }
      this.redeemFailures.delete(conditionId);
      return { ok: true };
    } catch (err) {
      if (this.deps.redeemQuarantineRepo && isZeroBalancePrecheckSkipError(err)) {
        this.recordResolutionZeroBalanceQuarantine(conditionId, err);
        return { ok: false, err, zeroBalanceQuarantined: true };
      }
      this.recordRedeemFailure([conditionId], Date.now());
      return { ok: false, err };
    }
  }

  private getActiveRedeemQuarantine(
    conditionId: string,
    now: number,
  ): { readonly reason: RedeemQuarantineReason; untilTs: number } | null {
    const repo = this.deps.redeemQuarantineRepo;
    if (!repo) return null;
    const state = repo.findByConditionIds([conditionId]).get(conditionId);
    const untilTs = state?.redeemQuarantineUntilTs ?? null;
    if (untilTs === null) return null;
    if (untilTs > now) {
      return {
        reason:
          (state?.consecutiveStateFailedCount ?? 0) > 0
            ? "state_failed_quarantine"
            : "zero_balance_quarantine",
        untilTs,
      };
    }
    repo.clearExpired(conditionId);
    return null;
  }

  private skipIfActiveRedeemQuarantine(
    conditionId: string,
    now: number,
    path: "algo" | "resolution",
  ): boolean {
    const activeQuarantine = this.getActiveRedeemQuarantine(conditionId, now);
    if (!activeQuarantine) return false;
    const metricName =
      path === "algo"
        ? "algo_redeem_quarantine_skipped_total"
        : "resolution_redeem_quarantine_skipped_total";
    const logMessage =
      path === "algo"
        ? "algo-triggered on-chain redeem skipped by redeem quarantine"
        : "resolution on-chain redeem skipped by redeem quarantine";
    this.writeResolutionCounterWithLabels(
      metricName,
      1,
      JSON.stringify({ reason: activeQuarantine.reason }),
    );
    this.deps.log.info(
      { conditionId, reason: activeQuarantine.reason, until: activeQuarantine.untilTs },
      logMessage,
    );
    return true;
  }

  private recordResolutionZeroBalanceQuarantine(conditionId: string, err: unknown): void {
    this.redeemFailures.delete(conditionId);
    this.writeResolutionCounterWithLabels(
      "resolution_redeem_zero_balance_quarantined_total",
      1,
      JSON.stringify({ reason: "zero_balance_precheck_skip" }),
    );
    const repo = this.deps.redeemQuarantineRepo;
    if (!repo) return;
    repo.recordBenignZeroBalanceSkip({
      conditionId,
      nowTs: Date.now(),
      ttlMs: RESOLUTION_ZERO_BALANCE_QUARANTINE_TTL_MS,
    });
    this.deps.log.info(
      { conditionId, err: summarizeError(err) },
      "resolution recorded zero-balance redeem quarantine",
    );
  }

  /**
   * Filter candidates to only those with near-zero on-chain token balance.
   * This ensures we only settle positions whose shares have been fully
   * redeemed or sold, while tolerating atomic-unit dust after settlement.
   */
  private async filterByZeroBalance(
    candidates: ResolutionCandidate[],
    conditionId: string,
  ): Promise<ResolutionCandidate[]> {
    const gateway = this.deps.gateway!;
    const settled: ResolutionCandidate[] = [];

    for (const candidate of candidates) {
      let balance: number;
      try {
        balance = await gateway.getPositionBalance(candidate.tokenId);
      } catch (err) {
        this.deps.log.warn(
          { tokenId: String(candidate.tokenId), conditionId, err },
          "skipping settlement — balance check failed",
        );
        continue;
      }
      if (balance <= SETTLEMENT_BALANCE_DUST_THRESHOLD) {
        settled.push(candidate);
      } else {
        this.deps.log.warn(
          { tokenId: String(candidate.tokenId), conditionId, balance },
          "skipping settlement — on-chain token balance is non-zero",
        );
      }
    }

    return settled;
  }

  private async publishMarketResolved(resolution: DetectedResolution): Promise<void> {
    await this.deps.bus.publish("MarketResolved", {
      conditionId: resolution.conditionId,
      tokenIds: resolution.candidates.map((c) => c.tokenId),
      resolution: resolution.resolution,
      resolvedAt: resolution.resolvedAt,
      source: resolution.source,
      timestamp: Date.now(),
    });
  }

  /** Publish CancelOrderRequested for open/partially-filled/pending orders on a resolved token. */
  private async cancelOpenOrders(
    tokenId: TokenId,
    opts?: Readonly<{
      skipOrderIds?: ReadonlySet<string>;
      rememberCancelledOrderIds?: Set<string>;
    }>,
  ): Promise<void> {
    const orders = this.deps.orderRepo.findByTokenId(tokenId);
    const active = orders.filter(
      (o) => o.status === "open" || o.status === "partially-filled" || o.status === "pending",
    );
    for (const order of active) {
      if (opts?.skipOrderIds?.has(String(order.orderId))) {
        continue;
      }
      // Pending orders without an exchange-assigned ID cannot be cancelled
      // on the exchange — just deactivate them locally.
      if (order.status === "pending" && !order.exchangeOrderId) {
        const telemetry = buildCancelTelemetry({
          order,
          nowMs: Date.now(),
          fillRepo: this.deps.fillRepo,
          marketRepo: this.deps.marketRepo,
        });
        this.deps.orderRepo.updateStatus(
          order.orderId,
          "cancelled",
          undefined,
          "market_resolved",
          telemetry,
        );
        opts?.rememberCancelledOrderIds?.add(String(order.orderId));
        this.deps.log.info(
          { orderId: String(order.orderId), tokenId: String(tokenId) },
          "locally cancelled pending order without exchange ID on resolved market",
        );
        continue;
      }
      opts?.rememberCancelledOrderIds?.add(String(order.orderId));
      await this.deps.bus.publish("CancelOrderRequested", {
        command: {
          type: "CancelOrderCommand" as const,
          commandId: createCommandId(`res-cancel-${String(order.orderId)}`),
          orderId: order.orderId,
          reason: "market_resolved" as const,
        },
        timestamp: Date.now(),
      });
      this.deps.log.info(
        { orderId: String(order.orderId), tokenId: String(tokenId) },
        "requested cancel for order on resolved market",
      );
    }
  }

  /** Re-resolve market_resolutions stuck in detected/unknown status. */
  private async recoverUnresolved(): Promise<number> {
    const allResolutions = this.deps.resolutionRepo.findAll();
    const unresolved = allResolutions.filter(
      (r) => r.status === "detected" && r.resolution === "unknown",
    );
    if (unresolved.length === 0) return 0;

    this.deps.log.info(
      { count: unresolved.length },
      "attempting recovery of unresolved conditions",
    );
    let recovered = 0;

    for (const mr of unresolved) {
      if (this.deps.runtimeControl?.isPaused()) {
        // Re-defer: leave the recovery flag set so the next non-paused runCheck
        // picks up the remaining unresolved rows from scratch.
        this.recoveryPending = true;
        this.deps.log.debug(
          { recovered, remaining: unresolved.length - recovered },
          "resolution recovery aborted after pause flip mid-loop",
        );
        return recovered;
      }
      const markets = this.deps.marketRepo.findByConditionId(mr.conditionId);
      if (markets.length === 0) continue;

      const slug = markets[0]!.slug;
      let info;
      try {
        info = await this.deps.gammaClient.getMarketBySlug(slug);
      } catch (err) {
        this.deps.log.warn(
          { conditionId: mr.conditionId, err },
          "recovery Gamma lookup failed — skipping",
        );
        continue;
      }
      if (this.deps.runtimeControl?.isPaused()) {
        this.recoveryPending = true;
        this.deps.log.debug(
          { conditionId: mr.conditionId },
          "resolution recovery aborted after pause flip mid-await",
        );
        return recovered;
      }
      if (!info?.closed) continue;

      const inferred = inferResolution(info.umaResolutionStatus, info.rawPayload);
      if (inferred === "unknown") continue;

      const resolution = inferred.outcome;
      const clobTokenIds = parseTokenIds(info.rawPayload);
      const winnerTokenId = inferred.winnerTokenId
        ? inferred.winnerTokenId
        : inferred.winnerIndex >= 0 && clobTokenIds[inferred.winnerIndex]
          ? clobTokenIds[inferred.winnerIndex]!
          : null;

      const resolvedAt = info.closedTime ?? new Date().toISOString();

      // Wrap ALL writes in a single transaction for atomicity
      const runSettlement = this.deps.db.transaction(() => {
        this.deps.resolutionRepo.updateResolution(
          mr.conditionId,
          resolution,
          resolvedAt,
          "gamma-api",
        );

        for (const market of markets) {
          // Find closed positions with orphaned lots for this token
          const allPositions = this.deps.positionRepo
            .findAll()
            .filter((p) => String(p.tokenId) === String(market.tokenId));
          const closedWithLots = allPositions.filter((p) => {
            if (p.status !== "closed") return false;
            const lots = this.deps.lotRepo.findOpen(p.positionId);
            return lots.length > 0;
          });

          for (const pos of closedWithLots) {
            const openLots = this.deps.lotRepo.findOpen(pos.positionId);
            const remainingSize = openLots.reduce((sum, l) => sum + l.remainingSize, 0);
            const isWinner = winnerTokenId
              ? String(market.tokenId) === winnerTokenId
              : normalizeOutcomeLabel(market.outcome) === normalizeOutcomeLabel(resolution);
            const settlementPrice = isWinner ? 1.0 : 0.0;
            const settlementPnl = (settlementPrice - pos.avgEntryPrice) * remainingSize;

            this.deps.lotRepo.settleAll(pos.positionId);

            const settlementId = `recovery-${mr.conditionId}-${String(market.tokenId)}`;
            this.deps.db
              .prepare(
                `INSERT OR IGNORE INTO settlement_ledger
                   (settlement_id, condition_id, position_id, token_id,
                    resolution, settlement_price, size, delta, settled_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                settlementId,
                mr.conditionId,
                String(pos.positionId),
                String(market.tokenId),
                resolution,
                settlementPrice,
                remainingSize,
                settlementPnl,
                resolvedAt,
              );

            this.deps.positionRepo.save({
              ...pos,
              size: 0,
              realizedPnl: pos.realizedPnl + settlementPnl,
              currentValueUsdc: 0,
              closedAt: resolvedAt,
              updatedAt: new Date().toISOString(),
            });

            this.deps.log.info(
              {
                positionId: String(pos.positionId),
                resolution,
                settlementPnl: settlementPnl.toFixed(4),
              },
              "recovery: settled orphaned closed position",
            );
          }
        }
      });
      runSettlement();

      this.deps.log.info(
        { conditionId: mr.conditionId, resolution },
        "recovered unresolved condition",
      );
      recovered++;
    }

    return recovered;
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: true,
      detail: `interval=${this.deps.checkIntervalMs}ms grace=${this.deps.graceMinutes}min asyncQueueDepth=${this.asyncResolutionQueue.length}`,
    };
  }
}
