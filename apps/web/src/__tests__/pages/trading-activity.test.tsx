import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { TradingActivityPanel } from "../../components/TradingActivityPanel.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

const mockSnapshots = [
  {
    tradingState: "ACTIVELY_TRADING",
    signalsProduced: 100,
    signalsApproved: 20,
    signalsRejected: 80,
    capturedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    tradingState: "ALIVE_BUT_BLOCKED",
    signalsProduced: 50,
    signalsApproved: 0,
    signalsRejected: 50,
    capturedAt: new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(),
  },
  {
    tradingState: "ACTIVELY_TRADING",
    signalsProduced: 75,
    signalsApproved: 15,
    signalsRejected: 60,
    capturedAt: new Date().toISOString(),
  },
];

function setupMockData() {
  server.use(
    http.get("/api/v1/metrics/trading-activity", () => ok({ items: mockSnapshots })),
  );
}

describe("TradingActivityPanel", () => {
  it("renders with data and shows legend", async () => {
    setupMockData();
    renderWithProviders(<TradingActivityPanel />);

    await screen.findByText("Trading Activity");
    expect(screen.getAllByText("Trading").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Blocked").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Approved").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Rejected").length).toBeGreaterThanOrEqual(1);
  });

  it("shows empty state when no data", async () => {
    server.use(
      http.get("/api/v1/metrics/trading-activity", () => ok({ items: [] })),
    );
    renderWithProviders(<TradingActivityPanel />);

    await screen.findByText("No activity data yet");
  });

  it("switches range when clicking 24h/7d buttons", async () => {
    setupMockData();
    const user = userEvent.setup();
    renderWithProviders(<TradingActivityPanel />);

    await screen.findByText("Trading Activity");

    // Default is 24h
    expect(screen.getByRole("button", { name: "24h" }).className).toContain("btn-success");
    expect(screen.getByRole("button", { name: "14d" }).className).toContain("btn-secondary");

    await user.click(screen.getByRole("button", { name: "7d" }));
    await screen.findByText("Trading Activity");
    expect(screen.getByRole("button", { name: "7d" }).className).toContain("btn-success");
    expect(screen.getByRole("button", { name: "24h" }).className).toContain("btn-secondary");
  });

  it("renders SVG elements for state band and bars", async () => {
    setupMockData();
    renderWithProviders(<TradingActivityPanel />);

    await screen.findByText("Trading Activity");

    const svgs = document.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(2);
  });
});
