/**
 * Krabs Runtime — composition root and entrypoint.
 *
 * Wires config, DB, selection rules, algo rules, event bus, supervisor, and modules.
 * Does NOT implement exchange, strategy, risk, or market-data logic.
 */

// Force IPv4 globally — some ISPs (e.g. FPT Vietnam) reset IPv6 connections to Polymarket.
// dns.setDefaultResultOrder is insufficient because axios reuses connections via its pool.
// Patching dns.lookup ensures every new socket resolves to IPv4.
import dns from "node:dns";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _origLookup: any = dns.lookup;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dns as any).lookup = function (hostname: string, optsOrCb: any, maybeCb?: any) {
  if (typeof optsOrCb === "function") {
    return _origLookup(hostname, { family: 4 }, optsOrCb);
  }
  const opts = typeof optsOrCb === "object" ? { ...optsOrCb, family: 4 } : { family: 4 };
  return _origLookup(hostname, opts, maybeCb);
};

// Force a ceiling timeout on every axios request so the CLOB SDK (which uses
// the global axios import) always releases its socket on stuck calls. The
// gateway's own Promise.race timeout only races at the JS level — it does
// not abort the underlying axios request, leaving the response body stuck
// in the kernel Recv-Q and the socket in CLOSE-WAIT (2026-04-22 leak hunt).
// Axios's native timeout uses its own AbortController and actually tears
// down the socket when it fires.
// axios@0.27.x's CJS default export confuses TS's ESM default inference, so
// we cast to the AxiosStatic shape instead of relying on the typed default.
import axiosDefault from "axios";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(axiosDefault as any).defaults.timeout = 45_000;
// Install a bounded https.Agent on the global axios singleton so CLOB SDK calls
// use a capped connection pool with a per-socket idle timeout. httpAgent is
// deliberately left unset — that field expects http.Agent, and CLOB/Gamma are
// HTTPS-only. Mixing an https.Agent into httpAgent is a type error that would
// break any future plain-HTTP consumer.
import {
  buildClobAxiosAgent,
  classifyExchangeRejectionReason,
  installClobErrorSanitizer,
} from "@krabs/exchange";
// CLOB SDK serializes axios error.config (which holds the keep-alive
// https.Agent) via JSON.stringify before re-throwing. Circular socket refs
// crash that stringify, masking real exchange errors as a generic
// "Converting circular structure to JSON" TypeError. The interceptor strips
// the agent fields from rejected errors before the SDK sees them.
installClobErrorSanitizer(
  axiosDefault as unknown as Parameters<typeof installClobErrorSanitizer>[0],
);

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { monitorEventLoopDelay, performance, PerformanceObserver } from "node:perf_hooks";
import process from "node:process";
import { loadEnv } from "@krabs/config";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  bootstrapControlDb,
  bootstrapLedgerDb,
  SqliteMarketRepository,
  SqliteOrderRepository,
  SqliteFillRepository,
  SqlitePositionRepository,
  SqliteInventoryLotRepository,
  SqliteOperatorCommandRepository,
  SqliteOperatorActionRepository,
  SqliteMarketSnapshotRepository,
  SqliteProfileSettingsRepository,
  SelectionRuleRepository,
  SqliteRiskEventRepository,
  SqliteStateTransitionRepository,
  SqliteFloorIntentRepository,
  SqliteHoldResolutionStateRepository,
  SqliteTradingCalendarRepository,
  withShutdownBusyTimeout,
  disableAutoCheckpoint,
  setSynchronousFull,
  isWorkingSellOrderStatus,
} from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import {
  createBotRunId,
  ENTRY_REASONS,
  recordStageDuration,
  snapshotAndResetStageTimers,
} from "@krabs/domain";
import type { OrderId, TokenId } from "@krabs/domain";
import {
  DataApiTradeCountProvider,
  GammaMarketDiscoveryGateway,
  PolymarketDataPositionReader,
} from "@krabs/exchange";
import { createGateways } from "./gateway-factory.js";
import { DEFAULT_LIVE_LITE_CONFIG, LiveLiteGuard } from "./live-lite-guard.js";
import { runProfilePreflight, writePreflightReport } from "./profile-preflight.js";
import {
  createBuySignalBudgetCircuitBreaker,
  type OrderCapacityMetricsSample,
} from "./wallet-buy-budget.js";

import { createLogger } from "./logger.js";
import { SignalActivityWindow } from "./signal-activity-window.js";
import {
  acquireLedgerInstanceLock,
  type LedgerInstanceLockHandle,
} from "./ledger-instance-lock.js";
import { persistFailedStartupState } from "./persist-failed-startup-state.js";
import { buildTradeCountObserver } from "./trade-count-observer.js";
import { LifecycleSupersededError, RUNTIME_STOP_WAIT_MS, waitAtMost } from "./lifecycle-chain.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { CommandPoller } from "./supervisor/command-poller.js";
import { MarketDataModule } from "./modules/market-data/market-data-module.js";
import { TrackCBookSignalsProvider } from "./modules/book-signals/book-signals-provider.js";
import { MarketScannerModule } from "./modules/market-scanner/index.js";
import { PlanktonEntryShadowModule } from "./modules/plankton-entry-shadow/plankton-entry-shadow-module.js";
import { NormalizationModule } from "./modules/normalization/normalization-module.js";
import { SoftRankingScoreModule } from "./modules/soft-ranking/soft-ranking-score-module.js";
import { loadSoftRankingModel } from "./modules/soft-ranking/load-soft-ranking-model.js";
import {
  computeScoreDistributionSnapshot,
  SCORE_DISTRIBUTION_METRIC_NAME,
} from "./modules/soft-ranking/score-distribution-snapshot.js";
import { softRankingDisabledCleanup } from "./soft-ranking-disabled-cleanup.js";
import { ExecutionModule } from "./modules/execution/execution-module.js";
import { MakerBuyFastCancel } from "./modules/execution/maker-buy-fast-cancel.js";
import { PermanentR23ActivationCoordinator } from "./permanent-r23-activation.js";
import { AuthoritativeTickResolver } from "./modules/execution/authoritative-tick-resolver.js";
import { ExchangeStateStore } from "./modules/execution/exchange-state-store.js";
import { RiskInventoryModule } from "./modules/risk-inventory/risk-inventory-module.js";
import { CandidateBookCache } from "./modules/strategy/candidate-book-cache.js";
import { SignalToOrderBridge } from "./modules/strategy/signal-to-order.js";
import { ExecutionPolicyProvider } from "./execution-policy-provider.js";
import { AlgoDecisionModule } from "./modules/algo-decision/algo-decision-module.js";
import { SellLoopGuardModule } from "./modules/sell-loop-guard/sell-loop-guard-module.js";
import { ExecutionProfileManager } from "./modules/execution-profile/execution-profile-manager.js";
import { ExecutionProfileAnomalyDetector } from "./modules/execution-profile/execution-profile-anomaly-detector.js";
import { ExecutionProfileHealthChecker } from "./modules/execution-profile/execution-profile-health-checker.js";
import { ExecutionProfileRollup } from "./modules/execution-profile/execution-profile-rollup.js";
import { SignalFeedManager } from "./modules/execution-profile/signal-feed-manager.js";
import { SignalFeedReader } from "./modules/execution-profile/signal-feed-reader.js";
import { SqliteSignalFeedRepository } from "./modules/execution-profile/signal-feed-repository.js";
import { SqliteExecutionProfileStateRepository } from "./modules/execution-profile/state-repository.js";
import {
  ProfileLadderModule,
  type ProfileLadderModeCandidateReader,
} from "./modules/execution-profile/profile-ladder-module.js";
import { SqliteProfileLadderRepository } from "./modules/execution-profile/profile-ladder-repository.js";
import { RepositoryDustAutoCloseCandidateProvider } from "./modules/track-s4/dust-auto-close-candidates.js";
import { DustAutoCloseModule } from "./modules/track-s4/dust-auto-close-module.js";
import { SqliteDustAutoCloseRepository } from "./modules/track-s4/dust-auto-close-repository.js";
import { S1LadderModule } from "./modules/s1-ladder/s1-ladder-module.js";
import { MarketSnapshotPriceHistoryProvider } from "./modules/algo-decision/market-snapshot-price-history.js";
import { MarketSelectionCache } from "./modules/algo-decision/market-selection-cache.js";
import { EntryLifecycleModule } from "./modules/entry-lifecycle/entry-lifecycle-module.js";
import { BounceAskCaptureLifecycleModule } from "./modules/bounce-ask-capture/bounce-ask-capture-lifecycle-module.js";
import { LegStateTrackerModule } from "./modules/leg-state/leg-state-tracker-module.js";
import { HoldResolutionCleanupModule } from "./modules/reconciliation/hold-resolution-cleanup.js";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation-module.js";
import { ResolutionModule } from "./modules/resolution/resolution-module.js";
import { UserOrderStreamModule } from "./modules/reconciliation/user-order-stream-module.js";
import { InventoryManagerModule } from "./modules/inventory-auto-merge/inventory-manager-module.js";
import {
  recoverConfirmedOnchainMerges,
  resolveAppliedMergeReplacementRepairs,
  resolveCurrentMergeRecoveryReplayPosition,
  resolveMergeRecoveryReplayPositions,
} from "./modules/inventory-auto-merge/recover-onchain-merges.js";
import { FillPollerModule } from "./modules/fill-poller/fill-poller-module.js";
import { LedgerRetentionModule } from "./modules/retention/ledger-retention-module.js";
import { DbSizeGuardModule } from "./modules/db-size-guard/db-size-guard-module.js";
import { ResolutionDetector } from "./modules/resolution/resolution-detector.js";
import { PositionSettler } from "./modules/resolution/position-settler.js";
import { MarketResolutionTracker } from "./modules/resolution/market-resolution-tracker.js";
import { startResolutionHealthWatcher } from "./modules/resolution/resolution-health-watcher.js";
import { GammaResolutionClient } from "@krabs/exchange";
import {
  SqliteMarketResolutionRepository,
  SqliteMergeLedgerRepository,
  SqliteAlgoRulesRepository,
  SqliteLegStateRepository,
  SqliteLegStateTransitionRepository,
  SqliteAlgoTokenModeStateRepository,
  SqliteOrderPriceCooldownRepository,
  SqliteSettlementLedgerRepository,
  SqlitePositionDriftRepository,
  SqliteExecutionPolicyObservationRepository,
  SqliteDecisionSignalLogRepository,
  SqliteRedeemLogRepository,
  SqliteRedeemQuarantineRepository,
  SqliteSettlementInfraPauseRepository,
  SqliteMakerShadowOrderRepository,
} from "@krabs/db";
import { SnapshotWriter } from "./snapshot-writer.js";
import { createTrackRFeeProvider } from "./track-r-fee-provider.js";
import { createHybridFeeScheduleProvider } from "./fee-schedule-provider.js";
import { findActivePositionRows } from "./active-positions.js";
import { calculateTotalExposure } from "./exposure-calculator.js";
import { RiskEventWriter } from "./risk-event-writer.js";
import { resolveActiveProfile } from "./profile-boot.js";
import {
  rebuildLegStatesFromLedger,
  runStartupPositionAdoption,
} from "./startup-position-adoption.js";
import {
  DrainedOrderUnfencedError,
  reportAbandonedDrainWaiver,
  runDrainedOrderFenceGate,
  runOwnershipInvariantStartupGate,
} from "./modules/exit-ownership/assert-bounce-for-all-invariant.js";
import { resolveNewPositionExitOwner } from "./modules/exit-ownership/resolve-new-position-exit-owner.js";
import { ProfileRuntimePublisher } from "./modules/publisher/profile-runtime-publisher.js";
import { RuntimeStatePublisher } from "./runtime-state-publisher.js";
import { PositionConcentrationService } from "./position-concentration-service.js";
import { PeriodicTimers } from "./periodic-timers.js";
import { composeStrandedFillAlertEmitter } from "./stranded-fill-alert.js";
import { RuntimeMetricWriter } from "./runtime-metric-writer.js";
import { RuntimeEffectiveResolutionService } from "./effective-resolution-service.js";
import {
  SlidingLatencyWindow,
  SustainedThresholdAlert,
} from "./modules/algo-decision/decision-metrics.js";
import { evaluateResumeIntent } from "./resume-intent.js";
import { createPolymarketClient, type SettlementClientLike } from "./polymarket-client-factory.js";
import { installConsoleRedaction } from "./console-redaction.js";
import { LatestUsablePriceLookup } from "./market-snapshot-pricing.js";
import { RefreshableSelectionRuleEngine } from "./selection-rule-engine-factory.js";
import { backfillLegStateTransitionsFromLedger } from "./modules/leg-state/leg-state-transition-backfill.js";
import { OrderLifetimeModule } from "./modules/order-lifetime/order-lifetime-module.js";
import { SamePriceCooldownModule } from "./modules/same-price-cooldown/same-price-cooldown-module.js";
import { CooldownRegistry } from "./modules/same-price-cooldown/cooldown-registry.js";
import { SignalPathTelemetry } from "./modules/strategy/signal-path-telemetry.js";
import { RedeemSweepModule } from "./modules/redeem-sweep/redeem-sweep-module.js";
import { SettlementInfraBreaker } from "./modules/settlement-infra-breaker.js";
import { buildRuntimeDiagnosticsSnapshot } from "./runtime-diagnostics.js";
import { isGatewayOrderReject } from "./order-rejection-classification.js";
import {
  buildRiskEventVolumeSnapshot,
  NON_OPERATIONAL_DIAGNOSTIC_RISK_EVENT_TYPES,
  SIGNAL_TELEMETRY_RISK_EVENT_TYPES,
} from "./risk-event-volume.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const ENTRY_FILL_LATENCY_TRACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RISK_EVENT_WARNING_THRESHOLD_PER_HOUR = 1_000;
const RISK_EVENT_WARNING_COOLDOWN_MS = 10 * 60 * 1000;
const DECISION_TICK_LATENCY_ALERT_THRESHOLD_MS = 30_000;
const DECISION_TICK_LATENCY_ALERT_SUSTAINED_MS = 5 * 60 * 1000;
const DECISION_TICK_LATENCY_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

interface OrderCapacityWindow {
  placeCalls: number;
  sourceBuckets: Map<string, number>;
  rejectedByReason: Map<string, number>;
  sellCapacityUsedBySource: Map<string, number>;
  sellCapacityRejectedBySource: Map<string, number>;
  openBuyOrderCountBuckets: Map<string, number>;
  openSellOrderCountBuckets: Map<string, number>;
  openOrdersTotalBuckets: Map<string, number>;
  perTokenOpenBuyOrderCountBuckets: Map<string, number>;
  perTokenOpenSellOrderCountBuckets: Map<string, number>;
  lastReset: number;
}

function summarizeFillLatency(samplesMs: readonly number[]): Record<string, number> | null {
  if (samplesMs.length === 0) return null;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    avgMs: Math.round(sum / sorted.length),
    minMs: sorted[0]!,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

function buildProcessMemoryTelemetry(memory: NodeJS.MemoryUsage): Record<string, unknown> {
  const rssMb = roundBytesToMb(memory.rss);
  return {
    rssMb,
    heapUsedMb: roundBytesToMb(memory.heapUsed),
    heapTotalMb: roundBytesToMb(memory.heapTotal),
    externalMb: roundBytesToMb(memory.external),
    arrayBuffersMb: roundBytesToMb(memory.arrayBuffers),
    maxRssMb: rssMb,
    byWorker: {},
    source: "process",
  };
}

function roundBytesToMb(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(1));
}

function createOrderCapacityWindow(now = Date.now()): OrderCapacityWindow {
  return {
    placeCalls: 0,
    sourceBuckets: new Map(),
    rejectedByReason: new Map(),
    sellCapacityUsedBySource: new Map(),
    sellCapacityRejectedBySource: new Map(),
    openBuyOrderCountBuckets: new Map(),
    openSellOrderCountBuckets: new Map(),
    openOrdersTotalBuckets: new Map(),
    perTokenOpenBuyOrderCountBuckets: new Map(),
    perTokenOpenSellOrderCountBuckets: new Map(),
    lastReset: now,
  };
}

function bucketCount(value: number, maxBucket: number): string {
  return String(Math.min(Math.max(0, Math.trunc(value)), maxBucket));
}

function incrementBucket(map: Map<string, number>, bucket: string): void {
  map.set(bucket, (map.get(bucket) ?? 0) + 1);
}

function resetOrderCapacityWindow(window: OrderCapacityWindow, now = Date.now()): void {
  window.placeCalls = 0;
  window.sourceBuckets.clear();
  window.rejectedByReason.clear();
  window.sellCapacityUsedBySource.clear();
  window.sellCapacityRejectedBySource.clear();
  window.openBuyOrderCountBuckets.clear();
  window.openSellOrderCountBuckets.clear();
  window.openOrdersTotalBuckets.clear();
  window.perTokenOpenBuyOrderCountBuckets.clear();
  window.perTokenOpenSellOrderCountBuckets.clear();
  window.lastReset = now;
}

function serializeOrderCapacityWindow(window: OrderCapacityWindow): Record<string, unknown> {
  return {
    placeCalls: window.placeCalls,
    sourceBuckets: Object.fromEntries(window.sourceBuckets),
    rejectedByReason: Object.fromEntries(window.rejectedByReason),
    sellCapacityUsedBySource: Object.fromEntries(window.sellCapacityUsedBySource),
    sellCapacityRejectedBySource: Object.fromEntries(window.sellCapacityRejectedBySource),
    openBuyOrderCountBuckets: Object.fromEntries(window.openBuyOrderCountBuckets),
    openSellOrderCountBuckets: Object.fromEntries(window.openSellOrderCountBuckets),
    openOrdersTotalBuckets: Object.fromEntries(window.openOrdersTotalBuckets),
    perTokenOpenBuyOrderCountBuckets: Object.fromEntries(window.perTokenOpenBuyOrderCountBuckets),
    perTokenOpenSellOrderCountBuckets: Object.fromEntries(window.perTokenOpenSellOrderCountBuckets),
    windowStartMs: window.lastReset,
  };
}

function percentile(sortedSamplesMs: readonly number[], q: number): number {
  if (sortedSamplesMs.length === 0) return 0;
  const index = Math.min(
    sortedSamplesMs.length - 1,
    Math.max(0, Math.ceil(sortedSamplesMs.length * q) - 1),
  );
  return sortedSamplesMs[index]!;
}

function pruneEntryFillLatencyTracker(
  placedAtByOrderId: Map<string, number>,
  nowMs: number,
  maxAgeMs = ENTRY_FILL_LATENCY_TRACK_MAX_AGE_MS,
): void {
  for (const [orderId, placedAtMs] of placedAtByOrderId.entries()) {
    if (nowMs - placedAtMs > maxAgeMs) {
      placedAtByOrderId.delete(orderId);
    }
  }
}

