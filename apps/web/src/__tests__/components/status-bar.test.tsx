import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { StatusBar } from "../../components/StatusBar.tsx";
import { mockStatus } from "../../test/handlers.ts";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

describe("StatusBar", () => {
  it("keeps health indicators without redundant live-lite labels", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          executionMode: "live",
          paused: false,
        }),
      ),
    );

    renderWithProviders(<StatusBar />);

    expect(await screen.findByText("RUNNING")).toBeInTheDocument();
    expect(screen.getByText(/uptime:/)).toBeInTheDocument();
    expect(screen.getByText(/recon:/)).toBeInTheDocument();
    expect(screen.getByText("FRESH")).toBeInTheDocument();
    expect(screen.queryByText("live-lite")).not.toBeInTheDocument();
    expect(screen.queryByText(/data:live exec:live/)).not.toBeInTheDocument();
    expect(screen.queryByText(/real orders on exchange/i)).not.toBeInTheDocument();
  });
});
