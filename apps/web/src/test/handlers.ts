/**
 * MSW request handlers — mock API responses for UI tests.
 * Each handler returns a minimal but realistic response shape.
 */
import { http, HttpResponse } from "msw";
import type { SelectionRule } from "../api/types.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

// ─── Selection Rules Fixtures ─────────────────────────────────────────────────

export const mockSelectionRules: SelectionRule[] = [
  {
    ruleId: "rule-1",
    profileId: "simulation",
    ruleType: "include_prefix",
    pattern: "bitcoin-",
    enabled: true,
    note: "Bitcoin markets",
    createdAt: "2026-04-18T00:00:00Z",
    updatedAt: "2026-04-18T00:00:00Z",
  },
  {
    ruleId: "rule-2",
    profileId: "simulation",
    ruleType: "exclude_slug",
    pattern: "bitcoin-to-150k-by-2025",
    enabled: true,
    note: "Too speculative",
    createdAt: "2026-04-18T00:00:00Z",
    updatedAt: "2026-04-18T00:00:00Z",
  },
  {
    ruleId: "rule-3",
    profileId: "simulation",
    ruleType: "include_prefix",
    pattern: "elon-musk-",
    enabled: true,
    note: null,
    createdAt: "2026-04-18T00:00:00Z",
    updatedAt: "2026-04-18T00:00:00Z",
  },
];

export const mockPreviewBuckets = {
  matchedInclude: [
    {
      conditionId: "cond-1",
      slug: "bitcoin-above-100k",
      eventSlug: "bitcoin-price-2026",
      eventMarketCount: 3,
      winningRuleId: "rule-1",
    },
  ],
  matchedExclude: [
    {
      conditionId: "cond-2",
      slug: "bitcoin-to-150k-by-2025",
      eventSlug: "bitcoin-price-2026",
      eventMarketCount: 3,
      winningRuleId: "rule-2",
    },
  ],
  step2FallbackInclude: [],
  fallbackExclude: [],
};

export const mockEventSlugs = ["bitcoin-price-2026", "elon-musk-ceo-2026", "us-election-2026"];

// ─── Fixtures ────────────────────────────────────────────────────────

export const mockProfiles = {
  profiles: [
    {
      profile_id: "live-lite",
      display_name: "Live-Lite",
      description: "Real orders with envelope caps",
      paused: null,
      last_run_at: null,
      open_orders: 0,
      open_positions: 0,
      total_exposure_usdc: 0,
      balance_usdc: null,
      last_preflight_status: null,
      updated_at: null,
    },
    {
      profile_id: "paper",
      display_name: "Paper",
      description: "Simulated orders with live data",
      paused: 0,
      last_run_at: "2026-03-31T00:00:00Z",
      open_orders: 2,
      open_positions: 10,
      total_exposure_usdc: 32.06,
      balance_usdc: 1.76,
      last_preflight_status: "passed",
      updated_at: "2026-03-31T00:00:00Z",
    },
    {
      profile_id: "simulation",
      display_name: "Simulation",
      description: "Fully simulated",
      paused: null,
      last_run_at: "2026-03-30T12:00:00Z",
      open_orders: 0,
      open_positions: 0,
      total_exposure_usdc: 0,
      balance_usdc: null,
      last_preflight_status: null,
      updated_at: "2026-03-30T12:00:00Z",
    },
  ],
  runtimeState: {
    current_profile: "paper",
    desired_profile: "paper",
    runtime_status: "running",
  },
};

