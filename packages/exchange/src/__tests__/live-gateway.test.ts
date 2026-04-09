import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenId } from "@plankton/domain";
import { LiveExchangeGateway } from "../live/exchange-gateway.js";
import { LiveMarketDataGateway, buildTokenIdBatches } from "../live/market-data-gateway.js";

// ─── Mock ClobClient ─────────────────────────────────────────────────────

function createMockClient() {
  return {
    chainId: 137,
    createAndPostOrder: vi.fn(),
    createOrder: vi.fn(),
    postOrder: vi.fn(),
    cancelOrder: vi.fn(),
    cancelAll: vi.fn(),
    getOpenOrders: vi.fn(),
    getTrades: vi.fn(),
    getBalanceAllowance: vi.fn(),
    getOk: vi.fn(),
    getMarkets: vi.fn(),
    getMarket: vi.fn(),
    getOrderBook: vi.fn(),
    getTickSize: vi.fn(),
  };
}

function createMockSettlementClient() {
  return {
    execute: vi.fn().mockResolvedValue({}),
  };
}

describe("LiveExchangeGateway", () => {
  let client: ReturnType<typeof createMockClient>;
  let gw: LiveExchangeGateway;

  beforeEach(() => {
    client = createMockClient();
    gw = new LiveExchangeGateway({ client });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("placeOrder calls createAndPostOrder and returns success", async () => {
    client.createAndPostOrder.mockResolvedValue({ orderID: "live-ord-1" });

    const result = await gw.placeOrder({
      clientOrderId: "cloid-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      size: 100,
      price: 0.5,
      orderType: "GTC",
      tickSize: 0.01,
      negRisk: false,
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("live-ord-1");
    expect(client.createAndPostOrder).toHaveBeenCalledOnce();

    const [userOrder, options] = client.createAndPostOrder.mock.calls[0]!;
    expect(userOrder.tokenID).toBe("tok-1");
    expect(userOrder.side).toBe("BUY");
    expect(options.tickSize).toBe("0.01");
    expect(options.negRisk).toBe(false);
  });

  it("placeOrder uses signed-order post path for post-only orders", async () => {
    const signedOrder = { id: "signed-order" };
    client.createOrder.mockResolvedValue(signedOrder);
    client.postOrder.mockResolvedValue({ orderID: "live-ord-post-only" });

    const result = await gw.placeOrder({
      clientOrderId: "cloid-post-only",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      size: 100,
      price: 0.49,
      postOnly: true,
      orderType: "GTC",
      tickSize: 0.01,
      negRisk: false,
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("live-ord-post-only");
    expect(client.createAndPostOrder).not.toHaveBeenCalled();
    expect(client.createOrder).toHaveBeenCalledOnce();
    expect(client.postOrder).toHaveBeenCalledWith(signedOrder, "GTC", true);
  });

  it("placeOrder returns error result on SDK failure", async () => {
    client.createAndPostOrder.mockRejectedValue(new Error("Insufficient balance"));

    const result = await gw.placeOrder({
      clientOrderId: "cloid-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      size: 100,
      price: 0.5,
      orderType: "GTC",
      tickSize: 0.01,
      negRisk: false,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INSUFFICIENT_BALANCE");
  });

  it("placeOrder rejects empty SDK success payload without order id", async () => {
    client.createAndPostOrder.mockResolvedValue({});

    const result = await gw.placeOrder({
      clientOrderId: "cloid-1",
      tokenId: createTokenId("tok-1"),
      side: "buy",
      size: 100,
      price: 0.5,
      orderType: "GTC",
      tickSize: 0.01,
      negRisk: false,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("UNKNOWN");
    expect(result.errorMessage).toContain("no order id");
  });

  it("cancelOrder calls SDK cancelOrder", async () => {
    client.cancelOrder.mockResolvedValue({});

    const result = await gw.cancelOrder({ orderId: "ord-1" });
    expect(result.success).toBe(true);
    expect(client.cancelOrder).toHaveBeenCalledWith({ orderID: "ord-1" });
  });

  it("cancelOrder returns error on failure", async () => {
    client.cancelOrder.mockRejectedValue(new Error("Order not found"));

    const result = await gw.cancelOrder({ orderId: "nonexistent" });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("ORDER_NOT_FOUND");
  });

  it("cancelAllOrders calls SDK cancelAll", async () => {
    client.cancelAll.mockResolvedValue({});
    const result = await gw.cancelAllOrders();
    expect(result.success).toBe(true);
  });

  it("getOpenOrders maps SDK response", async () => {
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

    const orders = await gw.getOpenOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.orderId).toBe("ord-1");
    expect(orders[0]!.status).toBe("OPEN");
  });

  it("getFills maps SDK trades", async () => {
    client.getTrades.mockResolvedValue([
      {
        id: "trade-1",
        taker_order_id: "ord-1",
        asset_id: "tok-1",
        side: "BUY",
        size: "50",
        price: "0.55",
        fee_rate_bps: "100",
        match_time: "2026-01-15T12:00:00Z",
      },
    ]);

    const fills = await gw.getFills(0);
    expect(fills).toHaveLength(1);
    expect(fills[0]!.fillId).toBe("trade-1");
    expect(fills[0]!.price).toBe(0.55);
    // fee = 50 * (100 / 10000) * 0.55 * (1 - 0.55) = 50 * 0.01 * 0.55 * 0.45 = 0.5 * 0.2475 = 0.12375
    expect(fills[0]!.fee).toBeCloseTo(0.12375);
  });

  it("getFills extracts only personal legs when traderAddress is configured", async () => {
    gw = new LiveExchangeGateway({ client, traderAddress: "0xours" });
    client.getTrades.mockResolvedValue([
      {
        id: "trade-maker",
        taker_order_id: "ord-foreign",
        asset_id: "tok-foreign-no",
        side: "BUY",
        size: "334.37",
        price: "0.90",
        fee_rate_bps: "1000",
        match_time: "2026-04-05T00:00:00Z",
        maker_address: "0xforeign",
        trader_side: "MAKER",
        maker_orders: [
          {
            order_id: "ord-ours",
            maker_address: "0xours",
            asset_id: "tok-our-yes",
            side: "BUY",
            matched_amount: "43.47",
            price: "0.11",
            fee_rate_bps: "1000",
          },
        ],
      },
      {
        id: "trade-taker",
        taker_order_id: "ord-taker",
        asset_id: "tok-our-no",
        side: "SELL",
        size: "5",
        price: "0.25",
        fee_rate_bps: "1000",
        match_time: "2026-04-05T00:00:00Z",
        maker_address: "0xours",
        trader_side: "TAKER",
      },
    ]);

    const fills = await gw.getFills(0);

    expect(fills).toHaveLength(2);
    expect(fills.map((fill) => fill.orderId)).toEqual(["ord-ours", "ord-taker"]);
    expect(fills.map((fill) => fill.tokenId)).toEqual(["tok-our-yes", "tok-our-no"]);
  });

  it("getBalances normalizes atomic units to human-readable USDC", async () => {
    client.getBalanceAllowance.mockResolvedValue({ balance: "8995487", allowance: "1000000000" });

    const balances = await gw.getBalances();
    expect(balances).toHaveLength(1);
    expect(balances[0]!.asset).toBe("USDC");
    expect(balances[0]!.available).toBeCloseTo(8.995487, 6);
    expect(client.getBalanceAllowance).toHaveBeenCalledWith({
      asset_type: "COLLATERAL",
    });
  });

  it("getOpenOrders returns empty array on SDK failure", async () => {
    client.getOpenOrders.mockRejectedValue(new Error("Network error"));
    const orders = await gw.getOpenOrders();
    expect(orders).toEqual([]);
  });

  it("getOpenOrdersForToken returns empty array on SDK failure", async () => {
    client.getOpenOrders.mockRejectedValue(new Error("timeout"));
    const orders = await gw.getOpenOrdersForToken(createTokenId("tok-1"));
    expect(orders).toEqual([]);
  });

  it("getFills returns empty array on SDK failure", async () => {
    client.getTrades.mockRejectedValue(new Error("fetch failed"));
    const fills = await gw.getFills(0);
    expect(fills).toEqual([]);
  });

  it("getBalances returns empty array on SDK failure", async () => {
    client.getBalanceAllowance.mockRejectedValue(new Error("Unauthorized"));
    const balances = await gw.getBalances();
    expect(balances).toEqual([]);
  });

  it("getPositionBalance normalizes atomic units to human-readable", async () => {
    client.getBalanceAllowance.mockResolvedValue({ balance: "42000000" });
    const balance = await gw.getPositionBalance(createTokenId("tok-1"));
    expect(balance).toBe(42);
    expect(client.getBalanceAllowance).toHaveBeenCalledWith({
      asset_type: "CONDITIONAL",
      token_id: "tok-1",
    });
  });

  it("getPositionBalance throws on SDK failure instead of returning 0", async () => {
    client.getBalanceAllowance.mockRejectedValue(new Error("Network error"));
    await expect(gw.getPositionBalance(createTokenId("tok-1"))).rejects.toThrow("Network error");
  });

  it("redeemPositions warns once and no-ops when the SDK has no redeem API", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    await expect(gw.redeemPositions(["cond-1", "cond-2"])).resolves.toBeUndefined();
    await expect(gw.redeemPositions(["cond-3"])).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("redeemPositions skipped"),
      expect.objectContaining({ code: "PLANKTON_REDEEM_UNSUPPORTED" }),
    );
  });

  it("redeemPositions submits CTF redeem via settlement client for regular markets", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "1000000" })
      .mockResolvedValueOnce({ balance: "0" });
    gw = new LiveExchangeGateway({ client, settlementClient });

    await gw.redeemPositions([
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    ]);

    expect(settlementClient.execute).toHaveBeenCalledTimes(1);
    const [txs, metadata] = settlementClient.execute.mock.calls[0]!;
    expect(metadata).toContain("redeem positions");
    expect(txs).toHaveLength(1);
    expect(txs[0]!.to).toBe("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045");
    expect(txs[0]!.value).toBe("0");
    expect(txs[0]!.data).toContain("0x");
  });

  it("redeemPositions submits neg-risk adapter redeem with raw token balances", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: true,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "111000000" })
      .mockResolvedValueOnce({ balance: "0" });
    gw = new LiveExchangeGateway({ client, settlementClient });

    await gw.redeemPositions([
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    ]);

    expect(settlementClient.execute).toHaveBeenCalledTimes(1);
    const [txs] = settlementClient.execute.mock.calls[0]!;
    expect(txs).toHaveLength(1);
    expect(txs[0]!.to).toBe("0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296");
    expect(txs[0]!.value).toBe("0");
    expect(txs[0]!.data).toContain("0x");
  });

  it("redeemPositions skips relayer submission when no token balances remain", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "0" })
      .mockResolvedValueOnce({ balance: "0" });
    gw = new LiveExchangeGateway({ client, settlementClient });

    await gw.redeemPositions([
      "0x3333333333333333333333333333333333333333333333333333333333333333",
    ]);

    expect(settlementClient.execute).not.toHaveBeenCalled();
  });

  it("redeemPositions marks a relayer submission as pending when confirmation is still async", async () => {
    const settlementClient = {
      execute: vi.fn().mockResolvedValue({}),
    };
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }],
    });
    client.getBalanceAllowance.mockResolvedValueOnce({ balance: "1000000" });
    gw = new LiveExchangeGateway({ client, settlementClient });

    const conditionId = "0x6666666666666666666666666666666666666666666666666666666666666666";
    await gw.redeemPositions([conditionId]);

    expect(gw.hasPendingRedeemSubmission(conditionId)).toBe(true);
  });

  it("redeemPositions clears pending state when relayer confirmation resolves quickly", async () => {
    const wait = vi.fn().mockResolvedValue({ state: "MINED" });
    const settlementClient = {
      execute: vi.fn().mockResolvedValue({ wait }),
    };
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }],
    });
    client.getBalanceAllowance.mockResolvedValueOnce({ balance: "1000000" });
    gw = new LiveExchangeGateway({ client, settlementClient });

    const conditionId = "0x7777777777777777777777777777777777777777777777777777777777777777";
    await gw.redeemPositions([conditionId]);
    await Promise.resolve();
    await Promise.resolve();

    expect(wait).toHaveBeenCalledTimes(1);
    expect(gw.hasPendingRedeemSubmission(conditionId)).toBe(false);
  });

  it("redeemPositions reports polygon rpc upstream failures as infra alerts", async () => {
    const settlementClient = {
      execute: vi
        .fn()
        .mockRejectedValue(
          new Error('{"error":"request error","status":503,"data":"no healthy upstream"}'),
        ),
    };
    const onInfraAlert = vi.fn();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }],
    });
    client.getBalanceAllowance.mockResolvedValueOnce({ balance: "1000000" });
    gw = new LiveExchangeGateway({ client, settlementClient, onInfraAlert });

    await expect(
      gw.redeemPositions(["0x4444444444444444444444444444444444444444444444444444444444444444"]),
    ).rejects.toThrow();

    expect(onInfraAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "POLYGON_RPC_UNAVAILABLE",
        source: "polygon-rpc",
      }),
    );
  });

  it("redeemPositions reports rpc quota failures as rate-limit alerts", async () => {
    const settlementClient = {
      execute: vi
        .fn()
        .mockRejectedValue(
          new Error('{"error":"request error","status":429,"data":"exceeded its compute units"}'),
        ),
    };
    const onInfraAlert = vi.fn();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }],
    });
    client.getBalanceAllowance.mockResolvedValueOnce({ balance: "1000000" });
    gw = new LiveExchangeGateway({ client, settlementClient, onInfraAlert });

    await expect(
      gw.redeemPositions(["0x5555555555555555555555555555555555555555555555555555555555555555"]),
    ).rejects.toThrow();

    expect(onInfraAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "POLYGON_RPC_RATE_LIMITED",
        source: "polygon-rpc",
      }),
    );
  });

  it("redeemPositions uses client postRedeem when available", async () => {
    const postRedeem = vi.fn().mockResolvedValue(undefined);
    Object.assign(client, { postRedeem });

    await gw.redeemPositions(["cond-1", "cond-2"]);

    expect(postRedeem).toHaveBeenCalledTimes(2);
    expect(postRedeem).toHaveBeenNthCalledWith(1, { conditionId: "cond-1" });
    expect(postRedeem).toHaveBeenNthCalledWith(2, { conditionId: "cond-2" });
  });

  it("mergePositions builds and executes on-chain merge transactions", async () => {
    const settlementClient = createMockSettlementClient();
    gw = new LiveExchangeGateway({ client, settlementClient });

    // Mock market tokens
    client.getMarket.mockResolvedValue({
      tokens: [
        { outcome: "Yes", token_id: "tok-yes" },
        { outcome: "No", token_id: "tok-no" },
      ],
    });

    await gw.mergePositions([
      {
        conditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
        amount: 10,
      },
    ]);

    expect(settlementClient.execute).toHaveBeenCalledTimes(1);
    const [txs, label] = settlementClient.execute.mock.calls[0] as [any[], string];
    expect(label).toContain(
      "merge positions: 0x1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(txs).toHaveLength(1);
    // Verify encoded data roughly contains the amount (10 tokens -> 10 * 10^6 = 10000000)
    // 10000000 decimal is 0x989680 hex.
    expect(txs[0].data).toContain("989680");
  });

  it("mergePositions warns once and no-ops when the SDK has no merge API", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    await expect(
      gw.mergePositions([
        { conditionId: "cond-1", amount: 10 },
        { conditionId: "cond-2", amount: 20 },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      gw.mergePositions([{ conditionId: "cond-3", amount: 30 }]),
    ).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("mergePositions skipped"),
      expect.objectContaining({ code: "PLANKTON_MERGE_UNSUPPORTED" }),
    );
  });

  it("mergePositions does not use batch fallback that drops merge amount", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const mergeBatch = vi.fn().mockResolvedValue(undefined);
    Object.assign(client as Record<string, unknown>, {
      mergePositions: mergeBatch,
    });

    await expect(
      gw.mergePositions([
        { conditionId: "cond-1", amount: 10 },
        { conditionId: "cond-2", amount: 20 },
      ]),
    ).resolves.toBeUndefined();

    expect(mergeBatch).not.toHaveBeenCalled();
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("mergePositions skipped"),
      expect.objectContaining({ code: "PLANKTON_MERGE_UNSUPPORTED" }),
    );
  });

  it("healthCheck returns ok on success", async () => {
    client.getOk.mockResolvedValue("OK");
    const health = await gw.healthCheck();
    expect(health.ok).toBe(true);
  });

  it("healthCheck returns not ok on failure", async () => {
    client.getOk.mockRejectedValue(new Error("down"));
    const health = await gw.healthCheck();
    expect(health.ok).toBe(false);
  });
});

