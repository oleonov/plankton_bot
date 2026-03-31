import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Families } from "../../pages/Families.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

const families = [
  {
    familyId: "fam-1",
    familyKey: "alpha",
    primaryCategory: "crypto",
    regime: "threshold",
    horizon: "weekly",
    cadence: "daily",
    strategyProfile: "generic",
    promotionState: "probe-only",
    probeSubstate: null,
    state: {
      runtimeMode: "active",
      openValueUsdc: 50,
      openPositionCount: 3,
      openDustCount: 0,
      activeMarketCount: 5,
      currentTailCostUsdc: 10,
      tailAdjustedPnlLive: -2,
      quarantineReason: null,
      effectiveMode: null,
      derivedModeReason: null,
    },
    caps: { maxOpenValueUsdc: 100, maxActiveMarkets: 10, maxDustPositions: 5 },
  },
  {
    familyId: "fam-2",
    familyKey: "beta",
    primaryCategory: "crypto",
    regime: "threshold",
    horizon: "weekly",
    cadence: "daily",
    strategyProfile: "generic",
    promotionState: "scaled",
    probeSubstate: null,
    state: {
      runtimeMode: "active",
      openValueUsdc: 20,
      openPositionCount: 1,
      openDustCount: 0,
      activeMarketCount: 2,
      currentTailCostUsdc: 5,
      tailAdjustedPnlLive: 8,
      quarantineReason: null,
      effectiveMode: null,
      derivedModeReason: null,
    },
    caps: { maxOpenValueUsdc: 100, maxActiveMarkets: 10, maxDustPositions: 5 },
  },
  {
    familyId: "fam-3",
    familyKey: "gamma",
    primaryCategory: "crypto",
    regime: "threshold",
    horizon: "weekly",
    cadence: "daily",
    strategyProfile: "generic",
    promotionState: "probe-only",
    probeSubstate: null,
    state: {
      runtimeMode: "quarantine",
      openValueUsdc: 0,
      openPositionCount: 0,
      openDustCount: 0,
      activeMarketCount: 0,
      currentTailCostUsdc: 0,
      tailAdjustedPnlLive: -5,
      quarantineReason: "risk breach",
      effectiveMode: null,
      derivedModeReason: null,
    },
    caps: { maxOpenValueUsdc: 100, maxActiveMarkets: 10, maxDustPositions: 5 },
  },
];

function setup() {
  server.use(http.get("/api/v1/families", () => ok(families)));
}

function getFamilyKeys(): string[] {
  const rows = screen.getAllByRole("row").slice(1); // skip header
  return rows
    .map((row) => {
      const cells = within(row).getAllByRole("cell");
      return cells[0]?.textContent?.replace(/[▶▼]\s*/, "") ?? "";
    })
    .filter(Boolean);
}

describe("Families table sorting", () => {
  it("sorts by Tail Cost ascending then descending", async () => {
    setup();
    const user = userEvent.setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);

    // Default order: alpha, beta, gamma
    expect(getFamilyKeys()).toEqual(["alpha", "beta", "gamma"]);

    // Click Tail Cost → asc (0, 5, 10)
    await user.click(screen.getByText("Tail Cost"));
    expect(getFamilyKeys()).toEqual(["gamma", "beta", "alpha"]);

    // Click again → desc (10, 5, 0)
    await user.click(screen.getByText(/Tail Cost/));
    expect(getFamilyKeys()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("sorts by Tail-Adj PnL ascending", async () => {
    setup();
    const user = userEvent.setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);

    // Click Tail-Adj PnL → asc (-5, -2, 8)
    await user.click(screen.getByText("Tail-Adj PnL"));
    expect(getFamilyKeys()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("third click resets to original order", async () => {
    setup();
    const user = userEvent.setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);

    await user.click(screen.getByText("Positions"));
    await user.click(screen.getByText(/Positions/));
    await user.click(screen.getByText(/Positions/));

    // Back to original
    expect(getFamilyKeys()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("shows sort indicator on active column", async () => {
    setup();
    const user = userEvent.setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);

    const header = screen.getByText("Markets");
    await user.click(header);
    expect(screen.getByText(/Markets \u25B2/)).toBeInTheDocument();

    await user.click(screen.getByText(/Markets/));
    expect(screen.getByText(/Markets \u25BC/)).toBeInTheDocument();
  });
});