export const mockStatus = {
  runtimeMode: "paper",
  uptimeSeconds: 3600,
  paused: false,
  lastReconciliationAt: "2026-03-31T00:00:00Z",
  marketDataStale: false,
  marketDataLastUpdateAt: "2026-03-31T00:00:00Z",
  openConditionCount: 12,
  openOrderCount: 2,
  openPositionCount: 10,
  ordersPlacedLastMin: 0,
  positionsOpenedLastMin: 0,
  totalOpenValueUsdc: 32.06,
  totalTailCostUsdc: 32.06,
  initialBalanceUsdc: 100,
  balanceUsdc: 69.7,
  walletBalanceUsdc: null,
  totalCurrentValueUsdc: 15.87,
  totalRealizedPnl: 1.76,
  polymarketPortfolio: null,
  marketDataSource: "live",
  executionMode: "simulation",
  reconciliationDriftDetected: false,
  tradingState: "ACTIVELY_TRADING",
  signalActivity: null,
  executionTelemetry24h: {
    windowHours: 24,
    totalFills: 0,
    volumeUsdc: 0,
    makerFills: 0,
    takerFills: 0,
    unknownFills: 0,
    makerRatio: null,
    takerRatio: null,
    explicitFeesUsdc: 0,
    feeLeakageRatio: null,
    lastFillAt: null,
  },
  infraAlerts: [],
};

export const mockControlOverview = {
  ...mockProfiles,
  activeSwitch: null,
  recentTransitions: [],
  heartbeats: [],
};

export const mockProfileDetail = {
  profile: mockProfiles.profiles[1],
  settings: {
    profile_id: "paper",
    initial_balance_usdc: 100,
    envelope_json: null,
    risk_caps_json: null,
    updated_at: "2026-03-31T00:00:00Z",
  },
};

export const mockAudit = {
  items: [
    {
      id: 1,
      entity_type: "family",
      entity_id: "fam-1",
      from_state: "probe-only",
      to_state: "scaled",
      trigger_type: "operator",
      initiator: "admin",
      reason: "paper validation passed",
      profile: "paper",
      created_at: "2026-03-31T00:00:00Z",
    },
  ],
  nextCursor: null,
};

export const mockDashboardKpi = {
  winrate_7d: {
    value: 84.5,
    wins: 1012,
    losses: 186,
    total: 1198,
    sell_closed_pct: 97.5,
    resolved_closed_pct: 48.7,
  },
  exit_multiple_7d: {
    median: 2.8,
    p90: 5.2,
    count: 87,
  },
  fills_24h: {
    total: 52,
    maker: 46,
    taker: 6,
    unknown: 0,
    maker_ratio: 88.4,
    volume_usd: 1240.5,
    rate_per_position: 0.74,
  },
  open_positions_count: 70,
  stuck_positions_count: 0,
  health: {
    severity: "ok" as const,
    ws_tracked: 5000,
    ws_total: 5000,
    lag_p95_ms: 90,
    restarts_24h: 0,
    oom_24h: 0,
    mode: "live-lite",
    paused: false,
    checks: [
      { key: "stuck" as const, severity: "ok" as const, label: "Stuck positions", value: "0" },
      { key: "lag" as const, severity: "ok" as const, label: "WS lag p95", value: "90 ms" },
      {
        key: "restart" as const,
        severity: "ok" as const,
        label: "Restarts · OOM (24h)",
        value: "0 · 0",
      },
      { key: "mode" as const, severity: "ok" as const, label: "Mode", value: "LIVE-LITE" },
    ],
  },
};

// ─── Handlers ────────────────────────────────────────────────────────

