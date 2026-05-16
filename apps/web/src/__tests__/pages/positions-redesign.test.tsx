import { describe, it, expect, beforeEach } from "vitest";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { server } from "../../test/server.ts";
import { Positions } from "../../pages/Positions.tsx";
import { TWEAKS_STORAGE_KEY, DEFAULT_TWEAKS } from "../../pages/positions/useTweaks.ts";
import type { PositionDTO, PositionPhase } from "../../api/types.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

function makePosition(overrides: Partial<PositionDTO>): PositionDTO {
  return {
    positionId: "pos-x",
    tokenId: "tok-x",
    side: "buy",
    size: 10,
    avgEntryPrice: 0.2,
    costBasisUsdc: 2.0,
    currentValueUsdc: 3.0,
    realizedPnl: 0,
    status: "open",
    openedAt: "2026-04-20T00:00:00Z",
    closedAt: null,
    updatedAt: "2026-04-24T10:00:00Z",
    slug: "test-market",
    eventSlug: "test-event",
    question: "Will BTC be above $100k?",
    outcome: "Yes",
    conditionId: "cond-x",
    endDate: "2026-05-20T00:00:00Z",
    resolution: null,
    resolutionStatus: null,
    phase: "S1",
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    lastActionAt: "2026-04-24T11:50:00Z",
    ...overrides,
  };
}

const FIXTURES: PositionDTO[] = [
  makePosition({
    positionId: "pos-s1-btc",
    tokenId: "tok-btc",
    question: "Will BTC be above $100k?",
    outcome: "Yes",
    phase: "S1",
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    lastActionAt: "2026-04-24T11:55:00Z",
  }),
  makePosition({
    positionId: "pos-s2-eth",
    tokenId: "tok-eth",
    question: "Will ETH flip SOL?",
    outcome: "No",
    phase: "S2",
    buyCount: 3,
    sellCount: 0,
    lastAction: "BUY",
    lastActionAt: "2026-04-24T09:00:00Z",
    costBasisUsdc: 5.0,
    currentValueUsdc: 8.5,
  }),
  makePosition({
    positionId: "pos-s3-doge",
    tokenId: "tok-doge",
    question: "Will DOGE be #1 meme?",
    outcome: "Up",
    phase: "S3",
    buyCount: 2,
    sellCount: 1,
    lastAction: "SELL",
    lastActionAt: "2026-04-23T12:00:00Z",
    costBasisUsdc: 4.2,
    currentValueUsdc: 3.1,
  }),
  makePosition({
    positionId: "pos-s0-closed",
    tokenId: "tok-xrp",
    question: "Will XRP win?",
    outcome: "Down",
    status: "closed",
    closedAt: "2026-04-24T10:00:00Z",
    phase: "S0",
    buyCount: 1,
    sellCount: 1,
    lastAction: "SELL",
    lastActionAt: "2026-04-24T10:00:00Z",
    currentValueUsdc: 0,
    realizedPnl: -1.5,
    costBasisUsdc: 1.5,
  }),
  makePosition({
    positionId: "pos-dust-sol",
    tokenId: "tok-sol",
    question: "Will SOL crash?",
    outcome: "No",
    status: "dust",
    phase: "S0",
    buyCount: 1,
    sellCount: 0,
    lastAction: "BUY",
    lastActionAt: "2026-04-24T08:00:00Z",
    currentValueUsdc: 0.01,
    costBasisUsdc: 0.4,
  }),
];

function seedPositions(items: PositionDTO[] = FIXTURES) {
  server.use(
    http.get("/api/v1/positions", () =>
      ok({ items, nextCursor: null, totalCount: items.length, totalPages: 1 }),
    ),
    http.get("/api/v1/fills", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
  );
}

function visiblePositionIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="position-row-"]')).map(
    (row) => row.dataset.testid!.replace("position-row-", ""),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // Most assertions in this file pre-date the hideClosedByDefault flip and
  // assume closed positions stay visible. Seed an explicit `false` so they
  // see the original behaviour; the dedicated "default hides closed" test
  // clears localStorage itself to pick up the new default.
  window.localStorage.setItem(
    TWEAKS_STORAGE_KEY,
    JSON.stringify({ ...DEFAULT_TWEAKS, hideClosedByDefault: false }),
  );
});

