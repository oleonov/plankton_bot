import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import type { LedgerPool } from "../ledger-pool.js";
import { computeExecutionTelemetry } from "../execution-telemetry.js";
import { ok } from "../errors.js";
import { resolveInitialBalanceUsdc } from "../initial-balance.js";

interface StatusOpts {
  db: Database.Database;
  controlDb?: Database.Database;
  ledgerPool?: LedgerPool;
  marketDataStaleThresholdMs?: number;
  envMode?: string | undefined;
  defaultInitialBalanceUsdc?: number | null | undefined;
}

const startedAt = Date.now();

interface LiveLiteStatus {
  familyAllowlist: string[];
  maxFamilies: number;
  maxOpenValueUsdc: number;
  maxOrderUsdc: number;
  maxActiveMarkets: number;
  walletMode?: string;
  minOrderUsdc?: number | null;
}

interface InfraAlertStatusItem {
  code: string;
  severity: "warning" | "error";
  source: string;
  message: string;
  details?: Record<string, unknown> | null;
  lastSeenAt: string;
}

const INFRA_ALERT_LOOKBACK_MS = 60 * 60 * 1000;

function resolveLiveLiteMaxFamilies(envelope: Record<string, unknown>): number {
  const configured = envelope.maxFamilies;
  if (typeof configured === "number" && Number.isFinite(configured)) return configured;
  return 100;
}

/**
 * Resolve the ledger DB for the currently active profile.
 * Falls back to the startup-fixed ledger if control.db or pool unavailable.
 */
function resolveActiveLedger(
  fallback: Database.Database,
  controlDb?: Database.Database,
  ledgerPool?: LedgerPool,
): { db: Database.Database; profile: string | null } {
  if (!controlDb || !ledgerPool) return { db: fallback, profile: null };
  try {
    const row = controlDb
      .prepare("SELECT current_profile FROM runtime_control_state WHERE id = 1")
      .get() as { current_profile: string | null } | undefined;
    if (row?.current_profile) {
      const ledger = ledgerPool.get(row.current_profile);
      if (ledger) return { db: ledger, profile: row.current_profile };
    }
  } catch {
    // Table may not exist in legacy/test DBs
  }
  return { db: fallback, profile: null };
}

