import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { buildStatusSnapshot } from "../routes/status.js";

interface FakeStatement {
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

function jsonMetric(labels: Record<string, unknown>): { labels: string } {
  return { labels: JSON.stringify(labels) };
}

function createFakeDb(runtimeMetrics: Record<string, Record<string, unknown>>): Database.Database {
  const lastMarketDataIso = new Date().toISOString();

  return {
    prepare(sql: string): FakeStatement {
      return {
        get: () => {
          if (sql.includes("FROM orders WHERE status IN")) return { cnt: 0 };
          if (sql.includes("FROM orders WHERE created_at >=")) return { cnt: 0 };
          if (sql.includes("COUNT(DISTINCT condition_id)")) return { cnt: 0 };
          if (sql.includes("COUNT(*) as cnt FROM positions WHERE status = 'open'")) return { cnt: 0 };
          if (sql.includes("FROM positions WHERE opened_at >=")) return { cnt: 0 };
          if (sql.includes("SUM(current_value_usdc)")) return { total: 0 };
          if (sql.includes("FROM bot_runs ORDER BY started_at DESC LIMIT 1")) {
            return { run_id: "run-1", mode: "simulation" };
          }
          if (sql.includes("metric_name = 'runtime_paused'")) return undefined;
          if (sql.includes("metric_name = 'last_reconciliation'")) return undefined;
          if (sql.includes("metric_name = 'market_data_last_update'")) {
            return { ts: lastMarketDataIso };
          }
          if (sql.includes("metric_name = 'market_data_source'")) return undefined;
          if (sql.includes("metric_name = 'execution_mode'")) return undefined;
          if (sql.includes("metric_name = 'reconciliation_drift'")) return undefined;
          if (sql.includes("metric_name = 'reconciliation_clean'")) return undefined;
          if (sql.includes("metric_name = 'market_data_poll_progress'")) return undefined;
          if (sql.includes("SUM(realized_pnl)")) return { total: 0 };
          if (sql.includes("metric_name = 'execution_queue'")) return undefined;
          if (sql.includes("metric_name = 'risk_event_volume'")) return undefined;
          if (sql.includes("metric_name = 'user_order_stream_activity'")) return undefined;
          if (sql.includes("metric_name = 'startup_adoption'")) return undefined;
          if (sql.includes("COUNT(*) as total")) return { total: 0, probeOnly: 0 };

          const metricMatch = sql.match(/metric_name = '([^']+)'/);
          const metricName = metricMatch?.[1];
          if (metricName) {
            const labels = runtimeMetrics[metricName];
            return labels ? jsonMetric(labels) : undefined;
          }

          throw new Error(`Unhandled fake DB get() query: ${sql}`);
        },
        all: () => {
          if (sql.includes("FROM runtime_metrics") && sql.includes("metric_name = 'infra_alert'")) {
            return [];
          }
          throw new Error(`Unhandled fake DB all() query: ${sql}`);
        },
      };
    },
  } as Database.Database;
}

describe("buildStatusSnapshot market-data stream telemetry", () => {
  it("includes marketDataStreamActivity when runtime metric is present", () => {
    const snapshot = buildStatusSnapshot(
      createFakeDb({
        market_data_stream_activity: {
          wsEnabled: true,
          windowStartMs: Date.now() - 60_000,
          wsEventsReceived: 120,
          wsEventsReceivedPerSec: 2,
          wsUpdatesApplied: 95,
          trackedTokenCount: 320,
          shardCount: 1,
          reconnectCount: 2,
          wsEventGapDetected: 1,
          wsLatencyMs: {
            count: 8,
            avgMs: 180,
            minMs: 75,
            p50Ms: 160,
            p95Ms: 290,
            maxMs: 320,
          },
          staleTokenCount: 14,
          fallbackPollCount: 14,
          fullBookTokenCount: 7,
          bookEventsReceived: 45,
          narrowSubscribeCount: 11,
          narrowUnsubscribeCount: 9,
          narrowRefCountLeaks: 0,
          marketResolvedEvents: 2,
          newMarketEvents: 3,
          gammaFallbackCount: 4,
          gammaFallbackTrackedTokenCount: 4,
        },
      }),
      120_000,
    );

    expect(snapshot.marketDataStreamActivity).toEqual({
      wsEnabled: true,
      windowStartMs: expect.any(Number),
      wsEventsReceived: 120,
      wsEventsReceivedPerSec: 2,
      wsUpdatesApplied: 95,
      trackedTokenCount: 320,
      shardCount: 1,
      reconnectCount: 2,
      wsEventGapDetected: 1,
      wsLatencyMs: {
        count: 8,
        avgMs: 180,
        minMs: 75,
        p50Ms: 160,
        p95Ms: 290,
        maxMs: 320,
      },
      staleTokenCount: 14,
      fallbackPollCount: 14,
      fullBookTokenCount: 7,
      bookEventsReceived: 45,
      narrowSubscribeCount: 11,
      narrowUnsubscribeCount: 9,
      narrowRefCountLeaks: 0,
      marketResolvedEvents: 2,
      newMarketEvents: 3,
      gammaFallbackCount: 4,
      gammaFallbackTrackedTokenCount: 4,
    });
  });
});
