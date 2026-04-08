import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { AlertStrip } from "../../components/AlertStrip.tsx";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { server } from "../../test/server.ts";
import { mockStatus } from "../../test/handlers.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

describe("AlertStrip", () => {
  it("does not show quarantined families from outside the current profile page", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          marketDataStale: false,
        }),
      ),
      http.get("/api/v1/families", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("scope") === "profile") {
          return ok({
            items: [],
            meta: { scope: "profile", profile: "live-lite", totalCatalogCount: 1, hasMore: false },
          });
        }
        return ok({
          items: [
            {
              familyId: "fam-disabled",
              familyKey: "disabled-fam",
              primaryCategory: "crypto",
              regime: "generic",
              horizon: "daily",
              cadence: "daily-dated",
              strategyProfile: "scalp",
              promotionState: null,
              probeSubstate: null,
              state: {
                runtimeMode: "quarantine",
                openValueUsdc: 0,
                openPositionCount: 0,
                openDustCount: 0,
                activeMarketCount: 0,
                currentTailCostUsdc: 0,
                tailAdjustedPnlLive: 0,
                quarantineReason: "disabled family",
                effectiveMode: "quarantine",
                derivedModeReason: null,
                updatedAt: new Date().toISOString(),
              },
              caps: null,
              deployment: {
                enabled: false,
                operatorMode: "quarantine",
                deploymentStage: "disabled",
              },
            },
          ],
          meta: { scope: "all", profile: "live-lite", totalCatalogCount: 1, hasMore: false },
        });
      }),
    );

    renderWithProviders(<AlertStrip />);

    expect(await screen.findByText(/SSE disconnected/i)).toBeInTheDocument();
    expect(screen.queryByText(/families quarantined/i)).not.toBeInTheDocument();
  });

  it("shows quarantined families from the current profile scoped list", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          marketDataStale: false,
        }),
      ),
      http.get("/api/v1/families", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("scope") === "profile") {
          return ok({
            items: [
              {
                familyId: "fam-live",
                familyKey: "alpha",
                primaryCategory: "crypto",
                regime: "generic",
                horizon: "daily",
                cadence: "daily-dated",
                strategyProfile: "scalp",
                promotionState: null,
                probeSubstate: null,
                state: {
                  runtimeMode: "quarantine",
                  openValueUsdc: 0,
                  openPositionCount: 0,
                  openDustCount: 0,
                  activeMarketCount: 0,
                  currentTailCostUsdc: 0,
                  tailAdjustedPnlLive: 0,
                  quarantineReason: "live family",
                  effectiveMode: "quarantine",
                  derivedModeReason: null,
                  updatedAt: new Date().toISOString(),
                },
                caps: null,
                deployment: {
                  enabled: true,
                  operatorMode: "quarantine",
                  deploymentStage: "live-probe",
                },
              },
            ],
            meta: { scope: "profile", profile: "live-lite", totalCatalogCount: 1, hasMore: false },
          });
        }
        return ok({
          items: [],
          meta: { scope: "all", profile: "live-lite", totalCatalogCount: 1, hasMore: false },
        });
      }),
    );

    renderWithProviders(<AlertStrip />);

    expect(await screen.findByText(/1 families quarantined — alpha/i)).toBeInTheDocument();
  });

  it("shows runtime infra alerts from status", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          marketDataStale: false,
          infraAlerts: [
            {
              code: "POLYGON_RPC_RATE_LIMITED",
              severity: "error",
              source: "polygon-rpc",
              message: "Polygon RPC rate limited — settlement may stall until quota resets.",
              details: null,
              lastSeenAt: new Date().toISOString(),
            },
          ],
        }),
      ),
      http.get("/api/v1/families", () =>
        ok({
          items: [],
          meta: { scope: "profile", profile: "live-lite", totalCatalogCount: 0, hasMore: false },
        }),
      ),
    );

    renderWithProviders(<AlertStrip />);

    expect(
      await screen.findByText(/Polygon RPC rate limited — settlement may stall until quota resets./i),
    ).toBeInTheDocument();
  });
});
