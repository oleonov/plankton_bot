import { describe, it, expect } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { FamilyDTO } from "../../api/types.ts";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Families } from "../../pages/Families.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

const families: FamilyDTO[] = [
  {
    familyId: "fam-1",
    familyKey: "alpha",
    primaryCategory: "crypto",
    regime: "threshold",
    horizon: "weekly",
    cadence: "daily",
    strategyProfile: "generic",
    liveness: "active",
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
      openValueUsdc: 50,
      openPositionCount: 3,
      openDustCount: 0,
      activeMarketCount: 5,
      currentTailCostUsdc: 10,
      tailAdjustedPnlLive: -2,
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
    liveness: "dormant",
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
      openValueUsdc: 20,
      openPositionCount: 1,
      openDustCount: 0,
      activeMarketCount: 2,
      currentTailCostUsdc: 5,
      tailAdjustedPnlLive: 8,
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
    liveness: "unseen",
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
      openValueUsdc: 0,
      openPositionCount: 0,
      openDustCount: 0,
      activeMarketCount: 0,
      currentTailCostUsdc: 0,
      tailAdjustedPnlLive: -5,
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
        meta: {
          scope: "all" as const,
          profile: null,
          totalCount: families.length,
          totalCatalogCount: families.length,
          hasMore: false,
          nextCursor: null,
        },
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
      const key = row.querySelector("[data-family-key]");
      return key?.textContent ?? "";
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
            totalCount: items.length,
            totalCatalogCount: overrides.totalCatalogCount ?? items.length,
            hasMore: false,
            nextCursor: null,
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
    expect(screen.getByText("1 families (live-lite)")).toBeInTheDocument();
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
              totalCount: allFamilies.length,
              totalCatalogCount: allFamilies.length,
              hasMore: false,
              nextCursor: null,
            },
          });
        }
        return ok({
          items: profileFamilies,
          meta: {
            scope: "profile",
            profile: "live-lite",
            totalCount: profileFamilies.length,
            totalCatalogCount: allFamilies.length,
            hasMore: false,
            nextCursor: null,
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

  it("shows liveness badges and dims non-active families in current profile view", async () => {
    scopeSetup({
      items: [
        {
          ...families[0]!,
          liveness: "active",
          deployment: {
            enabled: true,
            priority: 1,
          },
        },
        {
          ...families[1]!,
          liveness: "dormant",
          deployment: {
            enabled: true,
            priority: 2,
          },
        },
      ],
      scope: "profile",
      profile: "live-lite",
      totalCatalogCount: 47,
    });
    renderWithProviders(<Families />);

    await screen.findByText(/alpha/);
    expect(screen.getAllByText("active").length).toBeGreaterThan(0);
    expect(screen.getByText("dormant")).toBeInTheDocument();

    const rows = document.querySelectorAll("tbody > tr");
    const betaRow = Array.from(rows).find((r) => r.textContent?.includes("beta"));
    expect(betaRow).toBeTruthy();
    expect((betaRow as HTMLElement).style.opacity).toBe("0.6");
  });
});
