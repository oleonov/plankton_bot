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

export type ReconciliationHealthKind =
  | "ok"
  | "position_drift"
  | "unresolved_missing"
  | "acknowledged_external_state_unknown"
  | "other_drift"
  | "unknown";

export interface ReconciliationHealth {
  kind: ReconciliationHealthKind;
  detail: string;
}

const RECONCILIATION_STALE_MS = 90_000;
const RECONCILIATION_MARKERS = [
  "reconciliation_clean",
  "reconciliation_unresolved_missing_on_exchange",
  "reconciliation_acknowledged_external_state_unknown",
  "reconciliation_skipped_unreliable",
  "reconciliation_skipped_suspicious_empty",
  "reconciliation_fills_skipped_unreliable",
] as const;

export function readReconciliationHealth(
  db: Database.Database,
  nowMs: number,
): ReconciliationHealth {
  const unknown = (detail: string): ReconciliationHealth => ({ kind: "unknown", detail });
  try {
    const latest = db
      .prepare(
        "SELECT value, captured_at AS ts FROM runtime_metrics WHERE metric_name = 'last_reconciliation' ORDER BY captured_at DESC, id DESC LIMIT 1",
      )
      .get() as { value?: number; ts?: string } | undefined;
    if (latest?.value !== 1 || typeof latest.ts !== "string") {
      return unknown("reconciliation evidence missing");
    }
    const ranAtMs = parseDbTimestampMs(latest.ts);
    if (!Number.isFinite(ranAtMs) || nowMs < ranAtMs || nowMs - ranAtMs > RECONCILIATION_STALE_MS) {
      return unknown("reconciliation evidence stale");
    }
    const drift = db
      .prepare("SELECT COUNT(*) AS n FROM position_drifts WHERE status = 'open'")
      .get() as { n?: number };
    if (!Number.isInteger(drift.n) || (drift.n ?? -1) < 0) {
      return unknown("reconciliation drift evidence malformed");
    }
    if (drift.n! > 0) return { kind: "position_drift", detail: "position drift detected" };

    const rows = db
      .prepare(
        `SELECT metric_name AS name, value FROM runtime_metrics
          WHERE captured_at = ? AND metric_name IN (${RECONCILIATION_MARKERS.map(() => "?").join(",")})`,
      )
      .all(latest.ts, ...RECONCILIATION_MARKERS) as Array<{ name: string; value: number }>;
    const values = new Map<string, number>(RECONCILIATION_MARKERS.map((name) => [name, 0]));
    for (const row of rows) {
      if (!values.has(row.name) || !Number.isFinite(row.value) || row.value < 0) {
        return unknown("reconciliation marker malformed");
      }
      values.set(row.name, values.get(row.name)! + row.value);
    }
    const clean = values.get("reconciliation_clean")!;
    const unresolved = values.get("reconciliation_unresolved_missing_on_exchange")!;
    const quarantine = values.get("reconciliation_acknowledged_external_state_unknown")!;
    const skipped = RECONCILIATION_MARKERS.slice(3).reduce(
      (sum, name) => sum + values.get(name)!,
      0,
    );
    if ((clean !== 0 && clean !== 1) || (clean === 1 && unresolved + quarantine + skipped > 0)) {
      return unknown("reconciliation markers contradictory");
    }
    if (unresolved > 0) {
      return { kind: "unresolved_missing", detail: "unresolved exchange orders" };
    }
    if (skipped > 0) return unknown("reconciliation snapshot unreliable");
    if (quarantine > 0) {
      return {
        kind: "acknowledged_external_state_unknown",
        detail: "startup quarantine — external state unknown",
      };
    }
    return clean === 1
      ? { kind: "ok", detail: "clean" }
      : { kind: "other_drift", detail: "reconciliation not clean" };
  } catch {
    return unknown("reconciliation evidence unavailable");
  }
}

function reconciliationDrift(kind: ReconciliationHealthKind): boolean {
  return kind === "position_drift" || kind === "unresolved_missing" || kind === "other_drift";
}

