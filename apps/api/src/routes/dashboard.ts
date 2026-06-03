import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import type { AppConfig } from "@krabs/config";
import { DEFAULT_REPRICE_CHAIN_MAX_COUNT } from "@krabs/domain";
import { resolveActiveLedger } from "../active-ledger.js";
import { computeExecutionTelemetry } from "../execution-telemetry.js";
import { ok } from "../errors.js";
import type { LedgerPool } from "../ledger-pool.js";

interface DashboardOpts {
  ledgerDb: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
  config?: AppConfig;
}

interface ClosedPositionRow {
  total: number;
  wins: number;
}

interface ExitMultipleRow {
  multiple: number;
}

interface HoldResolutionRow {
  id: string;
  token_id: string;
  condition_id: string | null;
  position_id: string | null;
  source_order_id: string | null;
  source_signal_id: string | null;
  status: string;
  marker_created_at: string;
  expected_resolution_at: string | null;
  attempt_count_for_redeem: number;
  exit_pnl_pct: number | null;
  stale_reason: string;
  liveness_verdict: string;
  redeem_quarantine_observed_at: string | null;
  alert_emitted_at: string | null;
  cleared_at: string | null;
  clear_reason: string | null;
  metadata_json: string | null;
}

const DAY_MS = 24 * 60 * 60_000;
const HOLD_RESOLUTION_STATUSES = new Set([
  "active",
  "resolved_zero_loss",
  "recovered",
  "cancelled",
  "superseded",
]);

