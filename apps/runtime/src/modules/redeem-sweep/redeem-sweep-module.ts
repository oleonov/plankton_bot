import type {
  EventBus,
  ExchangeGateway,
  InventoryLotRepository,
  MarketRepository,
  PositionRepository,
  RedeemSweepPolicy,
  RuntimeEventMap,
  RuntimeModule,
  RedeemPositionsResult,
} from "@krabs/domain";
import { createTokenId } from "@krabs/domain";
import type { PolymarketPositionReader } from "@krabs/exchange";
import type { Logger } from "../../logger.js";
import type { RuntimeMetricWriter } from "../../runtime-metric-writer.js";
import type { RedeemLogEntry, SqliteRedeemLogRepository } from "@krabs/db";

interface RedeemSweepDeps {
  bus: EventBus;
  gateway: ExchangeGateway;
  positionReader: PolymarketPositionReader;
  positionRepo: PositionRepository;
  lotRepo: InventoryLotRepository;
  marketRepo: MarketRepository;
  redeemLogRepo: SqliteRedeemLogRepository;
  policy: () => RedeemSweepPolicy;
  log: Logger;
  runtimeMetrics?: RuntimeMetricWriter | undefined;
  now?: () => number;
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
  private readonly verificationAttemptsByCondition = new Map<string, number>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly verifyTimers = new Set<ReturnType<typeof setTimeout>>();
  private startupLoadPromise: Promise<void> | null = null;
  private startupLoadComplete = false;
  private isSweepRunning = false;
  private pendingSweepReason: string | null = null;
  private started = false;

  constructor(private readonly deps: RedeemSweepDeps) {}

  async start(): Promise<void> {
    this.started = true;
    this.unsubs.push(
      this.deps.bus.subscribe("PolymarketWalletUpdated", (event) =>
        this.handleWalletUpdated(event),
      ),
    );
    const policy = this.deps.policy();
    if (policy.enabled) {
      this.startupLoadPromise = this.loadInFlightFromDb(policy);
      await this.startupLoadPromise;
      this.startupLoadComplete = true;
      this.timer = setInterval(() => void this.runSweep("periodic"), policy.intervalMs);
      await this.runSweep("startup");
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.retryTimers) clearTimeout(timer);
    for (const timer of this.verifyTimers) clearTimeout(timer);
    this.retryTimers.clear();
    this.verifyTimers.clear();
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
        verificationAttempts: this.verificationAttemptsByCondition.size,
        retryTimers: this.retryTimers.size,
        verifyTimers: this.verifyTimers.size,
      }),
    };
  }

  isConditionInRedeemFlight(conditionId: string): boolean {
    const policy = this.deps.policy();
    if (!policy.enabled) return false;
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

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async handleWalletUpdated(
    event: RuntimeEventMap["PolymarketWalletUpdated"],
  ): Promise<void> {
    if (!this.deps.policy().enabled) return;
    await this.waitForStartupLoad();
    if (!event.positions.some((position) => position.redeemable && position.size > 0)) return;
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
    if (!this.started || !this.deps.policy().enabled) return;
    await this.waitForStartupLoad();
    const positions = await this.deps.positionReader.read();
    if (!positions) return;
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
    const redeemable = positions.filter((position) => position.redeemable && position.size > 0);
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

    for (const [conditionId, rows] of byCondition) {
      await this.attemptRedeem(this.buildGroup(conditionId, rows, positions), 0, source);
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

  private async attemptRedeem(
    group: RedeemGroup,
    retryCount: number,
    source: string,
  ): Promise<void> {
    const policy = this.deps.policy();
    const now = this.now();
    let keepInFlight = false;
    if (
      !this.reserveCondition(
        group.conditionId,
        now,
        policy,
        source === "retry" || source === "verify",
      )
    ) {
      return;
    }

    if (!this.insertAttemptingLog(group, retryCount, source, now)) return;

    try {
      const redeemResult = await this.deps.gateway.redeemPositions([group.conditionId], {
        redeemTokenIdsByCondition: {
          [group.conditionId]: group.includedTokenIds.map((tokenId) => createTokenId(tokenId)),
        },
      });
      const redeemLogStatus = redeemLogStatusForGatewayResult(redeemResult);
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
      keepInFlight =
        redeemResult.status === "submitted" ||
        redeemResult.status === "pending" ||
        redeemResult.reason === "no_redeem_requests";
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
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
      } else {
        this.scheduleRetry({ group, retryCount: retryCount + 1 });
      }
    } finally {
      if (!keepInFlight) this.inFlightByCondition.delete(group.conditionId);
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

  private scheduleRetry(task: RetryTask): void {
    const policy = this.deps.policy();
    const delay =
      policy.retryBackoffMs[Math.min(task.retryCount - 1, policy.retryBackoffMs.length - 1)]!;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.attemptRedeem(task.group, task.retryCount, "retry");
    }, delay);
    this.retryTimers.add(timer);
  }

  private scheduleVerification(group: RedeemGroup, delayMs?: number): void {
    const timer = setTimeout(() => {
      this.verifyTimers.delete(timer);
      void this.verifyRedeem(group);
    }, delayMs ?? this.deps.policy().postRedeemVerifyDelayMs);
    this.verifyTimers.add(timer);
  }

  private async verifyRedeem(group: RedeemGroup): Promise<void> {
    if (!this.started || !this.deps.policy().enabled) return;
    const positions = await this.deps.positionReader.read();
    const remaining = positions?.filter(
      (position) =>
        group.includedTokenIds.includes(position.tokenId) &&
        position.redeemable &&
        position.size > 0,
    );
    if (!remaining || remaining.length === 0) {
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
