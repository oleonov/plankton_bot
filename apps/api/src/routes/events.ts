/**
 * SSE endpoint — polling-based live updates.
 *
 * Polls SQLite for state changes and streams events to connected clients.
 *
 * Filter: `?types=position,order,fill,status,metrics,risk,transitions`
 * These are coarse categories. Each maps to one or more event names:
 *   position    → position:updated
 *   order       → order:created, order:filled, order:cancelled
 *   fill        → fill:new
 *   status      → status
 *   metrics     → metrics:snapshot
 *   risk        → risk:event
 *   transitions → transitions
 */

import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ledgerInstant } from "@krabs/db";
import { buildStatusSnapshot, resolveActiveLedger } from "./status.js";
import { normalizeRiskEvent } from "./normalize-risk-event.js";

interface EventsOpts {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
  ledgerPool?: import("../ledger-pool.js").LedgerPool;
  marketDataStaleThresholdMs?: number;
}

interface ChangeSnapshot {
  /**
   * Julian-day instants (via `ledgerInstant()`), not raw text: `positions.updated_at` and
   * `orders.updated_at` mix ISO and legacy space-format renderings, and a raw TEXT `MAX()`/`>`
   * comparison picks the lexically largest string, not the chronologically newest row, whenever
   * both renderings land on the same calendar day.
   */
  positions: number;
  orders: number;
  /**
   * Raw ISO text, deliberately unwrapped. `fills.filled_at` is single-rendering — 2,648/2,648
   * canonical on the live ledger — because its sole writer binds it explicitly, so the column
   * DEFAULT is unreachable. Wrapping it would buy nothing and cost `idx_fills_filled_at` twice
   * over: the `MAX()` below traverses the covering index on every 2 s tick of every SSE
   * connection, and the delta query — which runs only once a newer fill actually lands — degrades
   * from an indexed range to `SCAN fills` + a temp B-tree.
   */
  fills: string;
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
  status: ["status"],
  metrics: ["metrics:snapshot"],
  risk: ["risk:event"],
  transitions: ["transitions"],
};

function takeSnapshot(controlDb: Database.Database, ledgerDb: Database.Database): ChangeSnapshot {
  // Ledger tables — positions.updated_at / orders.updated_at mix ISO and legacy space-format
  // renderings, so MAX() must go through ledgerInstant() to pick the chronologically newest row
  // instead of the lexically largest string. fills.filled_at is single-rendering (see the
  // ChangeSnapshot doc) and stays raw so it keeps idx_fills_filled_at.
  const pos = ledgerDb
    .prepare(`SELECT MAX(${ledgerInstant("updated_at")}) as ts FROM positions`)
    .get() as { ts: number | null };
  const ord = ledgerDb
    .prepare(`SELECT MAX(${ledgerInstant("updated_at")}) as ts FROM orders`)
    .get() as { ts: number | null };
  const fill = ledgerDb.prepare("SELECT MAX(filled_at) as ts FROM fills").get() as {
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
    positions: pos.ts ?? 0,
    orders: ord.ts ?? 0,
    fills: fill.ts ?? "",
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
    // Heartbeat: emit an SSE comment every N data-ticks so idle connections
    // don't get killed by proxies / browsers when no DB changes occur.
    let heartbeatTickCount = 0;

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
              `SELECT * FROM positions WHERE ${ledgerInstant("updated_at")} > ?
               ORDER BY ${ledgerInstant("updated_at")} DESC LIMIT 20`,
            )
            .all(snapshot.positions) as Record<string, unknown>[];
          for (const row of rows) {
            sendEvent("position:updated", {
              positionId: row.position_id,
              tokenId: row.token_id,
              status: row.status,
              size: row.size,
              avgEntryPrice: row.avg_entry_price,
              updatedAt: row.updated_at,
            });
          }
        }

        if (next.orders !== snapshot.orders) {
          const rows = ledgerDb
            .prepare(
              `SELECT * FROM orders WHERE ${ledgerInstant("updated_at")} > ?
               ORDER BY ${ledgerInstant("updated_at")} DESC LIMIT 20`,
            )
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
              side: row.side,
              price: row.price,
              size: row.size,
              sizeUsdc: row.size_usdc,
              filledAt: row.filled_at,
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

        // Heartbeat every ~15s (7 ticks at 2s interval) — an SSE comment line
        // keeps idle connections alive through proxies / browser timeouts.
        heartbeatTickCount++;
        if (heartbeatTickCount >= 7) {
          heartbeatTickCount = 0;
          reply.raw.write(":ping\n\n");
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
