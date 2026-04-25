import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { server } from "../../test/server.ts";
import { Positions } from "../../pages/Positions.tsx";
import { TWEAKS_STORAGE_KEY, DEFAULT_TWEAKS } from "../../pages/positions/useTweaks.ts";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

beforeEach(() => {
  // Hide-closed defaults to true now; opt out so the closed-position
  // realised-PnL assertion still finds the row.
  window.localStorage.setItem(
    TWEAKS_STORAGE_KEY,
    JSON.stringify({ ...DEFAULT_TWEAKS, hideClosedByDefault: false }),
  );
});

describe("Positions page", () => {
  it("shows total pnl for open positions, not realized-only pnl", async () => {
    server.use(
      http.get("/api/v1/positions", () =>
        ok({
          items: [
            {
              positionId: "pos-1",
              tokenId: "tok-1",
              side: "buy",
              size: 10,
              avgEntryPrice: 1,
              costBasisUsdc: 10,
              currentValueUsdc: 12,
              realizedPnl: 1,
              status: "open",
              openedAt: "2026-04-05T00:00:00Z",
              closedAt: null,
              updatedAt: "2026-04-05T00:00:00Z",
              slug: "market-1",
              eventSlug: "event-1",
              question: "Will BTC do something?",
              outcome: "YES",
              conditionId: "cond-1",
              endDate: "2026-04-06T00:00:00Z",
              resolution: null,
              resolutionStatus: null,
              phase: "S1",
              buyCount: 1,
              sellCount: 0,
              lastAction: "BUY",
              lastActionAt: "2026-04-05T00:00:00Z",
            },
          ],
          nextCursor: null,
          totalCount: 1,
        }),
      ),
    );

    renderWithProviders(<Positions />);

    expect(await screen.findByText("+$3.00")).toBeInTheDocument();
  });

  it("shows realized pnl only for closed positions", async () => {
    server.use(
      http.get("/api/v1/positions", () =>
        ok({
          items: [
            {
              positionId: "pos-closed",
              tokenId: "tok-closed",
              side: "buy",
              size: 0,
              avgEntryPrice: 0.02,
              costBasisUsdc: 1.64,
              currentValueUsdc: 0,
              realizedPnl: 81.77,
              status: "closed",
              openedAt: "2026-04-05T00:00:00Z",
              closedAt: "2026-04-06T00:00:00Z",
              updatedAt: "2026-04-06T00:00:00Z",
              slug: "market-closed",
              eventSlug: "event-closed",
              question: "Bitcoin Up or Down?",
              outcome: "Up",
              conditionId: "cond-closed",
              endDate: "2026-04-06T00:00:00Z",
              resolution: "Down",
              resolutionStatus: "settled",
              phase: "S0",
              buyCount: 1,
              sellCount: 1,
              lastAction: "SELL",
              lastActionAt: "2026-04-06T00:00:00Z",
            },
          ],
          nextCursor: null,
          totalCount: 1,
        }),
      ),
    );

    renderWithProviders(<Positions />);

    expect(await screen.findByText("+$81.77")).toBeInTheDocument();
  });
});
