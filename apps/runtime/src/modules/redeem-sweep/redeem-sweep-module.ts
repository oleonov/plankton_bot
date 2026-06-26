import type {
  EventBus,
  ExchangeGateway,
  InventoryLotRepository,
  MarketRepository,
  OrderRepository,
  PositionRepository,
  RedeemSweepPolicy,
  RiskEventRepository,
  RuntimeControl,
  RuntimeEventMap,
  RuntimeModule,
  RedeemPositionsResult,
  DepositActivationPolicy,
} from "@krabs/domain";
import { createTokenId } from "@krabs/domain";
import type { PolymarketPositionReader } from "@krabs/exchange";
import type { Logger } from "../../logger.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type {
  RedeemLogEntry,
  SqliteRedeemLogRepository,
  SqliteRedeemQuarantineRepository,
} from "@krabs/db";
import type { SettlementInfraBreaker } from "../settlement-infra-breaker.js";
import {
  isSettlementInfraRateLimitError,
  isZeroBalancePrecheckSkipError,
  parseRpcRateLimitResetMs,
} from "../settlement-infra-breaker.js";

const REDEEM_BATCH_SIZE = 9;
const REDEEM_BATCH_PAUSE_MS = 5 * 60_000;
const RPC_RATE_LIMIT_HARD_PAUSE_MS = 5 * 60_000;
const STATE_FAILED_COOLDOWN_MS = 30 * 60_000;
const STABILITY_SNAPSHOTS_REQUIRED = 2;
const PAUSE_DEFER_RECHECK_MS = 30_000;
const DEPOSIT_ACTIVATION_PERIODIC_COOLDOWN_MS = 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const DEFAULT_STATE_FAILED_QUARANTINE_THRESHOLD = 5;
const DEFAULT_STATE_FAILED_QUARANTINE_TTL_HOURS = 24;
const ASYNC_SWEEP_QUEUE_MAX_DEPTH = 16;
const HARD_PAUSE_WALLET_EVENT_COALESCE_MS = 60_000;

interface RedeemSweepDeps {
  bus: EventBus;
  gateway: ExchangeGateway;
  positionReader: PolymarketPositionReader;
  positionRepo: PositionRepository;
  lotRepo: InventoryLotRepository;
  marketRepo: MarketRepository;
  orderRepo?: OrderRepository | undefined;
  redeemLogRepo: SqliteRedeemLogRepository;
  redeemQuarantineRepo: SqliteRedeemQuarantineRepository;
  policy: () => RedeemSweepPolicy;
  depositActivationPolicy: () => DepositActivationPolicy;
  log: Logger;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  riskEventRepo?: RiskEventRepository | undefined;
  settlementInfraBreaker?: SettlementInfraBreaker | undefined;
  now?: () => number;
  /**
   * Optional pause gate. When the runtime is paused, periodic and
   * wallet-event-triggered sweeps are skipped, and the in-flight retry /
   * verification timers re-arm themselves until the runtime resumes so on-chain
   * redeem calls and settlement_attempts writes stay frozen.
   */
  runtimeControl?: RuntimeControl;
}

interface RedeemablePosition {
  tokenId: string;
  conditionId: string;
  size: number;
  redeemable: boolean;
  slug: string | null;
  outcome: string | null;
}

interface RedeemGroup {
  conditionId: string;
  includedTokenIds: string[];
  excludedTokenIds: string[];
}

interface RetryTask {
  group: RedeemGroup;
  retryCount: number;
}

interface AsyncSweepRequest {
  reason: string;
  enqueuedAt: number;
}