describe("PositionsPage — redesign", () => {
  it("renders all positions with market questions", async () => {
    seedPositions();
    renderWithProviders(<Positions />);

    expect(await screen.findByText("Will BTC be above $100k?")).toBeInTheDocument();
    expect(screen.getByText("Will ETH flip SOL?")).toBeInTheDocument();
    expect(screen.getByText("Will DOGE be #1 meme?")).toBeInTheDocument();
  });

  it("filters by search query against market and position id", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will BTC be above $100k?");

    const user = userEvent.setup();
    const search = screen.getByLabelText(/search positions/i);
    await user.type(search, "eth");

    expect(screen.queryByText("Will BTC be above $100k?")).not.toBeInTheDocument();
    expect(screen.getByText("Will ETH flip SOL?")).toBeInTheDocument();
    expect(screen.queryByText("Will DOGE be #1 meme?")).not.toBeInTheDocument();
  });

  it("phase chips are exclusive single-select filters", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will BTC be above $100k?");

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Accum\./i }));

    expect(screen.queryByText("Will BTC be above $100k?")).not.toBeInTheDocument();
    expect(screen.getByText("Will ETH flip SOL?")).toBeInTheDocument();
    expect(screen.queryByText("Will DOGE be #1 meme?")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /All/i }));
    expect(screen.getByText("Will BTC be above $100k?")).toBeInTheDocument();
    expect(screen.getByText("Will ETH flip SOL?")).toBeInTheDocument();
  });

  it("Hide closed is on by default, hides only closed, and keeps dust visible", async () => {
    // Reset the per-suite seed so we exercise the actual app default.
    window.localStorage.clear();
    seedPositions();
    renderWithProviders(<Positions />);
    // BTC is open and visible immediately; XRP is closed and hidden by default.
    // Dust is controlled by the separate Hide dust toggle, not by Hide closed.
    await screen.findByText("Will BTC be above $100k?");
    expect(screen.queryByText("Will XRP win?")).not.toBeInTheDocument();
    expect(screen.getByText("Will SOL crash?")).toBeInTheDocument();

    const user = userEvent.setup();
    const closedToggle = screen.getByLabelText(/Hide closed/);
    await user.click(closedToggle);

    expect(screen.getByText("Will XRP win?")).toBeInTheDocument();
    expect(screen.getByText("Will BTC be above $100k?")).toBeInTheDocument();
  });

  it("Hide dust removes dust positions", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will SOL crash?");

    const user = userEvent.setup();
    const dustToggle = screen.getByLabelText(/Hide dust/);
    await user.click(dustToggle);

    expect(screen.queryByText("Will SOL crash?")).not.toBeInTheDocument();
    expect(screen.getByText("Will BTC be above $100k?")).toBeInTheDocument();
  });

  it("sorts Value through ascending, descending, and default while Hide dust still applies", async () => {
    seedPositions([
      makePosition({
        positionId: "sort-mid",
        question: "Middle value",
        currentValueUsdc: 5,
        lastActionAt: "2026-04-24T10:00:00Z",
      }),
      makePosition({
        positionId: "sort-dust",
        question: "Dust value",
        status: "dust",
        currentValueUsdc: 3,
        lastActionAt: "2026-04-24T10:00:00Z",
      }),
      makePosition({
        positionId: "sort-low",
        question: "Low value",
        currentValueUsdc: 1,
        lastActionAt: "2026-04-24T10:00:00Z",
      }),
      makePosition({
        positionId: "sort-high",
        question: "High value",
        currentValueUsdc: 9,
        lastActionAt: "2026-04-24T10:00:00Z",
      }),
    ]);
    renderWithProviders(<Positions />);
    await screen.findByText("Middle value");

    const user = userEvent.setup();
    const valueHeader = screen.getByRole("button", { name: "Value" });
    const valueColumn = screen.getByRole("columnheader", { name: "Value" });

    expect(visiblePositionIds()).toEqual(["sort-mid", "sort-dust", "sort-low", "sort-high"]);
    expect(valueColumn).toHaveAttribute("aria-sort", "none");

    await user.click(valueHeader);
    expect(valueColumn).toHaveAttribute("aria-sort", "ascending");
    expect(valueHeader.textContent).toContain("▲");
    expect(visiblePositionIds()).toEqual(["sort-low", "sort-dust", "sort-mid", "sort-high"]);

    await user.click(screen.getByLabelText(/Hide dust/));
    expect(visiblePositionIds()).toEqual(["sort-low", "sort-mid", "sort-high"]);

    await user.click(valueHeader);
    expect(valueColumn).toHaveAttribute("aria-sort", "descending");
    expect(valueHeader.textContent).toContain("▼");
    expect(visiblePositionIds()).toEqual(["sort-high", "sort-mid", "sort-low"]);

    await user.click(valueHeader);
    expect(valueColumn).toHaveAttribute("aria-sort", "none");
    expect(valueHeader.textContent).not.toContain("▲");
    expect(valueHeader.textContent).not.toContain("▼");
    expect(visiblePositionIds()).toEqual(["sort-mid", "sort-low", "sort-high"]);
  });

  it("keeps phase grouping active while sorting rows inside each group", async () => {
    seedPositions([
      makePosition({
        positionId: "phase-s2-high",
        question: "S2 high value",
        phase: "S2",
        currentValueUsdc: 8,
      }),
      makePosition({
        positionId: "phase-s1-mid",
        question: "S1 middle value",
        phase: "S1",
        currentValueUsdc: 5,
      }),
      makePosition({
        positionId: "phase-s2-low",
        question: "S2 low value",
        phase: "S2",
        currentValueUsdc: 2,
      }),
    ]);
    renderWithProviders(<Positions />);
    await screen.findByText("S2 high value");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/Group by/i), "phase");
    await user.click(screen.getByRole("button", { name: "Value" }));

    expect(screen.getByText(/Accumulating \(S2\)/)).toBeInTheDocument();
    expect(screen.getByText(/First Entry \(S1\)/)).toBeInTheDocument();
    expect(visiblePositionIds()).toEqual(["phase-s2-low", "phase-s2-high", "phase-s1-mid"]);
  });

  it("persists tweaks to localStorage", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will BTC be above $100k?");

    // beforeEach seeds hideClosedByDefault=false; clicking flips it to true
    // and that flip must round-trip through localStorage.
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/Hide closed/));

    await waitFor(() => {
      const raw = window.localStorage.getItem(TWEAKS_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as Record<string, unknown>;
      expect(parsed.hideClosedByDefault).toBe(true);
    });
  });

  it("re-buckets rows when Group by changes to Phase", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will BTC be above $100k?");

    const user = userEvent.setup();
    const groupBy = screen.getByLabelText(/Group by/i);
    await user.selectOptions(groupBy, "phase");

    expect(screen.getByText(/Accumulating \(S2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Distributing \(S3\)/)).toBeInTheDocument();
    expect(screen.getByText(/First Entry \(S1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Idle \(S0\)/)).toBeInTheDocument();
  });

  it("shows No Group as the last grouping option and renders rows without group headers", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will BTC be above $100k?");

    const user = userEvent.setup();
    const groupBy = screen.getByLabelText<HTMLSelectElement>(/Group by/i);
    expect(Array.from(groupBy.options).map((o) => o.value)).toEqual([
      "lastAction",
      "phase",
      "pnl",
      "ends",
      "none",
    ]);
    expect(groupBy.options[groupBy.options.length - 1]!.textContent).toBe("Group: No Group");

    await user.selectOptions(groupBy, "none");

    expect(groupBy.value).toBe("none");
    expect(screen.queryByText(/Accumulating \(S2\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/First Entry \(S1\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Idle \(S0\)/)).not.toBeInTheDocument();
    expect(screen.queryByText("No Group")).not.toBeInTheDocument();
    expect(visiblePositionIds()).toEqual([
      "pos-s1-btc",
      "pos-s2-eth",
      "pos-s3-doge",
      "pos-s0-closed",
      "pos-dust-sol",
    ]);
  });

  it("opens the drawer on row click and closes on backdrop click", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will BTC be above $100k?");

    const user = userEvent.setup();
    const row = screen.getByTestId("position-row-pos-s2-eth");
    await user.click(row);

    const drawer = await screen.findByTestId("position-drawer");
    expect(within(drawer).getByText("Will ETH flip SOL?")).toBeInTheDocument();
    expect(within(drawer).getByText(/buy_count=3, last=BUY/)).toBeInTheDocument();

    await user.click(screen.getByTestId("position-drawer-backdrop"));
    await waitFor(() => {
      expect(within(drawer).queryByText(/buy_count=3/)).not.toBeInTheDocument();
    });
  });

  it("closes the drawer on Escape", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will BTC be above $100k?");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("position-row-pos-s2-eth"));
    const drawer = await screen.findByTestId("position-drawer");
    expect(within(drawer).getByText("Will ETH flip SOL?")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => {
      expect(within(drawer).queryByText(/buy_count=3/)).not.toBeInTheDocument();
    });
  });

  it("does not render a Tweaks FAB anymore", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will BTC be above $100k?");
    expect(screen.queryByRole("button", { name: /Tweaks/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /Tweaks/i })).not.toBeInTheDocument();
  });

  it("encodes negative PnL with U+2212 minus, not hyphen", async () => {
    seedPositions([
      makePosition({
        positionId: "pos-loss",
        phase: "S1",
        status: "closed",
        currentValueUsdc: 0,
        costBasisUsdc: 2.0,
        realizedPnl: -1.23,
      }),
    ]);
    renderWithProviders(<Positions />);

    const MINUS = "\u2212";
    expect(await screen.findByText(`${MINUS}$1.23`)).toBeInTheDocument();
  });

  it("renders unrealized P&L and lifetime Full P&L as separate columns", async () => {
    seedPositions([
      makePosition({
        positionId: "pos-open-pnl",
        currentValueUsdc: 10,
        costBasisUsdc: 5,
        realizedPnl: 2,
        cumulativeBuyNotional: 14,
      }),
    ]);
    renderWithProviders(<Positions />);

    expect(await screen.findByRole("columnheader", { name: "P&L" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Full P&L" })).toBeInTheDocument();

    const row = screen.getByTestId("position-row-pos-open-pnl");
    expect(within(row).getByText("+$5.00")).toBeInTheDocument();
    expect(within(row).getByText("+100.0%")).toBeInTheDocument();
    expect(within(row).getByText("+$7.00")).toBeInTheDocument();
    expect(within(row).getByText("+50.0%")).toBeInTheDocument();
  });

  it("renders closed positions with zero unrealized and realized-only Full P&L", async () => {
    seedPositions([
      makePosition({
        positionId: "pos-closed-pnl",
        status: "closed",
        currentValueUsdc: 0,
        costBasisUsdc: 5,
        realizedPnl: 3,
      }),
    ]);
    renderWithProviders(<Positions />);

    const row = await screen.findByTestId("position-row-pos-closed-pnl");
    expect(within(row).getAllByText("$0.00").length).toBeGreaterThanOrEqual(1);
    expect(within(row).getByText("+$3.00")).toBeInTheDocument();
  });

  it("renders dust P&L percent on residual basis and Full P&L percent on lifetime basis", async () => {
    seedPositions([
      makePosition({
        positionId: "pos-zagreb-like",
        status: "dust",
        currentValueUsdc: null,
        costBasisUsdc: 0.0005,
        realizedPnl: 1.39,
        cumulativeBuyNotional: 8.41,
      }),
    ]);
    renderWithProviders(<Positions />);

    const row = await screen.findByTestId("position-row-pos-zagreb-like");
    const MINUS = "\u2212";
    expect(within(row).getByText(`${MINUS}$0.00`)).toBeInTheDocument();
    expect(within(row).getByText(`${MINUS}100.0%`)).toBeInTheDocument();
    expect(within(row).getByText("+$1.39")).toBeInTheDocument();
    expect(within(row).getByText("+16.5%")).toBeInTheDocument();
  });

  it("falls back to current cost basis for Full P&L percent when lifetime basis is absent", async () => {
    seedPositions([
      makePosition({
        positionId: "pos-no-lifetime-basis",
        currentValueUsdc: null,
        costBasisUsdc: 2,
        realizedPnl: 1,
        cumulativeBuyNotional: null,
      }),
    ]);
    renderWithProviders(<Positions />);

    const row = await screen.findByTestId("position-row-pos-no-lifetime-basis");
    const MINUS = "\u2212";
    expect(within(row).getByText(`${MINUS}$1.00`)).toBeInTheDocument();
    expect(within(row).getByText(`${MINUS}50.0%`)).toBeInTheDocument();
  });

  it("falls back to defaults on malformed localStorage", async () => {
    window.localStorage.setItem(TWEAKS_STORAGE_KEY, "not-json{");
    seedPositions();
    renderWithProviders(<Positions />);

    const closedToggle = await screen.findByLabelText<HTMLInputElement>(/Hide closed/);
    expect(closedToggle.checked).toBe(DEFAULT_TWEAKS.hideClosedByDefault);
  });

  it("restores persisted tweaks on mount", async () => {
    window.localStorage.setItem(
      TWEAKS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_TWEAKS, hideDust: true, groupBy: "phase" }),
    );
    seedPositions();
    renderWithProviders(<Positions />);

    const dustToggle = await screen.findByLabelText<HTMLInputElement>(/Hide dust/);
    expect(dustToggle.checked).toBe(true);
    const groupBy = screen.getByLabelText<HTMLSelectElement>(/Group by/i);
    expect(groupBy.value).toBe("phase");
  });

  it("keeps Pagination visible below the table", async () => {
    seedPositions();
    renderWithProviders(<Positions />);
    await screen.findByText("Will BTC be above $100k?");
    expect(screen.getByText(/1\u20135 of 5/)).toBeInTheDocument();
  });
});

