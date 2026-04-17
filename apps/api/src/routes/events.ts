/**
 * SSE endpoint — polling-based live updates.
 *
 * Polls SQLite for state changes and streams events to connected clients.
 *
 * Filter: `?types=position,order,fill,family,status,metrics,risk,transitions`
 * These are coarse categories. Each maps to one or more event names:
 *   position    → position:updated
 *   order       → order:created, order:filled, order:cancelled
 *   fill        → fill:new
 *   family      → family:state_changed
 *   status      → status
 *   metrics     → metrics:snapshot
 *   risk        → risk:event
 *   transitions → transitions
 */

import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { buildStatusSnapshot, resolveActiveLedger } from "./status.js";
import { normalizeRiskEvent } from "./normalize-risk-event.js";

interface EventsOpts {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
  ledgerPool?: import("../ledger-pool.js").LedgerPool;
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
  transitions: string;
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
  transitions: ["transitions"],
};

function takeSnapshot(controlDb: Database.Database, ledgerDb: Database.Database): ChangeSnapshot {
  // Ledger tables
  const pos = ledgerDb.prepare("SELECT MAX(updated_at) as ts FROM positions").get() as {
    ts: string | null;
  };
  const ord = ledgerDb.prepare("SELECT MAX(updated_at) as ts FROM orders").get() as {
    ts: string | null;
  };
  const fill = ledgerDb.prepare("SELECT MAX(filled_at) as ts FROM fills").get() as {
    ts: string | null;
  };
  const fam = ledgerDb.prepare("SELECT MAX(updated_at) as ts FROM family_runtime_state").get() as {
    ts: string | null;
  };
  const risk = ledgerDb.prepare("SELECT MAX(created_at) as ts FROM risk_events").get() as {
    ts: string | null;
  };
  const botRun = ledgerDb.prepare("SELECT MAX(started_at) as ts FROM bot_runs").get() as {
    ts: string | null;
  };
  const reconMetric = ledgerDb
    .prepare(
      "SELECT MAX(captured_at) as ts FROM runtime_metrics WHERE metric_name IN ('last_reconciliation','market_data_last_update','market_data_poll_progress')",
    )
    .get() as { ts: string | null };

  // Control tables
  const opCmd = controlDb
    .prepare("SELECT MAX(applied_at) as ts FROM operator_commands WHERE status = 'applied'")
    .get() as { ts: string | null };
  const transitionMaxTs = controlDb
    .prepare("SELECT MAX(created_at) FROM state_transitions")
    .pluck()
    .get() as string | null;

  return {
    positions: pos.ts ?? "",
    orders: ord.ts ?? "",
    fills: fill.ts ?? "",
    families: fam.ts ?? "",
    riskEvents: risk.ts ?? "",
    statusHash: `${opCmd.ts ?? ""}|${botRun.ts ?? ""}|${reconMetric.ts ?? ""}`,
    transitions: transitionMaxTs ?? "",
  };
}

export const eventsRoutes: FastifyPluginAsync<EventsOpts> = async (app, opts) => {
  const { controlDb, ledgerDb: startupLedger } = opts;
  const staleMs = opts.marketDataStaleThresholdMs ?? 120_000;

  /** Resolve the active profile's ledger, falling back to startup ledger. */
  function activeLedger(): Database.Database {
    const { db } = resolveActiveLedger(startupLedger, controlDb, opts.ledgerPool);
    return db;
  }

  app.get<{ Querystring: { types?: string } }>("/events", async (request, reply) => {
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

    // Initial snapshot uses the active ledger at connection time
    let snapshot = takeSnapshot(controlDb, activeLedger());
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
        // Resolve the active ledger on every tick — it may change after a profile switch
        const ledgerDb = activeLedger();
        const next = takeSnapshot(controlDb, ledgerDb);

        if (next.positions !== snapshot.positions) {
          const rows = ledgerDb
            .prepare(
              "SELECT * FROM positions WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20",
            )
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
          const rows = ledgerDb
            .prepare("SELECT * FROM orders WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20")
            .all(snapshot.orders) as Record<string, unknown>[];
          for (const row of rows) {
            const status = row.status as string;
            const eventType =
              status === "filled"
                ? "order:filled"
                : status === "cancelled"
                  ? "order:cancelled"
                  : "order:created";
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
          const rows = ledgerDb
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
          const rows = ledgerDb
            .prepare(
              "SELECT * FROM family_runtime_state WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 20",
            )
            .all(snapshot.families) as Record<string, unknown>[];
          for (const row of rows) {
            sendEvent("family:state_changed", {
              familyId: row.family_id,
              openValueUsdc: row.open_value_usdc,
              openPositionCount: row.open_position_count,
              updatedAt: row.updated_at,
            });
          }
        }

        // Emit status event (same shape as GET /status) on any status-affecting change
        if (next.statusHash !== snapshot.statusHash) {
          const active = resolveActiveLedger(startupLedger, controlDb, opts.ledgerPool);
          sendEvent("status", buildStatusSnapshot(active.db, staleMs, active.profile, controlDb));
        }

        // Emit risk:event when new risk events appear
        if (next.riskEvents !== snapshot.riskEvents) {
          const rows = ledgerDb
            .prepare(
              "SELECT * FROM risk_events WHERE created_at > ? ORDER BY created_at DESC LIMIT 20",
            )
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

        // Emit transitions when new state transitions appear
        if (next.transitions !== snapshot.transitions) {
          sendEvent("transitions", { latestAt: next.transitions });
        }

        // Emit metrics:snapshot every ~30s (15 ticks at 2s interval)
        metricsTickCount++;
        if (metricsTickCount >= 15) {
          metricsTickCount = 0;

          const positions = ledgerDb
            .prepare("SELECT status, COUNT(*) as cnt FROM positions GROUP BY status")
            .all() as Array<{ status: string; cnt: number }>;
          const totalFills = ledgerDb
            .prepare("SELECT COUNT(*) as cnt, COALESCE(SUM(size_usdc),0) as volume FROM fills")
            .get() as { cnt: number; volume: number };
          const pnl = ledgerDb
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
  });
};