describe("LiveMarketDataGateway", () => {
  let client: ReturnType<typeof createMockClient>;
  let gw: LiveMarketDataGateway;

  beforeEach(() => {
    client = createMockClient();
    gw = new LiveMarketDataGateway({ client });
  });

  it("getMarkets paginates and filters active", async () => {
    client.getMarkets
      .mockResolvedValueOnce({
        data: [{ condition_id: "c1", active: true, question: "Q1" }],
        next_cursor: "abc",
      })
      .mockResolvedValueOnce({
        data: [{ condition_id: "c2", active: false, question: "Q2" }],
        next_cursor: "LTE=",
      });

    const markets = await gw.getMarkets();
    expect(markets).toHaveLength(1);
    expect(markets[0]!.conditionId).toBe("c1");
    expect(client.getMarkets).toHaveBeenCalledTimes(2);
  });

  it("getMarkets calls onPage callback with incrementing page numbers", async () => {
    client.getMarkets
      .mockResolvedValueOnce({
        data: [{ condition_id: "c1", active: true, question: "Q1" }],
        next_cursor: "page2",
      })
      .mockResolvedValueOnce({
        data: [{ condition_id: "c2", active: true, question: "Q2" }],
        next_cursor: "LTE=",
      });

    const onPage = vi.fn();
    await gw.getMarkets(onPage);

    expect(onPage).toHaveBeenCalledTimes(2);
    expect(onPage).toHaveBeenNthCalledWith(1, 1);
    expect(onPage).toHaveBeenNthCalledWith(2, 2);
  });

  it("getMarkets works without onPage callback", async () => {
    client.getMarkets.mockResolvedValueOnce({
      data: [{ condition_id: "c1", active: true, question: "Q1" }],
      next_cursor: "LTE=",
    });

    const markets = await gw.getMarkets();
    expect(markets).toHaveLength(1);
    expect(markets[0]!.conditionId).toBe("c1");
  });

  it("getMarket returns mapped market", async () => {
    client.getMarket.mockResolvedValue({
      condition_id: "cond-1",
      question: "Test?",
      active: true,
      tokens: [],
    });

    const market = await gw.getMarket("cond-1");
    expect(market).not.toBeNull();
    expect(market!.conditionId).toBe("cond-1");
  });

  it("getMarket returns null on SDK failure", async () => {
    client.getMarket.mockRejectedValue(new Error("not found"));
    const market = await gw.getMarket("nonexistent");
    expect(market).toBeNull();
  });

  it("getOrderBook maps SDK response", async () => {
    client.getOrderBook.mockResolvedValue({
      bids: [{ price: "0.50", size: "100" }],
      asks: [{ price: "0.55", size: "200" }],
    });

    const tokenId = createTokenId("tok-1");
    const book = await gw.getOrderBook(tokenId);
    expect(book.tokenId).toBe("tok-1");
    expect(book.bestBid).toBe(0.5);
    expect(book.bestAsk).toBe(0.55);
  });

  it("getTickSize returns parsed number", async () => {
    client.getTickSize.mockResolvedValue("0.001");
    const tick = await gw.getTickSize(createTokenId("tok-1"));
    expect(tick).toBe(0.001);
  });

  it("getMarkets filters by slugFilter across multiple pages", async () => {
    const filtered = new LiveMarketDataGateway({
      client,
      slugFilter: (slug) => slug.startsWith("bitcoin-"),
    });

    client.getMarkets
      .mockResolvedValueOnce({
        data: [
          { condition_id: "c1", active: true, question: "Q1", market_slug: "bitcoin-above-100k" },
          { condition_id: "c2", active: true, question: "Q2", market_slug: "will-it-rain" },
        ],
        next_cursor: "page2",
      })
      .mockResolvedValueOnce({
        data: [
          { condition_id: "c3", active: true, question: "Q3", market_slug: "bitcoin-above-200k" },
          { condition_id: "c4", active: false, question: "Q4", market_slug: "bitcoin-above-50k" },
          { condition_id: "c5", active: true, question: "Q5", market_slug: "eth-price" },
        ],
        next_cursor: "LTE=",
      });

    const markets = await filtered.getMarkets();

    // c2 excluded (slug mismatch), c4 excluded (inactive), c5 excluded (slug mismatch)
    expect(markets).toHaveLength(2);
    expect(markets[0]!.slug).toBe("bitcoin-above-100k");
    expect(markets[1]!.slug).toBe("bitcoin-above-200k");
    // Both pages were fetched
    expect(client.getMarkets).toHaveBeenCalledTimes(2);
  });

  it("getMarkets propagates errors instead of masking them", async () => {
    client.getMarkets.mockRejectedValue(new Error("Network error"));
    await expect(gw.getMarkets()).rejects.toThrow("Network error");
  });

  it("getMarkets throws when SDK returns error object instead of data", async () => {
    // The SDK swallows axios errors and returns { error: "..." } instead of throwing
    client.getMarkets.mockResolvedValue({ error: "read ECONNRESET" });
    await expect(gw.getMarkets()).rejects.toThrow("CLOB SDK error: read ECONNRESET");
  });

  it("getMarkets rejects when client hangs beyond timeout", async () => {
    vi.useFakeTimers();
    try {
      client.getMarkets.mockReturnValue(new Promise(() => {})); // never resolves
      const promise = gw.getMarkets();
      // Attach rejection handler before advancing timers to avoid unhandled rejection
      const assertion = expect(promise).rejects.toThrow("request timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("getOrderBook returns empty book on SDK failure", async () => {
    client.getOrderBook.mockRejectedValue(new Error("timeout"));
    const tokenId = createTokenId("tok-1");
    const book = await gw.getOrderBook(tokenId);
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
    expect(book.bestBid).toBeNull();
  });

  it("getOrderBook returns empty book when client hangs beyond timeout", async () => {
    vi.useFakeTimers();
    try {
      client.getOrderBook.mockReturnValue(new Promise(() => {})); // never resolves
      const tokenId = createTokenId("tok-1");
      const promise = gw.getOrderBook(tokenId);
      await vi.advanceTimersByTimeAsync(10_000);
      const book = await promise;
      expect(book.bids).toEqual([]);
      expect(book.asks).toEqual([]);
      expect(book.bestBid).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("getTickSize returns default 0.01 on SDK failure", async () => {
    client.getTickSize.mockRejectedValue(new Error("fetch failed"));
    const tick = await gw.getTickSize(createTokenId("tok-1"));
    expect(tick).toBe(0.01);
  });

  it("getMarketPricing constructs URL with repeated clob_token_ids params", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              clobTokenIds: ["tok-a", "tok-b"],
              outcomePrices: "[0.45,0.55]",
              bestBid: 0.44,
              bestAsk: 0.46,
            },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { asset_id: "tok-a", min_order_size: "5" },
            { asset_id: "tok-b", min_order_size: "1" },
          ]),
      });

    try {
      await gw.getMarketPricing(["tok-a", "tok-b"]);

      const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(calledUrl).toContain("clob_token_ids=tok-a&clob_token_ids=tok-b");
      expect(calledUrl).toContain("gamma-api.polymarket.com/markets");
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1]![0]).toBe(
        "https://clob.polymarket.com/books",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing extracts pricing when Gamma returns stringified clobTokenIds and outcomePrices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              clobTokenIds: '["tok-a", "tok-b"]',
              outcomePrices: '["0.45", "0.55"]',
              bestBid: 0.44,
              bestAsk: 0.46,
              lastTradePrice: 0.45,
            },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { asset_id: "tok-a", min_order_size: "5" },
            { asset_id: "tok-b", min_order_size: "1" },
          ]),
      });

    try {
      const result = await gw.getMarketPricing(["tok-a"]);
      expect(result.size).toBe(2);
      expect(result.get("tok-a")!.bestBid).toBe(0.44);
      expect(result.get("tok-b")!.bestBid).toBe(0.55);
      expect(result.get("tok-a")!.minOrderSize).toBe(5);
      expect(result.get("tok-b")!.minOrderSize).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing splits into multiple requests when URL would exceed limit", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    globalThis.fetch = fetchMock;

    try {
      // Real Polymarket token IDs are ~77 chars; generate enough to force multiple batches
      const tokenIds = Array.from({ length: 50 }, (_, i) => String(i).padStart(77, "0"));
      await gw.getMarketPricing(tokenIds);

      // With 77-char IDs + "clob_token_ids=" overhead, each batch should stay under 3500 chars
      const gammaCalls = fetchMock.mock.calls.filter((call) => typeof call[0] === "string");
      expect(gammaCalls.length).toBeGreaterThan(1);
      for (const call of gammaCalls) {
        expect((call[0] as string).length).toBeLessThanOrEqual(3500);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing returns empty map for empty input", async () => {
    const result = await gw.getMarketPricing([]);
    expect(result.size).toBe(0);
  });

  it("getMarketPricing throws on HTTP error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    try {
      await expect(gw.getMarketPricing(["tok-1"])).rejects.toThrow(
        "Gamma pricing request failed: 500",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing throws when CLOB books request fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

    try {
      await expect(gw.getMarketPricing(["tok-1"])).rejects.toThrow(
        "CLOB books request failed: 503",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("healthCheck returns ok on success", async () => {
    client.getOk.mockResolvedValue("OK");
    const health = await gw.healthCheck();
    expect(health.ok).toBe(true);
  });
});

describe("buildTokenIdBatches", () => {
  const base = "https://gamma-api.polymarket.com/markets";

  it("returns empty array for empty input", () => {
    expect(buildTokenIdBatches(base, [], 3500)).toEqual([]);
  });

  it("keeps small input in one batch", () => {
    const batches = buildTokenIdBatches(base, ["a", "b", "c"], 3500);
    expect(batches).toEqual([["a", "b", "c"]]);
  });

  it("splits when URL would exceed maxUrlLength", () => {
    // Each ID is 50 chars. Param overhead per ID = "&clob_token_ids=" = 17 chars.
    // Per token: 50 + 17 = 67 chars. Base URL + "?" = 48 chars.
    // maxUrlLength = 200 → room for (200 - 48) / 67 ≈ 2 tokens per batch
    const ids = ["a".repeat(50), "b".repeat(50), "c".repeat(50)];
    const batches = buildTokenIdBatches(base, ids, 200);
    expect(batches.length).toBe(2);
    expect(batches[0]).toEqual([ids[0], ids[1]]);
    expect(batches[1]).toEqual([ids[2]]);
  });

  it("sends oversized single token alone instead of dropping it", () => {
    // A single token so large that base + "?" + param exceeds the limit
    const hugeToken = "x".repeat(5000);
    const batches = buildTokenIdBatches(base, [hugeToken], 200);
    expect(batches).toEqual([[hugeToken]]);
  });

  it("handles realistic 77-char Polymarket token IDs", () => {
    const ids = Array.from({ length: 40 }, (_, i) => String(i).padStart(77, "0"));
    const batches = buildTokenIdBatches(base, ids, 3500);

    // Every batch URL must be under the limit (except oversized singles)
    for (const batch of batches) {
      const params = batch.map((id) => `clob_token_ids=${id}`).join("&");
      const url = `${base}?${params}`;
      expect(url.length).toBeLessThanOrEqual(3500);
    }

    // All tokens are present and in order
    expect(batches.flat()).toEqual(ids);
  });

  it("preserves ordering across batches", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `token-${i}`);
    const batches = buildTokenIdBatches(base, ids, 300);
    expect(batches.flat()).toEqual(ids);
  });

  it("boundary: token that exactly fits is included in current batch", () => {
    // Calculate exact limit where 2 tokens fit but 3 don't
    const id = "tok";
    const overhead = 1 + "clob_token_ids".length + 1; // "&clob_token_ids="
    const twoTokenUrl = base.length + 1 + 2 * (overhead + id.length);
    const batches = buildTokenIdBatches(base, [id, id, id], twoTokenUrl);
    expect(batches).toEqual([[id, id], [id]]);
  });
});
