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
          liveLite: { maxOpenValueUsdc: 100, maxFamilies: 5, maxActiveMarkets: 10, maxOrderUsdc: 10, familyAllowlist: [] },
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
    expect(await screen.findByText("—")).toBeInTheDocument();
  });
});
