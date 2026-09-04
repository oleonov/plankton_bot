import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { PortfolioChart } from "../../components/PortfolioChart.tsx";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { server } from "../../test/server.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

const mockPortfolioSeries = {
  items: [
    {
      equityUsdc: 102,
      realizedPnlUsdc: 0,
      positionValueUsdc: 12,
      openValueUsdc: 10,
      capturedAt: "2026-04-04T10:00:00Z",
    },
    {
      equityUsdc: 105.42,
      realizedPnlUsdc: 3.42,
      positionValueUsdc: 15,
      openValueUsdc: 10,
      capturedAt: "2026-04-04T11:00:00Z",
    },
  ],
  baseline: 100,
  currentEquity: 105.42,
  portfolioPnl: 5.42,
  interval: "1d",
  historyStart: "2026-04-04T10:00:00Z",
  coverageComplete: true,
};

const mockPnlSeries = {
  items: [
    { date: "2026-04-03", realizedPnl: 0 },
    { date: "2026-04-04", realizedPnl: -17.63 },
  ],
};

const storageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

Object.defineProperty(window, "localStorage", { value: storageMock, writable: true });

describe("PortfolioChart", () => {
  beforeEach(() => {
    storageMock.clear();
    storageMock.getItem.mockClear();
    storageMock.setItem.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders portfolio P/L number from API data", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () => ok(mockPortfolioSeries)),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
      expect(screen.getByTestId("chart-subtitle")).toHaveTextContent("Past Day");
    });
  });

  it("defaults interval tabs to 1d", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () => ok(mockPortfolioSeries)),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    const btn1d = await screen.findByTestId("interval-1d");
    expect(btn1d).toHaveStyle({ fontWeight: 700 });

    const btn1w = screen.getByTestId("interval-1w");
    expect(btn1w).toHaveStyle({ fontWeight: 400 });
  });

  it("clicking interval tab changes data and saves to localStorage", async () => {
    let lastInterval = "";
    server.use(
      http.get("/api/v1/metrics/portfolio-series", ({ request }) => {
        const url = new URL(request.url);
        lastInterval = url.searchParams.get("interval") ?? "";
        return ok({ ...mockPortfolioSeries, interval: lastInterval });
      }),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    // Wait for initial render
    await screen.findByTestId("pnl-value");

    // Click 1W tab
    fireEvent.click(screen.getByTestId("interval-1w"));

    // Tab should be active
    expect(screen.getByTestId("interval-1w")).toHaveStyle({ fontWeight: 700 });
    expect(screen.getByTestId("interval-1d")).toHaveStyle({ fontWeight: 400 });

    // localStorage should be updated
    expect(storageMock.setItem).toHaveBeenCalledWith("portfolio-interval", "1w");
  });

  it("shows the API window P/L for 1w instead of cumulative all-time P/L", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", ({ request }) => {
        const interval = new URL(request.url).searchParams.get("interval") ?? "1d";
        if (interval === "1w") {
          return ok({
            items: [
              {
                equityUsdc: -258.87585,
                realizedPnlUsdc: 0,
                positionValueUsdc: 0,
                openValueUsdc: 0,
                capturedAt: "2026-05-28T12:00:00.000Z",
              },
              {
                equityUsdc: -257.3589,
                realizedPnlUsdc: 0,
                positionValueUsdc: 0,
                openValueUsdc: 0,
                capturedAt: "2026-06-04T09:00:00.000Z",
              },
            ],
            baseline: -258.87585,
            currentEquity: -257.3589,
            portfolioPnl: 1.51695,
            interval: "1w",
            historyStart: "2026-05-28T12:00:00.000Z",
            coverageComplete: true,
          });
        }
        return ok(mockPortfolioSeries);
      }),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    await screen.findByTestId("pnl-value");
    fireEvent.click(screen.getByTestId("interval-1w"));

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$1.52");
      expect(screen.getByTestId("pnl-value")).not.toHaveTextContent("-$257.36");
      expect(screen.getByTestId("chart-subtitle")).toHaveTextContent("Past Week");
    });
  });

  it("mode toggle switches between Portfolio and Realized", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () => ok(mockPortfolioSeries)),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    // Portfolio mode shows portfolio P/L
    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
    });

    // Switch to Realized mode
    fireEvent.click(screen.getByTestId("mode-realized"));

    // Should show the last realized PnL value (negative)
    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("-$17.63");
    });

    // Switch back to Portfolio
    fireEvent.click(screen.getByTestId("mode-portfolio"));
    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
    });
  });

  it("hovering chart updates headline P/L and shows date label", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () => ok(mockPortfolioSeries)),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
    });

    // Hover over the SVG — jsdom getBoundingClientRect returns zeros, so mock it
    const svg = document.querySelector("svg")!;
    svg.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 700,
        bottom: 200,
        width: 700,
        height: 200,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
    // clientX near left edge → first data point (equity 102 - baseline 100 = P/L $2.00)
    fireEvent.mouseMove(svg, { clientX: 60, clientY: 50 });

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$2.00");
      expect(screen.getByTestId("hover-label")).toBeInTheDocument();
      expect(screen.getByTestId("hover-label")).toHaveStyle({ right: "10px" });
    });

    // Mouse leave reverts to latest value
    fireEvent.mouseLeave(svg);
    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
      expect(screen.queryByTestId("hover-label")).not.toBeInTheDocument();
    });
  });

  it("formats portfolio hover labels using the browser local time", async () => {
    vi.spyOn(Date.prototype, "getMonth").mockReturnValue(3);
    vi.spyOn(Date.prototype, "getDate").mockReturnValue(4);
    vi.spyOn(Date.prototype, "getHours").mockReturnValue(7);
    vi.spyOn(Date.prototype, "getMinutes").mockReturnValue(5);

    server.use(
      http.get("/api/v1/metrics/portfolio-series", () => ok(mockPortfolioSeries)),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
    });

    const svg = document.querySelector("svg")!;
    svg.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 700,
        bottom: 200,
        width: 700,
        height: 200,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;

    fireEvent.mouseMove(svg, { clientX: 60, clientY: 50 });

    await waitFor(() => {
      expect(screen.getByTestId("hover-label")).toHaveTextContent("04-04 07:05");
    });
  });

  it("switching mode clears stale hover state", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () => ok(mockPortfolioSeries)),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
    });

    // Hover first data point
    const svg = document.querySelector("svg")!;
    svg.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        right: 700,
        bottom: 200,
        width: 700,
        height: 200,
        x: 0,
        y: 0,
        toJSON: () => {},
      }) as DOMRect;
    fireEvent.mouseMove(svg, { clientX: 60, clientY: 50 });

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$2.00");
    });

    // Switch to Realized without leaving SVG — hover should clear
    fireEvent.click(screen.getByTestId("mode-realized"));

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("-$17.63");
      expect(screen.queryByTestId("hover-label")).not.toBeInTheDocument();
    });
  });

  it("headline uses API portfolioPnl, not holdings-only P/L", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () => ok(mockPortfolioSeries)),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    await waitFor(() => {
      const pnlEl = screen.getByTestId("pnl-value");
      // Should show API portfolioPnl +$5.42, NOT holdings-only +$5.00 or raw equity
      expect(pnlEl.textContent).toContain("5.42");
      expect(pnlEl.textContent).not.toContain("5.00");
      expect(pnlEl.textContent).not.toContain("105");
      expect(pnlEl.textContent).not.toContain("100");
    });
  });

  it("keeps fixed interval subtitle even when longer history is incomplete", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () =>
        ok({
          ...mockPortfolioSeries,
          interval: "1w",
          historyStart: "2026-04-04T10:00:00Z",
          coverageComplete: false,
        }),
      ),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    fireEvent.click(await screen.findByTestId("interval-1w"));

    await waitFor(() => {
      expect(screen.getByTestId("chart-subtitle")).toHaveTextContent("Past Week");
    });
  });

  it("keeps 1w and 1m portfolio intervals available while history is still collecting", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () =>
        ok({
          ...mockPortfolioSeries,
          interval: "1w",
          historyStart: "2026-04-06T09:25:00Z",
          coverageComplete: false,
        }),
      ),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    await waitFor(() => {
      expect(screen.getByTestId("chart-subtitle")).toHaveTextContent("Past Day");
    });

    const interval1w = screen.getByTestId("interval-1w");
    const interval1m = screen.getByTestId("interval-1m");
    const intervalAll = screen.getByTestId("interval-all");

    expect(interval1w).not.toBeDisabled();
    expect(interval1m).not.toBeDisabled();
    expect(intervalAll).not.toBeDisabled();

    fireEvent.click(interval1m);
    expect(screen.getByTestId("interval-1m")).toHaveStyle({ fontWeight: 700 });
  });

  it("hides data from the previous interval during initial and cross-range loads", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", async ({ request }) => {
        const url = new URL(request.url);
        const interval = url.searchParams.get("interval");
        await delay(50);
        if (interval === "1w") {
          return ok({
            ...mockPortfolioSeries,
            items: [
              {
                equityUsdc: 110,
                realizedPnlUsdc: 0,
                positionValueUsdc: 20,
                openValueUsdc: 10,
                capturedAt: "2026-04-01T10:00:00Z",
              },
            ],
            currentEquity: 110,
            portfolioPnl: 10,
            interval: "1w",
          });
        }
        return ok(mockPortfolioSeries);
      }),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    expect(screen.getByTestId("portfolio-chart-card")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading Past Day");
    expect(screen.queryByTestId("pnl-value")).not.toBeInTheDocument();
    expect(document.querySelector("svg")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
    });

    fireEvent.click(screen.getByTestId("interval-1w"));

    expect(screen.getByTestId("interval-1w")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chart-subtitle")).toHaveTextContent("Past Week");
    expect(screen.getByRole("status")).toHaveTextContent("Loading Past Week");
    expect(screen.queryByText("+$5.42")).not.toBeInTheDocument();
    expect(document.querySelector("svg")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$10.00");
      expect(screen.getByTestId("chart-subtitle")).toHaveTextContent("Past Week");
      expect(screen.getByTestId("portfolio-chart-card")).toHaveAttribute("aria-busy", "false");
    });
  });

  it("shows a selected-range error without stale data and retries it", async () => {
    let weekAttempts = 0;
    server.use(
      http.get("/api/v1/metrics/portfolio-series", ({ request }) => {
        const interval = new URL(request.url).searchParams.get("interval");
        if (interval === "1w" && weekAttempts++ === 0) {
          return HttpResponse.json(
            { ok: false, data: null, error: { message: "temporarily unavailable" } },
            { status: 503 },
          );
        }
        return ok({
          ...mockPortfolioSeries,
          portfolioPnl: interval === "1w" ? 10 : 5.42,
          interval: interval ?? "1d",
        });
      }),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);
    await screen.findByText("+$5.42");
    fireEvent.click(screen.getByTestId("interval-1w"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't load Past Week");
    expect(screen.queryByText("+$5.42")).not.toBeInTheDocument();
    expect(document.querySelector("svg")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("+$10.00")).toBeInTheDocument();
  });

  it("keeps current-range data visible during a same-key background refresh", async () => {
    let attempts = 0;
    server.use(
      http.get("/api/v1/metrics/portfolio-series", async () => {
        attempts += 1;
        if (attempts > 1) await delay(80);
        return ok(mockPortfolioSeries);
      }),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <PortfolioChart />
      </QueryClientProvider>,
    );
    await screen.findByText("+$5.42");

    void queryClient.invalidateQueries({ queryKey: ["portfolio-series", "1d"] });

    expect(await screen.findByRole("status")).toHaveTextContent("Updating…");
    expect(screen.getByText("+$5.42")).toBeInTheDocument();
    expect(screen.getByTestId("portfolio-chart-card")).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("never paints a late response from an inactive interval", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", async ({ request }) => {
        const interval = new URL(request.url).searchParams.get("interval") ?? "1d";
        if (interval === "1w") await delay(120);
        if (interval === "1m") await delay(20);
        const portfolioPnl = interval === "1w" ? 10 : interval === "1m" ? 30 : 5.42;
        return ok({ ...mockPortfolioSeries, portfolioPnl, interval });
      }),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);
    await screen.findByText("+$5.42");
    fireEvent.click(screen.getByTestId("interval-1w"));
    fireEvent.click(screen.getByTestId("interval-1m"));

    expect(await screen.findByText("+$30.00")).toBeInTheDocument();
    await delay(130);
    expect(screen.getByText("+$30.00")).toBeInTheDocument();
    expect(screen.queryByText("+$10.00")).not.toBeInTheDocument();
    expect(screen.getByTestId("interval-1m")).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps a fixed chart shell height while data refetches", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("interval") === "1w") {
          await delay(100);
        }
        return ok(mockPortfolioSeries);
      }),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    const shell = await screen.findByTestId("portfolio-chart-shell");
    expect(shell).toHaveStyle({ minHeight: "200px" });

    fireEvent.click(screen.getByTestId("interval-1w"));
    expect(shell).toHaveStyle({ minHeight: "200px" });
  });
});
