import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { ResetLedgerWizard } from "../../components/wizards/ResetLedgerWizard.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

function renderWizard(onClose = () => {}) {
  return renderWithProviders(<ResetLedgerWizard onClose={onClose} />);
}

describe("ResetLedgerWizard", () => {
  it("step 1: shows profile options", async () => {
    renderWizard();

    expect(await screen.findByText("Live-Lite")).toBeInTheDocument();
    expect(screen.getByText("Paper")).toBeInTheDocument();
    expect(screen.getByText("Simulation")).toBeInTheDocument();
  });

  it("step 1: live-lite is blocked", async () => {
    renderWizard();

    expect(await screen.findByText("Live-lite ledger cannot be reset")).toBeInTheDocument();
  });

  it("step 3: button disabled until RESET typed", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/v1/actions/ledger/:profileId/reset", () => ok({ status: "reset" })),
    );
    renderWizard();

    await screen.findByText("Paper");
    await user.click(screen.getByText("Paper"));
    await user.click(screen.getByText("Next"));
    await user.click(screen.getByText("Next"));

    const resetBtn = screen.getByRole("button", { name: "Reset Ledger" });
    expect(resetBtn).toBeDisabled();

    const input = screen.getByPlaceholderText("RESET");
    await user.type(input, "RESE");
    expect(resetBtn).toBeDisabled();

    await user.type(input, "T");
    expect(screen.getByRole("button", { name: "Reset Ledger" })).not.toBeDisabled();
  });

  it("close button calls onClose", async () => {
    const onClose = vi.fn();
    renderWizard(onClose);

    await screen.findByText("Live-Lite");
    await userEvent.click(screen.getByText("\u00D7"));

    expect(onClose).toHaveBeenCalled();
  });
});