describe("PositionsPage — phase rail + outcome chip data-state", () => {
  it.each<[PositionPhase, string]>([
    ["S0", "pos-s0-closed"],
    ["S1", "pos-s1-btc"],
    ["S2", "pos-s2-eth"],
    ["S3", "pos-s3-doge"],
  ])("row for %s has data-state attribute", async (phase, id) => {
    seedPositions();
    renderWithProviders(<Positions />);
    const row = await screen.findByTestId(`position-row-${id}`);
    expect(row.getAttribute("data-state")).toBe(phase);
  });
});

describe("PositionsPage — filters operate on full dataset, not current page", () => {
  function manyPositions(n: number): PositionDTO[] {
    return Array.from({ length: n }, (_, i) =>
      makePosition({
        positionId: `bulk-${i}`,
        tokenId: `tok-${i}`,
        // Interleave phases/questions so the needle is deep in the set.
        phase: i === n - 1 ? "S2" : "S1",
        question: i === n - 1 ? "Needle ETH flip question" : `Bulk row ${i}`,
        buyCount: i === n - 1 ? 3 : 1,
        lastAction: "BUY",
        lastActionAt: new Date(2026, 3, 24, 8, 0, 0, i).toISOString(),
      }),
    );
  }

  it("phase filter sees positions that would have been off-page", async () => {
    const rows = manyPositions(75);
    server.use(
      http.get("/api/v1/positions", () =>
        ok({ items: rows, nextCursor: null, totalCount: rows.length }),
      ),
      http.get("/api/v1/fills", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
    );
    renderWithProviders(<Positions />);

    // First page of 50 does not include the needle (bulk-74, phase S2).
    await screen.findByText("Bulk row 0");
    expect(screen.queryByText("Needle ETH flip question")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Accum\./i }));

    // Filter was applied over the full 75 rows, not just page 1.
    expect(await screen.findByText("Needle ETH flip question")).toBeInTheDocument();
    expect(screen.queryByText("Bulk row 0")).not.toBeInTheDocument();
  });

  it("search sees positions that would have been off-page", async () => {
    const rows = manyPositions(75);
    server.use(
      http.get("/api/v1/positions", () =>
        ok({ items: rows, nextCursor: null, totalCount: rows.length }),
      ),
      http.get("/api/v1/fills", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
    );
    renderWithProviders(<Positions />);
    await screen.findByText("Bulk row 0");

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/search positions/i), "needle");
    expect(await screen.findByText("Needle ETH flip question")).toBeInTheDocument();
    expect(screen.queryByText("Bulk row 0")).not.toBeInTheDocument();
  });

  it("phase-chip counts reflect the full dataset", async () => {
    const rows = manyPositions(75);
    server.use(
      http.get("/api/v1/positions", () =>
        ok({ items: rows, nextCursor: null, totalCount: rows.length }),
      ),
      http.get("/api/v1/fills", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
    );
    renderWithProviders(<Positions />);
    await screen.findByText("Bulk row 0");

    const allTab = screen.getByRole("tab", { name: /^All/i });
    expect(within(allTab).getByText("75")).toBeInTheDocument();

    const accumTab = screen.getByRole("tab", { name: /Accum\./i });
    expect(within(accumTab).getByText("1")).toBeInTheDocument();

    const firstTab = screen.getByRole("tab", { name: /First/i });
    expect(within(firstTab).getByText("74")).toBeInTheDocument();
  });

  it("pagination operates over the filtered set", async () => {
    const rows = manyPositions(120);
    server.use(
      http.get("/api/v1/positions", () =>
        ok({ items: rows, nextCursor: null, totalCount: rows.length }),
      ),
      http.get("/api/v1/fills", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
    );
    renderWithProviders(<Positions />);
    await screen.findByText("Bulk row 0");
    expect(screen.getByText(/1\u2013 ?50 of 120/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: /Accum\./i }));

    // Only 1 row matches — pagination collapses to 1/1.
    expect(await screen.findByText(/1\u20131 of 1/)).toBeInTheDocument();
    expect(screen.getByText("Needle ETH flip question")).toBeInTheDocument();
  });
});

