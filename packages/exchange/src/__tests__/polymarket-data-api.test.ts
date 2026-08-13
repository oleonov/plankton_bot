import { describe, expect, it, vi } from "vitest";
import {
  aggregatePolymarketPositions,
  fetchPolymarketPositions,
  normalizePolymarketPosition,
} from "../polymarket-data-api.js";

describe("polymarket-data-api", () => {
  const positionRows = (count: number, start = 0) =>
    Array.from({ length: count }, (_, idx) => ({
      asset: `tok-${start + idx}`,
      size: "1",
      currentValue: "0.5",
      initialValue: "0.4",
    }));

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
    expect(url.searchParams.get("limit")).toBe("500");
    expect(url.searchParams.has("offset")).toBe(false);
  });

  it("fetches more than the Data API default 100 rows in one page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => positionRows(103),
    } as Response);

    const positions = await fetchPolymarketPositions("0xf00df00df00df00df00df00df00df00df00df00d", {
      fetchImpl,
    });

    expect(positions).toHaveLength(103);
    expect(positions?.at(-1)?.tokenId).toBe("tok-102");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("paginates until a short page and returns rows beyond the first page", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => positionRows(500),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => positionRows(3, 500),
      } as Response);

    const positions = await fetchPolymarketPositions("0xf00df00df00df00df00df00df00df00df00df00d", {
      fetchImpl,
    });

    expect(positions).toHaveLength(503);
    const secondUrl = fetchImpl.mock.calls[1]![0] as URL;
    expect(secondUrl.searchParams.get("limit")).toBe("500");
    expect(secondUrl.searchParams.get("offset")).toBe("500");
    expect(positions?.at(-1)?.tokenId).toBe("tok-502");
  });

  it("T27 rejects invalid production rows instead of returning a partial wallet snapshot", async () => {
    const validRow = { asset: "tok-valid", size: "1", currentValue: "0.5", initialValue: "0.4" };
    const invalidCases: Array<{ name: string; row: unknown }> = [
      ...["size", "currentValue", "initialValue"].flatMap((field) => [
        { name: `${field} missing`, row: { ...validRow, [field]: undefined } },
        { name: `${field} NaN`, row: { ...validRow, [field]: Number.NaN } },
        { name: `${field} positive infinity`, row: { ...validRow, [field]: Infinity } },
        { name: `${field} negative infinity`, row: { ...validRow, [field]: -Infinity } },
        { name: `${field} negative`, row: { ...validRow, [field]: -1 } },
        { name: `${field} blank`, row: { ...validRow, [field]: "   " } },
        { name: `${field} boolean`, row: { ...validRow, [field]: true } },
      ]),
      { name: "non-object row", row: null },
      { name: "missing token id", row: { size: "1", currentValue: "0.5", initialValue: "0.4" } },
    ];

    for (const { name, row } of invalidCases) {
      expect(normalizePolymarketPosition(row), name).toBeNull();
      const fetchImpl = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => [validRow, row] } as Response);

      await expect(
        fetchPolymarketPositions("0xf00df00df00df00df00df00df00df00df00df00d", { fetchImpl }),
        name,
      ).resolves.toBeNull();
      expect(fetchImpl, name).toHaveBeenCalledOnce();
    }

    expect(
      normalizePolymarketPosition({
        asset: "tok-zero",
        size: "0",
        currentValue: 0,
        initialValue: "0.4",
      }),
    ).toMatchObject({ tokenId: "tok-zero", size: 0, currentValueUsdc: 0, initialValueUsdc: 0.4 });
  });

  it("fails closed on a malformed row in a full page", async () => {
    const malformedFullPage = [...positionRows(499), { size: "1", currentValue: "0.5" }];
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => malformedFullPage,
    } as Response);

    const positions = await fetchPolymarketPositions("0xf00df00df00df00df00df00df00df00df00df00d", {
      fetchImpl,
    });

    expect(positions).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns null instead of a partial authoritative snapshot when a later page fails", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => positionRows(500),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        body: { cancel },
      } as unknown as Response);

    const positions = await fetchPolymarketPositions("0xf00df00df00df00df00df00df00df00df00df00d", {
      fetchImpl,
    });

    expect(positions).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
