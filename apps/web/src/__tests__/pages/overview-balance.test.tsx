import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../test/server.ts";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { Overview } from "../../pages/Overview.tsx";
import { mockStatus } from "../../test/handlers.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

describe("Overview Balance Card", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows virtual balance for paper mode", async () => {
    renderWithProviders(<Overview />);

    const card = await screen.findByTestId("overview-balance-card");
    expect(within(card).getByText("Portfolio")).toBeInTheDocument();
    expect(within(card).getByText("Available to trade")).toBeInTheDocument();
    // mockStatus: balanceUsdc = 69.70, totalCurrentValueUsdc = 15.87, initialBalanceUsdc = 100
    expect(within(card).getByText("$85.57")).toBeInTheDocument();
    expect(within(card).getByText("$69.70")).toBeInTheDocument();
    expect(within(card).getByText(/\$100\.00/)).toBeInTheDocument();
  });

  it("shows if-close-all value as the main portfolio number", async () => {
    renderWithProviders(<Overview />);

    const card = await screen.findByTestId("overview-balance-card");
    expect(within(card).getByText("$85.57")).toBeInTheDocument();
    expect(within(card).queryByText(/if close all/i)).not.toBeInTheDocument();
  });

  it("shows position value / initial for paper mode", async () => {
    renderWithProviders(<Overview />);

    const card = await screen.findByTestId("overview-balance-card");
    expect(
      within(card).getByText(/\$32\.06 position value \/ \$100\.00 initial/i),
    ).toBeInTheDocument();
  });

  it("shows Polymarket wallet portfolio for live-lite mode with green accent", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          walletBalanceUsdc: 487,
          polymarketPortfolio: {
            portfolioUsdc: 549.51,
            availableUsdc: 487,
            positionValueUsdc: 62.51,
            positionCount: 23,
            costBasisUsdc: 50.04,
            source: "polymarket",
            capturedAt: "2026-04-24T13:25:55.000Z",
          },
          liveLite: {
            maxOpenValueUsdc: 100,
            maxActiveMarkets: 10,
            maxOrderUsdc: 10,
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const card = await screen.findByTestId("overview-balance-card");
    expect(within(card).getByText("Portfolio")).toBeInTheDocument();
    expect(within(card).getByText("Available to trade")).toBeInTheDocument();
    expect(within(card).getByText("$549.51")).toBeInTheDocument();
    expect(within(card).getByText("$487.00")).toBeInTheDocument();
    expect(within(card).getByText(/\$62\.51 position value \/ \$100\.00 cap/i)).toBeInTheDocument();
  });

  it("replaces the live-lite envelope with compact risk capacity", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          walletBalanceUsdc: 487,
          polymarketPortfolio: {
            portfolioUsdc: 549.51,
            availableUsdc: 487,
            positionValueUsdc: 62.51,
            positionCount: 23,
            costBasisUsdc: 50.04,
            source: "polymarket",
            capturedAt: "2026-04-24T13:25:55.000Z",
          },
          openOrderBreakdown: {
            total: 42,
            buy: { open: 3, cap: 25 },
            sell: { open: 39, cap: 200 },
            profileLadderSell: { open: 39 },
          },
          liveLite: {
            maxOpenValueUsdc: 500,
            maxOrderUsdc: 25,
            maxActiveMarkets: 250,
            activeMarketCount: 101,
            activeMarketCapUtilizationPct: 40.4,
            walletMode: "relayer",
            minOrderUsdc: 0.05,
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const card = await screen.findByTestId("risk-capacity-card");
    expect(within(card).getByText("Risk Capacity")).toBeInTheDocument();
    expect(within(card).getByText("101/250")).toBeInTheDocument();
    expect(within(card).getByText("40%")).toBeInTheDocument();
    expect(within(card).getByText("$549.51")).toBeInTheDocument();
    expect(within(card).getByText("3/25")).toBeInTheDocument();
    expect(within(card).getByText("39/200")).toBeInTheDocument();
    expect(screen.queryByText(/Live-Lite Envelope/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Wallet: RELAYER/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Min order/i)).not.toBeInTheDocument();
  });

  it("uses runtime health instead of a redundant runtime-mode card", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          paused: false,
          tradingState: "EXITS_ONLY",
          liveLite: {
            maxOpenValueUsdc: 500,
            maxOrderUsdc: 25,
            maxActiveMarkets: 250,
            activeMarketCount: 101,
            activeMarketCapUtilizationPct: 40.4,
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByText("Runtime Health")).toBeInTheDocument();
    expect(screen.getByText("RUNNING")).toBeInTheDocument();
    expect(screen.getAllByText("EXITS ONLY").length).toBeGreaterThan(0);
    expect(screen.queryByText("Runtime Mode")).not.toBeInTheDocument();
  });

  it("falls back to local if-close-all when Polymarket portfolio is unavailable", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          walletBalanceUsdc: 487,
          polymarketPortfolio: null,
          liveLite: {
            maxOpenValueUsdc: 100,
            maxActiveMarkets: 10,
            maxOrderUsdc: 10,
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const card = await screen.findByTestId("overview-balance-card");
    expect(within(card).getByText("$502.87")).toBeInTheDocument();
    expect(within(card).getByText("$487.00")).toBeInTheDocument();
    expect(within(card).getByText(/\$32\.06 position value \/ \$100\.00 cap/i)).toBeInTheDocument();
  });

  it("shows dash when balance is null", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          balanceUsdc: null,
          initialBalanceUsdc: null,
          walletBalanceUsdc: null,
        }),
      ),
    );

    renderWithProviders(<Overview />);
    const card = await screen.findByTestId("overview-balance-card");
    expect(within(card).getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("shows 24h execution quality telemetry", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          executionTelemetry24h: {
            windowHours: 24,
            totalFills: 6,
            volumeUsdc: 24,
            makerFills: 4,
            takerFills: 2,
            unknownFills: 0,
            makerRatio: 4 / 6,
            takerRatio: 2 / 6,
            explicitFeesUsdc: 0.48,
            feeLeakageRatio: 0.02,
            lastFillAt: new Date().toISOString(),
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByText("Execution Quality")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
    expect(screen.getByText(/4 maker.*2 taker.*0 unknown/)).toBeInTheDocument();
    expect(screen.getByText(/\$0\.480 fees.*2\.00% leakage/)).toBeInTheDocument();
  });

  it("shows KPI cards instead of debug coverage widgets on Overview", async () => {
    renderWithProviders(<Overview />);

    expect(await screen.findByTestId("kpi-winrate-card")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-exit-multiple-card")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-fills-card")).toBeInTheDocument();
    expect(screen.getByTestId("kpi-health-card")).toBeInTheDocument();
    expect(screen.queryByText("Market Coverage")).not.toBeInTheDocument();
    expect(screen.queryByText("R23 Dip Trigger")).not.toBeInTheDocument();
  });

  it("links debug metrics from the Health KPI card", async () => {
    renderWithProviders(<Overview />);

    const healthCard = await screen.findByTestId("kpi-health-card");
    expect(within(healthCard).getByText("/debug →")).toBeInTheDocument();
  });

  it("shows execution telemetry note in execution quality card when no fills", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          executionTelemetry24h: {
            ...mockStatus.executionTelemetry24h,
            totalFills: 0,
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByText("Execution Quality")).toBeInTheDocument();
    expect(screen.getByText("No fills in 24h")).toBeInTheDocument();
  });

  it("shows active market count in the selection-rules card", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          openConditionCount: 42,
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const card = (await screen.findByText("Active Markets")).closest(".card");
    if (!(card instanceof HTMLElement)) {
      throw new Error("expected Active Markets card");
    }
    expect(within(card).getByText("42")).toBeInTheDocument();
    expect(within(card).getByText("View selection rules")).toBeInTheDocument();
  });

  it("shows compact trading activity instead of the raw capacity chain", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          tradingState: "EXITS_ONLY",
          signalActivity: {
            signalsProducedLast10m: 47,
            signalsApprovedLast10m: 47,
            signalsRejectedLast10m: 0,
            entrySignalsApprovedLast10m: 0,
            exitSignalsApprovedLast10m: 47,
            lastEntryApprovedAt: "2026-04-05T11:00:00Z",
            lastSignalRejectedAt: null,
            approvalRate: 100,
          },
          executionQueue: {
            activeCount: 0,
            queueDepth: 0,
            reservedBuyUsdc: 12.34,
            freeUsdcForNewOrders: 56.78,
            buyCapacity: {
              enabled: true,
              minNewEntryWalletHeadroomUsdc: 7,
              minAddWalletHeadroomUsdc: 5,
              minViableEntryUsdc: 1,
              maxOpenBuyOrders: 25,
              maxOpenBuyOrdersPerToken: 2,
              openBuyOrderCount: 1,
              newEntryCapacityUsdc: 10,
              addCapacityUsdc: 11,
              entriesBlocked: false,
              addsBlocked: false,
            },
            sellCapacity: {
              enabled: true,
              maxOpenSellOrders: 200,
              maxOpenSellOrdersPerToken: 2,
              openSellOrderCount: 39,
              blocked: false,
            },
            orderCapacity: {
              enabled: true,
              maxOpenOrdersTotal: 200,
              openOrdersTotal: 40,
              blocked: false,
            },
          },
          openOrderBreakdown: {
            total: 40,
            buy: { open: 1, cap: 25 },
            sell: { open: 39, cap: 200 },
            profileLadderSell: { open: 39 },
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    expect((await screen.findAllByText("EXITS ONLY")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Signals 47 produced \/ 0 rejected/)).toBeInTheDocument();
    expect(screen.getByText(/Orders 0 active \/ 0 queued/)).toBeInTheDocument();
    // capacity present + unblocked (entriesBlocked=false, freeUsdc>0) → the non-money "upstream" message
    expect(screen.getByText(/signals are not being approved/i)).toBeInTheDocument();
    expect(screen.queryByText(/reserved buy/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/per token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/entry reserve/i)).not.toBeInTheDocument();
  });

  it("shows last order placed by createdAt, not last status update", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-04-05T12:00:00Z").getTime());

    server.use(
      http.get("/api/v1/orders", () =>
        ok({
          items: [
            {
              orderId: "ord-1",
              clientOrderId: "client-1",
              tokenId: "tok-1",
              side: "buy",
              orderType: "limit",
              postOnly: true,
              price: 0.1,
              size: 10,
              sizeUsdc: 1,
              status: "filled",
              exchangeOrderId: "exch-1",
              createdAt: "2026-04-05T11:00:00Z",
              updatedAt: "2026-04-05T11:59:00Z",
              slug: "market-1",
              eventSlug: "event-1",
              question: "Question",
              outcome: "YES",
              conditionId: "cond-1",
              endDate: null,
            },
          ],
          nextCursor: null,
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const row = (await screen.findByText("Last order placed")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("1h ago")).toBeInTheDocument();
    expect(within(row!).queryByText("1m ago")).not.toBeInTheDocument();
  });

  it("shows open order capacity breakdown instead of per-minute throughput", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          openOrderCount: 51,
          openOrderBreakdown: {
            total: 51,
            buy: { open: 15, cap: 25 },
            sell: { open: 36, cap: 168 },
            profileLadderSell: { open: 28 },
          },
          openPositionCount: 99,
          ordersPlacedLastMin: 7,
          positionsOpenedLastMin: 3,
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const positionsCard = (await screen.findByText("Open Positions")).closest(".card");
    const ordersCard = screen.getByText("Open Orders").closest(".card");

    expect(positionsCard).toBeInstanceOf(HTMLElement);
    expect(ordersCard).toBeInstanceOf(HTMLElement);

    expect(positionsCard).toHaveTextContent("99");
    expect(ordersCard).toHaveTextContent("51");
    expect(ordersCard).toHaveTextContent("B 15/25");
    expect(ordersCard).toHaveTextContent("S 36/168");
    expect(ordersCard).toHaveTextContent("PL 28");
    expect(positionsCard).toHaveTextContent(
      /0 dust|1 dust|2 dust|3 dust|4 dust|5 dust|6 dust|7 dust|8 dust|9 dust/,
    );
    expect(positionsCard).toHaveTextContent("3 in last min");
    expect(ordersCard).not.toHaveTextContent("7 in last min");
    expect(screen.queryByText("Positions / Min")).not.toBeInTheDocument();
    expect(screen.queryByText("Orders / Min")).not.toBeInTheDocument();
  });

  it("keeps the Open Orders card stable when breakdown is missing", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          openOrderBreakdown: undefined,
          openOrderCount: 35,
          ordersPlacedLastMin: 0,
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const ordersCard = (await screen.findByText("Open Orders")).closest(".card");
    expect(ordersCard).toBeInstanceOf(HTMLElement);
    expect(ordersCard).toHaveTextContent("35");
    expect(ordersCard).toHaveTextContent("B ?/?");
    expect(ordersCard).toHaveTextContent("S ?/?");
    expect(ordersCard).toHaveTextContent("PL ?");
    expect(ordersCard).not.toHaveTextContent("0 in last min");
  });

  it("uses execution queue order capacity fallback consistently when breakdown is missing", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          walletBalanceUsdc: 487,
          openOrderBreakdown: undefined,
          openOrderCount: 16,
          tradingState: "EXITS_ONLY",
          signalActivity: {
            signalsProducedLast10m: 12,
            signalsApprovedLast10m: 10,
            signalsRejectedLast10m: 2,
            entrySignalsApprovedLast10m: 0,
            exitSignalsApprovedLast10m: 10,
            lastEntryApprovedAt: null,
            lastSignalRejectedAt: null,
            approvalRate: 83,
          },
          executionQueue: {
            activeCount: 1,
            queueDepth: 2,
            buyCapacity: {
              enabled: true,
              minNewEntryWalletHeadroomUsdc: 7,
              minAddWalletHeadroomUsdc: 5,
              maxOpenBuyOrders: 25,
              maxOpenBuyOrdersPerToken: 2,
              openBuyOrderCount: 4,
              newEntryCapacityUsdc: 10,
              addCapacityUsdc: 11,
              entriesBlocked: false,
              addsBlocked: false,
            },
            sellCapacity: {
              enabled: true,
              maxOpenSellOrders: 200,
              maxOpenSellOrdersPerToken: 2,
              openSellOrderCount: 12,
              blocked: false,
            },
            orderCapacity: {
              enabled: true,
              maxOpenOrdersTotal: 225,
              openOrdersTotal: 16,
              blocked: false,
            },
          },
          liveLite: {
            maxOpenValueUsdc: 500,
            maxOrderUsdc: 25,
            maxActiveMarkets: 250,
            activeMarketCount: 101,
            activeMarketCapUtilizationPct: 40.4,
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const ordersCard = (await screen.findByText("Open Orders")).closest(".card");
    expect(ordersCard).toBeInstanceOf(HTMLElement);
    expect(ordersCard).toHaveTextContent("16");
    expect(ordersCard).toHaveTextContent("B 4/25");
    expect(ordersCard).toHaveTextContent("S 12/200");

    const riskCapacity = screen.getByTestId("risk-capacity-card");
    expect(within(riskCapacity).getByText("4/25")).toBeInTheDocument();
    expect(within(riskCapacity).getByText("12/200")).toBeInTheDocument();
  });

  it("keeps Last Events focused on timestamped events only", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          ordersPlacedLastMin: 7,
          positionsOpenedLastMin: 3,
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const lastEventsLabel = await screen.findByText("Last Events");
    const lastEventsCard = lastEventsLabel.closest(".card");
    if (!(lastEventsCard instanceof HTMLElement)) {
      throw new Error("expected Last Events card");
    }

    const rowLabels = within(lastEventsCard)
      .getAllByRole("row")
      .map((row) => row.querySelector("td")?.textContent?.trim());

    expect(rowLabels).toEqual([
      "Last fill",
      "Last order placed",
      "Last reconciliation",
      "Last market data",
    ]);
    expect(within(lastEventsCard).queryByText("Orders in last min")).not.toBeInTheDocument();
    expect(within(lastEventsCard).queryByText("Positions in last min")).not.toBeInTheDocument();
  });
});
