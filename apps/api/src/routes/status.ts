import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ok } from "../errors.js";

interface StatusOpts {
  db: Database.Database;
  marketDataStaleThresholdMs?: number;
}

const startedAt = Date.now();

/** Build the status snapshot — shared by GET /status and SSE status events. */
export function buildStatusSnapshot(
  db: Database.Database,
  staleThresholdMs: number,
): Record<string, unknown> {
  const openOrders = db
    .prepare("SELECT COUNT(*) as cnt FROM orders WHERE status IN ('pending','open','partially-filled')")
    .get() as { cnt: number };

  const openPositions = db
    .prepare("SELECT COUNT(*) as cnt FROM positions WHERE status = 'open'")
    .get() as { cnt: number };

  const activeFamilies = db
    .prepare("SELECT COUNT(*) as cnt FROM family_runtime_state WHERE runtime_mode = 'active'")
    .get() as { cnt: number };

  const totalExposure = db
    .prepare("SELECT COALESCE(SUM(open_value_usdc),0) as total, COALESCE(SUM(current_tail_cost_usdc),0) as tail FROM family_runtime_state")
    .get() as { total: number; tail: number };

  // Runtime mode from the latest bot run
  const botRun = db
    .prepare("SELECT mode FROM bot_runs ORDER BY started_at DESC LIMIT 1")
    .get() as { mode: string } | undefined;

  // Paused = most recently applied pause/resume command is 'pause'
  const lastPauseResume = db
    .prepare("SELECT action FROM operator_commands WHERE action IN ('pause','resume') AND status = 'applied' ORDER BY applied_at DESC LIMIT 1")
    .get() as { action: string } | undefined;

  // Last reconciliation from runtime_metrics (written by ReconciliationComplete event listener)
  const lastRecon = db
    .prepare("SELECT captured_at as ts FROM runtime_metrics WHERE metric_name = 'last_reconciliation' ORDER BY captured_at DESC LIMIT 1")
    .get() as { ts: string } | undefined;

  // Market data freshness from runtime_metrics (written by MarketSnapshotReceived event listener)
  const lastMarketData = db
    .prepare("SELECT captured_at as ts FROM runtime_metrics WHERE metric_name = 'market_data_last_update' ORDER BY captured_at DESC LIMIT 1")
    .get() as { ts: string } | undefined;

  // Two-part mode decomposition for operator clarity
  const mdSource = db
    .prepare("SELECT labels FROM runtime_metrics WHERE metric_name = 'market_data_source' ORDER BY captured_at DESC LIMIT 1")
    .get() as { labels: string } | undefined;
  const execMode = db
    .prepare("SELECT labels FROM runtime_metrics WHERE metric_name = 'execution_mode' ORDER BY captured_at DESC LIMIT 1")
    .get() as { labels: string } | undefined;

  const marketDataLastUpdateAt = lastMarketData?.ts ?? null;
  const marketDataStale = marketDataLastUpdateAt
    ? (Date.now() - new Date(marketDataLastUpdateAt).getTime()) > staleThresholdMs
    : true; // no data yet = stale

  // Live-lite envelope — only show when current run is live-lite
  const envelopeRow = botRun?.mode === "live-lite"
    ? db
        .prepare("SELECT labels FROM runtime_metrics WHERE metric_name = 'live_lite_envelope' ORDER BY captured_at DESC LIMIT 1")
        .get() as { labels: string } | undefined
    : undefined;

  // Reconciliation drift: current-state (set on drift, reset on clean)
  const lastDrift = db
    .prepare("SELECT captured_at FROM runtime_metrics WHERE metric_name = 'reconciliation_drift' ORDER BY captured_at DESC LIMIT 1")
    .get() as { captured_at: string } | undefined;
  const lastCleanRecon = db
    .prepare("SELECT captured_at FROM runtime_metrics WHERE metric_name = 'reconciliation_clean' ORDER BY captured_at DESC LIMIT 1")
    .get() as { captured_at: string } | undefined;

  const reconciliationDriftDetected = lastDrift
    ? (!lastCleanRecon || new Date(lastDrift.captured_at) > new Date(lastCleanRecon.captured_at))
    : false;

  return {
    runtimeMode: botRun?.mode ?? "simulation",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    paused: lastPauseResume?.action === "pause",
    lastReconciliationAt: lastRecon?.ts ?? null,
    marketDataStale,
    marketDataLastUpdateAt,
    activeFamilyCount: activeFamilies.cnt,
    openOrderCount: openOrders.cnt,
    openPositionCount: openPositions.cnt,
    totalOpenValueUsdc: totalExposure.total,
    totalTailCostUsdc: totalExposure.tail,
    marketDataSource: mdSource ? JSON.parse(mdSource.labels).value : "simulation",
    executionMode: execMode ? JSON.parse(execMode.labels).value : "simulation",
    liveLite: envelopeRow ? JSON.parse(envelopeRow.labels) : undefined,
    reconciliationDriftDetected,
  };
}

export const statusRoutes: FastifyPluginAsync<StatusOpts> = async (app, opts) => {
  const staleMs = opts.marketDataStaleThresholdMs ?? 120_000;

  app.get("/status", async () => {
    return ok(buildStatusSnapshot(opts.db, staleMs));
  });
};
