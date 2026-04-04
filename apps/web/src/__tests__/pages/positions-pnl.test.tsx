import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "../../test/test-utils.tsx";
import { server } from "../../test/server.ts";
import { Positions } from "../../pages/Positions.tsx";

function ok<T>(data: T) {
  return HttpResponse.json({ ok: true, data, error: null, ts: new Date().toISOString() });
}

describe("Positions page", () => {
  it("shows total pnl for open positions, not realized-only pnl", async () => {
    server.use(
      http.get("/api/v1/positions", () =>
        ok({
          items: [
            {
              positionId: "pos-1",
              tokenId: "tok-1",
              familyId: "fam-1",
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
});