export class RedeemSweepModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: Array<() => void> = [];
  private readonly inFlightByCondition = new Map<string, number>();
  private readonly lastAttemptByCondition = new Map<string, number>();
  private readonly blockedUntilByCondition = new Map<string, number>();
  // Downsamples recurring skip telemetry: condition_id -> "reason:episodeKey"
  // (the quarantine/cooldown unlock ts). One redeem_log "skipped" row is written
  // per quarantine episode instead of one every ~15s sweep; bounded counters
  // still tick every skip.
  private readonly loggedRecurringSkipByCondition = new Map<string, string>();
  private readonly stabilityByCondition = new Map<string, { count: number; signature: string }>();
  private readonly verificationAttemptsByCondition = new Map<string, number>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly verifyTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly batchPauseTimers = new Set<ReturnType<typeof setTimeout>>();
  private startupLoadPromise: Promise<void> | null = null;
  private startupLoadComplete = false;
  private sweepDisabledUntilMs = 0;
  private isSweepRunning = false;
  private pendingSweepReason: string | null = null;
  private started = false;
  private pendingOrphanMarking = false;
  private lastActivationAttemptAt = 0;
  private lastHardPausedWalletEventAt = 0;
  private readonly asyncSweepQueue: AsyncSweepRequest[] = [];
  private asyncSweepWorkerRunning = false;

  constructor(private readonly deps: RedeemSweepDeps) {}

  async start(): Promise<void> {
    this.started = true;
    this.unsubs.push(
      this.deps.bus.subscribe("PolymarketWalletUpdated", (event) =>
        this.handleWalletUpdated(event),
      ),
    );
    const policy = this.deps.policy();
    this.startupLoadPromise = this.loadInFlightFromDb(policy);
    await this.startupLoadPromise;
    this.startupLoadComplete = true;
    this.timer = setInterval(() => void this.runSweep("periodic"), policy.intervalMs);
    await this.runSweep("startup");
  }

  private async runDeferredOrphanMarkingIfNeeded(): Promise<void> {
    if (!this.pendingOrphanMarking) return;
    if (this.deps.runtimeControl?.isPaused()) return;
    this.pendingOrphanMarking = false;
    const policy = this.deps.policy();
    const now = this.now();
    const orphaned = this.deps.redeemLogRepo.markOrphanedActiveAttempts(
      now - policy.inFlightTtlMs * 2,
      "runtime_restart_during_attempt",
    );
    if (orphaned.length > 0) {
      this.deps.log.error(
        { orphaned },
        "redeem sweep recovered orphaned attempts after runtime restart (post-resume)",
      );
      this.recordAlert("redeem_sweep_orphaned_attempts", {
        count: orphaned.length,
        conditionIds: orphaned.map((row) => row.conditionId),
      });
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.retryTimers) clearTimeout(timer);
    for (const timer of this.verifyTimers) clearTimeout(timer);
    for (const timer of this.batchPauseTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.verifyTimers.clear();
    this.batchPauseTimers.clear();
    this.startupLoadPromise = null;
    this.startupLoadComplete = false;
    this.asyncSweepQueue.length = 0;
    this.asyncSweepWorkerRunning = false;
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    return {
      ok: true,
      detail: JSON.stringify({
        inFlightConditions: this.inFlightByCondition.size,
        blockedConditions: this.blockedUntilByCondition.size,
        verificationAttempts: this.verificationAttemptsByCondition.size,
        retryTimers: this.retryTimers.size,
        verifyTimers: this.verifyTimers.size,
        asyncSweepQueueDepth: this.asyncSweepQueue.length,
        asyncSweepWorkerRunning: this.asyncSweepWorkerRunning,
        sweepDisabledUntilMs: this.sweepDisabledUntilMs,
      }),
    };
  }

  isConditionInRedeemFlight(conditionId: string): boolean {
    const policy = this.deps.policy();
    if (this.started && !this.startupLoadComplete) return true;
    const now = this.now();
    const startedAt = this.inFlightByCondition.get(conditionId);
    if (startedAt !== undefined) {
      if (now - startedAt < policy.inFlightTtlMs) return true;
      this.inFlightByCondition.delete(conditionId);
    }
    const active = this.deps.redeemLogRepo.hasRecentActiveAttempt(
      conditionId,
      now - policy.inFlightTtlMs,
    );
    if (active) this.inFlightByCondition.set(conditionId, now);
    return active;
  }

  notifySettlementInfraAlert(code: string): void {
    if (code === "POLYGON_RPC_RATE_LIMITED") {
      this.hardPauseSweep(code);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async handleWalletUpdated(
    event: RuntimeEventMap["PolymarketWalletUpdated"],
  ): Promise<void> {
    if (!this.deps.policy().enabled) return;
    const redeemable = event.positions.filter((p) => p.redeemable).length;
    if (redeemable === 0) {
      this.deps.log.debug(
        { totalPositions: event.positions.length, redeemablePositions: redeemable },
        "redeem sweep wallet-event received (no redeemable)",
      );
      return;
    }
    this.deps.log.info(
      { totalPositions: event.positions.length, redeemablePositions: redeemable },
      "redeem sweep wallet-event received",
    );
    this.enqueueAsyncSweep("wallet-event");
  }

  private enqueueAsyncSweep(reason: string): void {
    if (this.isSweepHardPaused()) {
      this.recordHardPausedAsyncTrigger(reason);
      return;
    }
    if (this.asyncSweepQueue.length >= ASYNC_SWEEP_QUEUE_MAX_DEPTH) {
      this.deps.log.warn(
        { reason, depth: this.asyncSweepQueue.length, maxDepth: ASYNC_SWEEP_QUEUE_MAX_DEPTH },
        "redeem sweep async queue overflow — trigger dropped",
      );
      this.recordMetricLabels("redeem_sweep_async_queue_overflow_total", {
        reason,
        max_depth: ASYNC_SWEEP_QUEUE_MAX_DEPTH,
      });
      return;
    }

    this.asyncSweepQueue.push({ reason, enqueuedAt: this.now() });
    this.recordMetricLabels("redeem_sweep_async_enqueued_total", { reason });
    this.recordAsyncQueueDepth();
    this.ensureAsyncSweepWorker();
  }

  private ensureAsyncSweepWorker(): void {
    if (this.asyncSweepWorkerRunning) return;
    this.asyncSweepWorkerRunning = true;
    void this.processAsyncSweepQueue()
      .catch((err) => {
        this.deps.log.error({ err }, "redeem sweep async worker crashed");
        this.recordAlert("redeem_sweep_async_worker_crashed", {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.asyncSweepWorkerRunning = false;
        this.recordAsyncQueueDepth();
        if (this.asyncSweepQueue.length > 0 && this.started) {
          this.ensureAsyncSweepWorker();
        }
      });
  }

  private async processAsyncSweepQueue(): Promise<void> {
    while (this.started && this.asyncSweepQueue.length > 0) {
      const request = this.asyncSweepQueue.shift();
      if (!request) continue;
      this.recordAsyncQueueDepth();
      const startedAt = this.now();
      try {
        await this.runSweep(request.reason);
        const completedAt = this.now();
        this.recordMetricLabels("redeem_sweep_async_completed_total", {
          reason: request.reason,
        });
        this.deps.runtimeMetrics?.writeEvent(
          "redeem_sweep_async_latency_ms",
          completedAt - request.enqueuedAt,
          JSON.stringify({
            reason: request.reason,
            queued_ms: startedAt - request.enqueuedAt,
            run_ms: completedAt - startedAt,
          }),
          new Date(completedAt).toISOString(),
        );
      } catch (err) {
        this.deps.log.error(
          { err, reason: request.reason, queuedMs: startedAt - request.enqueuedAt },
          "redeem sweep async worker failed",
        );
        this.recordMetricLabels("redeem_sweep_async_failed_total", {
          reason: request.reason,
        });
        this.recordAlert("redeem_sweep_async_failed", {
          reason: request.reason,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.recordAsyncQueueDepth();
      }
    }
  }

  private recordHardPausedAsyncTrigger(reason: string): void {
    if (reason !== "wallet-event") {
      this.recordMetricLabels("redeem_sweep_async_suppressed_hard_pause_total", { reason });
      return;
    }
    const now = this.now();
    if (now - this.lastHardPausedWalletEventAt < HARD_PAUSE_WALLET_EVENT_COALESCE_MS) return;
    this.lastHardPausedWalletEventAt = now;
    this.deps.log.info({ reason }, "redeem sweep wallet-event trigger coalesced — hard-paused");
    this.recordMetricLabels("redeem_sweep_async_suppressed_hard_pause_total", { reason });
  }

  private async runSweep(reason: string): Promise<void> {
    if (this.isSweepRunning) {
      this.pendingSweepReason = reason;
      return;
    }
    this.isSweepRunning = true;
    try {
      await this.doSweep(reason);
    } finally {
      const next = this.pendingSweepReason;
      this.pendingSweepReason = null;
      this.isSweepRunning = false;
      if (next !== null) {
        void this.runSweep(next);
      }
    }
  }

  private async doSweep(source: string): Promise<void> {
    if (!this.started || !this.deps.policy().enabled) {
      this.deps.log.info(
        { source, started: this.started, enabled: this.deps.policy().enabled },
        "redeem sweep doSweep skipped",
      );
      return;
    }
    if (this.isSweepHardPaused()) {
      this.deps.log.info({ source }, "redeem sweep doSweep skipped — hard-paused");
      return;
    }
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug({ source }, "redeem sweep skipped while runtime is paused");
      return;
    }
    await this.waitForStartupLoad();
    await this.runDeferredOrphanMarkingIfNeeded();
    const readStart = this.now();
    const positions = await this.deps.positionReader.read();
    const readMs = this.now() - readStart;
    if (!positions) {
      this.deps.log.warn({ source, readMs }, "redeem sweep positionReader returned null");
      return;
    }
    const redeemableCount = positions.filter((p) => p.redeemable).length;
    const snapshotPayload = {
      source,
      readMs,
      totalPositions: positions.length,
      redeemablePositions: redeemableCount,
    };
    if (redeemableCount > 0) {
      this.deps.log.info(snapshotPayload, "redeem sweep snapshot");
    } else {
      this.deps.log.debug(snapshotPayload, "redeem sweep snapshot");
    }
    await this.processPositions(
      positions.map((position) => ({
        tokenId: position.tokenId,
        conditionId: position.conditionId,
        size: position.size,
        redeemable: position.redeemable,
        slug: position.slug ?? position.marketSlug,
        outcome: position.outcome,
      })),
      source,
    );

    // Periodic safety-net: when there is nothing to redeem, check whether
    // residual USDC.e needs activation (e.g. after a manual redeem outside this
    // bot). Rate-limited so a busy sweep cycle doesn't hammer the RPC.
    if (redeemableCount === 0) {
      const sinceLast = this.now() - this.lastActivationAttemptAt;
      if (sinceLast >= DEPOSIT_ACTIVATION_PERIODIC_COOLDOWN_MS) {
        await this.tryActivateUsdcCollateral("periodic-safety-net");
      } else {
        this.deps.log.debug(
          { source, sinceLastMs: sinceLast, cooldownMs: DEPOSIT_ACTIVATION_PERIODIC_COOLDOWN_MS },
          "deposit activation safety-net rate-limited",
        );
      }
    }
  }

  private async waitForStartupLoad(): Promise<void> {
    if (this.startupLoadPromise) await this.startupLoadPromise;
  }

  private async loadInFlightFromDb(policy: RedeemSweepPolicy): Promise<void> {
    const now = this.now();
    // Orphan-marking writes (markOrphanedActiveAttempts + recordAlert) are
    // deferred when the runtime starts paused so the bot stays quiescent until
    // an operator resumes it. The in-memory in-flight state is still hydrated
    // so isConditionInRedeemFlight reports the truth from redeem_log.
    if (this.deps.runtimeControl?.isPaused()) {
      this.pendingOrphanMarking = true;
      this.deps.log.debug("redeem sweep orphan marking deferred while runtime is paused");
    } else {
      const orphaned = this.deps.redeemLogRepo.markOrphanedActiveAttempts(
        now - policy.inFlightTtlMs * 2,
        "runtime_restart_during_attempt",
      );
      if (orphaned.length > 0) {
        this.deps.log.error(
          { orphaned },
          "redeem sweep recovered orphaned attempts after runtime restart",
        );
        this.recordAlert("redeem_sweep_orphaned_attempts", {
          count: orphaned.length,
          conditionIds: orphaned.map((row) => row.conditionId),
        });
      }
    }

    for (const row of this.deps.redeemLogRepo.findRecentActiveAttempts(
      now - policy.inFlightTtlMs,
    )) {
      this.inFlightByCondition.set(row.conditionId, row.attemptTs);
      this.lastAttemptByCondition.set(row.conditionId, row.attemptTs);
      if (row.tokenIds.length > 0) {
        this.scheduleVerification(
          {
            conditionId: row.conditionId,
            includedTokenIds: row.tokenIds,
            excludedTokenIds: parseExcludedTokenIds(row.detailsJson),
          },
          Math.max(0, policy.postRedeemVerifyDelayMs - (now - row.attemptTs)),
        );
      }
    }
  }

  private async processPositions(
    positions: readonly {
      tokenId: string;
      conditionId: string | null;
      size: number;
      redeemable: boolean;
      slug: string | null;
      outcome: string | null;
    }[],
    source: string,
  ): Promise<void> {
    const redeemable = positions.filter((position) => position.redeemable);
    const missingCondition = redeemable.filter((position) => !position.conditionId);
    if (missingCondition.length > 0) {
      this.recordPartialAmbiguous(source, missingCondition);
    }

    const byCondition = new Map<string, RedeemablePosition[]>();
    for (const position of redeemable) {
      if (!position.conditionId) continue;
      const rows = byCondition.get(position.conditionId) ?? [];
      rows.push(position as RedeemablePosition);
      byCondition.set(position.conditionId, rows);
    }

    const readyGroups: RedeemGroup[] = [];
    let unstableSkipped = 0;
    let activeOrdersSkipped = 0;
    let quarantineSkipped = 0;
    const policy = this.deps.policy();
    for (const [conditionId, rows] of byCondition) {
      const group = this.buildGroup(conditionId, rows, positions);
      if (this.isRedeemQuarantineActive(group, source, this.now(), policy)) {
        quarantineSkipped++;
        continue;
      }
      if (!this.isStableRedeemCandidate(group)) {
        unstableSkipped++;
        continue;
      }
      if (this.hasActiveOrders(group, source)) {
        activeOrdersSkipped++;
        continue;
      }
      readyGroups.push(group);
    }

    this.deps.log.info(
      {
        source,
        redeemablePositions: redeemable.length,
        conditionGroups: byCondition.size,
        readyGroups: readyGroups.length,
        unstableSkipped,
        activeOrdersSkipped,
        quarantineSkipped,
        stabilityRequired: STABILITY_SNAPSHOTS_REQUIRED,
      },
      "redeem sweep processed positions",
    );

    for (let index = 0; index < readyGroups.length; index += REDEEM_BATCH_SIZE) {
      const batch = readyGroups.slice(index, index + REDEEM_BATCH_SIZE);
      await this.attemptRedeemBatch(batch, 0, source);
      if (index + REDEEM_BATCH_SIZE < readyGroups.length) {
        await this.pauseBetweenBatches();
      }
    }
  }

  private recordPartialAmbiguous(
    source: string,
    positions: readonly {
      tokenId: string;
      conditionId: string | null;
      size: number;
      redeemable: boolean;
      slug: string | null;
      outcome: string | null;
    }[],
  ): void {
    const conditionIds = new Set<string>();
    for (const position of positions) {
      const conditionId = position.conditionId ?? `unknown:${position.tokenId}`;
      conditionIds.add(conditionId);
      this.deps.redeemLogRepo.insert({
        conditionId,
        tokenIds: [position.tokenId],
        attemptTs: this.now(),
        status: "rejected",
        errorMsg: "partial_ambiguous",
        details: {
          source,
          reason: "redeemable_position_missing_condition_id",
          includedTokenIds: [position.tokenId],
          excludedTokenIds: [],
          position,
        },
      });
      this.recordMetricLabels("redeem_partial_ambiguous_total", {
        condition_id: conditionId,
      });
    }

    const details = {
      source,
      count: positions.length,
      conditionIds: [...conditionIds],
      tokenIds: positions.map((position) => position.tokenId),
    };
    this.deps.log.warn(details, "redeem_sweep_partial_ambiguous_batch");
    this.recordAlert("redeem_sweep_partial_ambiguous", details);
  }

  private buildGroup(
    conditionId: string,
    included: readonly RedeemablePosition[],
    allPositions: readonly { tokenId: string; conditionId: string | null; size: number }[],
  ): RedeemGroup {
    const includedSet = new Set(included.map((position) => position.tokenId));
    const marketRows = this.deps.marketRepo.findByConditionId(conditionId);
    const conditionPositions = allPositions.filter(
      (position) => position.conditionId === conditionId,
    );
    const excludedTokenIds = conditionPositions
      .filter((position) => position.size > 0 && !includedSet.has(position.tokenId))
      .map((position) => position.tokenId);
    return {
      conditionId,
      includedTokenIds: [...includedSet],
      excludedTokenIds: [
        ...new Set([
          ...excludedTokenIds,
          ...marketRows
            .filter((market) => !includedSet.has(String(market.tokenId)))
            .map((market) => String(market.tokenId)),
        ]),
      ],
    };
  }

  private isStableRedeemCandidate(group: RedeemGroup): boolean {
    const signature = [...group.includedTokenIds].sort().join(",");
    const prior = this.stabilityByCondition.get(group.conditionId);
    const count = prior?.signature === signature ? prior.count + 1 : 1;
    this.stabilityByCondition.set(group.conditionId, { signature, count });
    if (count >= STABILITY_SNAPSHOTS_REQUIRED) return true;
    this.recordMetricLabels("redeem_sweep_skipped_unstable_snapshot_total", {
      condition_id: group.conditionId,
      observed_count: count,
      required_count: STABILITY_SNAPSHOTS_REQUIRED,
    });
    return false;
  }

  private hasActiveOrders(group: RedeemGroup, source: string): boolean {
    const openOrders = this.deps.orderRepo?.findOpen() ?? [];
    const hasOpenConditionOrder = openOrders.some(
      (order) => String(order.conditionId) === group.conditionId,
    );
    if (!hasOpenConditionOrder) return false;
    this.recordRedeemSkip(group, source, "active_orders_exist");
    return true;
  }

  private insertRedeemSkipRow(
    group: RedeemGroup,
    source: string,
    reason: string,
    extraDetails: Record<string, unknown> = {},
  ): void {
    this.deps.redeemLogRepo.insert({
      conditionId: group.conditionId,
      tokenIds: group.includedTokenIds,
      attemptTs: this.now(),
      status: "skipped",
      errorMsg: reason,
      details: { source, reason, excludedTokenIds: group.excludedTokenIds, ...extraDetails },
    });
  }

  private recordRedeemSkip(
    group: RedeemGroup,
    source: string,
    reason: string,
    extraDetails: Record<string, unknown> = {},
  ): void {
    this.insertRedeemSkipRow(group, source, reason, extraDetails);
    this.recordBoundedMetricCounter("redeem_sweep_skipped_total", { reason });
  }

  /**
   * Telemetry for a skip that repeats every sweep (quarantine / cooldown). The
   * bounded `redeem_sweep_skipped_total` counter ticks on every skip so volume
   * stays observable, but the redeem_log "skipped" row is written at most once
   * per quarantine episode (keyed by unlock ts) instead of every ~15s — that
   * per-sweep row was the dominant source of redeem_log bloat.
   */
  private recordRecurringSkip(
    group: RedeemGroup,
    source: string,
    reason: string,
    episodeKey: number,
    extraDetails: Record<string, unknown> = {},
  ): void {
    this.recordBoundedMetricCounter("redeem_sweep_skipped_total", { reason });
    const dedupKey = `${reason}:${episodeKey}`;
    if (this.loggedRecurringSkipByCondition.get(group.conditionId) === dedupKey) return;
    this.loggedRecurringSkipByCondition.set(group.conditionId, dedupKey);
    this.insertRedeemSkipRow(group, source, reason, extraDetails);
  }

  private isRedeemQuarantineActive(
    group: RedeemGroup,
    source: string,
    now: number,
    policy: RedeemSweepPolicy,
  ): boolean {
    if (!isRedeemCircuitBreakerEnabled(policy)) return false;
    const state = this.deps.redeemQuarantineRepo
      .findByConditionIds([group.conditionId])
      .get(group.conditionId);
    const untilTs = state?.redeemQuarantineUntilTs ?? null;
    if (untilTs === null) return false;
    if (untilTs > now) {
      // A quarantine with no STATE_FAILED count is a benign zero-balance skip
      // (recordBenignZeroBalanceSkip leaves the counter at 0); a counted one is a
      // real STATE_FAILED quarantine. Same gate, distinct telemetry.
      const reason =
        (state?.consecutiveStateFailedCount ?? 0) > 0
          ? "state_failed_quarantine"
          : "zero_balance_quarantine";
      this.recordBoundedMetricCounter("redeem_quarantine_skipped_total", { reason });
      this.recordRecurringSkip(group, source, reason, untilTs, {
        consecutiveStateFailedCount: state?.consecutiveStateFailedCount ?? 0,
        quarantineUntilTs: untilTs,
      });
      return true;
    }

    this.loggedRecurringSkipByCondition.delete(group.conditionId);
    const reset = this.deps.redeemQuarantineRepo.clearExpired(group.conditionId);
    if (reset.reset) {
      this.recordMetricLabels("redeem_quarantine_expired_total", {
        condition_id: group.conditionId,
      });
      this.recordMetricLabels("redeem_quarantine_counter_reset_total", {
        condition_id: group.conditionId,
        reason: "ttl_expired",
      });
      this.deps.riskEventRepo?.insert({
        eventType: "redeem_quarantine_expired",
        payload: {
          condition_id: group.conditionId,
          previous_unlock_ts: reset.previousRedeemQuarantineUntilTs,
          source,
        },
      });
    }
    return false;
  }

  private isStateFailedCooldownActive(group: RedeemGroup, source: string, now: number): boolean {
    const blockedUntil = this.blockedUntilByCondition.get(group.conditionId);
    if (blockedUntil === undefined) return false;
    if (now >= blockedUntil) {
      this.blockedUntilByCondition.delete(group.conditionId);
      this.loggedRecurringSkipByCondition.delete(group.conditionId);
      return false;
    }
    this.recordRecurringSkip(group, source, "state_failed_cooldown", blockedUntil);
    return true;
  }

  private async attemptRedeem(
    group: RedeemGroup,
    retryCount: number,
    source: string,
  ): Promise<void> {
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug(
        { conditionId: group.conditionId, retryCount, source },
        "redeem attempt skipped while runtime is paused",
      );
      return;
    }
    await this.attemptRedeemBatch([group], retryCount, source);
  }

  private async attemptRedeemBatch(
    groups: readonly RedeemGroup[],
    retryCount: number,
    source: string,
  ): Promise<void> {
    if (groups.length === 0 || this.isSweepHardPaused()) return;
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug(
        { source, retryCount, count: groups.length },
        "redeem batch skipped while runtime is paused",
      );
      return;
    }
    const policy = this.deps.policy();
    const now = this.now();
    const reservedGroups: RedeemGroup[] = [];
    const keepInFlightConditions = new Set<string>();
    for (const group of groups) {
      if (this.isRedeemQuarantineActive(group, source, now, policy)) continue;
      if (this.isStateFailedCooldownActive(group, source, now)) continue;
      if (
        !this.reserveCondition(
          group.conditionId,
          now,
          policy,
          source === "retry" || source === "verify",
        )
      ) {
        continue;
      }
      if (!this.insertAttemptingLog(group, retryCount, source, now)) continue;
      reservedGroups.push(group);
    }
    if (reservedGroups.length === 0) {
      return;
    }

    try {
      const redeemResult = await this.deps.gateway.redeemPositions(
        reservedGroups.map((group) => group.conditionId),
        { redeemTokenIdsByCondition: this.buildRedeemTokenMap(reservedGroups) },
      );
      // Pause may flip during the gateway await, but at this point the on-chain
      // redeem call has already been submitted (or attempted) — we MUST commit
      // the outcome to the redeem_log so the in-flight reservation reflects
      // reality. Skipping these writes under pause would orphan a real on-chain
      // submission and break the post-restart deduplication guard.
      const redeemLogStatus = redeemLogStatusForGatewayResult(redeemResult);
      const keepInFlight =
        redeemResult.status === "submitted" ||
        redeemResult.status === "pending" ||
        redeemResult.reason === "no_redeem_requests";
      for (const group of reservedGroups) {
        this.recordAttemptOutcome({
          conditionId: group.conditionId,
          tokenIds: group.includedTokenIds,
          status: redeemLogStatus,
          txHash: redeemResult.txHash ?? null,
          gasUsed: redeemResult.gasUsed ?? null,
          retryCount,
          details: {
            source,
            gatewayStatus: redeemResult.status,
            gatewayReason: redeemResult.reason ?? null,
            excludedTokenIds: group.excludedTokenIds,
          },
        });
        this.handleRedeemResult(group, redeemResult);
        if (redeemLogStatus === "success") {
          this.clearStateFailedCounterAfterSuccess(group, policy);
        }
        if (keepInFlight) {
          keepInFlightConditions.add(group.conditionId);
        } else {
          this.inFlightByCondition.delete(group.conditionId);
        }
      }
      // Fire activation only on confirmed success — on "submitted" the USDC.e
      // hasn't landed on the proxy yet, and the periodic safety-net will cover
      // the eventual confirmation.
      if (redeemLogStatus === "success") {
        await this.tryActivateUsdcCollateral("post-redeem");
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const rateLimited = isSettlementInfraRateLimitError(err);
      if (rateLimited) this.hardPauseSweep("POLYGON_RPC_RATE_LIMITED", err);
      // A zero-position-balance precheck skip is benign and terminal — there is
      // nothing on-chain to redeem, so retrying just burns relayer/RPC calls.
      // `redeemPositions` is a single batch call, so a single error can only be
      // attributed to a specific condition when the batch holds exactly one. For
      // multi-condition batches we fall through to the existing retry path, where
      // each group is re-driven individually (length 1) and quarantined then.
      if (!rateLimited && reservedGroups.length === 1 && isZeroBalancePrecheckSkipError(err)) {
        this.recordZeroBalanceSkip(reservedGroups[0]!, policy, source, errorMsg);
        return;
      }
      const settlementFailed = isSettlementStateFailedError(err);
      for (const group of reservedGroups) {
        if (settlementFailed) {
          this.blockedUntilByCondition.set(
            group.conditionId,
            this.now() + STATE_FAILED_COOLDOWN_MS,
          );
          this.recordStateFailed(group, policy, source);
        }
        this.recordAttemptOutcome({
          conditionId: group.conditionId,
          tokenIds: group.includedTokenIds,
          status: retryCount >= policy.maxRetries ? "failed_max_retries" : "failed",
          errorMsg,
          retryCount,
          details: { source, excludedTokenIds: group.excludedTokenIds },
        });
        if (retryCount >= policy.maxRetries) {
          this.deps.log.error(
            { conditionId: group.conditionId, errorMsg },
            "redeem sweep exhausted retries",
          );
          this.recordAlert("redeem_sweep_failed_max_retries", {
            conditionId: group.conditionId,
            tokenIds: group.includedTokenIds,
            errorMsg,
          });
        } else if (!rateLimited) {
          this.scheduleRetry({ group, retryCount: retryCount + 1 });
        }
      }
    } finally {
      for (const group of reservedGroups) {
        if (keepInFlightConditions.has(group.conditionId)) continue;
        this.inFlightByCondition.delete(group.conditionId);
      }
    }
  }

  private insertAttemptingLog(
    group: RedeemGroup,
    retryCount: number,
    source: string,
    attemptTs: number,
  ): boolean {
    try {
      this.deps.redeemLogRepo.insert({
        conditionId: group.conditionId,
        tokenIds: group.includedTokenIds,
        attemptTs,
        status: "attempting",
        retryCount,
        details: { source, excludedTokenIds: group.excludedTokenIds },
      });
      return true;
    } catch (err) {
      if (isRedeemLogUniqueInFlightViolation(err)) {
        this.inFlightByCondition.delete(group.conditionId);
        this.deps.log.info(
          { conditionId: group.conditionId },
          "redeem sweep race detected, condition already in-flight",
        );
        return false;
      }
      this.inFlightByCondition.delete(group.conditionId);
      throw err;
    }
  }

  private recordAttemptOutcome(entry: Omit<RedeemLogEntry, "attemptTs">): void {
    if (this.deps.redeemLogRepo.updateLatestActiveAttempt(entry)) return;
    this.deps.redeemLogRepo.insert({ ...entry, attemptTs: this.now() });
  }

  private recordStateFailed(group: RedeemGroup, policy: RedeemSweepPolicy, source: string): void {
    if (!isRedeemCircuitBreakerEnabled(policy)) return;
    const now = this.now();
    const result = this.deps.redeemQuarantineRepo.recordStateFailed({
      conditionId: group.conditionId,
      nowTs: now,
      threshold: policy.stateFailedQuarantineThreshold ?? DEFAULT_STATE_FAILED_QUARANTINE_THRESHOLD,
      ttlMs:
        (policy.stateFailedQuarantineTtlHours ?? DEFAULT_STATE_FAILED_QUARANTINE_TTL_HOURS) *
        HOUR_MS,
    });
    if (result.positionRows === 0) {
      this.deps.log.warn(
        { conditionId: group.conditionId },
        "redeem quarantine state failed counter had no local position rows",
      );
      this.recordMetricLabels("redeem_quarantine_missing_position_row_total", {
        condition_id: group.conditionId,
      });
    }
    if (!result.enteredQuarantine) return;
    this.recordMetricLabels("redeem_quarantined_total", {
      condition_id: group.conditionId,
      consecutive_count: result.consecutiveStateFailedCount,
      until_ts: result.redeemQuarantineUntilTs,
    });
    this.deps.riskEventRepo?.insert({
      eventType: "redeem_quarantine_entered",
      payload: {
        condition_id: group.conditionId,
        reason: "state_failed",
        consecutive_count: result.consecutiveStateFailedCount,
        expected_unlock_ts: result.redeemQuarantineUntilTs,
        token_ids: group.includedTokenIds,
        source,
      },
    });
  }

  /**
   * Treat a zero-position-balance precheck skip as a benign terminal outcome:
   * resolve the in-flight "attempting" row to "skipped" (NOT "failed", so no
   * retry and no failed_max_retries alert) and quarantine the condition so
   * subsequent sweeps stop calling the relayer. The quarantine is persisted
   * (positions table) and cleared by the existing TTL-expiry / post-success
   * machinery, so it survives a restart.
   */
  private recordZeroBalanceSkip(
    group: RedeemGroup,
    policy: RedeemSweepPolicy,
    source: string,
    errorMsg: string,
  ): void {
    this.recordAttemptOutcome({
      conditionId: group.conditionId,
      tokenIds: group.includedTokenIds,
      status: "skipped",
      errorMsg: "zero_balance_precheck_skip",
      details: {
        source,
        reason: "zero_balance_precheck_skip",
        excludedTokenIds: group.excludedTokenIds,
        relayerMessage: errorMsg,
      },
    });
    this.recordBoundedMetricCounter("redeem_zero_balance_skipped_total", {
      reason: "zero_balance_precheck_skip",
    });
    if (!isRedeemCircuitBreakerEnabled(policy)) return;
    const result = this.deps.redeemQuarantineRepo.recordBenignZeroBalanceSkip({
      conditionId: group.conditionId,
      nowTs: this.now(),
      ttlMs:
        (policy.stateFailedQuarantineTtlHours ?? DEFAULT_STATE_FAILED_QUARANTINE_TTL_HOURS) *
        HOUR_MS,
    });
    if (!result.enteredQuarantine) return;
    this.deps.riskEventRepo?.insert({
      eventType: "redeem_quarantine_entered",
      payload: {
        condition_id: group.conditionId,
        reason: "zero_balance_precheck_skip",
        expected_unlock_ts: result.redeemQuarantineUntilTs,
        token_ids: group.includedTokenIds,
        source,
      },
    });
  }

  private clearStateFailedCounterAfterSuccess(group: RedeemGroup, policy: RedeemSweepPolicy): void {
    if (!isRedeemCircuitBreakerEnabled(policy)) return;
    this.loggedRecurringSkipByCondition.delete(group.conditionId);
    const result = this.deps.redeemQuarantineRepo.clearAfterSuccess(group.conditionId);
    if (!result.reset) return;
    this.recordMetricLabels("redeem_quarantine_counter_reset_total", {
      condition_id: group.conditionId,
      reason: "success",
    });
  }

  private buildRedeemTokenMap(
    groups: readonly RedeemGroup[],
  ): Record<string, ReturnType<typeof createTokenId>[]> {
    const redeemTokenIdsByCondition: Record<string, ReturnType<typeof createTokenId>[]> = {};
    for (const group of groups) {
      redeemTokenIdsByCondition[group.conditionId] = group.includedTokenIds.map((tokenId) =>
        createTokenId(tokenId),
      );
    }
    return redeemTokenIdsByCondition;
  }

  private pauseBetweenBatches(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.batchPauseTimers.delete(timer);
        resolve();
      }, REDEEM_BATCH_PAUSE_MS);
      this.batchPauseTimers.add(timer);
    });
  }

  private isSweepHardPaused(): boolean {
    if (this.deps.settlementInfraBreaker?.isOpen()) return true;
    return this.now() < this.sweepDisabledUntilMs;
  }

  private hardPauseSweep(code: string, error?: unknown): void {
    const pause = this.deps.settlementInfraBreaker?.pause(code, error);
    const upstreamPauseMs = pause?.upstreamPauseMs ?? parseRpcRateLimitResetMs(error);
    const pauseMs = pause?.pauseMs ?? Math.max(RPC_RATE_LIMIT_HARD_PAUSE_MS, upstreamPauseMs ?? 0);
    const until = pause?.until ?? this.now() + pauseMs;
    if (until <= this.sweepDisabledUntilMs) return;
    this.sweepDisabledUntilMs = Math.max(this.sweepDisabledUntilMs, until);
    this.deps.log.error(
      { code, until, pauseMs, upstreamPauseMs },
      "redeem sweep hard-paused after settlement infra alert",
    );
    this.recordAlert("redeem_sweep_hard_paused", { code, until, pauseMs, upstreamPauseMs });
  }

  private handleRedeemResult(group: RedeemGroup, result: RedeemPositionsResult): void {
    if (result.status === "confirmed") {
      this.closeLocalPositions(group.includedTokenIds);
      this.recordMetric("redeem_sweep_success_total", group);
      this.scheduleVerification(group);
      return;
    }

    if (result.status === "submitted" || result.status === "pending") {
      this.recordMetric(`redeem_sweep_${result.status}_total`, group);
      this.scheduleVerification(group);
      return;
    }

    if (result.reason === "no_redeem_requests") {
      this.recordMetric("redeem_sweep_skipped_no_requests_total", group);
      this.scheduleVerification(group);
      return;
    }

    this.deps.log.error(
      {
        conditionId: group.conditionId,
        gatewayStatus: result.status,
        gatewayReason: result.reason,
      },
      "redeem sweep skipped without settlement support",
    );
    this.recordAlert("redeem_sweep_unsupported_settlement", {
      conditionId: group.conditionId,
      tokenIds: group.includedTokenIds,
      gatewayStatus: result.status,
      gatewayReason: result.reason ?? null,
    });
  }

  private reserveCondition(
    conditionId: string,
    now: number,
    policy: RedeemSweepPolicy,
    bypassRecentAttempt: boolean,
  ): boolean {
    if (this.isSweepHardPaused()) return false;
    const startedAt = this.inFlightByCondition.get(conditionId);
    if (startedAt !== undefined) {
      if (now - startedAt < policy.inFlightTtlMs) return false;
      this.inFlightByCondition.delete(conditionId);
    }
    if (
      !bypassRecentAttempt &&
      this.deps.redeemLogRepo.hasRecentActiveAttempt(conditionId, now - policy.inFlightTtlMs)
    ) {
      return false;
    }
    const persistedLastAttemptAt = this.deps.redeemLogRepo.findLatestAttemptTs(conditionId);
    if (persistedLastAttemptAt !== null) {
      this.lastAttemptByCondition.set(conditionId, persistedLastAttemptAt);
    }
    const lastAttemptAt = this.lastAttemptByCondition.get(conditionId);
    if (
      !bypassRecentAttempt &&
      lastAttemptAt !== undefined &&
      now - lastAttemptAt < policy.inFlightTtlMs
    ) {
      return false;
    }
    this.inFlightByCondition.set(conditionId, now);
    this.lastAttemptByCondition.set(conditionId, now);
    return true;
  }

  private scheduleRetry(task: RetryTask, overrideDelayMs?: number): void {
    const policy = this.deps.policy();
    const delay =
      overrideDelayMs ??
      policy.retryBackoffMs[Math.min(task.retryCount - 1, policy.retryBackoffMs.length - 1)]!;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (this.deps.runtimeControl?.isPaused()) {
        this.deps.log.debug(
          { conditionId: task.group.conditionId, retryCount: task.retryCount },
          "redeem retry deferred while runtime is paused",
        );
        this.scheduleRetry(task, Math.max(delay, PAUSE_DEFER_RECHECK_MS));
        return;
      }
      void this.attemptRedeem(task.group, task.retryCount, "retry");
    }, delay);
    this.retryTimers.add(timer);
  }

  private scheduleVerification(group: RedeemGroup, delayMs?: number): void {
    const delay = delayMs ?? this.deps.policy().postRedeemVerifyDelayMs;
    const timer = setTimeout(() => {
      this.verifyTimers.delete(timer);
      if (this.deps.runtimeControl?.isPaused()) {
        this.deps.log.debug(
          { conditionId: group.conditionId },
          "redeem verification deferred while runtime is paused",
        );
        this.scheduleVerification(group, Math.max(delay, PAUSE_DEFER_RECHECK_MS));
        return;
      }
      void this.verifyRedeem(group);
    }, delay);
    this.verifyTimers.add(timer);
  }

  private async verifyRedeem(group: RedeemGroup): Promise<void> {
    if (!this.started || !this.deps.policy().enabled) return;
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug(
        { conditionId: group.conditionId },
        "redeem verification skipped while runtime is paused",
      );
      return;
    }
    const positions = await this.deps.positionReader.read();
    if (this.deps.runtimeControl?.isPaused()) {
      this.deps.log.debug(
        { conditionId: group.conditionId },
        "redeem verification deferred after pause flip mid-await",
      );
      this.scheduleVerification(group);
      return;
    }
    if (positions === null) {
      const verificationAttempt = this.nextVerificationAttempt(group);
      if (verificationAttempt === null) return;
      this.deps.log.warn(
        { conditionId: group.conditionId, verificationAttempt },
        "redeem sweep verification read returned null",
      );
      this.recordMetricLabels("redeem_sweep_verify_read_null_total", {
        condition_id: group.conditionId,
        verification_attempt: verificationAttempt,
      });
      this.scheduleVerification(group);
      return;
    }
    const remaining = positions.filter(
      (position) =>
        group.includedTokenIds.includes(position.tokenId) &&
        position.redeemable &&
        position.size > 0,
    );
    if (remaining.length === 0) {
      this.recordAttemptOutcome({
        conditionId: group.conditionId,
        tokenIds: group.includedTokenIds,
        status: "success",
        details: { source: "verify", excludedTokenIds: group.excludedTokenIds },
      });
      this.closeLocalPositions(group.includedTokenIds);
      this.inFlightByCondition.delete(group.conditionId);
      this.verificationAttemptsByCondition.delete(group.conditionId);
      this.recordMetric("redeem_sweep_verified_cleared_total", group);
      this.clearStateFailedCounterAfterSuccess(group, this.deps.policy());
      return;
    }
    const verificationAttempt = this.nextVerificationAttempt(group);
    if (verificationAttempt === null) return;
    this.deps.log.warn(
      { conditionId: group.conditionId, verificationAttempt, remaining },
      "redeem sweep verification found remaining wallet shares",
    );
    this.recordMetric("redeem_sweep_verify_mismatch_total", group);
    this.recordAttemptOutcome({
      conditionId: group.conditionId,
      tokenIds: group.includedTokenIds,
      status: "failed",
      errorMsg: "verification_found_remaining_wallet_shares",
      retryCount: verificationAttempt - 1,
      details: { source: "verify", excludedTokenIds: group.excludedTokenIds },
    });
    this.inFlightByCondition.delete(group.conditionId);
    await this.attemptRedeem(group, verificationAttempt, "verify");
  }

  private nextVerificationAttempt(group: RedeemGroup): number | null {
    const policy = this.deps.policy();
    const attempt = (this.verificationAttemptsByCondition.get(group.conditionId) ?? 0) + 1;
    if (attempt > policy.maxRetries) {
      this.verificationAttemptsByCondition.delete(group.conditionId);
      this.recordAttemptOutcome({
        conditionId: group.conditionId,
        tokenIds: group.includedTokenIds,
        status: "failed_max_retries",
        errorMsg: "verification_retry_budget_exhausted",
        retryCount: attempt - 1,
        details: { source: "verify", excludedTokenIds: group.excludedTokenIds },
      });
      this.deps.log.error(
        { conditionId: group.conditionId, tokenIds: group.includedTokenIds },
        "redeem sweep verification exhausted retry budget",
      );
      this.recordAlert("redeem_sweep_verify_max_retries", {
        conditionId: group.conditionId,
        tokenIds: group.includedTokenIds,
      });
      this.inFlightByCondition.delete(group.conditionId);
      return null;
    }
    this.verificationAttemptsByCondition.set(group.conditionId, attempt);
    return attempt;
  }

  private closeLocalPositions(tokenIds: readonly string[]): void {
    const updatedAt = new Date(this.now()).toISOString();
    for (const tokenId of tokenIds) {
      const position = this.deps.positionRepo.findByTokenId(createTokenId(tokenId));
      if (!position) continue;
      this.deps.lotRepo.settleAll(position.positionId);
      this.deps.positionRepo.save({
        ...position,
        size: 0,
        currentValueUsdc: 0,
        status: "closed",
        closedAt: updatedAt,
        updatedAt,
      });
    }
  }

  private async tryActivateUsdcCollateral(trigger: string): Promise<void> {
    const activationPolicy = this.deps.depositActivationPolicy();
    if (!activationPolicy.enabled) return;
    const gateway = this.deps.gateway;
    if (!gateway.activatePendingUsdcCollateral) return;
    if (this.isSweepHardPaused()) return;
    if (this.deps.runtimeControl?.isPaused()) return;

    // cents × 10^4 → 6-decimal raw (USDC has 6 decimals, 1 cent = 0.01 USDC = 10_000 raw)
    const minAmountWei = BigInt(activationPolicy.minAmountUsdcCents) * 10_000n;
    try {
      const result = await gateway.activatePendingUsdcCollateral({ minAmountWei });
      // Mark the attempt as completed only on a clean return so a transient
      // failure does not silence the 1h periodic safety-net.
      this.lastActivationAttemptAt = this.now();
      this.deps.log.info(
        { trigger, status: result.status, perAsset: result.perAsset, txHash: result.txHash },
        "deposit activation attempted",
      );
      this.recordActivationAudit(trigger, result.status, result, null);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.deps.log.warn({ trigger, errorMsg }, "deposit activation failed");
      this.recordActivationAudit(trigger, "error", null, errorMsg);
    }
  }

  private recordActivationAudit(
    trigger: string,
    status: string,
    result: { perAsset: unknown; txHash: unknown; gasUsed: unknown } | null,
    error: string | null,
  ): void {
    this.deps.riskEventRepo?.insert({
      eventType: "deposit-activation",
      payload: {
        trigger,
        status,
        perAsset: result?.perAsset ?? [],
        txHash: result?.txHash ?? null,
        gasUsed: result?.gasUsed ?? null,
        error,
      },
    });
  }

  private recordMetric(metricName: string, group: RedeemGroup): void {
    this.deps.runtimeMetrics?.writeEvent(
      metricName,
      1,
      JSON.stringify({
        condition_id: group.conditionId,
        token_count: group.includedTokenIds.length,
      }),
      new Date(this.now()).toISOString(),
    );
  }

  private recordMetricLabels(metricName: string, labels: Record<string, unknown>): void {
    this.deps.runtimeMetrics?.writeEvent(
      metricName,
      1,
      JSON.stringify(labels),
      new Date(this.now()).toISOString(),
    );
  }

  private recordBoundedMetricCounter(metricName: string, labels: Record<string, unknown>): void {
    this.deps.runtimeMetrics?.writeCounter?.(metricName, 1, JSON.stringify(labels));
  }

  private recordAsyncQueueDepth(): void {
    this.deps.runtimeMetrics?.writeLatest(
      "redeem_sweep_async_queue_depth",
      this.asyncSweepQueue.length,
      null,
      new Date(this.now()).toISOString(),
    );
  }

  private recordAlert(code: string, details: Record<string, unknown>): void {
    this.deps.runtimeMetrics?.writeEvent(
      "infra_alert",
      1,
      JSON.stringify({ code, severity: "error", source: "redeem-sweep", details }),
      new Date(this.now()).toISOString(),
    );
  }
}

