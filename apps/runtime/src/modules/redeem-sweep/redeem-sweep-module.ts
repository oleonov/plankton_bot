import type {
  EventBus,
  ExchangeGateway,
  InventoryLotRepository,
  MarketRepository,
  OrderRepository,
  PositionRepository,
  RedeemSweepPolicy,
  RuntimeControl,
  RuntimeEventMap,
  RuntimeModule,
  RedeemPositionsResult,
} from "@krabs/domain";
import { createTokenId } from "@krabs/domain";
import type { PolymarketPositionReader } from "@krabs/exchange";
import type { Logger } from "../../logger.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { RedeemLogEntry, SqliteRedeemLogRepository } from "@krabs/db";

const REDEEM_BATCH_SIZE = 9;
const REDEEM_BATCH_PAUSE_MS = 5 * 60_000;
const RPC_RATE_LIMIT_HARD_PAUSE_MS = 5 * 60_000;
const STATE_FAILED_COOLDOWN_MS = 30 * 60_000;
const STABILITY_SNAPSHOTS_REQUIRED = 2;
const PAUSE_DEFER_RECHECK_MS = 30_000;

interface RedeemSweepDeps {
  bus: EventBus;
  gateway: ExchangeGateway;
  positionReader: PolymarketPositionReader;
  positionRepo: PositionRepository;
  lotRepo: InventoryLotRepository;
  marketRepo: MarketRepository;
  orderRepo?: OrderRepository | undefined;
  redeemLogRepo: SqliteRedeemLogRepository;
  policy: () => RedeemSweepPolicy;
  log: Logger;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
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

export class RedeemSweepModule implements RuntimeModule {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubs: Array<() => void> = [];
  private readonly inFlightByCondition = new Map<string, number>();
  private readonly lastAttemptByCondition = new Map<string, number>();
  private readonly blockedUntilByCondition = new Map<string, number>();
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
    await this.waitForStartupLoad();
    const redeemable = event.positions.filter((p) => p.redeemable).length;
    this.deps.log.info(
      { totalPositions: event.positions.length, redeemablePositions: redeemable },
      "redeem sweep wallet-event received",
    );
    if (redeemable === 0) return;
    await this.runSweep("wallet-event");
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
    this.deps.log.info(
      {
        source,
        readMs,
        totalPositions: positions.length,
        redeemablePositions: redeemableCount,
      },
      "redeem sweep snapshot",
    );
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
    for (const [conditionId, rows] of byCondition) {
      const group = this.buildGroup(conditionId, rows, positions);
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

  private recordRedeemSkip(group: RedeemGroup, source: string, reason: string): void {
    this.deps.redeemLogRepo.insert({
      conditionId: group.conditionId,
      tokenIds: group.includedTokenIds,
      attemptTs: this.now(),
      status: "skipped",
      errorMsg: reason,
      details: { source, reason, excludedTokenIds: group.excludedTokenIds },
    });
    this.recordMetricLabels("redeem_sweep_skipped_total", {
      condition_id: group.conditionId,
      reason,
    });
  }

  private isStateFailedCooldownActive(group: RedeemGroup, source: string, now: number): boolean {
    const blockedUntil = this.blockedUntilByCondition.get(group.conditionId);
    if (blockedUntil === undefined) return false;
    if (now >= blockedUntil) {
      this.blockedUntilByCondition.delete(group.conditionId);
      return false;
    }
    this.recordRedeemSkip(group, source, "state_failed_cooldown");
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
        if (keepInFlight) {
          keepInFlightConditions.add(group.conditionId);
        } else {
          this.inFlightByCondition.delete(group.conditionId);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const rateLimited = isRpcRateLimitError(err);
      const settlementFailed = isSettlementStateFailedError(err);
      if (rateLimited) this.hardPauseSweep("POLYGON_RPC_RATE_LIMITED");
      for (const group of reservedGroups) {
        if (settlementFailed) {
          this.blockedUntilByCondition.set(
            group.conditionId,
            this.now() + STATE_FAILED_COOLDOWN_MS,
          );
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
    return this.now() < this.sweepDisabledUntilMs;
  }

  private hardPauseSweep(code: string): void {
    const until = this.now() + RPC_RATE_LIMIT_HARD_PAUSE_MS;
    if (until <= this.sweepDisabledUntilMs) return;
    this.sweepDisabledUntilMs = Math.max(this.sweepDisabledUntilMs, until);
    this.deps.log.error({ code, until }, "redeem sweep hard-paused after settlement infra alert");
    this.recordAlert("redeem_sweep_hard_paused", { code, until });
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

function isRpcRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /(?:\b429\b|rate.?limit|too many requests|throughput limit|exceeded its compute units)/i.test(
    message,
  );
}

function isSettlementStateFailedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  return (
    name === "SettlementTransactionFailedError" ||
    (typeof message === "string" && /STATE_FAILED|failed state|transaction.*failed/i.test(message))
  );
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
