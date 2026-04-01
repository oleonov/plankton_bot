import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { AppFooter } from "../../components/AppFooter.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

describe("AppFooter", () => {
  it("renders version and sha when deploy metadata exists", async () => {
    server.use(
      http.get("/api/v1/health", () =>
        ok({
          status: "ok",
          uptime: 100,
          sha: "abc1234def",
          deployVersion: 42,
          deployedAt: "2026-04-01T12:00:00Z",
        }),
      ),
    );

    renderWithProviders(<AppFooter />);

    const footer = await screen.findByText(/v042/);
    expect(footer).toBeInTheDocument();
    expect(footer.textContent).toContain("abc1234");
  });

  it("renders sha only when deployVersion is null", async () => {
    server.use(
      http.get("/api/v1/health", () =>
        ok({ status: "ok", uptime: 100, sha: "ffc0ae4", deployVersion: null, deployedAt: null }),
      ),
    );

    renderWithProviders(<AppFooter />);

    const footer = await screen.findByText(/ffc0ae4/);
    expect(footer).toBeInTheDocument();
    expect(footer.textContent).not.toContain("v0");
  });

  it("renders nothing when no metadata available", async () => {
    server.use(
      http.get("/api/v1/health", () =>
        ok({ status: "ok", uptime: 100, sha: null, deployVersion: null, deployedAt: null }),
      ),
    );

    renderWithProviders(<AppFooter />);

    // Wait for query to settle, then verify no footer rendered
    await waitFor(() => {
      expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
    });
  });

  it("shows deployedAt in title tooltip", async () => {
    server.use(
      http.get("/api/v1/health", () =>
        ok({
          status: "ok",
          uptime: 100,
          sha: "abc1234",
          deployVersion: 5,
          deployedAt: "2026-04-01T14:30:00Z",
        }),
      ),
    );

    renderWithProviders(<AppFooter />);

    const footer = await screen.findByText(/v005/);
    expect(footer.title).toContain("2026-04-01T14:30:00Z");
  });
});