function redeemLogStatusForGatewayResult(
  result: RedeemPositionsResult,
): "success" | "submitted" | "pending" | "skipped" | "rejected" {
  if (result.status === "confirmed") return "success";
  if (result.status === "submitted") return "submitted";
  if (result.status === "pending") return "pending";
  if (result.reason === "unsupported_settlement") return "rejected";
  return "skipped";
}

function parseExcludedTokenIds(detailsJson: string | null): string[] {
  if (!detailsJson) return [];
  try {
    const parsed = JSON.parse(detailsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const excluded = (parsed as { excludedTokenIds?: unknown }).excludedTokenIds;
    return Array.isArray(excluded) ? excluded.map(String) : [];
  } catch {
    return [];
  }
}

function isSettlementStateFailedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  return (
    name === "SettlementTransactionFailedError" ||
    (typeof message === "string" && /STATE_FAILED|failed state|transaction.*failed/i.test(message))
  );
}

function isRedeemCircuitBreakerEnabled(policy: RedeemSweepPolicy): boolean {
  return policy.circuitBreakerEnabled !== false;
}

function isRedeemLogUniqueInFlightViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof message === "string" &&
    (message.includes("idx_redeem_log_unique_in_flight") ||
      message.includes("redeem_log.condition_id"))
  );
}
