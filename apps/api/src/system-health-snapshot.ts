/**
 * Shared system-health snapshot — the single computation used by BOTH the
 * `/system-health` route and the StatusHistorySampler, so the live screen and
 * the recorded history can never disagree on "what was healthy now".
 *
 * Reads are isolated via `safe()` so a missing probe degrades to a safe default
 * rather than throwing. The per-module severity *rule* (`computeModuleSeverities`)
 * is pure given its inputs; the rank order + closed series enum come from
 * `@krabs/domain`.
 */

import type Database from "better-sqlite3";
import { worstStatusSev, type StatusSev, type StatusSeries } from "@krabs/domain";

export type Sev = StatusSev;

export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export interface InfraAlertRow {
  code: string;
  severity: "warning" | "error";
  source: string;
  capturedAt: string;
}

export function readInfraAlerts(db: Database.Database, sinceMs: number): InfraAlertRow[] {
  const sinceIso = new Date(Date.now() - sinceMs).toISOString();
  return safe(() => {
    const rows = db
      .prepare(
        `SELECT labels, captured_at FROM runtime_metrics
          WHERE metric_name = 'infra_alert' AND captured_at >= ?
          ORDER BY captured_at DESC LIMIT 500`,
      )
      .all(sinceIso) as Array<{ labels: string | null; captured_at: string }>;
    const out: InfraAlertRow[] = [];
    for (const row of rows) {
      if (!row.labels) continue;
      const parsed = JSON.parse(row.labels) as {
        code?: string;
        severity?: string;
        source?: string;
      };
      if (!parsed.code || !parsed.source) continue;
      out.push({
        code: parsed.code,
        severity: parsed.severity === "warning" ? "warning" : "error",
        source: parsed.source,
        capturedAt: row.captured_at,
      });
    }
    return out;
  }, []);
}

/** Open circuit breakers = BREAKER/CIRCUIT alerts seen in the last hour. */
export function countOpenBreakers(alerts: InfraAlertRow[]): number {
  const oneHourAgo = Date.now() - 3_600_000;
  return alerts.filter(
    (a) => /BREAKER|CIRCUIT/i.test(a.code) && Date.parse(a.capturedAt) >= oneHourAgo,
  ).length;
}

export function readControlState(controlDb: Database.Database | undefined): {
  paused: boolean;
  status: string;
} {
  if (!controlDb) return { paused: false, status: "unknown" };
  return safe(
    () => {
      const row = controlDb
        .prepare("SELECT runtime_status, paused FROM runtime_control_state WHERE id = 1")
        .get() as { runtime_status?: string; paused?: number } | undefined;
      return { paused: (row?.paused ?? 0) === 1, status: row?.runtime_status ?? "unknown" };
    },
    { paused: false, status: "unknown" },
  );
}

// Real market-data freshness from the runtime metric the bot writes on every
// MarketSnapshotReceived. null when the metric is absent (unknown) — we never
// claim "fresh" without evidence.
export function readMarketDataStale(
  db: Database.Database,
  staleThresholdMs: number,
): boolean | null {
  return safe<boolean | null>(() => {
    const row = db
      .prepare(
        "SELECT captured_at AS ts FROM runtime_metrics WHERE metric_name = 'market_data_last_update' ORDER BY captured_at DESC LIMIT 1",
      )
      .get() as { ts?: string } | undefined;
    if (!row?.ts) return null;
    return Date.now() - new Date(row.ts).getTime() > staleThresholdMs;
  }, null);
}

export function countOpenDrifts(db: Database.Database): number {
  return safe(() => {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM position_drifts WHERE status = 'open'")
      .get() as { n: number };
    return row.n;
  }, 0);
}

export interface ModuleSeverity {
  series: StatusSeries;
  nm: string;
  s: Sev;
  detail: string;
}

export interface ModuleHealthInputs {
  runtimeAlive: boolean;
  marketDataStale: boolean | null;
  reconDrift: boolean;
  breakerOpen: boolean;
  paused: boolean;
}

/**
 * Pure per-module severity rule (single source of the eight module statuses and
 * the overall `uptime` roll-up). `uptime` is the worst module severity, forced
 * to crit when the bot is paused — the same rule the web `analyze()` applies.
 */
export function computeModuleSeverities(inp: ModuleHealthInputs): {
  uptime: Sev;
  modules: ModuleSeverity[];
} {
  const live: Sev = inp.runtimeAlive ? "ok" : "crit";
  // Unknown freshness (null) is a warning, not a silent "fresh".
  const mdSev: Sev =
    inp.marketDataStale === true ? "crit" : inp.marketDataStale === false ? live : "warn";
  const mdDetail =
    inp.marketDataStale === true ? "STALE" : inp.marketDataStale === false ? "fresh" : "unknown";

  const modules: ModuleSeverity[] = [
    {
      series: "module:scanner",
      nm: "scanner",
      s: live,
      detail: inp.runtimeAlive ? "scanning" : "no heartbeat",
    },
    { series: "module:market_data", nm: "market data", s: mdSev, detail: mdDetail },
    {
      series: "module:strategy",
      nm: "strategy",
      s: live,
      detail: inp.runtimeAlive ? "live" : "no heartbeat",
    },
    {
      series: "module:risk",
      nm: "risk",
      s: inp.breakerOpen ? "crit" : live,
      detail: inp.breakerOpen ? "breaker open" : "no breakers",
    },
    { series: "module:execution", nm: "execution", s: live, detail: "posting" },
    {
      series: "module:reconciliation",
      nm: "reconciliation",
      s: inp.reconDrift ? "crit" : live,
      detail: inp.reconDrift ? "drift detected" : "no drift",
    },
    { series: "module:redeem", nm: "redeem", s: live, detail: "idle" },
    { series: "module:manager_api", nm: "manager / API", s: "ok", detail: "responding" },
  ];

  const base = worstStatusSev(modules.map((m) => m.s));
  const uptime: Sev = inp.paused ? "crit" : base;
  return { uptime, modules };
}

export interface SystemHealthSnapshot {
  paused: boolean;
  runtimeAlive: boolean;
  marketDataStale: boolean | null;
  reconDrift: boolean;
  breakerOpen: boolean;
  uptime: Sev;
  modules: ModuleSeverity[];
}

/**
 * Read every health signal once and compute the module/uptime snapshot. Returns
 * the alert windows alongside so the route can build its errors/deps panels
 * without re-reading the DB.
 */
export function collectSystemHealthSnapshot(
  ledgerDb: Database.Database,
  controlDb: Database.Database | undefined,
  staleThresholdMs: number,
): { snapshot: SystemHealthSnapshot; alerts1h: InfraAlertRow[]; alerts24h: InfraAlertRow[] } {
  const control = readControlState(controlDb);
  const paused = control.paused;
  const runtimeAlive = control.status === "running" || control.status === "ready_paused";

  const alerts1h = readInfraAlerts(ledgerDb, 3_600_000);
  const alerts24h = readInfraAlerts(ledgerDb, 86_400_000);
  const breakerOpen = countOpenBreakers(alerts24h) > 0;
  const reconDrift = countOpenDrifts(ledgerDb) > 0;
  const marketDataStale = readMarketDataStale(ledgerDb, staleThresholdMs);

  const { uptime, modules } = computeModuleSeverities({
    runtimeAlive,
    marketDataStale,
    reconDrift,
    breakerOpen,
    paused,
  });

  return {
    snapshot: { paused, runtimeAlive, marketDataStale, reconDrift, breakerOpen, uptime, modules },
    alerts1h,
    alerts24h,
  };
}