// Runtime liveness backstop for the live view: a heartbeat older than this counts
// as "not alive". Should be ~2× the runtime heartbeat interval; the sampler can
// use a stricter/looser window for its warm-up logic.
export const RUNTIME_HEARTBEAT_STALE_MS = 90_000;

export type RuntimeLifecycleState =
  | "running"
  | "ready_paused"
  | "starting"
  | "stopping"
  | "stopped"
  | "failed"
  | "unknown";

export interface RuntimeHealthEvidence {
  runtimeState: RuntimeLifecycleState;
  controlPaused: boolean | null;
  runtimeAlive: boolean;
  runtimeHeartbeatAtMs: number | null;
  runtimeHeartbeatFreshnessMs: number;
  runtimeUptimeSeconds: number | null;
}

// SQLite `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" in UTC with NO timezone.
// Parsing that with the JS Date parser treats it as LOCAL time, which is wrong on
// a non-UTC host. Force UTC when the string carries no timezone marker.
function parseDbTimestampMs(ts: string): number {
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(ts);
  return Date.parse(hasTz ? ts : `${ts.replace(" ", "T")}Z`);
}

const RUNTIME_LIFECYCLE_STATES = new Set<RuntimeLifecycleState>([
  "running",
  "ready_paused",
  "starting",
  "stopping",
  "stopped",
  "failed",
  "unknown",
]);

function normalizeRuntimeState(value: unknown): RuntimeLifecycleState {
  return typeof value === "string" && RUNTIME_LIFECYCLE_STATES.has(value as RuntimeLifecycleState)
    ? (value as RuntimeLifecycleState)
    : "unknown";
}

interface RuntimeControlEvidence {
  profile: string | null;
  runId: string | null;
  instanceId: string | null;
  runtimeState: RuntimeLifecycleState;
  controlPaused: boolean | null;
}

function unavailableRuntimeHealthEvidence(
  runtimeState: RuntimeLifecycleState = "unknown",
  controlPaused: boolean | null = null,
): RuntimeHealthEvidence {
  return {
    runtimeState,
    controlPaused,
    runtimeAlive: false,
    runtimeHeartbeatAtMs: null,
    runtimeHeartbeatFreshnessMs: RUNTIME_HEARTBEAT_STALE_MS,
    runtimeUptimeSeconds: null,
  };
}

function readRuntimeControlEvidence(controlDb: Database.Database): RuntimeControlEvidence {
  const control = controlDb
    .prepare(
      `SELECT current_profile, current_run_id, current_instance_id, runtime_status, paused
         FROM runtime_control_state WHERE id = 1`,
    )
    .get() as
    | {
        current_profile?: unknown;
        current_run_id?: unknown;
        current_instance_id?: unknown;
        runtime_status?: unknown;
        paused?: unknown;
      }
    | undefined;
  const nonEmptyString = (value: unknown): string | null =>
    typeof value === "string" && value ? value : null;
  return {
    profile: nonEmptyString(control?.current_profile),
    runId: nonEmptyString(control?.current_run_id),
    instanceId: nonEmptyString(control?.current_instance_id),
    runtimeState: normalizeRuntimeState(control?.runtime_status),
    controlPaused: control?.paused === 1 ? true : control?.paused === 0 ? false : null,
  };
}

function readActiveRunStartedAtMs(
  ledgerDb: Database.Database,
  runId: string,
  profile: string,
  nowMs: number,
): number | null {
  const run = ledgerDb
    .prepare("SELECT run_id, mode, started_at, finished_at FROM bot_runs WHERE run_id = ?")
    .get(runId) as
    | { run_id?: unknown; mode?: unknown; started_at?: unknown; finished_at?: unknown }
    | undefined;
  const startedAtMs =
    typeof run?.started_at === "string" ? parseDbTimestampMs(run.started_at) : Number.NaN;
  const active =
    run?.run_id === runId &&
    run.mode === profile &&
    run.finished_at === null &&
    Number.isFinite(startedAtMs) &&
    startedAtMs <= nowMs;
  return active ? startedAtMs : null;
}

