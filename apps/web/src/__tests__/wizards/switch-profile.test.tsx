import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { SwitchProfileWizard } from "../../components/wizards/SwitchProfileWizard.tsx";
import { server } from "../../test/server.ts";
import { mockProfiles } from "../../test/handlers.ts";

function renderWizard(onClose = () => {}) {
  return renderWithProviders(<SwitchProfileWizard onClose={onClose} />);
}

describe("SwitchProfileWizard", () => {
  it("shows only supported runtime targets", async () => {
    renderWizard();

    expect(await screen.findByText("Live-Lite")).toBeInTheDocument();
    expect(screen.queryByText("Paper")).not.toBeInTheDocument();
    expect(screen.queryByText("Simulation")).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("shows an empty state when current profile is live-lite", async () => {
    server.use(
      http.get("/api/v1/profiles", () =>
        HttpResponse.json({
          ok: true,
          data: {
            ...mockProfiles,
            runtimeState: {
              current_profile: "live-lite",
              desired_profile: "live-lite",
              runtime_status: "running",
            },
          },
          error: null,
          ts: new Date().toISOString(),
        }),
      ),
    );

    renderWizard();

    expect(await screen.findByText("No other profiles available")).toBeInTheDocument();
    expect(screen.queryByText("Paper")).not.toBeInTheDocument();
    expect(screen.queryByText("Simulation")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("can switch to live-lite when it is the only supported target", async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByText("Live-Lite"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next"));

    expect(await screen.findByText("Switch Summary")).toBeInTheDocument();
    expect(screen.getByText("Live-Lite")).toBeInTheDocument();
    expect(screen.getByText("Preserve data")).toBeInTheDocument();
  });

  it("clicking Confirm Switch calls the mutation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWizard(onClose);

    await user.click(await screen.findByText("Live-Lite"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Confirm Switch"));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("close button calls onClose", async () => {
    const onClose = vi.fn();
    renderWizard(onClose);

    await screen.findByText("Live-Lite");
    await userEvent.click(screen.getByText("\u00D7"));

    expect(onClose).toHaveBeenCalled();
  });
});
