import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Discovery } from "../../pages/Discovery.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

const discoveredCandidate = {
  candidateId: "cand-1",
  familyKey: "btc-above-50k",
  regime: "threshold",
  horizon: "weekly",
  recurrenceScore: 0.85,
  liveViabilityScore: 0.72,
  gateRecommendation: "probe-candidate",
  patternConfidence: "high",
  lastSeenAt: "2026-03-31T00:00:00Z",
  scoresUpdatedAt: "2026-03-31T00:00:00Z",
  materializedAt: null,
  status: "discovered",
};

function setupCandidate() {
  server.use(
    http.get("/api/v1/discovery/candidates", () =>
      ok({ items: [{ ...discoveredCandidate }], nextCursor: null }),
    ),
  );
}

describe("Discovery Accept dialog with caps", () => {
  it("shows editable cap fields with defaults", async () => {
    setupCandidate();
    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const acceptBtn = await screen.findByRole("button", { name: "Approve" });
    await user.click(acceptBtn);

    // Dialog opens with default values
    expect(screen.getByText("Approve btc-above-50k?")).toBeInTheDocument();
    const inputs = screen.getAllByRole("textbox");
    expect(inputs).toHaveLength(3);
    // Defaults from PROBE_DEFAULTS: 10, 3, 2
    expect((inputs[0] as HTMLInputElement).value).toBe("10");
    expect((inputs[1] as HTMLInputElement).value).toBe("3");
    expect((inputs[2] as HTMLInputElement).value).toBe("2");
  });

  it("explains that live-lite approve adds the family to the live profile", async () => {
    setupCandidate();
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          runtimeMode: "live-lite",
          uptimeSeconds: 1,
          paused: true,
          lastReconciliationAt: null,
          marketDataStale: false,
          marketDataLastUpdateAt: null,
          activeFamilyCount: 0,
          openOrderCount: 0,
          openPositionCount: 0,
          totalOpenValueUsdc: 0,
          totalTailCostUsdc: 0,
          initialBalanceUsdc: null,
          balanceUsdc: null,
          walletBalanceUsdc: null,
          totalCurrentValueUsdc: 0,
          totalRealizedPnl: 0,
          marketDataSource: "live",
          executionMode: "live",
          reconciliationDriftDetected: false,
          tradingState: "PAUSED",
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
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const acceptBtn = await screen.findByRole("button", { name: "Approve" });
    await user.click(acceptBtn);

    expect(
      screen.getByText(
        "This will materialize the candidate and add it to live-lite as a probe-only family. The bot will decide whether to trade it.",
      ),
    ).toBeInTheDocument();
  });

  it("shows error and disables Confirm for non-numeric input", async () => {
    setupCandidate();
    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const acceptBtn = await screen.findByRole("button", { name: "Approve" });
    await user.click(acceptBtn);

    const inputs = screen.getAllByRole("textbox");
    // Clear first input and type non-numeric
    await user.clear(inputs[0]!);
    await user.type(inputs[0]!, "abc");

    expect(screen.getByText("Must be a number")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("shows error for empty input", async () => {
    setupCandidate();
    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const acceptBtn = await screen.findByRole("button", { name: "Approve" });
    await user.click(acceptBtn);

    const inputs = screen.getAllByRole("textbox");
    await user.clear(inputs[0]!);

    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("shows error for value below minimum", async () => {
    setupCandidate();
    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const acceptBtn = await screen.findByRole("button", { name: "Approve" });
    await user.click(acceptBtn);

    const inputs = screen.getAllByRole("textbox");
    await user.clear(inputs[0]!);
    await user.type(inputs[0]!, "0");

    expect(screen.getByText("Min 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("sends custom caps to API on confirm", async () => {
    setupCandidate();
    const acceptHandler = vi.fn();
    server.use(
      http.post("/api/v1/discovery/candidates/cand-1/accept", async ({ request }) => {
        const body = await request.json();
        acceptHandler(body);
        return ok({ ...discoveredCandidate, status: "materialized" });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const acceptBtn = await screen.findByRole("button", { name: "Approve" });
    await user.click(acceptBtn);

    // Change Max Open from 10 to 20
    const inputs = screen.getAllByRole("textbox");
    await user.clear(inputs[0]!);
    await user.type(inputs[0]!, "20");

    // Change Max Markets from 3 to 5
    await user.clear(inputs[1]!);
    await user.type(inputs[1]!, "5");

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(acceptHandler).toHaveBeenCalledTimes(1));
    expect(acceptHandler).toHaveBeenCalledWith({
      maxOpenValueUsdc: 20,
      maxActiveMarkets: 5,
      maxDustPositions: 2,
    });
  });

  it("enables Confirm when error is fixed", async () => {
    setupCandidate();
    const user = userEvent.setup();
    renderWithProviders(<Discovery />);

    const acceptBtn = await screen.findByRole("button", { name: "Approve" });
    await user.click(acceptBtn);

    const inputs = screen.getAllByRole("textbox");

    // Break it
    await user.clear(inputs[0]!);
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();

    // Fix it
    await user.type(inputs[0]!, "15");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
  });
});