function readCorrelatedRuntimeHeartbeatAtMs(
  controlDb: Database.Database,
  instanceId: string,
  profile: string,
  runId: string,
): number | null {
  const heartbeat = controlDb
    .prepare(
      `SELECT instance_id, profile, run_id, last_heartbeat_at
         FROM service_heartbeats
        WHERE service_name = 'runtime' AND instance_id = ?`,
    )
    .get(instanceId) as
    | { instance_id?: unknown; profile?: unknown; run_id?: unknown; last_heartbeat_at?: unknown }
    | undefined;
  if (
    heartbeat?.instance_id !== instanceId ||
    heartbeat.profile !== profile ||
    heartbeat.run_id !== runId ||
    typeof heartbeat.last_heartbeat_at !== "string"
  ) {
    return null;
  }
  const heartbeatAtMs = parseDbTimestampMs(heartbeat.last_heartbeat_at);
  return Number.isFinite(heartbeatAtMs) ? heartbeatAtMs : null;
}

function buildRuntimeHealthEvidence(
  control: RuntimeControlEvidence,
  startedAtMs: number,
  runtimeHeartbeatAtMs: number,
  nowMs: number,
): RuntimeHealthEvidence {
  const operationalState =
    control.runtimeState === "running" || control.runtimeState === "ready_paused";
  const consistentPause =
    (control.runtimeState === "running" && control.controlPaused === false) ||
    (control.runtimeState === "ready_paused" && control.controlPaused === true);
  const heartbeatFresh =
    runtimeHeartbeatAtMs <= nowMs && nowMs - runtimeHeartbeatAtMs < RUNTIME_HEARTBEAT_STALE_MS;
  const runtimeAlive = operationalState && consistentPause && heartbeatFresh;
  return {
    runtimeState: control.runtimeState,
    controlPaused: control.controlPaused,
    runtimeAlive,
    runtimeHeartbeatAtMs: operationalState && consistentPause ? runtimeHeartbeatAtMs : null,
    runtimeHeartbeatFreshnessMs: RUNTIME_HEARTBEAT_STALE_MS,
    runtimeUptimeSeconds: runtimeAlive ? Math.floor((nowMs - startedAtMs) / 1000) : null,
  };
}

export function readRuntimeHealthEvidence(
  ledgerDb: Database.Database,
  controlDb: Database.Database | undefined,
  nowMs = Date.now(),
): RuntimeHealthEvidence {
  if (!controlDb) return unavailableRuntimeHealthEvidence();

  let observedState: RuntimeLifecycleState = "unknown";
  let observedPaused: boolean | null = null;
  try {
    const control = readRuntimeControlEvidence(controlDb);
    observedState = control.runtimeState;
    observedPaused = control.controlPaused;
    const fallback = () => unavailableRuntimeHealthEvidence(observedState, observedPaused);
    if (!control.profile || !control.runId || !control.instanceId) return fallback();

    const startedAtMs = readActiveRunStartedAtMs(ledgerDb, control.runId, control.profile, nowMs);
    if (startedAtMs === null) return fallback();
    const runtimeHeartbeatAtMs = readCorrelatedRuntimeHeartbeatAtMs(
      controlDb,
      control.instanceId,
      control.profile,
      control.runId,
    );
    if (runtimeHeartbeatAtMs === null) return fallback();
    return buildRuntimeHealthEvidence(control, startedAtMs, runtimeHeartbeatAtMs, nowMs);
  } catch {
    return unavailableRuntimeHealthEvidence(observedState, observedPaused);
  }
}

// Latest runtime heartbeat (epoch ms) — the robust liveness signal. A dead runtime
// stops rewriting `service_heartbeats.last_heartbeat_at`, so its staleness = dead;
// unlike `runtime_control_state.runtime_status`, which retains its pre-restart value.
export function readRuntimeHeartbeatAtMs(controlDb: Database.Database | undefined): number | null {
  if (!controlDb) return null;
  return safe<number | null>(() => {
    const row = controlDb
      .prepare(
        "SELECT MAX(last_heartbeat_at) AS ts FROM service_heartbeats WHERE service_name = 'runtime'",
      )
      .get() as { ts?: string | null } | undefined;
    if (!row?.ts) return null;
    const ms = parseDbTimestampMs(row.ts);
    return Number.isNaN(ms) ? null : ms;
  }, null);
}

