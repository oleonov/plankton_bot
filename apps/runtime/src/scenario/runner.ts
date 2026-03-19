/**
 * Scenario runner — boots a full module stack against a temp SQLite DB,
 * feeds market fixtures tick-by-tick, and collects results.
 *
 * Always runs in simulation mode (SimulationMarketDataGateway + SimulationExchangeGateway).
 * MarketSnapshotReceived events are published manually rather than via the timer.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

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
import type { FamilyState } from "@plankton/domain";
import { createFamilyId, createBotRunId, createTokenId, slugPatternToRegex } from "@plankton/domain";
import type { Market, ClobMarket } from "@plankton/domain";
import type { FamilyConfig } from "@plankton/config";
import {
  SimulationMarketDataGateway,
  SimulationExchangeGateway,
} from "@plankton/exchange";

import { MarketDataModule } from "../modules/market-data/market-data-module.js";
import { NormalizationModule } from "../modules/normalization/normalization-module.js";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { RiskInventoryModule } from "../modules/risk-inventory/risk-inventory-module.js";
import { StrategyModule } from "../modules/strategy/strategy-module.js";
import { ReconciliationModule } from "../modules/reconciliation/reconciliation-module.js";
import { Supervisor } from "../supervisor/supervisor.js";
import { CommandPoller } from "../supervisor/command-poller.js";

import type { ScenarioFixture, ScenarioResult, ScheduledCommand } from "./types.js";

const DRAIN_TIMEOUT_MS = 5_000;

export async function runScenario(
  fixture: ScenarioFixture,
  familyConfigs: FamilyConfig[],
): Promise<ScenarioResult> {
  if (fixture.dbPath) {
    // Shared-DB mode: caller manages DB lifecycle
    return await executeScenario(fixture, familyConfigs, fixture.dbPath);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "plankton-scenario-"));
  const dbPath = join(tmpDir, "scenario.db");

  try {
    return await executeScenario(fixture, familyConfigs, dbPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function executeScenario(
  fixture: ScenarioFixture,
  familyConfigs: FamilyConfig[],
  dbPath: string,
): Promise<ScenarioResult> {
  const log = pino({ level: "silent" });

  // 1. Bootstrap DB and create repos
  const conn = bootstrapDatabase(dbPath);
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

  // 2. Create family rules provider and seed catalog + baseline state
  const rulesProvider = createFamilyRulesProvider(familyConfigs);
  const families = rulesProvider.getAllFamilies();
  repos.familyCatalog.upsertAll(families);

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

  // 3. Apply family state overrides
  if (fixture.familyStateOverrides) {
    for (const override of fixture.familyStateOverrides) {
      const familyId = createFamilyId(override.familyId);
      const existing = repos.familyState.get(familyId);
      if (existing) {
        repos.familyState.save({
          ...existing,
          runtimeMode: (override.runtimeMode as FamilyState["runtimeMode"]) ?? existing.runtimeMode,
          quarantineReason: override.quarantineReason !== undefined
            ? override.quarantineReason
            : existing.quarantineReason,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  // 4. Create gateways
  const marketDataGateway = new SimulationMarketDataGateway();
  const exchangeGateway = new SimulationExchangeGateway();

  // 4a. Run optional setup callback (after seeding, before modules)
  if (fixture.setup) {
    await fixture.setup({ db: conn.db, exchangeGateway, repos });
  }

  // 5. Create event bus and subscribe for counting
  const bus = new InProcessEventBus();
  const counters = {
    signals: 0,
    approved: 0,
    rejected: 0,
    placed: 0,
    cancelled: 0,
    fills: 0,
    reconciliationRan: false,
  };

  bus.subscribe("SignalProduced", async () => { counters.signals++; });
  bus.subscribe("SignalApproved", async () => { counters.approved++; });
  bus.subscribe("SignalRejected", async () => { counters.rejected++; });
  bus.subscribe("OrderPlaced", async () => { counters.placed++; });
  bus.subscribe("OrderCancelled", async () => { counters.cancelled++; });
  bus.subscribe("FillReceived", async () => { counters.fills++; });
  bus.subscribe("ReconciliationComplete", async () => { counters.reconciliationRan = true; });

  // 6. Record bot run
  const botRunId = createBotRunId(`scenario-${Date.now()}`);
  conn.db.prepare(
    "INSERT INTO bot_runs (run_id, mode, started_at) VALUES (?, ?, ?)",
  ).run(botRunId, "simulation", new Date().toISOString());

  // 7. Create modules (long intervals — we bypass timers)
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
    pollIntervalMs: 60_000, // Long — we poll manually
  });

  const marketDataModule = new MarketDataModule({
    gateway: marketDataGateway,
    marketRepo: repos.market,
    bus,
    log,
    pollIntervalMs: 60_000,
    staleThresholdMs: 120_000,
    botRunId: String(botRunId),
  });

  const normalizationModule = new NormalizationModule({
    bus,
    rulesProvider,
    marketRepo: repos.market,
    log,
  });

  const executionModule = new ExecutionModule({
    gateway: exchangeGateway,
    bus,
    marketRepo: repos.market,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    log,
    botRunId,
    runtimeControl,
  });

  const riskInventoryModule = new RiskInventoryModule({
    bus,
    rulesProvider,
    familyStateRepo: repos.familyState,
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    orderRepo: repos.order,
    log,
    db: conn.db,
  });

  const strategyModule = new StrategyModule({
    bus,
    rulesProvider,
    positionRepo: repos.position,
    familyStateRepo: repos.familyState,
    log,
    scanIntervalMs: 60_000,
    runtimeControl,
  });

  const reconciliationModule = new ReconciliationModule({
    gateway: exchangeGateway,
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    log,
    reconcileIntervalMs: 60_000,
  });

  // 8. Create supervisor and start
  supervisor = new Supervisor({
    modules: [
      ["command-poller", commandPoller],
      ["market-data", marketDataModule],
      ["normalization", normalizationModule],
      ["reconciliation", reconciliationModule],
      ["strategy", strategyModule],
      ["risk-inventory", riskInventoryModule],
      ["execution", executionModule],
    ],
    bus,
    log,
  });

  await supervisor.start();

  // 8a. Pre-seed tracked markets into the market repo so the pricing loop finds them.
  // In production, MarketScannerModule does this; in scenarios we do it from fixtures.
  const compiledFamilies = families.map((f) => ({
    identity: f,
    regex: f.slugPattern ? slugPatternToRegex(f.slugPattern) : null,
  }));

  function seedTrackedMarket(clobMarket: ClobMarket): void {
    const matched = compiledFamilies.find((f) => f.regex?.test(clobMarket.slug));
    const now = new Date().toISOString();
    for (const token of clobMarket.tokens) {
      const market: Market = {
        tokenId: createTokenId(token.tokenId),
        conditionId: clobMarket.conditionId,
        slug: clobMarket.slug,
        eventSlug: clobMarket.eventSlug ?? null,
        question: clobMarket.question,
        outcome: token.outcome.toUpperCase() === "YES" ? "YES" : "NO",
        familyId: matched?.identity.familyId ?? null,
        familyKey: matched?.identity.familyKey ?? null,
        regime: matched?.identity.regime ?? null,
        horizon: matched?.identity.horizon ?? null,
        endDate: clobMarket.endDate,
        active: clobMarket.active,
        tickSize: clobMarket.tickSize,
        negRisk: clobMarket.negRisk,
        createdAt: now,
        updatedAt: now,
      };
      repos.market.save(market);
    }
  }

  // Pre-seed from all unique markets in fixtures
  const seeded = new Set<string>();
  for (const snap of fixture.marketSnapshots) {
    if (!seeded.has(snap.market.conditionId)) {
      seedTrackedMarket(snap.market);
      seeded.add(snap.market.conditionId);
    }
  }

  // 9. Tick loop
  const scheduledByTick = groupCommandsByTick(fixture.scheduledCommands ?? []);

  for (let tick = 0; tick < fixture.ticks; tick++) {
    // Inject scheduled commands for this tick
    const commands = scheduledByTick.get(tick);
    if (commands) {
      for (const cmd of commands) {
        repos.operatorCommand.insert({
          action: cmd.action,
          targetId: cmd.familyId ?? null,
          reason: cmd.reason ?? null,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Process commands
    await commandPoller.poll();
    await bus.drain(DRAIN_TIMEOUT_MS);

    // Load market snapshot into simulation gateway
    const snapshot = fixture.marketSnapshots[tick % fixture.marketSnapshots.length]!;
    marketDataGateway.addMarket(snapshot.market);
    for (const [tokenIdStr, book] of Object.entries(snapshot.orderBooks)) {
      marketDataGateway.setOrderBook(createTokenId(tokenIdStr), book.bids, book.asks);
    }

    // Publish MarketSnapshotReceived (bypass MarketDataModule timer)
    await marketDataModule.poll();
    await bus.drain(DRAIN_TIMEOUT_MS);

    // Manually trigger strategy scan (bypass StrategyModule timer)
    await strategyModule.tick();
    await bus.drain(DRAIN_TIMEOUT_MS);
  }

  // 10. Stop supervisor
  await supervisor.stop();

  // 11. Query final state from DB
  const finalFamilyStates = repos.familyState.findAll();
  const openPositions = repos.position.findOpen();
  const dustPositions = repos.position.findDust();

  const totalRealizedPnl = openPositions.reduce((sum, p) => sum + p.realizedPnl, 0)
    + dustPositions.reduce((sum, p) => sum + p.realizedPnl, 0)
    + sumClosedRealizedPnl(conn.db);

  const totalTailCostUsdc = finalFamilyStates.reduce(
    (sum, fs) => sum + fs.currentTailCostUsdc,
    0,
  );

  conn.close();

  return {
    signalCount: counters.signals,
    approvedCount: counters.approved,
    rejectedCount: counters.rejected,
    placedOrderCount: counters.placed,
    cancelledOrderCount: counters.cancelled,
    fillCount: counters.fills,
    openPositionCount: openPositions.length,
    dustPositionCount: dustPositions.length,
    familyStates: finalFamilyStates.map((fs) => ({
      familyId: fs.familyId,
      runtimeMode: fs.runtimeMode,
      openValueUsdc: fs.openValueUsdc,
      openPositionCount: fs.openPositionCount,
      tailAdjustedPnlLive: fs.tailAdjustedPnlLive,
    })),
    totalRealizedPnl,
    totalTailCostUsdc,
    reconciliationRan: counters.reconciliationRan,
    finalPhase: supervisor.getPhase(),
  };
}

function groupCommandsByTick(
  commands: ScheduledCommand[],
): Map<number, ScheduledCommand[]> {
  const map = new Map<number, ScheduledCommand[]>();
  for (const cmd of commands) {
    const list = map.get(cmd.atTick);
    if (list) {
      list.push(cmd);
    } else {
      map.set(cmd.atTick, [cmd]);
    }
  }
  return map;
}

function sumClosedRealizedPnl(db: import("better-sqlite3").Database): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(realized_pnl), 0) AS total FROM positions WHERE status = 'closed'")
    .get() as { total: number };
  return row.total;
}