async function main(): Promise<void> {
  installConsoleRedaction();

  // 1. Load config
  const config = loadEnv();
  const errorMetricWriter = { current: undefined as RuntimeMetricWriter | undefined };
  const log = createLogger(config.logLevel, config.runtimeMode, (level, source) =>
    errorMetricWriter.current?.observeLog(level, source),
  );
  const periodicTimers = new PeriodicTimers(log);
  log.info({ mode: config.runtimeMode }, "krabs runtime starting (env mode)");
  for (const issue of config.polygonRpcConfigIssues ?? []) {
    log.warn(
      {
        code: issue.code,
        sourceOfTruth: issue.sourceOfTruth,
        ignoredSources: issue.ignoredSources,
      },
      issue.message,
    );
  }

  // Install bounded https.Agent on the global axios singleton (covers all CLOB SDK calls).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (axiosDefault as any).defaults.httpsAgent = buildClobAxiosAgent({
    maxSockets: config.clobAxiosMaxSockets,
    maxFreeSockets: config.clobAxiosMaxFreeSockets,
    idleTimeoutMs: config.clobAxiosIdleTimeoutMs,
  });

  // 2. Bootstrap DBs
  const controlDbPath =
    process.env["CONTROL_DB_PATH"] ?? config.dbPath.replace(/[^/]+\.db$/, "control.db");

  let controlConn: DbConnection;
  try {
    controlConn = bootstrapControlDb(controlDbPath);
    log.info({ path: controlDbPath }, "control database ready");
  } catch (err) {
    log.fatal({ err }, "database bootstrap failed");
    process.exit(1);
  }

  // 2b. Resolve active profile from control.db (falls back to RUNTIME_MODE env)
  const resolvedProfile = resolveActiveProfile(controlConn.db, config.runtimeMode);
  const activeProfile = resolvedProfile.profile;
  const runtimeMode = resolvedProfile.runtimeMode;
  const { desiredProfile, currentProfile } = resolvedProfile;
  log.info(
    {
      envMode: config.runtimeMode,
      desiredProfile,
      currentProfile,
      activeProfile,
      runtimeMode,
    },
    "active profile resolved",
  );
  if (desiredProfile && config.runtimeMode !== desiredProfile) {
    log.warn(
      {
        envMode: config.runtimeMode,
        desiredProfile,
      },
      "env runtime mode differs from desired profile",
    );
  }

  // 2d. Ledger instance lock — refuse to start a second runtime against the same ledger
  // (r8-M2: concurrent runtimes race the merge-ledger fence). Taken BEFORE the bootstrap below,
  // because bootstrap itself applies migrations, backfills and position repairs: a runtime that
  // is going to lose the lock must not get to write to a ledger it does not own. Held for the
  // process lifetime.
  const ledgerDbPath = controlDbPath.replace("control.db", `ledger-${activeProfile}.db`);
  let ledgerLock: LedgerInstanceLockHandle;
  try {
    ledgerLock = acquireLedgerInstanceLock(ledgerDbPath);
    log.info({ lockDbPath: `${ledgerDbPath}.lock.db` }, "ledger instance lock acquired");
  } catch (err) {
    log.fatal({ err }, "ledger instance lock unavailable — refusing to start");
    controlConn.close();
    process.exit(1);
  }

  // 2e. Open ledger DB scoped to active profile
  let ledgerConn: DbConnection;
  try {
    ledgerConn = bootstrapLedgerDb(ledgerDbPath);
    if (runtimeMode === "live-lite") setSynchronousFull(ledgerConn);
    log.info({ path: ledgerDbPath }, "ledger database ready");
  } catch (err) {
    log.fatal({ err }, "ledger database bootstrap failed");
    ledgerLock.release();
    controlConn.close();
    process.exit(1);
  }

  // 3. Create repositories
  const repos = {
    // Ledger-side
    market: new SqliteMarketRepository(ledgerConn.db),
    order: new SqliteOrderRepository(ledgerConn.db),
    fill: new SqliteFillRepository(ledgerConn.db),
    position: new SqlitePositionRepository(ledgerConn.db),
    inventoryLot: new SqliteInventoryLotRepository(ledgerConn.db),
    mergeLedger: new SqliteMergeLedgerRepository(ledgerConn.db),
    settlementLedger: new SqliteSettlementLedgerRepository(ledgerConn.db),
    positionDrift: new SqlitePositionDriftRepository(ledgerConn.db),
    redeemLog: new SqliteRedeemLogRepository(ledgerConn.db),
    redeemQuarantine: new SqliteRedeemQuarantineRepository(ledgerConn.db),
    marketSnapshot: new SqliteMarketSnapshotRepository(ledgerConn.db),
    riskEvent: new SqliteRiskEventRepository(ledgerConn.db),
    decisionSignalLog: new SqliteDecisionSignalLogRepository(ledgerConn.db),
    floorIntent: new SqliteFloorIntentRepository(ledgerConn.db),
    holdResolutionState: new SqliteHoldResolutionStateRepository(ledgerConn.db),
    tradingCalendar: new SqliteTradingCalendarRepository(ledgerConn.db),
    makerShadowOrders: new SqliteMakerShadowOrderRepository(ledgerConn.db),
    // Control-side
    operatorCommand: new SqliteOperatorCommandRepository(controlConn.db),
    operatorAction: new SqliteOperatorActionRepository(controlConn.db),
    stateTransition: new SqliteStateTransitionRepository(controlConn.db),
    // Algo decision engine — algoRules lives in control.db, legState in ledger.db
    algoRules: new SqliteAlgoRulesRepository(controlConn.db),
    legState: new SqliteLegStateRepository(ledgerConn.db),
    legStateTransition: new SqliteLegStateTransitionRepository(ledgerConn.db),
    tokenModeState: new SqliteAlgoTokenModeStateRepository(ledgerConn.db),
    orderPriceCooldown: new SqliteOrderPriceCooldownRepository(ledgerConn.db),
  };

  const latestUsablePriceLookup = new LatestUsablePriceLookup(ledgerConn.db);
  const latestUsablePriceForToken = (tokenId: TokenId): number | null =>
    latestUsablePriceLookup.findUsablePrice(tokenId);

  // 3b. Selection rule engine — version-polled singleton shared by scanner,
  // MarketSelectionCache, and operator/debug endpoints.
  const selectionRuleRepo = new SelectionRuleRepository(controlConn.db);
  const selectionRuleEngine = new RefreshableSelectionRuleEngine(selectionRuleRepo, activeProfile);
  log.info({ version: selectionRuleRepo.getVersion() }, "selection rule engine ready");

  // 3c. MarketResolutionRepo — owned by ResolutionModule but constructed early
  // so MarketResolutionTracker can seed from it before any module is wired.
  const marketResolutionRepo = new SqliteMarketResolutionRepository(ledgerConn.db);

  // Read initial balance from profile_settings (control.db) instead of YAML
  const settingsRow = controlConn.db
    .prepare(
      `SELECT initial_balance_usdc, envelope_json, wallet_mode, min_order_usdc,
              fallback_min_order_usdc_relayer, fallback_min_order_usdc_eoa, relayer_json
         FROM profile_settings
        WHERE profile_id = ?`,
    )
    .get(activeProfile) as
    | {
        initial_balance_usdc: number | null;
        envelope_json: string | null;
        wallet_mode: "eoa" | "relayer" | null;
        min_order_usdc: number | null;
        fallback_min_order_usdc_relayer: number | null;
        fallback_min_order_usdc_eoa: number | null;
        relayer_json: string | null;
      }
    | undefined;
  const initialBalanceUsdc = settingsRow?.initial_balance_usdc ?? 1000;

  if (runtimeMode !== "live-lite") {
    log.info({ initialBalanceUsdc, runtimeMode }, "simulated exchange balance configured");
  }

  // 6. Create event bus
  const bus = new InProcessEventBus();
  let redeemSweepModule: RedeemSweepModule | null = null;

  // 6a. RuntimeMetricWriter + infra-alert sink — needed before tracker wiring
  // so the BUY-admission fail-closed path can report through the standard
  // `infra_alert` channel (surfaced in /status and the web banner).
  const runtimeMetrics = new RuntimeMetricWriter(ledgerConn.db);
  runtimeMetrics.startErrorCollection();
  errorMetricWriter.current = runtimeMetrics;
  const positionConcentration = new PositionConcentrationService({
    ledgerDb: ledgerConn.db,
    controlDb: controlConn.db,
    profileId: activeProfile as import("@krabs/domain").ProfileId,
    log,
    runtimeMetrics,
  });
  const settlementInfraBreaker = new SettlementInfraBreaker({
    // Persist the hard-pause window so a restart re-arms an open Polygon-RPC
    // rate-limit pause instead of clearing it and hammering the relayer on the
    // startup sweep.
    store: new SqliteSettlementInfraPauseRepository(ledgerConn.db),
  });
  // Aggregated counter flush — high-frequency `*_total` metrics buffer in
  // memory and persist as one row per (name, labels) pair every 30s. Keeps
  // total runtime_metrics write rate from dominating SQLite disk I/O.
  runtimeMetrics.startPeriodicFlush(30_000, periodicTimers);
  const recordInfraAlert = (alert: {
    code: string;
    severity: "warning" | "error";
    source: string;
    message: string;
    details?: Record<string, unknown> | undefined;
  }): void => {
    const now = new Date().toISOString();
    if (alert.code === "POLYGON_RPC_RATE_LIMITED") {
      settlementInfraBreaker.pause(alert.code, alert.details?.rawMessage);
    }
    runtimeMetrics.writeEvent("infra_alert", 1, JSON.stringify(alert), now);
    redeemSweepModule?.notifySettlementInfraAlert(alert.code);
    log.warn({ alert }, "runtime infra alert recorded");
  };

  const effectiveResolution = new RuntimeEffectiveResolutionService(
    repos.tradingCalendar,
    runtimeMetrics,
    recordInfraAlert,
  );
  const calendarCoverageNow = new Date().toISOString();
  effectiveResolution.emitCoverageMetric(calendarCoverageNow);
  const calendarCoverage = effectiveResolution.coverageStatus(calendarCoverageNow);
  if (calendarCoverage.warn) {
    recordInfraAlert({
      code: "TRADING_CALENDAR_VERIFIED_COVERAGE_LOW",
      severity: "warning",
      source: "effective-resolution",
      message:
        "US equity trading-calendar verified coverage expires within 18 months; verify and patch calendar exceptions.",
      details: calendarCoverage,
    });
  }

  // 6b. MarketResolutionTracker — early service. Seeded from the resolutions
  // table and subscribed to the bus BEFORE any publisher of
  // MarketResolved/MarketResolvedHint is constructed, so no resolution
  // event can be lost in the start-up window. Powers the BUY-side admission
  // guard in RiskInventoryModule and SignalToOrderBridge (fail-closed when
  // init fails — every BUY rejected with `resolution_tracker_unavailable`).
  const marketResolutionTracker = new MarketResolutionTracker(marketResolutionRepo, log);
  try {
    marketResolutionTracker.init();
  } catch (err) {
    // Degraded fail-closed mode: keep runtime up so SELL/REDEEM still work,
    // but raise a loud operator signal. The banner stays sticky thanks to
    // periodic re-emission below; per-BUY rejection metrics already flow
    // through RiskEventWriter → risk_events.
    recordInfraAlert({
      code: "resolution_tracker_unavailable",
      severity: "error",
      source: "market-resolution-tracker",
      message:
        "BUY orders blocked: resolution tracker init failed — investigate ledger DB or restart runtime",
      details: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  marketResolutionTracker.subscribe(bus);

  // 6c. Periodic health re-emission so the infra_alert banner stays sticky
  // (default lookback is 60m) and `entry_guard_resolution_tracker_healthy`
  // remains a fresh telemetry sample.
  startResolutionHealthWatcher({
    tracker: marketResolutionTracker,
    metricsWriter: runtimeMetrics,
    recordInfraAlert,
    intervalMs: 30 * 60 * 1000,
    timers: periodicTimers,
  });

  // 7. Build modules
  // supervisorRef is set before any closure that uses it is actually called
  const supervisorRef = { current: null as unknown as Supervisor };
  const statePublisherRef = { current: null as RuntimeStatePublisher | null };
  const resolutionModuleRef = { current: null as ResolutionModule | null };
  let captureControlGeneration = 0;
  const runtimeControl = {
    isPaused: () => supervisorRef.current.isPaused(),
    generation: () => captureControlGeneration,
  };

  // Persist pause state to runtime_metrics so the API can read it
  const persistPauseState = (paused: boolean) => {
    runtimeMetrics.writeLatest("runtime_paused", paused ? 1 : 0);
  };

  function setPausedAndPersist(paused: boolean): void {
    const wasPaused = supervisorRef.current.isPaused();
    if (paused !== wasPaused) captureControlGeneration++;
    supervisorRef.current.setPaused(paused);
    persistPauseState(paused);
    if (paused) {
      statePublisherRef.current?.publishPaused();
    } else {
      statePublisherRef.current?.publishRunning();
      if (wasPaused) resolutionModuleRef.current?.notifyRuntimeResumed();
    }
  }

  // Build live-lite envelope from control.db profile_settings.
  // Per ADR D4 (docs/superpowers/specs/2026-04-18-algo-spec-freeze-adr.md), the envelope
  // caps exposure only — admission is solely the selection-rule engine.
  const liveLiteConfig = (() => {
    if (runtimeMode !== "live-lite") return undefined;
    let envelope: Record<string, unknown> = {};
    if (settingsRow?.envelope_json) {
      try {
        envelope = JSON.parse(settingsRow.envelope_json) as Record<string, unknown>;
      } catch (err) {
        log.warn(
          { err },
          "live-lite profile_settings.envelope_json is invalid — using default caps",
        );
      }
    } else {
      log.warn("live-lite profile_settings.envelope_json is empty — using default caps");
    }
    const minOrderUsdc = settingsRow?.min_order_usdc;
    return {
      maxOpenValueUsdc: Number(
        envelope.maxOpenValueUsdc ?? DEFAULT_LIVE_LITE_CONFIG.maxOpenValueUsdc,
      ),
      maxOrderUsdc: Number(envelope.maxOrderUsdc ?? DEFAULT_LIVE_LITE_CONFIG.maxOrderUsdc),
      maxActiveMarkets: Number(
        envelope.maxActiveMarkets ?? DEFAULT_LIVE_LITE_CONFIG.maxActiveMarkets,
      ),
      walletMode: settingsRow?.wallet_mode ?? "eoa",
      fallbackMinOrderUsdcRelayer: settingsRow?.fallback_min_order_usdc_relayer ?? null,
      fallbackMinOrderUsdcEoa: settingsRow?.fallback_min_order_usdc_eoa ?? null,
      ...(typeof minOrderUsdc === "number" && Number.isFinite(minOrderUsdc)
        ? { minOrderUsdc }
        : {}),
    };
  })();
  const liveLiteGuard = new LiveLiteGuard(liveLiteConfig);

  // 7b. Create gateways via factory
  let polyClient: unknown;
  let settlementClient: SettlementClientLike | null = null;
  let relayerConfig: { walletType: string; funderAddress: string } | null = null;
  let traderAddress: string | undefined;
  let userWsAuth:
    | {
        apiKey: string;
        secret: string;
        passphrase: string;
      }
    | undefined;
  try {
    const configWithBuilder = config as typeof config & {
      polyBuilderApiKey?: string;
      polyBuilderSecret?: string;
      polyBuilderPassphrase?: string;
      polyBuilderCode?: string;
    };
    const polymarketClientConfig = {
      polyApiKey: config.polyApiKey,
      polyApiSecret: config.polyApiSecret,
      polyPassphrase: config.polyPassphrase,
      polyBuilderApiKey: configWithBuilder.polyBuilderApiKey,
      polyBuilderSecret: configWithBuilder.polyBuilderSecret,
      polyBuilderPassphrase: configWithBuilder.polyBuilderPassphrase,
      polyBuilderCode: configWithBuilder.polyBuilderCode,
      polyPrivateKey: config.polyPrivateKey,
      polymarketRelayerUrl:
        (config as typeof config & { polymarketRelayerUrl?: string }).polymarketRelayerUrl ??
        "https://relayer-v2.polymarket.com",
      polygonRpcUrl:
        (config as typeof config & { polygonRpcUrl?: string }).polygonRpcUrl ??
        "https://polygon-rpc.com",
      polygonRpcUrls: (config as typeof config & { polygonRpcUrls?: string[] }).polygonRpcUrls,
      polygonRpcFallbackUrl: (config as typeof config & { polygonRpcFallbackUrl?: string })
        .polygonRpcFallbackUrl,
      alchemyPolygonKeys: config.alchemyPolygonKeys,
    };
    const builtClient = await createPolymarketClient({
      runtimeMode,
      config: polymarketClientConfig,
      walletMode: liveLiteGuard.getWalletMode(),
      relayerJson: settingsRow?.relayer_json ?? null,
    });
    polyClient = builtClient.client;
    settlementClient = builtClient.settlementClient;
    traderAddress = builtClient.traderAddress ?? undefined;
    userWsAuth = builtClient.userWsAuth ?? undefined;
    relayerConfig = builtClient.relayerConfig
      ? {
          walletType: builtClient.relayerConfig.walletType,
          funderAddress: builtClient.relayerConfig.funderAddress,
        }
      : null;
  } catch (err) {
    log.fatal({ err }, "Polymarket client initialization failed");
    controlConn.close();
    ledgerConn.close();
    process.exit(1);
  }

  // Phase 6: family slug patterns removed; selection rules gate market discovery.
  // Accept all slugs — AlgoDecisionModule + SelectedMarketCache handle eligibility.
  const slugFilter = (_slug: string): boolean => true;

  const { marketDataGateway, exchangeGateway, modeLabel, marketDataSource, executionMode } =
    createGateways({
      runtimeMode,
      polyClient,
      settlementClient: settlementClient ?? undefined,
      traderAddress,
      userWsAuth,
      slugFilter,
      initialBalanceUsdc,
      depHealthRecorder: runtimeMetrics,
      onInfraAlert: runtimeMode === "live-lite" ? recordInfraAlert : undefined,
      polygonRpcUrl:
        runtimeMode === "live-lite"
          ? (config.polygonRpcUrl ?? "https://polygon-rpc.com")
          : undefined,
      polygonRpcUrls: runtimeMode === "live-lite" ? config.polygonRpcUrls : undefined,
      polygonRpcFallbackUrl: runtimeMode === "live-lite" ? config.polygonRpcFallbackUrl : undefined,
      alchemyPolygonKeys: runtimeMode === "live-lite" ? config.alchemyPolygonKeys : undefined,
      marketDataMaxTrackedTokens: config.marketDataMaxTrackedTokens,
      marketDataMaxWsShards: config.marketDataMaxWsShards,
      wsWorkerCount: config.wsWorkerCount,
      marketDataIngressQueueMax: config.marketDataIngressQueueMax,
      marketDataIngressLagWarnMs: config.marketDataIngressLagWarnMs,
      marketDataIngressOverflowPolicy: config.marketDataIngressOverflowPolicy,
      marketDataReconnectBaseMs: config.marketDataReconnectBaseMs,
      marketDataReconnectMaxMs: config.marketDataReconnectMaxMs,
      marketDataShardBreakerReconnectsPerMin: config.marketDataShardBreakerReconnectsPerMin,
      marketDataShardBreakerOpenMs: config.marketDataShardBreakerOpenMs,
      marketDataShardBreakerOpenMaxMs: config.marketDataShardBreakerOpenMaxMs,
      marketDataCircuitShardOpenPercent: config.marketDataCircuitShardOpenPercent,
      marketDataCircuitOpenShardFloor: config.marketDataCircuitOpenShardFloor,
      marketDataCircuitOpenMs: config.marketDataCircuitOpenMs,
      marketDataStreamStableMs: config.marketDataStreamStableMs,
      reconciliationFetchRetries: config.reconciliationFetchRetries,
      reconciliationFetchBackoffMs: config.reconciliationFetchBackoffMs,
      fetchRetryLog: log.child({ component: "fetch-retry" }),
    });
  log.info({ mode: modeLabel }, "gateways created");
  if (runtimeMode === "live-lite") {
    log.info(
      {
        walletMode: liveLiteGuard.getWalletMode(),
        ...(relayerConfig ? { relayer: relayerConfig } : {}),
      },
      "live wallet path configured",
    );
  }

  // 7c. Create bot run ID (needed by market-data and execution modules)
  const botRunId = createBotRunId(`run-${Date.now()}`);

  // Record this run in bot_runs for API consumption
  ledgerConn.db
    .prepare("INSERT INTO bot_runs (run_id, mode, started_at) VALUES (?, ?, ?)")
    .run(botRunId, runtimeMode, new Date().toISOString());
  log.info({ botRunId, mode: runtimeMode }, "bot run recorded");

  // 7d. Market scanner (discovery via Gamma API).
  // When GAMMA_TAG_ID is set, the scanner narrows to that tag server-side
  // (5–10× fewer markets crawled). When unset, the scanner broad-crawls all
  // active Gamma events and relies on selection rules for local filtering.
  const discoveryGateway = new GammaMarketDiscoveryGateway({
    ...(config.gammaTagId !== undefined ? { tagId: config.gammaTagId } : {}),
    depHealthRecorder: runtimeMetrics,
  });

  // ADR-015: DB-backed execution policy. The provider polls
  // `runtime_control_state.execution_policy_version` and hot-swaps the
  // snapshot when operators edit `profile_settings.execution_policy_json`.
  const profileSettingsRepo = new SqliteProfileSettingsRepository(controlConn.db);
  const executionPolicyProvider = new ExecutionPolicyProvider({
    controlDb: controlConn.db,
    profileSettingsRepo,
    log,
    profileId: activeProfile as import("@krabs/domain").ProfileId,
  });
  const currentExecutionPolicySnapshot = () => {
    executionPolicyProvider.refreshIfStale();
    const snapshot = executionPolicyProvider.snapshot();
    const withSellTimeout =
      config.sellTimeoutMs == null
        ? snapshot
        : { ...snapshot, sellTimeoutMs: config.sellTimeoutMs };
    return { policy: withSellTimeout, controlRevision: executionPolicyProvider.version() };
  };
  const currentExecutionPolicy = () => currentExecutionPolicySnapshot().policy;

  // ADR-016 — market-wide trade-count provider for the post-entry continuation
  // gate. Also supplies D9's rolling 24h public trade count enrichment.
  const tradeCountLog = log.child({ module: "data-api-trade-count-provider" });
  const tradeCountProvider = new DataApiTradeCountProvider({
    observer: buildTradeCountObserver({ log: tradeCountLog, metrics: runtimeMetrics }),
  });
  const trackCBookSignalsProvider = new TrackCBookSignalsProvider();
  const planktonEntryShadowModule =
    runtimeMode === "live-lite"
      ? new PlanktonEntryShadowModule({
          bus,
          dbPath: resolve(dirname(ledgerDbPath), "plankton-entry-shadow.db"),
          log,
          scanIntervalMs: config.marketScanIntervalMs,
          marketDataPollIntervalMs: config.marketDataPollIntervalMs,
          strategyScanIntervalMs: config.strategyScanIntervalMs,
        })
      : null;

  const marketScannerModule = new MarketScannerModule({
    discoveryGateway,
    marketRepo: repos.market,
    bus,
    log,
    scanIntervalMs: config.marketScanIntervalMs,
    hintScanMinIntervalMs: config.marketScanHintMinIntervalMs,
    selectionRuleEngine,
    marketSelectionPolicy: () => currentExecutionPolicy().marketSelection,
    effectiveResolution,
    runtimeMetrics,
    positionRepo: repos.position,
    orderRepo: repos.order,
    runtimeControl,
    ...(planktonEntryShadowModule ? { entryShadowObserver: planktonEntryShadowModule } : {}),
  });

  let selectedMarketCacheForEnrichment: MarketSelectionCache | null = null;

  // 7e. Real modules for market-data and normalization
  const marketDataModule = new MarketDataModule({
    gateway: marketDataGateway,
    marketRepo: repos.market,
    bus,
    log,
    pollIntervalMs: config.marketDataPollIntervalMs,
    staleThresholdMs: config.marketDataStaleThresholdMs,
    botRunId: String(botRunId),
    maxTrackedTokens: config.marketDataMaxTrackedTokens,
    signatureReserve: config.marketDataSignatureReserve,
    signatureThresholds: {
      minLiquidity: config.signatureMinLiquidity,
      minMid: config.signatureMinMid,
      maxMid: config.signatureMaxMid,
      minRemainingDays: config.signatureMinRemainingDays,
      minVol24h: config.signatureMinVol24h,
      minTick: config.signatureMinTick,
      featureTtlMs: config.signatureFeatureTtlMs,
    },
    signatureTierMode: config.marketDataSignatureTierMode,
    ...(planktonEntryShadowModule
      ? {
          trackedMarketObserver: (tokenIds: readonly string[], observedAt: number) =>
            planktonEntryShadowModule.observeTrackedMarkets(tokenIds, observedAt),
          entryShadowObserver: planktonEntryShadowModule,
        }
      : {}),
    recordSignatureCoverage: (inLiveTier, count, mode) => {
      runtimeMetrics.writeCounter(
        "entry_coverage_signature_total",
        count,
        JSON.stringify({ in_live_tier: inLiveTier, mode }),
      );
    },
    discoveryPollIntervalMs: config.marketDataDiscoveryPollIntervalMs,
    discoveryBatchSize: config.marketDataDiscoveryBatchSize,
    fallbackBatchSize: config.marketDataFallbackBatchSize,
    fallbackPollMaxConcurrency: config.marketDataFallbackPollConcurrency,
    fallbackPollRatePerSec: config.marketDataFallbackPollRatePerSec,
    fallbackStaleTokenAgeMs: config.marketDataStaleTokenAgeMs,
    tradeCountProvider,
    publicTradeCountEnrichmentFilter: (tokenId, role) =>
      role === "executionCritical" ||
      selectedMarketCacheForEnrichment?.isEligible(tokenId as TokenId) === true,
    httpErrorMetricsSink: ({ source, errorClass }) => {
      runtimeMetrics.writeCounter("http_error_class", 1, JSON.stringify({ source, errorClass }));
    },
    fullLifetimeSnapshots: {
      enabled: true,
      heartbeatMs: 5 * 60 * 1000,
      postCloseGraceMs: 0,
      activePositionTokenIds: () => repos.position.findOpen().map((position) => position.tokenId),
      recordMissingMarket: (reason) => {
        runtimeMetrics.writeCounter("full_lifetime_missing_market", 1, JSON.stringify({ reason }));
      },
      recordMarketCacheHydrated: (reason) => {
        runtimeMetrics.writeCounter(
          "full_lifetime_market_cache_hydrated_total",
          1,
          JSON.stringify({ reason }),
        );
      },
      recordSkippedSnapshot: (reason) => {
        runtimeMetrics.writeCounter(
          "full_lifetime_snapshot_skipped_total",
          1,
          JSON.stringify({ reason }),
        );
      },
    },
    bookSignals: {
      openPositionTokenIds: () => repos.position.findOpen().map((position) => position.tokenId),
      // Trade-stats track-set = open positions ∪ GATE-whitelist entry-candidate tokens, so
      // tradeCount3h is accumulated for GATE first-entry markets (which have no position yet) and
      // the adaptive entry TTL has a live input. Full-book (depth) subscription stays position-only.
      trackedTokenIds: () => {
        const positionTokens = repos.position.findOpen().map((position) => position.tokenId);
        const gate = currentExecutionPolicy().gateEntry;
        if (!gate?.enabled || gate.whitelistConditionIds.length === 0) return positionTokens;
        const gateTokens = gate.whitelistConditionIds.flatMap((conditionId) =>
          repos.market.findByConditionId(conditionId).map((market) => market.tokenId),
        );
        return [...positionTokens, ...gateTokens];
      },
      setOpenPositionTokenIds: (tokenIds) => {
        trackCBookSignalsProvider.setOpenPositionTokenIds(tokenIds);
      },
      ingestTopOfBook: (observation) => {
        trackCBookSignalsProvider.ingestTopOfBook(observation);
      },
      ingestLastTradePrice: (observation) => {
        trackCBookSignalsProvider.ingestLastTradePrice(observation);
      },
      ingestBook: (observation) => {
        trackCBookSignalsProvider.ingestBook(observation);
      },
      invalidateTokenIds: (tokenIds) => {
        trackCBookSignalsProvider.invalidateTokenIds(tokenIds);
      },
    },
    runtimeControl,
  });

  const normalizationModule = new NormalizationModule({
    bus,
    log,
  });

  // 7e1. Soft-ranking score module (Step 3 / ADR-020). The model artifact is
  // optional — a missing/invalid file produces `null` and the module enters
  // a disabled no-op state (audit doc §F1 / §F14: rollback story).
  //
  // The recompute hook (audit doc §D7 / §P4) runs the DB-aggregated snapshot
  // and persists it under `runtime_metrics.score_distribution`. The API reads
  // the latest persisted row from there — `apps/api` has no in-memory module
  // reference, so the DB is the cross-process surface.
  const softRankingModel = loadSoftRankingModel(log);
  // Disabled-state contract (ADR-020 §D4 score-column ownership invariant /
  // audit doc §F1 / §F14 / runbook §4): when the artifact is missing or
  // invalid the module no-ops. Two cleanups are mandatory at startup:
  //   1. Clear `runtime_metrics.score_distribution` so the API does not serve
  //      a stale snapshot as if it were current.
  //   2. NULL out all four score-ownership columns
  //      (`markets.score` / `markets.score_model_version` /
  //      `markets.scored_at` / `markets.features_captured_at`) so
  //      `effectiveScore` in the repository ranking cannot keep returning
  //      leftover values from before the disable.
  // Without (2), Step 3's WS-tier ranking would still be score-driven for any
  // row whose score has not yet aged past `FEATURE_FRESHNESS_MS`.
  if (softRankingModel === null) {
    softRankingDisabledCleanup(ledgerConn.db, log);
  }
  const recomputeScoreDistribution = () => {
    try {
      const snapshot = computeScoreDistributionSnapshot(ledgerConn.db);
      runtimeMetrics.writeLatest(
        SCORE_DISTRIBUTION_METRIC_NAME,
        1,
        JSON.stringify(snapshot),
        snapshot.capturedAt,
      );
      return {
        modelVersion: snapshot.modelVersion,
        scoredMarkets: snapshot.scoredMarkets,
        step2IncludedNoScore: snapshot.step2IncludedNoScore,
        skippedNonStep2Included: snapshot.skippedNonStep2Included,
        staleMarkets: snapshot.staleMarkets,
        mean: snapshot.mean,
        capturedAt: snapshot.capturedAt,
      };
    } catch (err) {
      log.warn({ err }, "score_distribution snapshot write failed");
      return undefined;
    }
  };
  const softRankingScoreModule = new SoftRankingScoreModule({
    bus,
    marketRepo: repos.market,
    log,
    model: softRankingModel,
    recomputeScoreDistribution,
  });

  let executionModule: ExecutionModule | null = null;
  const authorizeResume = () =>
    executionModule?.authorizeResumeAfterStartupExitRecovery() ?? Promise.resolve(false);
  const makerBuyFastCancel = new MakerBuyFastCancel({
    orderRepo: repos.order,
    bus,
    isMakerModeOff: () => currentExecutionPolicy().makerEntry.mode === "off",
    inFlightMakerBuys: () => executionModule?.makerBuyInFlightCount() ?? 0,
    inFlightPermanentR23: (activationId) =>
      executionModule?.permanentR23InFlightCount(activationId) ?? 0,
  });
  const permanentR23Activation = new PermanentR23ActivationCoordinator({
    controlDb: controlConn.db,
    ledgerDb: ledgerConn.db,
    profileId: activeProfile,
    inFlightMakerBuys: () => executionModule?.makerBuyInFlightCount() ?? 0,
  });

  // 7e2. Command poller (created here so normalizationModule is available)
  const commandPoller = new CommandPoller({
    commandRepo: repos.operatorCommand,
    actionRepo: repos.operatorAction,
    bus,
    log,
    getPaused: () => supervisorRef.current.isPaused(),
    setPaused: setPausedAndPersist,
    pollIntervalMs: 5_000,
    stateTransitionRepo: repos.stateTransition,
    makerBuyFastCancel,
    recoverMissingBounceExit: (predecessorOrderId, operatorCommandId) =>
      executionModule?.recoverMissingBounceExit(predecessorOrderId as OrderId, operatorCommandId) ??
      Promise.resolve({ status: "deferred" as const }),
    authorizeResume,
    activatePermanentR23: (command, expectedVersion) =>
      permanentR23Activation.activate(command, expectedVersion),
    fencePermanentR23Deactivation: (command, expectedVersion, activationId) =>
      permanentR23Activation.fenceDeactivation(command, expectedVersion, activationId),
    finalizePermanentR23Deactivation: (command, activationId, completedAt) =>
      permanentR23Activation.finalizeDeactivation(command, activationId, completedAt),
  });

  // 7f. Execution module

  // Persist two-part mode for API/web consumption
  const modeNow = new Date().toISOString();
  runtimeMetrics.writeLatest(
    "market_data_source",
    1,
    JSON.stringify({ value: marketDataSource }),
    modeNow,
  );
  runtimeMetrics.writeLatest(
    "execution_mode",
    1,
    JSON.stringify({ value: executionMode }),
    modeNow,
  );

  const orderCapacityWindow = createOrderCapacityWindow();
  const recordOrderCapacitySample = (sample: OrderCapacityMetricsSample): void => {
    orderCapacityWindow.placeCalls += 1;
    incrementBucket(orderCapacityWindow.sourceBuckets, sample.source);
    if (sample.side === "sell" && sample.sellCapacitySource) {
      if (sample.approved) {
        incrementBucket(orderCapacityWindow.sellCapacityUsedBySource, sample.sellCapacitySource);
        runtimeMetrics.writeCounter(
          "sell_capacity_used_by_source",
          1,
          JSON.stringify({ source: sample.sellCapacitySource }),
        );
      } else if (sample.sellCapacityRejectReason) {
        const rejectionBucket = `${sample.sellCapacitySource}:${sample.sellCapacityRejectReason}`;
        incrementBucket(orderCapacityWindow.sellCapacityRejectedBySource, rejectionBucket);
        runtimeMetrics.writeCounter(
          "sell_capacity_rejected_by_source",
          1,
          JSON.stringify({
            source: sample.sellCapacitySource,
            reason: sample.sellCapacityRejectReason,
          }),
        );
      }
    }
    if (sample.profileOwnedOpenPositionCount != null) {
      runtimeMetrics.writeLatest(
        "sell_capacity_dynamic_profile_owned_positions",
        sample.profileOwnedOpenPositionCount,
      );
    }
    if (sample.profileLadderCapRaw != null) {
      runtimeMetrics.writeLatest(
        "sell_capacity_dynamic_profile_ladder_cap",
        sample.profileLadderCapRaw,
      );
      runtimeMetrics.writeLatest(
        "sell_capacity_dynamic_profile_ladder_cap_raw",
        sample.profileLadderCapRaw,
      );
    }
    if (sample.effectiveProfileLadderCap != null) {
      runtimeMetrics.writeLatest(
        "sell_capacity_dynamic_profile_ladder_cap_effective",
        sample.effectiveProfileLadderCap,
      );
    }
    if (sample.nonLadderReserve != null) {
      runtimeMetrics.writeLatest(
        "sell_capacity_dynamic_non_ladder_reserve",
        sample.nonLadderReserve,
      );
    }
    if (sample.dynamicGlobalCap != null) {
      runtimeMetrics.writeLatest("sell_capacity_dynamic_global_cap", sample.dynamicGlobalCap);
    }
    if (!sample.approved && sample.rejectionReason) {
      orderCapacityWindow.rejectedByReason.set(
        sample.rejectionReason,
        (orderCapacityWindow.rejectedByReason.get(sample.rejectionReason) ?? 0) + 1,
      );
    }
    incrementBucket(
      orderCapacityWindow.openBuyOrderCountBuckets,
      bucketCount(sample.openBuyOrderCount, 15),
    );
    incrementBucket(
      orderCapacityWindow.openSellOrderCountBuckets,
      bucketCount(sample.openSellOrderCount, 10),
    );
    incrementBucket(
      orderCapacityWindow.openOrdersTotalBuckets,
      bucketCount(sample.openOrdersTotal, 22),
    );
    incrementBucket(
      orderCapacityWindow.perTokenOpenBuyOrderCountBuckets,
      bucketCount(sample.perTokenOpenBuyOrderCount, 2),
    );
    incrementBucket(
      orderCapacityWindow.perTokenOpenSellOrderCountBuckets,
      bucketCount(sample.perTokenOpenSellOrderCount, 2),
    );
  };

  const exchangeStateStore = new ExchangeStateStore({
    balanceRejectBlockMs: config.executionSellBalanceRejectBlockMs,
  });
  const reconcileTrigger: { fn: (() => void) | undefined } = { fn: undefined };
  const executionProfileStateRepo = new SqliteExecutionProfileStateRepository(ledgerConn.db);
  const executionProfileManagerRef: { current?: ExecutionProfileManager } = {};
  const countProfileOwnedOpenPositions = (): number =>
    repos.position
      .findOpen()
      .filter(
        (position) => executionProfileManagerRef.current?.isProfileOwned(position.tokenId) ?? false,
      ).length;
  const tickResolver = new AuthoritativeTickResolver({
    getMarket: (conditionId) => marketDataGateway.getMarket(conditionId),
    getTickSize: (tokenId) => marketDataGateway.getTickSize(tokenId),
  });
  // Built here rather than with the strategy modules below because BOTH the
  // entry pre-filter and the execution SELL guard need the same hydration route,
  // and execution is constructed first.
  const candidateBookCache = marketDataGateway.getOrderBooks
    ? new CandidateBookCache({
        gateway: {
          getOrderBooks: marketDataGateway.getOrderBooks.bind(marketDataGateway),
          setTokenMinimumAuthority: (authority) =>
            marketDataGateway.setTokenMinimumAuthority?.(authority),
        },
        log: log.child({ module: "candidate-book-cache" }),
        // The REST `/books` payload is the only place `min_order_size` ever
        // appears — Gamma pricing and the WSS `book` event both omit it. Feed it
        // back so the market cache keeps it and sellable sizing can size an entry.
        onMinimumChanged: (tokenId, minimum) => {
          void bus.publish("TokenMinimumChanged", { tokenId, minimum });
        },
      })
    : undefined;
  if (candidateBookCache) exchangeGateway.setTokenMinimumSource?.(candidateBookCache.tokenMinimum);
  // Closes the self-heal loop for every consumer that can be blocked by an
  // unknown exchange minimum: the REST book fetched here is what teaches the
  // market its `min_order_size` (via `onMinOrderSizeObserved` above). Left
  // undefined when the gateway cannot fetch books, which keeps each consumer
  // inert rather than permanently blocking. Each consumer applies its own
  // `MIN_ORDER_SIZE_HYDRATION_RETRY_MS` throttle around this call.
  const requestMinOrderSizeHydration = candidateBookCache
    ? (tokenId: string) => {
        void candidateBookCache.forceRefresh(tokenId).catch((error: unknown) => {
          log.debug({ err: error, tokenId }, "min order size hydration refresh failed");
        });
      }
    : undefined;
  executionModule = new ExecutionModule({
    tokenMinimum: candidateBookCache?.tokenMinimum,
    gateway: exchangeGateway,
    bus,
    marketRepo: repos.market,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    log,
    botRunId,
    runtimeControl,
    pauseLiveTrading: () => setPausedAndPersist(true),
    liveLiteGuard,
    runtimeMode,
    requestMinOrderSizeHydration,
    maxConcurrency: config.executionMaxConcurrency,
    fillCompletionTolerance: config.reconciliationFillCompletionTolerance,
    walletBufferPct: config.executionWalletBufferPct,
    walletBufferMinUsdc: config.executionWalletBufferMinUsdc,
    executionPolicy: currentExecutionPolicy,
    executionPolicySnapshot: currentExecutionPolicySnapshot,
    resolutionTracker: marketResolutionTracker,
    ...(candidateBookCache ? { candidateBookCache } : {}),
    allowSellSizeClamp: config.allowSellSizeClamp,
    capacityMetricsSink: recordOrderCapacitySample,
    profileOwnedOpenPositionCount: countProfileOwnedOpenPositions,
    // First-entry adaptive entry TTL — live per-token trailing-3h public trade activity.
    tradeStatsReader: trackCBookSignalsProvider,
    controlDb: controlConn.db,
    activeProfile: activeProfile as import("@krabs/domain").ProfileId,
    exchangeStateStore,
    sellBalanceRejectBlockEnabled: config.executionSellBalanceRejectBlockEnabled,
    sellExchangeReservedEnabled: config.executionSellExchangeReservedEnabled,
    runtimeMetrics,
    reconciliationTrigger: () => reconcileTrigger.fn?.(),
    legStateRepo: repos.legState,
    repriceChainPolicy: () => currentExecutionPolicy().repriceChain,
    riskEventRepo: repos.riskEvent,
    positionConcentration,
    tickResolver,
    makerBuyFastCancel,
  });

  // 7g. Risk + Inventory module
  const signalPathTelemetry = new SignalPathTelemetry();
  const cooldownRegistry = new CooldownRegistry(log.child({ component: "cooldown-registry" }));
  const riskInventoryModule = new RiskInventoryModule({
    tokenMinimum: candidateBookCache?.tokenMinimum,
    bus,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    orderRepo: repos.order,
    marketRepo: repos.market,
    fillRepo: repos.fill,
    log,
    db: ledgerConn.db,
    liveLiteGuard,
    runtimeControl,
    controlDb: controlConn.db,
    activeProfile: activeProfile as import("@krabs/domain").ProfileId,
    walletBufferPct: config.executionWalletBufferPct,
    walletBufferMinUsdc: config.executionWalletBufferMinUsdc,
    executionPolicy: currentExecutionPolicy,
    capacityMetricsSink: recordOrderCapacitySample,
    profileOwnedOpenPositionCount: countProfileOwnedOpenPositions,
    profileStateReader: executionProfileStateRepo,
    redeemInFlightGuard: (conditionId) =>
      redeemSweepModule?.isConditionInRedeemFlight(conditionId) ?? false,
    runtimeMetrics,
    cooldownRegistry,
    signalPathTelemetry,
    resolutionTracker: marketResolutionTracker,
    effectiveResolution,
    markToMarketEnabled: true,
    latestUsablePriceForToken,
    positionConcentration,
    timers: periodicTimers,
    emitStrandedFillAlert: composeStrandedFillAlertEmitter({
      riskEventRepo: repos.riskEvent,
      recordInfraAlert,
      log,
    }),
  });

  // 7h. Strategy module
  const feeScheduleProvider = createHybridFeeScheduleProvider({
    feeGateway: exchangeGateway,
    runtimeMetrics,
  });
  const trackRFeeProvider = createTrackRFeeProvider({
    feeGateway: exchangeGateway,
    fillRepo: repos.fill,
    feeScheduleProvider,
    runtimeMetrics,
  });
  // 7h1. Leg state tracker — maintains leg_states from fills/positions/settlements.
  // Must start before AlgoDecisionModule so leg states are populated when decisions run.
  const legStateTrackerModule = new LegStateTrackerModule({
    bus,
    legStateRepo: repos.legState,
    legStateTransitionRepo: repos.legStateTransition,
    positionRepo: repos.position,
    transitionBackfill: () =>
      backfillLegStateTransitionsFromLedger(ledgerConn.db, repos.legStateTransition, log),
    log,
  });

  // 7h2. Algo decision module (replaces legacy StrategyModule in the pipeline)
  const selectedMarketCache = new MarketSelectionCache(
    bus,
    selectionRuleEngine,
    () => currentExecutionPolicy().marketSelection,
    repos.riskEvent, // Track B §5.4 — durable strike-reject persistence
    effectiveResolution,
  );
  selectedMarketCacheForEnrichment = selectedMarketCache;
  selectedMarketCache.subscribe();

  // ADR-018 §D2 — Step 1 universe-filter funnel telemetry. Emits one log
  // line per `universeFunnelLogIntervalMs` (default 60 s) with cumulative
  // post-normalization counters. Independent of scan-cycle / pricing-tick:
  // `NormalizedMarketUpdated` arrives continuously and the cumulative funnel
  // is the spec-enforcer's view, not the scanner's.
  periodicTimers
    .every("universe_funnel_log", config.universeFunnelLogIntervalMs, () => {
      const snap = selectedMarketCache.getUniverseFilterSnapshot();
      if (snap.seen === 0) return;
      log.info(
        {
          seen: snap.seen,
          volumeZeroDropped: snap.volumeZeroDropped,
          volumeNullEvaluated: snap.volumeNullEvaluated,
          volumePositiveEvaluated: snap.volumePositiveEvaluated,
          selectionRuleAdmitted: snap.selectionRuleAdmitted,
          selectionRuleRejected: snap.selectionRuleRejected,
          selectionRejectReasons: snap.selectionRejectReasons,
        },
        "universeFunnel",
      );
    })
    .unref();

  const priceHistoryProvider = new MarketSnapshotPriceHistoryProvider(ledgerConn.db, {
    syncMissLookup: false,
  });
  const decisionTickLatencyAlert = new SustainedThresholdAlert(
    DECISION_TICK_LATENCY_ALERT_THRESHOLD_MS,
    DECISION_TICK_LATENCY_ALERT_SUSTAINED_MS,
    DECISION_TICK_LATENCY_ALERT_COOLDOWN_MS,
  );

  const sellLoopGuardModule = new SellLoopGuardModule({
    bus,
    policy: () => currentExecutionPolicy().sellLoopGuard,
    riskEventRepo: repos.riskEvent,
    runtimeMetrics,
    db: ledgerConn.db,
    log,
  });
  const signalFeedRepo = new SqliteSignalFeedRepository(ledgerConn.db);
  const signalFeedManager = new SignalFeedManager({
    bus,
    repository: signalFeedRepo,
    config: currentExecutionPolicy().executionProfile.signalFeed,
    metrics: runtimeMetrics,
    riskEvents: repos.riskEvent,
  });
  const signalFeedReader = new SignalFeedReader({
    hotBuffer: signalFeedManager.getHotBuffer(),
    warmTier: signalFeedManager.getWarmTier(),
    bookSignals: trackCBookSignalsProvider,
    config: currentExecutionPolicy().executionProfile.signalFeed,
    metrics: runtimeMetrics,
  });
  const executionProfileRollup = new ExecutionProfileRollup({
    windowMs: currentExecutionPolicy().executionProfile.monitoring.rollupWindowMs,
    maxBuckets: currentExecutionPolicy().executionProfile.monitoring.maxRollupBuckets,
    emit: (event) => repos.riskEvent.insert(event),
    writeCounter: (name, value, labels) => runtimeMetrics.writeCounter(name, value, labels),
    writeEvent: (name, value, labels, capturedAt) =>
      runtimeMetrics.writeEvent(name, value, labels, capturedAt),
  });
  const executionProfileHealthChecker = new ExecutionProfileHealthChecker({
    stateRepo: executionProfileStateRepo,
    riskEvents: repos.riskEvent,
    metrics: runtimeMetrics,
    policy: () => currentExecutionPolicy().executionProfile.monitoring,
    signalFreshness: () => ({ status: "stub_active", reason: "stub_feed" }),
    pendingScaleIns: () => executionProfileManagerRef.current?.getPendingScaleIns() ?? [],
  });
  const executionProfileAnomalyDetector = new ExecutionProfileAnomalyDetector({
    riskEvents: repos.riskEvent,
    metrics: runtimeMetrics,
    policy: () => currentExecutionPolicy().executionProfile.monitoring.anomalyDetection,
  });
  const executionProfileManager = new ExecutionProfileManager({
    bus,
    stateRepo: executionProfileStateRepo,
    positionRepo: repos.position,
    orderRepo: repos.order,
    policy: () => currentExecutionPolicy().executionProfile,
    buyGuardsPolicy: () => currentExecutionPolicy().buyGuards,
    effectiveResolution,
    runtimeMetrics,
    riskEvents: repos.riskEvent,
    rollup: executionProfileRollup,
    healthChecker: executionProfileHealthChecker,
    anomalyDetector: executionProfileAnomalyDetector,
    signalFeedReader,
  });
  executionProfileManagerRef.current = executionProfileManager;
  const profileLadderRepo = new SqliteProfileLadderRepository(ledgerConn.db);
  const profileLadderModeCandidateReader: ProfileLadderModeCandidateReader = {
    getCandidate: (tokenId, config) => {
      const state = repos.tokenModeState.get(tokenId);
      if (state == null) return null;
      const mappedMode = config.mapping[state.mode];
      if (mappedMode !== "up" && mappedMode !== "flat") return null;
      return {
        source: "algo_token_mode_state",
        sourceMode: state.mode,
        mappedMode,
        modeStatus: state.modeStatus,
        modeConfidence: state.modeConfidence,
      };
    },
  };
  const profileLadderModule = new ProfileLadderModule({
    runtimeControl,
    tokenMinimum: candidateBookCache?.tokenMinimum,
    bus,
    repository: profileLadderRepo,
    policy: () => currentExecutionPolicy().executionProfile,
    makerEntryPolicy: () => currentExecutionPolicy().makerEntry,
    modeCandidateReader: profileLadderModeCandidateReader,
    profileStateReader: {
      getProfileState: (tokenId) => executionProfileStateRepo.getState(tokenId)?.state ?? null,
    },
    positionRepo: repos.position,
    orderRepo: repos.order,
    isProfileOwned: (tokenId) => executionProfileManager.isProfileOwned(tokenId),
    bookCache: candidateBookCache,
    onPolicyReload: (handler) =>
      executionPolicyProvider.onReload(() => {
        handler();
      }),
    runtimeMode,
    runtimeMetrics,
    riskEvents: repos.riskEvent,
  });
  const dustAutoCloseRepo = new SqliteDustAutoCloseRepository(ledgerConn.db);
  const dustAutoCloseModule = new DustAutoCloseModule({
    bus,
    repository: dustAutoCloseRepo,
    policy: () => currentExecutionPolicy().trackS4,
    onPolicyReload: (handler) =>
      executionPolicyProvider.onReload(() => {
        handler();
      }),
    candidateProvider: new RepositoryDustAutoCloseCandidateProvider({
      positionRepo: repos.position,
      marketRepo: repos.market,
      fillRepo: repos.fill,
      bookCache: candidateBookCache,
      now: () => Date.now(),
    }),
    redeemInFlightGuard: (conditionId) =>
      redeemSweepModule?.isConditionInRedeemFlight(conditionId) ?? false,
    isProfileOwned: (tokenId) => executionProfileManager.isProfileOwned(tokenId),
    runtimeMetrics,
    riskEvents: repos.riskEvent,
    now: () => Date.now(),
  });
  const s1LadderModule = new S1LadderModule({
    runtimeControl,
    tokenMinimum: candidateBookCache?.tokenMinimum,
    bus,
    positionRepo: repos.position,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    policy: () => currentExecutionPolicy().trackS1,
    runtimeMetrics,
    candidateBookCache,
    riskEventRepo: repos.riskEvent,
    log: log.child({ module: "s1-ladder" }),
  });

  const algoDecisionModule = new AlgoDecisionModule({
    tokenMinimum: candidateBookCache?.tokenMinimum,
    bus,
    legStateRepo: repos.legState,
    algoRulesRepo: repos.algoRules,
    positionRepo: repos.position,
    orderRepo: repos.order,
    // Fill-aware bounce-ladder accounting (docs/plans/2026-07-19-sellable-sizing-bounce-for-all.md):
    // resolveBounceLadderState uses actual fills to compute soldShares/openCommitment and prevent
    // oversell. Also improves the already-live GATE-lane bounce accounting.
    fillRepo: repos.fill,
    ledgerDb: ledgerConn.db,
    decisionSignalLogRepo: repos.decisionSignalLog,
    riskEventRepo: repos.riskEvent,
    runtimeMetrics,
    liveLiteGuard,
    marketLivenessReader: { getMarket: marketDataGateway.getMarket.bind(marketDataGateway) },
    exactNullStartupTransition: {
      isDraining: (tokenId) => executionModule.isExactNullStartupTransitionDraining(tokenId),
    },
    sellLoopGuard: sellLoopGuardModule,
    s1Ownership: s1LadderModule,
    profileLadderOwnership: {
      isProfileLadderOwned: (tokenId) =>
        currentExecutionPolicy().executionProfile.sellLadder.enabled &&
        profileLadderRepo.isProfileLadderOwned(tokenId),
    },
    decisionPersistenceMode: "worker",
    decisionPersistenceWorkerDbPath: ledgerDbPath,
    decisionWorkerCount: config.algoDecisionWorkerCount,
    decisionWorkerBatchSize: config.algoDecisionWorkerBatchSize,
    deferMarketUpdateEvaluation: true,
    selectedMarketCache,
    runtimeControl,
    controlDb: controlConn.db,
    buySignalBudgetCircuitBreaker: createBuySignalBudgetCircuitBreaker({
      orderRepo: repos.order,
      executionPolicy: currentExecutionPolicy,
      controlDb: controlConn.db,
      activeProfile: activeProfile as import("@krabs/domain").ProfileId,
      walletBufferPct: config.executionWalletBufferPct,
      walletBufferMinUsdc: config.executionWalletBufferMinUsdc,
    }),
    tradeCountProvider,
    priceHistoryProvider,
    executionPolicy: currentExecutionPolicy,
    ...(requestMinOrderSizeHydration
      ? {
          requestMinOrderSizeHydration,
          canHydrateMinOrderSize: () => candidateBookCache !== undefined,
        }
      : {}),
    evalMetricsSink: (snapshot) => {
      runtimeMetrics.writeLatest(
        "algo_decision_eval_counters",
        snapshot.evalTotal,
        JSON.stringify(snapshot),
        snapshot.capturedAt,
      );
      runtimeMetrics.writeLatest(
        "algo_decision_latency",
        snapshot.decisionTickLatency.p95Ms ?? 0,
        JSON.stringify(snapshot.decisionTickLatency),
        snapshot.capturedAt,
      );
      runtimeMetrics.writeLatest(
        "r23_cache_activity",
        snapshot.r23Cache?.hitRate ?? 0,
        JSON.stringify(snapshot.r23Cache ?? { invocations: 0, hits: 0, misses: 0, hitRate: null }),
        snapshot.capturedAt,
      );
      const alertNow = Date.parse(snapshot.capturedAt);
      if (
        decisionTickLatencyAlert.observe(
          snapshot.decisionTickLatency.p95Ms,
          Number.isFinite(alertNow) ? alertNow : Date.now(),
        )
      ) {
        // Visibility only: performance alerts surface in /status and logs.
        // They must not pause trading or trigger rollback automatically.
        recordInfraAlert({
          code: "DECISION_TICK_LATENCY_P95_HIGH",
          severity: "error",
          source: "algo-decision",
          message: "Decision tick latency p95 exceeded 30s for 5 minutes.",
          details: {
            thresholdMs: DECISION_TICK_LATENCY_ALERT_THRESHOLD_MS,
            sustainedMs: DECISION_TICK_LATENCY_ALERT_SUSTAINED_MS,
            cooldownMs: DECISION_TICK_LATENCY_ALERT_COOLDOWN_MS,
            latency: snapshot.decisionTickLatency,
          },
        });
      }
    },
    makerShadowOrderRepo: repos.makerShadowOrders,
    marketSnapshotRepo: repos.marketSnapshot,
    log,
    sweepIntervalMs: config.strategyScanIntervalMs,
    plannerSuppressionRollupWindowMs: config.plannerSuppressionRollupWindowMs,
    ...(planktonEntryShadowModule ? { decisionShadowObserver: planktonEntryShadowModule } : {}),
  });

  const orderLifetimeModule = new OrderLifetimeModule({
    bus,
    fillRepo: repos.fill,
    orderRepo: repos.order,
    marketRepo: repos.market,
    positionRepo: repos.position,
    modeStateRepo: repos.tokenModeState,
    riskEventRepo: repos.riskEvent,
    runtimeMetrics,
    policy: () => currentExecutionPolicy().orderLifetime,
    log,
  });

  const samePriceCooldownModule = new SamePriceCooldownModule({
    bus,
    orderRepo: repos.order,
    cooldownRepo: repos.orderPriceCooldown,
    log,
    cooldownRegistry,
  });
  const entryLifecycleModule = new EntryLifecycleModule({
    runtimeControl,
    gateway: exchangeGateway,
    isOrderSubmissionActive: (clientOrderId) =>
      executionModule?.isOrderSubmissionActive(clientOrderId) ?? false,
    bus,
    orderRepo: repos.order,
    positionRepo: repos.position,
    fillRepo: repos.fill,
    legStateRepo: repos.legState,
    algoRulesRepo: repos.algoRules,
    policy: currentExecutionPolicy,
    policySnapshot: currentExecutionPolicySnapshot,
    candidateBookCache,
    ...(exchangeGateway.getOrderResult
      ? { getOrderResult: exchangeGateway.getOrderResult.bind(exchangeGateway) }
      : {}),
    runtimeMetrics,
    log,
  });
  const bounceAskCaptureLifecycleModule = new BounceAskCaptureLifecycleModule({
    runtimeControl,
    gateway: exchangeGateway,
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    policySnapshot: currentExecutionPolicySnapshot,
    ...(candidateBookCache ? { candidateBookCache } : {}),
    log,
  });

  // Standalone SignalToOrderBridge — wired here so it is active when AlgoDecisionModule
  // is used. bridge.subscribe() is called after all modules are wired (below).
  const executionPolicyObservationRepo = new SqliteExecutionPolicyObservationRepository(
    ledgerConn.db,
  );
  const signalToOrderBridge = new SignalToOrderBridge({
    bus,
    log,
    runtimeControl,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    liveLiteGuard,
    candidateBookCache,
    // Track S5 P0a — secondary exit-book source: direct CLOB fetch for cold-miss / stale-primary /
    // overflow held positions. Gated at call time by trackR.exitBookFallback (default off).
    exitBookFetcher: { getOrderBook: marketDataGateway.getOrderBook.bind(marketDataGateway) },
    trackRFeeProvider,
    policy: currentExecutionPolicy,
    policySnapshot: currentExecutionPolicySnapshot,
    observations: executionPolicyObservationRepo,
    profileId: activeProfile as import("@krabs/domain").ProfileId,
    runtimeMetrics,
    riskEventRepo: repos.riskEvent,
    // Track A live add-throttle (Krabs-specific). Authoritative leg source for the
    // shared evaluator; gated by policy.trackAAddThrottle.enforce (default off).
    legStateRepo: repos.legState,
    signalPathTelemetry,
    resolutionTracker: marketResolutionTracker,
    effectiveResolution,
    orderLifetime: orderLifetimeModule,
    samePriceCooldown: samePriceCooldownModule,
    positionConcentration,
    // Track S5 belt-and-suspenders — neutralizes S5 exit extensions on a token the
    // S1 ladder owns if the planner's upstream SELL suppression ever regresses.
    s1Ownership: s1LadderModule,
  });

  // 7i. Reconciliation module
  const exactNullStartupQuarantine = {
    isExactNullStartupOrderQuarantined: (order: import("@krabs/domain").Order) =>
      executionModule.isExactNullStartupOrderQuarantined(order),
    isExactNullStartupTokenQuarantined: (tokenId: import("@krabs/domain").TokenId) =>
      executionModule.isExactNullStartupTokenQuarantined(tokenId),
    observeExactNullStartupRemoteState: (
      order: import("@krabs/domain").Order,
      state: "absent" | "working",
    ) => executionModule.observeExactNullStartupRemoteState(order, state),
    getExactNullStartupQuarantineCount: () => executionModule.getExactNullStartupQuarantineCount(),
    getSubmitUnknownRecoveryContexts: (isCurrent?: () => boolean) =>
      executionModule.getSubmitUnknownRecoveryContexts(isCurrent),
  };
  const reconciliationModule = new ReconciliationModule({
    gateway: exchangeGateway,
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    marketRepo: repos.market,
    marketResolutionRepo,
    log,
    reconcileIntervalMs: config.reconciliationIntervalMs,
    suspiciousEmptyThreshold: config.reconciliationSuspiciousEmptyThreshold,
    consecutiveMissThreshold: config.reconciliationConsecutiveMissThreshold,
    fillCompletionTolerance: config.reconciliationFillCompletionTolerance,
    settlementLedgerRepo: repos.settlementLedger,
    driftRepo: repos.positionDrift,
    exitOrderTtlMs: () => currentExecutionPolicy().exitOrderTtlMs,
    exitTtlByLiquidity: () => currentExecutionPolicy().exitTtlByLiquidity,
    exitOrderLifetime: orderLifetimeModule,
    entryRepriceOnOutbid: {
      policy: () => currentExecutionPolicy().repriceOnOutbid,
      getRepriceCount: (signalId) => entryLifecycleModule.getRepriceCount(signalId),
      getMarket: (tokenId) => entryLifecycleModule.getMarket(tokenId),
    },
    exitRepriceOnDownprice: {
      // ONE execution-policy read → the nested policy and the top-level anchor are always a
      // coherent pair (no torn read if a config PATCH lands mid-scan).
      snapshot: () => {
        const p = currentExecutionPolicy();
        return { policy: p.exitRepriceOnDownprice, anchorTicks: p.exitMidpointAnchorTicks };
      },
      getMarket: (tokenId) => entryLifecycleModule.getMarket(tokenId),
    },
    runtimeMetrics,
    exactNullStartupQuarantine,
    exchangeStateStore,
    recoveryTtlCoverage: {
      positionRepo: repos.position,
      inventoryLotRepo: repos.inventoryLot,
      fillRepo: repos.fill,
      exchangeStateStore,
    },
    legStateRepo: repos.legState,
    trackAAddThrottlePolicy: () => currentExecutionPolicy().trackAAddThrottle,
    repriceChainPolicy: () => currentExecutionPolicy().repriceChain,
    riskEventRepo: repos.riskEvent,
    quoteMotionShadow: {
      orderRepo: repos.order,
      fillRepo: repos.fill,
      positionRepo: repos.position,
      inventoryLotRepo: repos.inventoryLot,
      riskEventRepo: repos.riskEvent,
      maxBookAgeMs: 3_000,
      getFreshBooks: async (tokenIds, nowMs) => {
        const result = new Map();
        const missing: string[] = [];
        for (const tokenId of tokenIds) {
          const entry = candidateBookCache?.getFreshEntry(tokenId, nowMs);
          const tickSize = entryLifecycleModule.getMarket(tokenId as TokenId)?.tickSize;
          if (!entry || tickSize == null || !Number.isFinite(tickSize) || tickSize <= 0) {
            missing.push(tokenId);
            continue;
          }
          result.set(tokenId, {
            book: entry.book,
            cachedAtMs: entry.cachedAtMs,
            snapshotTs: entry.snapshotTs,
            tickSize,
            source: `${entry.bookSource}:${entry.sourceKind}`,
          });
        }
        if (missing.length === 0 || !marketDataGateway.getOrderBooks) return result;
        const fetched = await marketDataGateway.getOrderBooks(missing);
        const acquiredAtMs = Date.now();
        for (const tokenId of missing) {
          const book = fetched.get(tokenId);
          const tickSize = entryLifecycleModule.getMarket(tokenId as TokenId)?.tickSize;
          if (!book || tickSize == null || !Number.isFinite(tickSize) || tickSize <= 0) continue;
          result.set(tokenId, {
            book,
            cachedAtMs: acquiredAtMs,
            snapshotTs: book.timestamp,
            tickSize,
            source: "clob:rest-shadow",
          });
        }
        return result;
      },
      onWriteError: (err, order) =>
        log.warn({ err, orderId: String(order.orderId) }, "quote-motion shadow event write failed"),
    },
    trackCExit: {
      positionRepo: repos.position,
      legStateRepo: repos.legState,
      holdResolutionRepo: repos.holdResolutionState,
      floorIntentRepo: repos.floorIntent,
      getBookSignals: (tokenId, anchor) =>
        trackCBookSignalsProvider.getBookSignals(tokenId, anchor),
      floorCloseRatioThreshold: () => null,
    },
    ...(runtimeMode === "live-lite" && traderAddress
      ? (() => {
          const reader = new PolymarketDataPositionReader(traderAddress);
          return {
            walletPositionSentinel: {
              reader,
              positionRepo: repos.position,
              fillRepo: repos.fill,
              marketRepo: repos.market,
              log,
              bus,
              latestUsablePriceLookup,
              latestMinOrderSize: (tokenId: TokenId): number | null =>
                riskInventoryModule.getLatestMinOrderSize(tokenId),
            },
            walletPositionReader: reader,
          };
        })()
      : {}),
  });
  reconcileTrigger.fn = () => reconciliationModule.triggerImmediateReconciliation();

  const userOrderStreamModule =
    runtimeMode === "live-lite"
      ? new UserOrderStreamModule({
          gateway: exchangeGateway,
          bus,
          exactNullStartupQuarantine,
          marketRepo: repos.market,
          orderRepo: repos.order,
          fillRepo: repos.fill,
          log,
          fillCompletionTolerance: config.reconciliationFillCompletionTolerance,
        })
      : null;

  // 7j. Resolution module — detect resolved markets, settle positions.
  // Note: `marketResolutionRepo` and `marketResolutionTracker` are constructed
  // earlier (alongside the repos block) so they are available to
  // RiskInventoryModule and SignalToOrderBridge upstream. The Gamma client and
  // detector live with the resolution module that owns them.
  const gammaResolutionClient = new GammaResolutionClient({ depHealthRecorder: runtimeMetrics });

  const resolutionDetector = new ResolutionDetector(
    repos.position,
    repos.market,
    marketResolutionRepo,
    gammaResolutionClient,
    log,
    marketDataGateway,
  );
  const positionSettler = new PositionSettler(
    repos.position,
    repos.inventoryLot,
    ledgerConn.db,
    repos.market,
  );
  const resolutionModule = new ResolutionModule({
    detector: resolutionDetector,
    settler: positionSettler,
    marketRepo: repos.market,
    resolutionRepo: marketResolutionRepo,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    gammaClient: gammaResolutionClient,
    lotRepo: repos.inventoryLot,
    positionRepo: repos.position,
    db: ledgerConn.db,
    bus,
    log,
    checkIntervalMs: 5 * 60_000, // 5 minutes
    graceMinutes: 30,
    runtimeControl,
    settlementInfraBreaker,
    redeemQuarantineRepo: repos.redeemQuarantine,
    // In live-lite mode, provide the exchange gateway so the resolution module
    // verifies on-chain token balance is 0 before settling in the ledger.
    // In simulation/paper modes, no gateway is needed (no on-chain state).
    ...(runtimeMode === "live-lite" && exchangeGateway ? { gateway: exchangeGateway } : {}),
  });
  resolutionModuleRef.current = resolutionModule;

  redeemSweepModule =
    runtimeMode === "live-lite" && traderAddress
      ? new RedeemSweepModule({
          bus,
          gateway: exchangeGateway,
          positionReader: new PolymarketDataPositionReader(traderAddress),
          positionRepo: repos.position,
          lotRepo: repos.inventoryLot,
          marketRepo: repos.market,
          marketResolutionRepo,
          settler: positionSettler,
          orderRepo: repos.order,
          redeemLogRepo: repos.redeemLog,
          redeemQuarantineRepo: repos.redeemQuarantine,
          policy: () => currentExecutionPolicy().redeemSweep,
          depositActivationPolicy: () => currentExecutionPolicy().depositActivation,
          riskEventRepo: repos.riskEvent,
          log,
          runtimeMetrics,
          runtimeControl,
          settlementInfraBreaker,
        })
      : null;

  // 7k. Inventory Auto-Merge (P3-1) — Polymarket-specific USDC-release operational
  // extension. Not in spec §0; gated behind ENABLE_INVENTORY_AUTO_MERGE=true.
  // See docs/adr/002-inventory-auto-merge.md.
  // The flag gates SUBMISSION only. Repairing a merge that already landed on chain is
  // unconditional and does not live here — see `recoverConfirmedOnchainMerges` at step 10b,
  // which runs before supervisor.start() whether or not this module exists.
  // Wallet-mode compatibility (submitting a merge needs a relayer settlement client) is enforced
  // by the startup preflight further down (INVENTORY_AUTO_MERGE_REQUIRES_RELAYER in
  // profile-preflight.ts), which exits before supervisor.start() ever runs this module.
  const inventoryManagerModule = config.enableInventoryAutoMerge
    ? new InventoryManagerModule({
        bus,
        gateway: exchangeGateway,
        positionRepo: repos.position,
        orderRepo: repos.order,
        marketRepo: repos.market,
        fillRepo: repos.fill,
        lotRepo: repos.inventoryLot,
        mergeLedgerRepo: repos.mergeLedger,
        db: ledgerConn.db,
        log,
        runtimeMetrics,
        settlementInfraBreaker,
        sweepIntervalMs: config.inventorySweepIntervalMs,
        runtimeControl,
      })
    : null;

  // 7l. Fill poller module — live-lite uses fast-interval fill detection.
  const fillPollerModule = new FillPollerModule({
    gateway: exchangeGateway,
    fillRepo: repos.fill,
    orderRepo: repos.order,
    bus,
    log,
    pollIntervalMs: config.fillPollIntervalMs,
    overlapMs: 5_000,
    fillCompletionTolerance: config.reconciliationFillCompletionTolerance,
    onImportObserved: userOrderStreamModule
      ? ({ imported }) => userOrderStreamModule.recordPollingFills(imported)
      : undefined,
  });

  // 7l3. Profile runtime publisher — periodic upsert of profile_summaries + equity snapshots
  const profilePublisher = new ProfileRuntimePublisher({
    controlDb: controlConn.db,
    ledgerDb: ledgerConn.db,
    profile: activeProfile,
    getPaused: () => supervisorRef.current.isPaused(),
    log,
    intervalMs: 60_000,
    ...(runtimeMode === "live-lite" ? { exchangeGateway } : {}),
  });
  const ledgerRetentionModule = new LedgerRetentionModule({
    db: ledgerConn.db,
    log,
    runtimeControl,
    // The checkpoint opens its own connection in a worker thread — a synchronous multi-GB TRUNCATE
    // on THIS connection would freeze the runtime for minutes.
    checkpointDbPath: ledgerDbPath,
    // Single source of truth: the operator's declared signal-feed retention, so lowering it in the
    // profile actually shrinks the ledger instead of silently diverging from it. Resolved per pass,
    // not once at construction — `currentExecutionPolicy()` reloads on a version bump, and a horizon
    // that only takes effect after a restart is exactly what an operator raising it to protect
    // history would NOT expect.
    resolveSignalFeedBucketsTtlMs: () =>
      currentExecutionPolicy().executionProfile.signalFeed.retentionDays * 24 * 60 * 60_000,
  });
  // v063 safety net: pause the bot through the normal operator-pause path
  // (a system-initiated `pause` command, applied by the command-poller) if the
  // ledger outgrows the disk faster than retention can sweep it. No auto-resume.
  const dbSizeGuardModule = new DbSizeGuardModule({
    dbPath: ledgerDbPath,
    db: ledgerConn.db,
    log,
    config: config.dbSizeGuard,
    runtimeControl,
    recordTrigger: () => runtimeMetrics.writeCounter("db_size_guard_triggered_total"),
    pause: (reason) => {
      repos.operatorCommand.insert({
        action: "pause",
        targetId: null,
        reason,
        createdAt: new Date().toISOString(),
        initiatorType: "system",
        initiator: "db-size-guard",
      });
    },
  });
  const holdResolutionCleanupModule = new HoldResolutionCleanupModule({
    bus,
    holdResolutionRepo: repos.holdResolutionState,
    log,
  });

  const modules: Array<[string, import("@krabs/domain").RuntimeModule]> = [
    ["command-poller", commandPoller],
    ...(planktonEntryShadowModule
      ? [
          ["plankton-entry-shadow", planktonEntryShadowModule] as [
            string,
            import("@krabs/domain").RuntimeModule,
          ],
        ]
      : []),
    ["market-scanner", marketScannerModule],
    ["market-data", marketDataModule],
    ["normalization", normalizationModule],
    ["soft-ranking-score", softRankingScoreModule],
    // leg-state-tracker MUST start before risk-inventory: risk-inventory's
    // start() runs replayUnreconciledFills, which publishes PositionUpdated
    // for each replayed fill. If leg-state-tracker hasn't subscribed yet,
    // those events are lost and any leg row whose closing PositionUpdated
    // came from a replay stays orphaned, driving D7 SELL spam against a
    // closed position.
    ["hold-resolution-cleanup", holdResolutionCleanupModule],
    ["leg-state-tracker", legStateTrackerModule],
    ["risk-inventory", riskInventoryModule],
    ["profile-publisher", profilePublisher],
    ["ledger-retention", ledgerRetentionModule],
    ["db-size-guard", dbSizeGuardModule],
    ["order-lifetime", orderLifetimeModule],
    ["same-price-cooldown", samePriceCooldownModule],
    ["reconciliation", reconciliationModule],
    ...(userOrderStreamModule
      ? [
          ["user-order-stream", userOrderStreamModule] as [
            string,
            import("@krabs/domain").RuntimeModule,
          ],
        ]
      : []),
    ...(redeemSweepModule
      ? [["redeem-sweep", redeemSweepModule] as [string, import("@krabs/domain").RuntimeModule]]
      : []),
    ["sell-loop-guard", sellLoopGuardModule],
    ["execution-profile-signal-feed", signalFeedManager],
    ["execution-profile", executionProfileManager],
    ["profile-ladder", profileLadderModule],
    ["track-s4-dust-auto-close", dustAutoCloseModule],
    ["s1-ladder", s1LadderModule],
    ["algo-decision", algoDecisionModule],
    ["resolution", resolutionModule],
    ...(fillPollerModule
      ? [["fill-poller", fillPollerModule] as [string, import("@krabs/domain").RuntimeModule]]
      : []),
    ["execution", executionModule],
    ["bounce-ask-capture-lifecycle", bounceAskCaptureLifecycleModule],
    ["entry-lifecycle", entryLifecycleModule],
    // inventory-manager MUST start LAST: its start() re-runs the merge-fence repair, and every
    // merge it settles publishes PositionUpdated. profile-ladder answers that event by publishing
    // PlaceOrderRequested/CancelOrderRequested — and a command published before ExecutionModule
    // subscribed is dropped with NO terminal event, while the ladder has already written the
    // pending rung it would clear. That rung never resolves, so exit coverage can stay stuck for
    // the life of the process. Started here, every consumer is subscribed: the startup fence still
    // refuses the placement, but it refuses it with an OrderRejected the ladder can act on.
    // Stopping in reverse makes it stop FIRST, which is also what the drain wants — an in-flight
    // sweep's PositionUpdated then still reaches subscribers that are all alive.
    ...(inventoryManagerModule
      ? [
          ["inventory-manager", inventoryManagerModule] as [
            string,
            import("@krabs/domain").RuntimeModule,
          ],
        ]
      : []),
  ];

  bus.subscribe("ReconciliationDriftDetected", async () => {
    runtimeMetrics.writeLatest("reconciliation_drift");
  });

  bus.subscribe("ReconciliationComplete", async ({ result }) => {
    runtimeMetrics.writeLatest(
      "last_reconciliation",
      1,
      null,
      new Date(result.ranAt).toISOString(),
    );
    if (result.clean) {
      runtimeMetrics.writeLatest(
        "reconciliation_clean",
        1,
        null,
        new Date(result.ranAt).toISOString(),
      );
    }
  });

  bus.subscribe("MarketSnapshotReceived", async ({ timestamp }) => {
    runtimeMetrics.writeLatest(
      "market_data_last_update",
      1,
      null,
      new Date(timestamp).toISOString(),
    );
  });

  // 7n. Persist downsampled market snapshots (5-min per token, 7-day TTL)
  const snapshotWriter = new SnapshotWriter(repos.marketSnapshot, {
    intervalMs: 5 * 60 * 1000,
    pruneIntervalMs: 60 * 60 * 1000,
    pruneTtlMs: 7 * 24 * 60 * 60 * 1000,
    enabled: () => !runtimeControl.isPaused(),
    preserveTokenIds: () => marketDataModule.getFullLifetimeSnapshotPreserveTokenIds(),
    positionValuation: {
      // Valuation is per ROW, not per token: each row's mark comes from its own `size`, and the
      // deduped read left every dust sibling's `current_value_usdc` frozen at its last write.
      activePositions: () => findActivePositionRows(repos.position),
      runtimeMetrics,
      log,
    },
  });

  bus.subscribe("MarketSnapshotReceived", async ({ markets, timestamp }) => {
    snapshotWriter.onSnapshot(markets, timestamp);
  });

  bus.subscribe("MarketSnapshotHeartbeat", async ({ markets, timestamp, booksByToken }) => {
    snapshotWriter.onHeartbeat(markets, timestamp, booksByToken);
  });

  // 7o. Persist risk events — deduplicated signal rejections, drift, exposure breach.
  // Operator commands (pause/resume) go to operator_commands + state_transitions
  // tables elsewhere, not to risk_events.
  const riskEventWriter = new RiskEventWriter(repos.riskEvent, {
    rejectCooldownMs: 15 * 60 * 1000,
    orderRejectCooldownMs: 15 * 60 * 1000,
    exchangeErrorRejectCooldownMs: 5 * 60 * 1000,
    exposureBreachCooldownMs: 15 * 60 * 1000,
  });

  bus.subscribe("SignalRejected", async ({ signal, reason, rejectedAt }) => {
    riskEventWriter.onSignalRejected(signal, reason, rejectedAt);
  });

  bus.subscribe("OrderRejected", async (event) => {
    riskEventWriter.onOrderRejected(event);
  });

  bus.subscribe("ReconciliationDriftDetected", async ({ details, severity, timestamp }) => {
    riskEventWriter.onReconciliationDrift(details, severity, timestamp);
  });

  // Post-reconciliation exposure check: pre-trade caps stop new signals that
  // would breach, but stale buy orders, reconciliation adjustments, or drift
  // from the pre-trade model can still push actual exposure over the envelope.
  // Uses the shared calculateTotalExposure formula (open positions cost basis
  // + open buy-order notional) — same as preflight and ExecutionModule — to
  // stay consistent with the rest of the exposure-cap plumbing. Emits only in
  // live-lite mode.
  if (liveLiteConfig) {
    const exposureCap = liveLiteConfig.maxOpenValueUsdc;
    bus.subscribe("ReconciliationComplete", async () => {
      const total = calculateTotalExposure(repos.position, repos.order);
      riskEventWriter.onExposureBreach(total, exposureCap, Date.now());
    });
  }

  // Through `runtimeMetrics`, not a raw statement, because this subscription is permanent: it keeps
  // firing while modules stop, and only the writer knows teardown has begun and must therefore drop
  // to the short busy_timeout. A raw prepared statement here would wait the full 30s per write
  // against the checkpoint worker's lock and eat the whole shutdown budget.
  bus.subscribe("MarketDataPollProgress", async ({ active, page, botRunId: runId }) => {
    if (active) {
      runtimeMetrics.replaceLatest(
        "market_data_poll_progress",
        1,
        JSON.stringify({ active: true, page, botRunId: runId }),
      );
    } else {
      runtimeMetrics.clearLatest("market_data_poll_progress");
    }
  });

  // 7p. Persist signal activity metrics for API trading-state computation

  const deleteSignalActivity = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'signal_activity'",
  );
  const insertSignalActivity = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('signal_activity', 1, ?, ?)",
  );
  const deleteSignalConversionActivity = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'signal_conversion_activity'",
  );
  const insertSignalConversionActivity = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('signal_conversion_activity', 1, ?, ?)",
  );
  const deleteRiskEventVolume = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'risk_event_volume'",
  );
  const insertRiskEventVolume = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('risk_event_volume', 1, ?, ?)",
  );
  const countRiskEventsSince = ledgerConn.db.prepare(
    "SELECT COUNT(*) as c FROM risk_events WHERE created_at >= datetime(?)",
  );
  const signalTelemetryRiskEventPlaceholders = SIGNAL_TELEMETRY_RISK_EVENT_TYPES.map(
    () => "?",
  ).join(", ");
  const countSignalTelemetryRiskEventsSince = ledgerConn.db.prepare(
    `SELECT COUNT(*) as c
     FROM risk_events
     WHERE created_at >= datetime(?)
       AND event_type IN (${signalTelemetryRiskEventPlaceholders})`,
  );
  const diagnosticRiskEventPlaceholders = NON_OPERATIONAL_DIAGNOSTIC_RISK_EVENT_TYPES.map(
    () => "?",
  ).join(", ");
  const countDiagnosticRiskEventsSince = ledgerConn.db.prepare(
    `SELECT COUNT(*) as c
     FROM risk_events
     WHERE created_at >= datetime(?)
       AND event_type IN (${diagnosticRiskEventPlaceholders})`,
  );
  const deleteUserOrderStreamActivity = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'user_order_stream_activity'",
  );
  const insertUserOrderStreamActivity = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('user_order_stream_activity', 1, ?, ?)",
  );
  const deleteMarketDataStreamActivity = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'market_data_stream_activity'",
  );
  const insertMarketDataStreamActivity = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('market_data_stream_activity', 1, ?, ?)",
  );
  const deleteSignalPathActivity = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'signal_path_activity'",
  );
  const insertSignalPathActivity = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('signal_path_activity', 1, ?, ?)",
  );
  const upsertSignalActivity = ledgerConn.db.transaction((labels: string, capturedAt: string) => {
    deleteSignalActivity.run();
    insertSignalActivity.run(labels, capturedAt);
  });
  const upsertSignalConversionActivity = ledgerConn.db.transaction(
    (labels: string, capturedAt: string) => {
      deleteSignalConversionActivity.run();
      insertSignalConversionActivity.run(labels, capturedAt);
    },
  );
  const upsertRiskEventVolume = ledgerConn.db.transaction((labels: string, capturedAt: string) => {
    deleteRiskEventVolume.run();
    insertRiskEventVolume.run(labels, capturedAt);
  });
  const upsertUserOrderStreamActivity = ledgerConn.db.transaction(
    (labels: string, capturedAt: string) => {
      deleteUserOrderStreamActivity.run();
      insertUserOrderStreamActivity.run(labels, capturedAt);
    },
  );
  const upsertMarketDataStreamActivity = ledgerConn.db.transaction(
    (labels: string, capturedAt: string) => {
      deleteMarketDataStreamActivity.run();
      insertMarketDataStreamActivity.run(labels, capturedAt);
    },
  );
  const upsertSignalPathActivity = ledgerConn.db.transaction(
    (labels: string, capturedAt: string) => {
      deleteSignalPathActivity.run();
      insertSignalPathActivity.run(labels, capturedAt);
    },
  );
  const readRiskEventCount = (
    stmt: { get(...args: unknown[]): unknown },
    sinceIso: string,
    eventTypes: readonly string[] = [],
  ): number => {
    const row = stmt.get(sinceIso, ...eventTypes) as { c?: number } | undefined;
    return row?.c ?? 0;
  };

  // Track signal counts in a sliding window (resets every 10 minutes — approximate, not rolling)
  const signalWindow = {
    produced: 0,
    approved: 0,
    rejected: 0,
    entryApproved: 0,
    exitApproved: 0,
    lastReset: Date.now(),
  };
  const SIGNAL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
  const durableSignalActivity = new SignalActivityWindow(ledgerConn.db);
  const conversionWindow = {
    converted: 0,
    conversionSkippedByReason: new Map<string, number>(),
    cacheStatusByStatus: new Map<string, number>(),
    exchangeAccepted: 0,
    exchangeRejectedByCode: new Map<string, number>(),
    exchangeRejectedByReason: new Map<string, number>(),
    fills: 0,
    fillLatencySamplesMs: [] as number[],
    cooldownBypassByReason: new Map<string, number>(),
    hotQuoteRefreshes: 0,
    hotLaneActionsByType: new Map<string, number>(),
    hotLaneStatesByState: new Map<string, number>(),
    queueJumpAccepted: 0,
    queueJumpFills: 0,
    lastReset: Date.now(),
  };
  const entryOrderPlacedAtMsByOrderId = new Map<string, number>();

  bus.subscribe("SignalProduced", async () => {
    signalWindow.produced++;
    durableSignalActivity.recordSignalProduced();
  });

  bus.subscribe("SignalApproved", async ({ signal }) => {
    signalWindow.approved++;
    durableSignalActivity.recordSignalApproved(ENTRY_REASONS.has(signal.reason));
    if (ENTRY_REASONS.has(signal.reason)) {
      signalWindow.entryApproved++;
      // Persist last entry approval timestamp separately (not cleared by signal_activity upsert)
      runtimeMetrics.replaceLatest("last_entry_approved");
    } else {
      signalWindow.exitApproved++;
    }
  });

  bus.subscribe("SignalRejected", async ({ reason }) => {
    signalWindow.rejected++;
    durableSignalActivity.recordSignalRejected(reason);
    runtimeMetrics.replaceLatest("last_signal_rejected");
  });

  bus.subscribe("SignalConversionSkipped", async ({ reasons, diagnostics }) => {
    for (const reason of reasons.length > 0 ? reasons : ["conversion-skipped"]) {
      conversionWindow.conversionSkippedByReason.set(
        reason,
        (conversionWindow.conversionSkippedByReason.get(reason) ?? 0) + 1,
      );
    }
    const cacheStatus = diagnostics["cacheStatus"];
    if (typeof cacheStatus === "string" && cacheStatus.length > 0) {
      conversionWindow.cacheStatusByStatus.set(
        cacheStatus,
        (conversionWindow.cacheStatusByStatus.get(cacheStatus) ?? 0) + 1,
      );
    }
  });

  bus.subscribe("PlaceOrderRequested", async ({ command }) => {
    if (ENTRY_REASONS.has(command.signalReason ?? "")) {
      conversionWindow.converted++;
    }
    const cacheStatus = command.metadata?.["cacheStatus"];
    if (typeof cacheStatus === "string" && cacheStatus.length > 0) {
      conversionWindow.cacheStatusByStatus.set(
        cacheStatus,
        (conversionWindow.cacheStatusByStatus.get(cacheStatus) ?? 0) + 1,
      );
    }
  });

  bus.subscribe("OrderPlaced", async ({ signalReason }) => {
    if (ENTRY_REASONS.has(signalReason ?? "")) {
      conversionWindow.exchangeAccepted++;
    }
  });

  bus.subscribe("OrderPlaced", async ({ price, size }) => {
    durableSignalActivity.recordOrderPlaced(price, size);
  });

  bus.subscribe("OrderPlaced", async ({ orderId, signalReason }) => {
    if (!ENTRY_REASONS.has(signalReason ?? "")) return;
    const order = repos.order.findById(orderId);
    if (order?.postOnly === false) {
      conversionWindow.queueJumpAccepted++;
    }
  });

  bus.subscribe("OrderPlaced", async ({ orderId, signalReason, timestamp }) => {
    if (!ENTRY_REASONS.has(signalReason ?? "")) return;
    entryOrderPlacedAtMsByOrderId.set(String(orderId), timestamp);
  });

  bus.subscribe("OrderRejected", async (event) => {
    if (!ENTRY_REASONS.has(event.signalReason ?? "")) return;
    if (!isGatewayOrderReject(event)) return;
    const code = String(event.errorCode ?? "UNKNOWN");
    conversionWindow.exchangeRejectedByCode.set(
      code,
      (conversionWindow.exchangeRejectedByCode.get(code) ?? 0) + 1,
    );
    const rejectionReason = classifyExchangeRejectionReason(event.exchangeErrorDetails);
    conversionWindow.exchangeRejectedByReason.set(
      rejectionReason,
      (conversionWindow.exchangeRejectedByReason.get(rejectionReason) ?? 0) + 1,
    );
  });

  bus.subscribe("FillReceived", async ({ signalReason }) => {
    if (ENTRY_REASONS.has(signalReason ?? "")) {
      conversionWindow.fills++;
    }
  });

  bus.subscribe("FillReceived", async ({ sizeUsdc }) => {
    durableSignalActivity.recordFill(sizeUsdc);
  });

  bus.subscribe("FillReceived", async ({ orderId, signalReason }) => {
    if (!ENTRY_REASONS.has(signalReason ?? "")) return;
    const order = repos.order.findById(orderId);
    if (order?.postOnly === false) {
      conversionWindow.queueJumpFills++;
    }
  });

  bus.subscribe("FillReceived", async ({ orderId, signalReason, timestamp }) => {
    if (!ENTRY_REASONS.has(signalReason ?? "")) return;
    const orderKey = String(orderId);
    const placedAtMs = entryOrderPlacedAtMsByOrderId.get(orderKey);
    if (placedAtMs == null) return;
    entryOrderPlacedAtMsByOrderId.delete(orderKey);
    conversionWindow.fillLatencySamplesMs.push(Math.max(0, timestamp - placedAtMs));
  });

  bus.subscribe("OrderCancelled", async ({ orderId, signalReason, tokenId, reason, timestamp }) => {
    if (reason === "track_a_resting_add_expired") {
      runtimeMetrics.writeCounter("track_a_resting_add_cancel_confirmed_total");
    }
    if (reason === "stale_exit_ttl") {
      runtimeMetrics.writeCounter("exit_order_ttl_cancel_total");
      const market = repos.market.findByTokenId(tokenId);
      const endMs = market?.endDate ? Date.parse(market.endDate) : Number.NaN;
      const aggressiveWindowMs =
        currentExecutionPolicy().orderLifetime.resolutionAggressiveWindowMs;
      if (Number.isFinite(endMs) && endMs - timestamp <= aggressiveWindowMs) {
        runtimeMetrics.writeCounter("exit_order_ttl_cancel_near_resolution_total");
      }
    }
    if (!ENTRY_REASONS.has(signalReason ?? "")) return;
    entryOrderPlacedAtMsByOrderId.delete(String(orderId));
  });

  bus.subscribe("CooldownBypassApplied", async ({ reason }) => {
    conversionWindow.cooldownBypassByReason.set(
      reason,
      (conversionWindow.cooldownBypassByReason.get(reason) ?? 0) + 1,
    );
  });

  bus.subscribe("HotQuoteUpdated", async ({ tokenIds }) => {
    conversionWindow.hotQuoteRefreshes += tokenIds.length;
  });

  // Scanner-layer metrics
  const scannerWindow = {
    candidatesConsidered: 0,
    blockedByResolutionBuffer: 0,
    blockedByWindow: 0,
    scanPrimeSkippedByPolicy: 0,
    lastReset: Date.now(),
  };

  bus.subscribe("ScanTickCompleted", async (ev) => {
    scannerWindow.candidatesConsidered += ev.candidatesConsidered;
    scannerWindow.blockedByResolutionBuffer += ev.blockedByResolutionBuffer;
    scannerWindow.blockedByWindow += ev.blockedByWindow;
    scannerWindow.scanPrimeSkippedByPolicy += ev.scanPrimeSkippedByPolicy;
  });

  const deleteScanner = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'scanner_activity'",
  );
  const insertScanner = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('scanner_activity', 1, ?, ?)",
  );
  const deleteExecutionQueue = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'execution_queue'",
  );
  const insertExecutionQueue = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('execution_queue', 1, ?, ?)",
  );
  const deleteOrderCapacityActivity = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'order_capacity_activity'",
  );
  const insertOrderCapacityActivity = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('order_capacity_activity', 1, ?, ?)",
  );
  let lastRiskEventVolumeWarningAtMs = 0;

  // Flush signal + scanner activity to DB every 30 seconds, reset windows every 10 minutes
  periodicTimers.every("metrics_flush", 30_000, () => {
    const metricsFlushStartMs = performance.now();
    const serializeLabels = (value: unknown): string => {
      const startMs = performance.now();
      try {
        return JSON.stringify(value);
      } finally {
        recordStageDuration("metrics_flush_snapshot_serialize", performance.now() - startMs);
      }
    };
    const writeMetric = (write: () => void): void => {
      const startMs = performance.now();
      try {
        write();
      } finally {
        recordStageDuration("metrics_flush_sqlite_writes", performance.now() - startMs);
      }
    };
    try {
      const now = Date.now();
      durableSignalActivity.closeIfDue(now, runtimeControl.isPaused());
      if (now - signalWindow.lastReset > SIGNAL_WINDOW_MS) {
        signalWindow.produced = 0;
        signalWindow.approved = 0;
        signalWindow.rejected = 0;
        signalWindow.entryApproved = 0;
        signalWindow.exitApproved = 0;
        signalWindow.lastReset = now;
      }
      if (now - conversionWindow.lastReset > SIGNAL_WINDOW_MS) {
        conversionWindow.converted = 0;
        conversionWindow.conversionSkippedByReason.clear();
        conversionWindow.cacheStatusByStatus.clear();
        conversionWindow.exchangeAccepted = 0;
        conversionWindow.exchangeRejectedByCode.clear();
        conversionWindow.exchangeRejectedByReason.clear();
        conversionWindow.fills = 0;
        conversionWindow.fillLatencySamplesMs = [];
        conversionWindow.cooldownBypassByReason.clear();
        conversionWindow.hotQuoteRefreshes = 0;
        conversionWindow.hotLaneActionsByType.clear();
        conversionWindow.hotLaneStatesByState.clear();
        conversionWindow.queueJumpAccepted = 0;
        conversionWindow.queueJumpFills = 0;
        conversionWindow.lastReset = now;
      }
      pruneEntryFillLatencyTracker(entryOrderPlacedAtMsByOrderId, now);
      writeMetric(() =>
        upsertSignalActivity(
          serializeLabels({
            produced: signalWindow.produced,
            approved: signalWindow.approved,
            rejected: signalWindow.rejected,
            entryApproved: signalWindow.entryApproved,
            exitApproved: signalWindow.exitApproved,
            windowStartMs: signalWindow.lastReset,
            durableWindowStartedAtMs: durableSignalActivity.getStartedAtMs(),
            botRunId: String(botRunId),
          }),
          new Date().toISOString(),
        ),
      );
      writeMetric(() =>
        upsertSignalConversionActivity(
          serializeLabels({
            converted: conversionWindow.converted,
            conversionSkippedByReason: Object.fromEntries(
              conversionWindow.conversionSkippedByReason,
            ),
            cacheStatusByStatus: Object.fromEntries(conversionWindow.cacheStatusByStatus),
            exchangeAccepted: conversionWindow.exchangeAccepted,
            exchangeRejectedByCode: Object.fromEntries(conversionWindow.exchangeRejectedByCode),
            exchangeRejectedByReason: Object.fromEntries(conversionWindow.exchangeRejectedByReason),
            fills: conversionWindow.fills,
            fillLatencyMs: summarizeFillLatency(conversionWindow.fillLatencySamplesMs),
            cooldownBypassByReason: Object.fromEntries(conversionWindow.cooldownBypassByReason),
            hotQuoteRefreshes: conversionWindow.hotQuoteRefreshes,
            hotLaneActionsByType: Object.fromEntries(conversionWindow.hotLaneActionsByType),
            hotLaneStatesByState: Object.fromEntries(conversionWindow.hotLaneStatesByState),
            queueJumpAccepted: conversionWindow.queueJumpAccepted,
            queueJumpFills: conversionWindow.queueJumpFills,
            windowStartMs: conversionWindow.lastReset,
          }),
          new Date().toISOString(),
        ),
      );
      const signalPathSnapshot = signalPathTelemetry.snapshotAndReset();
      const signalPathAggregateStartMs = performance.now();
      try {
        signalPathTelemetry.logAggregate(log, signalPathSnapshot, 30);
      } finally {
        recordStageDuration(
          "signal_path_aggregate",
          performance.now() - signalPathAggregateStartMs,
        );
      }
      writeMetric(() =>
        upsertSignalPathActivity(
          serializeLabels({
            ...signalPathSnapshot,
            cooldown: cooldownRegistry.snapshot(),
          }),
          new Date().toISOString(),
        ),
      );
      const riskEventSince1h = new Date(now - 60 * 60 * 1000).toISOString();
      const riskEventSince24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const riskEventsLast1h = readRiskEventCount(countRiskEventsSince, riskEventSince1h);
      const riskEventsLast24h = readRiskEventCount(countRiskEventsSince, riskEventSince24h);
      const signalTelemetryRiskEventsLast1h = readRiskEventCount(
        countSignalTelemetryRiskEventsSince,
        riskEventSince1h,
        SIGNAL_TELEMETRY_RISK_EVENT_TYPES,
      );
      const signalTelemetryRiskEventsLast24h = readRiskEventCount(
        countSignalTelemetryRiskEventsSince,
        riskEventSince24h,
        SIGNAL_TELEMETRY_RISK_EVENT_TYPES,
      );
      const diagnosticTelemetryLast1h = readRiskEventCount(
        countDiagnosticRiskEventsSince,
        riskEventSince1h,
        NON_OPERATIONAL_DIAGNOSTIC_RISK_EVENT_TYPES,
      );
      const diagnosticTelemetryLast24h = readRiskEventCount(
        countDiagnosticRiskEventsSince,
        riskEventSince24h,
        NON_OPERATIONAL_DIAGNOSTIC_RISK_EVENT_TYPES,
      );
      const riskEventVolume = buildRiskEventVolumeSnapshot({
        last1h: riskEventsLast1h,
        last24h: riskEventsLast24h,
        signalTelemetryLast1h: signalTelemetryRiskEventsLast1h,
        signalTelemetryLast24h: signalTelemetryRiskEventsLast24h,
        diagnosticTelemetryLast1h,
        diagnosticTelemetryLast24h,
        thresholdPerHour: RISK_EVENT_WARNING_THRESHOLD_PER_HOUR,
        windowStartMs: now - 24 * 60 * 60 * 1000,
      });
      writeMetric(() =>
        upsertRiskEventVolume(serializeLabels(riskEventVolume), new Date().toISOString()),
      );
      if (
        riskEventVolume.warning &&
        now - lastRiskEventVolumeWarningAtMs >= RISK_EVENT_WARNING_COOLDOWN_MS
      ) {
        lastRiskEventVolumeWarningAtMs = now;
        log.warn(
          {
            riskEventsLast1h: riskEventVolume.last1h,
            riskEventsLast24h: riskEventVolume.last24h,
            signalTelemetryRiskEventsLast1h: riskEventVolume.signalTelemetryLast1h,
            signalTelemetryRiskEventsLast24h: riskEventVolume.signalTelemetryLast24h,
            diagnosticTelemetryRiskEventsLast1h: riskEventVolume.diagnosticTelemetryLast1h,
            diagnosticTelemetryRiskEventsLast24h: riskEventVolume.diagnosticTelemetryLast24h,
            operationalRiskEventsLast1h: riskEventVolume.operationalLast1h,
            operationalRiskEventsLast24h: riskEventVolume.operationalLast24h,
            thresholdPerHour: RISK_EVENT_WARNING_THRESHOLD_PER_HOUR,
          },
          "risk_events growth threshold exceeded",
        );
      }
      if (userOrderStreamModule) {
        writeMetric(() =>
          upsertUserOrderStreamActivity(
            serializeLabels(userOrderStreamModule.getMetricsSnapshot()),
            new Date().toISOString(),
          ),
        );
      }
      writeMetric(() =>
        upsertMarketDataStreamActivity(
          serializeLabels({
            ...marketDataModule.getMetricsSnapshot(),
            ...marketScannerModule.getHintMetricsSnapshot(),
            ...resolutionModule.getHintMetricsSnapshot(),
            wsWorkerMemory: buildProcessMemoryTelemetry(process.memoryUsage()),
          }),
          new Date().toISOString(),
        ),
      );
      // Reset scanner window on same schedule as signal window
      if (now - scannerWindow.lastReset > SIGNAL_WINDOW_MS) {
        scannerWindow.candidatesConsidered = 0;
        scannerWindow.blockedByResolutionBuffer = 0;
        scannerWindow.blockedByWindow = 0;
        scannerWindow.scanPrimeSkippedByPolicy = 0;
        scannerWindow.lastReset = now;
      }
      if (now - orderCapacityWindow.lastReset > SIGNAL_WINDOW_MS) {
        resetOrderCapacityWindow(orderCapacityWindow, now);
      }
      writeMetric(() => {
        deleteScanner.run();
        insertScanner.run(
          serializeLabels({
            candidatesConsidered: scannerWindow.candidatesConsidered,
            blockedByResolutionBuffer: scannerWindow.blockedByResolutionBuffer,
            blockedByWindow: scannerWindow.blockedByWindow,
            scanPrimeSkippedByPolicy: scannerWindow.scanPrimeSkippedByPolicy,
          }),
          new Date().toISOString(),
        );
      });
      writeMetric(() => {
        deleteExecutionQueue.run();
        insertExecutionQueue.run(
          serializeLabels(executionModule.getDiagnostics()),
          new Date().toISOString(),
        );
      });
      writeMetric(() => {
        deleteOrderCapacityActivity.run();
        insertOrderCapacityActivity.run(
          serializeLabels(serializeOrderCapacityWindow(orderCapacityWindow)),
          new Date().toISOString(),
        );
      });
    } finally {
      recordStageDuration("metrics_flush_total", performance.now() - metricsFlushStartMs);
    }
  });

  // Memory-usage breakdown log — helps locate the source of the post-resume
  // RSS climb that has been tripping the 520 MiB cgroup OOM. Distinguishes
  // V8 heap (rss-arrayBuffers-external ~ heap) from off-heap native buffers
  // (arrayBuffers — WebSocket messages) and other external memory.
  periodicTimers
    .every("memory_usage_log", 60_000, () => {
      const mu = process.memoryUsage();
      log.info(
        {
          rssMb: Math.round(mu.rss / 1024 / 1024),
          heapUsedMb: Math.round(mu.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(mu.heapTotal / 1024 / 1024),
          externalMb: Math.round(mu.external / 1024 / 1024),
          arrayBuffersMb: Math.round(mu.arrayBuffers / 1024 / 1024),
        },
        "process.memoryUsage",
      );
    })
    .unref();

  // Event-loop lag instrumentation — the P8 canary auto-rolled back because
  // AbortSignal.timeout(2s) callbacks were firing ~30s late under sweep
  // pressure. Without this metric the symptom was indistinguishable from a
  // network egress problem. resolution=20ms keeps the histogram cheap.
  const loopLag = monitorEventLoopDelay({ resolution: 20 });
  loopLag.enable();
  const gcPauseWindow = new SlidingLatencyWindow(100);
  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcPauseWindow.record(entry.duration);
    }
  });
  try {
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch (err) {
    log.warn({ err }, "gc_pause_observer_unavailable");
  }
  let diagnosticsTickCount = 0;
  periodicTimers
    .every("runtime_diagnostics", 30_000, () => {
      diagnosticsTickCount++;
      if (diagnosticsTickCount % 10 === 0) {
        const cooldownSweepStartMs = performance.now();
        try {
          cooldownRegistry.sweepExpired(Date.now());
        } finally {
          recordStageDuration("cooldown_registry_sweep", performance.now() - cooldownSweepStartMs);
        }
      }
      const eventLoopLag = {
        p50Ms: Math.round(loopLag.percentile(50) / 1e6),
        p95Ms: Math.round(loopLag.percentile(95) / 1e6),
        p99Ms: Math.round(loopLag.percentile(99) / 1e6),
        maxMs: Math.round(loopLag.max / 1e6),
      };
      const gcPause = gcPauseWindow.snapshot();
      const stageTimers = snapshotAndResetStageTimers();
      const diagnostics = buildRuntimeDiagnosticsSnapshot(
        eventLoopLag,
        gcPause,
        process.memoryUsage(),
        stageTimers,
      );
      log.info(
        {
          ...eventLoopLag,
        },
        "event_loop_lag",
      );
      const diagnosticsWriteStartMs = performance.now();
      runtimeMetrics.writeLatest(
        "runtime_diagnostics",
        diagnostics.eventLoopLagMs.p95Ms,
        JSON.stringify(diagnostics),
      );
      recordStageDuration("diagnostics_write", performance.now() - diagnosticsWriteStartMs);
      loopLag.reset();
    })
    .unref();

  // 7q. Wire SignalToOrderBridge subscriptions (not a RuntimeModule — subscribe directly)
  signalToOrderBridge.subscribe();

  // 8. Create supervisor
  supervisorRef.current = new Supervisor({ modules, bus, log });
  const supervisor = supervisorRef.current;

  // 9. Signal handling
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutdown signal received");

    // FIRST, before the long `await` below. These timers write to SQLite at the full connection
    // timeout; left running they fire repeatedly across the teardown wait, and a lock one of them
    // loses would take the process down through Node's uncaught-exception path — skipping the final
    // flush, the shutdown-state publish and `process.exit(0)` at the bottom of this handler. Losing
    // the last periodic telemetry window is the cheapest thing in this teardown.
    periodicTimers.stopAll();
    const teardownDeadlineMs = Date.now() + RUNTIME_STOP_WAIT_MS;
    await waitAtMost(riskInventoryModule.quiescePeriodicReplay(), {
      ms: Math.max(0, teardownDeadlineMs - Date.now()),
      onExpired: () => log.error({}, "unreconciled replay drain exceeded the shutdown budget"),
    });

    // Bounds every REMAINING telemetry write — the ones module stops emit as well as the final
    // flush below — to SHUTDOWN_BUSY_TIMEOUT_MS. Telemetry reaches the ledger through exactly three
    // tables, so it takes all three calls to make that sentence true:
    //   • `runtime_metrics` — holds while every teardown-reachable write goes through
    //     `runtimeMetrics`: the raw prepared statements above are all inside `periodicTimers`,
    //     already killed one line up, and the three that hang off permanent bus subscriptions use
    //     `replaceLatest`/`clearLatest`. A new raw statement on a permanent subscription silently
    //     reopens the 30s-per-write hole this line claims to have closed.
    //   • `risk_events` — bounded at the REPOSITORY, because ~a dozen holders insert directly
    //     (`RiskEventWriter`'s permanent `OrderRejected`/`SignalRejected` subscriptions keep firing
    //     while modules stop, and order-lifetime writes from inside its own `stop()`). A per-caller
    //     bound would be a list to keep in sync; the repository is the one choke point they share.
    //   • `market_snapshots` — the least obvious of the three, because no module writes it from its
    //     own `stop()`. It is reached through the PERMANENT `MarketSnapshotReceived` /
    //     `MarketSnapshotHeartbeat` subscriptions, and `MarketDataModule.stop()` flushes pending
    //     stream updates, which can publish either event. Its `prune` is on the same connection and
    //     is the largest single DELETE in the ledger.
    // Deliberately NOT a connection-wide pragma:
    // execution drains its queue on this same ledger connection, and an order the exchange has
    // already ACCEPTED must be persisted at the full runtime timeout or it exists on the exchange
    // with no local row, which fail-closes startup adoption at the next boot. Telemetry loses one
    // row; trading state loses the position.
    runtimeMetrics.enterShutdownMode();
    repos.riskEvent.enterShutdownMode();
    repos.marketSnapshot.enterShutdownMode();

    try {
      // A teardown commit must not trigger SQLite's implicit PASSIVE checkpoint: it runs
      // synchronously on this thread and copies + fsyncs the whole WAL backlog, which is multi-GB
      // whenever the retention worker's explicit checkpoint has been failing. busy_timeout does not
      // bound that (it is I/O, not lock contention) and the ceiling below cannot fire while a native
      // call runs. Steady state keeps the auto-checkpoint — there it is the safety net.
      disableAutoCheckpoint(ledgerConn.db);
      disableAutoCheckpoint(controlConn.db);

      // Captured BEFORE the wait, not derived after it: the execution tail drain below spends what
      // is LEFT of this same budget, so a slow module teardown shortens the tail rather than
      // extending the total the container's grace period is sized against.
      // One ceiling over the WHOLE module teardown. Each module bounds its own waits, but the stop
      // is a sequence of two dozen of them: bounded-each is not bounded-total, and the total is what
      // the container's grace period actually measures. Past this point the process exits — whatever
      // is still stopping would have been SIGKILLed a few seconds later anyway.
      await waitAtMost(
        supervisor.stop().catch((err: unknown) => log.error({ err }, "supervisor stop error")),
        {
          ms: Math.max(0, teardownDeadlineMs - Date.now()),
          onExpired: () =>
            log.error(
              { waitMs: RUNTIME_STOP_WAIT_MS },
              "module teardown exceeded the shutdown budget — exiting anyway",
            ),
        },
      );

      // Execution's own stop deadline is short so one module cannot starve the rest, and what it
      // abandons can be a POST the exchange already accepted — an order that never reaches the
      // ledger fail-closes startup adoption at the next boot. Module stops normally take
      // milliseconds, so nearly the whole budget above is still unspent here; give the remainder to
      // those commands instead of exiting on top of them. The databases are deliberately left open
      // until `process.exit` (see the `finally` below), which is what makes a write from this tail
      // still land.
      await executionModule.drainAbandonedTail(Math.max(0, teardownDeadlineMs - Date.now()));

      entryLifecycleModule.disposeTerminalListeners();
      bounceAskCaptureLifecycleModule.disposeTerminalListeners();

      signalToOrderBridge.unsubscribe();
      loopLag.disable();
      gcObserver.disconnect();
      selectedMarketCache.dispose();
      candidateBookCache?.dispose();

      runtimeMetrics.stopPeriodicFlush();
      try {
        runtimeMetrics.flushCounters();
      } catch (err) {
        log.warn({ err }, "final runtime metrics flush failed");
      }

      const statePublisher = statePublisherRef.current;
      if (statePublisher) {
        statePublisher.stopHeartbeatLoop();
        try {
          withShutdownBusyTimeout(controlConn.db, () => statePublisher.publishShutdown());
        } catch (err) {
          // The API's control-DB connection holding the writer lock must not cost us the exit: the
          // dashboard shows a stale status for one run, which is strictly cheaper than a SIGKILL.
          log.warn({ err }, "final shutdown state publish failed");
        }
      }
    } catch (err) {
      log.error({ err }, "shutdown teardown failed — exiting anyway");
    } finally {
      // The instance lock is deliberately NOT released here either. A degraded shutdown can leave
      // an unref'ed checkpoint worker still running against its own ledger connection
      // (`wal-checkpoint.ts` abandons rather than terminates it); only `process.exit` below stops
      // that thread. Releasing first would open a window — however short — where a replacement
      // runtime takes the lock and starts bootstrapping a ledger the old worker is still writing.
      // Process exit reclaims the descriptor anyway, which is the whole point of putting the lock
      // on an fd instead of in a PID file.
      //
      // The databases are deliberately NOT closed. In WAL mode `close()` checkpoints once it takes
      // the last-connection exclusive lock — an unbounded copy + fsync of the entire WAL — and it
      // buys nothing on the way to `process.exit`: every committed transaction is already in the WAL
      // file, process exit cannot lose the OS page cache, and the next open recovers the WAL exactly
      // as it does after any crash. Under `synchronous = NORMAL` those frames were never fsynced
      // per-commit anyway, so closing would not raise the durability we already accept.
      log.info("runtime stopped — WAL left for recovery on next open");
      process.exit(0);
    }
  };

  // `.catch` rather than `void`: the handler owns the exit, so a rejection escaping it would become
  // an unhandled rejection and Node would exit through a path that is not this one.
  const onSignal = (signal: string): void => {
    shutdown(signal).catch((err: unknown) => {
      log.error({ err, signal }, "shutdown handler rejected — forcing exit");
      process.exit(1);
    });
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // 10. Profile-aware preflight — runs for ALL profiles before supervisor.start()
  const startupScan = await marketScannerModule.scanOrThrow();
  log.info(startupScan, "blocking startup market scan complete");

  // Gap 2 fail-closed: startup adoption requires the reliable result-returning fill
  // API (distinguishes empty from failure). Real gateways provide it; refuse to
  // start if it is somehow absent rather than falling back to the false-flat path.
  const getFillsResult = exchangeGateway.getFillsResult?.bind(exchangeGateway);
  if (!getFillsResult) {
    throw new Error("exchange gateway missing getFillsResult — cannot fail-closed on startup");
  }
  // Release A Phase 3 (P6): same fail-closed requirement as getFillsResult above —
  // the startup transition fence needs an authoritative open-orders snapshot to
  // classify stale/reopening-risk working orders before the supervisor starts.
  const getOpenOrdersResult = exchangeGateway.getOpenOrdersResult?.bind(exchangeGateway);
  if (!getOpenOrdersResult) {
    throw new Error("exchange gateway missing getOpenOrdersResult — cannot fail-closed on startup");
  }
  const getOrderResult = exchangeGateway.getOrderResult?.bind(exchangeGateway);
  if (!getOrderResult) {
    throw new Error(
      "exchange gateway missing getOrderResult — cannot resolve pending orders at startup",
    );
  }

  // An on-chain merge is already irreversible. Recover it before adoption, the first startup
  // operation that can delete and recreate its recorded position identities. Their current rows are
  // resolved immediately before replay after supervisor.start(), while the startup fence is latched.
  let onchainMergeRecovery: Awaited<ReturnType<typeof recoverConfirmedOnchainMerges>>;
  try {
    onchainMergeRecovery = await recoverConfirmedOnchainMerges({
      bus,
      positionRepo: repos.position,
      orderRepo: repos.order,
      marketRepo: repos.market,
      fillRepo: repos.fill,
      lotRepo: repos.inventoryLot,
      mergeLedgerRepo: repos.mergeLedger,
      db: ledgerConn.db,
      log,
      runtimeMetrics,
    });
  } catch (err) {
    persistFailedStartupState(controlConn.db, log, "on-chain merge recovery abort");
    throw err;
  }

  const startupAdoptionDeps: Parameters<typeof runStartupPositionAdoption>[0] = {
    gateway: {
      getFillsResult,
      getOpenOrdersResult,
      getOrderResult,
      ...(exchangeGateway.getMarketFeeInfo
        ? { getMarketFeeInfo: exchangeGateway.getMarketFeeInfo.bind(exchangeGateway) }
        : {}),
    },
    marketRepo: repos.market,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    legStateRepo: repos.legState,
    log,
    db: ledgerConn.db,
    botRunId,
    fillCompletionTolerance: config.reconciliationFillCompletionTolerance,
    resolveNewExitOwner: (fill, entryLane, openedAt) =>
      resolveNewPositionExitOwner(
        {
          entryLane,
          conditionId: String(fill.conditionId),
          openedAt,
          firstTradeAt: new Date(fill.timestamp).toISOString(),
        },
        currentExecutionPolicy(),
      ),
    allowMissingBounceExitRecovery: () =>
      runtimeMode === "live-lite" && currentExecutionPolicy().makerEntry.mode === "off",
  };
  let startupAdoption: Awaited<ReturnType<typeof runStartupPositionAdoption>>;
  try {
    startupAdoption = await runStartupPositionAdoption(startupAdoptionDeps);
  } catch (err) {
    // Gap 2: persist a failed/paused control state BEFORE exiting so a stale
    // `running, paused=0` row cannot linger (deploy resume-intent must not resume
    // onto a failed/aborted startup).
    persistFailedStartupState(controlConn.db, log, "startup abort");
    throw err;
  }
  log.info(startupAdoption, "startup position adoption complete");
  executionModule.acknowledgeStartupTransitions(startupAdoption.drainTargets);
  ledgerConn.db
    .prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('startup_adoption', ?, ?, ?)",
    )
    .run(
      startupAdoption.positionsCreated,
      JSON.stringify(startupAdoption),
      new Date().toISOString(),
    );
  ledgerConn.db
    .prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('startup_leg_state_seed', ?, ?, ?)",
    )
    .run(
      startupAdoption.seededLegStates,
      JSON.stringify({
        seeded: startupAdoption.seededLegStates,
        alreadyPresent: startupAdoption.alreadyPresentLegStates,
        withoutFills: startupAdoption.positionsWithoutFills.length,
      }),
      new Date().toISOString(),
    );

  if (liveLiteConfig) {
    log.info("running pre-supervisor reconciliation for live-lite preflight");
    await reconciliationModule.runReconciliation();
  }

  // Read active switch request ID (if this boot is part of a profile switch)
  const activeSwitchRow = controlConn.db
    .prepare(
      "SELECT switch_id FROM profile_switch_requests WHERE state NOT IN ('completed', 'failed', 'rolled_back') LIMIT 1",
    )
    .get() as { switch_id: string } | undefined;

  const preflightResult = runProfilePreflight({
    profile: activeProfile,
    ledgerDb: ledgerConn.db,
    controlDb: controlConn.db,
    relayerBuilderAuthConfigured:
      !!(config as typeof config & { polyBuilderApiKey?: string }).polyBuilderApiKey &&
      !!(config as typeof config & { polyBuilderSecret?: string }).polyBuilderSecret &&
      !!(config as typeof config & { polyBuilderPassphrase?: string }).polyBuilderPassphrase,
    polyBuilderCodeConfigured: !!(config as typeof config & { polyBuilderCode?: string })
      .polyBuilderCode,
    enableInventoryAutoMerge: config.enableInventoryAutoMerge,
    ...(liveLiteConfig ? { liveLiteConfig } : {}),
  });
  writePreflightReport(controlConn.db, activeProfile, preflightResult, activeSwitchRow?.switch_id);
  log.info(
    { status: preflightResult.status, info: preflightResult.info },
    "startup preflight complete",
  );

  // Read and clear resume intent early — one-shot guarantee regardless of startup outcome
  const intentRow = controlConn.db
    .prepare("SELECT resume_intent_at, desired_profile FROM runtime_control_state WHERE id = 1")
    .get() as { resume_intent_at: string | null; desired_profile: string | null } | undefined;
  controlConn.db
    .prepare("UPDATE runtime_control_state SET resume_intent_at = NULL WHERE id = 1")
    .run();

  if (preflightResult.status === "failed") {
    for (const b of preflightResult.blockers) {
      log.warn({ blocker: b }, "startup preflight blocker");
    }
    // Publish failed status so the runtime manager can detect and transition to failed
    const failPublisher = new RuntimeStatePublisher(controlConn.db, {
      profile: activeProfile,
      instanceId: randomUUID(),
      runId: "preflight-failed",
    });
    failPublisher.publishFailed();
    log.fatal("startup preflight failed — exiting");
    controlConn.close();
    ledgerConn.close();
    process.exit(1);
  }

  if (preflightResult.warnings.length > 0) {
    for (const w of preflightResult.warnings) {
      log.warn({ warning: w }, "startup preflight warning");
    }
  }

  // Persist live-lite envelope for API consumption
  if (liveLiteConfig) {
    const liveLiteStatus = {
      ...liveLiteConfig,
      walletMode: liveLiteGuard.getWalletMode(),
      minOrderUsdc: liveLiteGuard.getMinOrderUsdc(),
      ...(relayerConfig ? { relayer: relayerConfig } : {}),
    };
    runtimeMetrics.writeLatest(
      "live_lite_envelope",
      1,
      JSON.stringify(liveLiteStatus),
      new Date().toISOString(),
    );
  }

  if (runtimeMode === "live-lite" && liveLiteGuard.getWalletMode() === "relayer") {
    const balances = await exchangeGateway.getBalances();
    if (balances.length === 0) {
      // Every other fatal boot path records the failure for the runtime manager; this one used to
      // exit silently, leaving `runtime_status` stuck on the previous state.
      persistFailedStartupState(controlConn.db, log, "live-lite relayer auth abort");
      log.fatal("live-lite relayer auth check failed — exchange returned no balances");
      controlConn.close();
      ledgerConn.close();
      process.exit(1);
    }
  }

  // Release A Phase 5 — post-activation invariant (fail-closed hard-stop), widened to I1–I5 in
  // Phase 6 (§9a). Once `bounceExit.applyToAllMarkets` is enabled, EVERY active position must have
  // an assigned owner AND the ledger must be structurally consistent: the census repaired the
  // existing ones and the API gate refuses enabling the flag while any violation remains. A
  // violation surfacing HERE means startup adoption/reconciliation (which does not assign
  // ownership) recreated an unowned or mis-bound position AFTER activation — under
  // owner-authoritative servicing it would be legacy-routed (profile) instead of bounce, or its
  // resting SELL would be serviced by the wrong owner, silently violating the bounce-for-all
  // intent. HARD-STOP rather than trade it; the operator re-runs the census before resuming.
  //
  // One class of violation is NOT the operator's to repair: the exchange-live working orders this
  // boot's own classification has ALREADY quarantined as drain targets. `retirePositions` closes a
  // consolidated position and leaves its resting SELL pointing at a retired row (I2) — the exact row
  // the drain below is about to cancel, which is also this invariant's own declared remedy.
  // Hard-stopping there is the WORSE direction: it terminates before issuing the remedy and leaves
  // the real SELL resting on the exchange unsupervised. So those exact order ids are projected out
  // of the active-SELL relation for the gate (never from the ledger, never from the census), and
  // `runDrainedOrderFenceGate` re-proves after seeding that the barrier actually holds each one
  // before the startup fence is released.
  //
  // The gate therefore runs HERE, immediately before the fence, and not earlier: an excuse granted
  // above the preflight/relayer aborts would be handed out by a boot that then exits before
  // `seedStartupTransitions` can keep the promise. With no abort left between the deferral and the
  // drain, the excuse and its remedy are inseparable.
  //
  // Only orders that are STILL working earn the waiver. `classifyStartupTransitionTargets` selects
  // by exchange status and cycle identity, never by local status, so a locally-terminal row can ride
  // along in `drainTargets`. Such a row is not in the active-SELL relation to begin with — waiving it
  // masks nothing, but it would enter the fence gate's obligation set and then clear it on the same
  // terminal status, which reads like a proof and is not one. Keeping the waiver exactly equal to
  // "violations this boot will drain" is what makes the fence gate's later check meaningful.
  const bounceAppliesToAllMarkets = currentExecutionPolicy().bounceExit.applyToAllMarkets;
  // Side matters as much as status. `classifyStartupTransitionTargets` also quarantines reopening
  // BUYs, and `isWorkingSellOrderStatus` inspects only the status column — so without this filter a
  // BUY would raise the waiver latch while deferring nothing (a BUY is not in the active-SELL
  // relation), and the abandoned-waiver fatal would then name it as a "SELL with no owning
  // position", which is simply false.
  const startupFencedOrderIds = new Set(
    startupAdoption.drainTargets.flatMap((target) =>
      target.orders
        .filter((order) => isWorkingSellOrderStatus(order.status))
        .map((order) => String(order.orderId)),
    ),
  );
  const drainedOrderIds = new Set(
    startupAdoption.drainTargets.flatMap((target) =>
      target.orders
        .filter(
          (order) =>
            order.side === "sell" &&
            isWorkingSellOrderStatus(order.status) &&
            target.provenanceByOrderId.get(String(order.orderId)) === "exchange-working",
        )
        .map((order) => String(order.orderId)),
    ),
  );
  const ownershipWaivedOrderIds = drainedOrderIds;
  const recoveryPredecessorOrderIds = new Set(startupAdoption.recoveryPredecessorOrderIds);
  runOwnershipInvariantStartupGate({
    ledgerDb: ledgerConn.db,
    controlDb: controlConn.db,
    applyToAllMarkets: bounceAppliesToAllMarkets,
    log,
    drainedOrderIds,
    recoveryPredecessorOrderIds,
  });
  // The drain is `await`ed work that can itself reject, so no statement order can buy
  // "waiver ⇒ drain ran". What the ordering above DOES buy is "waiver ⇒ drain ran OR the process
  // dies" — every remaining path terminates, so an excused violation can never carry into live
  // trading. This latch covers the second disjunct: it stays true from the waiver until the fence
  // gate proves the drain, and the catch reads it so the abort names the SELL orders left resting
  // instead of burying them under whatever failed first.
  let drainWaiverOutstanding = bounceAppliesToAllMarkets && ownershipWaivedOrderIds.size > 0;

  // 11. Start
  try {
    // Default to paused BEFORE modules run so the command-poller (first module)
    // can legitimately flip us to resumed by applying a pending cmd. Setting
    // paused=true AFTER supervisor.start() clobbered any such resume.
    setPausedAndPersist(true);

    // Finding 6 (round 2): a LATCHED startup fence, set BEFORE the supervisor starts.
    // The command-poller (first module) can apply a pending resume DURING
    // supervisor.start(), before the barrier is seeded — the after-start re-pause used
    // to be too late for that window. While the fence is latched the ExecutionModule
    // refuses EVERY placement regardless of pause, so nothing can slip through until
    // the barrier is seeded.
    executionModule.beginStartupFence();

    await supervisor.start();

    await executionModule.seedStartupTransitions(startupAdoption.drainTargets);

    const replacementRepairs = resolveAppliedMergeReplacementRepairs(ledgerConn.db, repos.position);
    const replacementTokens = new Set(replacementRepairs.map((position) => position.tokenId));
    for (const position of replacementRepairs) repos.legState.delete(position.tokenId);
    const rebuiltLegStates = rebuildLegStatesFromLedger(
      startupAdoptionDeps,
      {
        ...startupAdoption,
        seededLegStates: 0,
        alreadyPresentLegStates: 0,
        positionsWithoutFills: [],
      },
      log,
      replacementTokens,
    );
    for (const legState of rebuiltLegStates) {
      await bus.publish("LegStateUpdated", { legState, timestamp: Date.now() });
    }
    for (const position of [
      ...resolveMergeRecoveryReplayPositions(
        repos.position,
        onchainMergeRecovery.settled,
        replacementTokens,
      ),
      ...replacementRepairs,
    ]) {
      const currentPosition = resolveCurrentMergeRecoveryReplayPosition(repos.position, position);
      if (!currentPosition) continue;
      try {
        await bus.publish("PositionUpdated", { position: currentPosition });
      } catch (err) {
        log.error(
          { positionId: currentPosition.positionId, err: String(err) },
          "failed to replay a startup merge-recovery position update — event-driven caches may hold pre-merge state",
        );
      }
    }

    // `bounceAppliesToAllMarkets` was read before `supervisor.start()`, and the policy is NOT a boot
    // constant: `currentExecutionPolicy()` re-reads control.db on every call with no throttle, so an
    // operator enabling the flag through the API mid-start — which IS the sanctioned activation
    // sequence right after a deploy — makes that snapshot stale. The API certifies the ledger it
    // sees, and the awaited reconciliation pass below can break it afterwards, so a stale `false`
    // here would skip the post-start proof entirely and release the fence onto a ledger the
    // now-enabled flag demands be clean.
    const bounceAppliesAtFenceRelease = currentExecutionPolicy().bounceExit.applyToAllMarkets;

    // Every startup-classified working order must still be terminal or owned by its exact
    // transition before the startup fence opens. This proof is independent of applyToAllMarkets:
    // exact-null quarantine is a submission-ambiguity boundary, not an ownership-policy waiver.
    let startupFenceProofRequired = startupFencedOrderIds.size > 0;
    if (drainWaiverOutstanding || (bounceAppliesAtFenceRelease && drainedOrderIds.size > 0)) {
      startupFenceProofRequired = true;
    }
    if (startupFenceProofRequired) {
      runDrainedOrderFenceGate({
        controlDb: controlConn.db,
        drainedOrderIds: startupFencedOrderIds,
        readOrderStatus: (orderId) => repos.order.findById(orderId as OrderId)?.status,
        isTransitionTarget: (orderId) => executionModule.hasTransitionTarget(orderId as OrderId),
        log,
      });
      drainWaiverOutstanding = false;
    }

    // Second ownership checkpoint — the gate above proved the ledger BEFORE `supervisor.start()`,
    // and module startup writes to that same ledger while the fence is still latched. The concrete
    // case: `ReconciliationModule.start()` `await`s a full reconciliation pass, and its
    // missing-remote auto-close sets a position to `closed` WITHOUT cancelling the SELL resting
    // against it. That SELL was correctly bound when the gate ran, so adoption never classified it
    // as a drain target and nothing downstream revisits it — releasing the fence here would put the
    // runtime live on exactly the ledger the gate exists to refuse.
    //
    // Same projection, so the drain targets the gate excused stay excused (their cancels may not be
    // confirmed yet) and only violations module startup CREATED can trip it. Failing closed here
    // costs one boot, not a crash loop: the auto-close is already persisted, so on the next boot
    // that SELL's cycle is no longer active, adoption classifies it as stale, and the drain cancels
    // it. This does NOT extend to fire-and-forget startup work (`ResolutionModule.start()` kicks
    // `runCheck()` without awaiting it) — no boot-time read can cover mutations that land after it.
    runOwnershipInvariantStartupGate({
      ledgerDb: ledgerConn.db,
      controlDb: controlConn.db,
      applyToAllMarkets: bounceAppliesAtFenceRelease,
      log,
      drainedOrderIds,
      recoveryPredecessorOrderIds,
      phase: "pre-fence-release",
    });

    // Publish runtime state to control.db for cross-service visibility
    const instanceId = randomUUID();
    const statePublisher = new RuntimeStatePublisher(controlConn.db, {
      profile: activeProfile,
      instanceId,
      runId: String(botRunId),
      getExecutionPendingCount: () => executionModule.pendingCount,
    });
    statePublisherRef.current = statePublisher;
    statePublisher.publishStartup();
    executionModule.endStartupFence();
    // publishStartup hardcodes paused=1; reconcile to the supervisor's actual
    // state so a resume applied by the command-poller during start() survives
    // in runtime_control_state as well.
    if (!supervisor.isPaused()) {
      statePublisher.publishRunning();
    }
    statePublisher.startHeartbeatLoop(15_000, periodicTimers);

    // Evaluate resume intent (read+cleared earlier, before preflight exit paths)
    const intentResult = evaluateResumeIntent({
      intentAt: intentRow?.resume_intent_at ?? null,
      nowMs: Date.now(),
      hasActiveSwitch: !!activeSwitchRow,
      desiredProfile: intentRow?.desired_profile ?? null,
      activeProfile,
    });

    if (intentResult.action === "resume") {
      if (await authorizeResume()) {
        log.info({ ageMs: intentResult.ageMs }, "resume intent found — auto-resuming");
        setPausedAndPersist(false);
      } else {
        log.warn("resume intent blocked by startup missing-bounce recovery fence");
      }
    } else if (intentResult.action === "stay_paused") {
      log.warn(
        { reason: intentResult.reason, ageMs: intentResult.ageMs },
        "resume intent skipped — staying paused",
      );
    } else if (!supervisor.isPaused()) {
      log.info({ mode: runtimeMode }, "runtime resumed via pending command");
    } else {
      log.info({ mode: runtimeMode }, "runtime started PAUSED — no resume intent");
    }

    await marketScannerModule.replayLastCatalogMissingSnapshot();

    log.info({ phase: supervisor.getPhase(), paused: supervisor.isPaused() }, "runtime ready");
  } catch (err) {
    // Before the branch that decides HOW this boot dies, and on both branches: a waiver the drain
    // never honoured is the one fact an operator has to act on, and it is invisible in whatever
    // error actually got us here. Excluded is the one abort that already said it better — the fence
    // gate names the precise subset it could not prove and persists the failed state itself, so
    // re-listing every candidate on top of that would bury an exact diagnosis under a broad one.
    if (drainWaiverOutstanding && !(err instanceof DrainedOrderUnfencedError)) {
      reportAbandonedDrainWaiver({
        controlDb: controlConn.db,
        drainedOrderIds,
        log,
      });
    }
    if (err instanceof LifecycleSupersededError) {
      // A signal arrived mid-startup and the shutdown handler took over: it owns the teardown and
      // the exit code. Exiting here too would race it.
      log.warn({ err }, "runtime startup superseded by shutdown");
      return;
    }
    // Not closed, for the same reason the signal path does not close — see the comment there. A
    // startup that failed on a multi-GB ledger would otherwise sit in a close-time checkpoint
    // instead of surfacing the failure.
    log.fatal({ err }, "runtime startup failed");
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("unhandled runtime error", err);
  process.exit(1);
});
