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
  PositionRepository,
  ReconciliationResult,
  SettlementLedgerRepository,
  PositionDriftRepository,
  RepriceOnOutbidPolicy,
  ExitRepriceOnDownpricePolicy,
  LegStateRepository,
  RepriceChainPolicyConfig,
  RiskEventRepository,
} from "@krabs/domain";
import {
  createTokenId,
  createConditionId,
  nextRepriceChainState,
  resolveDynamicChainCapDetails,
} from "@krabs/domain";
import type { Logger } from "../../logger.js";
import { reconcileOrders } from "./order-reconciler.js";
import { reconcileFills } from "./fill-reconciler.js";
import {
  cleanStaleEntryOrders,
  recordSellDownpriceCancelSucceeded,
  type SellDownpriceRepriceStateMap,
} from "./stale-order-cleaner.js";
import type { OrderLifetimeModule } from "../order-lifetime/order-lifetime-module.js";
import {
  formatAutoClosedMissingRemoteDetail,
  MISSING_REMOTE_AUTO_CLOSE_STABILITY_REQUIRED,
  runWalletPositionSentinel,
  type ActivePositionSizeDrift,
  type AutoClosedMissingRemotePosition,
  type ClosedLivePositionDrift,
  type MissingRemotePositionDrift,
  type WalletPositionSentinelDeps,
  type WalletPositionSentinelResult,
} from "./wallet-position-sentinel.js";
import type { ExchangeStateStore } from "../execution/exchange-state-store.js";
import { buildReservationSnapshot } from "../execution/reservation-utils.js";
import type { PolymarketDataPosition } from "@krabs/exchange";

const DRIFT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DRIFT_INTERVAL_MS = 5 * 60 * 1000;
const WALLET_SENTINEL_FATAL_AFTER_CONSECUTIVE = 3;
const WALLET_SENTINEL_BALANCE_EPSILON = 1e-3;

function computePercentile(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1));
  return sorted[idx]!;
}

function walletSentinelDriftKeys(result: WalletPositionSentinelResult): string[] {
  return [
    ...result.closedLivePositions.map(
      (drift) => `closed-live:${String(drift.tokenId)}:${drift.positionId}`,
    ),
    ...result.activePositionDrifts.map(
      (drift) => `active-size:${String(drift.tokenId)}:${drift.positionId}`,
    ),
    ...result.missingRemotePositions.map(
      (drift) => `missing-remote:${String(drift.tokenId)}:${drift.positionId}`,
    ),
  ];
}

function formatConfirmedClosedLiveDriftDetail(drift: ClosedLivePositionDrift): string {
  return [
    "wallet-live-position-closed-locally",
    `token=${String(drift.tokenId)}`,
    `position=${drift.positionId}`,
    `slug=${drift.slug ?? "unknown"}`,
    `remoteSize=${drift.remoteSize}`,
    `remoteValue=${drift.remoteCurrentValueUsdc}`,
    `endDate=${drift.endDate}`,
    "crossCheck=confirmed",
  ].join(" ");
}

function formatConfirmedActiveDriftDetail(drift: ActivePositionSizeDrift): string {
  return [
    "wallet-live-position-size-mismatch",
    `token=${String(drift.tokenId)}`,
    `position=${drift.positionId}`,
    `slug=${drift.slug ?? "unknown"}`,
    `localSize=${drift.localSize}`,
    `remoteSize=${drift.remoteSize}`,
    `remoteValue=${drift.remoteCurrentValueUsdc}`,
    "crossCheck=confirmed",
  ].join(" ");
}

