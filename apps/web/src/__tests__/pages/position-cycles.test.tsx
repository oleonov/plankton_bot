import { describe, it, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router-dom";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { PositionCycles } from "../../pages/PositionCycles.tsx";
import { mockPositionCycles } from "../../test/handlers.ts";
import { Layout } from "../../components/Layout.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

describe("PositionCycles", () => {
  it("renders the P&L nav tab and route in the app chrome", async () => {
    renderWithProviders(
      <Routes>
        <Route element={<Layout />}>
          <Route path="/pnl" element={<PositionCycles />} />
        </Route>
      </Routes>,
      { initialEntries: ["/pnl"] },
    );

    expect(await screen.findByRole("link", { name: "P&L" })).toBeInTheDocument();
    expect(await screen.findByText("Position Cycles")).toBeInTheDocument();
  });

  it("renders the P&L screen with summary cards and cycle rows", async () => {
    renderWithProviders(<PositionCycles />);

    expect(await screen.findByText("Position Cycles")).toBeInTheDocument();
    expect(screen.getByText("Closed Realized P&L")).toBeInTheDocument();
    expect(screen.getByText("Open Net P&L")).toBeInTheDocument();
    expect(await screen.findByText("Bitcoin closes over $75k in June?")).toBeInTheDocument();
    expect(screen.getByText("OPEN LOSS")).toBeInTheDocument();
  });

  it("shows unknown accounting as n/a and not as zero P&L", async () => {
    renderWithProviders(<PositionCycles />);

    const warning = await screen.findByTestId("position-cycle-pos-unknown");
    expect(within(warning).getByText("UNKNOWN ACCT")).toBeInTheDocument();
    expect(within(warning).getAllByText("n/a").length).toBeGreaterThan(0);
    expect(within(warning).queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByTestId("accounting-warnings")).toBeInTheDocument();
  });

  it("expands a row with operations, result drivers, and accounting", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PositionCycles />);

    const row = await screen.findByTestId("position-cycle-pos-profit");
    await user.click(row.querySelector("button")!);

    const expanded = await screen.findByTestId("expanded-pos-profit");
    expect(within(expanded).getByText("Operations history")).toBeInTheDocument();
    expect(within(expanded).getByText(/Bought 10 @ \$0\.1000/)).toBeInTheDocument();
    expect(within(expanded).getByText(/Sold 10 @ \$0\.1500/)).toBeInTheDocument();
    expect(within(expanded).getByText("−$1.00 spent")).toBeInTheDocument();
    expect(within(expanded).getByText("+$1.50 received")).toBeInTheDocument();
    expect(within(expanded).getByText("Result drivers")).toBeInTheDocument();
    expect(within(expanded).getByText(/Exit: PROFILE_LADDER/)).toBeInTheDocument();
    expect(within(expanded).getByText(/High confidence/)).toBeInTheDocument();
  });

  it("open rows show remaining, liquidation, realized, and unrealized split", async () => {
    renderWithProviders(<PositionCycles />);

    const row = await screen.findByTestId("position-cycle-pos-open-loss");
    expect(within(row).getByText("OPEN LOSS")).toBeInTheDocument();
    expect(within(row).getByText("$4.00")).toBeInTheDocument();
    expect(within(row).getByText("liq $2.00")).toBeInTheDocument();
    expect(within(row).getByText(/real \$0\.00 · unr −\$2\.00 · liq \$2\.00/)).toBeInTheDocument();
  });

  it("filter changes call the API with the new params and reset pagination", async () => {
    const seen: string[] = [];
    server.use(
      http.get("/api/v1/pnl/position-cycles", ({ request }) => {
        seen.push(new URL(request.url).search);
        return ok({
          ...mockPositionCycles,
          pagination: { page: 1, pageSize: 25, totalCount: 60, totalPages: 3 },
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<PositionCycles />);
    await screen.findByText("Bitcoin closes over $75k in June?");

    await user.click(screen.getByText("→"));
    await waitFor(() => expect(seen.some((query) => query.includes("page=2"))).toBe(true));

    await user.click(screen.getByRole("button", { name: "7d" }));
    await waitFor(() => {
      expect(seen.some((query) => query.includes("period=7d") && query.includes("page=1"))).toBe(
        true,
      );
    });
  });

  it("shows an empty state when filtered cycles are empty even if warnings exist", async () => {
    server.use(
      http.get("/api/v1/pnl/position-cycles", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("status") === "closed") {
          return ok({
            ...mockPositionCycles,
            cycles: [],
            pagination: { page: 1, pageSize: 25, totalCount: 0, totalPages: 1 },
          });
        }
        return ok(mockPositionCycles);
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<PositionCycles />);
    await screen.findByText("Bitcoin closes over $75k in June?");

    await user.selectOptions(screen.getByDisplayValue("all status"), "closed");

    expect(await screen.findByText("No cycles match current filters")).toBeInTheDocument();
    expect(screen.queryByTestId("accounting-warnings")).not.toBeInTheDocument();
  });

  it("renders loading, empty, and error states", async () => {
    server.use(http.get("/api/v1/pnl/position-cycles", () => new Promise(() => undefined)));
    const { unmount } = renderWithProviders(<PositionCycles />);
    expect(screen.getAllByText("…").length).toBeGreaterThan(0);
    unmount();

    server.use(
      http.get("/api/v1/pnl/position-cycles", () =>
        ok({
          ...mockPositionCycles,
          accountingWarnings: [],
          cycles: [],
          pagination: { page: 1, pageSize: 25, totalCount: 0, totalPages: 1 },
        }),
      ),
    );
    renderWithProviders(<PositionCycles />);
    expect(await screen.findByText("No cycles match current filters")).toBeInTheDocument();
    unmount();

    server.use(
      http.get("/api/v1/pnl/position-cycles", () => HttpResponse.json({}, { status: 500 })),
    );
    renderWithProviders(<PositionCycles />);
    expect(await screen.findByText("Couldn't load position cycles")).toBeInTheDocument();
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
