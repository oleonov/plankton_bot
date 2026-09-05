import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { TradingActivityPanel } from "../../components/TradingActivityPanel.tsx";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { server } from "../../test/server.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

function response(days = 1, orders = 2) {
  const end = Date.parse("2026-09-04T12:00:00.000Z");
  const start = end - days * 86_400_000;
  const windowStart = end - 20 * 60_000;
  const windowEnd = end - 10 * 60_000;
  return {
    items: [
      {
        tradingState: "ACTIVELY_TRADING",
        signalsProduced: 4,
        signalsApproved: 2,
        signalsRejected: 2,
        capturedAt: new Date(windowEnd).toISOString(),
        windowVersion: 2,
        windowStartedAt: new Date(windowStart).toISOString(),
        windowEndedAt: new Date(windowEnd).toISOString(),
        ordersAccepted: orders,
        orderNotionalUsdc: 3.5,
        fillsReceived: 1,
        fillNotionalUsdc: 1.25,
        rejectionReasons: { max_open_value: 2 },
      },
    ],
    coverage: {
      requestedStartAt: new Date(start).toISOString(),
      requestedEndAt: new Date(end).toISOString(),
      coveredMs: 600_000,
      gapMs: days * 86_400_000 - 600_000,
      gapCount: 2,
      coveragePercent: (600_000 / (days * 86_400_000)) * 100,
      gaps: [
        {
          startAt: new Date(start).toISOString(),
          endAt: new Date(windowStart).toISOString(),
          durationMs: windowStart - start,
          kind: "missing",
        },
        {
          startAt: new Date(windowEnd).toISOString(),
          endAt: new Date(end).toISOString(),
          durationMs: end - windowEnd,
          kind: "collecting",
        },
      ],
      excludedRows: { legacy: 1, invalid: 0, outsideRange: 0 },
    },
  };
}

function emptyResponse(days = 1) {
  const data = response(days);
  return { ...data, items: [] };
}

function legacyResponse() {
  return {
    items: [
      {
        tradingState: "ACTIVELY_TRADING",
        signalsProduced: 4,
        signalsApproved: 2,
        signalsRejected: 2,
        capturedAt: "2026-09-04T12:00:00.000Z",
      },
    ],
  };
}

function longRangeResponse() {
  const data = response(14);
  const firstStart = Date.parse(data.coverage.requestedStartAt);
  data.items = Array.from({ length: 120 }, (_, index) => {
    const windowStart = firstStart + index * 10 * 60_000;
    return {
      ...data.items[0]!,
      tradingState: index % 2 === 0 ? "ACTIVELY_TRADING" : "ALIVE_BUT_BLOCKED",
      capturedAt: new Date(windowStart + 10 * 60_000).toISOString(),
      windowStartedAt: new Date(windowStart).toISOString(),
      windowEndedAt: new Date(windowStart + 10 * 60_000).toISOString(),
    };
  });
  return data;
}

