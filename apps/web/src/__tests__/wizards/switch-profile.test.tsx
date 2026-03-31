import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { SwitchProfileWizard } from "../../components/wizards/SwitchProfileWizard.tsx";

function renderWizard(onClose = () => {}) {
  return renderWithProviders(<SwitchProfileWizard onClose={onClose} />);
}

describe("SwitchProfileWizard", () => {
  it("step 1: shows target profile options excluding current (paper)", async () => {
    renderWizard();

    expect(await screen.findByText("Live-Lite")).toBeInTheDocument();
    expect(screen.getByText("Simulation")).toBeInTheDocument();
    // Current profile "Paper" should not appear as a selectable option
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
  });

  it("step 1: can select a target profile", async () => {
    const user = userEvent.setup();
    renderWizard();

    const simOption = await screen.findByText("Simulation");
    await user.click(simOption);

    const radios = screen.getAllByRole("radio");
    const checked = radios.find((r) => (r as HTMLInputElement).checked);
    expect(checked).toBeTruthy();
  });

  it("step 2: shows ledger reset policy options", async () => {
    const user = userEvent.setup();
    renderWizard();

    await screen.findByText("Simulation");
    await user.click(screen.getByText("Simulation"));
    await user.click(screen.getByText("Next"));

    expect(await screen.findByText("Preserve existing data")).toBeInTheDocument();
    expect(screen.getByText("Archive & reset")).toBeInTheDocument();
  });

  it("step 3: shows review summary", async () => {
    const user = userEvent.setup();
    renderWizard();

    await screen.findByText("Simulation");
    await user.click(screen.getByText("Simulation"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next"));

    expect(await screen.findByText("Switch Summary")).toBeInTheDocument();
    expect(screen.getByText("paper")).toBeInTheDocument();
    expect(screen.getByText("Preserve data")).toBeInTheDocument();
  });

  it("step 4: clicking Confirm Switch calls the mutation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWizard(onClose);

    await screen.findByText("Simulation");
    await user.click(screen.getByText("Simulation"));
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

    await screen.findByText("Simulation");
    await userEvent.click(screen.getByText("\u00D7"));

    expect(onClose).toHaveBeenCalled();
  });

  it("back button goes to previous step", async () => {
    const user = userEvent.setup();
    renderWizard();

    await screen.findByText("Simulation");
    await user.click(screen.getByText("Simulation"));
    await user.click(screen.getByText("Next"));

    expect(screen.getByText("Preserve existing data")).toBeInTheDocument();
    await user.click(screen.getByText("Back"));

    expect(screen.getByText("Simulation")).toBeInTheDocument();
    expect(screen.getByText("Live-Lite")).toBeInTheDocument();
  });
});
