import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { StatusBar } from "../../components/StatusBar.tsx";
import { mockStatus } from "../../test/handlers.ts";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import type { StatusData } from "../../api/types.ts";

vi.mock("../../api/sse.tsx", () => ({ useSSEState: () => "connected" }));

const { signalActivity: incompatibleSignalActivity, ...mockStatusWithoutSignalActivity } =
  mockStatus;
void incompatibleSignalActivity;

const statusFixture: StatusData = {
  ...mockStatusWithoutSignalActivity,
  marketDataSource: "live",
  executionMode: "simulation",
};

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

function renderCachedStatus(status: StatusData): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  queryClient.setQueryData(["status"], status);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StatusBar />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

function neverResolveStatus(): void {
  server.use(
    http.get("/api/v1/status", async () => {
      await delay("infinite");
      return ok(mockStatus);
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("StatusBar", () => {
  it("keeps health indicators without redundant live-lite labels", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          executionMode: "live",
          paused: false,
        }),
      ),
    );

    renderWithProviders(<StatusBar />);

    expect(await screen.findByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText(/uptime:/)).toBeInTheDocument();
    expect(screen.getByText(/recon:/)).toBeInTheDocument();
    expect(screen.getByText("FRESH")).toBeInTheDocument();
    expect(screen.queryByText("live-lite")).not.toBeInTheDocument();
    expect(screen.queryByText(/data:live exec:live/)).not.toBeInTheDocument();
    expect(screen.queryByText(/real orders on exchange/i)).not.toBeInTheDocument();
    expect(screen.getByText(/API: connected/)).toBeInTheDocument();
  });

  it("expires cached runtime evidence while a refetch remains pending", async () => {
    const now = Date.parse("2026-09-22T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    neverResolveStatus();
    const status = {
      ...statusFixture,
      runtimeHeartbeatAt: new Date(now).toISOString(),
    };
    const queryClient = renderCachedStatus(status);

    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(90_000));
    expect(screen.getByText("STALE")).toBeInTheDocument();
    expect(screen.getByText(/uptime:/)).toHaveTextContent("uptime: —");

    await act(() => queryClient.setQueryData(["status"], { ...status }));
    expect(screen.getByText("STALE")).toBeInTheDocument();
  });

  it("rechecks expiry immediately when the document becomes visible", async () => {
    const now = Date.parse("2026-09-22T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    neverResolveStatus();
    renderCachedStatus({
      ...statusFixture,
      runtimeHeartbeatAt: new Date(now - 89_500).toISOString(),
    });

    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    vi.setSystemTime(now + 600);
    await act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByText("STALE")).toBeInTheDocument();
  });

  it("renders missing freshness evidence as unknown", () => {
    neverResolveStatus();
    const { runtimeHeartbeatFreshnessMs, ...statusWithoutFreshness } = statusFixture;
    void runtimeHeartbeatFreshnessMs;
    renderCachedStatus(statusWithoutFreshness);

    expect(screen.getByText("UNKNOWN")).toBeInTheDocument();
    expect(screen.getByText(/uptime:/)).toHaveTextContent("uptime: —");
  });

  it("lets failed lifecycle state dominate a recent heartbeat", () => {
    neverResolveStatus();
    renderCachedStatus({ ...statusFixture, runtimeState: "failed" });
    expect(screen.getByText("FAILED")).toBeInTheDocument();
  });

  it("distinguishes acknowledged external uncertainty from position drift", async () => {
    neverResolveStatus();
    const status = {
      ...statusFixture,
      reconciliation: {
        kind: "acknowledged_external_state_unknown",
        detail: "startup quarantine",
        quarantine: { count: 4, nextCloseAt: null },
      },
    } satisfies StatusData;
    const queryClient = renderCachedStatus(status);
    const badge = screen.getByText(/QUARANTINE 4/);
    expect(badge).toHaveClass("badge-blue");
    expect(badge).not.toHaveTextContent(/closes in/);
    expect(screen.queryByText("POSITION DRIFT")).not.toBeInTheDocument();

    await act(() =>
      queryClient.setQueryData(["status"], {
        ...status,
        reconciliation: { kind: "position_drift", detail: "position drift detected" },
      }),
    );
    await waitFor(() => expect(screen.getByText("POSITION DRIFT")).toBeInTheDocument());
  });

  it("renders a calm quarantine badge with count and close time, never RECON DRIFT", async () => {
    neverResolveStatus();
    const status = {
      ...statusFixture,
      reconciliation: {
        kind: "exchange_absent_quarantine",
        detail: "quarantined 3 orders — awaiting exchange-absence close",
        quarantine: { count: 3, nextCloseAt: new Date(Date.now() + 21 * 3_600_000).toISOString() },
      },
    } satisfies StatusData;
    renderCachedStatus(status);

    expect(await screen.findByText(/QUARANTINE 3/)).toBeInTheDocument();
    expect(screen.getByText(/QUARANTINE 3/)).toHaveTextContent(/closes in 21h/);
    expect(screen.queryByText("RECON DRIFT")).not.toBeInTheDocument();
  });

  it("omits the close-time fragment when nextCloseAt is unknown", async () => {
    neverResolveStatus();
    const status = {
      ...statusFixture,
      reconciliation: {
        kind: "exchange_absent_quarantine",
        detail: "quarantined 1 order — awaiting exchange-absence close",
        quarantine: { count: 1, nextCloseAt: null },
      },
    } satisfies StatusData;
    renderCachedStatus(status);

    const badge = await screen.findByText(/QUARANTINE 1/);
    expect(badge).toHaveTextContent("QUARANTINE 1");
    expect(badge.textContent).not.toMatch(/closes in/);
  });
});
