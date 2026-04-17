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
  it("shows SSE disconnected when SSE is not connected", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          marketDataStale: false,
        }),
      ),
    );

    renderWithProviders(<AlertStrip />);

    expect(await screen.findByText(/SSE disconnected/i)).toBeInTheDocument();
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
      await screen.findByText(
        /Polygon RPC rate limited — settlement may stall until quota resets./i,
      ),
    ).toBeInTheDocument();
  });
});
