import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Overview } from "../../pages/Overview.tsx";
import { Debug } from "../../pages/Debug.tsx";
import { mockDashboardKpi } from "../../test/handlers.ts";
import type { DashboardKpiData } from "../../api/types.ts";

type DashboardKpiOverride = Omit<
  Partial<DashboardKpiData>,
  "winrate_7d" | "exit_multiple_7d" | "fills_24h" | "health"
> & {
  winrate_7d?: Partial<DashboardKpiData["winrate_7d"]>;
  exit_multiple_7d?: Partial<DashboardKpiData["exit_multiple_7d"]>;
  fills_24h?: Partial<DashboardKpiData["fills_24h"]>;
  health?: Partial<DashboardKpiData["health"]>;
};

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

function kpi(overrides: DashboardKpiOverride): DashboardKpiData {
  return {
    ...mockDashboardKpi,
    ...overrides,
    winrate_7d: { ...mockDashboardKpi.winrate_7d, ...overrides.winrate_7d },
    exit_multiple_7d: { ...mockDashboardKpi.exit_multiple_7d, ...overrides.exit_multiple_7d },
    fills_24h: { ...mockDashboardKpi.fills_24h, ...overrides.fills_24h },
    health: { ...mockDashboardKpi.health, ...overrides.health },
  };
}

function mockKpi(data: DashboardKpiData) {
  server.use(http.get("/api/v1/dashboard/kpi", () => ok(data)));
}

