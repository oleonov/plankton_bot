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

function makeEventsPage(
  events: Record<string, unknown>[],
  nextCursor?: string,
): Record<string, unknown> {
  return nextCursor ? { events, next_cursor: nextCursor } : { events };
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
    // Page 1 has a next cursor -> continue.
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(
        makeEventsPage(
          [
            makeEvent("a", [makeGammaMarket("1"), makeGammaMarket("2")]),
            makeEvent("b", [makeGammaMarket("3")]),
          ],
          "cursor-page-2",
        ),
      ),
    );
    // Page 2 has no next cursor -> stop.
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(makeEventsPage([makeEvent("c", [makeGammaMarket("4")])])),
    );

    const markets = await gateway.discoverMarkets();

    expect(markets).toHaveLength(4);
    expect(markets[0]!.conditionId).toBe("cond-1");
    expect(markets[3]!.conditionId).toBe("cond-4");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(secondUrl.searchParams.get("after_cursor")).toBe("cursor-page-2");
  });

  it("discoverMarkets() uses /events/keyset endpoint with active=true&closed=false", async () => {
    // ADR-019 §D4 / Step 2 audit P2: scanner-query MUST match the ADR-003
    // baseline filter `active=true&closed=false` so per-event funnel counters
    // (eventsSingleMarketTotal / scannedEventsTotal) are apples-to-apples
    // with the published 39.17 % single-market ratio.
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      tagId: 42,
      pageSize: 100,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockFetchResponse(makeEventsPage([])));

    await gateway.discoverMarkets();

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe("/events/keyset");
    expect(calledUrl.searchParams.get("active")).toBe("true");
    expect(calledUrl.searchParams.get("closed")).toBe("false");
    expect(calledUrl.searchParams.get("tag_id")).toBe("42");
    expect(calledUrl.searchParams.get("limit")).toBe("100");
    expect(calledUrl.searchParams.has("offset")).toBe(false);
    expect(calledUrl.searchParams.has("after_cursor")).toBe(false);
  });

  it("forEachMarketPage() emits per-page eventStats with single/multi-market split", async () => {
    // ADR-019 §D4 / Step 2 audit P2: gateway counts events at the page
    // boundary (where event identity is still intact) so the scanner can
    // accumulate `events`, `singleMarket` and `multiMarket` totals without
    // re-grouping flattened markets by eventSlug downstream.
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(
        makeEventsPage([
          makeEvent("solo-1", [makeGammaMarket("s1")]),
          makeEvent("solo-2", [makeGammaMarket("s2")]),
          makeEvent("multi-a", [makeGammaMarket("ma-1"), makeGammaMarket("ma-2")]),
          makeEvent("multi-b", [
            makeGammaMarket("mb-1"),
            makeGammaMarket("mb-2"),
            makeGammaMarket("mb-3"),
          ]),
        ]),
      ),
    );

    const captured: Array<{ events: number; singleMarket: number; multiMarket: number }> = [];
    let totalMarkets = 0;
    await gateway.forEachMarketPage((pageMarkets, eventStats) => {
      captured.push({ ...eventStats });
      totalMarkets += pageMarkets.length;
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ events: 4, singleMarket: 2, multiMarket: 2 });
    expect(totalMarkets).toBe(7);
  });

  it("forEachMarketPage() omits the callback for empty pages but still terminates", async () => {
    // Empty-page guard: scanner must not be invoked when the gateway returns
    // no events, otherwise per-event counters would be incremented with
    // zero markets and skew the funnel.
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockFetchResponse(makeEventsPage([])));

    const cb = vi.fn();
    const result = await gateway.forEachMarketPage(cb);

    expect(cb).not.toHaveBeenCalled();
    expect(result).toEqual({ totalMarkets: 0 });
  });

  it("forEachMarketPage() excludes zero-market events from eventStats", async () => {
    // ADR-019 §D4: events with `markets: []` or no `markets` field are
    // malformed/settled envelopes that don't belong in the trading universe.
    // They must NOT count as multiMarket (which would skew ADR-003's 39.17 %
    // single-market ratio) and must preserve the partition invariant
    // `events == singleMarket + multiMarket`.
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(
        makeEventsPage([
          makeEvent("solo", [makeGammaMarket("s1")]),
          makeEvent("empty", []),
          { id: "no-markets-field", slug: "bare-event" },
          makeEvent("multi", [makeGammaMarket("m1"), makeGammaMarket("m2")]),
        ]),
      ),
    );

    const captured: Array<{ events: number; singleMarket: number; multiMarket: number }> = [];
    let totalMarkets = 0;
    await gateway.forEachMarketPage((pageMarkets, eventStats) => {
      captured.push({ ...eventStats });
      totalMarkets += pageMarkets.length;
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ events: 2, singleMarket: 1, multiMarket: 1 });
    expect(totalMarkets).toBe(3);
  });

  it("forEachMarketPage() omits the callback when every event is zero-market", async () => {
    // Zero-market events alone must not trigger a scanner callback — per the
    // empty-page guard, downstream counters would otherwise advance with no
    // observable work to report.
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(
        makeEventsPage([makeEvent("empty-1", []), { id: "no-markets-field", slug: "bare-event" }]),
      ),
    );

    const cb = vi.fn();
    const result = await gateway.forEachMarketPage(cb);

    expect(cb).not.toHaveBeenCalled();
    expect(result).toEqual({ totalMarkets: 0 });
  });

  it("discoverMarkets() maps nested markets via mapGammaMarket", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(
        makeEventsPage([
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
      ),
    );

    const markets = await gateway.discoverMarkets();

    expect(markets).toHaveLength(1);
    const m = markets[0]!;
    expect(m.conditionId).toBe("cond-btc");
    expect(m.tokens).toEqual([{ tokenId: "tok-btc-yes", outcome: "Yes", outcomeIndex: 0 }]);
    expect(m.slug).toBe("bitcoin-above-100k");
    expect(m.negRisk).toBe(true);
    expect(m.tickSize).toBe(0.001);
  });

  it("discoverMarkets() retries transient Gamma 5xx before succeeding", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
      maxRetries: 3,
      retryDelayMs: 0,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse(null, false, 500))
      .mockResolvedValueOnce(
        mockFetchResponse(makeEventsPage([makeEvent("ok", [makeGammaMarket("ok")])])),
      );

    const markets = await gateway.discoverMarkets();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markets).toHaveLength(1);
    expect(markets[0]!.conditionId).toBe("cond-ok");
  });

  it("discoverMarkets() does not retry permanent Gamma 4xx", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
      maxRetries: 3,
      retryDelayMs: 0,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockFetchResponse(null, false, 400));

    await expect(gateway.discoverMarkets()).rejects.toThrow("Gamma API responded with 400");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forEachMarketPage() attaches bounded request context to exhausted Gamma 5xx", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
      maxRetries: 2,
      retryDelayMs: 0,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(
        mockFetchResponse(
          makeEventsPage([makeEvent("a", [makeGammaMarket("a")])], "cursor-page-2"),
        ),
      )
      .mockResolvedValueOnce(mockFetchResponse(null, false, 503))
      .mockResolvedValueOnce(mockFetchResponse(null, false, 503));

    await expect(gateway.forEachMarketPage(() => {})).rejects.toMatchObject({
      message: "Gamma API responded with 503: Internal Server Error",
      statusCode: 503,
      attempt: 2,
      maxAttempts: 2,
      endpointPath: "/events/keyset",
      cursorPreview: "cursor-page-2",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("healthCheck() returns ok:true when Gamma is reachable", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockFetchResponse(makeEventsPage([])));

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

  it("healthCheck() uses /events/keyset with limit=1", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 100,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(mockFetchResponse(makeEventsPage([])));

    await gateway.healthCheck();

    const calledUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(calledUrl.pathname).toBe("/events/keyset");
    expect(calledUrl.searchParams.get("limit")).toBe("1");
    expect(calledUrl.searchParams.has("offset")).toBe(false);
  });

  it("eventMarketCount is populated from event.markets.length for each nested market", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // One binary event (2 markets) and one multi-outcome event (30 markets)
    const binaryMarkets = [makeGammaMarket("bin-a"), makeGammaMarket("bin-b")];
    const multiMarkets = Array.from({ length: 30 }, (_, i) => makeGammaMarket(`multi-${i}`));
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(
        makeEventsPage([
          makeEvent("binary-event", binaryMarkets),
          makeEvent("multi-event", multiMarkets),
        ]),
      ),
    );

    const markets = await gateway.discoverMarkets();

    expect(markets).toHaveLength(32);
    // Binary event markets each report eventMarketCount = 2
    const binaryResults = markets.slice(0, 2);
    expect(binaryResults.every((m) => m.eventMarketCount === 2)).toBe(true);
    // Multi-market event markets each report eventMarketCount = 30
    const multiResults = markets.slice(2);
    expect(multiResults.every((m) => m.eventMarketCount === 30)).toBe(true);
  });

  it("discoverMarkets() handles events with no nested markets", async () => {
    const gateway = new GammaMarketDiscoveryGateway({
      baseUrl: "https://test.gamma.api",
      pageSize: 10,
    });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      mockFetchResponse(
        makeEventsPage([makeEvent("empty", []), { id: "no-markets-field", slug: "bare-event" }]),
      ),
    );

    const markets = await gateway.discoverMarkets();
    expect(markets).toHaveLength(0);
  });
});