describe("PositionsPage — cursor aggregation across pages", () => {
  it("walks nextCursor until null and merges all batches into the table", async () => {
    const batch1 = Array.from({ length: 3 }, (_, i) =>
      makePosition({
        positionId: `page1-${i}`,
        tokenId: `tok-p1-${i}`,
        question: `Page1 row ${i}`,
      }),
    );
    const batch2 = [
      makePosition({
        positionId: "page2-needle",
        tokenId: "tok-p2-needle",
        question: "Second-page needle",
      }),
    ];

    const batches = [
      { items: batch1, nextCursor: "cursor-abc" },
      { items: batch2, nextCursor: null as string | null },
    ];
    let callIndex = 0;
    server.use(
      http.get("/api/v1/positions", () => {
        const b = batches[Math.min(callIndex, batches.length - 1)]!;
        callIndex += 1;
        return ok({ items: b.items, nextCursor: b.nextCursor, totalCount: 4 });
      }),
      http.get("/api/v1/fills", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
    );

    renderWithProviders(<Positions />);

    expect(await screen.findByText("Page1 row 0")).toBeInTheDocument();
    expect(await screen.findByText("Second-page needle")).toBeInTheDocument();
    await waitFor(() => {
      expect(callIndex).toBeGreaterThanOrEqual(2);
    });
    expect(screen.queryByTestId("positions-truncated-notice")).not.toBeInTheDocument();
  });

  it("stops at the safety cap and surfaces a truncation notice", async () => {
    // Server never returns nextCursor=null, so the hook is forced to cap out.
    server.use(
      http.get("/api/v1/positions", ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor") ?? "seed";
        return ok({
          items: [
            makePosition({
              positionId: `bulk-${cursor}`,
              tokenId: `tok-${cursor}`,
              question: `Bulk ${cursor}`,
            }),
          ],
          nextCursor: `${cursor}-next`,
          totalCount: 99_999,
        });
      }),
      http.get("/api/v1/fills", () => ok({ items: [], nextCursor: null, totalCount: 0 })),
    );

    renderWithProviders(<Positions />);

    expect(await screen.findByTestId("positions-truncated-notice")).toBeInTheDocument();
  });
});

