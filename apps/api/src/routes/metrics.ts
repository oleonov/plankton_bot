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
    const eventLoopLag = readObject(runtimeDiagnostics, "eventLoopLagMs");
    const gcPause = readObject(runtimeDiagnostics, "gcPauseMs");
    const v4AdmissionTelemetry = readObject(stream, "v4AdmissionTelemetry");
    const wsTracked = readNumber(stream, "trackedTokenCount") ?? 0;
    const eventsPerSec = readNumber(stream, "wsEventsReceivedPerSec") ?? 0;
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
      http_errors_by_class_1h: aggregateHttpErrors(httpErrorRows),
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
