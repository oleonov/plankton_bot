/**
 * MSW request handlers — mock API responses for UI tests.
 * Each handler returns a minimal but realistic response shape.
 */
import { http, HttpResponse } from "msw";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

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
  activeFamilyCount: 12,
  openOrderCount: 2,
  openPositionCount: 10,
  totalOpenValueUsdc: 32.06,
  totalTailCostUsdc: 32.06,
  initialBalanceUsdc: 100,
  balanceUsdc: 69.7,
  walletBalanceUsdc: null,
  totalCurrentValueUsdc: 15.87,
  totalRealizedPnl: 1.76,
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
};

export const mockControlOverview = {
  ...mockProfiles,
  activeSwitch: null,
  recentTransitions: [],
  pendingProposals: 0,
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
  deployedFamilies: [
    {
      family_id: "fam-1",
      enabled: 1,
      operator_mode: "active",
      strategy_stage: "probe-only",
      deployment_stage: "paper-only",
      priority: 1,
      family_key: "bitcoin-above",
      primary_category: "crypto",
      regime: "threshold",
    },
  ],
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
  http.get("/api/v1/families/options", () => ok({ items: [] })),
  http.get("/api/v1/families", () =>
    ok({
      items: [],
      meta: { scope: "all", profile: null, totalCount: 0, totalCatalogCount: 0, hasMore: false, nextCursor: null },
    }),
  ),
  http.get("/api/v1/families/proposals", () => ok([])),
  http.get("/api/v1/families/recent-demotions", () => ok([])),
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
  http.get("/api/v1/metrics/pnl-series", () => ok({ items: [] })),
  http.get("/api/v1/metrics/families", () => ok([])),
  http.get("/api/v1/audit", () => ok({ ...mockAudit, totalCount: mockAudit.items.length })),
  http.get("/api/v1/risk-events", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
  http.get("/api/v1/discovery/status", () =>
    ok({ lastRun: null, lastSuccessfulRun: null, activeRun: null, workerState: "healthy" }),
  ),
  http.get("/api/v1/discovery/candidates", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
  http.get("/api/v1/discovery/runs", () => ok([])),
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