describe("TradingActivityPanel", () => {
  it("treats a legacy items-only response as unavailable instead of throwing", async () => {
    server.use(http.get("/api/v1/metrics/trading-activity", () => ok(legacyResponse())));
    renderWithProviders(<TradingActivityPanel />);

    expect(await screen.findByTestId("activity-chart")).toBeInTheDocument();
    expect(screen.getByTestId("activity-summary")).toHaveTextContent("1d unavailable");
  });

  it("shows the shared shimmer without rendering stale activity", async () => {
    server.use(
      http.get("/api/v1/metrics/trading-activity", async () => {
        await delay(80);
        return ok(response());
      }),
    );
    renderWithProviders(<TradingActivityPanel />);

    expect(screen.getByTestId("trading-activity-card")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading 24h activity");
    expect(document.querySelector(".pnl-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("activity-chart")).not.toBeInTheDocument();
    await screen.findByTestId("activity-chart");
  });

  it("defaults to understandable execution facts with truthful gaps and collecting tail", async () => {
    server.use(http.get("/api/v1/metrics/trading-activity", () => ok(response())));
    renderWithProviders(<TradingActivityPanel />);

    const chart = await screen.findByTestId("activity-chart");
    expect(screen.getByTestId("mode-execution")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("activity-summary")).toHaveTextContent(
      "10m verified · 23h 50m unavailable · collecting current window",
    );
    expect(screen.getByTestId("activity-gap-missing")).toBeInTheDocument();
    expect(screen.getByTestId("activity-gap-collecting")).toBeInTheDocument();
    expect(chart).toHaveAttribute("aria-label", expect.stringContaining("Execution activity"));
    expect(screen.getByLabelText(/2 accepted orders.*1 fill/)).toBeInTheDocument();
  });

  it("switches to signal counts and normalized rejection reasons", async () => {
    server.use(http.get("/api/v1/metrics/trading-activity", () => ok(response())));
    const user = userEvent.setup();
    renderWithProviders(<TradingActivityPanel />);
    await screen.findByTestId("activity-chart");

    await user.click(screen.getByTestId("mode-signals"));
    expect(screen.getByTestId("mode-signals")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText(/4 produced.*2 approved.*max open value: 2/)).toBeInTheDocument();
  });

  it("hides the 24h result while a newly selected 7d query loads", async () => {
    server.use(
      http.get("/api/v1/metrics/trading-activity", async ({ request }) => {
        const days = Number(new URL(request.url).searchParams.get("days"));
        if (days === 7) await delay(80);
        return ok(response(days, days === 7 ? 7 : 2));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<TradingActivityPanel />);
    await screen.findByLabelText(/2 accepted orders/);

    await user.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading 7d activity");
    expect(screen.queryByLabelText(/2 accepted orders/)).not.toBeInTheDocument();
    expect(await screen.findByLabelText(/7 accepted orders/)).toBeInTheDocument();
  });

  it("keeps current-range data during background refresh and exposes retryable hard errors", async () => {
    let attempts = 0;
    server.use(
      http.get("/api/v1/metrics/trading-activity", async () => {
        attempts++;
        if (attempts === 2) await delay(80);
        return ok(response());
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TradingActivityPanel />
      </QueryClientProvider>,
    );
    await screen.findByLabelText(/2 accepted orders/);
    void client.invalidateQueries({ queryKey: ["trading-activity", 1] });
    expect(await screen.findByText(/Updating/)).toBeInTheDocument();
    expect(screen.getByLabelText(/2 accepted orders/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Updating/)).not.toBeInTheDocument());
  });

  it("keeps same-range data and offers Retry when a background refresh fails", async () => {
    let attempts = 0;
    server.use(
      http.get("/api/v1/metrics/trading-activity", () => {
        attempts++;
        if (attempts === 2) {
          return HttpResponse.json(
            { ok: false, data: null, error: { code: "TEMP", message: "unavailable" } },
            { status: 503 },
          );
        }
        return ok(response());
      }),
    );
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TradingActivityPanel />
      </QueryClientProvider>,
    );
    await screen.findByLabelText(/2 accepted orders/);

    await client.invalidateQueries({ queryKey: ["trading-activity", 1] });
    expect(await screen.findByRole("alert")).toHaveTextContent("Update failed");
    expect(screen.getByLabelText(/2 accepted orders/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Update failed/)).not.toBeInTheDocument());
  });

  it("scales stacked signal outcomes as one total", async () => {
    const data = response();
    data.items[0]!.signalsProduced = 1;
    data.items[0]!.signalsApproved = 1;
    data.items[0]!.signalsRejected = 1;
    server.use(http.get("/api/v1/metrics/trading-activity", () => ok(data)));
    const user = userEvent.setup();
    renderWithProviders(<TradingActivityPanel />);
    await screen.findByTestId("activity-chart");
    await user.click(screen.getByTestId("mode-signals"));

    const signal = screen.getByLabelText(/1 produced.*1 approved.*1 rejected/);
    const rejected = signal.querySelector('rect[fill="var(--red)"]');
    expect(Number(rejected?.getAttribute("y"))).toBeGreaterThanOrEqual(28);
  });

  it("shows a selected-range error without old data and retries", async () => {
    let weekAttempts = 0;
    server.use(
      http.get("/api/v1/metrics/trading-activity", ({ request }) => {
        const days = Number(new URL(request.url).searchParams.get("days"));
        if (days === 7 && weekAttempts++ === 0) {
          return HttpResponse.json(
            { ok: false, data: null, error: { code: "TEMP", message: "unavailable" } },
            { status: 503 },
          );
        }
        return ok(response(days, days === 7 ? 7 : 2));
      }),
    );
    const user = userEvent.setup();
    renderWithProviders(<TradingActivityPanel />);
    await screen.findByLabelText(/2 accepted orders/);
    await user.click(screen.getByRole("button", { name: "7d" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load 7d activity");
    expect(screen.queryByLabelText(/2 accepted orders/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText(/7 accepted orders/)).toBeInTheDocument();
  });

  it("keeps empty coverage visible and retryable during a same-key refresh error", async () => {
    let attempts = 0;
    server.use(
      http.get("/api/v1/metrics/trading-activity", () => {
        attempts++;
        if (attempts === 2) {
          return HttpResponse.json(
            { ok: false, data: null, error: { code: "TEMP", message: "unavailable" } },
            { status: 503 },
          );
        }
        return ok(emptyResponse());
      }),
    );
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TradingActivityPanel />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("activity-chart")).toBeInTheDocument();
    expect(screen.getByTestId("activity-summary")).toHaveTextContent("collecting current window");
    await client.invalidateQueries({ queryKey: ["trading-activity", 1] });
    expect(await screen.findByRole("alert")).toHaveTextContent("Update failed");
    expect(screen.getByTestId("activity-chart")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText(/Update failed/)).not.toBeInTheDocument());
  });

  it("aggregates dense long-range state markers into keyboard-readable details", async () => {
    const data = longRangeResponse();
    server.use(http.get("/api/v1/metrics/trading-activity", () => ok(data)));
    renderWithProviders(<TradingActivityPanel />);

    const chart = await screen.findByTestId("activity-chart");
    const markers = chart.querySelectorAll('[data-testid="activity-state-marker"]');
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.length).toBeLessThan(data.items.length);
    expect(markers[0]).toHaveAttribute("tabindex", "0");
    expect(markers[0]).toHaveAccessibleName(/state-at-close observations.*Trading.*Blocked/i);
    (markers[0] as SVGElement).focus();
    expect(markers[0]).toHaveFocus();
  });
});