export const dashboardRoutes: FastifyPluginAsync<DashboardOpts> = async (app, opts) => {
  const { ledgerDb, controlDb, ledgerPool, config } = opts;

  app.get("/dashboard/kpi", async () => {
    const { db } = resolveActiveLedger(ledgerDb, controlDb, ledgerPool);
    const since7d = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const since24h = new Date(Date.now() - DAY_MS).toISOString();

    const overall = readClosedWinrate(db, since7d, "");
    const sellClosed = readClosedWinrate(
      db,
      since7d,
      `AND EXISTS (
         SELECT 1
           FROM fills f
          WHERE f.token_id = positions.token_id
            AND LOWER(f.side) = 'sell'
            AND f.filled_at >= positions.opened_at
            AND f.filled_at <= COALESCE(positions.closed_at, datetime('now'))
       )
       AND NOT EXISTS (
         SELECT 1
           FROM settlement_ledger sl
          WHERE sl.position_id = positions.position_id
       )`,
    );
    const resolvedClosed = readClosedWinrate(
      db,
      since7d,
      `AND EXISTS (
         SELECT 1
           FROM settlement_ledger sl
          WHERE sl.position_id = positions.position_id
       )`,
    );

    const exitMultiples = readExitMultiples(db, since7d);
    const fills24h = computeExecutionTelemetry(db, { sinceIso: since24h });
    const stream = parseLatestLabels(db, "market_data_stream_activity");
    const diagnostics = parseLatestLabels(db, "runtime_diagnostics");
    const eventLoopLag = readObject(diagnostics, "eventLoopLagMs");
    const latestRun = db
      .prepare("SELECT mode FROM bot_runs ORDER BY started_at DESC LIMIT 1")
      .get() as { mode: string } | undefined;
    const paused = (
      db
        .prepare(
          "SELECT value FROM runtime_metrics WHERE metric_name = 'runtime_paused' ORDER BY captured_at DESC, id DESC LIMIT 1",
        )
        .get() as { value: number } | undefined
    )?.value;

    const openPositionsCount = readOpenPositionCount(db);
    const stuckPositionsCount = readStuckPositionCount(db);
    const activeHoldResolutionCount = readActiveHoldResolutionCount(db);
    const wsTracked = readNumber(stream, "trackedTokenCount") ?? 0;
    const wsTotal =
      readNumber(stream, "universeTokenCount") ??
      readNumber(stream, "totalTokenCount") ??
      readNumber(stream, "universeSize") ??
      wsTracked;
    const lagP95 = readNumber(eventLoopLag, "p95Ms") ?? 0;
    const restarts24h = readRuntimeEventCount(db, since24h, [
      "runtime_restart",
      "process_restart",
      "container_restart",
    ]);
    const oom24h = readRuntimeEventCount(db, since24h, [
      "oom_kill",
      "container_oom_kill",
      "runtime_oom_kill",
    ]);
    const mode = latestRun?.mode ?? config?.runtimeMode ?? "simulation";
    const isPaused = paused === 1;

    const stuckSeverity: HealthSeverity =
      stuckPositionsCount >= 4 ? "crit" : stuckPositionsCount >= 1 ? "warn" : "ok";
    const lagSeverity: HealthSeverity = lagP95 >= 1500 ? "crit" : lagP95 >= 200 ? "warn" : "ok";
    const restartSeverity: HealthSeverity =
      restarts24h >= 3 || oom24h >= 1 ? "crit" : restarts24h >= 1 ? "warn" : "ok";
    const modeSeverity: HealthSeverity =
      mode === "degraded" ? "crit" : isPaused || mode !== "live-lite" ? "warn" : "ok";
    const holdResolutionSeverity: HealthSeverity = activeHoldResolutionCount > 0 ? "warn" : "ok";
    const healthSeverity = worseSeverity(
      stuckSeverity,
      lagSeverity,
      restartSeverity,
      modeSeverity,
      holdResolutionSeverity,
    );

    const rate24h = openPositionsCount > 0 ? fills24h.totalFills / openPositionsCount : 0;

    return ok({
      winrate_7d: {
        value: percent(overall.wins, overall.total),
        wins: overall.wins,
        losses: Math.max(0, overall.total - overall.wins),
        total: overall.total,
        sell_closed_pct: percent(sellClosed.wins, sellClosed.total),
        resolved_closed_pct: percent(resolvedClosed.wins, resolvedClosed.total),
      },
      exit_multiple_7d: {
        median: percentile(exitMultiples, 0.5),
        p90: percentile(exitMultiples, 0.9),
        count: exitMultiples.length,
      },
      fills_24h: {
        total: fills24h.totalFills,
        maker: fills24h.makerFills,
        taker: fills24h.takerFills,
        unknown: fills24h.unknownFills,
        maker_ratio: fills24h.makerRatio == null ? 0 : fills24h.makerRatio * 100,
        volume_usd: fills24h.volumeUsdc,
        rate_per_position: rate24h,
      },
      open_positions_count: openPositionsCount,
      stuck_positions_count: stuckPositionsCount,
      hold_resolution_active_count: activeHoldResolutionCount,
      health: {
        severity: healthSeverity,
        ws_tracked: wsTracked,
        ws_total: wsTotal,
        lag_p95_ms: lagP95,
        restarts_24h: restarts24h,
        oom_24h: oom24h,
        mode,
        paused: isPaused,
        checks: [
          {
            key: "stuck",
            severity: stuckSeverity,
            label: "Stuck positions",
            value: String(stuckPositionsCount),
          },
          {
            key: "lag",
            severity: lagSeverity,
            label: "WS lag p95",
            value: `${Math.round(lagP95)} ms`,
          },
          {
            key: "restart",
            severity: restartSeverity,
            label: "Restarts · OOM (24h)",
            value: `${restarts24h} · ${oom24h}`,
          },
          {
            key: "mode",
            severity: modeSeverity,
            label: "Mode",
            value: `${mode.toUpperCase()}${isPaused ? " · PAUSED" : ""}`,
          },
          {
            key: "hold_resolution",
            severity: holdResolutionSeverity,
            label: "Hold resolution",
            value: String(activeHoldResolutionCount),
          },
        ],
      },
    });
  });

  app.get("/hold-resolution", async (request) => {
    const { db } = resolveActiveLedger(ledgerDb, controlDb, ledgerPool);
    const query = request.query as {
      status?: string;
      tokenId?: string;
      limit?: string | number;
    };
    const status = normalizeHoldStatus(query.status);
    const limit = clampLimit(query.limit, 100, 500);
    const predicates: string[] = [];
    const params: Array<string | number> = [];

    if (status) {
      predicates.push("status = ?");
      params.push(status);
    }
    if (query.tokenId) {
      predicates.push("token_id = ?");
      params.push(query.tokenId);
    }

    const where = predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "";
    const rows = db
      .prepare(
        `SELECT id, token_id, condition_id, position_id, source_order_id, source_signal_id,
                status, marker_created_at, expected_resolution_at, attempt_count_for_redeem,
                exit_pnl_pct, stale_reason, liveness_verdict, redeem_quarantine_observed_at,
                alert_emitted_at, cleared_at, clear_reason, metadata_json
           FROM hold_resolution_states
          ${where}
          ORDER BY marker_created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(...params, limit) as HoldResolutionRow[];

    return ok({
      rows: rows.map((row) => ({
        ...row,
        metadata: parseJsonObject(row.metadata_json),
      })),
      count: rows.length,
      status: status ?? "all",
    });
  });
};

type HealthSeverity = "ok" | "warn" | "crit";

function worseSeverity(...severities: HealthSeverity[]): HealthSeverity {
  if (severities.includes("crit")) return "crit";
  if (severities.includes("warn")) return "warn";
  return "ok";
}

function readOpenPositionCount(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM positions WHERE status = 'open'").get() as {
    cnt: number;
  };
  return row.cnt;
}

function readClosedWinrate(
  db: Database.Database,
  sinceIso: string,
  extraPredicate: string,
): ClosedPositionRow {
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins
         FROM positions
        WHERE status = 'closed'
          AND closed_at IS NOT NULL
          AND closed_at >= ?
          ${extraPredicate}`,
    )
    .get(sinceIso) as ClosedPositionRow;
}

function readExitMultiples(db: Database.Database, sinceIso: string): number[] {
  const rows = db
    .prepare(
      `SELECT SUM(f.size_usdc) / NULLIF(SUM(f.size), 0) / p.avg_entry_price AS multiple
         FROM positions p
         JOIN fills f ON f.token_id = p.token_id
        WHERE p.status = 'closed'
          AND p.closed_at IS NOT NULL
          AND p.closed_at >= ?
          AND p.avg_entry_price > 0
          AND LOWER(f.side) = 'sell'
          AND f.filled_at >= p.opened_at
          AND f.filled_at <= p.closed_at
        GROUP BY p.position_id, p.avg_entry_price
       HAVING multiple IS NOT NULL AND multiple >= 2.0`,
    )
    .all(sinceIso) as ExitMultipleRow[];
  return rows
    .map((row) => row.multiple)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
}

function readStuckPositionCount(db: Database.Database): number {
  const row = db
    .prepare(
      `WITH stuck AS (
         SELECT p.token_id
           FROM positions p
           JOIN leg_states ls ON ls.token_id = p.token_id
          WHERE p.status = 'open'
            AND COALESCE(ls.sell_count, 0) = 0
            AND COALESCE(ls.reprice_chain_count_24h, 0) >= ?
            AND julianday('now') - julianday(p.opened_at) > 0.5
         UNION
         SELECT hrs.token_id
           FROM hold_resolution_states hrs
           JOIN positions p ON p.token_id = hrs.token_id
          WHERE hrs.status = 'active'
            AND p.status = 'open'
       )
       SELECT COUNT(*) AS cnt FROM stuck`,
    )
    .get(DEFAULT_REPRICE_CHAIN_MAX_COUNT) as { cnt: number };
  return row.cnt;
}

function readActiveHoldResolutionCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS cnt FROM hold_resolution_states WHERE status = 'active'")
    .get() as { cnt: number };
  return row.cnt;
}

function readRuntimeEventCount(
  db: Database.Database,
  sinceIso: string,
  metricNames: readonly string[],
): number {
  const placeholders = metricNames.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(value), 0) AS total
         FROM runtime_metrics
        WHERE captured_at >= ?
          AND metric_name IN (${placeholders})`,
    )
    .get(sinceIso, ...metricNames) as { total: number | null };
  return row.total ?? 0;
}

function parseLatestLabels(
  db: Database.Database,
  metricName: string,
): Record<string, unknown> | null {
  const row = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
    )
    .get(metricName) as { labels: string | null } | undefined;
  return parseJsonObject(row?.labels);
}

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

function readObject(
  obj: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const value = obj?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(obj: Record<string, unknown> | null, key: string): number | null {
  const value = obj?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeHoldStatus(raw: string | undefined): string | null {
  if (!raw) return "active";
  if (raw === "all") return null;
  return HOLD_RESOLUTION_STATUSES.has(raw) ? raw : "active";
}

function clampLimit(raw: string | number | undefined, defaultValue: number, max: number): number {
  const value = typeof raw === "number" ? raw : raw == null ? defaultValue : Number(raw);
  if (!Number.isFinite(value)) return defaultValue;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function percent(wins: number, total: number): number {
  return total > 0 ? (wins / total) * 100 : 0;
}

function percentile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(q * sortedValues.length) - 1),
  );
  return sortedValues[index] ?? 0;
}
