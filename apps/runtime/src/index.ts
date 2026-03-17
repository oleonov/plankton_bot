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
import { loadEnv, loadFamilyRulesYaml } from "@plankton/config";
import { createFamilyRulesProvider } from "@plankton/family-rules";
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
} from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { FamilyIdentity, FamilyState } from "@plankton/domain";
import { createFamilyId, createBotRunId, slugPatternToRegex } from "@plankton/domain";
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
import { ResolutionDetector } from "./modules/resolution/resolution-detector.js";
import { PositionSettler } from "./modules/resolution/position-settler.js";
import { FamilyExposureCalculator } from "./modules/risk-inventory/family-exposure.js";
import { GammaResolutionClient } from "@plankton/exchange";
import { SqliteMarketResolutionRepository } from "@plankton/db";

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
  };

  // 4. Load family rules
  let families: FamilyIdentity[];
  let rulesProvider: ReturnType<typeof createFamilyRulesProvider>;
  try {
    const familyConfigs = loadFamilyRulesYaml(config.familyRulesPath);
    rulesProvider = createFamilyRulesProvider(familyConfigs);
    families = rulesProvider.getAllFamilies();
    log.info({ count: families.length }, "family rules loaded");
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
    familyStateRepo: repos.familyState,
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
  let supervisor: Supervisor;
  const runtimeControl = { isPaused: () => supervisor.isPaused() };

  const commandPoller = new CommandPoller({
    commandRepo: repos.operatorCommand,
    actionRepo: repos.operatorAction,
    familyStateRepo: repos.familyState,
    bus,
    log,
    getPaused: () => supervisor.isPaused(),
    setPaused: (p) => supervisor.setPaused(p),
    pollIntervalMs: 5_000,
  });

  // 7b. Create gateways via factory
  let polyClient: unknown | undefined;
  if (config.runtimeMode === "paper" || config.runtimeMode === "live-lite") {
    const { ClobClient } = await import("@polymarket/clob-client");
    const CLOB_HOST = "https://clob.polymarket.com";
    const POLYGON_CHAIN_ID = 137;

    if (config.runtimeMode === "paper") {
      polyClient = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID);
    } else {
      const { Wallet } = await import("ethers");
      const signer = new Wallet(config.polyPrivateKey!);
      polyClient = new ClobClient(
        CLOB_HOST,
        POLYGON_CHAIN_ID,
        signer,
        {
          key: config.polyApiKey!,
          secret: config.polyApiSecret!,
          passphrase: config.polyPassphrase!,
        },
      );
    }
  }

  // Build slug filter from family rules so we only keep relevant markets during pagination
  const slugPatterns: RegExp[] = [];
  for (const f of families) {
    if (!f.slugPattern) continue;
    try {
      slugPatterns.push(slugPatternToRegex(f.slugPattern));
    } catch {
      log.warn(
        { familyId: String(f.familyId), pattern: f.slugPattern },
        "invalid slug pattern — skipping for market-data filter",
      );
    }
  }
  const slugFilter = slugPatterns.length > 0
    ? (slug: string) => slugPatterns.some((re) => re.test(slug))
    : undefined;

  const { marketDataGateway, exchangeGateway, modeLabel, marketDataSource, executionMode } = createGateways({
    runtimeMode: config.runtimeMode,
    polyClient,
    slugFilter,
  });
  log.info({ mode: modeLabel }, "gateways created");

  const liveLiteGuard = new LiveLiteGuard(config.liveLite);

  // 7c. Create bot run ID (needed by market-data and execution modules)
  const botRunId = createBotRunId(`run-${Date.now()}`);

  // Record this run in bot_runs for API consumption
  conn.db.prepare(
    "INSERT INTO bot_runs (run_id, mode, started_at) VALUES (?, ?, ?)",
  ).run(botRunId, config.runtimeMode, new Date().toISOString());
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
  });

  // 7g. Risk + Inventory module
  const riskInventoryModule = new RiskInventoryModule({
    bus,
    rulesProvider,
    familyStateRepo: repos.familyState,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
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
    scanIntervalMs: 30_000,
    runtimeControl,
    liveLiteGuard,
  });

  // 7i. Reconciliation module
  const reconciliationModule = new ReconciliationModule({
    gateway: exchangeGateway,
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    log,
    reconcileIntervalMs: 60_000,
    db: conn.db,
  });

  // 7j. Resolution module — detect resolved markets, settle positions
  const marketResolutionRepo = new SqliteMarketResolutionRepository(conn.db);
  const gammaResolutionClient = new GammaResolutionClient();
  const exposureCalculator = new FamilyExposureCalculator(
    repos.familyState,
    repos.position,
    repos.inventoryLot,
    log,
  );
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
    conn.db,
  );
  const resolutionModule = new ResolutionModule({
    detector: resolutionDetector,
    settler: positionSettler,
    marketRepo: repos.market,
    resolutionRepo: marketResolutionRepo,
    orderRepo: repos.order,
    rulesProvider,
    exposureCalculator,
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

  const modules: Array<[string, import("@plankton/domain").RuntimeModule]> = [
    ["command-poller", commandPoller],
    ["market-scanner", marketScannerModule],
    ["market-data", marketDataModule],
    ["normalization", normalizationModule],
    ["reconciliation", reconciliationModule],
    ["strategy", strategyModule],
    ["risk-inventory", riskInventoryModule],
    ["resolution", resolutionModule],
    ["stale-pruning", stalePruningModule],
    ["execution", executionModule],
  ];

  // 7l. Persist key timestamps to runtime_metrics for API consumption
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

  const deletePollProgress = conn.db.prepare(
    "DELETE FROM runtime_metrics WHERE metric_name = 'market_data_poll_progress'",
  );
  const insertPollProgress = conn.db.prepare(
    "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES ('market_data_poll_progress', 1, ?, ?)",
  );
  const upsertPollProgress = conn.db.transaction(
    (labels: string, capturedAt: string) => {
      deletePollProgress.run();
      insertPollProgress.run(labels, capturedAt);
    },
  );

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

  // 8. Create supervisor
  supervisor = new Supervisor({ modules, bus, log });

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
      supervisor.setPaused(true);
    } else {
      log.info("live-lite preflight passed — no violations");
    }

    // Persist envelope for API consumption, tied to this bot_run_id
    conn.db.prepare(
      "INSERT INTO runtime_metrics (metric_name, value, labels, captured_at) VALUES (?, 1, ?, ?)",
    ).run("live_lite_envelope", JSON.stringify(config.liveLite), new Date().toISOString());
  }

  // 11. Start
  try {
    await supervisor.start();
    log.info({ phase: supervisor.getPhase() }, "runtime ready");
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