function computeTradingState(
  db: Database.Database,
  paused: boolean,
): { tradingState: string; signalActivity: Record<string, unknown> | null } {
  if (paused) return { tradingState: "PAUSED", signalActivity: null };

  const signalActivityRow = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'signal_activity' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;

  if (!signalActivityRow) return { tradingState: "NO_SIGNALS", signalActivity: null };

  const lastEntryApprovedRow = db
    .prepare(
      "SELECT captured_at FROM runtime_metrics WHERE metric_name = 'last_entry_approved' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { captured_at: string } | undefined;

  const lastSignalRejectedRow = db
    .prepare(
      "SELECT captured_at FROM runtime_metrics WHERE metric_name = 'last_signal_rejected' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { captured_at: string } | undefined;

  const scannerActivityRow = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'scanner_activity' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;

  const scanner = scannerActivityRow
    ? (JSON.parse(scannerActivityRow.labels) as {
        candidatesConsidered: number;
        blockedByResolutionBuffer: number;
        blockedByWeekend: number;
        blockedByWindow: number;
      })
    : null;

  const sa = JSON.parse(signalActivityRow.labels) as {
    produced: number;
    approved: number;
    rejected: number;
    entryApproved: number;
    exitApproved: number;
    windowStartMs: number;
  };

  const signalActivity: Record<string, unknown> = {
    signalsProducedLast10m: sa.produced,
    signalsApprovedLast10m: sa.approved,
    signalsRejectedLast10m: sa.rejected,
    entrySignalsApprovedLast10m: sa.entryApproved,
    exitSignalsApprovedLast10m: sa.exitApproved ?? 0,
    lastEntryApprovedAt: lastEntryApprovedRow?.captured_at ?? null,
    lastSignalRejectedAt: lastSignalRejectedRow?.captured_at ?? null,
    approvalRate: sa.produced > 0 ? Math.round((sa.approved / sa.produced) * 100) : null,
  };

  if (scanner) {
    signalActivity.candidatesConsideredLast10m = scanner.candidatesConsidered;
    signalActivity.blockedByResolutionBufferLast10m = scanner.blockedByResolutionBuffer;
    signalActivity.blockedByWeekendLast10m = scanner.blockedByWeekend;
    signalActivity.blockedByWindowLast10m = scanner.blockedByWindow;
  }

  const allProbeOnly = db
    .prepare(
      "SELECT COUNT(*) as total, COUNT(CASE WHEN effective_mode = 'probe-only' THEN 1 END) as probeOnly FROM family_runtime_state WHERE runtime_mode = 'active'",
    )
    .get() as { total: number; probeOnly: number };

  let tradingState: string;
  if (
    sa.entryApproved > 0 &&
    allProbeOnly.total > 0 &&
    allProbeOnly.probeOnly === allProbeOnly.total
  ) {
    tradingState = "PROBING_ONLY";
  } else if (sa.entryApproved > 0) {
    tradingState = "ACTIVELY_TRADING";
  } else if (sa.produced > 0 && sa.rejected > 0 && sa.entryApproved === 0) {
    tradingState = "ALIVE_BUT_BLOCKED";
  } else if (sa.produced > 0 && (sa.exitApproved ?? 0) > 0 && sa.entryApproved === 0) {
    tradingState = "EXITS_ONLY";
  } else {
    tradingState = "NO_SIGNALS";
  }

  if (tradingState === "NO_SIGNALS" && scanner && scanner.candidatesConsidered > 0) {
    signalActivity.topBlockingLayer = "scanner";
  } else if (tradingState === "ALIVE_BUT_BLOCKED") {
    signalActivity.topBlockingLayer = "risk-gate";
  } else {
    signalActivity.topBlockingLayer = null;
  }

  return { tradingState, signalActivity };
}

function parseEnvelopeJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readInfraAlerts(db: Database.Database): InfraAlertStatusItem[] {
  const sinceIso = new Date(Date.now() - INFRA_ALERT_LOOKBACK_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT labels, captured_at
         FROM runtime_metrics
        WHERE metric_name = 'infra_alert' AND captured_at >= ?
        ORDER BY captured_at DESC
        LIMIT 20`,
    )
    .all(sinceIso) as Array<{ labels: string | null; captured_at: string }>;

  const deduped = new Map<string, InfraAlertStatusItem>();
  for (const row of rows) {
    if (!row.labels) continue;
    try {
      const parsed = JSON.parse(row.labels) as {
        code?: string;
        severity?: "warning" | "error";
        source?: string;
        message?: string;
        details?: Record<string, unknown> | null;
      };
      const code = parsed.code?.trim();
      const message = parsed.message?.trim();
      const source = parsed.source?.trim();
      if (!code || !message || !source || deduped.has(code)) continue;
      deduped.set(code, {
        code,
        severity: parsed.severity === "warning" ? "warning" : "error",
        source,
        message,
        details: parsed.details ?? null,
        lastSeenAt: row.captured_at,
      });
    } catch {
      // Ignore malformed alert payloads.
    }
  }

  return [...deduped.values()];
}

function buildLiveLiteStatus(
  runtimeMode: string,
  controlDb?: Database.Database,
  envelopeLabels?: string,
): LiveLiteStatus | undefined {
  if (runtimeMode !== "live-lite") return undefined;

  if (controlDb) {
    try {
      const settingsRow = controlDb
        .prepare(
          "SELECT envelope_json, wallet_mode, min_order_usdc FROM profile_settings WHERE profile_id = ?",
        )
        .get(runtimeMode) as
        | {
            envelope_json: string | null;
            wallet_mode: string | null;
            min_order_usdc: number | null;
          }
        | undefined;
      const envelope = parseEnvelopeJson(settingsRow?.envelope_json);
      const deploymentRows = controlDb
        .prepare(
          "SELECT family_id FROM family_deployments WHERE profile = ? AND enabled = 1 ORDER BY family_id ASC",
        )
        .all(runtimeMode) as Array<{ family_id: string }>;

      const familyAllowlist = deploymentRows.map((row) => row.family_id);
      const liveLiteStatus: LiveLiteStatus = {
        familyAllowlist,
        maxFamilies: resolveLiveLiteMaxFamilies(envelope),
        maxOpenValueUsdc: Number(envelope.maxOpenValueUsdc ?? 500),
        maxOrderUsdc: Number(envelope.maxOrderUsdc ?? 25),
        maxActiveMarkets: Number(envelope.maxActiveMarkets ?? 10),
        walletMode: settingsRow?.wallet_mode ?? "eoa",
      };
      if (
        typeof settingsRow?.min_order_usdc === "number" &&
        Number.isFinite(settingsRow.min_order_usdc)
      ) {
        liveLiteStatus.minOrderUsdc = settingsRow.min_order_usdc;
      }
      return liveLiteStatus;
    } catch {
      // Fall through to runtime metric snapshot for legacy/test setups.
    }
  }

  if (!envelopeLabels) return undefined;
  try {
    return JSON.parse(envelopeLabels) as LiveLiteStatus;
  } catch {
    return undefined;
  }
}

/** Build the status snapshot — shared by GET /status and SSE status events. */
export function buildStatusSnapshot(
  db: Database.Database,
  staleThresholdMs: number,
  profileOverride?: string | null,
  controlDb?: Database.Database,
  envMode?: string,
  defaultInitialBalanceUsdc?: number | null,
): Record<string, unknown> {
  const openOrders = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM orders WHERE status IN ('pending','open','partially-filled')",
    )
    .get() as { cnt: number };

  const openPositions = db
    .prepare("SELECT COUNT(*) as cnt FROM positions WHERE status = 'open'")
    .get() as { cnt: number };

  const activeFamilies = db
    .prepare("SELECT COUNT(*) as cnt FROM family_runtime_state WHERE runtime_mode = 'active'")
    .get() as { cnt: number };

  const totalExposure = db
    .prepare(
      "SELECT COALESCE(SUM(open_value_usdc),0) as total, COALESCE(SUM(current_tail_cost_usdc),0) as tail FROM family_runtime_state",
    )
    .get() as { total: number; tail: number };

  // Runtime mode from the latest bot run
  const botRun = db
    .prepare("SELECT run_id, mode FROM bot_runs ORDER BY started_at DESC LIMIT 1")
    .get() as { run_id: string; mode: string } | undefined;

  // Paused state persisted by runtime via runtime_metrics
  const pausedMetric = db
    .prepare(
      "SELECT value FROM runtime_metrics WHERE metric_name = 'runtime_paused' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { value: number } | undefined;

  // Last reconciliation from runtime_metrics (written by ReconciliationComplete event listener)
  const lastRecon = db
    .prepare(
      "SELECT captured_at as ts FROM runtime_metrics WHERE metric_name = 'last_reconciliation' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { ts: string } | undefined;

  // Market data freshness from runtime_metrics (written by MarketSnapshotReceived event listener)
  const lastMarketData = db
    .prepare(
      "SELECT captured_at as ts FROM runtime_metrics WHERE metric_name = 'market_data_last_update' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { ts: string } | undefined;

  // Two-part mode decomposition for operator clarity
  const mdSource = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'market_data_source' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;
  const execMode = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'execution_mode' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;

  const marketDataLastUpdateAt = lastMarketData?.ts ?? null;
  const marketDataStale = marketDataLastUpdateAt
    ? Date.now() - new Date(marketDataLastUpdateAt).getTime() > staleThresholdMs
    : true; // no data yet = stale

  const runtimeMode = profileOverride ?? botRun?.mode ?? "simulation";

  // Live-lite envelope — only show when current run is live-lite
  const envelopeRow =
    runtimeMode === "live-lite"
      ? (db
          .prepare(
            "SELECT labels FROM runtime_metrics WHERE metric_name = 'live_lite_envelope' ORDER BY captured_at DESC LIMIT 1",
          )
          .get() as { labels: string } | undefined)
      : undefined;

  // Reconciliation drift: current-state (set on drift, reset on clean)
  const lastDrift = db
    .prepare(
      "SELECT captured_at FROM runtime_metrics WHERE metric_name = 'reconciliation_drift' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { captured_at: string } | undefined;
  const lastCleanRecon = db
    .prepare(
      "SELECT captured_at FROM runtime_metrics WHERE metric_name = 'reconciliation_clean' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { captured_at: string } | undefined;

  const reconciliationDriftDetected = lastDrift
    ? !lastCleanRecon || new Date(lastDrift.captured_at) > new Date(lastCleanRecon.captured_at)
    : false;

  const paused = pausedMetric?.value === 1;

  const { tradingState, signalActivity } = computeTradingState(db, paused);

  // Poll progress: only include if active and belongs to current bot run
  const pollProgressRow = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'market_data_poll_progress' LIMIT 1",
    )
    .get() as { labels: string } | undefined;

  let marketDataPoll: { active: boolean; page: number } | undefined;
  if (pollProgressRow) {
    const parsed = JSON.parse(pollProgressRow.labels) as {
      active?: boolean;
      page?: number;
      botRunId?: string;
    };
    if (parsed.active === true && botRun && parsed.botRunId === botRun.run_id) {
      marketDataPoll = { active: true, page: parsed.page ?? 0 };
    }
  }

  // Balance: initial balance from profile_settings, realized PnL from ledger
  const initialBalanceUsdc = resolveInitialBalanceUsdc(
    controlDb,
    runtimeMode,
    defaultInitialBalanceUsdc,
  );

  const totalRealizedPnl = (
    db.prepare("SELECT COALESCE(SUM(realized_pnl), 0) as total FROM positions").get() as {
      total: number;
    }
  ).total;

  const balanceUsdc =
    initialBalanceUsdc != null ? initialBalanceUsdc - totalExposure.total + totalRealizedPnl : null;

  // Wallet balance from exchange (live-lite only, written by runtime publisher)
  let walletBalanceUsdc: number | null = null;
  if (controlDb) {
    try {
      const walletRow = controlDb
        .prepare("SELECT wallet_balance_usdc FROM profile_summaries WHERE profile_id = ?")
        .get(runtimeMode) as { wallet_balance_usdc: number | null } | undefined;
      walletBalanceUsdc = walletRow?.wallet_balance_usdc ?? null;
    } catch {
      // Column may not exist in legacy DBs before migration 013
    }
  }

  // Total current value of open positions
  const totalCurrentValueUsdc = (
    db
      .prepare(
        "SELECT COALESCE(SUM(current_value_usdc), 0) as total FROM positions WHERE status = 'open'",
      )
      .get() as { total: number }
  ).total;

  const executionTelemetry24h = {
    windowHours: 24,
    ...computeExecutionTelemetry(db, {
      sinceIso: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }),
  };

  let desiredProfile: string | null = null;
  let currentProfile: string | null = null;
  if (controlDb) {
    try {
      const runtimeControl = controlDb
        .prepare("SELECT desired_profile, current_profile FROM runtime_control_state WHERE id = 1")
        .get() as { desired_profile: string | null; current_profile: string | null } | undefined;
      desiredProfile = runtimeControl?.desired_profile ?? null;
      currentProfile = runtimeControl?.current_profile ?? null;
    } catch {
      // Legacy/test DBs may not have runtime_control_state.
    }
  }

  // Family mode breakdown for current profile
  let familyModeCounts: Record<string, number> | undefined;
  if (controlDb) {
    try {
      const enabledFamilies = controlDb
        .prepare("SELECT family_id FROM family_deployments WHERE profile = ? AND enabled = 1")
        .all(runtimeMode) as Array<{ family_id: string }>;

      const enabledIds = new Set(enabledFamilies.map((f) => f.family_id));

      const allStates = db
        .prepare("SELECT family_id, runtime_mode, effective_mode FROM family_runtime_state")
        .all() as Array<{ family_id: string; runtime_mode: string; effective_mode: string | null }>;

      const counts: Record<string, number> = {};
      for (const s of allStates) {
        if (!enabledIds.has(s.family_id)) continue;
        const mode = s.effective_mode ?? s.runtime_mode;
        counts[mode] = (counts[mode] ?? 0) + 1;
      }
      familyModeCounts = counts;

      // Count disabled families for the profile
      const disabledRow = controlDb
        .prepare("SELECT COUNT(*) as cnt FROM family_deployments WHERE profile = ? AND enabled = 0")
        .get(runtimeMode) as { cnt: number };
      familyModeCounts._disabled = disabledRow.cnt;
    } catch {
      // control DB may not have family_deployments in legacy/test setups
    }
  }

  const startupAdoptionRow = db
    .prepare(
      "SELECT value, labels, captured_at FROM runtime_metrics WHERE metric_name = 'startup_adoption' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { value: number; labels: string | null; captured_at: string } | undefined;
  const startupAdoption =
    startupAdoptionRow?.labels != null
      ? {
          ...(JSON.parse(startupAdoptionRow.labels) as Record<string, unknown>),
          positionsCreated: startupAdoptionRow.value,
          capturedAt: startupAdoptionRow.captured_at,
        }
      : null;
  const infraAlerts = readInfraAlerts(db);

  return {
    runtimeMode,
    envMode: envMode ?? null,
    desiredProfile,
    currentProfile,
    ledgerProfile: profileOverride ?? runtimeMode,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    paused,
    lastReconciliationAt: lastRecon?.ts ?? null,
    marketDataStale,
    marketDataLastUpdateAt,
    activeFamilyCount: activeFamilies.cnt,
    openOrderCount: openOrders.cnt,
    openPositionCount: openPositions.cnt,
    totalOpenValueUsdc: totalExposure.total,
    totalTailCostUsdc: totalExposure.tail,
    initialBalanceUsdc,
    balanceUsdc,
    walletBalanceUsdc,
    totalCurrentValueUsdc,
    totalRealizedPnl,
    marketDataSource: mdSource
      ? ((JSON.parse(mdSource.labels) as { value?: string }).value ?? "simulation")
      : "simulation",
    executionMode: execMode
      ? ((JSON.parse(execMode.labels) as { value?: string }).value ?? "simulation")
      : "simulation",
    liveLite: buildLiveLiteStatus(runtimeMode, controlDb, envelopeRow?.labels),
    reconciliationDriftDetected,
    tradingState,
    signalActivity,
    executionTelemetry24h,
    startupAdoption,
    ...(infraAlerts.length > 0 ? { infraAlerts } : {}),
    ...(familyModeCounts !== undefined ? { familyModeCounts } : {}),
    ...(marketDataPoll ? { marketDataPoll } : {}),
  };
}

export { resolveActiveLedger };

export const statusRoutes: FastifyPluginAsync<StatusOpts> = async (app, opts) => {
  const staleMs = opts.marketDataStaleThresholdMs ?? 120_000;

  app.get("/status", async () => {
    const { db, profile } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
    return ok(
      buildStatusSnapshot(
        db,
        staleMs,
        profile,
        opts.controlDb,
        opts.envMode,
        opts.defaultInitialBalanceUsdc,
      ),
    );
  });
};
