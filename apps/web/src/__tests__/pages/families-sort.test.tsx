import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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
    executionTelemetry24h: {
      windowHours: 24,
      totalFills: 5,
      volumeUsdc: 12,
      makerFills: 4,
      takerFills: 1,
      unknownFills: 0,
      makerRatio: 0.8,
      takerRatio: 0.2,
      explicitFeesUsdc: 0.12,
      feeLeakageRatio: 0.01,
      lastFillAt: "2026-03-31T00:00:00Z",
    },
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
    deployment: null,
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
    deployment: null,
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
    executionTelemetry24h: {
      windowHours: 24,
      totalFills: 2,
      volumeUsdc: 3,
      makerFills: 0,
      takerFills: 2,
      unknownFills: 0,
      makerRatio: 0,
      takerRatio: 1,
      explicitFeesUsdc: 0.15,
      feeLeakageRatio: 0.05,
      lastFillAt: "2026-03-31T00:00:00Z",
    },
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
    deployment: null,
  },
];

function setup(evidenceByFamily: Record<string, { [key: string]: unknown } | null> = {}) {
  server.use(
    http.get("/api/v1/families", () =>
      ok({
        items: families,
        meta: { scope: "all" as const, profile: null, totalCatalogCount: families.length },
      }),
    ),
    http.get("/api/v1/families/:familyId/transitions", () => ok([])),
    http.get("/api/v1/families/:familyId/positions", () => ok([])),
    http.get("/api/v1/families/:familyId/orders", () => ok({ items: [], nextCursor: null })),
    http.get("/api/v1/families/:familyId/evidence", ({ params }) =>
      ok(evidenceByFamily[String(params.familyId)] ?? null),
    ),
  );
}

function getFamilyKeys(): string[] {
  const rows = Array.from(document.querySelectorAll("tbody > tr"));
  return rows
    .map((row) => {
      const cell = row.querySelector("td");
      return cell?.textContent?.replace(/[▶▼]\s*/, "") ?? "";
    })
    .filter(Boolean);
}

function getSortHeader(label: string): HTMLElement {
  return screen.getByText(new RegExp(`^${label}(?: [\\u25B2\\u25BC])?$`));
}

