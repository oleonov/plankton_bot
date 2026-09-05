import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { ledgerInstant } from "@krabs/db";
import { ok } from "../errors.js";
import { RUNTIME_HEARTBEAT_STALE_MS } from "../system-health-snapshot.js";

interface TradingActivityOpts {
  db: Database.Database;
}

interface TradingActivityQuery {
  days?: string;
}

interface SnapshotRow {
  trading_state: string;
  signals_produced: number;
  signals_approved: number;
  signals_rejected: number;
  captured_at: string;
  window_version: number | null;
  window_started_at: string | null;
  window_ended_at: string | null;
  orders_accepted: number | null;
  order_notional_usdc: number | null;
  fills_received: number | null;
  fill_notional_usdc: number | null;
  rejection_reasons_json: string | null;
}

type GapKind = "missing" | "collecting";

interface ActivityItem {
  tradingState: string;
  signalsProduced: number;
  signalsApproved: number;
  signalsRejected: number;
  capturedAt: string;
  windowVersion: 2;
  windowStartedAt: string;
  windowEndedAt: string;
  ordersAccepted: number;
  orderNotionalUsdc: number;
  fillsReceived: number;
  fillNotionalUsdc: number;
  rejectionReasons: Record<string, number>;
}

const MIN_WINDOW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_STATES = new Set([
  "PAUSED",
  "NO_SIGNALS",
  "ACTIVELY_TRADING",
  "EXITS_ONLY",
  "ALIVE_BUT_BLOCKED",
]);

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isAmount(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseReasons(raw: string | null): Record<string, number> | null {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (!entries.every(([key, value]) => key.length > 0 && isCount(value))) return null;
    return Object.fromEntries(entries) as Record<string, number>;
  } catch {
    return null;
  }
}

function parseV2Row(row: SnapshotRow): ActivityItem | null {
  if (row.window_version !== 2 || !VALID_STATES.has(row.trading_state)) return null;
  const startMs = Date.parse(row.window_started_at ?? "");
  const endMs = Date.parse(row.window_ended_at ?? "");
  const capturedMs = Date.parse(row.captured_at);
  const reasons = parseReasons(row.rejection_reasons_json);
  const counts = [
    row.signals_produced,
    row.signals_approved,
    row.signals_rejected,
    row.orders_accepted,
    row.fills_received,
  ];
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || !Number.isFinite(capturedMs))
    return null;
  if (endMs - startMs < MIN_WINDOW_MS || capturedMs < endMs) return null;
  if (!counts.every((value) => isCount(value)) || reasons == null) return null;
  if (!isAmount(row.order_notional_usdc) || !isAmount(row.fill_notional_usdc)) return null;
  return {
    tradingState: row.trading_state,
    signalsProduced: row.signals_produced,
    signalsApproved: row.signals_approved,
    signalsRejected: row.signals_rejected,
    capturedAt: row.captured_at,
    windowVersion: 2,
    windowStartedAt: row.window_started_at!,
    windowEndedAt: row.window_ended_at!,
    ordersAccepted: row.orders_accepted!,
    orderNotionalUsdc: row.order_notional_usdc,
    fillsReceived: row.fills_received!,
    fillNotionalUsdc: row.fill_notional_usdc,
    rejectionReasons: reasons,
  };
}

function mergeIntervals(items: ActivityItem[]): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const item of items) {
    const interval: [number, number] = [
      Date.parse(item.windowStartedAt),
      Date.parse(item.windowEndedAt),
    ];
    const previous = merged.at(-1);
    if (!previous || interval[0] > previous[1]) merged.push(interval);
    else previous[1] = Math.max(previous[1], interval[1]);
  }
  return merged;
}

