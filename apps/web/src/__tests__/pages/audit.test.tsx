import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Audit } from "../../pages/Audit.tsx";

describe("Audit", () => {
  it("renders audit entries from mock data", async () => {
    renderWithProviders(<Audit />);

    expect(await screen.findByText("fam-1")).toBeInTheDocument();
  });

  it("shows entity type", async () => {
    renderWithProviders(<Audit />);

    expect(await screen.findByText("family")).toBeInTheDocument();
  });

  it("shows from and to states", async () => {
    renderWithProviders(<Audit />);

    await screen.findByText("fam-1");
    expect(screen.getByText(/probe-only/)).toBeInTheDocument();
    expect(screen.getByText(/scaled/)).toBeInTheDocument();
  });

  it("shows trigger type and initiator", async () => {
    renderWithProviders(<Audit />);

    expect(await screen.findByText("operator")).toBeInTheDocument();
    expect(screen.getByText("admin")).toBeInTheDocument();
  });
});
