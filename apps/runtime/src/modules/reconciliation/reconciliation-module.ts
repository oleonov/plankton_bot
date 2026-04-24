/**
 * Reconciliation Module — startup reconciliation + periodic drift detection.
 *
 * Startup: runs full reconciliation during start() before returning,
 * blocking trading until the pass completes.
 *
 * Periodic: setInterval-driven loop with re-entrancy guard.
 *
 * Drift categories:
 *  - Phantom orders (local open, not on exchange) → cancelled locally
 *  - Unknown exchange orders (on exchange, not local) → logged
 *  - Missing fills → imported via importExchangeFills, FillReceived published on bus
 *  - Unrecoverable inventory drift → emits critical severity event
 *
 * Exchange is source of truth. Does NOT fabricate state.
 */

import type {
  RuntimeModule,
  EventBus,
  ExchangeGateway,
  OrderRepository,
  FillRepository,
  MarketRepository,
  ReconciliationResult,
  SettlementLedgerRepository,
  PositionDriftRepository,
} from "@plankton/domain";
import { createTokenId, createConditionId } from "@plankton/domain";
import type { Logger } from "../../logger.js";
import { reconcileOrders } from "./order-reconciler.js";
import { reconcileFills } from "./fill-reconciler.js";
import { cleanStaleEntryOrders } from "./stale-order-cleaner.js";

const DRIFT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DRIFT_INTERVAL_MS = 5 * 60 * 1000;

export interface ReconciliationModuleDeps {
  gateway: ExchangeGateway;
  bus: EventBus;
  orderRepo: OrderRepository;
  fillRepo: FillRepository;
  marketRepo: MarketRepository;
  log: Logger;
  reconcileIntervalMs: number;
  /**
   * Optional settlement ledger + drift repo + gateway balance accessor.
   * When all three are provided, a periodic drift check compares algo-redeem
   * settlements in the last 24h against on-chain outcome-token balances.
   */
  settlementLedgerRepo?: SettlementLedgerRepository;
  driftRepo?: PositionDriftRepository;
  /** Drift detection cadence. Defaults to 5 minutes. */
  driftIntervalMs?: number;
  /**
   * ADR-015 — per-call hook to read the current `exitOrderTtlMs` from the
   * execution policy snapshot. Passed through to `cleanStaleEntryOrders` so
   * operator edits take effect without a runtime restart. When omitted, the
   * cleaner falls back to the ADR-013 constant.
   */
  exitOrderTtlMs?: () => number;
}

export class ReconciliationModule implements RuntimeModule {
  private readonly log: Logger;
  private unsubs: Array<() => void> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private driftRunning = false;
  private started = false;
  private runCount = 0;
  private lastRunAt: number | null = null;
  private lastResult: ReconciliationResult | null = null;
  private readonly staleBackoffMap = new Map<string, number>();

  constructor(private readonly deps: ReconciliationModuleDeps) {
    this.log = deps.log.child({ module: "reconciliation" });
  }

