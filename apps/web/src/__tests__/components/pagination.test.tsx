import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Pagination } from "../../components/Pagination.tsx";
import { renderWithProviders } from "../../test/test-utils.tsx";

describe("Pagination", () => {
  it("renders numbered controls even when there is only one page", async () => {
    const onPageChange = vi.fn();
    renderWithProviders(
      <Pagination page={1} totalPages={1} onPageChange={onPageChange} pageInfo="1–10 of 10" />,
    );

    expect(screen.getByRole("button", { name: "←" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "→" })).toBeDisabled();
    expect(screen.getByText("1–10 of 10")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "1" }));
    expect(onPageChange).not.toHaveBeenCalled();
  });
});
