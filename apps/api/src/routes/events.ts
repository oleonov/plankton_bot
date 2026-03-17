/**
 * SSE endpoint — polling-based live updates.
 *
 * Polls SQLite for state changes and streams events to connected clients.
 *
 * Filter: `?types=position,order,fill,family,status,metrics`
 * These are coarse categories. Each maps to one or more event names:
 *   position → position:updated
 *   order    → order:created, order:filled, order:cancelled
 *   fill     → fill:new
 *   family   → family:state_changed
 *   status   → status
 *   metrics  → metrics:snapshot
 *
 * Auth via `?token=<api_key>` (EventSource can't send headers).
 */

import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { buildStatusSnapshot } from "./status.js";
import { normalizeRiskEvent } from "./normalize-risk-event.js";

interface EventsOpts {
  db: Database.Database;
  apiKey: string | undefined;
  marketDataStaleThresholdMs?: number;
}

interface ChangeSnapshot {
  positions: string;
  orders: string;
  fills: string;
  families: string;
  riskEvents: string;
  /** Composite key: changes in operator_commands OR bot_runs OR runtime_metrics trigger status events. */
  statusHash: string;
}

/** Maps coarse filter names to the fine-grained event types they include. */
const CATEGORY_TO_EVENTS: Record<string, string[]> = {
  position: ["position:updated"],
  order: ["order:created", "order:filled", "order:cancelled"],
  fill: ["fill:new"],
  family: ["family:state_changed"],
  status: ["status"],
  metrics: ["metrics:snapshot"],
  risk: ["risk:event"],
};

function takeSnapshot(db: Database.Database): ChangeSnapshot {
  const pos = db
    .prepare("SELECT MAX(updated_at) as ts FROM positions")
    .get() as { ts: string | null };
  const ord = db
    .prepare("SELECT MAX(updated_at) as ts FROM orders")
    .get() as { ts: string | null };
  const fill = db
    .prepare("SELECT MAX(filled_at) as ts FROM fills")
    .get() as { ts: string | null };
  const fam = db
    .prepare("SELECT MAX(updated_at) as ts FROM family_runtime_state")
    .get() as { ts: string | null };
  const risk = db
    .prepare("SELECT MAX(created_at) as ts FROM risk_events")
    .get() as { ts: string | null };

  // Composite hash for status-affecting tables
  const opCmd = db
    .prepare("SELECT MAX(applied_at) as ts FROM operator_commands WHERE status = 'applied'")
    .get() as { ts: string | null };
  const botRun = db
    .prepare("SELECT MAX(started_at) as ts FROM bot_runs")
    .get() as { ts: string | null };
  const reconMetric = db
    .prepare("SELECT MAX(captured_at) as ts FROM runtime_metrics WHERE metric_name IN ('last_reconciliation','market_data_last_update','market_data_poll_progress')")
    .get() as { ts: string | null };

  return {
    positions: pos.ts ?? "",
    orders: ord.ts ?? "",
    fills: fill.ts ?? "",
    families: fam.ts ?? "",
    riskEvents: risk.ts ?? "",
    statusHash: `${opCmd.ts ?? ""}|${botRun.ts ?? ""}|${reconMetric.ts ?? ""}`,
  };
}

