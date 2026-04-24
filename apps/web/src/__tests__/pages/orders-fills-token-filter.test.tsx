import { describe, it, expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
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

describe("OrdersFills — tokenId URL filter", () => {
  it("opens on the Fills tab and passes tokenId to /fills when URL has ?tab=fills&tokenId=...", async () => {
    let capturedTokenId: string | null = null;
    server.use(
      http.get("/api/v1/fills", ({ request }) => {
        capturedTokenId = new URL(request.url).searchParams.get("tokenId");
        return ok({
          items: [fill({ tokenId: "tok-a", question: "Market A" })],
          nextCursor: null,
          totalCount: 1,
        });
      }),
    );

    renderWithProviders(<OrdersFills />, {
      initialEntries: ["/orders?tab=fills&tokenId=tok-a"],
    });

    expect(await screen.findByText("Market A")).toBeInTheDocument();
    expect(capturedTokenId).toBe("tok-a");

    // Filter chip visible; clear removes it and re-requests without tokenId.
    const chip = screen.getByTestId("fills-token-filter");
    expect(chip).toBeInTheDocument();

    let reqAfterClear: string | null | undefined = "not-called";
    server.use(
      http.get("/api/v1/fills", ({ request }) => {
        reqAfterClear = new URL(request.url).searchParams.get("tokenId");
        return ok({ items: [], nextCursor: null, totalCount: 0 });
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByLabelText(/Clear token filter/));

    // Chip disappears once the tokenId param is cleared from the URL.
    await waitFor(() => {
      expect(screen.queryByTestId("fills-token-filter")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(reqAfterClear).toBeNull();
    });
  });

  it("does not pass tokenId when URL has no tokenId (backward compatible)", async () => {
    let capturedTokenId: string | null | undefined = undefined;
    server.use(
      http.get("/api/v1/fills", ({ request }) => {
        capturedTokenId = new URL(request.url).searchParams.get("tokenId");
        return ok({ items: [], nextCursor: null, totalCount: 0 });
      }),
    );

    renderWithProviders(<OrdersFills />, {
      initialEntries: ["/orders?tab=fills"],
    });

    // Wait for a fills-only column header to render.
    expect(await screen.findByText("Filled At")).toBeInTheDocument();
    expect(capturedTokenId).toBeNull();
  });
});