function formatConfirmedMissingRemoteDriftDetail(drift: MissingRemotePositionDrift): string {
  return [
    "wallet-local-position-missing-remote",
    `token=${String(drift.tokenId)}`,
    `position=${drift.positionId}`,
    `slug=${drift.slug ?? "unknown"}`,
    `localStatus=${drift.localStatus}`,
    `localSize=${drift.localSize}`,
    `remoteSize=${drift.remoteSize}`,
    `endDate=${drift.endDate ?? "unknown"}`,
    "crossCheck=confirmed",
  ].join(" ");
}

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
  exitOrderLifetime?: Pick<OrderLifetimeModule, "resolveExitOrder">;
  entryRepriceOnOutbid?: {
    policy: () => RepriceOnOutbidPolicy;
    getRepriceCount: (signalId: string | null) => number;
    getMarket: (
      tokenId: import("@krabs/domain").TokenId,
    ) => Pick<import("@krabs/domain").NormalizedMarket, "bestBid" | "tickSize"> | null;
  };
  exitRepriceOnDownprice?: {
    policy: () => ExitRepriceOnDownpricePolicy;
    getMarket: (
      tokenId: import("@krabs/domain").TokenId,
    ) => Pick<
      import("@krabs/domain").NormalizedMarket,
      | "bestBid"
      | "bestAsk"
      | "bestAskSize"
      | "askDepthExcludingOurs"
      | "tickSize"
      | "publicTradeCount24h"
    > | null;
  };
  runtimeMetrics?: {
    writeEvent: (
      metricName: string,
      value?: number,
      labels?: string | null,
      capturedAt?: string,
    ) => void;
    writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
  };
  /**
   * Live-lite wallet↔ledger sentinel. Detects impossible local state where
   * Polymarket still reports shares for a token, but the local position is
   * already closed before market endDate. It never repairs or pauses runtime;
   * it emits critical drift so the root cause remains visible.
   */
  walletPositionSentinel?: WalletPositionSentinelDeps;
  /**
   * Shared store published into Execution. The reconciliation pass pushes the
   * freshest exchange-side open SELL summary + wallet position snapshot here
   * so the SELL clamp uses the same source of truth the gateway will compare
   * against. Optional — when omitted, Execution falls back to local state.
   */
  exchangeStateStore?: ExchangeStateStore;
  /**
   * Optional reader for wallet positions in non-live-lite modes (or when the
   * sentinel is disabled). When provided, periodic reconciliation pulls
   * positions through it solely for ExchangeStateStore — never for local
   * repair. Currently wired only in live-lite (same source as the sentinel).
   */
  walletPositionReader?: {
    read: () => Promise<readonly PolymarketDataPosition[] | null>;
  };
  /**
   * CHANGE C — leg-state repo + reprice-chain policy. When all three are
   * provided, the stale-order-cleaner gates `downpriced_reprice` cancels and
   * the OrderCancelled subscription records the chain event on success.
   * Skipped when any field is omitted (legacy tests).
   */
  legStateRepo?: LegStateRepository;
  repriceChainPolicy?: () => RepriceChainPolicyConfig;
  riskEventRepo?: RiskEventRepository;
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
  private readonly walletSentinelConsecutiveCounts = new Map<string, number>();
  private readonly staleBackoffMap = new Map<string, number>();
  private readonly sellDownpriceRepriceMap: SellDownpriceRepriceStateMap = new Map();
  /**
   * Consecutive "missing-remote AND on-chain-zero" observations per tokenId.
   * Drives the sentinel auto-close path: after the count reaches
   * MISSING_REMOTE_AUTO_CLOSE_STABILITY_REQUIRED, the local position is closed
   * to match the wallet. Cleared on auto-close, on recovery (token reappears
   * with non-zero balance), or when no confirmed drift is observed for the
   * token in the current pass.
   */
  private readonly missingRemoteAutoCloseCounts = new Map<string, number>();

  constructor(private readonly deps: ReconciliationModuleDeps) {
    this.log = deps.log.child({ module: "reconciliation" });
  }

  async start(): Promise<void> {
    this.unsubs.push(
      this.deps.bus.subscribe("OrderCancelled", async (event) => {
        if (event.reason === "downpriced_reprice") {
          recordSellDownpriceCancelSucceeded(
            this.sellDownpriceRepriceMap,
            event.tokenId,
            event.orderId,
          );
        }
        // CHANGE C — record the reprice event on any source that contributes
        // to the rolling 24h chain: `downpriced_reprice` (stale-order-cleaner),
        // `sell_replace_reprice` (execution-module first attempt), and
        // `sell_replace_retry` (execution-module retry after lock). Without
        // counting retries, a long-running lock could land additional cancels
        // outside the cap accounting.
        if (
          (event.reason === "downpriced_reprice" ||
            event.reason === "sell_replace_reprice" ||
            event.reason === "sell_replace_retry") &&
          this.deps.legStateRepo &&
          this.deps.repriceChainPolicy
        ) {
          try {
            const policy = this.deps.repriceChainPolicy();
            if (policy.enabled) {
              const legState = this.deps.legStateRepo.get(event.tokenId);
              const nowMs = Date.now();
              const market = this.deps.exitRepriceOnDownprice?.getMarket(event.tokenId) ?? null;
              const cap = resolveDynamicChainCapDetails(market, policy);
              const next = nextRepriceChainState(legState, nowMs, {
                ...policy,
                maxChainCount: cap.maxChainCount,
              });
              this.deps.legStateRepo.applyRepriceChainEvent(
                event.tokenId,
                next.eventsJson,
                next.count,
                next.windowStartIso,
                new Date(nowMs).toISOString(),
              );
            }
          } catch (err) {
            this.log.warn(
              { err, tokenId: String(event.tokenId), reason: event.reason },
              "failed to apply reprice chain event",
            );
          }
        }
      }),
    );

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
      const stageTimingsMs: Record<string, number> = {};

      // 1. Order reconciliation
      // Grace = 2 intervals + 30s buffer. Covers worst case: order placed right after
      // pass N, still absent on pass N+1 (60s) and N+2 (120s), only phantom-cancel on N+3.
      const graceMs = this.deps.reconcileIntervalMs * 2 + 30_000;
      const stageOrdersStart = Date.now();
      const orderResult = await reconcileOrders({
        gateway: this.deps.gateway,
        orderRepo: this.deps.orderRepo,
        fillRepo: this.deps.fillRepo,
        marketRepo: this.deps.marketRepo,
        log: this.log,
        phantomGraceMs: graceMs,
      });
      stageTimingsMs.orders = Date.now() - stageOrdersStart;
      allDetails.push(...orderResult.details);

      // 2. Fill reconciliation (startup uses sinceMs=0, periodic uses last run)
      const sinceMs = this.lastRunAt ?? 0;
      const stageFillsStart = Date.now();
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
      stageTimingsMs.fills = Date.now() - stageFillsStart;
      allDetails.push(...fillResult.details);

      // 3. Stale entry order cleanup
      const repriceChainGate =
        this.deps.legStateRepo && this.deps.repriceChainPolicy
          ? {
              policy: this.deps.repriceChainPolicy,
              legStateRepo: this.deps.legStateRepo,
              riskEventRepo: this.deps.riskEventRepo,
              metrics: this.deps.runtimeMetrics,
            }
          : undefined;
      const stageStaleStart = Date.now();
      const staleResult = await cleanStaleEntryOrders(
        {
          orderRepo: this.deps.orderRepo,
          marketRepo: this.deps.marketRepo,
          bus: this.deps.bus,
          log: this.log,
          ...(this.deps.exitOrderTtlMs ? { exitOrderTtlMs: this.deps.exitOrderTtlMs() } : {}),
          ...(this.deps.exitOrderLifetime
            ? { exitOrderLifetime: this.deps.exitOrderLifetime }
            : {}),
          ...(this.deps.entryRepriceOnOutbid
            ? { entryRepriceOnOutbid: this.deps.entryRepriceOnOutbid }
            : {}),
          ...(this.deps.exitRepriceOnDownprice
            ? { exitRepriceOnDownprice: this.deps.exitRepriceOnDownprice }
            : {}),
          ...(repriceChainGate ? { repriceChainGate } : {}),
        },
        this.staleBackoffMap,
        this.sellDownpriceRepriceMap,
      );
      stageTimingsMs.stale = Date.now() - stageStaleStart;
      if (staleResult.staleTtlCancelled > 0) {
        allDetails.push(`stale entry TTL cancels: ${staleResult.staleTtlCancelled}`);
      }
      if (staleResult.staleEndDateCancelled > 0) {
        allDetails.push(`stale entry endDate cancels: ${staleResult.staleEndDateCancelled}`);
      }
      if (staleResult.staleExitTtlCancelled > 0) {
        allDetails.push(`stale exit TTL cancels: ${staleResult.staleExitTtlCancelled}`);
      }
      if (staleResult.outbidRepriceCancelled > 0) {
        allDetails.push(`outbid reprice cancels: ${staleResult.outbidRepriceCancelled}`);
      }
      if (staleResult.downpriceRepriceCancelled > 0) {
        allDetails.push(`downprice reprice cancels: ${staleResult.downpriceRepriceCancelled}`);
        this.deps.runtimeMetrics?.writeEvent(
          "downprice_reprice_events_total",
          staleResult.downpriceRepriceCancelled,
          JSON.stringify({ source: "stale-order-cleaner" }),
          new Date(ranAt).toISOString(),
        );
      }
      if (staleResult.stuckSellWarnings > 0) {
        allDetails.push(`stuck sell warnings: ${staleResult.stuckSellWarnings}`);
        this.deps.runtimeMetrics?.writeEvent(
          "stuck_sell_warnings_total",
          staleResult.stuckSellWarnings,
          JSON.stringify({ source: "stale-order-cleaner" }),
          new Date(ranAt).toISOString(),
        );
      }

      // 4. Wallet↔ledger sentinel
      const stageSentinelStart = Date.now();
      const rawWalletResult = this.deps.walletPositionSentinel
        ? await runWalletPositionSentinel(this.deps.walletPositionSentinel, ranAt)
        : {
            driftCount: 0,
            details: [],
            markUpdateCount: 0,
            missingRemoteRevaluedCount: 0,
            closedLivePositions: [],
            activePositionDrifts: [],
            missingRemotePositions: [],
            autoClosedMissingRemotePositions: [],
          };
      stageTimingsMs.sentinel = Date.now() - stageSentinelStart;
      const walletResult = await this.confirmWalletSentinelDrifts(rawWalletResult);
      const walletSentinelSeverity = this.updateWalletSentinelConsecutiveCounts(walletResult);
      allDetails.push(...walletResult.details);
      if (walletResult.driftCount > 0) {
        const logFn =
          walletSentinelSeverity === "critical"
            ? this.log.error.bind(this.log)
            : this.log.warn.bind(this.log);
        logFn(
          {
            closedLive: walletResult.closedLivePositions,
            activeMismatch: walletResult.activePositionDrifts,
            missingRemote: walletResult.missingRemotePositions,
            consecutiveThreshold: WALLET_SENTINEL_FATAL_AFTER_CONSECUTIVE,
            severity: walletSentinelSeverity,
          },
          "wallet position sentinel detected drift",
        );
      }
      if (walletResult.autoClosedMissingRemotePositions.length > 0) {
        this.log.warn(
          {
            autoClosed: walletResult.autoClosedMissingRemotePositions,
            stabilityRequired: MISSING_REMOTE_AUTO_CLOSE_STABILITY_REQUIRED,
          },
          "wallet position sentinel auto-closed missing-remote positions",
        );
      }

      // 4b. Push exchange snapshot + wallet snapshot into ExchangeStateStore.
      // Best-effort: a sentinel failure must not abort the reconciliation pass.
      const stagePublishStart = Date.now();
      await this.publishExchangeState(orderResult, ranAt);
      stageTimingsMs.publishExchangeState = Date.now() - stagePublishStart;

      // 5. Build result
      const clean =
        orderResult.phantomsCancelled === 0 &&
        orderResult.unknownExchangeOrders === 0 &&
        fillResult.missingFillsImported === 0 &&
        orderResult.staleCancelled === 0 &&
        orderResult.staleCancelFailed === 0 &&
        staleResult.staleTtlCancelled === 0 &&
        staleResult.staleEndDateCancelled === 0 &&
        staleResult.staleExitTtlCancelled === 0 &&
        staleResult.outbidRepriceCancelled === 0 &&
        staleResult.downpriceRepriceCancelled === 0 &&
        walletResult.driftCount === 0;

      const result: ReconciliationResult = {
        ranAt,
        openOrdersExchange: orderResult.exchangeOpenCount,
        openOrdersLocal: orderResult.localOpenCount,
        missingFills: fillResult.missingFillsImported,
        phantomOrders: orderResult.phantomsCancelled,
        positionDriftCount: walletResult.driftCount,
        clean,
        details: allDetails,
      };

      this.runCount++;
      this.lastRunAt = ranAt;
      this.lastResult = result;

      // 6. Publish events
      if (!clean) {
        const severity =
          fillResult.missingFillsImported > 0 || walletSentinelSeverity === "critical"
            ? ("critical" as const)
            : ("warn" as const);
        await this.deps.bus.publish("ReconciliationDriftDetected", {
          details: allDetails.join("; "),
          severity,
          timestamp: ranAt,
        });
      }

      const lagMs = Date.now() - ranAt;
      this.recordReconciliationLag(lagMs, ranAt);

      await this.deps.bus.publish("ReconciliationComplete", { result });

      if (lagMs >= 5_000) {
        this.log.warn(
          { run: this.runCount, lagMs, stageTimingsMs },
          "reconciliation pass slow — per-stage timings",
        );
      }

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
          outbidRepriceCancelled: staleResult.outbidRepriceCancelled,
          downpriceRepriceCancelled: staleResult.downpriceRepriceCancelled,
          stuckSellWarnings: staleResult.stuckSellWarnings,
          walletPositionDrifts: walletResult.driftCount,
          walletPositionMarkUpdates: walletResult.markUpdateCount,
          walletPositionMissingRemoteRevalued: walletResult.missingRemoteRevaluedCount ?? 0,
          lagMs,
          stageTimingsMs,
        },
        "reconciliation pass complete",
      );

      return result;
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Triggered by ExecutionModule after an exchange "balance is not enough"
   * reject so the next SELL evaluates against a fresh snapshot rather than
   * waiting for the next 15s tick. Uses the same re-entrancy guard as the
   * periodic loop — concurrent runs return the last result.
   */
  triggerImmediateReconciliation(): void {
    if (this.reconciling) return;
    this.runReconciliation().catch((err) =>
      this.log.error({ err }, "immediate reconciliation error"),
    );
  }

  private async confirmWalletSentinelDrifts(
    result: WalletPositionSentinelResult,
  ): Promise<WalletPositionSentinelResult> {
    if (result.driftCount === 0) {
      // Even when nothing surfaced this pass, drop any stability counters for
      // tokens that no longer surface as drifts — they recovered cleanly.
      this.pruneMissingRemoteAutoCloseCounts(new Set());
      return result;
    }

    const closedLivePositions = await this.filterConfirmedClosedLiveDrifts(
      result.closedLivePositions,
    );
    const activePositionDrifts = await this.filterConfirmedActiveDrifts(
      result.activePositionDrifts,
    );
    const confirmedMissingRemote = await this.filterConfirmedMissingRemoteDrifts(
      result.missingRemotePositions,
    );
    const autoCloseOutcome = this.applyMissingRemoteAutoClose(confirmedMissingRemote);
    const missingRemotePositions = autoCloseOutcome.remainingDrifts;
    const autoClosedMissingRemotePositions = autoCloseOutcome.autoClosed;
    return {
      ...result,
      closedLivePositions,
      activePositionDrifts,
      missingRemotePositions,
      autoClosedMissingRemotePositions,
      driftCount:
        closedLivePositions.length + activePositionDrifts.length + missingRemotePositions.length,
      details: [
        ...closedLivePositions.map(formatConfirmedClosedLiveDriftDetail),
        ...activePositionDrifts.map(formatConfirmedActiveDriftDetail),
        ...missingRemotePositions.map(formatConfirmedMissingRemoteDriftDetail),
        ...autoClosedMissingRemotePositions.map(formatAutoClosedMissingRemoteDetail),
      ],
    };
  }

  /**
   * Drive the per-token stability counter and close positions that have been
   * confirmed missing on-chain for `MISSING_REMOTE_AUTO_CLOSE_STABILITY_REQUIRED`
   * consecutive passes. The first observation only seeds the counter — actual
   * close happens on the second confirmation, giving the data-api one full
   * reconciliation cycle to recover before we touch local state.
   */
  private applyMissingRemoteAutoClose(confirmed: readonly MissingRemotePositionDrift[]): {
    remainingDrifts: MissingRemotePositionDrift[];
    autoClosed: AutoClosedMissingRemotePosition[];
  } {
    const positionRepo = this.deps.walletPositionSentinel?.positionRepo;
    if (!positionRepo) {
      // Without the sentinel's position repo we cannot persist a close —
      // fall back to legacy report-only behaviour so callers without the new
      // wiring stay safe.
      this.pruneMissingRemoteAutoCloseCounts(new Set());
      return { remainingDrifts: [...confirmed], autoClosed: [] };
    }

    const remaining: MissingRemotePositionDrift[] = [];
    const autoClosed: AutoClosedMissingRemotePosition[] = [];
    const confirmedTokens = new Set<string>();

    for (const drift of confirmed) {
      const tokenIdStr = String(drift.tokenId);
      confirmedTokens.add(tokenIdStr);
      const nextCount = (this.missingRemoteAutoCloseCounts.get(tokenIdStr) ?? 0) + 1;
      this.missingRemoteAutoCloseCounts.set(tokenIdStr, nextCount);
      if (nextCount < MISSING_REMOTE_AUTO_CLOSE_STABILITY_REQUIRED) {
        remaining.push(drift);
        continue;
      }
      const closed = this.closeMissingRemotePosition(drift, nextCount, positionRepo);
      if (closed) {
        autoClosed.push(closed);
        this.missingRemoteAutoCloseCounts.delete(tokenIdStr);
      } else {
        // Position vanished between sentinel and auto-close (rare race) — drop
        // the counter and keep reporting the drift so the operator still sees
        // it surface next pass.
        this.missingRemoteAutoCloseCounts.delete(tokenIdStr);
        remaining.push(drift);
      }
    }

    this.pruneMissingRemoteAutoCloseCounts(confirmedTokens);
    return { remainingDrifts: remaining, autoClosed };
  }

  private closeMissingRemotePosition(
    drift: MissingRemotePositionDrift,
    consecutiveObservations: number,
    positionRepo: PositionRepository,
  ): AutoClosedMissingRemotePosition | null {
    const positions = positionRepo
      .findAll()
      .filter((p) => String(p.tokenId) === String(drift.tokenId));
    const candidate = positions.find((p) => String(p.positionId) === drift.positionId) ?? null;
    if (!candidate) return null;
    if (candidate.status === "closed" || candidate.size <= 0) return null;
    const status =
      candidate.status === "open" || candidate.status === "dust" ? candidate.status : null;
    if (status === null) return null;

    const closedAtIso = new Date().toISOString();
    const prevSize = candidate.size;
    const prevCurrentValueUsdc =
      candidate.currentValueUsdc === null || !Number.isFinite(candidate.currentValueUsdc)
        ? 0
        : candidate.currentValueUsdc;
    positionRepo.save({
      ...candidate,
      size: 0,
      currentValueUsdc: 0,
      status: "closed",
      closedAt: closedAtIso,
      updatedAt: closedAtIso,
    });
    this.log.warn(
      {
        tokenId: String(drift.tokenId),
        positionId: drift.positionId,
        slug: drift.slug,
        prevSize,
        prevCurrentValueUsdc,
        prevStatus: status,
        consecutiveObservations,
      },
      "wallet sentinel auto-closed missing-remote position",
    );
    return {
      tokenId: drift.tokenId,
      positionId: drift.positionId,
      slug: drift.slug,
      prevSize,
      prevCurrentValueUsdc,
      prevStatus: status,
      consecutiveObservations,
    };
  }

  private pruneMissingRemoteAutoCloseCounts(activeTokenIds: ReadonlySet<string>): void {
    for (const key of [...this.missingRemoteAutoCloseCounts.keys()]) {
      if (!activeTokenIds.has(key)) this.missingRemoteAutoCloseCounts.delete(key);
    }
  }

  private async filterConfirmedClosedLiveDrifts(
    drifts: readonly ClosedLivePositionDrift[],
  ): Promise<ClosedLivePositionDrift[]> {
    const confirmed: ClosedLivePositionDrift[] = [];
    for (const drift of drifts) {
      const balance = await this.readWalletSentinelCrossCheckBalance(drift.tokenId);
      if (balance === null) continue;
      if (balance > WALLET_SENTINEL_BALANCE_EPSILON) confirmed.push(drift);
    }
    return confirmed;
  }

  private async filterConfirmedActiveDrifts(
    drifts: readonly ActivePositionSizeDrift[],
  ): Promise<ActivePositionSizeDrift[]> {
    const confirmed: ActivePositionSizeDrift[] = [];
    for (const drift of drifts) {
      const balance = await this.readWalletSentinelCrossCheckBalance(drift.tokenId);
      if (balance === null) continue;
      if (Math.abs(drift.localSize - balance) > WALLET_SENTINEL_BALANCE_EPSILON) {
        confirmed.push({ ...drift, remoteSize: balance });
      }
    }
    return confirmed;
  }

  private async filterConfirmedMissingRemoteDrifts(
    drifts: readonly MissingRemotePositionDrift[],
  ): Promise<MissingRemotePositionDrift[]> {
    const confirmed: MissingRemotePositionDrift[] = [];
    for (const drift of drifts) {
      const balance = await this.readWalletSentinelCrossCheckBalance(drift.tokenId);
      if (balance === null) continue;
      if (balance <= WALLET_SENTINEL_BALANCE_EPSILON) confirmed.push(drift);
    }
    return confirmed;
  }

  private async readWalletSentinelCrossCheckBalance(
    tokenId: import("@krabs/domain").TokenId,
  ): Promise<number | null> {
    try {
      return await this.deps.gateway.getPositionBalance(tokenId);
    } catch (err) {
      this.log.warn({ err, tokenId: String(tokenId) }, "wallet sentinel cross-check failed");
      return null;
    }
  }

  private updateWalletSentinelConsecutiveCounts(
    result: WalletPositionSentinelResult,
  ): "warn" | "critical" | null {
    const activeKeys = new Set(walletSentinelDriftKeys(result));
    for (const key of [...this.walletSentinelConsecutiveCounts.keys()]) {
      if (!activeKeys.has(key)) this.walletSentinelConsecutiveCounts.delete(key);
    }
    let maxConsecutive = 0;
    for (const key of activeKeys) {
      const count = (this.walletSentinelConsecutiveCounts.get(key) ?? 0) + 1;
      this.walletSentinelConsecutiveCounts.set(key, count);
      maxConsecutive = Math.max(maxConsecutive, count);
    }
    if (maxConsecutive === 0) return null;
    return maxConsecutive >= WALLET_SENTINEL_FATAL_AFTER_CONSECUTIVE ? "critical" : "warn";
  }

  private async publishExchangeState(
    orderResult: Pick<
      Awaited<ReturnType<typeof reconcileOrders>>,
      "exchangeOpenOrders" | "capturedAtMs"
    >,
    ranAt: number,
  ): Promise<void> {
    const store = this.deps.exchangeStateStore;
    if (!store) return;

    const sellRows = orderResult.exchangeOpenOrders
      .filter((order) => order.side === "sell")
      .map((order) => ({
        orderId: order.orderId,
        tokenId: order.tokenId,
        sizeRemaining: order.sizeRemaining,
      }));
    store.updateExchangeSellOrders(sellRows, orderResult.capturedAtMs);

    if (this.deps.walletPositionReader) {
      try {
        const readStart = Date.now();
        const positions = await this.deps.walletPositionReader.read();
        const readMs = Date.now() - readStart;
        if (readMs >= 2_000) {
          this.log.warn(
            { readMs, positionCount: positions?.length ?? null },
            "walletPositionReader.read() slow",
          );
        }
        if (positions) {
          const redeemable = positions.filter((p) => p.redeemable).length;
          this.log.debug(
            { readMs, positionCount: positions.length, redeemablePositions: redeemable },
            "walletPositionReader.read() ok — publishing PolymarketWalletUpdated",
          );
          store.updateWalletPositionsBatch(
            positions.map((p) => ({ tokenId: p.tokenId, size: p.size })),
            ranAt,
          );
          await this.deps.bus.publish("PolymarketWalletUpdated", {
            positions: positions.map((p) => ({
              tokenId: p.tokenId as import("@krabs/domain").TokenId,
              conditionId: p.conditionId,
              size: p.size,
              redeemable: p.redeemable,
              slug: p.slug ?? p.marketSlug,
              outcome: p.outcome,
            })),
            timestamp: ranAt,
          });
          // Local active tokens absent from the wallet response are the precise
          // desync case: local DB believes we hold shares the wallet does not
          // report. Publish an explicit zero so the SELL clamp sees the truth
          // instead of falling back to local-only.
          const remoteTokens = new Set(positions.map((p) => String(p.tokenId)));
          const localRepo = this.deps.walletPositionSentinel?.positionRepo;
          if (localRepo) {
            for (const local of localRepo.findAll()) {
              if (local.status === "closed") continue;
              if (local.size <= 0) continue;
              if (remoteTokens.has(String(local.tokenId))) continue;
              store.updateWalletPosition(local.tokenId, 0, ranAt);
            }
          }
        }
      } catch (err) {
        this.log.debug({ err }, "wallet position reader threw — exchange store not refreshed");
      }
    }

    const metrics = this.computeStoreMetrics(store);
    this.deps.runtimeMetrics?.writeEvent(
      "wallet_position_drift_abs",
      metrics.walletPositionDriftAbs,
      JSON.stringify({ source: "reconciliation" }),
      new Date(ranAt).toISOString(),
    );
    this.deps.runtimeMetrics?.writeEvent(
      "reserved_sell_drift_abs",
      metrics.reservedSellDriftAbs,
      JSON.stringify({ source: "reconciliation" }),
      new Date(ranAt).toISOString(),
    );

    if (metrics.reservedSellDriftAbs >= 1) {
      this.log.warn(
        { reservedSellDriftAbs: metrics.reservedSellDriftAbs },
        "reservedSell drift threshold exceeded (>=1 share)",
      );
    }
    if (metrics.walletPositionDriftAbs >= 5) {
      this.log.warn(
        { walletPositionDriftAbs: metrics.walletPositionDriftAbs },
        "wallet position drift threshold exceeded (>=5 shares)",
      );
    }
  }

  private computeStoreMetrics(store: NonNullable<ReconciliationModuleDeps["exchangeStateStore"]>) {
    const localOpenSellSizeByToken = new Map<string, number>();
    // Use buildReservationSnapshot so the per-token sum subtracts realized
    // fills — the exchange snapshot reports `sizeRemaining`, so comparing
    // against original `order.size` would falsely flag partially-filled SELLs
    // as drift.
    const reservations = buildReservationSnapshot(
      this.deps.orderRepo.findOpen(),
      this.deps.fillRepo,
    );
    for (const [key, remaining] of reservations.reservedSellByToken) {
      localOpenSellSizeByToken.set(key, remaining);
    }
    // Local position size by token comes from the wallet sentinel deps when
    // available (same PositionRepository the sentinel reads).
    const localPositionSizeByToken = new Map<string, number>();
    const repo = this.deps.walletPositionSentinel?.positionRepo;
    if (repo) {
      for (const position of repo.findAll()) {
        if (position.status === "closed") continue;
        const key = String(position.tokenId);
        localPositionSizeByToken.set(
          key,
          (localPositionSizeByToken.get(key) ?? 0) + Math.max(0, position.size),
        );
      }
    }
    return store.computeMetrics({ localOpenSellSizeByToken, localPositionSizeByToken });
  }

  private readonly reconciliationLagSamplesMs: number[] = [];

  private recordReconciliationLag(lagMs: number, ranAt: number): void {
    if (!Number.isFinite(lagMs) || lagMs < 0) return;
    this.reconciliationLagSamplesMs.push(lagMs);
    if (this.reconciliationLagSamplesMs.length > 240) {
      this.reconciliationLagSamplesMs.shift();
    }
    const p99 = computePercentile(this.reconciliationLagSamplesMs, 0.99);
    this.deps.runtimeMetrics?.writeEvent(
      "reconciliation_lag_ms_p99",
      p99,
      JSON.stringify({ samples: this.reconciliationLagSamplesMs.length }),
      new Date(ranAt).toISOString(),
    );
    if (p99 >= 5_000) {
      this.log.warn({ p99 }, "reconciliation_lag_ms_p99 threshold exceeded (>=5s)");
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
