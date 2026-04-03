import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Overview } from "../../pages/Overview.tsx";
import { mockStatus } from "../../test/handlers.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

describe("Overview Balance Card", () => {
  it("shows virtual balance for paper mode", async () => {
    renderWithProviders(<Overview />);

    // mockStatus: balanceUsdc = 69.70, initialBalanceUsdc = 100
    expect(await screen.findByText("$70")).toBeInTheDocument(); // rounded
    expect(screen.getByText(/\$100/)).toBeInTheDocument(); // invested denominator
  });

  it("shows if-close-all value", async () => {
    renderWithProviders(<Overview />);

    // if close all = balanceUsdc (69.70) + totalCurrentValueUsdc (15.87) ≈ 86
    expect(await screen.findByText(/86.*if close all/i)).toBeInTheDocument();
  });

  it("shows invested / initial for paper mode", async () => {
    renderWithProviders(<Overview />);

    // totalOpenValueUsdc = 32.06, initialBalanceUsdc = 100
    expect(await screen.findByText(/\$32.*\/.*\$100.*invested/)).toBeInTheDocument();
  });

  it("shows wallet balance for live-lite mode with green accent", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          walletBalanceUsdc: 487,
          liveLite: {
            maxOpenValueUsdc: 100,
            maxFamilies: 5,
            maxActiveMarkets: 10,
            maxOrderUsdc: 10,
            familyAllowlist: [],
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    // Wallet balance shown
    expect(await screen.findByText("$487")).toBeInTheDocument();
    // invested / cap
    expect(screen.getByText(/\$32.*\/.*\$100.*cap.*invested/)).toBeInTheDocument();
  });

  it("shows dash when balance is null", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          balanceUsdc: null,
          initialBalanceUsdc: null,
          walletBalanceUsdc: null,
        }),
      ),
    );

    renderWithProviders(<Overview />);
    expect((await screen.findAllByText("—")).length).toBeGreaterThanOrEqual(1);
  });

  it("shows 24h execution quality telemetry", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          executionTelemetry24h: {
            windowHours: 24,
            totalFills: 6,
            volumeUsdc: 24,
            makerFills: 4,
            takerFills: 2,
            unknownFills: 0,
            makerRatio: 4 / 6,
            takerRatio: 2 / 6,
            explicitFeesUsdc: 0.48,
            feeLeakageRatio: 0.02,
            lastFillAt: new Date().toISOString(),
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByText("Execution Quality")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
    expect(screen.getByText(/4 maker.*2 taker.*0 unknown/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.480 fees.*2\.00% leakage/)).toBeInTheDocument();
  });

  it("shows canary watch summary for families with taker leakage", async () => {
    server.use(
      http.get("/api/v1/metrics/families", () =>
        ok([
          {
            familyId: "fam-1",
            familyKey: "bitcoin-above",
            feeTier: "fee-enabled",
            requiresPostOnlyForLive: true,
            runtimeMode: "active",
            openValueUsdc: 12,
            openPositionCount: 2,
            tailAdjustedPnlLive: 1.5,
            quarantineReason: null,
            effectiveMode: "active",
            derivedModeReason: null,
            executionTelemetry24h: {
              windowHours: 24,
              totalFills: 4,
              volumeUsdc: 18,
              makerFills: 2,
              takerFills: 2,
              unknownFills: 0,
              makerRatio: 0.5,
              takerRatio: 0.5,
              explicitFeesUsdc: 0.12,
              feeLeakageRatio: 0.0066666667,
              lastFillAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          },
        ]),
      ),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByText(/Watch: bitcoin-above/i)).toBeInTheDocument();
    expect(screen.getByText(/2 taker.*\$0\.120 fees/)).toBeInTheDocument();
  });
});
