import { describe, expect, it, vi } from "vitest";
import { createConditionId } from "@krabs/domain";
import {
  DataApiTradeCountProvider,
  type TradeCountFetchEvent,
} from "../data-api-trade-count-provider.js";

const CID = createConditionId("0xabc");

function makeFetch(payload: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    body: null,
    json: async () => payload,
  } as unknown as Response);
}

describe("DataApiTradeCountProvider", () => {
  it("returns capped count on happy path and writes cache", async () => {
    const fetchImpl = makeFetch([{}, {}, {}, {}, {}, {}, {}]);
    const events: TradeCountFetchEvent[] = [];
    const provider = new DataApiTradeCountProvider({
      fetchImpl,
      observer: (e) => events.push(e),
    });

    const first = await provider.countTrades(CID, 6);
    const second = await provider.countTrades(CID, 6);

    expect(first).toBe(6);
    expect(second).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0]![0] as URL;
    expect(url.hostname).toBe("data-api.polymarket.com");
    expect(url.searchParams.get("market")).toBe(CID);
    expect(url.searchParams.get("limit")).toBe("6");
    expect(events.map((e) => e.type)).toEqual(["cache_miss", "fetch_ok", "cache_hit"]);
  });

  it("returns 0 for empty arrays", async () => {
    const provider = new DataApiTradeCountProvider({ fetchImpl: makeFetch([]) });
    expect(await provider.countTrades(CID, 6)).toBe(0);
  });

  it("returns the actual count when below cap", async () => {
    const provider = new DataApiTradeCountProvider({ fetchImpl: makeFetch([{}, {}, {}]) });
    expect(await provider.countTrades(CID, 6)).toBe(3);
  });

  it("fetchPublicTradeCount24h counts recent rows and ignores older rows", async () => {
    const now = Date.parse("2026-05-16T12:00:00.000Z");
    const recent = Math.floor((now - 60_000) / 1000);
    const older = Math.floor((now - 25 * 60 * 60_000) / 1000);
    const provider = new DataApiTradeCountProvider({
      fetchImpl: makeFetch([
        { timestamp: recent },
        { timestamp: recent - 10 },
        { timestamp: older },
      ]),
      now: () => now,
    });

    const result = await provider.fetchPublicTradeCount24h(CID, now);

    expect(result).toEqual({ count: 2, capReached: false, fetchedAt: now });
  });

  it("fetchPublicTradeCount24h caps at 100 for diagnostic headroom", async () => {
    const now = Date.parse("2026-05-16T12:00:00.000Z");
    const timestamp = Math.floor((now - 60_000) / 1000);
    const fetchImpl = makeFetch(Array.from({ length: 100 }, () => ({ timestamp })));
    const provider = new DataApiTradeCountProvider({ fetchImpl, now: () => now });

    const result = await provider.fetchPublicTradeCount24h(CID, now);

    expect(result).toEqual({ count: 100, capReached: true, fetchedAt: now });
    const url = fetchImpl.mock.calls[0]![0] as URL;
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("fetchPublicTradeCount24h returns null on API failure", async () => {
    const now = Date.parse("2026-05-16T12:00:00.000Z");
    const provider = new DataApiTradeCountProvider({
      fetchImpl: makeFetch(null, false, 500),
      now: () => now,
    });

    expect(await provider.fetchPublicTradeCount24h(CID, now)).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    const fetchImpl = makeFetch(null, false, 500);
    const events: TradeCountFetchEvent[] = [];
    const provider = new DataApiTradeCountProvider({
      fetchImpl,
      observer: (e) => events.push(e),
    });
    expect(await provider.countTrades(CID, 6)).toBeNull();
    expect(events.find((e) => e.type === "fetch_error")?.error).toBe("http_500");
  });

  it("returns null on non-array payload", async () => {
    const provider = new DataApiTradeCountProvider({
      fetchImpl: makeFetch({ unexpected: "shape" }),
    });
    expect(await provider.countTrades(CID, 6)).toBeNull();
  });

  it("returns null on fetch throw", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    const provider = new DataApiTradeCountProvider({ fetchImpl });
    expect(await provider.countTrades(CID, 6)).toBeNull();
  });

  it("re-fetches after cache TTL expires", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [{}, {}] } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [{}, {}, {}] } as Response);
    let now = 1_000_000;
    const provider = new DataApiTradeCountProvider({
      fetchImpl,
      cacheTtlMs: 1000,
      now: () => now,
    });

    expect(await provider.countTrades(CID, 6)).toBe(2);
    now += 999;
    expect(await provider.countTrades(CID, 6)).toBe(2);
    now += 2;
    expect(await provider.countTrades(CID, 6)).toBe(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest entry when cache is full", async () => {
    const fetchImpl = makeFetch([{}]);
    const provider = new DataApiTradeCountProvider({
      fetchImpl,
      maxCacheEntries: 2,
    });
    await provider.countTrades(createConditionId("0x1"), 6);
    await provider.countTrades(createConditionId("0x2"), 6);
    await provider.countTrades(createConditionId("0x3"), 6);
    await provider.countTrades(createConditionId("0x1"), 6);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("prefetch warms multiple condition IDs in parallel", async () => {
    const fetchImpl = makeFetch([{}, {}]);
    const provider = new DataApiTradeCountProvider({ fetchImpl });
    await provider.prefetch(
      [createConditionId("0xa"), createConditionId("0xb"), createConditionId("0xc")],
      6,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await provider.countTrades(createConditionId("0xa"), 6)).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("prefetch caps in-flight fetches at prefetchConcurrency and saturates it", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const fetchImpl = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => release.push(r));
      inFlight--;
      return { ok: true, json: async () => [{}] } as Response;
    });
    const provider = new DataApiTradeCountProvider({ fetchImpl, prefetchConcurrency: 3 });
    const ids = Array.from({ length: 12 }, (_, i) => createConditionId(`0x${i}`));
    const done = provider.prefetch(ids, 6);

    // First, let all workers spin up to their cap without releasing any fetch.
    // Multiple setImmediate yields are required: each worker needs (a) its
    // initial scheduling tick, (b) the microtask hop into the awaited fetchImpl.
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    expect(inFlight).toBe(3); // saturation: peak hits the configured ceiling

    // Drain workers one-at-a-time; cap must hold for every wave.
    for (let drained = 0; drained < ids.length; drained++) {
      release.shift()?.();
      await new Promise<void>((r) => setImmediate(r));
    }
    await done;
    expect(fetchImpl).toHaveBeenCalledTimes(12);
    expect(peak).toBe(3);
  });

  it("negative-caches HTTP errors so a second call within TTL does not re-fetch", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        body: null,
        json: async () => null,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{}, {}],
      } as Response);
    let now = 1_000_000;
    const events: TradeCountFetchEvent[] = [];
    const provider = new DataApiTradeCountProvider({
      fetchImpl,
      negativeCacheTtlMs: 30_000,
      observer: (e) => events.push(e),
      now: () => now,
    });

    expect(await provider.countTrades(CID, 6)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Second call inside the negative-cache window short-circuits, no re-fetch.
    expect(await provider.countTrades(CID, 6)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // The negative cache_hit event has no count, distinguishing it from a positive hit.
    const negHit = events.find(
      (e, i) => e.type === "cache_hit" && events[i - 1]?.type === "fetch_error",
    );
    expect(negHit).toBeDefined();
    expect(negHit?.count).toBeUndefined();

    // After the negative TTL elapses, the next call re-fetches.
    now += 31_000;
    expect(await provider.countTrades(CID, 6)).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("negative-caches non-array payloads and fetch throws", async () => {
    const now = 1_000_000;
    const provider1 = new DataApiTradeCountProvider({
      fetchImpl: makeFetch({ unexpected: "shape" }),
      now: () => now,
    });
    expect(await provider1.countTrades(CID, 6)).toBeNull();
    // re-call within window: cached, no second fetch
    expect(await provider1.countTrades(CID, 6)).toBeNull();

    const throwImpl = vi.fn().mockRejectedValue(new Error("network"));
    const provider2 = new DataApiTradeCountProvider({
      fetchImpl: throwImpl,
      now: () => now,
    });
    expect(await provider2.countTrades(CID, 6)).toBeNull();
    expect(await provider2.countTrades(CID, 6)).toBeNull();
    expect(throwImpl).toHaveBeenCalledTimes(1);
  });

  it("prefetch under data-api outage issues at most one fetch per conditionId", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
      json: async () => null,
    } as unknown as Response);
    const provider = new DataApiTradeCountProvider({
      fetchImpl,
      prefetchConcurrency: 4,
      negativeCacheTtlMs: 30_000,
    });
    const ids = [createConditionId("0xa"), createConditionId("0xb"), createConditionId("0xc")];
    await provider.prefetch(ids, 6);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // Each id stays in the negative cache: subsequent countTrades during the
    // outage returns null without re-issuing a request.
    for (const id of ids) {
      expect(await provider.countTrades(id, 6)).toBeNull();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("treats different caps as separate cache entries (cap=6 cached cannot satisfy cap=10)", async () => {
    // Saturated cap=6 response: actual count is unknowable but ≥6.
    // A subsequent cap=10 lookup MUST refetch — otherwise we silently
    // undercount when the threshold tunes upward.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => Array(6).fill({}) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => Array(8).fill({}) } as Response);
    const provider = new DataApiTradeCountProvider({ fetchImpl });

    expect(await provider.countTrades(CID, 6)).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(await provider.countTrades(CID, 10)).toBe(8);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1]![0] as URL).searchParams.get("limit")).toBe("10");

    // Original cap=6 entry is still cached and reused.
    expect(await provider.countTrades(CID, 6)).toBe(6);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("respects custom baseUrl", async () => {
    const fetchImpl = makeFetch([]);
    const provider = new DataApiTradeCountProvider({
      fetchImpl,
      baseUrl: "https://test-host.example",
    });
    await provider.countTrades(CID, 6);
    const url = fetchImpl.mock.calls[0]![0] as URL;
    expect(url.hostname).toBe("test-host.example");
    expect(url.pathname).toBe("/trades");
  });
});
