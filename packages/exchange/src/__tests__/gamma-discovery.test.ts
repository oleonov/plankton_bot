import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GammaMarketDiscoveryGateway } from "../gamma/market-discovery-gateway.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeGammaMarket(id: string): Record<string, unknown> {
  return {
    conditionId: `cond-${id}`,
    clobTokenIds: [`tok-${id}-yes`, `tok-${id}-no`],
    outcomes: ["Yes", "No"],
    question: `Question ${id}?`,
    slug: `slug-${id}`,
    endDate: "2026-12-31",
    active: true,
    negRisk: false,
    orderPriceMinTickSize: 0.01,
  };
}

/** Wrap market objects in an event envelope, as the /events endpoint returns. */
function makeEvent(id: string, markets: Record<string, unknown>[]): Record<string, unknown> {
  return { id: `event-${id}`, slug: `event-slug-${id}`, markets };
}

function mockFetchResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Internal Server Error",
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("GammaMarketDiscoveryGateway", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("discoverMarkets() paginates events and extracts nested markets", async () => {
    const pageSize = 2;
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // Page 1: 2 events (full page) -> continue
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse([
        makeEvent("a", [makeGammaMarket("1"), makeGammaMarket("2")]),
        makeEvent("b", [makeGammaMarket("3")]),
      ]),
    );
    // Page 2: 1 event (partial) -> stop
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse([makeEvent("c", [makeGammaMarket("4")])]),
    );

    const markets = await gateway.discoverMarkets();

    expect(markets).toHaveLength(4);
    expect(markets[0]!.conditionId).toBe("cond-1");
    expect(markets[3]!.conditionId).toBe("cond-4");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("discoverMarkets() uses /events endpoint with closed=false", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      tagId: 42,
      pageSize: 100,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockFetchResponse([]));

    await gateway.discoverMarkets();

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe("/events");
    expect(calledUrl.searchParams.get("closed")).toBe("false");
    expect(calledUrl.searchParams.get("tag_id")).toBe("42");
    expect(calledUrl.searchParams.get("limit")).toBe("100");
    expect(calledUrl.searchParams.get("offset")).toBe("0");
  });

  it("discoverMarkets() maps nested markets via mapGammaMarket", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse([
        makeEvent("btc", [
          {
            conditionId: "cond-btc",
            clobTokenIds: ["tok-btc-yes"],
            outcomes: ["Yes"],
            question: "BTC above 100k?",
            slug: "bitcoin-above-100k",
            endDate: "2026-06-30",
            active: true,
            negRisk: true,
            orderPriceMinTickSize: 0.001,
          },
        ]),
      ]),
    );

    const markets = await gateway.discoverMarkets();

    expect(markets).toHaveLength(1);
    const m = markets[0]!;
    expect(m.conditionId).toBe("cond-btc");
    expect(m.tokens).toEqual([{ tokenId: "tok-btc-yes", outcome: "Yes" }]);
    expect(m.slug).toBe("bitcoin-above-100k");
    expect(m.negRisk).toBe(true);
    expect(m.tickSize).toBe(0.001);
  });

  it("discoverMarkets() throws on HTTP error", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(null, false, 500),
    );

    await expect(gateway.discoverMarkets()).rejects.toThrow(
      "Gamma API responded with 500",
    );
  });

  it("healthCheck() returns ok:true when Gamma is reachable", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockFetchResponse([]));

    const result = await gateway.healthCheck();

    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("healthCheck() returns ok:false when Gamma is unreachable", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const result = await gateway.healthCheck();

    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("healthCheck() uses /events with limit=1", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 100,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockFetchResponse([]));

    await gateway.healthCheck();

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe("/events");
    expect(calledUrl.searchParams.get("limit")).toBe("1");
  });

  it("discoverMarkets() handles events with no nested markets", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse([
        makeEvent("empty", []),
        { id: "no-markets-field", slug: "bare-event" },
      ]),
    );

    const markets = await gateway.discoverMarkets();
    expect(markets).toHaveLength(0);
  });
});
