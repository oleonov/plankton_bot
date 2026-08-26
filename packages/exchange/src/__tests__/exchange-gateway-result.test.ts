import { describe, it, expect, vi, beforeEach } from "vitest";
import { LiveExchangeGateway } from "../live/exchange-gateway.js";

function createMockClient() {
  return {
    getOpenOrders: vi.fn(),
    getTrades: vi.fn(),
    getTradesPaginated: vi.fn(),
    getOrder: vi.fn(),
  };
}

function tradePage(trades: unknown[], nextCursor = "LTE=") {
  return { trades, next_cursor: nextCursor, limit: trades.length, count: trades.length };
}

function statusError(message: string, status: number): Error {
  const err = new Error(message);
  Object.assign(err, { status });
  return err;
}

const FAST_RETRY = {
  retries: 3,
  backoffMs: [1, 1, 1],
  sleep: async () => {},
};

describe("LiveExchangeGateway.getOpenOrdersResult", () => {
  let client: ReturnType<typeof createMockClient>;
  let gw: LiveExchangeGateway;

  beforeEach(() => {
    client = createMockClient();
    gw = new LiveExchangeGateway({ client, fetchRetry: FAST_RETRY });
  });

  it("returns ok:true with mapped orders", async () => {
    client.getOpenOrders.mockResolvedValue([
      {
        id: "ord-1",
        asset_id: "tok-1",
        side: "BUY",
        original_size: "100",
        size_matched: "0",
        price: "0.50",
        status: "LIVE",
        created_at: 1700000000000,
      },
    ]);

    const result = await gw.getOpenOrdersResult();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.orderId).toBe("ord-1");
    }
  });

  it("treats an empty array as a successful empty snapshot (NOT a failure)", async () => {
    client.getOpenOrders.mockResolvedValue([]);
    const result = await gw.getOpenOrdersResult();
    expect(result).toEqual({ ok: true, data: [] });
    expect(client.getOpenOrders).toHaveBeenCalledTimes(1);
  });

  it("retries a persistent 429 then fails with reason rate_limit and attempts === retries+1", async () => {
    client.getOpenOrders.mockRejectedValue(statusError("Too Many Requests", 429));
    const result = await gw.getOpenOrdersResult();
    expect(result).toEqual({ ok: false, reason: "rate_limit", attempts: 4 });
    expect(client.getOpenOrders).toHaveBeenCalledTimes(4);
  });

  it("classifies a RETURNED { error, status } object (throwOnError=false path)", async () => {
    // The CLOB client returns this instead of throwing when throwOnError=false.
    client.getOpenOrders.mockResolvedValue({ error: "no healthy upstream", status: 503 });
    const result = await gw.getOpenOrdersResult();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("server");
    expect(client.getOpenOrders).toHaveBeenCalledTimes(4);
  });

  it("does NOT retry a 4xx client error", async () => {
    client.getOpenOrders.mockRejectedValue(statusError("Bad Request", 400));
    const result = await gw.getOpenOrdersResult();
    expect(result).toEqual({ ok: false, reason: "client", attempts: 1 });
    expect(client.getOpenOrders).toHaveBeenCalledTimes(1);
  });

  it("returns parse (no retry) when the response is not array-shaped", async () => {
    client.getOpenOrders.mockResolvedValue({ unexpected: true });
    const result = await gw.getOpenOrdersResult();
    expect(result).toEqual({ ok: false, reason: "parse", attempts: 1 });
    expect(client.getOpenOrders).toHaveBeenCalledTimes(1);
  });

  it("recovers after a transient failure then succeeds", async () => {
    client.getOpenOrders.mockRejectedValueOnce(statusError("503", 503)).mockResolvedValueOnce([]);
    const result = await gw.getOpenOrdersResult();
    expect(result).toEqual({ ok: true, data: [] });
    expect(client.getOpenOrders).toHaveBeenCalledTimes(2);
  });

  it("old getOpenOrders still returns [] on failure (backward compat, no retry semantics leak)", async () => {
    client.getOpenOrders.mockRejectedValue(new Error("Network error"));
    const orders = await gw.getOpenOrders();
    expect(orders).toEqual([]);
    // Old path must NOT retry — one call only.
    expect(client.getOpenOrders).toHaveBeenCalledTimes(1);
  });
});

