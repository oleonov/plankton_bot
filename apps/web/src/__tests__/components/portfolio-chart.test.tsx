import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { PortfolioChart } from "../../components/PortfolioChart.tsx";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { server } from "../../test/server.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

const mockPortfolioSeries = {
  items: [
    {
      equityUsdc: 100,
      realizedPnlUsdc: 0,
      positionValueUsdc: 0,
      capturedAt: "2026-04-04T10:00:00Z",
    },
    {
      equityUsdc: 105.42,
      realizedPnlUsdc: 3.42,
      positionValueUsdc: 2,
      capturedAt: "2026-04-04T11:00:00Z",
    },
  ],
  baseline: 100,
  currentEquity: 105.42,
  portfolioPnl: 5.42,
  interval: "1d",
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

  it("renders portfolio P/L number from API data", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () => ok(mockPortfolioSeries)),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
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
    // clientX near left edge → first data point (equity 100, baseline 100 → P/L $0.00)
    fireEvent.mouseMove(svg, { clientX: 60, clientY: 50 });

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$0.00");
      expect(screen.getByTestId("hover-label")).toBeInTheDocument();
    });

    // Mouse leave reverts to latest value
    fireEvent.mouseLeave(svg);
    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$5.42");
      expect(screen.queryByTestId("hover-label")).not.toBeInTheDocument();
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
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("+$0.00");
    });

    // Switch to Realized without leaving SVG — hover should clear
    fireEvent.click(screen.getByTestId("mode-realized"));

    await waitFor(() => {
      expect(screen.getByTestId("pnl-value")).toHaveTextContent("-$17.63");
      expect(screen.queryByTestId("hover-label")).not.toBeInTheDocument();
    });
  });

  it("headline shows P/L relative to baseline, not absolute equity", async () => {
    server.use(
      http.get("/api/v1/metrics/portfolio-series", () => ok(mockPortfolioSeries)),
      http.get("/api/v1/metrics/pnl-series", () => ok(mockPnlSeries)),
    );

    renderWithProviders(<PortfolioChart />);

    await waitFor(() => {
      const pnlEl = screen.getByTestId("pnl-value");
      // Should show +$5.42 (P/L), NOT +$105.42 (absolute equity)
      expect(pnlEl.textContent).toContain("5.42");
      expect(pnlEl.textContent).not.toContain("105");
      expect(pnlEl.textContent).not.toContain("100");
    });
  });
});