export const handlers = [
  http.get("/api/v1/status", () => ok(mockStatus)),
  http.get("/api/v1/auth/me", () => ok({ authenticated: true })),
  http.get("/api/v1/auth/config", () => ok({ usernameRequired: false })),
  http.get("/api/v1/profiles", () => ok(mockProfiles)),
  http.get("/api/v1/profiles/:profileId", ({ params }) => {
    if (params.profileId === "paper") return ok(mockProfileDetail);
    return ok({ ...mockProfileDetail, profile: mockProfiles.profiles[0] });
  }),
  http.get("/api/v1/profiles/:profileId/settings", () => ok(mockProfileDetail.settings)),
  http.put("/api/v1/profiles/:profileId/settings", () => ok(mockProfileDetail.settings)),
  http.get("/api/v1/control/overview", () => ok(mockControlOverview)),
  // Selection Rules
  http.get("/api/v1/selection-rules", () => ok({ rules: mockSelectionRules })),
  http.post("/api/v1/selection-rules", async ({ request }) => {
    const body = (await request.json()) as {
      ruleType: string;
      pattern: string;
      note?: string | null;
    };
    const newRule: SelectionRule = {
      ruleId: `rule-new-${Date.now()}`,
      profileId: "simulation",
      ruleType: body.ruleType as SelectionRule["ruleType"],
      pattern: body.pattern,
      enabled: true,
      note: body.note ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return ok({ rule: newRule });
  }),
  http.patch("/api/v1/selection-rules/:ruleId", async ({ params, request }) => {
    const rule = mockSelectionRules.find((r) => r.ruleId === params.ruleId);
    if (!rule) return new HttpResponse(null, { status: 404 });
    const patch = (await request.json()) as { enabled?: boolean; note?: string | null };
    return ok({ rule: { ...rule, ...patch, updatedAt: new Date().toISOString() } });
  }),
  http.delete("/api/v1/selection-rules/:ruleId", ({ params }) => {
    return ok({ deleted: true, ruleId: params.ruleId });
  }),
  http.get("/api/v1/selection-rules/preview", () => ok(mockPreviewBuckets)),
  http.get("/api/v1/selection-rules/match", ({ request }) => {
    const url = new URL(request.url);
    const marketSlug = url.searchParams.get("marketSlug") ?? "";
    const matched = mockSelectionRules.find(
      (r) => r.ruleType === "include_slug" && r.pattern === marketSlug.toLowerCase(),
    );
    const isInclude = matched !== undefined || marketSlug.startsWith("bitcoin-");
    return ok({
      decision: isInclude ? "include" : "no_match",
      winningRuleId: matched?.ruleId ?? (isInclude ? "rule-1" : null),
      finalStatus: isInclude ? "INCLUDE" : "EXCLUDE",
      step2Fallback: false,
    });
  }),
  // Event slugs
  http.get("/api/v1/markets/event-slugs", () => ok({ eventSlugs: mockEventSlugs })),
  // Events metrics
  http.get("/api/v1/metrics/events", () => ok({ events: [] })),
  http.get("/api/v1/metrics", () =>
    ok({
      positions: {},
      orders: {},
      fills: {
        count: 0,
        volumeUsdc: 0,
        makerCount: 0,
        takerCount: 0,
        unknownCount: 0,
        explicitFeesUsdc: 0,
        feeLeakageRatio: null,
      },
      totalRealizedPnl: 0,
    }),
  ),
  http.get("/api/v1/dashboard/kpi", () => ok(mockDashboardKpi)),
  http.get("/api/v1/metrics/coverage", () =>
    ok({
      ws_tracked: 5000,
      universe_active: 21348,
      markets_total: 25000,
      markets_active: 22000,
      coverage_pct: 23.42,
      events_per_sec: 42.7,
      raw_ws_records: 12000,
      raw_ws_records_per_sec: 200.0,
      parsed_updates: 9000,
      parsed_updates_per_sec: 150.0,
      emitted_updates: 1350,
      emitted_updates_per_sec: 22.5,
      noop_updates: 3000,
      noop_updates_per_sec: 50.0,
      suppressed_trading_noop_count_total: 7650,
      suppressed_trading_noop_per_sec: 127.5,
      suppressed_trading_noop_by_reason: {
        top_of_book_only: 7650,
        book_only: 0,
        last_trade_only: 0,
        tick_size_only: 0,
        mixed_non_critical: 0,
      },
      hub_filter_checked: 250000,
      hub_filter_checked_per_sec: 4166.7,
      hub_filter_passed: 9000,
      hub_filter_passed_per_sec: 150.0,
      shard_count: 10,
      rotation_cycle_hours: 2.72,
      positions_opened_24h: 17,
      plankton_reference_weekly: 2450,
      discovery_batch_size: 500,
      discovery_poll_interval_ms: 300000,
      max_tracked_tokens: 5000,
      decision_tick_latency_p95_ms: 420,
      decision_tick_latency_p99_ms: 890,
      r23_cache_hit_rate: 0.73,
      event_loop_lag_max_ms: 37,
      event_loop_lag_p95_ms: 12,
      gc_pause_max_ms: 4,
      stage_ipc_decode_max_ms: 1.2,
      stage_ipc_decode_p95_ms: 0.8,
      stage_handle_worker_batch_max_ms: 2.2,
      stage_handle_worker_batch_p95_ms: 1.8,
      stage_hub_dispatch_max_ms: 3.2,
      stage_hub_dispatch_p95_ms: 2.8,
      stage_coalescing_flush_max_ms: 4.2,
      stage_coalescing_flush_p95_ms: 3.8,
      stage_latency_summary_max_ms: 5.2,
      stage_latency_summary_p95_ms: 4.8,
      stage_diagnostics_write_max_ms: 6.2,
      stage_diagnostics_write_p95_ms: 5.8,
      stage_metrics_flush_total_max_ms: 10.2,
      stage_metrics_flush_total_p95_ms: 7.2,
      stage_metrics_flush_sqlite_writes_max_ms: 8.1,
      stage_metrics_flush_sqlite_writes_p95_ms: 5.1,
      stage_metrics_flush_snapshot_serialize_max_ms: 2.1,
      stage_metrics_flush_snapshot_serialize_p95_ms: 1.1,
      stage_risk_signal_approval_max_ms: 3.4,
      stage_risk_signal_approval_p95_ms: 1.4,
      stage_signal_to_order_bridge_max_ms: 4.5,
      stage_signal_to_order_bridge_p95_ms: 2.5,
      stage_worker_non_update_events_max_ms: 1.5,
      stage_worker_non_update_events_p95_ms: 0.5,
      stage_discovery_poll_publish_max_ms: 6.5,
      stage_discovery_poll_publish_p95_ms: 3.5,
      stage_signal_path_aggregate_max_ms: 1.8,
      stage_signal_path_aggregate_p95_ms: 0.8,
      stage_cooldown_registry_sweep_max_ms: 1.2,
      stage_cooldown_registry_sweep_p95_ms: 0.4,
      signals_suppressed_early_cooldown_total: 12,
      signals_suppressed_early_cooldown_by_token: { "token-1": 12 },
      cooldown_registry_size: 3,
      cooldown_signal_dedupe_total: 12,
      cooldown_signal_dedupe_early_only: 7,
      cooldown_signal_dedupe_late_only: 5,
      cooldown_signal_dedupe_early_and_late: 0,
      cooldown_signal_dedupe_duplicate_early: 0,
      cooldown_signal_dedupe_duplicate_late: 0,
      cooldown_signal_unique_signals_total: 12,
      cooldown_signal_early_only_total: 7,
      cooldown_signal_late_only_total: 5,
      cooldown_signal_early_and_late_total: 0,
      cooldown_signal_duplicate_early_total: 0,
      cooldown_signal_duplicate_late_total: 0,
      cooldown_price_dedupe_total: 10,
      cooldown_price_dedupe_early_only: 4,
      cooldown_price_dedupe_late_only: 4,
      cooldown_price_dedupe_early_and_late: 2,
      cooldown_price_dedupe_duplicate_early: 0,
      cooldown_price_dedupe_duplicate_late: 0,
      cooldown_price_dedupe_skipped_no_price: 0,
      cooldown_price_unique_price_keys_total: 10,
      cooldown_price_early_only_total: 4,
      cooldown_price_late_only_total: 4,
      cooldown_price_early_and_late_total: 2,
      cooldown_price_duplicate_early_total: 0,
      cooldown_price_duplicate_late_total: 0,
      cooldown_price_skipped_no_price_total: 0,
      exit_order_ttl_cancel_total: 3,
      exit_order_ttl_cancel_near_resolution_total: 1,
      exit_anchor_mode_total: { midpoint: 2, ask_undercut: 8, ask_fallback: 1 },
      exit_ttl_resolved_total: { thin: 3, medium: 2, liquid: 4, default: 1, disabled: 0 },
      exit_reprice_suppressed_threshold_total: 5,
      exit_chain_cap_resolved_total: { "13": 4, "30": 2, "50": 3, unknown: 1 },
      http_errors_by_class_1h: { "gamma-pricing:timeout": 2 },
      ws_heartbeat: {
        pingSent: 20,
        pongReceived: 20,
        timeoutFired: 0,
        timeoutSuppressedByInbound: 1,
        workerEventLoopLagMaxMs: 8,
        byShard: {
          "0": {
            pingSent: 2,
            pongReceived: 2,
            timeoutFired: 0,
            timeoutSuppressedByInbound: 0,
            lastPingSentAt: 1779292800000,
            lastPongAt: 1779292800010,
            lastInboundMessageAt: 1779292800010,
            workerEventLoopLagMaxMs: 3,
          },
        },
      },
      ws_worker_memory: {
        rssMb: 512.4,
        heapUsedMb: 180.2,
        heapTotalMb: 260.1,
        externalMb: 12.3,
        arrayBuffersMb: 4.8,
        maxRssMb: 132.6,
        byWorker: {
          "0": {
            rssMb: 128.4,
            heapUsedMb: 42.2,
            heapTotalMb: 64.1,
            externalMb: 3.1,
            arrayBuffersMb: 1.2,
            heapLimitMb: 248,
            capturedAt: 1779292800010,
          },
        },
      },
      v4_admit_count_total: 420,
      v4_admit_count_by_category: { "crypto-btc": 180, geopolitics: 90, weather: 40 },
      v4_reject_count_total: 1580,
      v4_reject_count_by_reason: {
        rejected_category_not_in_hot_cats: 900,
        rejected_liquidity_below_100: 480,
        rejected_volume_below_5: 200,
        rejected_no_orderbook_proxy: 0,
      },
      v4_admit_rate: 0.21,
      v4_seen_count_by_category: { "crypto-btc": 240, geopolitics: 130, weather: 120 },
      v4_admit_rate_by_category: { "crypto-btc": 0.75, geopolitics: 0.69, weather: 0.33 },
      v4_evaluated_total: 2000,
      captured_at: "2026-05-18T00:00:00Z",
    }),
  ),
  http.get("/api/v1/metrics/r23", () =>
    ok({
      current: {
        checked: 840,
        fired: 12,
        no_history: 230,
        no_dip: 598,
        cache_hit_rate: 0.73,
        cache_hits: 730,
        cache_misses: 270,
        cache_invocations: 1000,
        decision_tick_latency_p95_ms: 420,
        decision_tick_latency_p99_ms: 890,
        captured_at: "2026-05-18T00:00:00Z",
      },
      hourly: {
        fires: [{ hour: "2026-05-18T00:00:00Z", count: 12 }],
        skips: [
          { hour: "2026-05-18T00:00:00Z", reason: "r23-no-history", count: 230 },
          { hour: "2026-05-18T00:00:00Z", reason: "r23-no-dip", count: 598 },
        ],
      },
      orders_24h: 8,
      fills_24h: 3,
      fill_notional_usdc_24h: 2.4,
      since: "2026-05-17T00:00:00Z",
    }),
  ),
  http.get("/api/v1/metrics/pnl-series", () => ok({ items: [] })),
  http.get("/api/v1/metrics/portfolio-series", () =>
    ok({ items: [], baseline: 100, currentEquity: 100, portfolioPnl: 0, interval: "1d" }),
  ),
  http.get("/api/v1/metrics/families", () => ok([])),
  http.get("/api/v1/audit", () => ok({ ...mockAudit, totalCount: mockAudit.items.length })),
  http.get("/api/v1/risk-events", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
  http.get("/api/v1/positions", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
  http.get("/api/v1/orders", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
  http.get("/api/v1/fills", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
  http.get("/api/v1/metrics/trading-activity", () => ok({ items: [] })),
  http.get("/api/v1/events", () => new HttpResponse(null, { status: 200 })),
  http.post("/api/v1/actions/pause", () => ok({ commandId: 1, status: "enqueued" })),
  http.post("/api/v1/actions/resume", () => ok({ commandId: 2, status: "enqueued" })),
  http.post("/api/v1/actions/switch-profile", () =>
    ok({ switchId: "switch-123", status: "requested" }),
  ),
];
