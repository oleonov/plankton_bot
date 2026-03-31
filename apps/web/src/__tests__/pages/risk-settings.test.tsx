import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { RiskSettings } from "../../pages/RiskSettings.tsx";

describe("RiskSettings", () => {
  it("renders profile tabs", async () => {
    renderWithProviders(<RiskSettings />);

    expect(await screen.findByText("Live-Lite")).toBeInTheDocument();
    expect(screen.getByText("Paper")).toBeInTheDocument();
    expect(screen.getByText("Simulation")).toBeInTheDocument();
  });

  it("shows form fields for the selected profile", async () => {
    renderWithProviders(<RiskSettings />);

    expect(await screen.findByText("Daily Loss Cap (USDC)")).toBeInTheDocument();
    expect(screen.getByText("Max Open Families")).toBeInTheDocument();
    expect(screen.getByText("Max Total Exposure (USDC)")).toBeInTheDocument();
  });

  it("typing values and clicking Save triggers mutation", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RiskSettings />);

    const fields = await screen.findAllByPlaceholderText("No limit");
    await user.type(fields[0]!, "500");

    await user.click(screen.getByText("Save"));

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeInTheDocument();
    });
  });
});
