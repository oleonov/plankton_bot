import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import type { AppConfig } from "@krabs/config";
import { resolveActiveLedger } from "../active-ledger.js";
import { computeExecutionTelemetry } from "../execution-telemetry.js";
import { ok, fail } from "../errors.js";
import type { LedgerPool } from "../ledger-pool.js";

interface MetricsOpts {
  ledgerDb: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
  config?: AppConfig;
}

export const metricsRoutes: FastifyPluginAsync<MetricsOpts> = async (app, opts) => {
  const { ledgerDb, controlDb, ledgerPool, config } = opts;

  app.get("/metrics", async () => {
    const positions = ledgerDb
      .prepare("SELECT status, COUNT(*) as cnt FROM positions GROUP BY status")
      .all() as Array<{ status: string; cnt: number }>;

    const orders = ledgerDb
      .prepare("SELECT status, COUNT(*) as cnt FROM orders GROUP BY status")
      .all() as Array<{ status: string; cnt: number }>;

    const totalFills = ledgerDb
      .prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(size_usdc),0) as volume FROM fills")
      .get() as { cnt: number; volume: number };

    const pnl = ledgerDb
      .prepare("SELECT COALESCE(SUM(realized_pnl),0) as total FROM positions")
      .get() as { total: number };

    const executionTelemetry = computeExecutionTelemetry(ledgerDb);

    return ok({
      positions: Object.fromEntries(positions.map((r) => [r.status, r.cnt])),
      orders: Object.fromEntries(orders.map((r) => [r.status, r.cnt])),
      fills: {
        count: totalFills.cnt,
        volumeUsdc: totalFills.volume,
        makerCount: executionTelemetry.makerFills,
        takerCount: executionTelemetry.takerFills,
        unknownCount: executionTelemetry.unknownFills,
        explicitFeesUsdc: executionTelemetry.explicitFeesUsdc,
        feeLeakageRatio: executionTelemetry.feeLeakageRatio,
      },
      totalRealizedPnl: pnl.total,
    });
  });

  app.get("/metrics/coverage", async () => {
    const { db } = resolveActiveLedger(ledgerDb, controlDb, ledgerPool);
    const marketCounts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(CASE WHEN active = 1 AND tradable = 1 THEN 1 ELSE 0 END), 0) AS activeTradable
           FROM markets`,
      )
      .get() as { total: number; active: number; activeTradable: number };
    const positionsOpened24h = db
      .prepare(
        `SELECT COUNT(*) AS cnt
           FROM positions
          WHERE julianday(opened_at) >= julianday(?)`,
      )
      .get(new Date(Date.now() - 24 * 60 * 60_000).toISOString()) as { cnt: number };
    const streamRow = db
      .prepare(
        "SELECT labels, captured_at FROM runtime_metrics WHERE metric_name = 'market_data_stream_activity' ORDER BY captured_at DESC, id DESC LIMIT 1",
      )
      .get() as { labels: string | null; captured_at: string } | undefined;
    const stream = parseJsonObject(streamRow?.labels);
    const latencyRow = db
      .prepare(
        "SELECT labels FROM runtime_metrics WHERE metric_name = 'algo_decision_latency' ORDER BY captured_at DESC, id DESC LIMIT 1",
      )
      .get() as { labels: string | null } | undefined;
    const r23CacheRow = db
      .prepare(
        "SELECT labels FROM runtime_metrics WHERE metric_name = 'r23_cache_activity' ORDER BY captured_at DESC, id DESC LIMIT 1",
      )
      .get() as { labels: string | null } | undefined;
    const runtimeDiagnosticsRow = db
      .prepare(
        "SELECT labels FROM runtime_metrics WHERE metric_name = 'runtime_diagnostics' ORDER BY captured_at DESC, id DESC LIMIT 1",
      )
      .get() as { labels: string | null } | undefined;
    const signalPathRow = db
      .prepare(
        "SELECT labels FROM runtime_metrics WHERE metric_name = 'signal_path_activity' ORDER BY captured_at DESC, id DESC LIMIT 1",
      )
      .get() as { labels: string | null } | undefined;
    const httpErrorRows = db
      .prepare(
        `SELECT value, labels
           FROM runtime_metrics
          WHERE metric_name = 'http_error_class'
            AND captured_at >= ?`,
      )
      .all(new Date(Date.now() - 60 * 60_000).toISOString()) as Array<{
      value: number | null;
      labels: string | null;
    }>;
    const latency = parseJsonObject(latencyRow?.labels);
    const r23Cache = parseJsonObject(r23CacheRow?.labels);
    const runtimeDiagnostics = parseJsonObject(runtimeDiagnosticsRow?.labels);
    const signalPath = parseJsonObject(signalPathRow?.labels);
    const cooldownTelemetry = readObject(signalPath, "cooldown");
    const cooldownSignalDedupe = readObject(signalPath, "cooldownSignalDedupe");
    const eventLoopLag = readObject(runtimeDiagnostics, "eventLoopLagMs");
    const gcPause = readObject(runtimeDiagnostics, "gcPauseMs");
    const stageTimers = readObject(runtimeDiagnostics, "stageTimers");
    const v4AdmissionTelemetry = readObject(stream, "v4AdmissionTelemetry");
    const wsHeartbeat = readObject(stream, "wsHeartbeat");
    const wsWorkerMemory = readObject(stream, "wsWorkerMemory");
    const wsTracked = readNumber(stream, "trackedTokenCount") ?? 0;
    const eventsPerSec = readNumber(stream, "wsEventsReceivedPerSec") ?? 0;
    const rawWsRecords = readNumber(stream, "rawWsRecords") ?? 0;
    const rawWsRecordsPerSec = readNumber(stream, "rawWsRecordsPerSec") ?? 0;
    const parsedUpdates = readNumber(stream, "parsedUpdates") ?? 0;
    const parsedUpdatesPerSec = readNumber(stream, "parsedUpdatesPerSec") ?? 0;
    const emittedUpdates = readNumber(stream, "emittedUpdates") ?? 0;
    const emittedUpdatesPerSec = readNumber(stream, "emittedUpdatesPerSec") ?? 0;
    const noopUpdates = readNumber(stream, "noopUpdates") ?? 0;
    const noopUpdatesPerSec = readNumber(stream, "noopUpdatesPerSec") ?? 0;
    const suppressedTradingNoopCountTotal =
      readNumber(stream, "suppressedTradingNoopCountTotal") ?? 0;
    const suppressedTradingNoopPerSec = readNumber(stream, "suppressedTradingNoopPerSec") ?? 0;
    const suppressedTradingNoopByReason = readObject(stream, "suppressedTradingNoopByReason");
    const hubFilterChecked = readNumber(stream, "hubFilterChecked") ?? 0;
    const hubFilterCheckedPerSec = readNumber(stream, "hubFilterCheckedPerSec") ?? 0;
    const hubFilterPassed = readNumber(stream, "hubFilterPassed") ?? 0;
    const hubFilterPassedPerSec = readNumber(stream, "hubFilterPassedPerSec") ?? 0;
    const shardCount = readNumber(stream, "shardCount") ?? 0;
    const universeActive = marketCounts.activeTradable;
    const coveragePct = universeActive > 0 ? (wsTracked / universeActive) * 100 : 0;
    const discoveryBatchSize = config?.marketDataDiscoveryBatchSize ?? 50;
    const discoveryPollIntervalMs = config?.marketDataDiscoveryPollIntervalMs ?? 300_000;
    const untracked = Math.max(0, universeActive - wsTracked);
    const rotationCycleHours =
      discoveryBatchSize > 0
        ? (untracked / discoveryBatchSize) * (discoveryPollIntervalMs / 3_600_000)
        : 0;

    return ok({
      ws_tracked: wsTracked,
      universe_active: universeActive,
      markets_total: marketCounts.total,
      markets_active: marketCounts.active,
      coverage_pct: coveragePct,
      events_per_sec: eventsPerSec,
      raw_ws_records: rawWsRecords,
      raw_ws_records_per_sec: rawWsRecordsPerSec,
      parsed_updates: parsedUpdates,
      parsed_updates_per_sec: parsedUpdatesPerSec,
      emitted_updates: emittedUpdates,
      emitted_updates_per_sec: emittedUpdatesPerSec,
      noop_updates: noopUpdates,
      noop_updates_per_sec: noopUpdatesPerSec,
      suppressed_trading_noop_count_total: suppressedTradingNoopCountTotal,
      suppressed_trading_noop_per_sec: suppressedTradingNoopPerSec,
      suppressed_trading_noop_by_reason: {
        top_of_book_only: readNumber(suppressedTradingNoopByReason, "topOfBookOnly") ?? 0,
        book_only: readNumber(suppressedTradingNoopByReason, "bookOnly") ?? 0,
        last_trade_only: readNumber(suppressedTradingNoopByReason, "lastTradeOnly") ?? 0,
        tick_size_only: readNumber(suppressedTradingNoopByReason, "tickSizeOnly") ?? 0,
        mixed_non_critical: readNumber(suppressedTradingNoopByReason, "mixedNonCritical") ?? 0,
      },
      hub_filter_checked: hubFilterChecked,
      hub_filter_checked_per_sec: hubFilterCheckedPerSec,
      hub_filter_passed: hubFilterPassed,
      hub_filter_passed_per_sec: hubFilterPassedPerSec,
      shard_count: shardCount,
      rotation_cycle_hours: rotationCycleHours,
      positions_opened_24h: positionsOpened24h.cnt,
      plankton_reference_weekly: 2450,
      discovery_batch_size: discoveryBatchSize,
      discovery_poll_interval_ms: discoveryPollIntervalMs,
      max_tracked_tokens: config?.marketDataMaxTrackedTokens ?? null,
      decision_tick_latency_p95_ms: readNumber(latency, "p95Ms"),
      decision_tick_latency_p99_ms: readNumber(latency, "p99Ms"),
      r23_cache_hit_rate: readNumber(r23Cache, "hitRate"),
      event_loop_lag_max_ms: readNumber(eventLoopLag, "maxMs"),
      event_loop_lag_p95_ms: readNumber(eventLoopLag, "p95Ms"),
      gc_pause_max_ms: readNumber(gcPause, "maxMs"),
      stage_ipc_decode_max_ms: readStageTimerValue(stageTimers, "ipc_decode", "maxMs"),
      stage_ipc_decode_p95_ms: readStageTimerValue(stageTimers, "ipc_decode", "p95Ms"),
      stage_handle_worker_batch_max_ms: readStageTimerValue(
        stageTimers,
        "handle_worker_batch",
        "maxMs",
      ),
      stage_handle_worker_batch_p95_ms: readStageTimerValue(
        stageTimers,
        "handle_worker_batch",
        "p95Ms",
      ),
      stage_hub_dispatch_max_ms: readStageTimerValue(stageTimers, "hub_dispatch", "maxMs"),
      stage_hub_dispatch_p95_ms: readStageTimerValue(stageTimers, "hub_dispatch", "p95Ms"),
      stage_coalescing_flush_max_ms: readStageTimerValue(stageTimers, "coalescing_flush", "maxMs"),
      stage_coalescing_flush_p95_ms: readStageTimerValue(stageTimers, "coalescing_flush", "p95Ms"),
      stage_latency_summary_max_ms: readStageTimerValue(stageTimers, "latency_summary", "maxMs"),
      stage_latency_summary_p95_ms: readStageTimerValue(stageTimers, "latency_summary", "p95Ms"),
      stage_diagnostics_write_max_ms: readStageTimerValue(
        stageTimers,
        "diagnostics_write",
        "maxMs",
      ),
      stage_diagnostics_write_p95_ms: readStageTimerValue(
        stageTimers,
        "diagnostics_write",
        "p95Ms",
      ),
      stage_metrics_flush_total_max_ms: readStageTimerValue(
        stageTimers,
        "metrics_flush_total",
        "maxMs",
      ),
      stage_metrics_flush_total_p95_ms: readStageTimerValue(
        stageTimers,
        "metrics_flush_total",
        "p95Ms",
      ),
      stage_metrics_flush_sqlite_writes_max_ms: readStageTimerValue(
        stageTimers,
        "metrics_flush_sqlite_writes",
        "maxMs",
      ),
      stage_metrics_flush_sqlite_writes_p95_ms: readStageTimerValue(
        stageTimers,
        "metrics_flush_sqlite_writes",
        "p95Ms",
      ),
      stage_metrics_flush_snapshot_serialize_max_ms: readStageTimerValue(
        stageTimers,
        "metrics_flush_snapshot_serialize",
        "maxMs",
      ),
      stage_metrics_flush_snapshot_serialize_p95_ms: readStageTimerValue(
        stageTimers,
        "metrics_flush_snapshot_serialize",
        "p95Ms",
      ),
      stage_risk_signal_approval_max_ms: readStageTimerValue(
        stageTimers,
        "risk_signal_approval",
        "maxMs",
      ),
      stage_risk_signal_approval_p95_ms: readStageTimerValue(
        stageTimers,
        "risk_signal_approval",
        "p95Ms",
      ),
      stage_signal_to_order_bridge_max_ms: readStageTimerValue(
        stageTimers,
        "signal_to_order_bridge",
        "maxMs",
      ),
      stage_signal_to_order_bridge_p95_ms: readStageTimerValue(
        stageTimers,
        "signal_to_order_bridge",
        "p95Ms",
      ),
      stage_worker_non_update_events_max_ms: readStageTimerValue(
        stageTimers,
        "worker_non_update_events",
        "maxMs",
      ),
      stage_worker_non_update_events_p95_ms: readStageTimerValue(
        stageTimers,
        "worker_non_update_events",
        "p95Ms",
      ),
      stage_discovery_poll_publish_max_ms: readStageTimerValue(
        stageTimers,
        "discovery_poll_publish",
        "maxMs",
      ),
      stage_discovery_poll_publish_p95_ms: readStageTimerValue(
        stageTimers,
        "discovery_poll_publish",
        "p95Ms",
      ),
      stage_signal_path_aggregate_max_ms: readStageTimerValue(
        stageTimers,
        "signal_path_aggregate",
        "maxMs",
      ),
      stage_signal_path_aggregate_p95_ms: readStageTimerValue(
        stageTimers,
        "signal_path_aggregate",
        "p95Ms",
      ),
      stage_cooldown_registry_sweep_max_ms: readStageTimerValue(
        stageTimers,
        "cooldown_registry_sweep",
        "maxMs",
      ),
      stage_cooldown_registry_sweep_p95_ms: readStageTimerValue(
        stageTimers,
        "cooldown_registry_sweep",
        "p95Ms",
      ),
      signals_suppressed_early_cooldown_total:
        readNumber(cooldownTelemetry, "signalsSuppressedEarlyCooldownTotal") ?? 0,
      signals_suppressed_early_cooldown_by_token: readNumberRecord(
        cooldownTelemetry,
        "signalsSuppressedEarlyCooldownByToken",
      ),
      cooldown_registry_size: readNumber(cooldownTelemetry, "cooldownRegistrySize") ?? 0,
      cooldown_signal_dedupe_total: readNumber(cooldownSignalDedupe, "total") ?? 0,
      cooldown_signal_dedupe_early_only: readNumber(cooldownSignalDedupe, "earlyOnly") ?? 0,
      cooldown_signal_dedupe_late_only: readNumber(cooldownSignalDedupe, "lateOnly") ?? 0,
      cooldown_signal_dedupe_early_and_late: readNumber(cooldownSignalDedupe, "earlyAndLate") ?? 0,
      cooldown_signal_dedupe_duplicate_early:
        readNumber(cooldownSignalDedupe, "duplicateEarly") ?? 0,
      cooldown_signal_dedupe_duplicate_late: readNumber(cooldownSignalDedupe, "duplicateLate") ?? 0,
      http_errors_by_class_1h: aggregateHttpErrors(httpErrorRows),
      ws_heartbeat: wsHeartbeat,
      ws_worker_memory: wsWorkerMemory,
      v4_admit_count_total: readNumber(v4AdmissionTelemetry, "admitCountTotal") ?? 0,
      v4_admit_count_by_category: readNumberRecord(v4AdmissionTelemetry, "admitCountByCategory"),
      v4_reject_count_total: readNumber(v4AdmissionTelemetry, "rejectCountTotal") ?? 0,
      v4_reject_count_by_reason: readNumberRecord(v4AdmissionTelemetry, "rejectCountByReason"),
      v4_admit_rate: readNumber(v4AdmissionTelemetry, "admitRate") ?? 0,
      v4_seen_count_by_category: readNumberRecord(v4AdmissionTelemetry, "seenCountByCategory"),
      v4_admit_rate_by_category: readNumberRecord(v4AdmissionTelemetry, "admitRateByCategory"),
      v4_evaluated_total: readNumber(v4AdmissionTelemetry, "evaluatedTotal") ?? 0,
      captured_at: streamRow?.captured_at ?? null,
    });
  });

  app.get("/metrics/r23", async () => {
    const { db } = resolveActiveLedger(ledgerDb, controlDb, ledgerPool);
    const sinceIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const latestEvalRow = db
      .prepare(
        "SELECT labels, captured_at FROM runtime_metrics WHERE metric_name = 'algo_decision_eval_counters' ORDER BY captured_at DESC, id DESC LIMIT 1",
      )
      .get() as { labels: string | null; captured_at: string } | undefined;
    const latestEval = parseJsonObject(latestEvalRow?.labels);
    const latestCache = readObject(latestEval, "r23Cache");
    const latestLatency = readObject(latestEval, "decisionTickLatency");
    const fireRows = db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:00:00Z', signal_timestamp) AS hour,
                COUNT(*) AS count
           FROM decision_signal_log
          WHERE decision_rule_id = 'R23_DIP_TRIGGER'
            AND signal_timestamp >= ?
          GROUP BY hour
          ORDER BY hour`,
      )
      .all(sinceIso) as Array<{ hour: string | null; count: number }>;
    const skipRows = db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:00:00Z', created_at) AS hour,
                COALESCE(json_extract(payload, '$.reasonCode'), 'unknown') AS reason,
                COUNT(*) AS count
           FROM risk_events
          WHERE event_type = 'signal_suppressed'
            AND created_at >= datetime(?)
            AND json_extract(payload, '$.decisionRuleId') = 'R23_DIP_TRIGGER'
          GROUP BY hour, reason
          ORDER BY hour, reason`,
      )
      .all(sinceIso) as Array<{ hour: string | null; reason: string | null; count: number }>;
    const orderStats = db
      .prepare(
        `SELECT COUNT(*) AS ordersPlaced
           FROM orders
          WHERE decision_rule_id = 'R23_DIP_TRIGGER'
            AND created_at >= datetime(?)`,
      )
      .get(sinceIso) as { ordersPlaced: number };
    const fillStats = db
      .prepare(
        `SELECT COUNT(*) AS fills, COALESCE(SUM(size_usdc), 0) AS fillNotionalUsdc
           FROM fills
          WHERE decision_rule_id = 'R23_DIP_TRIGGER'
            AND filled_at >= datetime(?)`,
      )
      .get(sinceIso) as { fills: number; fillNotionalUsdc: number };

    return ok({
      current: {
        checked: readNumber(latestEval, "r23DipChecked") ?? 0,
        fired: readNumber(latestEval, "r23DipFired") ?? 0,
        no_history: readNumber(latestEval, "r23NoHistory") ?? 0,
        no_dip: readNumber(latestEval, "r23NoDip") ?? 0,
        cache_hit_rate: readNumber(latestCache, "hitRate"),
        cache_hits: readNumber(latestCache, "hits") ?? 0,
        cache_misses: readNumber(latestCache, "misses") ?? 0,
        cache_invocations: readNumber(latestCache, "invocations") ?? 0,
        decision_tick_latency_p95_ms: readNumber(latestLatency, "p95Ms"),
        decision_tick_latency_p99_ms: readNumber(latestLatency, "p99Ms"),
        captured_at: latestEvalRow?.captured_at ?? null,
      },
      hourly: {
        fires: fireRows
          .filter((row) => row.hour)
          .map((row) => ({ hour: row.hour as string, count: row.count })),
        skips: skipRows
          .filter((row) => row.hour)
          .map((row) => ({
            hour: row.hour as string,
            reason: row.reason ?? "unknown",
            count: row.count,
          })),
      },
      orders_24h: orderStats.ordersPlaced,
      fills_24h: fillStats.fills,
      fill_notional_usdc_24h: fillStats.fillNotionalUsdc,
      since: sinceIso,
    });
  });

  // ── GET /metrics/events ───────────────────────────────────────────────
  // Aggregate PnL + volume grouped by event_slug.
  // Per-profile: resolves the ledger via ledgerPool when profileId is provided,
  // otherwise falls back to the startup ledgerDb.
  app.get("/metrics/events", async (req, reply) => {
    const { profileId, limit } = req.query as { profileId?: string; limit?: string };
    if (!profileId) return reply.code(400).send(fail("BAD_REQUEST", "profileId required"));
    const db = ledgerPool?.get(profileId) ?? null;
    if (!db)
      return reply.code(404).send(fail("LEDGER_NOT_FOUND", `no ledger for profile ${profileId}`));
    const cap = Math.min(Number(limit ?? 20), 100);
    const rows = db
      .prepare(
        `SELECT m.event_slug AS eventSlug,
                SUM(p.realized_pnl) AS realizedPnl,
                SUM(p.current_value_usdc - p.cost_basis_usdc) AS unrealizedPnl,
                SUM(p.cost_basis_usdc) AS volumeUsdc,
                COUNT(*) AS positionCount
         FROM positions p
         JOIN markets m ON m.token_id = p.token_id
         WHERE m.event_slug IS NOT NULL
         GROUP BY m.event_slug
         ORDER BY ABS(IFNULL(SUM(p.realized_pnl),0) + IFNULL(SUM(p.current_value_usdc - p.cost_basis_usdc),0)) DESC
         LIMIT ?`,
      )
      .all(cap);
    return reply.send(ok({ events: rows }));
  });
};

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readNumber(obj: Record<string, unknown> | null, key: string): number | null {
  const value = obj?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readObject(
  obj: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const value = obj?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumberRecord(
  obj: Record<string, unknown> | null,
  key: string,
): Record<string, number> {
  const value = readObject(obj, key);
  if (!value) return {};
  const out: Record<string, number> = {};
  for (const [recordKey, recordValue] of Object.entries(value)) {
    if (typeof recordValue === "number" && Number.isFinite(recordValue)) {
      out[recordKey] = recordValue;
    }
  }
  return out;
}

function readStageTimerValue(
  stageTimers: Record<string, unknown> | null,
  stageName: string,
  key: "maxMs" | "p95Ms",
): number | null {
  return readNumber(readObject(stageTimers, stageName), key);
}

function aggregateHttpErrors(
  rows: Array<{ value: number | null; labels: string | null }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const labels = parseJsonObject(row.labels);
    const source = typeof labels?.source === "string" ? labels.source : "unknown";
    const errorClass = typeof labels?.errorClass === "string" ? labels.errorClass : "unknown";
    const key = `${source}:${errorClass}`;
    out[key] = (out[key] ?? 0) + (row.value ?? 0);
  }
  return out;
}