describe("LiveExchangeGateway.getOrderResult", () => {
  let client: ReturnType<typeof createMockClient>;
  let gw: LiveExchangeGateway;

  beforeEach(() => {
    client = createMockClient();
    gw = new LiveExchangeGateway({ client, fetchRetry: FAST_RETRY });
  });

  it("returns an exact mapped record and retries only transient failures", async () => {
    client.getOrder.mockRejectedValueOnce(statusError("unavailable", 503)).mockResolvedValueOnce({
      id: "ord-1",
      asset_id: "tok-1",
      side: "BUY",
      original_size: "100",
      size_matched: "0",
      price: "0.5",
      status: "ORDER_STATUS_LIVE",
      created_at: 1700000000000,
    });
    expect(await gw.getOrderResult("ord-1")).toMatchObject({
      ok: true,
      data: { orderId: "ord-1" },
    });
    expect(client.getOrder).toHaveBeenCalledTimes(2);
  });

  it("treats literal, returned, and thrown 404 as authoritative null", async () => {
    client.getOrder
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ error: "not found", status: 404 })
      .mockRejectedValueOnce(statusError("not found", 404));
    expect(await gw.getOrderResult("ord-1")).toEqual({ ok: true, data: null });
    expect(await gw.getOrderResult("ord-2")).toEqual({ ok: true, data: null });
    expect(await gw.getOrderResult("ord-3")).toEqual({ ok: true, data: null });
  });

  it("fails closed for malformed or mismatched exact records", async () => {
    client.getOrder.mockResolvedValue({
      id: "other-order",
      asset_id: "tok-1",
      side: "BUY",
      original_size: "100",
      size_matched: "0",
      price: "0.5",
      status: "LIVE",
    });
    expect(await gw.getOrderResult("ord-1")).toEqual({ ok: false, reason: "parse", attempts: 1 });
  });

  it("fails closed when exact terminal fill status contradicts matched size", async () => {
    client.getOrder
      .mockResolvedValueOnce({
        id: "ord-partial",
        asset_id: "tok-1",
        side: "BUY",
        original_size: "100",
        size_matched: "99",
        price: "0.5",
        status: "MATCHED",
      })
      .mockResolvedValueOnce({
        id: "ord-zero",
        asset_id: "tok-1",
        side: "BUY",
        original_size: "100",
        size_matched: "0",
        price: "0.5",
        status: "FILLED",
      });

    expect(await gw.getOrderResult("ord-partial")).toEqual({
      ok: false,
      reason: "parse",
      attempts: 1,
    });
    expect(await gw.getOrderResult("ord-zero")).toEqual({
      ok: false,
      reason: "parse",
      attempts: 1,
    });
  });

  it("accepts exact terminal fill status when matched size equals original size", async () => {
    client.getOrder.mockResolvedValue({
      id: "ord-filled",
      asset_id: "tok-1",
      side: "BUY",
      original_size: "100",
      size_matched: "100",
      price: "0.5",
      status: "MATCHED",
    });

    expect(await gw.getOrderResult("ord-filled")).toMatchObject({
      ok: true,
      data: { orderId: "ord-filled", status: "FILLED", sizeRemaining: 0 },
    });
  });
});

describe("LiveExchangeGateway.getFillsResult", () => {
  let client: ReturnType<typeof createMockClient>;
  let gw: LiveExchangeGateway;

  beforeEach(() => {
    client = createMockClient();
    gw = new LiveExchangeGateway({ client, fetchRetry: FAST_RETRY });
  });

  it("returns ok:true with mapped fills", async () => {
    client.getTradesPaginated.mockResolvedValue(
      tradePage([
        {
          id: "trade-1",
          taker_order_id: "ord-1",
          asset_id: "tok-1",
          side: "BUY",
          size: "50",
          price: "0.55",
          fee_rate_bps: "100",
          status: "CONFIRMED",
          match_time: "2026-01-15T12:00:00Z",
        },
      ]),
    );

    const result = await gw.getFillsResult(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.fillId).toBe("trade-1");
    }
  });

  it("treats empty trades as ok:true (NOT failure)", async () => {
    client.getTradesPaginated.mockResolvedValue(tradePage([]));
    const result = await gw.getFillsResult(0);
    expect(result).toEqual({ ok: true, data: [] });
  });

  it("retries transient failures and reports ok:false on exhaustion", async () => {
    client.getTradesPaginated.mockRejectedValue(statusError("502", 502));
    const result = await gw.getFillsResult(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("server");
      expect(result.attempts).toBe(4);
    }
    expect(client.getTradesPaginated).toHaveBeenCalledTimes(4);
  });

  it("fails closed without returning page-one fills when page two is unauthorized", async () => {
    client.getTradesPaginated
      .mockResolvedValueOnce(
        tradePage(
          [
            {
              id: "trade-page-1",
              taker_order_id: "ord-1",
              asset_id: "tok-1",
              side: "BUY",
              size: "1",
              price: "0.5",
              status: "CONFIRMED",
              match_time: "2026-01-15T12:00:00Z",
            },
          ],
          "page-2",
        ),
      )
      .mockResolvedValueOnce({
        trades: [],
        error: "Invalid API key",
        status: 401,
        next_cursor: "LTE=",
        limit: 0,
        count: 0,
      });

    expect(await gw.getFillsResult(0)).toEqual({ ok: false, reason: "client", attempts: 1 });
  });

  it("restarts a transiently failed paginated fill snapshot from page one", async () => {
    const firstPage = tradePage([], "page-2");
    client.getTradesPaginated
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(statusError("502", 502))
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(tradePage([]));

    expect(await gw.getFillsResult(0)).toEqual({ ok: true, data: [] });
    expect(client.getTradesPaginated.mock.calls.map((call) => call[1])).toEqual([
      "MA==",
      "page-2",
      "MA==",
      "page-2",
    ]);
  });

  it("old getFills still returns [] on failure (backward compat)", async () => {
    client.getTradesPaginated.mockRejectedValue(new Error("fetch failed"));
    const fills = await gw.getFills(0);
    expect(fills).toEqual([]);
    expect(client.getTradesPaginated).toHaveBeenCalledTimes(1);
  });
});