function readLatestActiveRunId(db: Database.Database): string | null {
  const row = db
    .prepare(
      `SELECT run_id FROM bot_runs
        WHERE finished_at IS NULL
        ORDER BY ${ledgerInstant("started_at")} DESC, rowid DESC LIMIT 1`,
    )
    .get() as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

function readActiveWindowStart(
  db: Database.Database,
  rangeStartMs: number,
  rangeEndMs: number,
): number | null {
  const activeRunId = readLatestActiveRunId(db);
  if (!activeRunId) return null;
  const row = db
    .prepare(
      `SELECT labels, captured_at FROM runtime_metrics
        WHERE metric_name = 'signal_activity'
        ORDER BY ${ledgerInstant("captured_at")} DESC, id DESC LIMIT 1`,
    )
    .get() as { labels: string | null; captured_at: string } | undefined;
  if (!row) return null;
  try {
    const labels = JSON.parse(row.labels ?? "") as {
      durableWindowStartedAtMs?: unknown;
      botRunId?: unknown;
    };
    const startedAtMs = labels.durableWindowStartedAtMs;
    const heartbeatMs = Date.parse(row.captured_at);
    if (labels.botRunId !== activeRunId) return null;
    if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return null;
    if (!Number.isFinite(heartbeatMs)) return null;
    if (startedAtMs < rangeStartMs || startedAtMs >= rangeEndMs) return null;
    if (heartbeatMs < startedAtMs || heartbeatMs > rangeEndMs) return null;
    if (rangeEndMs - heartbeatMs > RUNTIME_HEARTBEAT_STALE_MS) return null;
    return startedAtMs;
  } catch {
    return null;
  }
}

function buildCoverage(
  items: ActivityItem[],
  startMs: number,
  endMs: number,
  activeStartMs: number | null,
) {
  const intervals = mergeIntervals(items);
  const gaps: Array<{ startAt: string; endAt: string; durationMs: number; kind: GapKind }> = [];
  let cursor = startMs;
  let coveredMs = 0;
  for (const [start, end] of intervals) {
    if (start > cursor) gaps.push(makeGap(cursor, start, "missing"));
    coveredMs += end - Math.max(start, cursor);
    cursor = Math.max(cursor, end);
  }
  if (cursor < endMs && activeStartMs !== null && activeStartMs >= cursor) {
    if (cursor < activeStartMs) gaps.push(makeGap(cursor, activeStartMs, "missing"));
    gaps.push(makeGap(activeStartMs, endMs, "collecting"));
  } else if (cursor < endMs) gaps.push(makeGap(cursor, endMs, "missing"));
  const rangeMs = endMs - startMs;
  return {
    requestedStartAt: new Date(startMs).toISOString(),
    requestedEndAt: new Date(endMs).toISOString(),
    coveredMs,
    gapMs: rangeMs - coveredMs,
    gapCount: gaps.length,
    coveragePercent: rangeMs > 0 ? (coveredMs / rangeMs) * 100 : 0,
    gaps,
  };
}

function makeGap(startMs: number, endMs: number, kind: GapKind) {
  return {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    durationMs: endMs - startMs,
    kind,
  };
}

export const tradingActivityRoutes: FastifyPluginAsync<TradingActivityOpts> = async (app, opts) => {
  app.get<{ Querystring: TradingActivityQuery }>("/metrics/trading-activity", async (request) => {
    const days = Math.min(Math.max(Number(request.query.days) || 14, 1), 14);
    const endMs = Date.now();
    const startMs = endMs - days * DAY_MS;
    const rows = opts.db
      .prepare(
        `SELECT trading_state, signals_produced, signals_approved, signals_rejected, captured_at,
                window_version, window_started_at, window_ended_at, orders_accepted,
                order_notional_usdc, fills_received, fill_notional_usdc, rejection_reasons_json
           FROM trading_state_snapshots
          WHERE ${ledgerInstant("captured_at")} >= ${ledgerInstant("?")}
            AND ${ledgerInstant("captured_at")} <= ${ledgerInstant("?")}
          ORDER BY ${ledgerInstant("captured_at")} ASC`,
      )
      .all(new Date(startMs).toISOString(), new Date(endMs).toISOString()) as SnapshotRow[];

    const excludedRows = { legacy: 0, invalid: 0, outsideRange: 0 };
    const items: ActivityItem[] = [];
    for (const row of rows) {
      if (row.window_version !== 2) {
        excludedRows.legacy++;
        continue;
      }
      const item = parseV2Row(row);
      if (!item) {
        excludedRows.invalid++;
        continue;
      }
      if (Date.parse(item.windowStartedAt) < startMs || Date.parse(item.windowEndedAt) > endMs) {
        excludedRows.outsideRange++;
        continue;
      }
      items.push(item);
    }
    items.sort((a, b) => Date.parse(a.windowStartedAt) - Date.parse(b.windowStartedAt));
    const activeStartMs = readActiveWindowStart(opts.db, startMs, endMs);
    const coverage = { ...buildCoverage(items, startMs, endMs, activeStartMs), excludedRows };
    return ok({ items, coverage });
  });
};
