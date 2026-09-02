import type { FastifyPluginAsync } from "fastify";
import type Database from "better-sqlite3";
import { parseExecutionPolicyJson, resolveTradingState } from "@krabs/domain";
import type { LedgerPool } from "../ledger-pool.js";
import { resolveActiveLedger } from "../active-ledger.js";
import { computeExecutionTelemetry } from "../execution-telemetry.js";
import { ok } from "../errors.js";
import { resolveInitialBalanceUsdc } from "../initial-balance.js";
import {
  PolymarketPortfolioReader,
  resolveLiveLiteFunderAddress,
} from "../polymarket-portfolio.js";
import type { PolymarketPositionPortfolio } from "../polymarket-portfolio.js";
import { readReconciliationHealth } from "../system-health-snapshot.js";

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
  maxOpenValueUsdc: number;
  maxOrderUsdc: number;
  maxActiveMarkets: number;
  activeMarketCount?: number;
  activeMarketCapUtilizationPct?: number;
  walletMode: string;
  minOrderUsdc?: number;
}

interface InfraAlertStatusItem {
  code: string;
  severity: "warning" | "error";
  source: string;
  message: string;
  details?: Record<string, unknown> | null;
  lastSeenAt: string;
}

type StatusSnapshot = Record<string, unknown> & {
  runtimeMode?: unknown;
  walletBalanceUsdc?: unknown;
  polymarketPortfolio?: PolymarketPositionPortfolio | null;
};

const INFRA_ALERT_LOOKBACK_MS = 60 * 60 * 1000;
const ACTIVE_ORDER_STATUS_SQL = "('pending','open','partially-filled')";
const DEFAULT_LIVE_LITE_STATUS_ENVELOPE = {
  maxOpenValueUsdc: 500,
  maxOrderUsdc: 25,
  maxActiveMarkets: 250,
} as const;

interface OpenOrderBreakdown {
  total: number;
  buy: {
    open: number;
    cap: number | null;
  };
  sell: {
    open: number;
    cap: number | null;
  };
  profileLadderSell: {
    open: number;
  };
}

function readExecutionPolicyJson(
  controlDb: Database.Database | undefined,
  profileId: string,
): string | null {
  if (!controlDb) return null;
  try {
    const row = controlDb
      .prepare("SELECT execution_policy_json FROM profile_settings WHERE profile_id = ?")
      .get(profileId) as { execution_policy_json: string | null } | undefined;
    return row?.execution_policy_json ?? null;
  } catch {
    return null;
  }
}

