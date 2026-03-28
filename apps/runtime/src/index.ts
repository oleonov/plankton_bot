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

import process from "node:process";
import { loadEnv, loadFamilyRulesYaml, type LoadedFamilyRules } from "@plankton/config";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  bootstrapDatabase,
  SqliteMarketRepository,
  SqliteOrderRepository,
  SqliteFillRepository,
  SqlitePositionRepository,
  SqliteInventoryLotRepository,
  SqliteFamilyStateRepository,
  SqliteFamilyCatalogRepository,
  SqliteOperatorCommandRepository,
  SqliteOperatorActionRepository,
  SqliteMarketSnapshotRepository,
  SqliteRiskEventRepository,
  SqliteFamilyCandidateRepository,
  SqliteFamilyEvidenceRepository,
  SqliteFamilyRulesSnapshotRepository,
  SqliteStateTransitionRepository,
  SqlitePromotionProposalRepository,
  SqliteCandidateObservationRepository,
  SqliteFamilyRulesDbRepository,
} from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { FamilyIdentity, FamilyState, FamilyRulesProvider } from "@plankton/domain";
import { createBotRunId, slugPatternToRegex, ENTRY_REASONS } from "@plankton/domain";
import { migrateOrphanedPositions } from "./universe-migration.js";
import { GammaMarketDiscoveryGateway } from "@plankton/exchange";
import { createGateways } from "./gateway-factory.js";
import { LiveLiteGuard } from "./live-lite-guard.js";
import { liveLitePreflight } from "./live-lite-preflight.js";