  async start(): Promise<void> {
    // Startup reconciliation — blocks until complete
    this.log.info("running startup reconciliation");
    await this.runReconciliation();
    this.log.info("startup reconciliation complete");

    // Periodic loop
    this.timer = setInterval(() => {
      this.runReconciliation().catch((err) =>
        this.log.error({ err }, "periodic reconciliation error"),
      );
    }, this.deps.reconcileIntervalMs);

    if (this.driftCheckEnabled()) {
      const intervalMs = this.deps.driftIntervalMs ?? DEFAULT_DRIFT_INTERVAL_MS;
      this.driftTimer = setInterval(() => {
        this.runDriftCheck().catch((err) => this.log.error({ err }, "periodic drift check error"));
      }, intervalMs);
      this.log.info({ driftIntervalMs: intervalMs }, "position drift detection enabled");
    }

    this.started = true;
    this.log.info(
      { reconcileIntervalMs: this.deps.reconcileIntervalMs },
      "reconciliation module started",
    );
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.driftTimer) {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
    }
    for (const unsub of this.unsubs) unsub();
    this.unsubs = [];
    this.started = false;
    this.log.info("reconciliation module stopped");
  }

  async healthCheck(): Promise<{ readonly ok: boolean; readonly detail?: string }> {
    if (!this.started) {
      return { ok: false, detail: "not started" };
    }
    return {
      ok: true,
      detail: `runs=${this.runCount} lastRun=${this.lastRunAt ?? "never"} clean=${this.lastResult?.clean ?? "unknown"}`,
    };
  }

  /** Exposed for testing — in production driven by startup + interval timer. */
  async runReconciliation(): Promise<ReconciliationResult> {
    if (this.reconciling) {
      this.log.debug("reconciliation already in progress — skipping");
      return this.lastResult ?? this.emptyResult();
    }

    this.reconciling = true;
    try {
      const ranAt = Date.now();
      const allDetails: string[] = [];

      // 1. Order reconciliation
      // Grace = 2 intervals + 30s buffer. Covers worst case: order placed right after
      // pass N, still absent on pass N+1 (60s) and N+2 (120s), only phantom-cancel on N+3.
      const graceMs = this.deps.reconcileIntervalMs * 2 + 30_000;
      const orderResult = await reconcileOrders({
        gateway: this.deps.gateway,
        orderRepo: this.deps.orderRepo,
        log: this.log,
        phantomGraceMs: graceMs,
      });
      allDetails.push(...orderResult.details);

      // 2. Fill reconciliation (startup uses sinceMs=0, periodic uses last run)
      const sinceMs = this.lastRunAt ?? 0;
      const fillResult = await reconcileFills(
        {
          gateway: this.deps.gateway,
          fillRepo: this.deps.fillRepo,
          orderRepo: this.deps.orderRepo,
          bus: this.deps.bus,
          log: this.log,
        },
        sinceMs,
      );
      allDetails.push(...fillResult.details);

      // 3. Stale entry order cleanup
      const staleResult = await cleanStaleEntryOrders(
        {
          orderRepo: this.deps.orderRepo,
          marketRepo: this.deps.marketRepo,
          bus: this.deps.bus,
          log: this.log,
          ...(this.deps.exitOrderTtlMs ? { exitOrderTtlMs: this.deps.exitOrderTtlMs() } : {}),
        },
        this.staleBackoffMap,
      );
      if (staleResult.staleTtlCancelled > 0) {
        allDetails.push(`stale entry TTL cancels: ${staleResult.staleTtlCancelled}`);
      }
      if (staleResult.staleEndDateCancelled > 0) {
        allDetails.push(`stale entry endDate cancels: ${staleResult.staleEndDateCancelled}`);
      }
      if (staleResult.staleExitTtlCancelled > 0) {
        allDetails.push(`stale exit TTL cancels: ${staleResult.staleExitTtlCancelled}`);
      }

      // 4. Build result
      const clean =
        orderResult.phantomsCancelled === 0 &&
        orderResult.unknownExchangeOrders === 0 &&
        fillResult.missingFillsImported === 0 &&
        orderResult.staleCancelled === 0 &&
        orderResult.staleCancelFailed === 0 &&
        staleResult.staleTtlCancelled === 0 &&
        staleResult.staleEndDateCancelled === 0 &&
        staleResult.staleExitTtlCancelled === 0;

      const result: ReconciliationResult = {
        ranAt,
        openOrdersExchange: orderResult.exchangeOpenCount,
        openOrdersLocal: orderResult.localOpenCount,
        missingFills: fillResult.missingFillsImported,
        phantomOrders: orderResult.phantomsCancelled,
        positionDriftCount: 0,
        clean,
        details: allDetails,
      };

      this.runCount++;
      this.lastRunAt = ranAt;
      this.lastResult = result;

      // 5. Publish events
      if (!clean) {
        const severity =
          fillResult.missingFillsImported > 0 ? ("critical" as const) : ("warn" as const);
        await this.deps.bus.publish("ReconciliationDriftDetected", {
          details: allDetails.join("; "),
          severity,
          timestamp: ranAt,
        });
      }

      await this.deps.bus.publish("ReconciliationComplete", { result });

      this.log.info(
        {
          run: this.runCount,
          clean,
          phantoms: orderResult.phantomsCancelled,
          phantomsSkippedGrace: orderResult.phantomsSkippedGrace,
          missingFills: fillResult.missingFillsImported,
          unknownOrders: orderResult.unknownExchangeOrders,
          staleCancelled: orderResult.staleCancelled,
          staleCancelFailed: orderResult.staleCancelFailed,
          staleEntryTtl: staleResult.staleTtlCancelled,
          staleEntryEndDate: staleResult.staleEndDateCancelled,
          staleExitTtl: staleResult.staleExitTtlCancelled,
        },
        "reconciliation pass complete",
      );

      return result;
    } finally {
      this.reconciling = false;
    }
  }

  private emptyResult(): ReconciliationResult {
    return {
      ranAt: Date.now(),
      openOrdersExchange: 0,
      openOrdersLocal: 0,
      missingFills: 0,
      phantomOrders: 0,
      positionDriftCount: 0,
      clean: true,
      details: [],
    };
  }

  private driftCheckEnabled(): boolean {
    return !!(this.deps.settlementLedgerRepo && this.deps.driftRepo);
  }

  /**
   * Exposed for testing. Compares recent algo-redeem settlement rows against
   * their on-chain outcome-token balance; non-zero balances mean the redeem
   * transaction never cleared the position and a drift is persisted.
   */
  async runDriftCheck(): Promise<number> {
    if (!this.driftCheckEnabled()) return 0;
    if (this.driftRunning) return 0;
    this.driftRunning = true;
    try {
      return await this.doRunDriftCheck();
    } finally {
      this.driftRunning = false;
    }
  }

  private async doRunDriftCheck(): Promise<number> {
    const ledgerRepo = this.deps.settlementLedgerRepo!;
    const driftRepo = this.deps.driftRepo!;
    const now = Date.now();
    const cutoffIso = new Date(now - DRIFT_LOOKBACK_MS).toISOString();

    const recent = ledgerRepo.findAlgoRedeemSettlementsSince(cutoffIso);
    const seenSettlementIds = new Set<string>();
    const requeuedConditionIds = new Set<string>();
    let driftsPublished = 0;

    for (const row of recent) {
      seenSettlementIds.add(row.settlementId);
      driftsPublished += await this.checkRowForDrift(row, driftRepo, now, requeuedConditionIds);
    }

    // Sweep still-open drifts whose ledger row has aged out of the 24 h
    // lookback. Without this, a drift opened >24 h ago whose on-chain balance
    // has since cleared would stay `open` forever — markResolved() would never
    // run because the ledger row no longer enters the loop above.
    for (const open of driftRepo.findOpen()) {
      if (seenSettlementIds.has(open.settlementId)) continue;
      driftsPublished += await this.checkRowForDrift(
        {
          settlementId: open.settlementId,
          tokenId: open.tokenId,
          conditionId: open.conditionId,
        },
        driftRepo,
        now,
        requeuedConditionIds,
      );
    }

    return driftsPublished;
  }

  private async checkRowForDrift(
    row: { settlementId: string; tokenId: string; conditionId: string },
    driftRepo: PositionDriftRepository,
    now: number,
    requeuedConditionIds: Set<string>,
  ): Promise<number> {
    const tokenId = createTokenId(row.tokenId);
    let balance: bigint;
    try {
      balance = await this.deps.gateway.getOutcomeTokenBalance(tokenId);
    } catch (err) {
      this.log.warn(
        { err, tokenId: row.tokenId, conditionId: row.conditionId },
        "drift check gateway read failed",
      );
      return 0;
    }

    const nowIso = new Date(now).toISOString();
    if (balance === 0n) {
      driftRepo.markResolved(row.settlementId, nowIso);
      return 0;
    }

    // A non-zero balance against an `algo-redeem` ledger row is only drift
    // if the market is actually redeemable. For not-yet-resolved markets the
    // position is simply still live (e.g. re-entered after a prior local
    // settle) — do NOT flag it, do NOT requeue RedeemRequested. markResolved
    // closes any pre-existing row so it stops re-entering the open sweep.
    if (this.isMarketNotYetRedeemable(row.conditionId, now)) {
      driftRepo.markResolved(row.settlementId, nowIso);
      return 0;
    }

    const balanceStr = balance.toString();
    driftRepo.upsert({
      settlementId: row.settlementId,
      tokenId: row.tokenId,
      conditionId: row.conditionId,
      detectedAt: nowIso,
      onChainBalance: balanceStr,
      lastCheckedAt: nowIso,
      status: "open",
    });

    await this.deps.bus.publish("PositionDriftDetected", {
      settlementId: row.settlementId,
      tokenId,
      conditionId: createConditionId(row.conditionId),
      onChainBalance: balanceStr,
      detectedAt: now,
    });

    if (!requeuedConditionIds.has(row.conditionId)) {
      requeuedConditionIds.add(row.conditionId);
      await this.deps.bus.publish("RedeemRequested", {
        conditionIds: [row.conditionId],
        timestamp: now,
      });
    }

    this.log.warn(
      {
        settlementId: row.settlementId,
        tokenId: row.tokenId,
        conditionId: row.conditionId,
        onChainBalance: balanceStr,
      },
      "position_drift_detected",
    );
    return 1;
  }

  private isMarketNotYetRedeemable(conditionId: string, now: number): boolean {
    const markets = this.deps.marketRepo.findByConditionId(conditionId);
    if (markets.length === 0) return false;
    for (const market of markets) {
      if (!market.endDate) continue;
      const endMs = new Date(market.endDate).getTime();
      if (Number.isFinite(endMs) && endMs > now) return true;
    }
    return false;
  }
}
