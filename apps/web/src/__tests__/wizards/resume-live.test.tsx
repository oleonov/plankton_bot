import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { ResumeLiveWizard } from "../../components/wizards/ResumeLiveWizard.tsx";

function renderWizard(onClose = () => {}) {
  return renderWithProviders(<ResumeLiveWizard onClose={onClose} />);
}

function findPreflightLabel() {
  return screen.findByText("Profile");
}

describe("ResumeLiveWizard", () => {
  it("step 1: shows preflight information", async () => {
    renderWizard();

    expect(await findPreflightLabel()).toBeInTheDocument();
    expect(screen.getByText("Exposure")).toBeInTheDocument();
    expect(screen.getByText("Balance")).toBeInTheDocument();
    expect(screen.getByText("Positions")).toBeInTheDocument();
  });

  it("step 3: button disabled until RESUME LIVE typed exactly", async () => {
    const user = userEvent.setup();
    renderWizard();

    await findPreflightLabel();
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next"));

    const resumeBtn = screen.getByRole("button", { name: "Resume" });
    expect(resumeBtn).toBeDisabled();

    const input = screen.getByPlaceholderText("RESUME LIVE");
    await user.type(input, "RESUME LIV");
    expect(resumeBtn).toBeDisabled();

    await user.type(input, "E");
    expect(screen.getByRole("button", { name: "Resume" })).not.toBeDisabled();
  });

  it("submitting calls resume mutation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWizard(onClose);

    await findPreflightLabel();
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next"));

    const input = screen.getByPlaceholderText("RESUME LIVE");
    await user.type(input, "RESUME LIVE");
    await user.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