import { createLogger } from "./logger.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { CommandPoller } from "./supervisor/command-poller.js";
import { MarketDataModule } from "./modules/market-data/market-data-module.js";
import { MarketScannerModule } from "./modules/market-scanner/index.js";
import { NormalizationModule } from "./modules/normalization/normalization-module.js";
import { ExecutionModule } from "./modules/execution/execution-module.js";
import { RiskInventoryModule } from "./modules/risk-inventory/risk-inventory-module.js";
import { StrategyModule } from "./modules/strategy/strategy-module.js";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation-module.js";
import { ResolutionModule } from "./modules/resolution/resolution-module.js";
import { StalePruningModule } from "./modules/pruning/stale-pruning-module.js";
import { FillPollerModule } from "./modules/fill-poller/fill-poller-module.js";
import { ResolutionDetector } from "./modules/resolution/resolution-detector.js";
import { PositionSettler } from "./modules/resolution/position-settler.js";
import { FamilyExposureCalculator } from "./modules/risk-inventory/family-exposure.js";
import { GammaResolutionClient } from "@plankton/exchange";
import { SqliteMarketResolutionRepository } from "@plankton/db";
import { SnapshotWriter } from "./snapshot-writer.js";
import { RiskEventWriter } from "./risk-event-writer.js";
import { ReloadableFamilyRulesManager } from "./family-rules-manager.js";
import { FamilyEvidenceEngine } from "./modules/evidence/evidence-engine.js";
import { ScoreComputer } from "./modules/evidence/score-computer.js";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Load config
  const config = loadEnv();
  const log = createLogger(config.logLevel, config.runtimeMode);
  log.info({ mode: config.runtimeMode }, "plankton runtime starting");

  // 2. Bootstrap DB
  let conn: DbConnection;
  try {
    conn = bootstrapDatabase(config.dbPath);
    log.info({ path: config.dbPath }, "database ready");
  } catch (err) {
    log.fatal({ err, path: config.dbPath }, "database bootstrap failed");
    process.exit(1);
  }

  // 3. Create repositories
  const repos = {
    market: new SqliteMarketRepository(conn.db),
    order: new SqliteOrderRepository(conn.db),
    fill: new SqliteFillRepository(conn.db),
    position: new SqlitePositionRepository(conn.db),
    inventoryLot: new SqliteInventoryLotRepository(conn.db),
    familyState: new SqliteFamilyStateRepository(conn.db),
    familyCatalog: new SqliteFamilyCatalogRepository(conn.db),
    operatorCommand: new SqliteOperatorCommandRepository(conn.db),
    operatorAction: new SqliteOperatorActionRepository(conn.db),
    marketSnapshot: new SqliteMarketSnapshotRepository(conn.db),
    riskEvent: new SqliteRiskEventRepository(conn.db),
    familyCandidate: new SqliteFamilyCandidateRepository(conn.db),
    familyEvidence: new SqliteFamilyEvidenceRepository(conn.db),
    familyRulesSnapshot: new SqliteFamilyRulesSnapshotRepository(conn.db),
    stateTransition: new SqliteStateTransitionRepository(conn.db),
    promotionProposal: new SqlitePromotionProposalRepository(conn.db),
    candidateObservation: new SqliteCandidateObservationRepository(conn.db),
  };

  // 4. Load family rules (YAML + DB merge via ReloadableFamilyRulesManager)
  let families: FamilyIdentity[];
  let rulesProvider: FamilyRulesProvider;
  let rulesManager: ReloadableFamilyRulesManager;
  let loaded: LoadedFamilyRules;
  const dbRulesReader = new SqliteFamilyRulesDbRepository(conn.db);
  try {
    loaded = loadFamilyRulesYaml(config.familyRulesPath);
    rulesManager = new ReloadableFamilyRulesManager(loaded.families, dbRulesReader);
    rulesProvider = rulesManager;
    families = rulesProvider.getAllFamilies();
    log.info({ count: families.length }, "family rules loaded");
    if (config.runtimeMode !== "live-lite") {
      log.info(
        { initialBalanceUsdc: loaded.global.initialBalanceUsdc, runtimeMode: config.runtimeMode },
        "simulated exchange balance configured",
      );
    }
  } catch (err) {
    log.fatal({ err, path: config.familyRulesPath }, "family rules load failed");
    conn.close();
    process.exit(1);
  }

  // 5. Seed family catalog + ensure baseline runtime state
  repos.familyCatalog.upsertAll(families);
  log.info({ count: families.length }, "family catalog seeded");

  for (const identity of families) {
    const existing = repos.familyState.get(identity.familyId);
    if (!existing) {
      const baseline: FamilyState = {
        familyId: identity.familyId,
        runtimeMode: "active",
        openValueUsdc: 0,
        openPositionCount: 0,
        openDustCount: 0,
        activeMarketCount: 0,
        currentTailCostUsdc: 0,
        tailAdjustedPnlLive: 0,
        lastEntryTs: null,
        lastExitTs: null,
        quarantineReason: null,
        effectiveMode: null,
        derivedModeReason: null,
        updatedAt: new Date().toISOString(),
      };
      repos.familyState.save(baseline);
    }
  }
  log.info("family runtime state baseline ensured");

  // 5b. Seed family rules (caps) for API consumption
  const upsertFamilyRules = conn.db.prepare(`
    INSERT INTO family_rules (family_id, max_open_value_usdc, max_active_markets, max_dust_positions,
      enabled, action, priority_rank, entry_mode, max_initial_notional_usdc,
      tail_quarantine_threshold_usdc, tail_quarantine_threshold_ratio, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(family_id) DO UPDATE SET
      max_open_value_usdc = excluded.max_open_value_usdc,
      max_active_markets = excluded.max_active_markets,
      max_dust_positions = excluded.max_dust_positions,
      enabled = excluded.enabled,
      action = excluded.action,
      priority_rank = excluded.priority_rank,
      entry_mode = excluded.entry_mode,
      max_initial_notional_usdc = excluded.max_initial_notional_usdc,
      tail_quarantine_threshold_usdc = excluded.tail_quarantine_threshold_usdc,
      tail_quarantine_threshold_ratio = excluded.tail_quarantine_threshold_ratio,
      updated_at = excluded.updated_at
  `);

  for (const identity of families) {
    const bundle = rulesProvider.getRule(identity.familyId);
    if (!bundle) continue;
    const ts = bundle.rules.tailSuppression;
    const uni = bundle.rules.universe;
    const entry = bundle.rules.entry;
    upsertFamilyRules.run(
      String(identity.familyId),
      ts.maxOpenValueUsdc,
      ts.maxActiveMarkets,
      ts.maxDustPositions,
      uni.enabled ? 1 : 0,
      uni.action,
      uni.priorityRank,
      entry.entryMode,
      entry.maxInitialNotionalUsdc,
      ts.tailQuarantineThresholdUsdc,
      ts.tailQuarantineThresholdRatio,
      new Date().toISOString(),
    );
  }
  log.info({ count: families.length }, "family rules seeded");

  // 5.5. Migrate orphaned positions — close positions whose market no longer
  // matches the family's current slug pattern or horizon filter. Without this,
  // stale positions from a previous universe (e.g. will-bitcoin-reach-*) would
  // permanently consume family caps and block new entries.
  const migration = migrateOrphanedPositions({
    positionRepo: repos.position,
    marketRepo: repos.market,
    lotRepo: repos.inventoryLot,
    families,
    log,
  });
  if (migration.closedCount > 0) {
    log.info(
      { closedCount: migration.closedCount },
      "universe migration closed orphaned positions",
    );
  }

  // 6. Create event bus
  const bus = new InProcessEventBus();

  // 7. Build modules
  // supervisorRef is set before any closure that uses it is actually called
  const supervisorRef = { current: null as unknown as Supervisor };
  const runtimeControl = { isPaused: () => supervisorRef.current.isPaused() };

  // Persist pause state to runtime_metrics so the API can read it
  const deletePauseMetric = conn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'runtime_paused'",
  );
  const insertPauseMetric = conn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES ('runtime_paused', ?, ?)",
  );
  const persistPauseState = conn.db.transaction((paused: boolean) => {
    deletePauseMetric.run();
    insertPauseMetric.run(paused ? 1 : 0, new Date().toISOString());
  });

  function setPausedAndPersist(paused: boolean): void {
    supervisorRef.current.setPaused(paused);
    persistPauseState(paused);
  }

  // 7b. Create gateways via factory
  let polyClient: unknown;
  if (config.runtimeMode === "paper" || config.runtimeMode === "live-lite") {
    const { ClobClient } = await import("@polymarket/clob-client");
    const CLOB_HOST = "https://clob.polymarket.com";
    const POLYGON_CHAIN_ID = 137;

    if (config.runtimeMode === "paper") {
      polyClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID);
    } else {
      const { Wallet } = await import("ethers");
      const signer = new Wallet(config.polyPrivateKey!);
      polyClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, signer, {
        key: config.polyApiKey!,
        secret: config.polyApiSecret!,
        passphrase: config.polyPassphrase!,
      });
    }
  }

  // Build slug filter dynamically from rules manager so new families added via
  // rules_reload are picked up without restart.
  const slugFilter = (slug: string): boolean => {
    const currentFamilies = rulesManager.getAllFamilies();
    return currentFamilies.some((f) => {
      if (!f.slugPattern) return false;
      try {
        return slugPatternToRegex(f.slugPattern).test(slug);
      } catch {
        return false;
      }
    });
  };

  const { marketDataGateway, exchangeGateway, modeLabel, marketDataSource, executionMode } =
    createGateways({
      runtimeMode: config.runtimeMode,
      polyClient,
      slugFilter,
      initialBalanceUsdc: loaded.global.initialBalanceUsdc,
    });
  log.info({ mode: modeLabel }, "gateways created");

  const liveLiteGuard = new LiveLiteGuard(config.liveLite);

  // 7c. Create bot run ID (needed by market-data and execution modules)
  const botRunId = createBotRunId(`run-${Date.now()}`);

  // Record this run in bot_runs for API consumption
  conn.db
    .prepare("INSERT INTO bot_runs (run_id, mode, started_at) VALUES (?, ?, ?)")
    .run(botRunId, config.runtimeMode, new Date().toISOString());
  log.info({ botRunId, mode: config.runtimeMode }, "bot run recorded");

  // 7d. Market scanner (discovery via Gamma API)
  // TODO: pass tagId for server-side narrowing once we have a category→tagId mapping.
  // Without it, discovery broad-crawls all active Gamma markets then filters locally.
  const discoveryGateway = new GammaMarketDiscoveryGateway();
  const marketScannerModule = new MarketScannerModule({
    discoveryGateway,
    familyRules: rulesProvider,
    marketRepo: repos.market,
    bus,
    log,
    scanIntervalMs: 5 * 60 * 1000,
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
    rulesProvider,
    marketRepo: repos.market,
    log,
  });

  // 7e2. Command poller (created here so normalizationModule is available)
  const commandPoller = new CommandPoller({
    commandRepo: repos.operatorCommand,
    actionRepo: repos.operatorAction,
    familyStateRepo: repos.familyState,
    bus,
    log,
    getPaused: () => supervisorRef.current.isPaused(),
    setPaused: setPausedAndPersist,
    pollIntervalMs: 5_000,
    rulesManager,
    normalizationModule,
    familyEvidenceRepo: repos.familyEvidence,
    familyRulesSnapshotRepo: repos.familyRulesSnapshot,
    familyCandidateRepo: repos.familyCandidate,
    stateTransitionRepo: repos.stateTransition,
    familyRulesDbWriter: dbRulesReader,
  });

  // 7f. Execution module

  // Persist two-part mode for API/web consumption
  const upsertModeMetric = conn.db.prepare(
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
    log,
    botRunId,
    runtimeControl,
    liveLiteGuard,
    runtimeMode: config.runtimeMode,
    maxConcurrency: config.executionMaxConcurrency,
  });

  // 7g. Risk + Inventory module
  const riskInventoryModule = new RiskInventoryModule({
    bus,
    rulesProvider,
    familyStateRepo: repos.familyState,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    log,
    db: conn.db,
    liveLiteGuard,
  });

  // 7h. Strategy module
  const strategyModule = new StrategyModule({
    bus,
    rulesProvider,
    positionRepo: repos.position,
    familyStateRepo: repos.familyState,
    log,
    scanIntervalMs: config.strategyScanIntervalMs,
    runtimeControl,
    liveLiteGuard,
  });

  // 7i. Reconciliation module
  const reconciliationModule = new ReconciliationModule({
    gateway: exchangeGateway,
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    log,
    reconcileIntervalMs: 60_000,
  });

  // 7j. Resolution module — detect resolved markets, settle positions
  const marketResolutionRepo = new SqliteMarketResolutionRepository(conn.db);
  const gammaResolutionClient = new GammaResolutionClient();
  const exposureCalculator = new FamilyExposureCalculator(
    repos.familyState,
    repos.position,
    repos.inventoryLot,
    log,
    rulesProvider,
  );

  // Recompute family state after universe migration — the migration only patches
  // position status, doesn't recompute tail cost or tail-adjusted PnL. Recomputing
  // all families is cheap at startup and ensures no stale state persists.
  if (migration.closedCount > 0) {
    for (const fam of families) {
      exposureCalculator.recompute(fam.familyId, false);
    }
    log.info({ families: families.length }, "family state recomputed after universe migration");
  }

  const resolutionDetector = new ResolutionDetector(
    repos.position,
    repos.market,
    marketResolutionRepo,
    gammaResolutionClient,
    log,
  );
  const positionSettler = new PositionSettler(repos.position, repos.inventoryLot, conn.db);
  const resolutionModule = new ResolutionModule({
    detector: resolutionDetector,
    settler: positionSettler,
    marketRepo: repos.market,
    resolutionRepo: marketResolutionRepo,
    orderRepo: repos.order,
    rulesProvider,
    exposureCalculator,
    gammaClient: gammaResolutionClient,
    lotRepo: repos.inventoryLot,
    positionRepo: repos.position,
    db: conn.db,
    bus,
    log,
    checkIntervalMs: 5 * 60_000, // 5 minutes
    graceMinutes: 30,
    // In live-lite mode, provide the exchange gateway so the resolution module
    // verifies on-chain token balance is 0 before settling in the ledger.
    // In simulation/paper modes, no gateway is needed (no on-chain state).
    ...(config.runtimeMode === "live-lite" && exchangeGateway ? { gateway: exchangeGateway } : {}),
  });

  // 7k. Stale tail pruning module
  const stalePruningModule = new StalePruningModule({
    positionRepo: repos.position,
    marketRepo: repos.market,
    rulesProvider,
    bus,
    log,
    checkIntervalMs: 10 * 60_000, // 10 minutes
  });

  // 7l. Fill poller module — fast-interval fill detection (paper/live-lite only;
  // simulation mode uses inline checkForFills after each placement)
  const fillPollerModule =
    config.runtimeMode !== "simulation"
      ? new FillPollerModule({
          gateway: exchangeGateway,
          fillRepo: repos.fill,
          orderRepo: repos.order,
          bus,
          log,
          pollIntervalMs: config.fillPollIntervalMs,
          overlapMs: 5_000,
        })
      : null;

  // 7l2. Family evidence engine — periodic scoring for discovery candidates
  const scoreComputer = new ScoreComputer(conn.db);
  const evidenceEngine = new FamilyEvidenceEngine({
    bus,
    log,
    scoreComputer,
    candidateRepo: repos.familyCandidate,
    evidenceRepo: repos.familyEvidence,
    proposalRepo: repos.promotionProposal,
    commandRepo: repos.operatorCommand,
    stateTransitionRepo: repos.stateTransition,
    familyStateRepo: repos.familyState,
    rulesProvider: rulesManager,
  });

  const modules: Array<[string, import("@plankton/domain").RuntimeModule]> = [
    ["command-poller", commandPoller],
    ["market-scanner", marketScannerModule],
    ["market-data", marketDataModule],
    ["normalization", normalizationModule],
    ["risk-inventory", riskInventoryModule],
    ["evidence-engine", evidenceEngine],
    ["reconciliation", reconciliationModule],
    ["strategy", strategyModule],
    ["resolution", resolutionModule],
    ["stale-pruning", stalePruningModule],
    ...(fillPollerModule
      ? [["fill-poller", fillPollerModule] as [string, import("@plankton/domain").RuntimeModule]]
      : []),
    ["execution", executionModule],
  ];

  // 7m. Persist key timestamps to runtime_metrics for API consumption
  const upsertMetric = conn.db.prepare(`
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
    riskEventWriter.onOperatorCommand(ev.action, ev.targetFamilyId, ev.commandDbId, ev.reason);
  });

  bus.subscribe("ReconciliationDriftDetected", async ({ details, severity, timestamp }) => {
    riskEventWriter.onReconciliationDrift(details, severity, timestamp);
  });

  const deletePollProgress = conn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'market_data_poll_progress'",
  );
  const insertPollProgress = conn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('market_data_poll_progress', 1, ?, ?)",
  );
  const upsertPollProgress = conn.db.transaction((labels: string, capturedAt: string) => {
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

  const deleteSignalActivity = conn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'signal_activity'",
  );
  const insertSignalActivity = conn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('signal_activity', 1, ?, ?)",
  );
  const deleteLastEntryApproved = conn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'last_entry_approved'",
  );
  const insertLastEntryApproved = conn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES ('last_entry_approved', 1, ?)",
  );
  const deleteLastSignalRejected = conn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'last_signal_rejected'",
  );
  const insertLastSignalRejected = conn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, captured_at) VALUES ('last_signal_rejected', 1, ?)",
  );
  const upsertSignalActivity = conn.db.transaction((labels: string, capturedAt: string) => {
    deleteSignalActivity.run();
    insertSignalActivity.run(labels, capturedAt);
  });

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

  // Scanner-layer metrics
  const scannerWindow = {
    candidatesConsidered: 0,
    blockedByResolutionBuffer: 0,
    blockedByWeekend: 0,
    blockedByWindow: 0,
    lastReset: Date.now(),
  };

  bus.subscribe("ScanTickCompleted", async (ev) => {
    scannerWindow.candidatesConsidered += ev.candidatesConsidered;
    scannerWindow.blockedByResolutionBuffer += ev.blockedByResolutionBuffer;
    scannerWindow.blockedByWeekend += ev.blockedByWeekend;
    scannerWindow.blockedByWindow += ev.blockedByWindow;
  });

  const deleteScanner = conn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'scanner_activity'",
  );
  const insertScanner = conn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('scanner_activity', 1, ?, ?)",
  );

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

    // Reset scanner window on same schedule as signal window
    if (now - scannerWindow.lastReset > SIGNAL_WINDOW_MS) {
      scannerWindow.candidatesConsidered = 0;
      scannerWindow.blockedByResolutionBuffer = 0;
      scannerWindow.blockedByWeekend = 0;
      scannerWindow.blockedByWindow = 0;
      scannerWindow.lastReset = now;
    }
    deleteScanner.run();
    insertScanner.run(
      JSON.stringify({
        candidatesConsidered: scannerWindow.candidatesConsidered,
        blockedByResolutionBuffer: scannerWindow.blockedByResolutionBuffer,
        blockedByWeekend: scannerWindow.blockedByWeekend,
        blockedByWindow: scannerWindow.blockedByWindow,
      }),
      new Date().toISOString(),
    );
  }, 30_000);

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

    conn.close();
    log.info("database closed — runtime stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // 10. Live-lite preflight: reconcile first, then check DB state
  if (config.liveLite) {
    log.info("running pre-supervisor reconciliation for live-lite preflight");
    await reconciliationModule.runReconciliation();

    const preflight = liveLitePreflight(conn.db, config.liveLite);
    if (preflight.shouldPause) {
      for (const v of preflight.violations) {
        log.warn({ violation: v }, "live-lite preflight violation — starting paused");
      }
      setPausedAndPersist(true);
    } else {
      log.info("live-lite preflight passed — no violations");
    }

    // Persist envelope for API consumption, tied to this bot_run_id
    conn.db
      .prepare(
        "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, 1, ?, ?)",
      )
      .run("live_lite_envelope", JSON.stringify(config.liveLite), new Date().toISOString());
  }

  // 11. Start
  try {
    await supervisor.start();

    // Safety: always start paused. Operator must explicitly resume via dashboard.
    setPausedAndPersist(true);
    log.info(
      { mode: config.runtimeMode },
      "runtime started PAUSED — operator must resume via dashboard",
    );

    log.info({ phase: supervisor.getPhase(), paused: supervisor.isPaused() }, "runtime ready");
  } catch (err) {
    log.fatal({ err }, "runtime startup failed");
    conn.close();
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("unhandled runtime error", err);
  process.exit(1);
});
