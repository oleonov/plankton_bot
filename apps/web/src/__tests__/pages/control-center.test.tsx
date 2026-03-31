import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { ControlCenter } from "../../pages/ControlCenter.tsx";
import { mockStatus } from "../../test/handlers.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

describe("ControlCenter", () => {
  it("renders profile cards for all 3 profiles", async () => {
    renderWithProviders(<ControlCenter />);

    expect(await screen.findByText("Live-Lite")).toBeInTheDocument();
    expect(screen.getByText("Paper")).toBeInTheDocument();
    expect(screen.getByText("Simulation")).toBeInTheDocument();
  });

  it("shows ACTIVE PROFILE for the current profile (paper)", async () => {
    renderWithProviders(<ControlCenter />);

    expect(await screen.findByText("ACTIVE PROFILE")).toBeInTheDocument();
  });

  it("shows Pause button when running", async () => {
    renderWithProviders(<ControlCenter />);

    expect(await screen.findByText("Pause")).toBeInTheDocument();
  });

  it("shows Resume button when paused", async () => {
    server.use(
      http.get("/api/v1/status", () => ok({ ...mockStatus, paused: true })),
    );
    renderWithProviders(<ControlCenter />);

    expect(await screen.findByText("Resume")).toBeInTheDocument();
  });

  it("clicking Switch Profile opens the wizard", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ControlCenter />);

    const btn = await screen.findByText("Switch Profile");
    await user.click(btn);

    expect(await screen.findByText("Select Target Profile")).toBeInTheDocument();
  });
});
