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
import { readFileSync } from "node:fs";
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
import { loadEnv, loadFamilyRulesYaml, type GlobalConfig } from "@plankton/config";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  bootstrapControlDb,
  bootstrapLedgerDb,
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
  SqliteFamilyDeploymentRepository,
  computeConfigChecksum,
  getLatestConfigImportMeta,
} from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { FamilyState } from "@plankton/domain";
import {
  createBotRunId,
  slugPatternToRegex,
  ENTRY_REASONS,
  type EntryRulePreset,
} from "@plankton/domain";
import { migrateOrphanedPositions } from "./universe-migration.js";
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
import { StrategyModule } from "./modules/strategy/strategy-module.js";
import { CandidateBookCache } from "./modules/strategy/candidate-book-cache.js";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation-module.js";
import { ResolutionModule } from "./modules/resolution/resolution-module.js";
import { UserOrderStreamModule } from "./modules/reconciliation/user-order-stream-module.js";
import { InventoryManagerModule } from "./modules/inventory-auto-merge/inventory-manager-module.js";
import { StalePruningModule } from "./modules/pruning/stale-pruning-module.js";
import { FillPollerModule } from "./modules/fill-poller/fill-poller-module.js";
import { ResolutionDetector } from "./modules/resolution/resolution-detector.js";
import { PositionSettler } from "./modules/resolution/position-settler.js";
import { FamilyExposureCalculator } from "./modules/risk-inventory/family-exposure.js";
import { GammaResolutionClient } from "@plankton/exchange";
import { SqliteMarketResolutionRepository, SqliteMergeLedgerRepository } from "@plankton/db";
import { SnapshotWriter } from "./snapshot-writer.js";
import { RiskEventWriter } from "./risk-event-writer.js";
import { DbFamilyRulesProvider } from "./db-family-rules-provider.js";
import { needsBootstrap, bootstrapImport, syncProfileInitialBalances } from "./bootstrap-import.js";
import { resolveActiveProfile } from "./profile-boot.js";
import { runStartupPositionAdoption } from "./startup-position-adoption.js";
import { FamilyEvidenceEngine } from "./modules/evidence/evidence-engine.js";
import { ScoreComputer } from "./modules/evidence/score-computer.js";
import { RuntimeSafetyEvaluator } from "./modules/safety/runtime-safety-evaluator.js";
import { ProfileRuntimePublisher } from "./modules/publisher/profile-runtime-publisher.js";
import { ValidationMetricsReader } from "./modules/publisher/validation-metrics-reader.js";
import { RuntimeStatePublisher } from "./runtime-state-publisher.js";
import { evaluateResumeIntent } from "./resume-intent.js";
import { createPolymarketClient, type SettlementClientLike } from "./polymarket-client-factory.js";
import { resolveLiveLiteMaxFamilies } from "./live-lite-envelope.js";
import { installConsoleRedaction } from "./console-redaction.js";
import { HotFamilyExecutionModule } from "./modules/hot-lane/hot-family-execution-module.js";
import { HotQuoteBusModule } from "./modules/hot-lane/hot-quote-bus-module.js";
import { FastExitCleanupModule } from "./modules/hot-lane/fast-exit-cleanup-module.js";
import { HotMarketDataModule } from "./modules/hot-lane/hot-market-data-module.js";
import { evaluateConfigDrift } from "./config-drift-monitor.js";
import type { CandidateBookRefreshObserved } from "./modules/strategy/candidate-book-cache.js";

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
  let familyRulesRaw = "";
  let familyRulesChecksum = "";
  let loadedFamilyRules: ReturnType<typeof loadFamilyRulesYaml>;

  let controlConn: DbConnection;
  try {
    controlConn = bootstrapControlDb(controlDbPath);
    log.info({ path: controlDbPath }, "control database ready");
  } catch (err) {
    log.fatal({ err }, "database bootstrap failed");
    process.exit(1);
  }

  try {
    familyRulesRaw = readFileSync(config.familyRulesPath, "utf-8");
    familyRulesChecksum = computeConfigChecksum(familyRulesRaw);
    loadedFamilyRules = loadFamilyRulesYaml(config.familyRulesPath);
  } catch (err) {
    log.fatal({ err, path: config.familyRulesPath }, "failed to load family rules YAML");
    controlConn.close();
    process.exit(1);
  }

  // 2b. Bootstrap import — seed control.db from YAML if empty
  if (needsBootstrap(controlConn.db)) {
    bootstrapImport(controlConn.db, loadedFamilyRules, {
      sourcePath: config.familyRulesPath,
      sourceChecksum: familyRulesChecksum,
      sourceVersion: 1,
      importedBy: "bootstrap",
    });
    log.info("control.db bootstrapped from YAML");
  }

  const latestConfigImport = getLatestConfigImportMeta(controlConn.db);
  const loadedControlChecksum = latestConfigImport?.sourceChecksum ?? null;
  let lastConfigDriftWarningKey: string | null = null;
  const logConfigDriftWarning = (
    yamlRaw: string,
    latestImportMeta = getLatestConfigImportMeta(controlConn.db),
  ): void => {
    const drift = evaluateConfigDrift({
      yamlRaw,
      latestConfigImport: latestImportMeta,
      loadedControlChecksum,
    });
    if (!drift.warningKey) {
      lastConfigDriftWarningKey = null;
      return;
    }
    if (drift.warningKey === lastConfigDriftWarningKey) return;
    lastConfigDriftWarningKey = drift.warningKey;
    log.warn(
      {
        yamlPath: config.familyRulesPath,
        yamlChecksum: drift.yamlChecksum,
        importedChecksum: drift.importedChecksum,
        loadedControlChecksum,
        importedAt: latestImportMeta?.importedAt ?? null,
        importedBy: latestImportMeta?.importedBy ?? null,
        sourcePath: latestImportMeta?.sourcePath ?? null,
        warnings: drift.warnings,
      },
      "family rules drift detected; sync and/or restart are required",
    );
  };
  logConfigDriftWarning(familyRulesRaw, latestConfigImport);

  // 2b-2. Load global config from YAML (spray sizing, budget caps, etc.)
  // Global config lives in YAML only — not persisted to DB.
  let globalConfig: GlobalConfig | undefined;
  let defaultEntryPreset: EntryRulePreset | undefined;
  try {
    globalConfig = loadedFamilyRules.global;
    defaultEntryPreset = loadedFamilyRules.defaults.entry ?? undefined;
    syncProfileInitialBalances(controlConn.db, loadedFamilyRules.global.initialBalanceUsdc);
  } catch {
    log.warn("failed to load global config from YAML — spray features disabled");
  }

  // 2c. Resolve active profile from control.db (falls back to RUNTIME_MODE env)
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
    familyState: new SqliteFamilyStateRepository(ledgerConn.db),
    marketSnapshot: new SqliteMarketSnapshotRepository(ledgerConn.db),
    riskEvent: new SqliteRiskEventRepository(ledgerConn.db),
    // Control-side
    familyCatalog: new SqliteFamilyCatalogRepository(controlConn.db),
    operatorCommand: new SqliteOperatorCommandRepository(controlConn.db),
    operatorAction: new SqliteOperatorActionRepository(controlConn.db),
    familyCandidate: new SqliteFamilyCandidateRepository(controlConn.db),
    familyEvidence: new SqliteFamilyEvidenceRepository(controlConn.db),
    familyRulesSnapshot: new SqliteFamilyRulesSnapshotRepository(controlConn.db),
    stateTransition: new SqliteStateTransitionRepository(controlConn.db),
    promotionProposal: new SqlitePromotionProposalRepository(controlConn.db),
    candidateObservation: new SqliteCandidateObservationRepository(controlConn.db),
  };

  // 4. Family rules — DB-backed provider
  const rulesProvider = new DbFamilyRulesProvider(controlConn.db, activeProfile);
  const families = rulesProvider.getAllFamilies();
  log.info({ count: families.length }, "family rules loaded from control.db");

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
        firstNegativeTailAt: null,
        updatedAt: new Date().toISOString(),
      };
      repos.familyState.save(baseline);
    }
  }
  log.info("family runtime state baseline ensured");

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

  // Build live-lite envelope from control.db profile_settings (replaces env vars)
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
    // Derive allowlist from enabled family_deployments for live-lite
    const deployedFamilies = controlConn.db
      .prepare(
        "SELECT family_id FROM family_deployments WHERE profile = 'live-lite' AND enabled = 1",
      )
      .all() as { family_id: string }[];
    const minOrderUsdc = settingsRow?.min_order_usdc;
    return {
      familyAllowlist: deployedFamilies.map((f) => f.family_id),
      maxFamilies: resolveLiveLiteMaxFamilies(envelope, deployedFamilies.length),
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

  // Build slug filter dynamically from rules manager so new families added via
  // rules_reload are picked up without restart.
  const slugFilter = (slug: string): boolean => {
    const currentFamilies = rulesProvider.getAllFamilies();
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
    rulesManager: rulesProvider,
    normalizationModule,
    familyEvidenceRepo: repos.familyEvidence,
    familyRulesSnapshotRepo: repos.familyRulesSnapshot,
    familyCandidateRepo: repos.familyCandidate,
    stateTransitionRepo: repos.stateTransition,
    familyRulesDbWriter: new SqliteFamilyRulesDbRepository(controlConn.db),
    deploymentUpdater: new SqliteFamilyDeploymentRepository(controlConn.db),
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
    rulesProvider,
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
    rulesProvider,
    familyStateRepo: repos.familyState,
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
  const handleCandidateBookRefreshObserved = (event: CandidateBookRefreshObserved): void => {
    if (event.outcome === "attempted") {
      candidateBookRefreshWindow.attempts += event.tokenCount;
    }
    if (event.outcome === "refresh-budget-exhausted" || event.outcome === "refresh-failed") {
      candidateBookRefreshWindow.timeouts += event.tokenCount;
    }
  };
  const candidateBookCache = marketDataGateway.getOrderBooks
    ? new CandidateBookCache({
        gateway: { getOrderBooks: marketDataGateway.getOrderBooks.bind(marketDataGateway) },
        log: log.child({ module: "candidate-book-cache" }),
        onRefreshObserved: handleCandidateBookRefreshObserved,
      })
    : undefined;
  const strategyModule = new StrategyModule({
    bus,
    rulesProvider,
    positionRepo: repos.position,
    orderRepo: repos.order,
    familyStateRepo: repos.familyState,
    candidateBookCache,
    log,
    scanIntervalMs: config.strategyScanIntervalMs,
    runtimeControl,
    liveLiteGuard,
    globalConfig,
    defaultEntryPreset,
  });

  const hotFamilyExecutionModule = candidateBookCache
    ? new HotFamilyExecutionModule({
        bus,
        rulesProvider,
        orderRepo: repos.order,
        candidateBookCache,
        log,
        policy: { hotQuoteRefreshIntervalMs: 500 },
      })
    : null;
  const hotMarketDataModule = new HotMarketDataModule({
    bus,
    gateway: marketDataGateway,
    rulesProvider,
    orderRepo: repos.order,
    ...(candidateBookCache ? { candidateBookCache } : {}),
    log,
    policy: { hotQuoteRefreshIntervalMs: 500, maxTokensPerCycle: 120 },
  });
  const hotQuoteBusModule = candidateBookCache
    ? new HotQuoteBusModule({
        bus,
        rulesProvider,
        orderRepo: repos.order,
        candidateBookCache,
        log,
        policy: { hotQuoteRefreshIntervalMs: 500, maxTokensPerCycle: 120 },
      })
    : null;
  const fastExitCleanupModule = candidateBookCache
    ? new FastExitCleanupModule({
        bus,
        rulesProvider,
        positionRepo: repos.position,
        orderRepo: repos.order,
        candidateBookCache,
        log,
        policy: { hotQuoteRefreshIntervalMs: 500 },
      })
    : null;

  // 7i. Reconciliation module
  const reconciliationModule = new ReconciliationModule({
    gateway: exchangeGateway,
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    marketRepo: repos.market,
    rulesProvider,
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
          rulesProvider,
          log,
        })
      : null;

  // 7j. Resolution module — detect resolved markets, settle positions
  const marketResolutionRepo = new SqliteMarketResolutionRepository(ledgerConn.db);
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
  const positionSettler = new PositionSettler(repos.position, repos.inventoryLot, ledgerConn.db);
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
    rulesProvider,
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
          rulesProvider,
          bus,
          log,
          pollIntervalMs: config.fillPollIntervalMs,
          overlapMs: 5_000,
          onImportObserved: userOrderStreamModule
            ? ({ imported }) => userOrderStreamModule.recordPollingFills(imported)
            : undefined,
        })
      : null;

  // 7l2. Family evidence engine — periodic ledger-side scoring for deployed families
  const scoreComputer = new ScoreComputer(
    ledgerConn.db,
    controlConn.db,
    activeProfile as import("@plankton/domain").ProfileId,
  );
  const validationMetricsReader = new ValidationMetricsReader(ledgerConn.db);
  const evidenceEngine = new FamilyEvidenceEngine({
    bus,
    log,
    scoreComputer,
    evidenceRepo: repos.familyEvidence,
    rulesProvider,
  });

  // 7l2b. Safety evaluator — toxicity-based demotion writes to family_deployments
  const deploymentRepo = new SqliteFamilyDeploymentRepository(controlConn.db);
  const safetyEvaluator = new RuntimeSafetyEvaluator({
    bus,
    log,
    scoreComputer,
    executionTelemetryReader: validationMetricsReader,
    deploymentRepo,
    stateTransitionRepo: repos.stateTransition,
    familyStateRepo: repos.familyState,
    familyEvidenceRepo: repos.familyEvidence,
    rulesProvider,
    activeProfile: activeProfile as import("@plankton/domain").ProfileId,
  });

  // 7l3. Profile runtime publisher — periodic rollup of family metrics to control.db
  const profilePublisher = new ProfileRuntimePublisher({
    controlDb: controlConn.db,
    ledgerDb: ledgerConn.db,
    profile: activeProfile,
    deployedFamilyIds: () => rulesProvider.getAllFamilies().map((f) => String(f.familyId)),
    getPaused: () => supervisorRef.current.isPaused(),
    log,
    intervalMs: 60_000,
    ...(runtimeMode === "live-lite"
      ? {
          setLiveActiveFamilyAllowlist: (familyIds: string[] | null) =>
            liveLiteGuard.setDynamicFamilyAllowlist(familyIds),
        }
      : {}),
    ...(runtimeMode === "live-lite" ? { exchangeGateway } : {}),
  });

  const modules: Array<[string, import("@plankton/domain").RuntimeModule]> = [
    ["command-poller", commandPoller],
    ["market-scanner", marketScannerModule],
    ["market-data", marketDataModule],
    ["normalization", normalizationModule],
    ["risk-inventory", riskInventoryModule],
    ["evidence-engine", evidenceEngine],
    ["safety-evaluator", safetyEvaluator],
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
    ["strategy", strategyModule],
    ...(hotMarketDataModule
      ? [
          ["hot-market-data", hotMarketDataModule] as [
            string,
            import("@plankton/domain").RuntimeModule,
          ],
        ]
      : []),
    ...(hotQuoteBusModule
      ? [["hot-quote-bus", hotQuoteBusModule] as [string, import("@plankton/domain").RuntimeModule]]
      : []),
    ...(hotFamilyExecutionModule
      ? [
          ["hot-family-execution", hotFamilyExecutionModule] as [
            string,
            import("@plankton/domain").RuntimeModule,
          ],
        ]
      : []),
    ...(fastExitCleanupModule
      ? [
          ["fast-exit-cleanup", fastExitCleanupModule] as [
            string,
            import("@plankton/domain").RuntimeModule,
          ],
        ]
      : []),
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
    riskEventWriter.onOperatorCommand(
      ev.action,
      ev.targetFamilyId,
      ev.commandDbId,
      ev.reason,
      ev.initiatorType,
    );
  });

  bus.subscribe("FamilyDemotionApplied", async (ev) => {
    riskEventWriter.onFamilyDemotionApplied(ev.familyId, ev.previousState, ev.newState, ev.reason);
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

  bus.subscribe("HotLaneActionApplied", async ({ action }) => {
    conversionWindow.hotLaneActionsByType.set(
      action,
      (conversionWindow.hotLaneActionsByType.get(action) ?? 0) + 1,
    );
  });

  bus.subscribe("HotLaneStateChanged", async ({ nextState }) => {
    conversionWindow.hotLaneStatesByState.set(
      nextState,
      (conversionWindow.hotLaneStatesByState.get(nextState) ?? 0) + 1,
    );
  });

  // Scanner-layer metrics
  const scannerWindow = {
    candidatesConsidered: 0,
    blockedByResolutionBuffer: 0,
    blockedByWindow: 0,
    blockedByPerFamilyTickLimit: 0,
    gammaFallbackDustSignalsProduced: 0,
    scanPrimeSkippedByPolicy: 0,
    lastReset: Date.now(),
  };

  bus.subscribe("ScanTickCompleted", async (ev) => {
    scannerWindow.candidatesConsidered += ev.candidatesConsidered;
    scannerWindow.blockedByResolutionBuffer += ev.blockedByResolutionBuffer;
    scannerWindow.blockedByWindow += ev.blockedByWindow;
    scannerWindow.blockedByPerFamilyTickLimit += ev.blockedByPerFamilyTickLimit;
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
  let lastConfigDriftCheckAtMs = 0;

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
    if (now - lastConfigDriftCheckAtMs >= 60_000) {
      lastConfigDriftCheckAtMs = now;
      try {
        logConfigDriftWarning(readFileSync(config.familyRulesPath, "utf-8"));
      } catch (err) {
        log.warn({ err, path: config.familyRulesPath }, "failed to re-read family rules YAML");
      }
    }

    // Reset scanner window on same schedule as signal window
    if (now - scannerWindow.lastReset > SIGNAL_WINDOW_MS) {
      scannerWindow.candidatesConsidered = 0;
      scannerWindow.blockedByResolutionBuffer = 0;
      scannerWindow.blockedByWindow = 0;
      scannerWindow.blockedByPerFamilyTickLimit = 0;
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
        blockedByPerFamilyTickLimit: scannerWindow.blockedByPerFamilyTickLimit,
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

      // Derive trading state from current window — mirrors API computeTradingState logic
      const sa = signalWindow;
      let tradingState: string;
      if (sa.entryApproved > 0) {
        const allProbeOnly = ledgerConn.db
          .prepare(
            "SELECT COUNT(*) as total, COUNT(CASE WHEN effective_mode = 'probe-only' THEN 1 END) as probeOnly FROM family_runtime_state WHERE runtime_mode = 'active'",
          )
          .get() as { total: number; probeOnly: number };
        tradingState =
          allProbeOnly.total > 0 && allProbeOnly.probeOnly === allProbeOnly.total
            ? "PROBING_ONLY"
            : "ACTIVELY_TRADING";
      } else if (sa.produced > 0 && sa.rejected > 0 && sa.entryApproved === 0) {
        tradingState = "ALIVE_BUT_BLOCKED";
      } else if (sa.produced > 0 && sa.exitApproved > 0 && sa.entryApproved === 0) {
        tradingState = "EXITS_ONLY";
      } else {
        tradingState = "NO_SIGNALS";
      }

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
    familyStateRepo: repos.familyState,
    rulesProvider,
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
