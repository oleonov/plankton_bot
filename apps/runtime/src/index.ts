/**
 * Plankton Runtime — composition root and entrypoint.
 *
 * Wires config, DB, family rules, event bus, supervisor, and modules.
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

import { randomUUID } from "node:crypto";
import process from "node:process";
import { loadEnv } from "@plankton/config";
import { InProcessEventBus } from "@plankton/event-bus";
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
  SelectionRuleRepository,
  SqliteRiskEventRepository,
  SqliteStateTransitionRepository,
} from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import { createBotRunId, ENTRY_REASONS, resolveTradingState } from "@plankton/domain";
import { GammaMarketDiscoveryGateway } from "@plankton/exchange";
import { createGateways } from "./gateway-factory.js";
import { LiveLiteGuard } from "./live-lite-guard.js";
import { runProfilePreflight, writePreflightReport } from "./profile-preflight.js";

import { createLogger } from "./logger.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { CommandPoller } from "./supervisor/command-poller.js";
import { MarketDataModule } from "./modules/market-data/market-data-module.js";
import { MarketScannerModule } from "./modules/market-scanner/index.js";
import { NormalizationModule } from "./modules/normalization/normalization-module.js";
import { ExecutionModule } from "./modules/execution/execution-module.js";
import { RiskInventoryModule } from "./modules/risk-inventory/risk-inventory-module.js";
import { CandidateBookCache } from "./modules/strategy/candidate-book-cache.js";
import { SignalToOrderBridge } from "./modules/strategy/signal-to-order.js";
import { AlgoDecisionModule } from "./modules/algo-decision/algo-decision-module.js";
import { MarketSelectionCache } from "./modules/algo-decision/market-selection-cache.js";
import { LegStateTrackerModule } from "./modules/leg-state/leg-state-tracker-module.js";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation-module.js";
import { ResolutionModule } from "./modules/resolution/resolution-module.js";
import { UserOrderStreamModule } from "./modules/reconciliation/user-order-stream-module.js";
import { InventoryManagerModule } from "./modules/inventory-auto-merge/inventory-manager-module.js";
import { StalePruningModule } from "./modules/pruning/stale-pruning-module.js";
import { FillPollerModule } from "./modules/fill-poller/fill-poller-module.js";
import { ResolutionDetector } from "./modules/resolution/resolution-detector.js";
import { PositionSettler } from "./modules/resolution/position-settler.js";
import { GammaResolutionClient } from "@plankton/exchange";
import {
  SqliteMarketResolutionRepository,
  SqliteMergeLedgerRepository,
  SqliteAlgoRulesRepository,
  SqliteLegStateRepository,
} from "@plankton/db";
import { SnapshotWriter } from "./snapshot-writer.js";
import { RiskEventWriter } from "./risk-event-writer.js";
import { resolveActiveProfile } from "./profile-boot.js";
import { runStartupPositionAdoption } from "./startup-position-adoption.js";
import { ProfileRuntimePublisher } from "./modules/publisher/profile-runtime-publisher.js";
import { RuntimeStatePublisher } from "./runtime-state-publisher.js";
import { evaluateResumeIntent } from "./resume-intent.js";
import { createPolymarketClient, type SettlementClientLike } from "./polymarket-client-factory.js";
import { installConsoleRedaction } from "./console-redaction.js";
import { RefreshableSelectionRuleEngine } from "./selection-rule-engine-factory.js";
import type {
  CandidateBookRefreshObserved,
  CandidateBookUsageObserved,
} from "./modules/strategy/candidate-book-cache.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const ENTRY_FILL_LATENCY_TRACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RISK_EVENT_WARNING_THRESHOLD_PER_HOUR = 1_000;
const RISK_EVENT_WARNING_COOLDOWN_MS = 10 * 60 * 1000;

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
  log.info({ mode: config.runtimeMode }, "plankton runtime starting (env mode)");

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
    marketSnapshot: new SqliteMarketSnapshotRepository(ledgerConn.db),
    riskEvent: new SqliteRiskEventRepository(ledgerConn.db),
    // Control-side
    operatorCommand: new SqliteOperatorCommandRepository(controlConn.db),
    operatorAction: new SqliteOperatorActionRepository(controlConn.db),
    stateTransition: new SqliteStateTransitionRepository(controlConn.db),
    // Algo decision engine — algoRules lives in control.db, legState in ledger.db
    algoRules: new SqliteAlgoRulesRepository(controlConn.db),
    legState: new SqliteLegStateRepository(ledgerConn.db),
  };

  // 3b. Selection rule engine — version-polled singleton for Phase 4 scanner wiring.
  // Constructed here so it is available to the module DI graph; Phase 4 plugs it
  // into the scanner and MarketSelectionCache. Not used by scanner yet (Phase 3).
  const selectionRuleRepo = new SelectionRuleRepository(controlConn.db);
  const selectionRuleEngine = new RefreshableSelectionRuleEngine(selectionRuleRepo, activeProfile);
  log.info({ version: selectionRuleRepo.getVersion() }, "selection rule engine ready");

  // Read initial balance from profile_settings (control.db) instead of YAML
  const settingsRow = controlConn.db
    .prepare(
      `SELECT initial_balance_usdc, envelope_json, wallet_mode, min_order_usdc, relayer_json
         FROM profile_settings
        WHERE profile_id = ?`,
    )
    .get(activeProfile) as
    | {
        initial_balance_usdc: number | null;
        envelope_json: string | null;
        wallet_mode: "eoa" | "relayer" | null;
        min_order_usdc: number | null;
        relayer_json: string | null;
      }
    | undefined;
  const initialBalanceUsdc = settingsRow?.initial_balance_usdc ?? 1000;

  if (runtimeMode !== "live-lite") {
    log.info({ initialBalanceUsdc, runtimeMode }, "simulated exchange balance configured");
  }

  // 6. Create event bus
  const bus = new InProcessEventBus();

  // 7. Build modules
  // supervisorRef is set before any closure that uses it is actually called
  const supervisorRef = { current: null as unknown as Supervisor };
  const statePublisherRef = { current: null as RuntimeStatePublisher | null };
  const runtimeControl = { isPaused: () => supervisorRef.current.isPaused() };

  // Persist pause state to runtime_metrics so the API can read it
  const deletePauseMetric = ledgerConn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'runtime_paused'",
  );
  const insertPauseMetric = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES ('runtime_paused', ?, ?)",
  );
  const persistPauseState = ledgerConn.db.transaction((paused: boolean) => {
    deletePauseMetric.run();
    insertPauseMetric.run(paused ? 1 : 0, new Date().toISOString());
  });

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
      };
      const polymarketClientConfig = {
        polyApiKey: config.polyApiKey,
        polyApiSecret: config.polyApiSecret,
        polyPassphrase: config.polyPassphrase,
        polyBuilderApiKey: configWithBuilder.polyBuilderApiKey,
        polyBuilderSecret: configWithBuilder.polyBuilderSecret,
        polyBuilderPassphrase: configWithBuilder.polyBuilderPassphrase,
        polyPrivateKey: config.polyPrivateKey,
        polymarketRelayerUrl:
          (config as typeof config & { polymarketRelayerUrl?: string }).polymarketRelayerUrl ??
          "https://relayer-v2.polymarket.com",
        polygonRpcUrl:
          (config as typeof config & { polygonRpcUrl?: string }).polygonRpcUrl ??
          "https://polygon-rpc.com",
        polygonRpcFallbackUrl: (config as typeof config & { polygonRpcFallbackUrl?: string })
          .polygonRpcFallbackUrl,
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

  const recordInfraAlert = (alert: {
    code: string;
    severity: "warning" | "error";
    source: string;
    message: string;
    details?: Record<string, unknown> | undefined;
  }): void => {
    const now = new Date().toISOString();
    ledgerConn.db
      .prepare(
        "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('infra_alert', 1, ?, ?)",
      )
      .run(JSON.stringify(alert), now);
    log.warn({ alert }, "runtime infra alert recorded");
  };

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

  // 7d. Market scanner (discovery via Gamma API)
  // TODO: pass tagId for server-side narrowing once we have a category→tagId mapping.
  // Without it, discovery broad-crawls all active Gamma markets then filters locally.
  const discoveryGateway = new GammaMarketDiscoveryGateway();
  const marketScannerModule = new MarketScannerModule({
    discoveryGateway,
    marketRepo: repos.market,
    bus,
    log,
    scanIntervalMs: 5 * 60 * 1000,
    selectionRuleEngine,
    positionRepo: repos.position,
    orderRepo: repos.order,
  });

  // 7e. Real modules for market-data and normalization
  const marketDataModule = new MarketDataModule({
    gateway: marketDataGateway,
    marketRepo: repos.market,
    bus,
    log,
    pollIntervalMs: config.marketDataPollIntervalMs,
    staleThresholdMs: config.marketDataStaleThresholdMs,
    botRunId: String(botRunId),
  });

  const normalizationModule = new NormalizationModule({
    bus,
    marketRepo: repos.market,
    log,
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
    activeProfile: activeProfile as import("@plankton/domain").ProfileId,
  });

  // 7f. Execution module

  // Persist two-part mode for API/web consumption
  const upsertModeMetric = ledgerConn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, 1, ?, ?)",
  );
  const modeNow = new Date().toISOString();
  upsertModeMetric.run("market_data_source", JSON.stringify({ value: marketDataSource }), modeNow);
  upsertModeMetric.run("execution_mode", JSON.stringify({ value: executionMode }), modeNow);

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
    controlDb: controlConn.db,
    activeProfile: activeProfile as import("@plankton/domain").ProfileId,
  });

  // 7g. Risk + Inventory module
  const riskInventoryModule = new RiskInventoryModule({
    bus,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    log,
    db: ledgerConn.db,
    liveLiteGuard,
  });

  // 7h. Strategy module
  const candidateBookRefreshWindow = {
    attempts: 0,
    timeouts: 0,
    lastReset: Date.now(),
  };
  const candidateBookUsageWindow = {
    bridgeRefreshLatenciesMs: [] as number[],
    bridgeRestBookFetchCount: 0,
  };
  const handleCandidateBookRefreshObserved = (event: CandidateBookRefreshObserved): void => {
    if (event.outcome === "attempted") {
      candidateBookRefreshWindow.attempts += event.tokenCount;
      if (event.source === "bridge-refresh") {
        candidateBookUsageWindow.bridgeRestBookFetchCount += event.tokenCount;
        conversionWindow.bridgeRestBookFetchCount += event.tokenCount;
      }
    }
    if (event.outcome === "refresh-budget-exhausted" || event.outcome === "refresh-failed") {
      candidateBookRefreshWindow.timeouts += event.tokenCount;
    }
    if (event.source === "bridge-refresh" && event.durationMs != null) {
      candidateBookUsageWindow.bridgeRefreshLatenciesMs.push(event.durationMs);
      conversionWindow.bridgeBookRefreshLatenciesMs.push(event.durationMs);
    }
  };
  const handleCandidateBookUsageObserved = (event: CandidateBookUsageObserved): void => {
    if (event.type === "ws-hit") {
      conversionWindow.candidateBookCacheWsHits++;
      return;
    }
    conversionWindow.candidateBookCacheRestFallbacks++;
  };
  const candidateBookCache = marketDataGateway.getOrderBooks
    ? new CandidateBookCache({
        gateway: { getOrderBooks: marketDataGateway.getOrderBooks.bind(marketDataGateway) },
        log: log.child({ module: "candidate-book-cache" }),
        onRefreshObserved: handleCandidateBookRefreshObserved,
        onUsageObserved: handleCandidateBookUsageObserved,
      })
    : undefined;
  // 7h1. Leg state tracker — maintains leg_states from fills/positions/settlements.
  // Must start before AlgoDecisionModule so leg states are populated when decisions run.
  const legStateTrackerModule = new LegStateTrackerModule({
    bus,
    legStateRepo: repos.legState,
    log,
  });

  // 7h2. Algo decision module (replaces legacy StrategyModule in the pipeline)
  const selectedMarketCache = new MarketSelectionCache(bus, selectionRuleEngine);
  selectedMarketCache.subscribe();
  const algoDecisionModule = new AlgoDecisionModule({
    bus,
    legStateRepo: repos.legState,
    algoRulesRepo: repos.algoRules,
    selectedMarketCache,
    runtimeControl,
    log,
    sweepIntervalMs: 12_000,
  });

  // Standalone SignalToOrderBridge — wired here so it is active when AlgoDecisionModule
  // is used. bridge.subscribe() is called after all modules are wired (below).
  const signalToOrderBridge = new SignalToOrderBridge({
    bus,
    log,
    orderRepo: repos.order,
    liveLiteGuard,
    candidateBookCache,
  });

  // 7i. Reconciliation module
  const reconciliationModule = new ReconciliationModule({
    gateway: exchangeGateway,
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    marketRepo: repos.market,
    log,
    reconcileIntervalMs: 60_000,
  });

  const userOrderStreamModule =
    runtimeMode === "live-lite"
      ? new UserOrderStreamModule({
          gateway: exchangeGateway,
          bus,
          marketRepo: repos.market,
          orderRepo: repos.order,
          fillRepo: repos.fill,
          log,
        })
      : null;

  // 7j. Resolution module — detect resolved markets, settle positions
  const marketResolutionRepo = new SqliteMarketResolutionRepository(ledgerConn.db);
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
    gammaClient: gammaResolutionClient,
    lotRepo: repos.inventoryLot,
    positionRepo: repos.position,
    db: ledgerConn.db,
    bus,
    log,
    checkIntervalMs: 5 * 60_000, // 5 minutes
    graceMinutes: 30,
    // In live-lite mode, provide the exchange gateway so the resolution module
    // verifies on-chain token balance is 0 before settling in the ledger.
    // In simulation/paper modes, no gateway is needed (no on-chain state).
    ...(runtimeMode === "live-lite" && exchangeGateway ? { gateway: exchangeGateway } : {}),
  });

  // 7k. Stale tail pruning module
  const stalePruningModule = new StalePruningModule({
    positionRepo: repos.position,
    marketRepo: repos.market,
    bus,
    log,
    checkIntervalMs: 10 * 60_000, // 10 minutes
  });

  // 7k2. Inventory Auto-Merge (P3-1)
  const inventoryManagerModule = new InventoryManagerModule({
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
  });

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

  const modules: Array<[string, import("@plankton/domain").RuntimeModule]> = [
    ["command-poller", commandPoller],
    ["market-scanner", marketScannerModule],
    ["market-data", marketDataModule],
    ["normalization", normalizationModule],
    ["risk-inventory", riskInventoryModule],
    ["profile-publisher", profilePublisher],
    ["reconciliation", reconciliationModule],
    ...(userOrderStreamModule
      ? [
          ["user-order-stream", userOrderStreamModule] as [
            string,
            import("@plankton/domain").RuntimeModule,
          ],
        ]
      : []),
    ["leg-state-tracker", legStateTrackerModule],
    ["algo-decision", algoDecisionModule],
    ["resolution", resolutionModule],
    ["stale-pruning", stalePruningModule],
    ["inventory-manager", inventoryManagerModule],
    ...(fillPollerModule
      ? [["fill-poller", fillPollerModule] as [string, import("@plankton/domain").RuntimeModule]]
      : []),
    ["execution", executionModule],
  ];

  // 7m. Persist key timestamps to runtime_metrics for API consumption
  const upsertMetric = ledgerConn.db.prepare(`
    INSERT INTO runtime_metrics (metric_name, value, captured_at)
    VALUES (?, 1, ?)
  `);

  bus.subscribe("ReconciliationDriftDetected", async () => {
    upsertMetric.run("reconciliation_drift", new Date().toISOString());
  });

  bus.subscribe("ReconciliationComplete", async ({ result }) => {
    upsertMetric.run("last_reconciliation", new Date(result.ranAt).toISOString());
    if (result.clean) {
      upsertMetric.run("reconciliation_clean", new Date(result.ranAt).toISOString());
    }
  });

  bus.subscribe("MarketSnapshotReceived", async ({ timestamp }) => {
    upsertMetric.run("market_data_last_update", new Date(timestamp).toISOString());
  });

  // 7n. Persist downsampled market snapshots (5-min per token, 7-day TTL)
  const snapshotWriter = new SnapshotWriter(repos.marketSnapshot, {
    intervalMs: 5 * 60 * 1000,
    pruneIntervalMs: 60 * 60 * 1000,
    pruneTtlMs: 7 * 24 * 60 * 60 * 1000,
  });

  bus.subscribe("MarketSnapshotReceived", async ({ markets, timestamp }) => {
    snapshotWriter.onSnapshot(markets, timestamp);
  });

  // 7o. Persist risk events — deduplicated signal rejections, operator commands, drift
  const riskEventWriter = new RiskEventWriter(repos.riskEvent, {
    rejectCooldownMs: 15 * 60 * 1000,
  });

  bus.subscribe("SignalRejected", async ({ signal, reason, rejectedAt }) => {
    riskEventWriter.onSignalRejected(signal, reason, rejectedAt);
  });

  bus.subscribe("OperatorCommandApplied", async (ev) => {
    riskEventWriter.onOperatorCommand(ev.action, null, ev.commandDbId, ev.reason, ev.initiatorType);
  });

  bus.subscribe("ReconciliationDriftDetected", async ({ details, severity, timestamp }) => {
    riskEventWriter.onReconciliationDrift(details, severity, timestamp);
  });

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
    marketabilityRejectedByReason: new Map<string, number>(),
    cacheStatusByStatus: new Map<string, number>(),
    exchangeAccepted: 0,
    exchangeRejectedByCode: new Map<string, number>(),
    fills: 0,
    fillLatencySamplesMs: [] as number[],
    cooldownBypassByReason: new Map<string, number>(),
    hotQuoteRefreshes: 0,
    hotLaneActionsByType: new Map<string, number>(),
    hotLaneStatesByState: new Map<string, number>(),
    queueJumpAccepted: 0,
    queueJumpFills: 0,
    gammaFallbackDustOrders: 0,
    gammaFallbackDustFills: 0,
    candidateBookCacheWsHits: 0,
    candidateBookCacheRestFallbacks: 0,
    bridgeBookRefreshLatenciesMs: [] as number[],
    bridgeRestBookFetchCount: 0,
    lastReset: Date.now(),
  };
  const entryOrderPlacedAtMsByOrderId = new Map<string, number>();
  const gammaFallbackDustClientOrderIds = new Set<string>();

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
      conversionWindow.marketabilityRejectedByReason.set(
        reason,
        (conversionWindow.marketabilityRejectedByReason.get(reason) ?? 0) + 1,
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
    const marketData =
      command.metadata?.["marketData"] &&
      typeof command.metadata["marketData"] === "object" &&
      command.metadata["marketData"] != null
        ? (command.metadata["marketData"] as Record<string, unknown>)
        : null;
    if (marketData?.["gammaFallbackDust"] === true) {
      conversionWindow.gammaFallbackDustOrders++;
      gammaFallbackDustClientOrderIds.add(String(command.clientOrderId));
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

  bus.subscribe("OrderRejected", async ({ errorCode, signalReason }) => {
    if (!ENTRY_REASONS.has(signalReason ?? "")) return;
    const code = String(errorCode ?? "UNKNOWN");
    conversionWindow.exchangeRejectedByCode.set(
      code,
      (conversionWindow.exchangeRejectedByCode.get(code) ?? 0) + 1,
    );
  });

  bus.subscribe("FillReceived", async ({ signalReason }) => {
    if (ENTRY_REASONS.has(signalReason ?? "")) {
      conversionWindow.fills++;
    }
  });

  bus.subscribe("FillReceived", async ({ clientOrderId }) => {
    if (!gammaFallbackDustClientOrderIds.has(String(clientOrderId))) return;
    conversionWindow.gammaFallbackDustFills++;
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

  bus.subscribe("OrderCancelled", async ({ orderId, signalReason }) => {
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
    gammaFallbackDustSignalsProduced: 0,
    scanPrimeSkippedByPolicy: 0,
    lastReset: Date.now(),
  };

  bus.subscribe("ScanTickCompleted", async (ev) => {
    scannerWindow.candidatesConsidered += ev.candidatesConsidered;
    scannerWindow.blockedByResolutionBuffer += ev.blockedByResolutionBuffer;
    scannerWindow.blockedByWindow += ev.blockedByWindow;
    scannerWindow.gammaFallbackDustSignalsProduced += ev.gammaFallbackDustSignalsProduced;
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
      conversionWindow.marketabilityRejectedByReason.clear();
      conversionWindow.cacheStatusByStatus.clear();
      conversionWindow.exchangeAccepted = 0;
      conversionWindow.exchangeRejectedByCode.clear();
      conversionWindow.fills = 0;
      conversionWindow.fillLatencySamplesMs = [];
      conversionWindow.cooldownBypassByReason.clear();
      conversionWindow.hotQuoteRefreshes = 0;
      conversionWindow.hotLaneActionsByType.clear();
      conversionWindow.hotLaneStatesByState.clear();
      conversionWindow.queueJumpAccepted = 0;
      conversionWindow.queueJumpFills = 0;
      conversionWindow.gammaFallbackDustOrders = 0;
      conversionWindow.gammaFallbackDustFills = 0;
      conversionWindow.candidateBookCacheWsHits = 0;
      conversionWindow.candidateBookCacheRestFallbacks = 0;
      conversionWindow.bridgeBookRefreshLatenciesMs = [];
      conversionWindow.bridgeRestBookFetchCount = 0;
      gammaFallbackDustClientOrderIds.clear();
      candidateBookRefreshWindow.attempts = 0;
      candidateBookRefreshWindow.timeouts = 0;
      candidateBookRefreshWindow.lastReset = now;
      conversionWindow.lastReset = now;
    }
    pruneEntryFillLatencyTracker(entryOrderPlacedAtMsByOrderId, now);
    upsertSignalActivity(
      JSON.stringify({
        produced: signalWindow.produced,
        approved: signalWindow.approved,
        rejected: signalWindow.rejected,
        entryApproved: signalWindow.entryApproved,
        exitApproved: signalWindow.exitApproved,
        windowStartMs: signalWindow.lastReset,
      }),
      new Date().toISOString(),
    );
    upsertSignalConversionActivity(
      JSON.stringify({
        converted: conversionWindow.converted,
        marketabilityRejectedByReason: Object.fromEntries(
          conversionWindow.marketabilityRejectedByReason,
        ),
        cacheStatusByStatus: Object.fromEntries(conversionWindow.cacheStatusByStatus),
        exchangeAccepted: conversionWindow.exchangeAccepted,
        exchangeRejectedByCode: Object.fromEntries(conversionWindow.exchangeRejectedByCode),
        fills: conversionWindow.fills,
        fillLatencyMs: summarizeFillLatency(conversionWindow.fillLatencySamplesMs),
        cooldownBypassByReason: Object.fromEntries(conversionWindow.cooldownBypassByReason),
        hotQuoteRefreshes: conversionWindow.hotQuoteRefreshes,
        hotLaneActionsByType: Object.fromEntries(conversionWindow.hotLaneActionsByType),
        hotLaneStatesByState: Object.fromEntries(conversionWindow.hotLaneStatesByState),
        queueJumpAccepted: conversionWindow.queueJumpAccepted,
        queueJumpFills: conversionWindow.queueJumpFills,
        gammaFallbackDustOrders: conversionWindow.gammaFallbackDustOrders,
        gammaFallbackDustFills: conversionWindow.gammaFallbackDustFills,
        candidateBookCacheWsHits: conversionWindow.candidateBookCacheWsHits,
        candidateBookCacheRestFallbacks: conversionWindow.candidateBookCacheRestFallbacks,
        bridgeBookRefreshMs: summarizeFillLatency(conversionWindow.bridgeBookRefreshLatenciesMs),
        bridgeRestBookFetchCount: conversionWindow.bridgeRestBookFetchCount,
        candidateBookRefreshAttempts: candidateBookRefreshWindow.attempts,
        candidateBookRefreshTimeouts: candidateBookRefreshWindow.timeouts,
        windowStartMs: conversionWindow.lastReset,
      }),
      new Date().toISOString(),
    );
    const riskEventsLast1h = repos.riskEvent.countSince(
      new Date(now - 60 * 60 * 1000).toISOString(),
    );
    const riskEventsLast24h = repos.riskEvent.countSince(
      new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    );
    const riskEventWarning = riskEventsLast1h >= RISK_EVENT_WARNING_THRESHOLD_PER_HOUR;
    upsertRiskEventVolume(
      JSON.stringify({
        last1h: riskEventsLast1h,
        last24h: riskEventsLast24h,
        warning: riskEventWarning,
        thresholdPerHour: RISK_EVENT_WARNING_THRESHOLD_PER_HOUR,
        windowStartMs: now - 24 * 60 * 60 * 1000,
      }),
      new Date().toISOString(),
    );
    if (
      riskEventWarning &&
      now - lastRiskEventVolumeWarningAtMs >= RISK_EVENT_WARNING_COOLDOWN_MS
    ) {
      lastRiskEventVolumeWarningAtMs = now;
      log.warn(
        {
          riskEventsLast1h,
          riskEventsLast24h,
          thresholdPerHour: RISK_EVENT_WARNING_THRESHOLD_PER_HOUR,
        },
        "risk_events growth threshold exceeded",
      );
    }
    if (userOrderStreamModule) {
      upsertUserOrderStreamActivity(
        JSON.stringify(userOrderStreamModule.getMetricsSnapshot()),
        new Date().toISOString(),
      );
    }
    upsertMarketDataStreamActivity(
      JSON.stringify({
        ...marketDataModule.getMetricsSnapshot(),
        ...marketScannerModule.getHintMetricsSnapshot(),
        ...resolutionModule.getHintMetricsSnapshot(),
      }),
      new Date().toISOString(),
    );
    // Reset scanner window on same schedule as signal window
    if (now - scannerWindow.lastReset > SIGNAL_WINDOW_MS) {
      scannerWindow.candidatesConsidered = 0;
      scannerWindow.blockedByResolutionBuffer = 0;
      scannerWindow.blockedByWindow = 0;
      scannerWindow.gammaFallbackDustSignalsProduced = 0;
      scannerWindow.scanPrimeSkippedByPolicy = 0;
      scannerWindow.lastReset = now;
    }
    deleteScanner.run();
    insertScanner.run(
      JSON.stringify({
        candidatesConsidered: scannerWindow.candidatesConsidered,
        blockedByResolutionBuffer: scannerWindow.blockedByResolutionBuffer,
        blockedByWindow: scannerWindow.blockedByWindow,
        gammaFallbackDustSignalsProduced: scannerWindow.gammaFallbackDustSignalsProduced,
        scanPrimeSkippedByPolicy: scannerWindow.scanPrimeSkippedByPolicy,
      }),
      new Date().toISOString(),
    );
    deleteExecutionQueue.run();
    insertExecutionQueue.run(
      JSON.stringify(executionModule.getDiagnostics()),
      new Date().toISOString(),
    );

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

      insertSnapshot.run(
        tradingState,
        sa.produced,
        sa.approved,
        sa.rejected,
        new Date().toISOString(),
      );
      pruneSnapshots.run();
    }
  }, 30_000);

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
    selectedMarketCache.dispose();

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
    ledgerConn.db
      .prepare(
        "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, 1, ?, ?)",
      )
      .run("live_lite_envelope", JSON.stringify(liveLiteStatus), new Date().toISOString());
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
    await supervisor.start();

    // Start paused, then check for deploy resume intent
    setPausedAndPersist(true);

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
