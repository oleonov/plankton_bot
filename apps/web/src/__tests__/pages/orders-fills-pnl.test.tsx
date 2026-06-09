import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { OrdersFills } from "../../pages/OrdersFills.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

function fill(overrides: Record<string, unknown>) {
  return {
    fillId: "fill-1",
    orderId: "ord-1",
    tokenId: "tok-a",
    side: "buy",
    price: 0.33,
    size: 10,
    sizeUsdc: 3.3,
    liquidityRole: "maker",
    explicitFeeUsdc: 0,
    fee: 0,
    pnlUsd: null,
    pnlPct: null,
    filledAt: "2026-04-24T09:00:00Z",
    slug: null,
    eventSlug: null,
    question: "Market A",
    outcome: "Yes",
    conditionId: null,
    endDate: null,
    ...overrides,
  };
}

async function openFills(items: unknown[]) {
  server.use(
    http.get("/api/v1/fills", () => ok({ items, nextCursor: null, totalCount: items.length })),
  );
  const user = userEvent.setup();
  renderWithProviders(<OrdersFills />, { initialEntries: ["/orders?tab=fills"] });
  await screen.findByText("Filled At");
  return user;
}

describe("OrdersFills — per-SELL P&L column", () => {
  it("BUY fills show an em-dash placeholder, not a number", async () => {
    await openFills([
      fill({ fillId: "f-buy", side: "buy", pnlUsd: null, pnlPct: null, question: "Buy mkt" }),
      fill({ fillId: "f-sell", side: "sell", pnlUsd: 1.12, pnlPct: 145.45, question: "Sell mkt" }),
    ]);
    const dash = await screen.findByText("—");
    expect(dash.closest("td")).toHaveAttribute("data-pnl-sign", "none");
  });

  it("profitable SELL renders a green, signed gain", async () => {
    await openFills([
      fill({ fillId: "f-win", side: "sell", pnlUsd: 1.12, pnlPct: 145.45, question: "Win mkt" }),
    ]);
    const money = await screen.findByText("+$1.12");
    const cell = money.closest("td")!;
    expect(cell).toHaveAttribute("data-pnl-sign", "pos");
    expect(within(cell).getByText(/^\+145(\.\d)?%$/)).toBeInTheDocument();
  });

  it("losing SELL renders a red, signed loss", async () => {
    await openFills([
      fill({ fillId: "f-loss", side: "sell", pnlUsd: -0.4, pnlPct: -40, question: "Loss mkt" }),
    ]);
    const money = await screen.findByText("−$0.40");
    const cell = money.closest("td")!;
    expect(cell).toHaveAttribute("data-pnl-sign", "neg");
    expect(within(cell).getByText("−40.0%")).toBeInTheDocument();
  });

  it("hides the P&L column entirely when no fill carries P&L data", async () => {
    await openFills([
      fill({ fillId: "f-b1", side: "buy", pnlUsd: null, pnlPct: null, question: "Only buys" }),
      fill({ fillId: "f-b2", side: "buy", pnlUsd: null, pnlPct: null, question: "Only buys 2" }),
    ]);
    expect(screen.queryByText("P&L")).not.toBeInTheDocument();
  });
});
