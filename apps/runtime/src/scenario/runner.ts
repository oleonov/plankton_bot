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

import { InProcessEventBus } from "@krabs/event-bus";
import {
  bootstrapDatabase,
  SqliteMarketRepository,
  SqliteOrderRepository,
  SqliteFillRepository,
  SqlitePositionRepository,
  SqliteInventoryLotRepository,
  SqliteOperatorCommandRepository,
  SqliteOperatorActionRepository,
  SqliteAlgoRulesRepository,
  SqliteLegStateRepository,
} from "@krabs/db";
import { createBotRunId, createTokenId } from "@krabs/domain";
import type { Market, ClobMarket, TokenId } from "@krabs/domain";
import { SimulationMarketDataGateway, SimulationExchangeGateway } from "@krabs/exchange";

import { MarketDataModule } from "../modules/market-data/market-data-module.js";
import { NormalizationModule } from "../modules/normalization/normalization-module.js";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import { RiskInventoryModule } from "../modules/risk-inventory/risk-inventory-module.js";
import { AlgoDecisionModule } from "../modules/algo-decision/algo-decision-module.js";
import type { SelectedMarketCache } from "../modules/algo-decision/algo-decision-module.js";
import { LegStateTrackerModule } from "../modules/leg-state/leg-state-tracker-module.js";
import { SignalToOrderBridge } from "../modules/strategy/signal-to-order.js";
import { CandidateBookCache } from "../modules/strategy/candidate-book-cache.js";
import { ReconciliationModule } from "../modules/reconciliation/reconciliation-module.js";
import { Supervisor } from "../supervisor/supervisor.js";
import { CommandPoller } from "../supervisor/command-poller.js";

import type { ScenarioFixture, ScenarioResult, ScheduledCommand } from "./types.js";

const DRAIN_TIMEOUT_MS = 5_000;

/**
 * A SelectedMarketCache that includes all tracked markets.
 * Scenario runs skip the selection-rule layer — every seeded market is
 * eligible. AlgoDecisionModule uses this cache to gate new BUY entries.
 */
class AllMarketsCache implements SelectedMarketCache {
  private readonly tokenIds = new Set<string>();

  track(tokenId: string): void {
    this.tokenIds.add(tokenId);
  }

  isEligible(_tokenId: TokenId): boolean {
    return true; // All seeded markets are eligible
  }

  getEligibleTokenIds(): TokenId[] {
    return [...this.tokenIds] as TokenId[];
  }
}

