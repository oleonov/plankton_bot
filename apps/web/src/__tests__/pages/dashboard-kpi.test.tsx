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
  it("renders green KPI states above the financial row", async () => {
    mockKpi(
      kpi({
        winrate_7d: { value: 84.5 },
        exit_multiple_7d: { median: 2.8 },
        fills_24h: { total: 52, maker_ratio: 88.4 },
        stuck_positions_count: 0,
        health: { lag_p95_ms: 90, restarts_24h: 0, oom_24h: 0, paused: false, mode: "live-lite" },
      }),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByText("WINRATE 7d")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-winrate-status")).toHaveTextContent("OK");
    expect(screen.getByTestId("kpi-exit-multiple-status")).toHaveTextContent("OK");
    expect(screen.getByTestId("kpi-fills-status")).toHaveTextContent("OK");
    expect(screen.getByTestId("kpi-health-status")).toHaveTextContent("OK");
    expect(screen.getByText("84.5%")).toBeInTheDocument();
    expect(screen.getByText("2.8×")).toBeInTheDocument();
    expect(screen.getByText("52 fills")).toBeInTheDocument();
  });

  it("renders yellow KPI states at warning thresholds", async () => {
    mockKpi(
      kpi({
        winrate_7d: { value: 70 },
        exit_multiple_7d: { median: 2 },
        fills_24h: { total: 30, maker_ratio: 75 },
        stuck_positions_count: 2,
        health: { lag_p95_ms: 90, restarts_24h: 0, oom_24h: 0, paused: false, mode: "live-lite" },
      }),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByTestId("kpi-winrate-status")).toHaveTextContent("WARN");
    expect(screen.getByTestId("kpi-exit-multiple-status")).toHaveTextContent("WARN");
    expect(screen.getByTestId("kpi-fills-status")).toHaveTextContent("WARN");
    expect(screen.getByTestId("kpi-health-status")).toHaveTextContent("WARN");
  });

  it("renders red KPI states below thresholds", async () => {
    mockKpi(
      kpi({
        winrate_7d: { value: 40 },
        exit_multiple_7d: { median: 1.2 },
        fills_24h: { total: 5, maker_ratio: 60 },
        stuck_positions_count: 5,
        health: { lag_p95_ms: 900, restarts_24h: 1, oom_24h: 1, paused: false, mode: "live-lite" },
      }),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByTestId("kpi-winrate-status")).toHaveTextContent("ALERT");
    expect(screen.getByTestId("kpi-exit-multiple-status")).toHaveTextContent("ALERT");
    expect(screen.getByTestId("kpi-fills-status")).toHaveTextContent("ALERT");
    expect(screen.getByTestId("kpi-health-status")).toHaveTextContent("ALERT");
  });

  it("renders maker ratio as a separate fills quality state", async () => {
    mockKpi(kpi({ fills_24h: { total: 52, maker_ratio: 72 } }));

    renderWithProviders(<Overview />);

    const fillsCard = await screen.findByTestId("kpi-fills-card");
    expect(within(fillsCard).getByText(/maker quality/i)).toHaveTextContent("WARN");
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