describe("PositionDrawer — fills are fetched server-side by tokenId", () => {
  it("passes tokenId to /fills and shows the returned rows", async () => {
    let capturedTokenId: string | null = null;
    server.use(
      http.get("/api/v1/positions", () =>
        ok({ items: FIXTURES, nextCursor: null, totalCount: FIXTURES.length }),
      ),
      http.get("/api/v1/fills", ({ request }) => {
        capturedTokenId = new URL(request.url).searchParams.get("tokenId");
        return ok({
          items: [
            {
              fillId: "fill-eth-1",
              orderId: "ord-eth-1",
              tokenId: "tok-eth",
              side: "buy",
              price: 0.42,
              size: 5,
              sizeUsdc: 2.1,
              liquidityRole: "maker",
              explicitFeeUsdc: 0,
              fee: 0,
              filledAt: "2026-04-24T09:00:00Z",
              slug: "eth-flip",
              eventSlug: "eth-event",
              question: "Will ETH flip SOL?",
              outcome: "No",
              conditionId: "cond-eth",
              endDate: "2026-05-20T00:00:00Z",
            },
          ],
          nextCursor: null,
          totalCount: 1,
        });
      }),
    );

    renderWithProviders(<Positions />);
    await screen.findByText("Will ETH flip SOL?");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("position-row-pos-s2-eth"));

    const drawer = await screen.findByTestId("position-drawer");
    await within(drawer).findByText(/@ \$0.4200/);
    expect(capturedTokenId).toBe("tok-eth");
  });
});
