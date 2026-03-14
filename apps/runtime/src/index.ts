/**
 * Plankton Runtime — composition root and entrypoint.
 *
 * Wires config, DB, family rules, event bus, supervisor, and modules.
 * Does NOT implement exchange, strategy, risk, or market-data logic.
 */

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
import { createFamilyId, createBotRunId } from "@plankton/domain";
import { createGateways } from "./gateway-factory.js";

import { createLogger } from "./logger.js";
import { Supervisor } from "./supervisor/supervisor.js";
import { CommandPoller } from "./supervisor/command-poller.js";
import { MarketDataModule } from "./modules/market-data/market-data-module.js";
import { NormalizationModule } from "./modules/normalization/normalization-module.js";
import { ExecutionModule } from "./modules/execution/execution-module.js";
import { RiskInventoryModule } from "./modules/risk-inventory/risk-inventory-module.js";
import { StrategyModule } from "./modules/strategy/strategy-module.js";
import { ReconciliationModule } from "./modules/reconciliation/reconciliation-module.js";

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

  // 6. Create event bus
  const bus = new InProcessEventBus();

  // 7. Build modules
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
    // @ts-expect-error — optional SDK, only required for paper/live-lite modes
    const { ClobClient } = await import("@polymarket/clob-client");
    polyClient = new ClobClient(config.polyApiKey!, config.polyApiSecret!, config.polyPassphrase!);
  }

  const { marketDataGateway, exchangeGateway, modeLabel, marketDataSource, executionMode } = createGateways({
    runtimeMode: config.runtimeMode,
    polyClient,
  });
  log.info({ mode: modeLabel }, "gateways created");

  // 7c. Real modules for market-data and normalization
  const marketDataModule = new MarketDataModule({
    gateway: marketDataGateway,
    bus,
    log,
    pollIntervalMs: config.marketDataPollIntervalMs,
    staleThresholdMs: config.marketDataStaleThresholdMs,
  });

  const normalizationModule = new NormalizationModule({
    bus,
    rulesProvider,
    marketRepo: repos.market,
    log,
  });

  // 7e. Execution module
  const botRunId = createBotRunId(`run-${Date.now()}`);

  // Record this run in bot_runs for API consumption
  conn.db.prepare(
    "INSERT INTO bot_runs (run_id, mode, started_at) VALUES (?, ?, ?)",
  ).run(botRunId, config.runtimeMode, new Date().toISOString());
  log.info({ botRunId, mode: config.runtimeMode }, "bot run recorded");

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
    orderRepo: repos.order,
    fillRepo: repos.fill,
    log,
    botRunId,
  });

  // 7f. Risk + Inventory module
  const riskInventoryModule = new RiskInventoryModule({
    bus,
    rulesProvider,
    familyStateRepo: repos.familyState,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    log,
    db: conn.db,
  });

  // 7g. Strategy module
  const strategyModule = new StrategyModule({
    bus,
    rulesProvider,
    positionRepo: repos.position,
    familyStateRepo: repos.familyState,
    log,
    scanIntervalMs: 30_000,
  });

  // 7h. Reconciliation module
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

  const modules: Array<[string, import("@plankton/domain").RuntimeModule]> = [
    ["command-poller", commandPoller],
    ["market-data", marketDataModule],
    ["normalization", normalizationModule],
    ["reconciliation", reconciliationModule],
    ["strategy", strategyModule],
    ["risk-inventory", riskInventoryModule],
    ["execution", executionModule],
  ];

  // 7i. Persist key timestamps to runtime_metrics for API consumption
  const upsertMetric = conn.db.prepare(`
    INSERT INTO runtime_metrics (metric_name, value, captured_at)
    VALUES (?, 1, ?)
  `);

  bus.subscribe("ReconciliationComplete", async ({ result }) => {
    upsertMetric.run("last_reconciliation", new Date(result.ranAt).toISOString());
  });

  bus.subscribe("MarketSnapshotReceived", async ({ timestamp }) => {
    upsertMetric.run("market_data_last_update", new Date(timestamp).toISOString());
  });

  // 8. Create supervisor
  const supervisor = new Supervisor({ modules, bus, log });

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

  // 10. Start
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