export async function runScenario(fixture: ScenarioFixture): Promise<ScenarioResult> {
  if (fixture.dbPath) {
    return await executeScenario(fixture, fixture.dbPath);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "krabs-scenario-"));
  const dbPath = join(tmpDir, "scenario.db");

  try {
    return await executeScenario(fixture, dbPath);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function executeScenario(fixture: ScenarioFixture, dbPath: string): Promise<ScenarioResult> {
  const log = pino({ level: "silent" });

  // 1. Bootstrap DB and create repos
  const conn = bootstrapDatabase(dbPath);
  const repos = {
    market: new SqliteMarketRepository(conn.db),
    order: new SqliteOrderRepository(conn.db),
    fill: new SqliteFillRepository(conn.db),
    position: new SqlitePositionRepository(conn.db),
    inventoryLot: new SqliteInventoryLotRepository(conn.db),
    operatorCommand: new SqliteOperatorCommandRepository(conn.db),
    operatorAction: new SqliteOperatorActionRepository(conn.db),
    algoRules: new SqliteAlgoRulesRepository(conn.db),
    legState: new SqliteLegStateRepository(conn.db),
  };

  // 2. Create gateways
  const marketDataGateway = new SimulationMarketDataGateway();
  const exchangeGateway = new SimulationExchangeGateway();

  // 3. Run optional setup callback (after seeding, before modules)
  if (fixture.setup) {
    await fixture.setup({ db: conn.db, exchangeGateway, marketDataGateway, repos });
  }

  // 4. Create event bus and subscribe for counting
  const bus = new InProcessEventBus();
  const counters = {
    signals: 0,
    approved: 0,
    rejected: 0,
    placed: 0,
    cancelled: 0,
    fills: 0,
    reconciliationRan: false,
    placeOrderRequested: 0,
    conversionSkipped: 0,
  };
  const skippedConversions: ScenarioResult["skippedConversions"] = [];

  bus.subscribe("SignalProduced", async () => {
    counters.signals++;
  });
  bus.subscribe("SignalApproved", async () => {
    counters.approved++;
  });
  bus.subscribe("SignalRejected", async () => {
    counters.rejected++;
  });
  bus.subscribe("OrderPlaced", async () => {
    counters.placed++;
  });
  bus.subscribe("OrderCancelled", async () => {
    counters.cancelled++;
  });
  bus.subscribe("FillReceived", async () => {
    counters.fills++;
  });
  bus.subscribe("ReconciliationComplete", async () => {
    counters.reconciliationRan = true;
  });
  bus.subscribe("PlaceOrderRequested", async () => {
    counters.placeOrderRequested++;
  });
  bus.subscribe("SignalConversionSkipped", async (ev) => {
    counters.conversionSkipped++;
    skippedConversions.push({
      stage: ev.stage,
      reasons: ev.reasons,
      diagnostics: ev.diagnostics,
    });
  });

  // 5. Record bot run
  const botRunId = createBotRunId(`scenario-${Date.now()}`);
  conn.db
    .prepare("INSERT INTO bot_runs (run_id, mode, started_at) VALUES (?, ?, ?)")
    .run(botRunId, "simulation", new Date().toISOString());

  // 6. Create modules
  const supervisorRef = { current: null as unknown as Supervisor };
  const runtimeControl = { isPaused: () => supervisorRef.current.isPaused() };

  const commandPoller = new CommandPoller({
    commandRepo: repos.operatorCommand,
    actionRepo: repos.operatorAction,
    bus,
    log,
    getPaused: () => supervisorRef.current.isPaused(),
    setPaused: (p) => supervisorRef.current.setPaused(p),
    pollIntervalMs: 60_000,
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
    positionRepo: repos.position,
    inventoryLotRepo: repos.inventoryLot,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    log,
    db: conn.db,
  });

  const candidateBookCache = marketDataGateway.getOrderBooks
    ? new CandidateBookCache({
        gateway: { getOrderBooks: marketDataGateway.getOrderBooks.bind(marketDataGateway) },
        log: log.child({ module: "candidate-book-cache" }),
      })
    : undefined;

  // All seeded markets are eligible (no selection-rule filtering in scenario runner)
  const selectedMarketCache = new AllMarketsCache();

  const legStateTrackerModule = new LegStateTrackerModule({
    bus,
    legStateRepo: repos.legState,
    log,
  });

  const algoDecisionModule = new AlgoDecisionModule({
    bus,
    legStateRepo: repos.legState,
    algoRulesRepo: repos.algoRules,
    positionRepo: repos.position,
    selectedMarketCache,
    runtimeControl,
    log,
    sweepIntervalMs: 60_000,
    ...(fixture.controlDb ? { controlDb: fixture.controlDb } : {}),
    ...(fixture.tradeCountProvider ? { tradeCountProvider: fixture.tradeCountProvider } : {}),
  });

  const signalToOrderBridge = new SignalToOrderBridge({
    bus,
    log,
    orderRepo: repos.order,
    candidateBookCache,
  });

  const reconciliationModule = new ReconciliationModule({
    gateway: exchangeGateway,
    bus,
    orderRepo: repos.order,
    fillRepo: repos.fill,
    marketRepo: repos.market,
    log,
    reconcileIntervalMs: 60_000,
  });

  // 7. Create supervisor and start
  supervisorRef.current = new Supervisor({
    modules: [
      ["command-poller", commandPoller],
      ["market-data", marketDataModule],
      ["normalization", normalizationModule],
      ["leg-state-tracker", legStateTrackerModule],
      ["algo-decision", algoDecisionModule],
      ["reconciliation", reconciliationModule],
      ["risk-inventory", riskInventoryModule],
      ["execution", executionModule],
    ],
    bus,
    log,
  });
  const supervisor = supervisorRef.current;

  signalToOrderBridge.subscribe();

  await supervisor.start();

  // 8. Pre-seed tracked markets into the market repo and the AllMarketsCache.
  function seedTrackedMarket(clobMarket: ClobMarket): void {
    const now = new Date().toISOString();
    for (const token of clobMarket.tokens) {
      const market: Market = {
        tokenId: createTokenId(token.tokenId),
        conditionId: clobMarket.conditionId,
        slug: clobMarket.slug,
        eventSlug: clobMarket.eventSlug ?? null,
        question: clobMarket.question,
        outcome: token.outcome,
        outcomeIndex: token.outcomeIndex ?? null,
        regime: null,
        horizon: null,
        endDate: clobMarket.endDate,
        active: clobMarket.active,
        tradable: true,
        tickSize: clobMarket.tickSize,
        negRisk: clobMarket.negRisk,
        eventMarketCount: clobMarket.eventMarketCount,
        gammaCreatedAt: clobMarket.gammaCreatedAt,
        createdAt: now,
        updatedAt: now,
      };
      repos.market.save(market);
      selectedMarketCache.track(token.tokenId);
    }
  }

  const seeded = new Set<string>();
  for (const snap of fixture.marketSnapshots) {
    if (!seeded.has(snap.market.conditionId)) {
      seedTrackedMarket(snap.market);
      seeded.add(snap.market.conditionId);
    }
  }

  // 9. Tick loop
  const scheduledByTick = groupCommandsByTick(fixture.scheduledCommands ?? []);

  const loopStart = Date.now();
  for (let tick = 0; tick < fixture.ticks; tick++) {
    if (fixture.maxDurationMs != null && Date.now() - loopStart >= fixture.maxDurationMs) {
      break;
    }
    const tickStart = performance.now();

    // Inject scheduled commands for this tick
    const commands = scheduledByTick.get(tick);
    if (commands) {
      for (const cmd of commands) {
        repos.operatorCommand.insert({
          action: cmd.action,
          targetId: cmd.targetId ?? null,
          reason: cmd.reason ?? null,
          createdAt: new Date().toISOString(),
        });
      }
    }

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

    if (fixture.onTick) {
      fixture.onTick(tick, performance.now() - tickStart);
    }

    if (fixture.tickDelayMs && fixture.tickDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, fixture.tickDelayMs));
    }
  }

  // 10. Stop supervisor
  signalToOrderBridge.unsubscribe();
  await supervisor.stop();
  candidateBookCache?.dispose();

  // 11. Query final state from DB
  const openPositions = repos.position.findOpen();
  const dustPositions = repos.position.findDust();

  const totalRealizedPnl =
    openPositions.reduce((sum, p) => sum + p.realizedPnl, 0) +
    dustPositions.reduce((sum, p) => sum + p.realizedPnl, 0) +
    sumClosedRealizedPnl(conn.db);

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
    totalRealizedPnl,
    totalTailCostUsdc: 0,
    reconciliationRan: counters.reconciliationRan,
    finalPhase: supervisor.getPhase(),
    placeOrderRequestedCount: counters.placeOrderRequested,
    conversionSkippedCount: counters.conversionSkipped,
    skippedConversions,
  };
}

function groupCommandsByTick(commands: ScheduledCommand[]): Map<number, ScheduledCommand[]> {
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
    .prepare(
      "SELECT COALESCE(SUM(realized_pnl), 0) AS total FROM positions WHERE status = 'closed'",
    )
    .get() as { total: number };
  return row.total;
}
