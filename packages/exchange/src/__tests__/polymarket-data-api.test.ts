import { describe, expect, it, vi } from "vitest";
import {
  aggregatePolymarketPositions,
  fetchPolymarketPositions,
  normalizePolymarketPosition,
} from "../polymarket-data-api.js";

describe("polymarket-data-api", () => {
  it("normalizes Data API position fields", () => {
    const position = normalizePolymarketPosition({
      asset: "tok-1",
      size: "67.3",
      currentValue: "5.08",
      initialValue: "1.82",
      conditionId: "cond-1",
      redeemable: true,
      slug: "market-slug",
      outcome: "Yes",
    });

    expect(position).toMatchObject({
      tokenId: "tok-1",
      size: 67.3,
      currentValueUsdc: 5.08,
      initialValueUsdc: 1.82,
      conditionId: "cond-1",
      redeemable: true,
      slug: "market-slug",
      outcome: "Yes",
    });
  });

  it("aggregates only positive-size wallet positions", () => {
    const aggregate = aggregatePolymarketPositions(
      [
        {
          tokenId: "tok-1",
          size: 10,
          currentValueUsdc: 2,
          initialValueUsdc: 1,
          conditionId: null,
          redeemable: false,
          slug: null,
          marketSlug: null,
          outcome: null,
          raw: {},
        },
        {
          tokenId: "tok-zero",
          size: 0,
          currentValueUsdc: 99,
          initialValueUsdc: 99,
          conditionId: null,
          redeemable: false,
          slug: null,
          marketSlug: null,
          outcome: null,
          raw: {},
        },
      ],
      "2026-04-25T00:00:00.000Z",
    );

    expect(aggregate).toEqual({
      positionValueUsdc: 2,
      positionCount: 1,
      costBasisUsdc: 1,
      capturedAt: "2026-04-25T00:00:00.000Z",
    });
  });

  it("fetches positions with sizeThreshold=0", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ asset: "tok-1", size: "1", currentValue: "0.5", initialValue: "0.4" }],
    } as Response);

    const positions = await fetchPolymarketPositions("0xf00df00df00df00df00df00df00df00df00df00d", {
      fetchImpl,
    });

    expect(positions).toHaveLength(1);
    const url = fetchImpl.mock.calls[0]![0] as URL;
    expect(url.hostname).toBe("data-api.polymarket.com");
    expect(url.searchParams.get("sizeThreshold")).toBe("0");
  });
});
