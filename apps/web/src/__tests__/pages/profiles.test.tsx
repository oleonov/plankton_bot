import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Profiles } from "../../pages/Profiles.tsx";
import { mockProfiles } from "../../test/handlers.ts";

describe("Profiles", () => {
  it("renders profile tabs for all 3 profiles", async () => {
    renderWithProviders(<Profiles />);

    expect(await screen.findByText("Live-Lite")).toBeInTheDocument();
    expect(screen.getByText("Paper")).toBeInTheDocument();
    expect(screen.getByText("Simulation")).toBeInTheDocument();
  });

  it("first tab auto-selected shows Summary content", async () => {
    renderWithProviders(<Profiles />);

    expect(await screen.findByText("Summary")).toBeInTheDocument();
    expect(screen.getByText("Exposure")).toBeInTheDocument();
  });

  it("clicking another tab switches content", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Profiles />);

    await screen.findByText("Live-Lite");
    await user.click(screen.getByText("Paper"));

    expect(await screen.findByText("Summary")).toBeInTheDocument();
    expect(await screen.findByText("$32.06")).toBeInTheDocument();
  });

  it("shows deployed families count in sub-tab", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Profiles />);

    await screen.findByText("Live-Lite");
    await user.click(screen.getByText("Paper"));

    expect(await screen.findByText(/Deployed Families \(1\)/)).toBeInTheDocument();
  });

  it("only current profile shows RUNNING, others show STOPPED", async () => {
    renderWithProviders(<Profiles />);

    // Wait for profiles to load — current_profile is "paper" in mock
    await screen.findByText("Live-Lite");

    // Get all badge texts — paper should be RUNNING, others STOPPED
    const badges = screen.getAllByText(/running|stopped|paused/i);
    const badgeTexts = badges.map((b) => b.textContent?.toLowerCase());

    // Mock has current_profile = "paper" and paused = false
    // Live-Lite and Simulation should be "stopped", Paper should be "running"
    expect(badgeTexts.filter((t) => t === "stopped")).toHaveLength(2);
    expect(badgeTexts.filter((t) => t === "running")).toHaveLength(1);
  });

  it("current profile shows runtime_status when not running (e.g. stopped, failed)", async () => {
    server.use(
      http.get("/api/v1/profiles", () =>
        HttpResponse.json({
          ok: true,
          data: {
            ...mockProfiles,
            runtimeState: {
              current_profile: "paper",
              desired_profile: "paper",
              runtime_status: "stopped",
            },
          },
          error: null,
          ts: new Date().toISOString(),
        }),
      ),
    );

    renderWithProviders(<Profiles />);
    await screen.findByText("Live-Lite");

    const badges = screen.getAllByText(/running|stopped|paused|failed|starting|stopping/i);
    const badgeTexts = badges.map((b) => b.textContent?.toLowerCase());

    // All 3 should show "stopped" — current profile has runtime_status=stopped
    expect(badgeTexts.filter((t) => t === "stopped")).toHaveLength(3);
    expect(badgeTexts.filter((t) => t === "running")).toHaveLength(0);
  });

  it("switching to Deployed Families sub-tab shows family table", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Profiles />);

    await screen.findByText("Live-Lite");
    await user.click(screen.getByText("Paper"));

    const familiesTab = await screen.findByText(/Deployed Families \(1\)/);
    await user.click(familiesTab);

    expect(await screen.findByText("bitcoin-above")).toBeInTheDocument();
  });
});