export const eventsRoutes: FastifyPluginAsync<EventsOpts> = async (app, opts) => {
  const staleMs = opts.marketDataStaleThresholdMs ?? 120_000;

  app.get<{ Querystring: { types?: string; token?: string } }>(
    "/events",
    async (request, reply) => {
      // Build allowed event set from coarse filter categories
      let allowedEvents: Set<string> | null = null;
      if (request.query.types) {
        allowedEvents = new Set<string>();
        for (const cat of request.query.types.split(",")) {
          const events = CATEGORY_TO_EVENTS[cat.trim()];
          if (events) {
            for (const e of events) allowedEvents.add(e);
          }
        }
      }

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      let snapshot = takeSnapshot(opts.db);
      let alive = true;
      let metricsTickCount = 0;

      const sendEvent = (type: string, data: unknown) => {
        if (allowedEvents && !allowedEvents.has(type)) return;
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Initial heartbeat
      reply.raw.write(":connected\n\n");

      const interval = setInterval(() => {
        if (!alive) {
          clearInterval(interval);
          return;
        }

        try {
          const next = takeSnapshot(opts.db);

          if (next.positions !== snapshot.positions) {
            const rows = opts.db
              .prepare("SELECT * FROM positions WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20")
              .all(snapshot.positions) as Record<string, unknown>[];
            for (const row of rows) {
              sendEvent("position:updated", {
                positionId: row.position_id,
                tokenId: row.token_id,
                familyId: row.family_id,
                status: row.status,
                size: row.size,
                avgEntryPrice: row.avg_entry_price,
                updatedAt: row.updated_at,
              });
            }
          }

          if (next.orders !== snapshot.orders) {
            const rows = opts.db
              .prepare("SELECT * FROM orders WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20")
              .all(snapshot.orders) as Record<string, unknown>[];
            for (const row of rows) {
              const status = row.status as string;
              const eventType =
                status === "filled" ? "order:filled" :
                status === "cancelled" ? "order:cancelled" :
                "order:created";
              sendEvent(eventType, {
                orderId: row.order_id,
                clientOrderId: row.client_order_id,
                tokenId: row.token_id,
                familyId: row.family_id,
                side: row.side,
                price: row.price,
                size: row.size,
                status,
                updatedAt: row.updated_at,
              });
            }
          }

          if (next.fills !== snapshot.fills) {
            const rows = opts.db
              .prepare("SELECT * FROM fills WHERE filled_at > ? ORDER BY filled_at DESC LIMIT 20")
              .all(snapshot.fills) as Record<string, unknown>[];
            for (const row of rows) {
              sendEvent("fill:new", {
                fillId: row.fill_id,
                orderId: row.order_id,
                tokenId: row.token_id,
                familyId: row.family_id,
                side: row.side,
                price: row.price,
                size: row.size,
                sizeUsdc: row.size_usdc,
                filledAt: row.filled_at,
              });
            }
          }

          if (next.families !== snapshot.families) {
            const rows = opts.db
              .prepare("SELECT * FROM family_runtime_state WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20")
              .all(snapshot.families) as Record<string, unknown>[];
            for (const row of rows) {
              sendEvent("family:state_changed", {
                familyId: row.family_id,
                runtimeMode: row.runtime_mode,
                openValueUsdc: row.open_value_usdc,
                openPositionCount: row.open_position_count,
                quarantineReason: row.quarantine_reason,
                updatedAt: row.updated_at,
              });
            }
          }

          // Emit status event (same shape as GET /status) on any status-affecting change
          if (next.statusHash !== snapshot.statusHash) {
            sendEvent("status", buildStatusSnapshot(opts.db, staleMs));
          }

          // Emit risk:event when new risk events appear
          if (next.riskEvents !== snapshot.riskEvents) {
            const rows = opts.db
              .prepare("SELECT * FROM risk_events WHERE created_at > ? ORDER BY created_at DESC LIMIT 20")
              .all(snapshot.riskEvents) as Array<{
                id: number;
                event_type: string;
                family_id: string | null;
                payload: string;
                created_at: string;
              }>;
            for (const row of rows) {
              sendEvent("risk:event", normalizeRiskEvent(row));
            }
          }

          // Emit metrics:snapshot every ~30s (15 ticks at 2s interval)
          metricsTickCount++;
          if (metricsTickCount >= 15) {
            metricsTickCount = 0;

            const positions = opts.db
              .prepare("SELECT status, COUNT(*) as cnt FROM positions GROUP BY status")
              .all() as Array<{ status: string; cnt: number }>;
            const totalFills = opts.db
              .prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(size_usdc),0) as volume FROM fills")
              .get() as { cnt: number; volume: number };
            const pnl = opts.db
              .prepare("SELECT COALESCE(SUM(realized_pnl),0) as total FROM positions")
              .get() as { total: number };

            sendEvent("metrics:snapshot", {
              positions: Object.fromEntries(positions.map((r) => [r.status, r.cnt])),
              fills: { count: totalFills.cnt, volumeUsdc: totalFills.volume },
              totalRealizedPnl: pnl.total,
            });
          }

          snapshot = next;
        } catch {
          // DB query failed — skip this tick
        }
      }, 2000);

      request.raw.on("close", () => {
        alive = false;
        clearInterval(interval);
      });

      // Keep the request open — SSE stream stays open until client disconnects
      await new Promise(() => {});
    },
  );
};
