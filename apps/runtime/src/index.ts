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
} from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import {
  createBotRunId,
  ENTRY_REASONS,
  recordStageDuration,
  resolveTradingState,
  snapshotAndResetStageTimers,
} from "@krabs/domain";
import type { TokenId } from "@krabs/domain";
import {
  DataApiTradeCountProvider,
  GammaMarketDiscoveryGateway,
  PolymarketDataPositionReader,
} from "@krabs/exchange";
import { createGateways } from "./gateway-factory.js";
import { LiveLiteGuard } from "./live-lite-guard.js";
import { runProfilePreflight, writePreflightReport } from "./profile-preflight.js";
import {
  evaluatePerTokenOrderCapacity,
  evaluateTotalOrdersCapacity,
  evaluateWalletBuyCapacity,
  hasWalletBuyBudget,
  normalizeBuyCapacityPolicy,
  normalizeOrderCapacityPolicy,
  type OrderCapacityMetricsSample,
  PER_TOKEN_BUY_LIMIT_REASON,
  resolveWalletBuyBudget,
  TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
  WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
} from "./wallet-buy-budget.js";

import { createLogger } from "./logger.js";
import { buildTradeCountObserver } from "./trade-count-observer.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { CommandPoller } from "./supervisor/command-poller.js";
import { MarketDataModule } from "./modules/market-data/market-data-module.js";
import { TrackCBookSignalsProvider } from "./modules/book-signals/book-signals-provider.js";
import { MarketScannerModule } from "./modules/market-scanner/index.js";
import { NormalizationModule } from "./modules/normalization/normalization-module.js";
import { SoftRankingScoreModule } from "./modules/soft-ranking/soft-ranking-score-module.js";
import { loadSoftRankingModel } from "./modules/soft-ranking/load-soft-ranking-model.js";
import {
  computeScoreDistributionSnapshot,
  SCORE_DISTRIBUTION_METRIC_NAME,
} from "./modules/soft-ranking/score-distribution-snapshot.js";
import { softRankingDisabledCleanup } from "./soft-ranking-disabled-cleanup.js";
import { ExecutionModule } from "./modules/execution/execution-module.js";
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
import { ProfileLadderModule } from "./modules/execution-profile/profile-ladder-module.js";
import { SqliteProfileLadderRepository } from "./modules/execution-profile/profile-ladder-repository.js";
import { S1LadderModule } from "./modules/s1-ladder/s1-ladder-module.js";
import { MarketSnapshotPriceHistoryProvider } from "./modules/algo-decision/market-snapshot-price-history.js";
import { MarketSelectionCache } from "./modules/algo-decision/market-selection-cache.js";
import { EntryLifecycleModule } from "./modules/entry-lifecycle/entry-lifecycle-module.js";
import { LegStateTrackerModule } from "./modules/leg-state/leg-state-tracker-module.js";
import { HoldResolutionCleanupModule } from "./modules/reconciliation/hold-resolution-cleanup.js";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation-module.js";
import { ResolutionModule } from "./modules/resolution/resolution-module.js";
import { UserOrderStreamModule } from "./modules/reconciliation/user-order-stream-module.js";
import { InventoryManagerModule } from "./modules/inventory-auto-merge/inventory-manager-module.js";
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
} from "@krabs/db";
import { SnapshotWriter } from "./snapshot-writer.js";
import { createTrackRFeeProvider } from "./track-r-fee-provider.js";
import { findActivePositions } from "./active-positions.js";
import { calculateTotalExposure } from "./exposure-calculator.js";
import { RiskEventWriter } from "./risk-event-writer.js";
import { resolveActiveProfile } from "./profile-boot.js";
import { runStartupPositionAdoption } from "./startup-position-adoption.js";
import { ProfileRuntimePublisher } from "./modules/publisher/profile-runtime-publisher.js";
import { RuntimeStatePublisher } from "./runtime-state-publisher.js";
import { RuntimeMetricWriter } from "./runtime-metric-writer.js";
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
import { buildRuntimeDiagnosticsSnapshot } from "./runtime-diagnostics.js";
import { isGatewayOrderReject } from "./order-rejection-classification.js";
import {
  buildRiskEventVolumeSnapshot,
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
  const log = createLogger(config.logLevel, config.runtimeMode);
  log.info({ mode: config.runtimeMode }, "krabs runtime starting (env mode)");

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
  type RuntimeMode = "simulation" | "paper" | "live-lite";
  const resolvedProfile = resolveActiveProfile(controlConn.db, config.runtimeMode);
  const activeProfile = resolvedProfile.profile;
  const runtimeMode = resolvedProfile.runtimeMode as RuntimeMode;
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

  // 2d. Open ledger DB scoped to active profile
  const ledgerDbPath = controlDbPath.replace("control.db", `ledger-${activeProfile}.db`);
  let ledgerConn: DbConnection;
  try {
    ledgerConn = bootstrapLedgerDb(ledgerDbPath);
    log.info({ path: ledgerDbPath }, "ledger database ready");
  } catch (err) {
    log.fatal({ err }, "ledger database bootstrap failed");
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
  // Aggregated counter flush — high-frequency `*_total` metrics buffer in
  // memory and persist as one row per (name, labels) pair every 30s. Keeps
  // total runtime_metrics write rate from dominating SQLite disk I/O.
  runtimeMetrics.startPeriodicFlush(30_000);
  const recordInfraAlert = (alert: {
    code: string;
    severity: "warning" | "error";
    source: string;
    message: string;
    details?: Record<string, unknown> | undefined;
  }): void => {
    const now = new Date().toISOString();
    runtimeMetrics.writeEvent("infra_alert", 1, JSON.stringify(alert), now);
    redeemSweepModule?.notifySettlementInfraAlert(alert.code);
    log.warn({ alert }, "runtime infra alert recorded");
  };

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
  });

  // 7. Build modules
  // supervisorRef is set before any closure that uses it is actually called
  const supervisorRef = { current: null as unknown as Supervisor };
  const statePublisherRef = { current: null as RuntimeStatePublisher | null };
  const runtimeControl = { isPaused: () => supervisorRef.current.isPaused() };

  // Persist pause state to runtime_metrics so the API can read it
  const persistPauseState = (paused: boolean) => {
    runtimeMetrics.writeLatest("runtime_paused", paused ? 1 : 0);
  };

  function setPausedAndPersist(paused: boolean): void {
    supervisorRef.current.setPaused(paused);
    persistPauseState(paused);
    if (paused) {
      statePublisherRef.current?.publishPaused();
    } else {
      statePublisherRef.current?.publishRunning();
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
      maxOpenValueUsdc: Number(envelope.maxOpenValueUsdc ?? 500),
      maxOrderUsdc: Number(envelope.maxOrderUsdc ?? 25),
      maxActiveMarkets: Number(envelope.maxActiveMarkets ?? 10),
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
  if (runtimeMode === "paper" || runtimeMode === "live-lite") {
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
  const discoveryGateway = new GammaMarketDiscoveryGateway(
    config.gammaTagId !== undefined ? { tagId: config.gammaTagId } : {},
  );

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
  const currentExecutionPolicy = () => {
    executionPolicyProvider.refreshIfStale();
    const snapshot = executionPolicyProvider.snapshot();
    return config.sellTimeoutMs == null
      ? snapshot
      : { ...snapshot, sellTimeoutMs: config.sellTimeoutMs };
  };

  // ADR-016 — market-wide trade-count provider for the post-entry continuation
  // gate. Also supplies D9's rolling 24h public trade count enrichment.
  const tradeCountLog = log.child({ module: "data-api-trade-count-provider" });
  const tradeCountProvider = new DataApiTradeCountProvider({
    observer: buildTradeCountObserver({ log: tradeCountLog, metrics: runtimeMetrics }),
  });
  const trackCBookSignalsProvider = new TrackCBookSignalsProvider();

  const marketScannerModule = new MarketScannerModule({
    discoveryGateway,
    marketRepo: repos.market,
    bus,
    log,
    scanIntervalMs: config.marketScanIntervalMs,
    hintScanMinIntervalMs: config.marketScanHintMinIntervalMs,
    selectionRuleEngine,
    marketSelectionPolicy: () => currentExecutionPolicy().marketSelection,
    runtimeMetrics,
    positionRepo: repos.position,
    orderRepo: repos.order,
    runtimeControl,
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
      activePositionTokenIds: () =>
        findActivePositions(repos.position).map((position) => position.tokenId),
      recordMissingMarket: (tokenId) => {
        runtimeMetrics.writeCounter("full_lifetime_missing_market", 1, JSON.stringify({ tokenId }));
      },
    },
    bookSignals: {
      openPositionTokenIds: () => repos.position.findOpen().map((position) => position.tokenId),
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
  const executionModule = new ExecutionModule({
    gateway: exchangeGateway,
    bus,
    marketRepo: repos.market,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    positionRepo: repos.position,
    log,
    botRunId,
    runtimeControl,
    liveLiteGuard,
    runtimeMode,
    maxConcurrency: config.executionMaxConcurrency,
    fillCompletionTolerance: config.reconciliationFillCompletionTolerance,
    walletBufferPct: config.executionWalletBufferPct,
    walletBufferMinUsdc: config.executionWalletBufferMinUsdc,
    executionPolicy: currentExecutionPolicy,
    allowSellSizeClamp: config.allowSellSizeClamp,
    capacityMetricsSink: recordOrderCapacitySample,
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
  });

  // 7g. Risk + Inventory module
  const signalPathTelemetry = new SignalPathTelemetry();
  const cooldownRegistry = new CooldownRegistry(log.child({ component: "cooldown-registry" }));
  const riskInventoryModule = new RiskInventoryModule({
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
    redeemInFlightGuard: (conditionId) =>
      redeemSweepModule?.isConditionInRedeemFlight(conditionId) ?? false,
    runtimeMetrics,
    cooldownRegistry,
    signalPathTelemetry,
    resolutionTracker: marketResolutionTracker,
    markToMarketEnabled: true,
    latestUsablePriceForToken,
  });

  // 7h. Strategy module
  const candidateBookCache = marketDataGateway.getOrderBooks
    ? new CandidateBookCache({
        gateway: { getOrderBooks: marketDataGateway.getOrderBooks.bind(marketDataGateway) },
        log: log.child({ module: "candidate-book-cache" }),
      })
    : undefined;
  const trackRFeeProvider = createTrackRFeeProvider({
    feeGateway: exchangeGateway,
    fillRepo: repos.fill,
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
  );
  selectedMarketCacheForEnrichment = selectedMarketCache;
  selectedMarketCache.subscribe();

  // ADR-018 §D2 — Step 1 universe-filter funnel telemetry. Emits one log
  // line per `universeFunnelLogIntervalMs` (default 60 s) with cumulative
  // post-normalization counters. Independent of scan-cycle / pricing-tick:
  // `NormalizedMarketUpdated` arrives continuously and the cumulative funnel
  // is the spec-enforcer's view, not the scanner's.
  const universeFunnelLogTimer = setInterval(() => {
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
  }, config.universeFunnelLogIntervalMs);
  universeFunnelLogTimer.unref();

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
  const executionProfileStateRepo = new SqliteExecutionProfileStateRepository(ledgerConn.db);
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
  const executionProfileManagerRef: { current?: ExecutionProfileManager } = {};
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
    runtimeMetrics,
    riskEvents: repos.riskEvent,
    rollup: executionProfileRollup,
    healthChecker: executionProfileHealthChecker,
    anomalyDetector: executionProfileAnomalyDetector,
    signalFeedReader,
  });
  executionProfileManagerRef.current = executionProfileManager;
  const profileLadderModule = new ProfileLadderModule({
    bus,
    repository: new SqliteProfileLadderRepository(ledgerConn.db),
    policy: () => currentExecutionPolicy().executionProfile,
    runtimeMetrics,
    riskEvents: repos.riskEvent,
  });
  const s1LadderModule = new S1LadderModule({
    bus,
    positionRepo: repos.position,
    orderRepo: repos.order,
    policy: () => currentExecutionPolicy().trackS1,
    runtimeMetrics,
    riskEventRepo: repos.riskEvent,
    log: log.child({ module: "s1-ladder" }),
  });

  const algoDecisionModule = new AlgoDecisionModule({
    bus,
    legStateRepo: repos.legState,
    algoRulesRepo: repos.algoRules,
    positionRepo: repos.position,
    orderRepo: repos.order,
    decisionSignalLogRepo: repos.decisionSignalLog,
    riskEventRepo: repos.riskEvent,
    runtimeMetrics,
    sellLoopGuard: sellLoopGuardModule,
    s1Ownership: s1LadderModule,
    decisionPersistenceMode: "worker",
    decisionPersistenceWorkerDbPath: ledgerDbPath,
    decisionWorkerCount: config.algoDecisionWorkerCount,
    decisionWorkerBatchSize: config.algoDecisionWorkerBatchSize,
    deferMarketUpdateEvaluation: true,
    selectedMarketCache,
    runtimeControl,
    controlDb: controlConn.db,
    buySignalBudgetCircuitBreaker: {
      canAttemptBuy: (requiredNotionalUsdc, signal, context) => {
        const openOrders = repos.order.findOpen();
        const pendingPreOpenBuyCount = context?.pendingPreOpenBuyCount ?? 0;
        const openBuyOrderCount =
          openOrders.filter((order) => order.side === "buy").length + pendingPreOpenBuyCount;
        const openOrdersTotal = openOrders.length + pendingPreOpenBuyCount;
        const perTokenOpenBuyOrderCount =
          openOrders.filter((order) => order.side === "buy" && order.tokenId === signal.tokenId)
            .length + (context?.pendingPreOpenBuyCountForToken ?? 0);
        const policy = currentExecutionPolicy();
        const buyPolicy = normalizeBuyCapacityPolicy(policy.buyCapacity);
        const perTokenCapacity = evaluatePerTokenOrderCapacity({
          side: "buy",
          maxOpenOrdersPerToken: buyPolicy.maxOpenBuyOrdersPerToken,
          openOrdersForToken: perTokenOpenBuyOrderCount,
          enabled: buyPolicy.enabled,
        });
        if (!perTokenCapacity.allowed) {
          return {
            canAttempt: false,
            reasonCode: PER_TOKEN_BUY_LIMIT_REASON,
            activateCooldown: false,
          };
        }
        const walletBudget = resolveWalletBuyBudget(
          {
            controlDb: controlConn.db,
            activeProfile: activeProfile as import("@krabs/domain").ProfileId,
            walletBufferPct: config.executionWalletBufferPct,
            walletBufferMinUsdc: config.executionWalletBufferMinUsdc,
          },
          repos.order.sumOpenBuyNotional(),
        );
        const buyCapacity = evaluateWalletBuyCapacity({
          policy: buyPolicy,
          snapshot: walletBudget,
          requiredNotionalUsdc,
          signalReason: signal.reason,
          openBuyOrderCount,
        });
        if (!buyCapacity.allowed) {
          return {
            canAttempt: false,
            reasonCode: WALLET_BUY_CAPACITY_EXHAUSTED_REASON,
            activateCooldown: buyCapacity.availableAfterOrderUsdc != null,
          };
        }
        const totalCapacity = evaluateTotalOrdersCapacity({
          policy: normalizeOrderCapacityPolicy(policy.orderCapacity),
          openOrdersTotal,
        });
        if (!totalCapacity.allowed) {
          return {
            canAttempt: false,
            reasonCode: TOTAL_ORDERS_CAPACITY_EXHAUSTED_REASON,
            activateCooldown: false,
          };
        }
        return {
          canAttempt: hasWalletBuyBudget(walletBudget, requiredNotionalUsdc),
        };
      },
    },
    tradeCountProvider,
    priceHistoryProvider,
    executionPolicy: currentExecutionPolicy,
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
    log,
    sweepIntervalMs: config.strategyScanIntervalMs,
    plannerSuppressionRollupWindowMs: config.plannerSuppressionRollupWindowMs,
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
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    legStateRepo: repos.legState,
    algoRulesRepo: repos.algoRules,
    policy: currentExecutionPolicy,
    runtimeMetrics,
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
    orderRepo: repos.order,
    positionRepo: repos.position,
    liveLiteGuard,
    candidateBookCache,
    // Track S5 P0a — secondary exit-book source: direct CLOB fetch for cold-miss / stale-primary /
    // overflow held positions. Gated at call time by trackR.exitBookFallback (default off).
    exitBookFetcher: { getOrderBook: marketDataGateway.getOrderBook.bind(marketDataGateway) },
    trackRFeeProvider,
    policy: currentExecutionPolicy,
    observations: executionPolicyObservationRepo,
    profileId: activeProfile as import("@krabs/domain").ProfileId,
    runtimeMetrics,
    riskEventRepo: repos.riskEvent,
    signalPathTelemetry,
    resolutionTracker: marketResolutionTracker,
    orderLifetime: orderLifetimeModule,
    samePriceCooldown: samePriceCooldownModule,
    // Track S5 belt-and-suspenders — neutralizes S5 exit extensions on a token the
    // S1 ladder owns if the planner's upstream SELL suppression ever regresses.
    s1Ownership: s1LadderModule,
  });

  // 7i. Reconciliation module
  const reconciliationModule = new ReconciliationModule({
    gateway: exchangeGateway,
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    marketRepo: repos.market,
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
      policy: () => currentExecutionPolicy().exitRepriceOnDownprice,
      getMarket: (tokenId) => entryLifecycleModule.getMarket(tokenId),
    },
    runtimeMetrics,
    exchangeStateStore,
    legStateRepo: repos.legState,
    repriceChainPolicy: () => currentExecutionPolicy().repriceChain,
    riskEventRepo: repos.riskEvent,
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
  const gammaResolutionClient = new GammaResolutionClient();

  const resolutionDetector = new ResolutionDetector(
    repos.position,
    repos.market,
    marketResolutionRepo,
    gammaResolutionClient,
    log,
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
    // In live-lite mode, provide the exchange gateway so the resolution module
    // verifies on-chain token balance is 0 before settling in the ledger.
    // In simulation/paper modes, no gateway is needed (no on-chain state).
    ...(runtimeMode === "live-lite" && exchangeGateway ? { gateway: exchangeGateway } : {}),
  });

  redeemSweepModule =
    runtimeMode === "live-lite" && traderAddress
      ? new RedeemSweepModule({
          bus,
          gateway: exchangeGateway,
          positionReader: new PolymarketDataPositionReader(traderAddress),
          positionRepo: repos.position,
          lotRepo: repos.inventoryLot,
          marketRepo: repos.market,
          orderRepo: repos.order,
          redeemLogRepo: repos.redeemLog,
          redeemQuarantineRepo: repos.redeemQuarantine,
          policy: () => currentExecutionPolicy().redeemSweep,
          depositActivationPolicy: () => currentExecutionPolicy().depositActivation,
          riskEventRepo: repos.riskEvent,
          log,
          runtimeMetrics,
          runtimeControl,
        })
      : null;

  // 7k. Inventory Auto-Merge (P3-1) — Polymarket-specific USDC-release operational
  // extension. Not in spec §0; gated behind ENABLE_INVENTORY_AUTO_MERGE=true.
  // See docs/adr/002-inventory-auto-merge.md.
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
        sweepIntervalMs: config.inventorySweepIntervalMs,
        runtimeControl,
      })
    : null;

  // 7l. Fill poller module — fast-interval fill detection (paper/live-lite only;
  // simulation mode uses inline checkForFills after each placement)
  const fillPollerModule =
    runtimeMode !== "simulation"
      ? new FillPollerModule({
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
        })
      : null;

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
    ["s1-ladder", s1LadderModule],
    ["algo-decision", algoDecisionModule],
    ["resolution", resolutionModule],
    ...(inventoryManagerModule
      ? [
          ["inventory-manager", inventoryManagerModule] as [
            string,
            import("@krabs/domain").RuntimeModule,
          ],
        ]
      : []),
    ...(fillPollerModule
      ? [["fill-poller", fillPollerModule] as [string, import("@krabs/domain").RuntimeModule]]
      : []),
    ["execution", executionModule],
    ["entry-lifecycle", entryLifecycleModule],
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
      activePositions: () => findActivePositions(repos.position),
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

  const deletePollProgress = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'market_data_poll_progress'",
  );
  const insertPollProgress = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('market_data_poll_progress', 1, ?, ?)",
  );
  const upsertPollProgress = ledgerConn.db.transaction((labels: string, capturedAt: string) => {
    deletePollProgress.run();
    insertPollProgress.run(labels, capturedAt);
  });

  bus.subscribe("MarketDataPollProgress", async ({ active, page, botRunId: runId }) => {
    if (active) {
      upsertPollProgress(
        JSON.stringify({ active: true, page, botRunId: runId }),
        new Date().toISOString(),
      );
    } else {
      deletePollProgress.run();
    }
  });

  // 7p. Persist signal activity metrics for API trading-state computation

  const deleteSignalActivity = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'signal_activity'",
  );
  const insertSignalActivity = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('signal_activity', 1, ?, ?)",
  );
  const deleteLastEntryApproved = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'last_entry_approved'",
  );
  const insertLastEntryApproved = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES ('last_entry_approved', 1, ?)",
  );
  const deleteLastSignalRejected = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'last_signal_rejected'",
  );
  const insertLastSignalRejected = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES ('last_signal_rejected', 1, ?)",
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
  });

  bus.subscribe("SignalApproved", async ({ signal }) => {
    signalWindow.approved++;
    if (ENTRY_REASONS.has(signal.reason)) {
      signalWindow.entryApproved++;
      // Persist last entry approval timestamp separately (not cleared by signal_activity upsert)
      deleteLastEntryApproved.run();
      insertLastEntryApproved.run(new Date().toISOString());
    } else {
      signalWindow.exitApproved++;
    }
  });

  bus.subscribe("SignalRejected", async () => {
    signalWindow.rejected++;
    deleteLastSignalRejected.run();
    insertLastSignalRejected.run(new Date().toISOString());
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
  const insertSnapshot = ledgerConn.db.prepare(
    `INSERT INTO trading_state_snapshots (trading_state, signals_produced, signals_approved, signals_rejected, captured_at)
   VALUES (?, ?, ?, ?, ?)`,
  );
  const pruneSnapshots = ledgerConn.db.prepare(
    "DELETE FROM trading_state_snapshots WHERE captured_at < datetime('now', '-14 days')",
  );

  let lastSnapshotMs = 0;
  let lastRiskEventVolumeWarningAtMs = 0;

  // Flush signal + scanner activity to DB every 30 seconds, reset windows every 10 minutes
  setInterval(() => {
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
      const riskEventVolume = buildRiskEventVolumeSnapshot({
        last1h: riskEventsLast1h,
        last24h: riskEventsLast24h,
        signalTelemetryLast1h: signalTelemetryRiskEventsLast1h,
        signalTelemetryLast24h: signalTelemetryRiskEventsLast24h,
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

      // Write trading-state snapshot every 10 minutes
      const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
      if (now - lastSnapshotMs >= SNAPSHOT_INTERVAL_MS) {
        lastSnapshotMs = now;

        const sa = signalWindow;
        const tradingState = resolveTradingState({
          signalWindow: {
            produced: sa.produced,
            approved: sa.approved,
            rejected: sa.rejected,
            entryApproved: sa.entryApproved,
            exitApproved: sa.exitApproved,
          },
        });

        writeMetric(() => {
          insertSnapshot.run(
            tradingState,
            sa.produced,
            sa.approved,
            sa.rejected,
            new Date().toISOString(),
          );
          pruneSnapshots.run();
        });
      }
    } finally {
      recordStageDuration("metrics_flush_total", performance.now() - metricsFlushStartMs);
    }
  }, 30_000);

  // Memory-usage breakdown log — helps locate the source of the post-resume
  // RSS climb that has been tripping the 520 MiB cgroup OOM. Distinguishes
  // V8 heap (rss-arrayBuffers-external ~ heap) from off-heap native buffers
  // (arrayBuffers — WebSocket messages) and other external memory.
  setInterval(() => {
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
  }, 60_000).unref();

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
  const runtimeDiagnosticsTimer = setInterval(() => {
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
  }, 30_000).unref();

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

    try {
      await supervisor.stop();
    } catch (err) {
      log.error({ err }, "supervisor stop error");
    }

    signalToOrderBridge.unsubscribe();
    clearInterval(universeFunnelLogTimer);
    clearInterval(runtimeDiagnosticsTimer);
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

    if (statePublisherRef.current) {
      statePublisherRef.current.stopHeartbeatLoop();
      statePublisherRef.current.publishShutdown();
    }

    controlConn.close();
    ledgerConn.close();
    log.info("databases closed — runtime stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 10. Profile-aware preflight — runs for ALL profiles before supervisor.start()
  const startupScan = await marketScannerModule.scanOrThrow();
  log.info(startupScan, "blocking startup market scan complete");

  const startupAdoption = await runStartupPositionAdoption({
    gateway: exchangeGateway,
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
  });
  log.info(startupAdoption, "startup position adoption complete");
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
      log.fatal("live-lite relayer auth check failed — exchange returned no balances");
      controlConn.close();
      ledgerConn.close();
      process.exit(1);
    }
  }

  // 11. Start
  try {
    // Default to paused BEFORE modules run so the command-poller (first module)
    // can legitimately flip us to resumed by applying a pending cmd. Setting
    // paused=true AFTER supervisor.start() clobbered any such resume.
    setPausedAndPersist(true);

    await supervisor.start();

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
    // publishStartup hardcodes paused=1; reconcile to the supervisor's actual
    // state so a resume applied by the command-poller during start() survives
    // in runtime_control_state as well.
    if (!supervisor.isPaused()) {
      statePublisher.publishRunning();
    }
    statePublisher.startHeartbeatLoop(15_000);

    // Evaluate resume intent (read+cleared earlier, before preflight exit paths)
    const intentResult = evaluateResumeIntent({
      intentAt: intentRow?.resume_intent_at ?? null,
      nowMs: Date.now(),
      hasActiveSwitch: !!activeSwitchRow,
      desiredProfile: intentRow?.desired_profile ?? null,
      activeProfile,
    });

    if (intentResult.action === "resume") {
      log.info({ ageMs: intentResult.ageMs }, "resume intent found — auto-resuming");
      setPausedAndPersist(false);
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

    log.info({ phase: supervisor.getPhase(), paused: supervisor.isPaused() }, "runtime ready");
  } catch (err) {
    log.fatal({ err }, "runtime startup failed");
    controlConn.close();
    ledgerConn.close();
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("unhandled runtime error", err);
  process.exit(1);
});