// Latest market-data update (epoch ms). null when the metric is absent.
export function readMarketDataUpdatedAtMs(db: Database.Database): number | null {
  return safe<number | null>(() => {
    const row = db
      .prepare(
        "SELECT captured_at AS ts FROM runtime_metrics WHERE metric_name = 'market_data_last_update' ORDER BY captured_at DESC LIMIT 1",
      )
      .get() as { ts?: string } | undefined;
    if (!row?.ts) return null;
    const ms = parseDbTimestampMs(row.ts);
    return Number.isNaN(ms) ? null : ms;
  }, null);
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
  reconciliation: ReconciliationHealth;
  breakerOpen: boolean;
  paused: boolean;
}

/**
 * Pure per-module severity rule (single source of the eight module statuses and
 * the overall `uptime` roll-up). `uptime` is the worst module severity. Pause is
 * NOT a severity here — it is a distinct recorded state (sampler) and an amber
 * hero (web `analyze()`), so it no longer forces the roll-up to crit.
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
  const reconSev: Sev =
    inp.reconciliation.kind === "position_drift"
      ? "crit"
      : inp.reconciliation.kind === "ok"
        ? live
        : "warn";

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
      s: reconSev,
      detail: inp.reconciliation.detail,
    },
    { series: "module:redeem", nm: "redeem", s: live, detail: "idle" },
    { series: "module:manager_api", nm: "manager / API", s: "ok", detail: "responding" },
  ];

  // Pause is NOT a severity — it is a distinct recorded state (handled by the
  // sampler + client hero), so it no longer forces the uptime roll-up to crit.
  const uptime = worstStatusSev(modules.map((m) => m.s));
  return { uptime, modules };
}

export interface SystemHealthSnapshot {
  paused: boolean;
  runtimeAlive: boolean;
  marketDataStale: boolean | null;
  reconDrift: boolean;
  reconciliation: ReconciliationHealth;
  breakerOpen: boolean;
  uptime: Sev;
  modules: ModuleSeverity[];
  // Raw liveness evidence for the sampler's warm-up / readiness logic.
  runtimeHeartbeatAtMs: number | null;
  runtimeState: RuntimeLifecycleState;
  runtimeHeartbeatFreshnessMs: number;
  runtimeUptimeSeconds: number | null;
  marketDataUpdatedAtMs: number | null;
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
  nowMs = Date.now(),
): { snapshot: SystemHealthSnapshot; alerts1h: InfraAlertRow[]; alerts24h: InfraAlertRow[] } {
  const runtime = readRuntimeHealthEvidence(ledgerDb, controlDb, nowMs);
  const paused = runtime.controlPaused ?? false;
  const { runtimeAlive, runtimeHeartbeatAtMs } = runtime;
  const marketDataUpdatedAtMs = readMarketDataUpdatedAtMs(ledgerDb);
  const marketDataStale = readMarketDataStale(ledgerDb, staleThresholdMs);

  const alerts1h = readInfraAlerts(ledgerDb, 3_600_000);
  const alerts24h = readInfraAlerts(ledgerDb, 86_400_000);
  const breakerOpen = countOpenBreakers(alerts24h) > 0;
  const reconciliation = readReconciliationHealth(ledgerDb, nowMs);
  const reconDrift = reconciliationDrift(reconciliation.kind);

  const { uptime, modules } = computeModuleSeverities({
    runtimeAlive,
    marketDataStale,
    reconciliation,
    breakerOpen,
    paused,
  });

  return {
    snapshot: {
      paused,
      runtimeAlive,
      marketDataStale,
      reconDrift,
      reconciliation,
      breakerOpen,
      uptime,
      modules,
      runtimeHeartbeatAtMs,
      runtimeState: runtime.runtimeState,
      runtimeHeartbeatFreshnessMs: runtime.runtimeHeartbeatFreshnessMs,
      runtimeUptimeSeconds: runtime.runtimeUptimeSeconds,
      marketDataUpdatedAtMs,
    },
    alerts1h,
    alerts24h,
  };
}