describe("dashboard KPI cards", () => {
  it("renders OK KPI states above the financial row", async () => {
    mockKpi(
      kpi({
        winrate_7d: { value: 84.5 },
        exit_multiple_7d: { median: 2.8 },
        fills_24h: { total: 52, maker_ratio: 88.4, rate_per_position: 0.74 },
        open_positions_count: 70,
        stuck_positions_count: 0,
        health: {
          severity: "ok",
          lag_p95_ms: 90,
          restarts_24h: 0,
          oom_24h: 0,
          paused: false,
          mode: "live-lite",
          checks: [
            { key: "stuck", severity: "ok", label: "Stuck positions", value: "0" },
            { key: "lag", severity: "ok", label: "WS lag p95", value: "90 ms" },
            { key: "restart", severity: "ok", label: "Restarts · OOM (24h)", value: "0 · 0" },
            { key: "mode", severity: "ok", label: "Mode", value: "LIVE-LITE" },
          ],
        },
      }),
    );

    renderWithProviders(<Overview />);

    const winrateCard = await screen.findByTestId("kpi-winrate-card");
    expect(within(winrateCard).getByText("Winrate")).toBeInTheDocument();
    expect(within(winrateCard).getByText("7d")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-winrate-status")).toHaveTextContent("OK");
    expect(screen.getByTestId("kpi-exit-multiple-status")).toHaveTextContent("OK");
    expect(screen.getByTestId("kpi-fills-status")).toHaveTextContent("OK");
    expect(screen.getByTestId("kpi-health-status")).toHaveTextContent("OK");
    expect(winrateCard).toHaveAttribute("data-state", "ok");
    expect(within(winrateCard).getByText(/84\.5/)).toBeInTheDocument();
    const exitCard = screen.getByTestId("kpi-exit-multiple-card");
    expect(within(exitCard).getByText(/2\.8/)).toBeInTheDocument();
  });

  it("renders Warn KPI states at warning thresholds", async () => {
    mockKpi(
      kpi({
        winrate_7d: { value: 70 },
        exit_multiple_7d: { median: 2 },
        fills_24h: { total: 30, maker_ratio: 78, rate_per_position: 0.3 },
        open_positions_count: 100,
        stuck_positions_count: 2,
        health: {
          severity: "warn",
          lag_p95_ms: 300,
          restarts_24h: 1,
          oom_24h: 0,
          paused: false,
          mode: "live-lite",
          checks: [
            { key: "stuck", severity: "warn", label: "Stuck positions", value: "2" },
            { key: "lag", severity: "warn", label: "WS lag p95", value: "300 ms" },
            { key: "restart", severity: "warn", label: "Restarts · OOM (24h)", value: "1 · 0" },
            { key: "mode", severity: "ok", label: "Mode", value: "LIVE-LITE" },
          ],
        },
      }),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByTestId("kpi-winrate-status")).toHaveTextContent("Warn");
    expect(screen.getByTestId("kpi-exit-multiple-status")).toHaveTextContent("Warn");
    expect(screen.getByTestId("kpi-fills-status")).toHaveTextContent("Warn");
    expect(screen.getByTestId("kpi-health-status")).toHaveTextContent("Warn");
    expect(screen.getByTestId("kpi-winrate-card")).toHaveAttribute("data-state", "warn");
  });

  it("renders Crit KPI states below thresholds", async () => {
    mockKpi(
      kpi({
        winrate_7d: { value: 40 },
        exit_multiple_7d: { median: 1.2 },
        fills_24h: { total: 5, maker_ratio: 60, rate_per_position: 0.1 },
        open_positions_count: 50,
        stuck_positions_count: 5,
        health: {
          severity: "crit",
          lag_p95_ms: 900,
          restarts_24h: 1,
          oom_24h: 1,
          paused: false,
          mode: "live-lite",
          checks: [
            { key: "stuck", severity: "crit", label: "Stuck positions", value: "5" },
            { key: "lag", severity: "warn", label: "WS lag p95", value: "900 ms" },
            { key: "restart", severity: "crit", label: "Restarts · OOM (24h)", value: "1 · 1" },
            { key: "mode", severity: "ok", label: "Mode", value: "LIVE-LITE" },
          ],
        },
      }),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByTestId("kpi-winrate-status")).toHaveTextContent("Crit");
    expect(screen.getByTestId("kpi-exit-multiple-status")).toHaveTextContent("Crit");
    expect(screen.getByTestId("kpi-fills-status")).toHaveTextContent("Crit");
    expect(screen.getByTestId("kpi-health-status")).toHaveTextContent("Crit");
    expect(screen.getByTestId("kpi-winrate-card")).toHaveAttribute("data-state", "crit");
  });

  it("renders pre-v072 and post-v072 winrate cohorts inside the winrate card", async () => {
    mockKpi(
      kpi({
        winrate_7d: {
          value: 21.1,
          wins: 4,
          losses: 15,
          total: 19,
          cohort_cutoff: "2026-06-03T11:54:56Z",
          cohorts: {
            pre_v072: {
              label: "Pre-v072",
              value: 23.529,
              wins: 4,
              losses: 13,
              total: 17,
              sell_closed_pct: 20,
              resolved_closed_pct: 25,
            },
            post_v072: {
              label: "Post-v072",
              value: 0,
              wins: 0,
              losses: 2,
              total: 2,
              sell_closed_pct: 0,
              resolved_closed_pct: 0,
            },
          },
        },
      }),
    );

    renderWithProviders(<Overview />);

    const winrateCard = await screen.findByTestId("kpi-winrate-card");
    const preCohort = within(winrateCard).getByTestId("kpi-winrate-cohort-pre_v072");
    const postCohort = within(winrateCard).getByTestId("kpi-winrate-cohort-post_v072");

    expect(preCohort).toHaveAttribute("title", "v072 deploy cutoff: 2026-06-03T11:54:56Z");
    expect(within(preCohort).getByText("Pre-v072")).toBeInTheDocument();
    expect(within(preCohort).getByTestId("kpi-winrate-cohort-pre_v072-value")).toHaveTextContent(
      "23.5%",
    );
    expect(within(preCohort).getByText("17 closed")).toBeInTheDocument();
    expect(within(preCohort).getByText("4W · 13L")).toBeInTheDocument();
    expect(within(preCohort).getByText("SELL 20.0%")).toBeInTheDocument();
    expect(within(preCohort).getByText("Resolved 25.0%")).toBeInTheDocument();
    expect(within(preCohort).getByText("Plankton 84.9%")).toBeInTheDocument();

    expect(within(postCohort).getByText("Post-v072")).toBeInTheDocument();
    expect(within(postCohort).getByTestId("kpi-winrate-cohort-post_v072-value")).toHaveTextContent(
      "0.0%",
    );
    expect(within(postCohort).getByText("2 closed")).toBeInTheDocument();
  });

  it("derives card severity from worst submetric on the fills card", async () => {
    mockKpi(
      kpi({
        fills_24h: { total: 52, maker_ratio: 72, rate_per_position: 0.74 },
        open_positions_count: 70,
      }),
    );

    renderWithProviders(<Overview />);

    const fillsCard = await screen.findByTestId("kpi-fills-card");
    expect(fillsCard).toHaveAttribute("data-state", "crit");
    expect(within(fillsCard).getByText("Maker ratio")).toBeInTheDocument();
    expect(within(fillsCard).getByTestId("kpi-fills-maker-value")).toHaveTextContent("72.0%");
  });

  it("keeps full instrumentation on the debug page", async () => {
    const { container } = renderWithProviders(<Debug />);

    expect(await screen.findByText("WS throughput")).toBeInTheDocument();
    expect(screen.getByText("Loop / GC / timers")).toBeInTheDocument();
    expect(screen.getByText("V4 admission")).toBeInTheDocument();
    expect(screen.getByText("Exit telemetry")).toBeInTheDocument();
    expect(screen.getByText("Cooldown diagnostics")).toBeInTheDocument();
    expect(screen.getByText("R23 Dip Trigger")).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });
});