describe("Families table sorting", () => {
  it("sorts by Tail Cost ascending then descending", async () => {
    setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);

    // Default order: alpha, beta, gamma
    expect(getFamilyKeys()).toEqual(["alpha", "beta", "gamma"]);

    // Click Tail Cost → asc (0, 5, 10)
    fireEvent.click(getSortHeader("Tail Cost"));
    expect(getFamilyKeys()).toEqual(["gamma", "beta", "alpha"]);

    // Click again → desc (10, 5, 0)
    fireEvent.click(getSortHeader("Tail Cost"));
    expect(getFamilyKeys()).toEqual(["alpha", "beta", "gamma"]);
  }, 15000);

  it("sorts by Tail-Adj PnL ascending", async () => {
    setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);

    // Click Tail-Adj PnL → asc (-5, -2, 8)
    fireEvent.click(getSortHeader("Tail-Adj PnL"));
    expect(getFamilyKeys()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("third click resets to original order", async () => {
    setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);

    fireEvent.click(getSortHeader("Positions"));
    fireEvent.click(getSortHeader("Positions"));
    fireEvent.click(getSortHeader("Positions"));

    // Back to original
    expect(getFamilyKeys()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("shows sort indicator on active column", async () => {
    setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);

    fireEvent.click(getSortHeader("Markets"));
    expect(screen.getByText(/Markets \u25B2/)).toBeInTheDocument();

    fireEvent.click(getSortHeader("Markets"));
    expect(screen.getByText(/Markets \u25BC/)).toBeInTheDocument();
  });

  it("renders per-family execution telemetry in list and expanded detail", async () => {
    setup();
    const user = userEvent.setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);

    expect(screen.getByText("80% maker")).toBeInTheDocument();
    expect(screen.getByText(/1 taker.*\$0\.120/)).toBeInTheDocument();

    await user.click(screen.getByText(/alpha/));

    expect(await screen.findByText("Execution (24h)")).toBeInTheDocument();
    expect(screen.getByText(/4 maker \/ 1 taker \/ 0 unknown/)).toBeInTheDocument();
    expect(screen.getByText(/fees \$0\.120/)).toBeInTheDocument();
    expect(screen.getByText(/leakage 1\.00%/)).toBeInTheDocument();
  });

  it("renders execution canary blockers inside evidence detail", async () => {
    setup({
      "fam-1": {
        familyId: "fam-1",
        evidenceStatus: "confirmed",
        evidenceScore: 0.8,
        promotionState: "probe-only",
        localTradeCount: 25,
        localMarketCount: 6,
        localRealizedPnlFifo: 4,
        openTailCostUsdc: 1,
        tailAdjustedPnl: 3,
        remoteClosedRealizedPnl: null,
        openPositionCount: 1,
        openDustCount: 0,
        bothSidedEligible: false,
        heavyCampaignEligible: false,
        activeWindowEdgeScore: null,
        recurrenceScore: 0.6,
        recycleScore: 0.7,
        liveViabilityScore: 0.5,
        toxicityPenalty: 0.1,
        lastValidatedAt: "2026-03-31T00:00:00Z",
        probeSubstate: null,
        repricingExitCount: 3,
        promotionBlockers: [],
        executionCanary24h: {
          windowHours: 24,
          required: true,
          eligible: false,
          minTotalFills: 10,
          blockers: [
            { metric: "24h fills", current: 5, required: 10, passed: false },
            { metric: "Taker fills", current: 1, required: 0, passed: false },
            { metric: "Explicit fees (USDC)", current: 0.12, required: 0, passed: false },
          ],
        },
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);
    await user.click(screen.getByText(/alpha/));
    await user.click(screen.getByText(/Evidence/));

    expect(await screen.findByText("Execution Canary (24h)")).toBeInTheDocument();
    expect(screen.getByText(/Execution Canary:/)).toBeInTheDocument();
    expect(screen.getByText("blocked")).toBeInTheDocument();
    expect(screen.getByText(/24h fills/)).toBeInTheDocument();
    expect(screen.getByText(/Taker fills/)).toBeInTheDocument();
  });
});

describe("Families scope toggle", () => {
  function scopeSetup(
    overrides: {
      items?: typeof families;
      scope?: "profile" | "all";
      profile?: string | null;
      totalCatalogCount?: number;
    } = {},
  ) {
    const items = overrides.items ?? families;
    server.use(
      http.get("/api/v1/families", () =>
        ok({
          items,
          meta: {
            scope: overrides.scope ?? "all",
            profile: overrides.profile ?? null,
            totalCatalogCount: overrides.totalCatalogCount ?? items.length,
          },
        }),
      ),
      http.get("/api/v1/families/:familyId/transitions", () => ok([])),
      http.get("/api/v1/families/:familyId/positions", () => ok([])),
      http.get("/api/v1/families/:familyId/orders", () => ok({ items: [], nextCursor: null })),
      http.get("/api/v1/families/:familyId/evidence", () => ok(null)),
    );
  }

  it("shows count with profile context in profile scope", async () => {
    scopeSetup({
      items: [families[0]!],
      scope: "profile",
      profile: "live-lite",
      totalCatalogCount: 47,
    });
    renderWithProviders(<Families />);
    await screen.findByText(/alpha/);
    expect(screen.getByText("1 of 47 families (live-lite)")).toBeInTheDocument();
  });

  it("shows plain count when scope=all", async () => {
    scopeSetup({ scope: "all", profile: null });
    renderWithProviders(<Families />);
    await screen.findByText(/alpha/);
    expect(screen.getByText("3 families")).toBeInTheDocument();
  });

  it("disables Current Profile button when no profile available", async () => {
    scopeSetup({ scope: "all", profile: null });
    renderWithProviders(<Families />);
    await screen.findByText(/alpha/);
    const btn = screen.getByText("Current Profile");
    expect(btn).toBeDisabled();
  });

  it("toggles to All Families and dims non-enabled rows with disabled badge", async () => {
    const profileFamilies = [
      {
        ...families[0]!,
        deployment: {
          enabled: true,
          operatorMode: "active",
          deploymentStage: "live",
          priority: 1,
        },
      },
    ];
    const allFamilies = [
      ...profileFamilies,
      {
        ...families[1]!,
        deployment: {
          enabled: false,
          operatorMode: "active",
          deploymentStage: "disabled",
          priority: 999,
        },
      },
    ];

    const scopesSeen: string[] = [];
    server.use(
      http.get("/api/v1/families", ({ request }) => {
        const url = new URL(request.url);
        const scope = url.searchParams.get("scope") ?? "none";
        scopesSeen.push(scope);
        if (scope === "all") {
          return ok({
            items: allFamilies,
            meta: {
              scope: "all",
              profile: "live-lite",
              totalCatalogCount: allFamilies.length,
            },
          });
        }
        return ok({
          items: profileFamilies,
          meta: {
            scope: "profile",
            profile: "live-lite",
            totalCatalogCount: allFamilies.length,
          },
        });
      }),
      http.get("/api/v1/families/:familyId/transitions", () => ok([])),
      http.get("/api/v1/families/:familyId/positions", () => ok([])),
      http.get("/api/v1/families/:familyId/orders", () => ok({ items: [], nextCursor: null })),
      http.get("/api/v1/families/:familyId/evidence", () => ok(null)),
    );
    const user = userEvent.setup();
    renderWithProviders(<Families />);

    // Profile view: only alpha visible
    await screen.findByText(/alpha/);
    expect(screen.queryByText(/beta/)).not.toBeInTheDocument();

    // Switch to All Families
    await user.click(screen.getByText("All Families"));
    await screen.findByText(/beta/);

    // Verify the toggle actually sent scope=all
    expect(scopesSeen).toContain("all");

    // Disabled badge should appear for beta
    const badges = document.querySelectorAll(".badge");
    const disabledBadge = Array.from(badges).find((b) => b.textContent === "disabled");
    expect(disabledBadge).toBeTruthy();

    // Dimmed row: beta's row should have opacity 0.45
    const rows = document.querySelectorAll("tbody > tr");
    const betaRow = Array.from(rows).find((r) => r.textContent?.includes("beta"));
    expect(betaRow).toBeTruthy();
    expect((betaRow as HTMLElement).style.opacity).toBe("0.45");
  });
});