function readProfileOwnedOpenPositionCount(db: Database.Database): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(DISTINCT p.token_id) AS cnt
           FROM positions p
           INNER JOIN execution_profile_state eps ON eps.token_id = p.token_id
          WHERE p.status = 'open'
            AND eps.state != 'CLOSED'`,
      )
      .get() as { cnt: number };
    return row.cnt;
  } catch {
    return 0;
  }
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function nonNegativeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function computeStatusDynamicGlobalSellCap(args: {
  profileOwnedOpenPositionCount: number;
  profileLadderLiveRungsPerPosition: number;
  minNonLadderReserve: number;
  nonLadderReserveRatio: number;
  hardMaxOpenSellOrders: number;
}): number {
  const profileLadderCapRaw =
    nonNegativeInt(args.profileOwnedOpenPositionCount) *
    nonNegativeInt(args.profileLadderLiveRungsPerPosition);
  const nonLadderReserve = Math.max(
    nonNegativeInt(args.minNonLadderReserve),
    Math.ceil(profileLadderCapRaw * nonNegativeNumber(args.nonLadderReserveRatio)),
  );
  return Math.min(
    profileLadderCapRaw + nonLadderReserve,
    Math.max(1, nonNegativeInt(args.hardMaxOpenSellOrders)),
  );
}

function buildOpenOrderBreakdown(
  db: Database.Database,
  controlDb: Database.Database | undefined,
  runtimeMode: string,
): OpenOrderBreakdown {
  const counts = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END), 0) AS buy_open,
         COALESCE(SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END), 0) AS sell_open,
         COALESCE(SUM(CASE
           WHEN side = 'sell'
            AND (
              decision_rule_id = 'PROFILE_LADDER'
              OR signal_reason = 'profile-ladder-exit'
            )
           THEN 1 ELSE 0 END), 0) AS profile_ladder_sell_open
       FROM orders
       WHERE status IN ${ACTIVE_ORDER_STATUS_SQL}`,
    )
    .get() as {
    buy_open: number;
    sell_open: number;
    profile_ladder_sell_open: number;
  };
  const policy = parseExecutionPolicyJson(readExecutionPolicyJson(controlDb, runtimeMode)).policy;
  const sellPolicy = policy.sellCapacity;
  const sellCap =
    sellPolicy.mode === "source_aware_dynamic"
      ? computeStatusDynamicGlobalSellCap({
          profileOwnedOpenPositionCount: readProfileOwnedOpenPositionCount(db),
          profileLadderLiveRungsPerPosition: sellPolicy.profileLadderLiveRungsPerPosition,
          minNonLadderReserve: sellPolicy.minNonLadderReserve,
          nonLadderReserveRatio: sellPolicy.nonLadderReserveRatio,
          hardMaxOpenSellOrders: sellPolicy.hardMaxOpenSellOrders,
        })
      : nonNegativeInt(sellPolicy.maxOpenSellOrders);
  const buyOpen = counts.buy_open;
  const sellOpen = counts.sell_open;

  return {
    total: buyOpen + sellOpen,
    buy: {
      open: buyOpen,
      cap: nonNegativeInt(policy.buyCapacity.maxOpenBuyOrders),
    },
    sell: {
      open: sellOpen,
      cap: sellCap,
    },
    profileLadderSell: {
      open: counts.profile_ladder_sell_open,
    },
  };
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
  const signalConversionRow = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'signal_conversion_activity' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;

  const scanner = scannerActivityRow
    ? (JSON.parse(scannerActivityRow.labels) as {
        candidatesConsidered: number;
        blockedByResolutionBuffer: number;
        blockedByWindow: number;
        scanPrimeSkippedByPolicy?: number;
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
    signalActivity.blockedByWindowLast10m = scanner.blockedByWindow;
    signalActivity.scanPrimeSkippedByPolicyLast10m = scanner.scanPrimeSkippedByPolicy ?? 0;
  }

  if (signalConversionRow?.labels) {
    const conversion = JSON.parse(signalConversionRow.labels) as {
      converted?: number;
      conversionSkippedByReason?: Record<string, number>;
      cacheStatusByStatus?: Record<string, number>;
      exchangeAccepted?: number;
      exchangeRejectedByCode?: Record<string, number>;
      exchangeRejectedByReason?: Record<string, number>;
      fills?: number;
      fillLatencyMs?: Record<string, number> | null;
      cooldownBypassByReason?: Record<string, number>;
      hotQuoteRefreshes?: number;
      hotLaneActionsByType?: Record<string, number>;
      hotLaneStatesByState?: Record<string, number>;
      queueJumpAccepted?: number;
      queueJumpFills?: number;
    };
    signalActivity.signalsConvertedLast10m = conversion.converted ?? 0;
    signalActivity.conversionSkippedLast10mByReason = conversion.conversionSkippedByReason ?? {};
    signalActivity.cacheStatusLast10mByStatus = conversion.cacheStatusByStatus ?? {};
    signalActivity.exchangeAcceptedLast10m = conversion.exchangeAccepted ?? 0;
    signalActivity.exchangeRejectedLast10mByCode = conversion.exchangeRejectedByCode ?? {};
    signalActivity.exchangeRejectedLast10mByReason = conversion.exchangeRejectedByReason ?? {};
    signalActivity.fillsLast10m = conversion.fills ?? 0;
    signalActivity.fillLatencyMsLast10m = conversion.fillLatencyMs ?? null;
    signalActivity.cooldownBypassLast10mByReason = conversion.cooldownBypassByReason ?? {};
    signalActivity.hotQuoteRefreshesLast10m = conversion.hotQuoteRefreshes ?? 0;
    signalActivity.hotLaneActionsLast10mByType = conversion.hotLaneActionsByType ?? {};
    signalActivity.hotLaneStatesLast10mByState = conversion.hotLaneStatesByState ?? {};
    signalActivity.queueJumpAcceptedLast10m = conversion.queueJumpAccepted ?? 0;
    signalActivity.queueJumpFillsLast10m = conversion.queueJumpFills ?? 0;
  }

  const tradingState = resolveTradingState({
    signalWindow: {
      produced: sa.produced,
      approved: sa.approved,
      rejected: sa.rejected,
      entryApproved: sa.entryApproved,
      exitApproved: sa.exitApproved ?? 0,
    },
  });

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
    const parsed = JSON.parse(raw) as unknown;
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

function readActiveMarketCount(db: Database.Database): number {
  try {
    const row = db
      .prepare("SELECT COUNT(DISTINCT token_id) AS cnt FROM positions WHERE status = 'open'")
      .get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

function buildLiveLiteStatus(
  runtimeMode: string,
  db: Database.Database,
  controlDb?: Database.Database,
  envelopeLabels?: string,
): LiveLiteStatus | undefined {
  if (runtimeMode !== "live-lite") return undefined;
  const activeMarketCount = readActiveMarketCount(db);
  const withActiveMarketUtilization = (status: LiveLiteStatus): LiveLiteStatus => ({
    ...status,
    activeMarketCount,
    activeMarketCapUtilizationPct:
      status.maxActiveMarkets > 0 ? (activeMarketCount / status.maxActiveMarkets) * 100 : 0,
  });

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
      const liveLiteStatus: LiveLiteStatus = {
        maxOpenValueUsdc: Number(
          envelope.maxOpenValueUsdc ?? DEFAULT_LIVE_LITE_STATUS_ENVELOPE.maxOpenValueUsdc,
        ),
        maxOrderUsdc: Number(
          envelope.maxOrderUsdc ?? DEFAULT_LIVE_LITE_STATUS_ENVELOPE.maxOrderUsdc,
        ),
        maxActiveMarkets: Number(
          envelope.maxActiveMarkets ?? DEFAULT_LIVE_LITE_STATUS_ENVELOPE.maxActiveMarkets,
        ),
        walletMode: settingsRow?.wallet_mode ?? "eoa",
      };
      if (
        typeof settingsRow?.min_order_usdc === "number" &&
        Number.isFinite(settingsRow.min_order_usdc)
      ) {
        liveLiteStatus.minOrderUsdc = settingsRow.min_order_usdc;
      }
      return withActiveMarketUtilization(liveLiteStatus);
    } catch {
      // Fall through to runtime metric snapshot for legacy/test setups.
    }
  }

  if (!envelopeLabels) return undefined;
  try {
    return withActiveMarketUtilization(JSON.parse(envelopeLabels) as LiveLiteStatus);
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
  const oneMinuteAgoIso = new Date(Date.now() - 60_000).toISOString();

  const openPositions = db
    .prepare("SELECT COUNT(*) as cnt FROM positions WHERE status = 'open'")
    .get() as { cnt: number };

  const recentOrderCount = db
    .prepare("SELECT COUNT(*) as cnt FROM orders WHERE created_at >= ?")
    .get(oneMinuteAgoIso) as { cnt: number };

  const recentPositionCount = db
    .prepare("SELECT COUNT(*) as cnt FROM positions WHERE opened_at >= ?")
    .get(oneMinuteAgoIso) as { cnt: number };

  // Count of unique condition IDs with an open or dust position (replaces family_runtime_state)
  const openConditions = db
    .prepare(
      "SELECT COUNT(DISTINCT condition_id) as cnt FROM positions WHERE status IN ('open','dust')",
    )
    .get() as { cnt: number };

  // Open exposure from positions; tail cost is no longer tracked in a summary table
  const totalExposure = db
    .prepare(
      "SELECT COALESCE(SUM(current_value_usdc),0) as total FROM positions WHERE status IN ('open','dust')",
    )
    .get() as { total: number };

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
  const openOrderBreakdown = buildOpenOrderBreakdown(db, controlDb, runtimeMode);

  // Live-lite envelope — only show when current run is live-lite
  const envelopeRow =
    runtimeMode === "live-lite"
      ? (db
          .prepare(
            "SELECT labels FROM runtime_metrics WHERE metric_name = 'live_lite_envelope' ORDER BY captured_at DESC LIMIT 1",
          )
          .get() as { labels: string } | undefined)
      : undefined;

  const reconciliationKind = readReconciliationHealth(db, Date.now()).kind;
  const reconciliationDriftDetected =
    reconciliationKind === "position_drift" ||
    reconciliationKind === "unresolved_missing" ||
    reconciliationKind === "other_drift";

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
        "SELECT COALESCE(SUM(current_value_usdc), 0) as total FROM positions WHERE status IN ('open','dust')",
      )
      .get() as { total: number }
  ).total;
  const totalLiquidationValueUsdc = (
    db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(liquidation_value_usdc, current_value_usdc)), 0) as total
           FROM positions WHERE status IN ('open','dust')`,
      )
      .get() as { total: number }
  ).total;

  const executionTelemetry24h = {
    windowHours: 24,
    ...computeExecutionTelemetry(db, {
      sinceIso: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    }),
  };
  const executionQueueRow = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'execution_queue' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;
  const executionQueue = executionQueueRow
    ? (JSON.parse(executionQueueRow.labels) as Record<string, unknown>)
    : null;
  const orderCapacityActivityRow = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'order_capacity_activity' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;
  const orderCapacityActivity = orderCapacityActivityRow
    ? (JSON.parse(orderCapacityActivityRow.labels) as Record<string, unknown>)
    : null;
  const riskEventVolumeRow = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'risk_event_volume' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;
  const riskEventVolume = riskEventVolumeRow
    ? (JSON.parse(riskEventVolumeRow.labels) as Record<string, unknown>)
    : null;
  const userOrderStreamActivityRow = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'user_order_stream_activity' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;
  const userOrderStreamActivity = userOrderStreamActivityRow
    ? (JSON.parse(userOrderStreamActivityRow.labels) as Record<string, unknown>)
    : null;
  const marketDataStreamActivityRow = db
    .prepare(
      "SELECT labels FROM runtime_metrics WHERE metric_name = 'market_data_stream_activity' ORDER BY captured_at DESC LIMIT 1",
    )
    .get() as { labels: string } | undefined;
  const marketDataStreamActivity = marketDataStreamActivityRow
    ? (JSON.parse(marketDataStreamActivityRow.labels) as Record<string, unknown>)
    : null;

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
    openConditionCount: openConditions.cnt,
    openOrderCount: openOrderBreakdown.total,
    openOrderBreakdown,
    openPositionCount: openPositions.cnt,
    ordersPlacedLastMin: recentOrderCount.cnt,
    positionsOpenedLastMin: recentPositionCount.cnt,
    totalOpenValueUsdc: totalExposure.total,
    totalTailCostUsdc: 0,
    initialBalanceUsdc,
    balanceUsdc,
    walletBalanceUsdc,
    totalCurrentValueUsdc,
    totalLiquidationValueUsdc,
    totalRealizedPnl,
    polymarketPortfolio: null,
    marketDataSource: mdSource
      ? ((JSON.parse(mdSource.labels) as { value?: string }).value ?? "simulation")
      : "simulation",
    executionMode: execMode
      ? ((JSON.parse(execMode.labels) as { value?: string }).value ?? "simulation")
      : "simulation",
    liveLite: buildLiveLiteStatus(runtimeMode, db, controlDb, envelopeRow?.labels),
    reconciliationDriftDetected,
    tradingState,
    signalActivity,
    riskEventVolume,
    userOrderStreamActivity,
    marketDataStreamActivity,
    executionTelemetry24h,
    executionQueue,
    orderCapacityActivity,
    startupAdoption,
    ...(infraAlerts.length > 0 ? { infraAlerts } : {}),
    ...(marketDataPoll ? { marketDataPoll } : {}),
  };
}

export { resolveActiveLedger };

async function readPolymarketPortfolio(
  snapshot: StatusSnapshot,
  controlDb: Database.Database | undefined,
  reader: PolymarketPortfolioReader,
): Promise<PolymarketPositionPortfolio | null> {
  if (snapshot.runtimeMode !== "live-lite") return null;
  if (
    typeof snapshot.walletBalanceUsdc !== "number" ||
    !Number.isFinite(snapshot.walletBalanceUsdc)
  ) {
    return null;
  }

  const funderAddress = resolveLiveLiteFunderAddress(controlDb, "live-lite");
  if (!funderAddress) return null;
  return reader.read(funderAddress, snapshot.walletBalanceUsdc);
}

export const statusRoutes: FastifyPluginAsync<StatusOpts> = async (app, opts) => {
  const staleMs = opts.marketDataStaleThresholdMs ?? 120_000;
  const portfolioReader = new PolymarketPortfolioReader();

  app.get("/status", async () => {
    const { db, profile } = resolveActiveLedger(opts.db, opts.controlDb, opts.ledgerPool);
    const snapshot = buildStatusSnapshot(
      db,
      staleMs,
      profile,
      opts.controlDb,
      opts.envMode,
      opts.defaultInitialBalanceUsdc,
    );
    const polymarketPortfolio = await readPolymarketPortfolio(
      snapshot,
      opts.controlDb,
      portfolioReader,
    );
    return ok({ ...snapshot, polymarketPortfolio });
  });
};
