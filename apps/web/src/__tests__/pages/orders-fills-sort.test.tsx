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

const orders = {
  items: [
    {
      orderId: "ord-a",
      clientOrderId: "c-a",
      tokenId: "tok-1",
      familyId: "fam-btc",
      side: "buy",
      orderType: "limit",
      price: 0.07,
      size: 57,
      sizeUsdc: 4,
      status: "filled",
      createdAt: "2026-03-31T14:30:00Z",
      updatedAt: "2026-03-31T14:35:00Z",
      slug: null,
      eventSlug: null,
      question: "Bitcoin above 60k",
      outcome: "Yes",
      conditionId: null,
      endDate: "2026-04-01T00:00:00Z",
    },
    {
      orderId: "ord-b",
      clientOrderId: "c-b",
      tokenId: "tok-2",
      familyId: "fam-eth",
      side: "sell",
      orderType: "limit",
      price: 0.22,
      size: 88,
      sizeUsdc: 19,
      status: "open",
      createdAt: "2026-03-31T14:00:00Z",
      updatedAt: "2026-03-31T14:44:00Z",
      slug: null,
      eventSlug: null,
      question: "Ethereum above 1700",
      outcome: "Yes",
      conditionId: null,
      endDate: "2026-04-02T00:00:00Z",
    },
    {
      orderId: "ord-c",
      clientOrderId: "c-c",
      tokenId: "tok-3",
      familyId: "fam-sol",
      side: "buy",
      orderType: "limit",
      price: 0.13,
      size: 248,
      sizeUsdc: 32,
      status: "filled",
      createdAt: "2026-03-31T13:00:00Z",
      updatedAt: "2026-03-31T14:44:12Z",
      slug: null,
      eventSlug: null,
      question: "Solana above 150",
      outcome: "Yes",
      conditionId: null,
      endDate: null,
    },
  ],
  nextCursor: null,
};

const fills = {
  items: [
    {
      fillId: "fill-x",
      orderId: "ord-a",
      tokenId: "tok-1",
      familyId: "fam-btc",
      side: "buy",
      price: 0.07,
      size: 57,
      sizeUsdc: 4,
      fee: 0,
      filledAt: "2026-03-31T14:35:00Z",
      slug: null,
      eventSlug: null,
      question: "Bitcoin above 60k",
      outcome: "Yes",
      conditionId: null,
      endDate: null,
    },
    {
      fillId: "fill-y",
      orderId: "ord-b",
      tokenId: "tok-2",
      familyId: "fam-eth",
      side: "sell",
      price: 0.22,
      size: 88,
      sizeUsdc: 19,
      fee: 0,
      filledAt: "2026-03-31T14:44:00Z",
      slug: null,
      eventSlug: null,
      question: "Ethereum above 1700",
      outcome: "Yes",
      conditionId: null,
      endDate: null,
    },
    {
      fillId: "fill-z",
      orderId: "ord-c",
      tokenId: "tok-3",
      familyId: "fam-sol",
      side: "sell",
      price: 0.04,
      size: 28,
      sizeUsdc: 1,
      fee: 0,
      filledAt: "2026-03-31T14:00:00Z",
      slug: null,
      eventSlug: null,
      question: "Solana above 150",
      outcome: "Yes",
      conditionId: null,
      endDate: null,
    },
  ],
  nextCursor: null,
};

function setupOrders() {
  server.use(http.get("/api/v1/orders", () => ok(orders)));
}

function setupFills() {
  server.use(http.get("/api/v1/fills", () => ok(fills)));
}

function getColumnValues(colIndex: number): string[] {
  const rows = screen.getAllByRole("row").slice(1);
  return rows.map((row) => {
    const cells = within(row).getAllByRole("cell");
    return cells[colIndex]?.textContent ?? "";
  });
}

describe("Orders table sorting", () => {
  it("sorts by Price ascending then descending", { timeout: 15_000 }, async () => {
    setupOrders();
    const user = userEvent.setup();
    renderWithProviders(<OrdersFills />);

    await screen.findByText("Bitcoin above 60k");

    // Click Price → asc (0.07, 0.13, 0.22)
    await user.click(screen.getByText("Price"));
    const asc = getColumnValues(4);
    expect(asc).toEqual(["$0.0700", "$0.1300", "$0.2200"]);

    // Click again → desc
    await user.click(screen.getByText(/Price/));
    const desc = getColumnValues(4);
    expect(desc).toEqual(["$0.2200", "$0.1300", "$0.0700"]);
  });

  it("sorts by Size ascending", async () => {
    setupOrders();
    const user = userEvent.setup();
    renderWithProviders(<OrdersFills />);

    await screen.findByText("Bitcoin above 60k");

    await user.click(screen.getByText("Size"));
    const sizes = getColumnValues(5);
    expect(sizes).toEqual(["57.00", "88.00", "248.00"]);
  });

  it("sorts by Side ascending", async () => {
    setupOrders();
    const user = userEvent.setup();
    renderWithProviders(<OrdersFills />);

    await screen.findByText("Bitcoin above 60k");

    await user.click(screen.getByText("Side"));
    const sides = getColumnValues(3);
    expect(sides).toEqual(["BUY", "BUY", "SELL"]);
  });
});

describe("Fills table sorting", () => {
  it("sorts by USDC ascending then descending", async () => {
    setupFills();
    const user = userEvent.setup();
    renderWithProviders(<OrdersFills />);

    // Switch to Fills tab
    await user.click(screen.getByText("Fills"));
    await screen.findByText("Bitcoin above 60k");

    // Click USDC → asc (1, 4, 19)
    await user.click(screen.getByText("USDC"));
    const asc = getColumnValues(6);
    expect(asc).toEqual(["$1.00", "$4.00", "$19.00"]);

    // Click again → desc (19, 4, 1)
    await user.click(screen.getByText(/USDC/));
    const desc = getColumnValues(6);
    expect(desc).toEqual(["$19.00", "$4.00", "$1.00"]);
  });

  it("sorts by Price ascending", async () => {
    setupFills();
    const user = userEvent.setup();
    renderWithProviders(<OrdersFills />);

    await user.click(screen.getByText("Fills"));
    await screen.findByText("Bitcoin above 60k");

    await user.click(screen.getByText("Price"));
    const prices = getColumnValues(4);
    expect(prices).toEqual(["$0.0400", "$0.0700", "$0.2200"]);
  });
});
