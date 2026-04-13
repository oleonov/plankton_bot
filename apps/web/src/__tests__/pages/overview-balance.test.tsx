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

    // mockStatus: balanceUsdc = 69.70, initialBalanceUsdc = 100
    expect(await screen.findByText("$69.70")).toBeInTheDocument();
    expect(screen.getByText(/\$100\.00/)).toBeInTheDocument();
  });

  it("shows if-close-all value", async () => {
    renderWithProviders(<Overview />);

    expect(await screen.findByText(/\$85\.57 if close all/i)).toBeInTheDocument();
  });

  it("shows invested / initial for paper mode", async () => {
    renderWithProviders(<Overview />);

    expect(
      await screen.findByText(/\$32\.06 cost basis \/ \$100\.00 initial/i),
    ).toBeInTheDocument();
  });

  it("shows wallet balance for live-lite mode with green accent", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          walletBalanceUsdc: 487,
          liveLite: {
            maxOpenValueUsdc: 100,
            maxFamilies: 5,
            maxActiveMarkets: 10,
            maxOrderUsdc: 10,
            familyAllowlist: [],
          },
        }),
      ),
    );

    renderWithProviders(<Overview />);

    // Wallet balance shown
    expect(await screen.findByText("$487.00")).toBeInTheDocument();
    expect(screen.getByText(/\$32\.06 cost basis \/ \$100\.00 cap/i)).toBeInTheDocument();
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
    expect((await screen.findAllByText("—")).length).toBeGreaterThanOrEqual(1);
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

  it("shows canary watch summary for families with taker leakage", async () => {
    server.use(
      http.get("/api/v1/metrics/families", () =>
        ok([
          {
            familyId: "fam-1",
            familyKey: "bitcoin-above",
            feeTier: "fee-enabled",
            requiresPostOnlyForLive: true,
            runtimeMode: "active",
            openValueUsdc: 12,
            openPositionCount: 2,
            tailAdjustedPnlLive: 1.5,
            quarantineReason: null,
            effectiveMode: "active",
            derivedModeReason: null,
            executionTelemetry24h: {
              windowHours: 24,
              totalFills: 4,
              volumeUsdc: 18,
              makerFills: 2,
              takerFills: 2,
              unknownFills: 0,
              makerRatio: 0.5,
              takerRatio: 0.5,
              explicitFeesUsdc: 0.12,
              feeLeakageRatio: 0.0066666667,
              lastFillAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          },
        ]),
      ),
    );

    renderWithProviders(<Overview />);

    expect(await screen.findByText(/Watch: bitcoin-above/i)).toBeInTheDocument();
    expect(screen.getByText(/2 taker.*\$0\.120 fees/)).toBeInTheDocument();
  });

  it("uses enabled family mode breakdown for live-lite overview summary", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          runtimeMode: "live-lite",
          activeFamilyCount: 422,
          liveLite: {
            maxOpenValueUsdc: 500,
            maxFamilies: 100,
            maxActiveMarkets: 10,
            maxOrderUsdc: 25,
            familyAllowlist: Array.from({ length: 12 }, (_, index) => `fam-${index}`),
          },
          familyModeCounts: {
            active: 9,
            "probe-only": 1,
            "reduce-only": 2,
            _disabled: 435,
          },
        }),
      ),
      http.get("/api/v1/metrics/families", () => ok([])),
    );

    renderWithProviders(<Overview />);

    const card = (await screen.findByText("Enabled Families")).closest(".card");
    if (!(card instanceof HTMLElement)) {
      throw new Error("expected Enabled Families card");
    }
    const familyCard: HTMLElement = card;
    expect(within(familyCard).getByText("12")).toBeInTheDocument();
    expect(within(familyCard).getByText(/1 probe-only/)).toBeInTheDocument();
    expect(within(familyCard).queryByText("422")).not.toBeInTheDocument();
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
              familyId: "fam-1",
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

  it("uses per-minute throughput as the primary value for position and order cards", async () => {
    server.use(
      http.get("/api/v1/status", () =>
        ok({
          ...mockStatus,
          openOrderCount: 88,
          openPositionCount: 99,
          ordersPlacedLastMin: 7,
          positionsOpenedLastMin: 3,
        }),
      ),
    );

    renderWithProviders(<Overview />);

    const positionsCard = (await screen.findByText("Positions / Min")).closest(".card");
    const ordersCard = screen.getByText("Orders / Min").closest(".card");

    expect(positionsCard).toBeInstanceOf(HTMLElement);
    expect(ordersCard).toBeInstanceOf(HTMLElement);

    expect(positionsCard).toHaveTextContent("3");
    expect(ordersCard).toHaveTextContent("7");
    expect(positionsCard).toHaveTextContent(/0 dust|1 dust|2 dust|3 dust|4 dust|5 dust|6 dust|7 dust|8 dust|9 dust/);
    expect(positionsCard).not.toHaveTextContent("99");
    expect(ordersCard).not.toHaveTextContent("88");
    expect(screen.queryByText("3 in last min")).not.toBeInTheDocument();
    expect(screen.queryByText("7 in last min")).not.toBeInTheDocument();
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
