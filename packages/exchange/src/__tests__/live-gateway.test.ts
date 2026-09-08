import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenId, type DepHealthRecorder, type DepKey } from "@krabs/domain";
import { decodeFunctionData, parseAbi } from "viem";
import { TokenMinimumAuthority } from "@krabs/domain";
import {
  OrderBuilder,
  type UserOrderV2,
  type CreateOrderOptions,
} from "@polymarket/clob-client-v2";
import type { PlaceOrderParams } from "@krabs/domain";
import {
  LiveExchangeGateway,
  SettlementNotSubmittedError,
  SettlementUnconfirmedError,
} from "../live/exchange-gateway.js";
import { LiveMarketDataGateway, buildTokenIdBatches } from "../live/market-data-gateway.js";
import { SharedMarketPricingStreamHub } from "../live/market-pricing-stream-hub.js";

const CTF_REDEEM_ABI = parseAbi([
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
]);
const NEG_RISK_REDEEM_ABI = parseAbi([
  "function redeemPositions(bytes32 _conditionId, uint256[] _amounts)",
]);

// ─── Mock ClobClient ─────────────────────────────────────────────────────

function createMockClient() {
  const getTrades = vi.fn();
  return {
    chainId: 137,
    createAndPostOrder: vi.fn(),
    createOrder: vi.fn().mockImplementation(async (order) => ({
      ...signedV2Order(),
      tokenId: order.tokenID,
      side: order.side,
      makerAmount: String(Math.round(order.size * 1e6)),
      takerAmount: String(Math.round(order.size * 1e6)),
    })),
    postOrder: vi.fn(),
    cancelOrder: vi.fn(),
    getOrder: vi.fn(),
    cancelAll: vi.fn(),
    getOpenOrders: vi.fn(),
    getTrades,
    getTradesPaginated: vi.fn(async (params: unknown): Promise<unknown> => {
      const trades = await getTrades(params);
      return {
        trades,
        next_cursor: "LTE=",
        limit: Array.isArray(trades) ? trades.length : 0,
        count: Array.isArray(trades) ? trades.length : 0,
      };
    }),
    getBalanceAllowance: vi.fn(),
    getOk: vi.fn(),
    getMarkets: vi.fn(),
    getMarket: vi.fn(),
    getOrderBook: vi.fn().mockResolvedValue({ min_order_size: "5" }),
    getTickSize: vi.fn(),
    getClobMarketInfo: vi.fn(),
  };
}

function signedV2Order() {
  return {
    salt: "123456789",
    maker: "0x1111111111111111111111111111111111111111",
    signer: "0x2222222222222222222222222222222222222222",
    tokenId: "9876543210123456789",
    makerAmount: "5000000",
    takerAmount: "10000000",
    side: "BUY",
    signatureType: 1,
    timestamp: "1700000000000",
    metadata: `0x${"00".repeat(32)}`,
    builder: `0x${"ab".repeat(32)}`,
    expiration: "0",
    signature: "0xsignature",
  };
}

function createLiveGateway(config: ConstructorParameters<typeof LiveExchangeGateway>[0]) {
  const gateway = new LiveExchangeGateway(config);
  const marketData = new LiveMarketDataGateway({ client: config.client });
  const source = new TokenMinimumAuthority(
    async (tokenId) => {
      await marketData.getOrderBook(createTokenId(tokenId));
      return true;
    },
    () => {},
  );
  marketData.setTokenMinimumAuthority(source);
  gateway.setTokenMinimumSource(source);
  return gateway;
}

function minimumSdkFixture() {
  const builder = new OrderBuilder(
    {
      getAddress: async () => "0x1111111111111111111111111111111111111111",
      _signTypedData: async () => `0x${"11".repeat(65)}`,
    },
    137,
  );
  const client = {
    chainId: 137,
    createOrder: vi.fn((order: UserOrderV2, options: CreateOrderOptions) =>
      builder.buildOrder(order, options, 2),
    ),
    postOrder: vi.fn().mockResolvedValue({ orderID: "accepted-minimum" }),
    getOrderBook: vi.fn().mockResolvedValue({ min_order_size: "5" }),
  };
  const gateway = createLiveGateway({ client });
  const marketData = new LiveMarketDataGateway({ client });
  const changed = vi.fn();
  const source = new TokenMinimumAuthority(async (id) => {
    await marketData.getOrderBook(createTokenId(id));
    return true;
  }, changed);
  gateway.setTokenMinimumSource(source);
  marketData.setTokenMinimumAuthority(source);
  const params: PlaceOrderParams = {
    clientOrderId: "minimum-contract",
    tokenId: createTokenId(
      "25440768084173492596124660289664772112753850137373593713699019611407231160558",
    ),
    side: "sell",
    size: 6.504000000000005,
    price: 0.018,
    orderType: "GTC",
    postOnly: true,
    tickSize: 0.001,
    negRisk: false,
  };
  return { client, gateway, marketData, source, changed, params };
}

describe("attempt minimum contract at the SDK boundary", () => {
  it.each([
    "valid",
    "omitted",
    "conflicting-alias",
    "duplicate",
    "missing-minimum",
    "unexpected",
    "failure",
  ])("ingests each batch completion once and blocks unusable %s metadata", async (outcome) => {
    const f = minimumSdkFixture();
    const prepared = await f.gateway.prepareOrder(f.params);
    f.changed.mockClear();
    const raw = { asset_id: String(f.params.tokenId), min_order_size: "5" };
    const books =
      outcome === "omitted"
        ? []
        : outcome === "conflicting-alias"
          ? [{ ...raw, token_id: "other" }]
          : outcome === "duplicate"
            ? [raw, { ...raw, min_order_size: "7" }, raw]
            : outcome === "missing-minimum"
              ? [{ asset_id: raw.asset_id }]
              : outcome === "unexpected"
                ? [{ ...raw, asset_id: "other" }]
                : [raw];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(books), { status: outcome === "failure" ? 400 : 200 }),
      ),
    );
    const completion = vi.spyOn(f.source, "complete");
    if (outcome === "failure")
      await expect(f.marketData.getOrderBooks([raw.asset_id])).rejects.toThrow();
    else await f.marketData.getOrderBooks([raw.asset_id]);
    expect(completion).toHaveBeenCalledOnce();
    expect(f.source.read(raw.asset_id).remembered).toBe(5);
    expect(f.source.read(raw.asset_id).latest?.minimum).toBe(outcome === "valid" ? 5 : null);
    expect(f.source.read("other").latest).toBeNull();
    expect(f.changed).toHaveBeenCalledTimes(outcome === "valid" ? 0 : 1);
    expect((await f.gateway.submitPreparedOrder(prepared)).kind).toBe(
      outcome === "valid" ? "accepted" : "local-minimum",
    );
    expect(f.client.postOrder).toHaveBeenCalledTimes(outcome === "valid" ? 1 : 0);
  });

  it.each([
    "mismatch",
    "accepted",
    "timeout",
    "other-rejection",
    "refresh-failed",
    "minimum-increased",
  ])("bounds direct version recovery after %s", async (outcome) => {
    const f = minimumSdkFixture();
    const resolveVersion = vi.fn(async () => {
      if (outcome === "refresh-failed") throw new Error("version read failed");
      return 2;
    });
    Object.assign(f.client, { cachedVersion: 1, resolveVersion });
    f.client.postOrder.mockImplementationOnce(async () => {
      if (outcome === "timeout") throw new Error("timeout");
      if (outcome === "accepted") return { orderID: "first-accepted" };
      if (outcome === "minimum-increased")
        f.client.getOrderBook.mockResolvedValue({ min_order_size: "7" });
      return {
        status: 400,
        error: outcome === "other-rejection" ? "unrelated rejection" : "order_version_mismatch",
      };
    });
    const result = await f.gateway.placeOrder({ ...f.params, postOnly: false });
    expect(f.client.postOrder).toHaveBeenCalledTimes(outcome === "mismatch" ? 2 : 1);
    expect(f.client.createOrder).toHaveBeenCalledTimes(
      ["mismatch", "minimum-increased"].includes(outcome) ? 2 : 1,
    );
    expect(result.success).toBe(["mismatch", "accepted"].includes(outcome));
    if (["accepted", "timeout", "other-rejection"].includes(outcome))
      expect(resolveVersion).not.toHaveBeenCalled();
    if (outcome === "mismatch")
      expect(f.client.createOrder.mock.calls[1]).toEqual(f.client.createOrder.mock.calls[0]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["buy", "sell"] as const)(
    "uses SDK signed shares for %s while retaining logical size",
    async (side) => {
      const f = minimumSdkFixture();
      const params = { ...f.params, side };
      const prepared = await f.gateway.prepareOrder(params);
      expect(prepared.signedFacts).toMatchObject({
        shares: 6.5,
        logicalSize: 6.504000000000005,
        side,
      });
      expect(f.client.postOrder).not.toHaveBeenCalled();
      expect(await f.gateway.submitPreparedOrder(prepared)).toMatchObject({ kind: "accepted" });
      const signed = f.client.postOrder.mock.calls[0]![0];
      expect(signed[side === "buy" ? "takerAmount" : "makerAmount"]).toBe("6500000");
      expect(f.client.createOrder.mock.calls[0]![0].size).toBe(params.size);
    },
  );

  it.each(["buy", "sell"] as const)(
    "blocks %s when only logical shares meet the minimum",
    async (side) => {
      const f = minimumSdkFixture();
      f.client.getOrderBook.mockResolvedValue({ min_order_size: "6.502" });
      await expect(f.gateway.prepareOrder({ ...f.params, side })).rejects.toMatchObject({
        reason: "token-minimum-below",
      });
      expect(f.client.postOrder).not.toHaveBeenCalled();
      f.client.getOrderBook.mockResolvedValue({ min_order_size: "1" });
      expect(await f.gateway.placeOrder({ ...f.params, side, size: 1.22 })).toMatchObject({
        success: true,
      });
      expect(f.client.postOrder).toHaveBeenCalledOnce();
    },
  );

  it.each([5, 7, null])(
    "delayed preparation uses latest completed minimum %s without a TTL",
    async (minimum) => {
      vi.useFakeTimers();
      const f = minimumSdkFixture();
      const prepared = await f.gateway.prepareOrder(f.params);
      vi.advanceTimersByTime(60_000);
      if (minimum !== 5) {
        f.client.getOrderBook.mockResolvedValue(
          minimum === null ? {} : { min_order_size: String(minimum) },
        );
        await f.marketData.getOrderBook(f.params.tokenId);
      }
      const callback = vi.fn();
      const result = await f.gateway.submitPreparedOrder(prepared, callback);
      expect(result.kind).toBe(minimum === 5 ? "accepted" : "local-minimum");
      expect(f.client.postOrder).toHaveBeenCalledTimes(minimum === 5 ? 1 : 0);
      expect(callback).toHaveBeenCalledTimes(minimum === 5 ? 1 : 0);
    },
  );

  it("does not release an ambiguous identity after a later local minimum block", async () => {
    const f = minimumSdkFixture();
    const prepared = await f.gateway.prepareOrder(f.params);
    f.client.postOrder.mockRejectedValueOnce(new Error("timeout"));
    expect(await f.gateway.submitPreparedOrder(prepared)).toMatchObject({ kind: "unknown" });
    f.client.getOrderBook.mockResolvedValue({ min_order_size: "7" });
    expect(await f.gateway.submitPreparedOrder(prepared)).toMatchObject({
      kind: "local-minimum",
      neverPosted: false,
    });
    expect(f.client.postOrder).toHaveBeenCalledOnce();
    expect(f.client.createOrder).toHaveBeenCalledOnce();
  });

  it("uses a decrease and ignores an unfinished newer request", async () => {
    const f = minimumSdkFixture();
    const prepared = await f.gateway.prepareOrder(f.params);
    const token = String(f.params.tokenId);
    const decreased = f.source.begin([token]);
    f.source.complete(decreased, new Map([[token, 1]]));
    f.source.begin([token]);
    expect(await f.gateway.submitPreparedOrder(prepared)).toMatchObject({ kind: "accepted" });
    expect(f.client.postOrder).toHaveBeenCalledOnce();
  });

  it.each(["asset_id", "token_id"] as const)(
    "rejects mismatched raw %s before mapping",
    async (field) => {
      const f = minimumSdkFixture();
      f.client.getOrderBook.mockResolvedValue({ min_order_size: "5", [field]: "unexpected" });
      await expect(f.gateway.prepareOrder(f.params)).rejects.toMatchObject({
        reason: "token-minimum-unavailable",
      });
      expect(f.client.createOrder).not.toHaveBeenCalled();
      expect(f.client.postOrder).not.toHaveBeenCalled();
    },
  );

  it("orders same-millisecond completions by request sequence and remembers older valid knowledge", async () => {
    vi.useFakeTimers();
    const f = minimumSdkFixture();
    const token = String(f.params.tokenId);
    const old = f.source.begin([token]);
    const recent = f.source.begin([token]);
    f.source.complete(recent, new Map([[token, null]]));
    f.source.complete(old, new Map([[token, 5]]));
    expect(f.source.read(token)).toMatchObject({
      remembered: 5,
      latest: { sequence: recent.sequence, minimum: null },
    });
    f.client.getOrderBook.mockResolvedValue({});
    await expect(f.gateway.prepareOrder(f.params)).rejects.toMatchObject({
      reason: "token-minimum-unavailable",
    });
    expect(f.client.postOrder).not.toHaveBeenCalled();
  });

  it("stops before SDK invocation when the write-ahead callback fails", async () => {
    const f = minimumSdkFixture();
    const prepared = await f.gateway.prepareOrder(f.params);
    await expect(
      f.gateway.submitPreparedOrder(prepared, () => {
        throw new Error("sqlite write failed");
      }),
    ).rejects.toThrow("sqlite write failed");
    expect(f.client.postOrder).not.toHaveBeenCalled();
    f.client.getOrderBook.mockResolvedValue({ min_order_size: "7" });
    expect(await f.gateway.submitPreparedOrder(prepared)).toMatchObject({
      kind: "local-minimum",
      neverPosted: true,
    });
  });

  it("disposal revokes a prepared receipt and ignores late completions", async () => {
    const f = minimumSdkFixture();
    const prepared = await f.gateway.prepareOrder(f.params);
    const request = f.source.begin([String(f.params.tokenId)]);
    f.source.dispose();
    f.source.complete(request, new Map([[String(f.params.tokenId), 1]]));
    expect(await f.gateway.submitPreparedOrder(prepared)).toMatchObject({
      kind: "local-minimum",
      neverPosted: true,
    });
    expect(f.client.postOrder).not.toHaveBeenCalled();
  });
});

function createMockSettlementClient() {
  return {
    // `wait()` resolving to a mined receipt is the SHAPE PRODUCTION ACTUALLY RETURNS — the live
    // relayer response exposes it, and the runtime log shows 4/4 settlements confirming inside the
    // wait window with zero `redeem_pending_after_wait_error`. The previous bare `{}` modelled a
    // response production does not send, and since `mergePositions` now rejects on anything short of
    // a confirmed settlement, defaulting to that shape would make every merge test exercise the
    // failure path. Tests that WANT `submitted`/`pending` override `execute` themselves.
    execute: vi.fn().mockResolvedValue({ wait: vi.fn().mockResolvedValue({ state: "MINED" }) }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i += 1) await Promise.resolve();
}

class FakeMarketSocket {
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.({});
  }

  emitOpen(): void {
    this.onopen?.({});
  }

  emitJson(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  emitText(payload: string): void {
    this.onmessage?.({ data: payload });
  }
}

class DeferredCloseMarketSocket extends FakeMarketSocket {
  private readonly emitErrorOnClose: boolean;

  constructor(opts?: { emitErrorOnClose?: boolean }) {
    super();
    this.emitErrorOnClose = opts?.emitErrorOnClose ?? false;
  }

  override close(): void {
    if (this.emitErrorOnClose) {
      this.onerror?.({
        type: "error",
        error: new TypeError("socket closed"),
      });
    }
  }

  emitClose(): void {
    this.onclose?.({});
  }
}

describe("LiveExchangeGateway", () => {
  let client: ReturnType<typeof createMockClient>;
  let gw: LiveExchangeGateway;

  beforeEach(() => {
    client = createMockClient();
    gw = createLiveGateway({ client });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("placeOrder calls createAndPostOrder and returns success", async () => {
    client.postOrder.mockResolvedValue({ orderID: "live-ord-1" });

    const result = await gw.placeOrder({
      clientOrderId: "cloid-1",
      tokenId: createTokenId("9876543210123456789"),
      side: "buy",
      size: 100,
      price: 0.5,
      orderType: "GTC",
      tickSize: 0.01,
      negRisk: false,
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("live-ord-1");
    expect(client.postOrder).toHaveBeenCalledOnce();

    const [userOrder, options] = client.createOrder.mock.calls[0]!;
    expect(userOrder.tokenID).toBe("9876543210123456789");
    expect(userOrder.side).toBe("BUY");
    expect(options.tickSize).toBe("0.01");
    expect(options.negRisk).toBe(false);
  });

  it("placeOrder uses signed-order post path for post-only orders", async () => {
    const signedOrder = signedV2Order();
    client.createOrder.mockResolvedValue(signedOrder);
    client.postOrder.mockResolvedValue({ orderID: "live-ord-post-only" });

    const result = await gw.placeOrder({
      clientOrderId: "cloid-post-only",
      tokenId: createTokenId("9876543210123456789"),
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

  it("prepares once without posting, then posts the exact signed object", async () => {
    const signedOrder = signedV2Order();
    client.createOrder.mockResolvedValue(signedOrder);
    client.postOrder.mockResolvedValue({ orderID: "live-ord-prepared" });

    const prepared = await gw.prepareOrder({
      clientOrderId: "cloid-prepared",
      tokenId: createTokenId("9876543210123456789"),
      side: "buy",
      size: 100,
      price: 0.5,
      orderType: "GTC",
      tickSize: 0.01,
      negRisk: false,
    });

    expect(client.createOrder).toHaveBeenCalledOnce();
    expect(client.postOrder).not.toHaveBeenCalled();
    expect(prepared.orderId).toBe(
      "0xa2b09ce8441ecb0330c23b0622ccf7ffb3a9341b485f1748d08a983182c5a52d",
    );

    await expect(gw.submitPreparedOrder(prepared)).resolves.toEqual({
      kind: "accepted",
      orderId: "live-ord-prepared",
    });
    expect(client.postOrder).toHaveBeenCalledOnce();
    expect(client.postOrder).toHaveBeenCalledWith(signedOrder, "GTC", false);
  });

  it("classifies thrown and SDK-resolved business rejections, but preserves ambiguous outcomes", async () => {
    const prepare = async () => {
      client.createOrder.mockResolvedValue(signedV2Order());
      return gw.prepareOrder({
        clientOrderId: "cloid-prepared",
        tokenId: createTokenId("9876543210123456789"),
        side: "buy",
        size: 100,
        price: 0.5,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
      });
    };

    client.postOrder.mockRejectedValue(Object.assign(new Error("invalid price"), { status: 400 }));
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
      kind: "rejected",
      errorCode: "INVALID_PRICE",
    });

    client.postOrder.mockResolvedValue({ status: 422, error: "invalid price" });
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
      kind: "rejected",
      errorCode: "INVALID_PRICE",
    });

    client.postOrder.mockResolvedValue({ status: 503, error: " Trading Is Disabled " });
    const tradingDisabled = await gw.submitPreparedOrder(await prepare());
    expect(tradingDisabled).toMatchObject({
      kind: "rejected",
      errorCode: "UNKNOWN",
      errorMessage: "trading is disabled",
      errorDetails: {
        responseBody: { status: 503, error: " Trading Is Disabled " },
        retryAt: expect.any(Number),
      },
    });
    expect((tradingDisabled as any).errorDetails).not.toHaveProperty("synthetic");

    gw = createLiveGateway({ client });
    client.postOrder.mockResolvedValue({ status: 503, message: "trading is disabled" });
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
      kind: "rejected",
      errorCode: "UNKNOWN",
      errorMessage: "trading is disabled",
    });

    gw = createLiveGateway({ client });
    client.postOrder.mockRejectedValue(
      Object.assign(new Error("request timeout"), { status: 408 }),
    );
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
      kind: "unknown",
    });

    client.postOrder.mockResolvedValue({ status: 429, error: "rate limit" });
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
      kind: "unknown",
    });

    for (const response of [
      { status: "503", error: "trading is disabled" },
      { status: 503, error: "trading is disabled right now" },
      { status: 503, error: "service unavailable" },
    ]) {
      client.postOrder.mockResolvedValue(response);
      await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
        kind: "unknown",
      });
    }

    client.postOrder.mockRejectedValue(
      Object.assign(new Error("trading is disabled"), { status: 503 }),
    );
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
      kind: "unknown",
    });

    client.postOrder.mockResolvedValue({});
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
      kind: "unknown",
    });
  });

  it("admits exactly one SELL half-open probe while BUYs and concurrent SELLs stay synthetic", async () => {
    let nowMs = 1_000;
    gw = createLiveGateway({
      client,
      __now: () => nowMs,
      __tradingDisabledCooldownMs: 300_000,
    } as any);
    client.createOrder.mockImplementation(async (order) => ({
      ...signedV2Order(),
      side: order.side,
    }));
    const prepare = (side: "buy" | "sell") =>
      gw.prepareOrder({
        clientOrderId: `cloid-breaker-${side}-${nowMs}`,
        tokenId: createTokenId("9876543210123456789"),
        side,
        size: 10,
        price: 0.5,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
      });

    client.postOrder.mockResolvedValueOnce({ status: 503, error: " Trading Is Disabled " });
    const initial = await gw.submitPreparedOrder(await prepare("sell"));
    expect(initial).toMatchObject({
      kind: "rejected",
      errorMessage: "trading is disabled",
      errorDetails: {
        responseBody: { status: 503, error: " Trading Is Disabled " },
        retryAt: 301_000,
      },
    });
    expect((initial as any).errorDetails).not.toHaveProperty("synthetic");
    expect(client.postOrder).toHaveBeenCalledTimes(1);

    await expect(gw.submitPreparedOrder(await prepare("sell"))).resolves.toMatchObject({
      kind: "rejected",
      errorDetails: expect.objectContaining({
        synthetic: "trading-disabled-cooldown",
        retryAt: 301_000,
      }),
    });
    expect(client.postOrder).toHaveBeenCalledTimes(1);

    nowMs = 301_000;
    await expect(gw.submitPreparedOrder(await prepare("buy"))).resolves.toMatchObject({
      kind: "rejected",
      errorDetails: expect.objectContaining({ synthetic: "trading-disabled-cooldown" }),
    });
    expect(client.postOrder).toHaveBeenCalledTimes(1);

    const probe = deferred<unknown>();
    client.postOrder.mockImplementationOnce(() => probe.promise);
    const [sellOne, sellTwo] = await Promise.all([prepare("sell"), prepare("sell")]);
    const submissions = Promise.all([
      gw.submitPreparedOrder(sellOne),
      gw.submitPreparedOrder(sellTwo),
    ]);
    await flushMicrotasks();
    expect(client.postOrder).toHaveBeenCalledTimes(2);
    probe.resolve({ status: 503, message: "trading is disabled" });

    const results = await submissions;
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "rejected", errorMessage: "trading is disabled" }),
        expect.objectContaining({
          kind: "rejected",
          errorDetails: expect.objectContaining({ synthetic: "trading-disabled-cooldown" }),
        }),
      ]),
    );
    const actualProbeResult = results.find(
      (result) => (result as any).errorDetails?.synthetic === undefined,
    );
    expect(actualProbeResult).toMatchObject({
      kind: "rejected",
      errorDetails: {
        responseBody: { status: 503, message: "trading is disabled" },
        retryAt: 601_000,
      },
    });
    nowMs = 600_999;
    await gw.submitPreparedOrder(await prepare("sell"));
    expect(client.postOrder).toHaveBeenCalledTimes(2);
  });

  it("rearms an unknown half-open POST and closes the breaker on a definitive response", async () => {
    let nowMs = 10_000;
    gw = createLiveGateway({
      client,
      __now: () => nowMs,
      __tradingDisabledCooldownMs: 300_000,
    } as any);
    client.createOrder.mockImplementation(async (order) => ({
      ...signedV2Order(),
      side: order.side,
    }));
    const prepare = (side: "buy" | "sell" = "sell") =>
      gw.prepareOrder({
        clientOrderId: `cloid-breaker-${nowMs}`,
        tokenId: createTokenId("9876543210123456789"),
        side,
        size: 10,
        price: 0.5,
        orderType: "GTC",
        tickSize: 0.01,
        negRisk: false,
      });

    client.postOrder.mockResolvedValueOnce({ status: 503, error: "trading is disabled" });
    await gw.submitPreparedOrder(await prepare());

    nowMs = 310_000;
    client.postOrder.mockResolvedValueOnce({ status: 503, error: "service unavailable" });
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
      kind: "unknown",
    });
    expect(client.postOrder).toHaveBeenCalledTimes(2);

    nowMs = 609_999;
    await gw.submitPreparedOrder(await prepare());
    expect(client.postOrder).toHaveBeenCalledTimes(2);

    nowMs = 610_000;
    client.postOrder.mockResolvedValueOnce({ status: 422, error: "invalid price" });
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toMatchObject({
      kind: "rejected",
      errorCode: "INVALID_PRICE",
    });
    client.postOrder.mockResolvedValueOnce({ orderID: "accepted-after-close" });
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toEqual({
      kind: "accepted",
      orderId: "accepted-after-close",
    });
    expect(client.postOrder).toHaveBeenCalledTimes(4);

    client.postOrder.mockResolvedValueOnce({ status: 503, error: "trading is disabled" });
    await gw.submitPreparedOrder(await prepare());
    nowMs = 910_000;
    client.postOrder.mockResolvedValueOnce({ orderID: "accepted-half-open" });
    await expect(gw.submitPreparedOrder(await prepare())).resolves.toEqual({
      kind: "accepted",
      orderId: "accepted-half-open",
    });
    client.postOrder.mockResolvedValueOnce({ orderID: "buy-after-accepted-probe" });
    await expect(gw.submitPreparedOrder(await prepare("buy"))).resolves.toEqual({
      kind: "accepted",
      orderId: "buy-after-accepted-probe",
    });
    expect(client.postOrder).toHaveBeenCalledTimes(7);
  });

  it("placeOrder returns error result on SDK failure", async () => {
    client.postOrder.mockRejectedValue(new Error("Insufficient balance"));

    const result = await gw.placeOrder({
      clientOrderId: "cloid-1",
      tokenId: createTokenId("9876543210123456789"),
      side: "buy",
      size: 100,
      price: 0.5,
      orderType: "GTC",
      tickSize: 0.01,
      negRisk: false,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INSUFFICIENT_BALANCE");
    expect(result.errorDetails).toMatchObject({ name: "Error", message: "Insufficient balance" });
  });

  it("placeOrder rejects empty SDK success payload without order id", async () => {
    client.postOrder.mockResolvedValue({});

    const result = await gw.placeOrder({
      clientOrderId: "cloid-1",
      tokenId: createTokenId("9876543210123456789"),
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

  it("records the CLOB dep sample as ok=false when placeOrder returns no order id", async () => {
    const calls: { dep: DepKey; ok: boolean }[] = [];
    const recorder: DepHealthRecorder = {
      record: (dep, _latencyMs, ok) => calls.push({ dep, ok }),
    };
    const gwR = createLiveGateway({ client, depHealthRecorder: recorder });
    const params = {
      clientOrderId: "cloid-1",
      tokenId: createTokenId("9876543210123456789"),
      side: "buy" as const,
      size: 100,
      price: 0.5,
      orderType: "GTC" as const,
      tickSize: 0.01,
      negRisk: false,
    };

    // Resolved payload with no order id → failed placement → dep ok=false.
    client.postOrder.mockResolvedValue({});
    const bad = await gwR.placeOrder(params);
    expect(bad.success).toBe(false);
    expect(calls).toEqual([{ dep: "clob", ok: false }]);

    // A real order id → success → dep ok=true.
    calls.length = 0;
    client.postOrder.mockResolvedValue({ orderID: "ord-ok" });
    const good = await gwR.placeOrder(params);
    expect(good.success).toBe(true);
    expect(calls).toEqual([{ dep: "clob", ok: true }]);
  });

  it("cancelOrder accepts only an ACK that names the requested order", async () => {
    client.cancelOrder.mockResolvedValue({ canceled: ["ord-1"], not_canceled: [] });

    const result = await gw.cancelOrder({ orderId: "ord-1" });
    expect(result.success).toBe(true);
    expect(client.cancelOrder).toHaveBeenCalledWith({ orderID: "ord-1" });
  });

  it("cancelOrder treats empty or ambiguous responses as no acknowledgement", async () => {
    client.cancelOrder.mockResolvedValue({ canceled: [], not_canceled: ["ord-1"] });
    expect((await gw.cancelOrder({ orderId: "ord-1" })).success).toBe(false);
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
        asset_id: "9876543210123456789",
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
        asset_id: "9876543210123456789",
        side: "BUY",
        size: "50",
        price: "0.55",
        fee_rate_bps: "100",
        status: "CONFIRMED",
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

  it("getFills refreshes authentication by fetching each trade page separately", async () => {
    const trade = (id: string) => ({
      id,
      taker_order_id: `ord-${id}`,
      asset_id: "9876543210123456789",
      side: "BUY",
      size: "1",
      price: "0.5",
      status: "CONFIRMED",
      match_time: "2026-01-15T12:00:00Z",
    });
    client.getTradesPaginated
      .mockResolvedValueOnce({
        trades: [trade("trade-page-1")],
        next_cursor: "page-2",
        limit: 1,
        count: 1,
      })
      .mockResolvedValueOnce({
        trades: [trade("trade-page-2")],
        next_cursor: "LTE=",
        limit: 1,
        count: 1,
      });

    const result = await gw.getFillsResult(0);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.data.map((fill) => fill.fillId)).toEqual(["trade-page-1", "trade-page-2"]);
    }
    expect(client.getTradesPaginated).toHaveBeenNthCalledWith(1, { after: "0" }, "MA==");
    expect(client.getTradesPaginated).toHaveBeenNthCalledWith(2, { after: "0" }, "page-2");
    expect(client.getTrades).not.toHaveBeenCalled();
  });

  it("fails closed when paginated trades omit or repeat a cursor", async () => {
    client.getTradesPaginated.mockResolvedValueOnce({
      trades: [],
      limit: 0,
      count: 0,
    });
    await expect(gw.getFillsResult(0)).resolves.toMatchObject({
      ok: false,
      reason: "parse",
      attempts: 1,
    });

    client.getTradesPaginated
      .mockResolvedValueOnce({ trades: [], next_cursor: "page-2", limit: 0, count: 0 })
      .mockResolvedValueOnce({ trades: [], next_cursor: "MA==", limit: 0, count: 0 });
    await expect(gw.getFillsResult(0)).resolves.toMatchObject({
      ok: false,
      reason: "parse",
      attempts: 1,
    });

    client.getTradesPaginated.mockResolvedValueOnce({
      trades: [],
      next_cursor: "LTE=",
      limit: 1,
      count: 1,
    });
    await expect(gw.getFillsResult(0)).resolves.toMatchObject({
      ok: false,
      reason: "parse",
      attempts: 1,
    });
  });

  it("imports only final successful trades and excludes reproduced FAILED maker fills", async () => {
    gw = createLiveGateway({ client, traderAddress: "0xours" });
    const makerTrade = (id: string, status: string, size: string) => ({
      id,
      taker_order_id: "ord-foreign",
      asset_id: "tok-opposite",
      side: "BUY",
      size,
      price: "0.988",
      status,
      match_time: "2026-08-22T12:55:01Z",
      trader_side: "MAKER",
      maker_orders: [
        {
          order_id: "ord-ours",
          maker_address: "0xours",
          asset_id: "tok-ours",
          side: "BUY",
          matched_amount: size,
          price: "0.012",
        },
      ],
    });
    client.getTrades.mockResolvedValue([
      makerTrade("failed-1", "FAILED", "10.121416"),
      makerTrade("failed-2", "TRADE_STATUS_FAILED", "10.020166"),
      makerTrade("confirmed", "CONFIRMED", "5"),
      makerTrade("confirmed-prefixed", "TRADE_STATUS_CONFIRMED", "6"),
    ]);

    const result = await gw.getFillsResult(0);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.data.map((fill) => [fill.fillId, fill.size])).toEqual([
        ["confirmed#maker:0", 5],
        ["confirmed-prefixed#maker:0", 6],
      ]);
    }
  });

  it.each(["MATCHED", "MINED", "RETRYING"])(
    "holds the REST cursor until a %s trade becomes CONFIRMED",
    async (pendingStatus) => {
      gw = createLiveGateway({ client, traderAddress: "0xours" });
      const trade = (status: string) => ({
        id: "trade-late-finality",
        taker_order_id: "ord-ours",
        asset_id: "tok-ours",
        side: "BUY",
        size: "5",
        price: "0.2",
        status,
        match_time: "2026-08-24T01:00:00Z",
        maker_address: "0xours",
        trader_side: "TAKER",
      });
      client.getTrades
        .mockResolvedValueOnce([trade(pendingStatus)])
        .mockResolvedValueOnce([trade("CONFIRMED")]);

      await expect(gw.getFillsResult(0)).resolves.toMatchObject({ ok: false, reason: "parse" });
      const confirmed = await gw.getFillsResult(0);

      expect(confirmed).toMatchObject({ ok: true });
      if (confirmed.ok) {
        expect(confirmed.data.map((fill) => fill.fillId)).toEqual(["trade-late-finality"]);
      }
    },
  );

  it("fails a reliable fill snapshot for an unknown trade status", async () => {
    client.getTrades.mockResolvedValue([
      {
        id: "trade-unknown",
        taker_order_id: "ord-1",
        asset_id: "9876543210123456789",
        side: "BUY",
        size: "1",
        price: "0.5",
        status: "SETTLED_SOMEDAY",
        match_time: "2026-08-22T12:55:01Z",
      },
    ]);

    await expect(gw.getFillsResult(0)).resolves.toMatchObject({ ok: false, reason: "parse" });
  });

  it("fails the reliable open snapshot when any required row field is malformed", async () => {
    client.getOpenOrders.mockResolvedValue([
      {
        id: "ord-1",
        asset_id: "",
        side: "BUY",
        original_size: "5",
        size_matched: "0",
        price: "0.5",
        status: "LIVE",
        created_at: Date.now(),
      },
    ]);
    await expect(gw.getOpenOrdersResult()).resolves.toMatchObject({ ok: false, reason: "parse" });
  });

  it("fails the reliable fill snapshot when any required row field is malformed", async () => {
    client.getTrades.mockResolvedValue([
      {
        id: "trade-1",
        taker_order_id: "ord-1",
        asset_id: "9876543210123456789",
        side: "SELL",
        size: "0",
        price: "0.5",
        status: "CONFIRMED",
        match_time: "2026-01-15T12:00:00Z",
      },
    ]);
    await expect(gw.getFillsResult(0)).resolves.toMatchObject({ ok: false, reason: "parse" });
  });

  it("getFills extracts only personal legs when traderAddress is configured", async () => {
    gw = createLiveGateway({ client, traderAddress: "0xours" });
    client.getTrades.mockResolvedValue([
      {
        id: "trade-maker",
        taker_order_id: "ord-foreign",
        asset_id: "tok-foreign-no",
        side: "BUY",
        size: "334.37",
        price: "0.90",
        fee_rate_bps: "1000",
        status: "CONFIRMED",
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
        status: "CONFIRMED",
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

  it.each([
    { trader_side: "UNKNOWN", maker_orders: [] },
    { trader_side: "MAKER" },
    { trader_side: "MAKER", maker_orders: "malformed" },
    {
      trader_side: "MAKER",
      maker_orders: [
        {
          order_id: "foreign-order",
          maker_address: "0xforeign",
          asset_id: "9876543210123456789",
          side: "SELL",
          matched_amount: "1",
          price: "0.5",
        },
      ],
    },
  ])("fails authenticated fill snapshots for ambiguous personal rows %#", async (shape) => {
    gw = createLiveGateway({ client, traderAddress: "0xours" });
    client.getTrades.mockResolvedValue([
      {
        id: "trade-ambiguous",
        taker_order_id: "ord-1",
        asset_id: "9876543210123456789",
        side: "SELL",
        size: "1",
        price: "0.5",
        status: "CONFIRMED",
        match_time: "2026-04-05T00:00:00Z",
        maker_address: "0xforeign",
        ...shape,
      },
    ]);
    await expect(gw.getFillsResult(0)).resolves.toMatchObject({ ok: false, reason: "parse" });
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
    const orders = await gw.getOpenOrdersForToken(createTokenId("9876543210123456789"));
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
    const balance = await gw.getPositionBalance(createTokenId("9876543210123456789"));
    expect(balance).toBe(42);
    expect(client.getBalanceAllowance).toHaveBeenCalledWith({
      asset_type: "CONDITIONAL",
      token_id: "9876543210123456789",
    });
  });

  it("getPositionBalance throws on SDK failure instead of returning 0", async () => {
    client.getBalanceAllowance.mockRejectedValue(new Error("Network error"));
    await expect(gw.getPositionBalance(createTokenId("9876543210123456789"))).rejects.toThrow(
      "Network error",
    );
  });

  it("createUserEventStream requires websocket auth", () => {
    expect(() =>
      gw.createUserEventStream?.({
        onTradeEvents: vi.fn(),
        onOrderEvents: vi.fn(),
      }),
    ).toThrow("user websocket auth is not configured");
  });

  it("redeemPositions warns once and no-ops when the SDK has no redeem API", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    await expect(gw.redeemPositions(["cond-1", "cond-2"])).resolves.toMatchObject({
      status: "skipped",
      conditionIds: ["cond-1", "cond-2"],
      txHash: null,
      gasUsed: null,
    });
    await expect(gw.redeemPositions(["cond-3"])).resolves.toMatchObject({
      status: "skipped",
      conditionIds: ["cond-3"],
    });

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("redeemPositions skipped"),
      expect.objectContaining({ code: "KRABS_REDEEM_UNSUPPORTED" }),
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
    gw = createLiveGateway({ client, settlementClient });

    await gw.redeemPositions([
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    ]);

    expect(settlementClient.execute).toHaveBeenCalledTimes(1);
    const [txs, metadata] = settlementClient.execute.mock.calls[0]!;
    expect(metadata).toBe("redeem");
    expect(txs).toHaveLength(1);
    expect(txs[0]!.to).toBe("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045");
    expect(txs[0]!.value).toBe("0");
    expect(txs[0]!.data).toContain("0x");
  });

  it("redeemPositions encodes resolver-returned collateral for CTF redeem", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "1000000" })
      .mockResolvedValueOnce({ balance: "0" });
    const usdcLegacy = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
    const collateralResolver = vi.fn().mockResolvedValue(usdcLegacy);
    gw = createLiveGateway({ client, settlementClient, collateralResolver });

    const conditionId = "0x1414141414141414141414141414141414141414141414141414141414141414";
    await gw.redeemPositions([conditionId]);

    expect(collateralResolver).toHaveBeenCalledTimes(1);
    expect(collateralResolver).toHaveBeenCalledWith({
      conditionId,
      canonicalTokenId: "tok-yes",
      indexSet: 1n,
    });
    const [txs] = settlementClient.execute.mock.calls[0]!;
    const decoded = decodeFunctionData({ abi: CTF_REDEEM_ABI, data: txs[0]!.data });
    expect(decoded.functionName).toBe("redeemPositions");
    expect((decoded.args[0] as string).toLowerCase()).toBe(usdcLegacy.toLowerCase());
    expect(decoded.args[2]).toBe(conditionId);
  });

  it("redeemPositions throws when configured resolver returns null (no candidate matched)", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "1000000" })
      .mockResolvedValueOnce({ balance: "0" });
    const collateralResolver = vi.fn().mockResolvedValue(null);
    gw = createLiveGateway({ client, settlementClient, collateralResolver });

    const conditionId = "0x1515151515151515151515151515151515151515151515151515151515151515";
    // Throw rather than silently skip — the upstream redeem-sweep caller
    // applies the aggregate result to every reserved group, so silently
    // dropping one condition would falsely mark its local position as
    // confirmed/closed.
    await expect(gw.redeemPositions([conditionId])).rejects.toThrow(
      /collateral token \(USDC vs pUSD\)/,
    );
    expect(settlementClient.execute).not.toHaveBeenCalled();
  });

  it("redeemPositions throws when configured resolver itself throws", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "1000000" })
      .mockResolvedValueOnce({ balance: "0" });
    const collateralResolver = vi.fn().mockRejectedValue(new Error("rpc timeout"));
    gw = createLiveGateway({ client, settlementClient, collateralResolver });

    const conditionId = "0x1616161616161616161616161616161616161616161616161616161616161616";
    await expect(gw.redeemPositions([conditionId])).rejects.toThrow(
      /collateral token \(USDC vs pUSD\)/,
    );
    expect(settlementClient.execute).not.toHaveBeenCalled();
  });

  it("redeemPositions raises POLYGON_RPC_RATE_LIMITED when resolver hits a 429", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "1000000" })
      .mockResolvedValueOnce({ balance: "0" });
    const onInfraAlert = vi.fn();
    const collateralResolver = vi
      .fn()
      .mockRejectedValue(new Error("RPC HTTP 429: Too Many Requests"));
    gw = createLiveGateway({ client, settlementClient, collateralResolver, onInfraAlert });

    const conditionId = "0x1717171717171717171717171717171717171717171717171717171717171717";
    // Throws and also surfaces the rate-limit signal via onInfraAlert + bubbles
    // the cause text in error.message so redeem-sweep's isRpcRateLimitError
    // regex still triggers the hard-pause path.
    await expect(gw.redeemPositions([conditionId])).rejects.toThrow(/429/);
    expect(onInfraAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "POLYGON_RPC_RATE_LIMITED",
        source: "polygon-rpc",
      }),
    );
    expect(settlementClient.execute).not.toHaveBeenCalled();
  });

  it("redeemPositions targets only requested CTF outcome tokens", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance.mockResolvedValueOnce({ balance: "25000000" });
    gw = createLiveGateway({ client, settlementClient });

    const conditionId = "0x1212121212121212121212121212121212121212121212121212121212121212";
    await gw.redeemPositions([conditionId], {
      redeemTokenIdsByCondition: { [conditionId]: [createTokenId("tok-no")] },
    });

    expect(client.getBalanceAllowance).toHaveBeenCalledTimes(1);
    expect(client.getBalanceAllowance).toHaveBeenCalledWith({
      asset_type: "CONDITIONAL",
      token_id: "tok-no",
    });

    const [txs] = settlementClient.execute.mock.calls[0]!;
    const decoded = decodeFunctionData({
      abi: CTF_REDEEM_ABI,
      data: txs[0]!.data,
    });
    expect(decoded.functionName).toBe("redeemPositions");
    expect(decoded.args[3]).toEqual([2n]);
  });

  it("redeemPositions preserves original token indexes when malformed market tokens are filtered", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{}, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance.mockResolvedValueOnce({ balance: "25000000" });
    gw = createLiveGateway({ client, settlementClient });

    const conditionId = "0x1313131313131313131313131313131313131313131313131313131313131313";
    await gw.redeemPositions([conditionId], {
      redeemTokenIdsByCondition: { [conditionId]: [createTokenId("tok-no")] },
    });

    const [txs] = settlementClient.execute.mock.calls[0]!;
    const decoded = decodeFunctionData({
      abi: CTF_REDEEM_ABI,
      data: txs[0]!.data,
    });
    expect(decoded.args[3]).toEqual([2n]);
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
    gw = createLiveGateway({ client, settlementClient });

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

  it("redeemPositions zeroes unrequested neg-risk outcome amounts", async () => {
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: true,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance.mockResolvedValueOnce({ balance: "31000000" });
    gw = createLiveGateway({ client, settlementClient });

    const conditionId = "0x3434343434343434343434343434343434343434343434343434343434343434";
    await gw.redeemPositions([conditionId], {
      redeemTokenIdsByCondition: { [conditionId]: [createTokenId("tok-no")] },
    });

    expect(client.getBalanceAllowance).toHaveBeenCalledTimes(1);
    expect(client.getBalanceAllowance).toHaveBeenCalledWith({
      asset_type: "CONDITIONAL",
      token_id: "tok-no",
    });

    const [txs] = settlementClient.execute.mock.calls[0]!;
    const decoded = decodeFunctionData({
      abi: NEG_RISK_REDEEM_ABI,
      data: txs[0]!.data,
    });
    expect(decoded.functionName).toBe("redeemPositions");
    expect(decoded.args[1]).toEqual([0n, 31_000_000n]);
  });

  it("redeemPositions uses a constant slug as relayer metadata for batched submissions", async () => {
    // Regression: Polymarket relayer rejects free-form metadata (e.g.
    // "redeem positions: 0xabc,0xdef...") with 400 `invalid metadata field`.
    // Submission must use a short alphanumeric slug regardless of batch size.
    const settlementClient = createMockSettlementClient();
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }, { token_id: "tok-no" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "1000000" })
      .mockResolvedValueOnce({ balance: "0" })
      .mockResolvedValueOnce({ balance: "2000000" })
      .mockResolvedValueOnce({ balance: "0" });
    gw = createLiveGateway({ client, settlementClient });

    await gw.redeemPositions([
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    ]);

    expect(settlementClient.execute).toHaveBeenCalledTimes(1);
    const [, metadata] = settlementClient.execute.mock.calls[0]!;
    expect(metadata).toBe("redeem");
    expect(metadata).not.toMatch(/0x[0-9a-f]+/i);
    expect(metadata).not.toMatch(/[:\s,]/);
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
    gw = createLiveGateway({ client, settlementClient });

    await expect(
      gw.redeemPositions(["0x3333333333333333333333333333333333333333333333333333333333333333"]),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: "no_redeem_requests",
    });

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
    gw = createLiveGateway({ client, settlementClient });

    const conditionId = "0x6666666666666666666666666666666666666666666666666666666666666666";
    await gw.redeemPositions([conditionId]);

    expect(gw.__hasPendingRedeemSubmission(conditionId)).toBe(true);
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
    gw = createLiveGateway({ client, settlementClient });

    const conditionId = "0x7777777777777777777777777777777777777777777777777777777777777777";
    const result = await gw.redeemPositions([conditionId]);
    await Promise.resolve();
    await Promise.resolve();

    expect(result).toMatchObject({ status: "confirmed", conditionIds: [conditionId] });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(gw.__hasPendingRedeemSubmission(conditionId)).toBe(false);
  });

  it("redeemPositions returns tx metadata from submit and wait responses", async () => {
    const wait = vi.fn().mockResolvedValue({
      receipt: { transactionHash: "0xwait", gasUsed: "12345" },
    });
    const settlementClient = {
      execute: vi.fn().mockResolvedValue({ txHash: "0xsubmit", wait }),
    };
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }],
    });
    client.getBalanceAllowance.mockResolvedValueOnce({ balance: "1000000" });
    gw = createLiveGateway({ client, settlementClient });

    const conditionId = "0x7878787878787878787878787878787878787878787878787878787878787878";
    await expect(gw.redeemPositions([conditionId])).resolves.toMatchObject({
      status: "confirmed",
      conditionIds: [conditionId],
      txHash: "0xwait",
      gasUsed: 12345,
    });
  });

  it("redeemPositions accepts an empty wait result when postcheck balances are already zero", async () => {
    const wait = vi.fn().mockResolvedValue(null);
    const settlementClient = {
      execute: vi.fn().mockResolvedValue({ wait }),
    };
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "1000000" })
      .mockResolvedValueOnce({ balance: "0" });
    gw = createLiveGateway({ client, settlementClient });

    const conditionId = "0x8888888888888888888888888888888888888888888888888888888888888888";
    await expect(gw.redeemPositions([conditionId])).resolves.toMatchObject({
      status: "confirmed",
      conditionIds: [conditionId],
    });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(gw.__hasPendingRedeemSubmission(conditionId)).toBe(false);
  });

  it("redeemPositions clears pending state when wait result is empty and balances remain non-zero", async () => {
    const wait = vi.fn().mockResolvedValue(null);
    const settlementClient = {
      execute: vi.fn().mockResolvedValue({ wait }),
    };
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "1000000" })
      .mockResolvedValueOnce({ balance: "1000000" });
    gw = createLiveGateway({ client, settlementClient });

    const conditionId = "0x9999999999999999999999999999999999999999999999999999999999999999";
    await expect(gw.redeemPositions([conditionId])).rejects.toThrow(
      "Settlement transaction reached failed state before balances cleared",
    );

    expect(wait).toHaveBeenCalledTimes(1);
    expect(gw.__hasPendingRedeemSubmission(conditionId)).toBe(false);
  });

  it("redeemPositions keeps pending state when confirmation check errors after submit", async () => {
    const wait = vi.fn().mockRejectedValue(new Error("relayer poll timeout"));
    const settlementClient = {
      execute: vi.fn().mockResolvedValue({ wait }),
    };
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }],
    });
    client.getBalanceAllowance
      .mockResolvedValueOnce({ balance: "1000000" })
      .mockResolvedValueOnce({ balance: "1000000" });
    gw = createLiveGateway({ client, settlementClient });

    const conditionId = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await expect(gw.redeemPositions([conditionId])).resolves.toMatchObject({
      status: "pending",
      conditionIds: [conditionId],
    });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(gw.__hasPendingRedeemSubmission(conditionId)).toBe(true);
  });

  it("redeemPositions serializes concurrent relayer submissions until confirmation releases the lane", async () => {
    const firstWait = deferred<unknown>();
    const settlementClient = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ wait: vi.fn(() => firstWait.promise) })
        .mockResolvedValueOnce({ wait: vi.fn().mockResolvedValue({ state: "MINED" }) }),
    };
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [{ token_id: "tok-yes" }],
    });
    client.getBalanceAllowance.mockResolvedValue({ balance: "1000000" });
    gw = createLiveGateway({ client, settlementClient });

    const first = gw.redeemPositions([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]);
    await vi.waitFor(() => expect(settlementClient.execute).toHaveBeenCalledTimes(1));

    const second = gw.redeemPositions([
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(settlementClient.execute).toHaveBeenCalledTimes(1);

    firstWait.resolve({ state: "MINED" });
    await expect(first).resolves.toMatchObject({ status: "confirmed" });
    await Promise.resolve();
    await Promise.resolve();

    expect(settlementClient.execute).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toMatchObject({ status: "confirmed" });
  });

  it("redeemPositions rechecks recent submissions after queued same-condition calls", async () => {
    vi.useFakeTimers();
    try {
      const settlementClient = {
        execute: vi.fn().mockResolvedValue({ txHash: "0xsubmitted" }),
      };
      client.getMarket.mockResolvedValue({
        condition_id: "0xcond",
        neg_risk: false,
        tokens: [{ token_id: "tok-yes" }],
      });
      client.getBalanceAllowance.mockResolvedValue({ balance: "1000000" });
      gw = createLiveGateway({
        client,
        settlementClient,
        __settlementLaneBackstopMs: 1_000,
      });

      const conditionId = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
      await expect(gw.redeemPositions([conditionId])).resolves.toMatchObject({
        status: "submitted",
      });
      expect(settlementClient.execute).toHaveBeenCalledTimes(1);
      expect(gw.__hasPendingRedeemSubmission(conditionId)).toBe(true);

      const second = gw.redeemPositions([conditionId]);
      await Promise.resolve();
      expect(settlementClient.execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(second).resolves.toMatchObject({
        status: "skipped",
        reason: "no_redeem_requests",
      });
      expect(settlementClient.execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redeemPositions releases the settlement lane when the submit task watchdog expires", async () => {
    vi.useFakeTimers();
    try {
      const settlementClient = {
        execute: vi
          .fn()
          .mockReturnValueOnce(new Promise<unknown>(() => {}))
          .mockResolvedValueOnce({ wait: vi.fn().mockResolvedValue({ state: "MINED" }) }),
      };
      client.getMarket.mockResolvedValue({
        condition_id: "0xcond",
        neg_risk: false,
        tokens: [{ token_id: "tok-yes" }],
      });
      client.getBalanceAllowance.mockResolvedValue({ balance: "1000000" });
      gw = createLiveGateway({
        client,
        settlementClient,
        __settlementLaneTaskTimeoutMs: 1_000,
      });

      const first = gw.redeemPositions([
        "0xcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcfcf",
      ]);
      await flushMicrotasks();
      expect(settlementClient.execute).toHaveBeenCalledTimes(1);

      const second = gw.redeemPositions([
        "0xdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdfdf",
      ]);
      await flushMicrotasks();
      expect(settlementClient.execute).toHaveBeenCalledTimes(1);

      const firstRejected = expect(first).rejects.toThrow(
        "Settlement submit lane redeem task timed out after 1000ms",
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await firstRejected;

      await flushMicrotasks();
      expect(settlementClient.execute).toHaveBeenCalledTimes(2);
      await expect(second).resolves.toMatchObject({ status: "confirmed" });
    } finally {
      vi.useRealTimers();
    }
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
    gw = createLiveGateway({ client, settlementClient, onInfraAlert });

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
    gw = createLiveGateway({ client, settlementClient, onInfraAlert });

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
    gw = createLiveGateway({ client, settlementClient });

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
    expect(label).toBe("merge");
    expect(txs).toHaveLength(1);
    // Verify encoded data roughly contains the amount (10 tokens -> 10 * 10^6 = 10000000)
    // 10000000 decimal is 0x989680 hex.
    expect(txs[0].data).toContain("989680");
  });

  it("mergePositions shares the relayer submit lane with redeemPositions", async () => {
    const firstWait = deferred<unknown>();
    const settlementClient = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ wait: vi.fn(() => firstWait.promise) })
        .mockResolvedValueOnce({ wait: vi.fn().mockResolvedValue({ state: "MINED" }) }),
    };
    gw = createLiveGateway({ client, settlementClient });
    client.getMarket.mockResolvedValue({
      condition_id: "0xcond",
      neg_risk: false,
      tokens: [
        { outcome: "Yes", token_id: "tok-yes" },
        { outcome: "No", token_id: "tok-no" },
      ],
    });
    client.getBalanceAllowance.mockResolvedValue({ balance: "1000000" });

    const redeem = gw.redeemPositions([
      "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    ]);
    await vi.waitFor(() => expect(settlementClient.execute).toHaveBeenCalledTimes(1));

    const merge = gw.mergePositions([
      {
        conditionId: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        amount: 10,
      },
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(settlementClient.execute).toHaveBeenCalledTimes(1);

    firstWait.resolve({ state: "MINED" });
    await expect(redeem).resolves.toMatchObject({ status: "confirmed" });
    await merge;
    expect(settlementClient.execute).toHaveBeenCalledTimes(2);
  });

  it("mergePositions uses a constant slug as relayer metadata for batched submissions", async () => {
    // Regression: same relayer validation as redeemPositions; metadata must be
    // a short alphanumeric slug, not a free-form string with conditionIds.
    const settlementClient = createMockSettlementClient();
    gw = createLiveGateway({ client, settlementClient });

    client.getMarket.mockResolvedValue({
      tokens: [
        { outcome: "Yes", token_id: "tok-yes" },
        { outcome: "No", token_id: "tok-no" },
      ],
    });

    await gw.mergePositions([
      {
        conditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
        amount: 5,
      },
      {
        conditionId: "0x2222222222222222222222222222222222222222222222222222222222222222",
        amount: 7,
      },
    ]);

    expect(settlementClient.execute).toHaveBeenCalledTimes(1);
    const [, metadata] = settlementClient.execute.mock.calls[0] as [unknown, string];
    expect(metadata).toBe("merge");
    expect(metadata).not.toMatch(/0x[0-9a-f]+/i);
    expect(metadata).not.toMatch(/[:\s,]/);
  });

  it("mergePositions rejects, submitting nothing, when one condition's request cannot be built", async () => {
    // Regression: the relayer path resolved on a SHORT request list. `buildMergeRequests` drops a
    // condition whose market has no token ids (and any other non-collateral build failure), and
    // `mergePositions` returns void, so the caller could not tell — it marked every write-ahead row
    // 'onchain', consumed the local YES/NO lots and settled the rows to 'applied'. Terminal, and the
    // startup divergence report only surfaces non-terminal rows, so the merge that never hit chain
    // was invisible forever. Same defect class as the no-merge-API case below, on the path live-lite
    // actually uses.
    const settlementClient = createMockSettlementClient();
    gw = createLiveGateway({ client, settlementClient });

    client.getMarket
      .mockResolvedValueOnce({
        tokens: [
          { outcome: "Yes", token_id: "tok-yes" },
          { outcome: "No", token_id: "tok-no" },
        ],
      })
      // Malformed market: no tokens -> buildMergeRequest returns null -> the condition is dropped.
      .mockResolvedValueOnce({ tokens: [] });

    await expect(
      gw.mergePositions([
        {
          conditionId: "0x1111111111111111111111111111111111111111111111111111111111111111",
          amount: 5,
        },
        {
          conditionId: "0x2222222222222222222222222222222222222222222222222222222222222222",
          amount: 7,
        },
      ]),
    ).rejects.toThrow(/could not build merge requests for 0x2222/);

    // The batch is atomic: the buildable condition must NOT go on chain either, or its ledger row
    // would be left 'pending' for a merge that actually happened.
    expect(settlementClient.execute).not.toHaveBeenCalled();
  });

  it("mergePositions rejects (never silently resolves) when the SDK has no merge API", async () => {
    // Regression: resolving here told the caller the merge was irrevocable. Its write-ahead
    // ledger then marked the intents 'onchain' and settled them to 'applied', consuming the
    // local positions — a divergence that is both terminal and INVISIBLE, since the startup
    // report only surfaces non-terminal rows. A configuration with auto-merge on and no merge
    // API must fail loudly on every sweep instead.
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});

    await expect(
      gw.mergePositions([
        { conditionId: "cond-1", amount: 10 },
        { conditionId: "cond-2", amount: 20 },
      ]),
    ).rejects.toThrow(/mergePositions unsupported/);
    await expect(gw.mergePositions([{ conditionId: "cond-3", amount: 30 }])).rejects.toThrow(
      /mergePositions unsupported/,
    );

    expect(emitWarning).toHaveBeenCalledTimes(1);
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("mergePositions skipped"),
      expect.objectContaining({ code: "KRABS_MERGE_UNSUPPORTED" }),
    );
  });

  it("mergePositions rejects when the relayer submitted but never confirmed", async () => {
    // Regression (round-2 #1): the relayer response is observed, and anything short of 'confirmed'
    // used to be DISCARDED — mergePositions resolved, and InventoryManagerModule read that as "the
    // batch is on chain and irrevocable": every write-ahead intent went 'onchain' and then the
    // TERMINAL 'applied', with the local YES/NO lots consumed. Merge requests carry no
    // precheckTokenIds, so the balance post-check returns false vacuously and can never rescue it.
    // If the transaction then failed, the ledger claimed a merge that never happened — and the
    // startup divergence report only surfaces NON-terminal rows, so it was invisible forever.
    vi.useFakeTimers();
    try {
      const settlementClient = {
        // A wait() that rejects is how a confirmation we could not observe reaches the caller:
        // observeSettlementExecution converts every non-SettlementTransactionFailedError into
        // { status: "pending" }. The batch WAS broadcast — which is why the rows must survive.
        execute: vi.fn().mockResolvedValue({
          wait: vi.fn().mockRejectedValue(new Error("confirmation stream closed")),
        }),
      };
      gw = createLiveGateway({
        client,
        settlementClient,
        __settlementLaneBackstopMs: 1_000,
      });
      client.getMarket.mockResolvedValue({
        tokens: [
          { outcome: "Yes", token_id: "tok-yes" },
          { outcome: "No", token_id: "tok-no" },
        ],
      });

      const conditionId = "0x1111111111111111111111111111111111111111111111111111111111111111";
      const err = await gw.mergePositions([{ conditionId, amount: 10 }]).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(SettlementUnconfirmedError);
      expect((err as SettlementUnconfirmedError).observedStatus).toBe("pending");
      expect((err as SettlementUnconfirmedError).conditionIds).toEqual([conditionId]);
      // It really was submitted — the rejection means "unconfirmed", never "not attempted".
      expect(settlementClient.execute).toHaveBeenCalledTimes(1);

      // The throw is raised AFTER the lane released for the observed status, so the TTL hold that
      // an unconfirmed submission earns is intact: the next sweep is made to wait out the backstop
      // rather than racing a transaction that may still be in flight. Routing this through the
      // lane's catch instead would have released it as a plain error, immediately.
      const second = gw.mergePositions([{ conditionId, amount: 10 }]).catch((e: unknown) => e);
      await Promise.resolve();
      await Promise.resolve();
      expect(settlementClient.execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(second).resolves.toBeInstanceOf(SettlementUnconfirmedError);
      expect(settlementClient.execute).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mergePositions rejects a response with no wait(), without raising an infra alert", async () => {
    // The second unconfirmable shape: a relayer response that exposes no wait() at all resolves as
    // 'submitted'. Same verdict — the caller must not apply it locally.
    const settlementClient = { execute: vi.fn().mockResolvedValue({ transactionID: "0xabc" }) };
    const onInfraAlert = vi.fn();
    gw = createLiveGateway({ client, settlementClient, onInfraAlert });
    client.getMarket.mockResolvedValue({
      tokens: [
        { outcome: "Yes", token_id: "tok-yes" },
        { outcome: "No", token_id: "tok-no" },
      ],
    });

    const err = await gw
      .mergePositions([
        {
          conditionId: "0x3333333333333333333333333333333333333333333333333333333333333333",
          amount: 4,
        },
      ])
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(SettlementUnconfirmedError);
    expect((err as SettlementUnconfirmedError).observedStatus).toBe("submitted");
    // Thrown OUTSIDE the lane's try/catch on purpose: a transaction that is merely slow to confirm
    // is not an infrastructure failure, and routing it through the submit-error handler would open
    // a settlement alert (and its breaker) for a batch that is probably perfectly healthy.
    expect(onInfraAlert).not.toHaveBeenCalled();
  });

  it("mergePositions refuses without a relayer client instead of broadcasting per condition", async () => {
    // A per-condition `postMerge` fallback used to run here. It resolved on acceptance for
    // broadcast, never on a receipt, so every outcome it could produce was unsupported: resolving
    // handed the caller a terminal invisible divergence, and rejecting after a broadcast left the
    // conditions permanently fenced with no way to confirm what landed. Refusing BEFORE the first
    // broadcast is the only recoverable answer — nothing is on chain, so the caller may safely
    // discard its write-ahead rows and nothing is fenced. The presence of a client merge API must
    // NOT re-enable submission.
    const mergeOne = vi.fn().mockResolvedValue(undefined);
    Object.assign(client as Record<string, unknown>, { postMerge: mergeOne });

    const err = await gw
      .mergePositions([
        { conditionId: "cond-a", amount: 10 },
        { conditionId: "cond-b", amount: 20 },
      ])
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(mergeOne).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(SettlementNotSubmittedError);
  });

  it("redeemPositions reports the partially submitted fallback batch instead of rejecting", async () => {
    // The sequential fallback can leave cond-a irrevocable when cond-b throws. Unlike merge — whose
    // void return forces a throw — the redeem contract carries the submitted set, and the caller
    // partitions on it: cond-a keeps a non-terminal 'submitted' row, cond-b is recorded as never
    // submitted. Rejecting instead would erase that cond-a was already broadcast and let the retry
    // path redeem it a second time.
    const onInfraAlert = vi.fn();
    const gwWithAlert = createLiveGateway({ client, onInfraAlert });
    const redeemOne = vi
      .fn()
      .mockResolvedValueOnce({ transactionHash: "0xpartial" })
      .mockRejectedValueOnce(new Error("429 Too Many Requests"));
    Object.assign(client as Record<string, unknown>, { postRedeem: redeemOne });

    await expect(gwWithAlert.redeemPositions(["cond-a", "cond-b"])).resolves.toMatchObject({
      status: "submitted",
      conditionIds: ["cond-a"],
      txHash: "0xpartial",
    });

    expect(redeemOne).toHaveBeenCalledTimes(2);
    // The per-call error classification is lost for this sweep, so the 429 must still reach the
    // shared settlement breaker through the alert channel.
    expect(onInfraAlert).toHaveBeenCalledWith(
      expect.objectContaining({ code: "POLYGON_RPC_RATE_LIMITED" }),
    );
  });

  it("redeemPositions rethrows the original error when the fallback batch broadcast nothing", async () => {
    // Nothing is on chain, so the error is attributable to the whole call — the caller needs it
    // intact for its 429 hard-pause, zero-balance and STATE_FAILED classification.
    const redeemOne = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
    Object.assign(client as Record<string, unknown>, { postRedeem: redeemOne });

    await expect(gw.redeemPositions(["cond-a", "cond-b"])).rejects.toThrow(/429/);
    expect(redeemOne).toHaveBeenCalledTimes(1);
  });

  it("redeemPositions reports every condition when the whole fallback batch is broadcast", async () => {
    const redeemOne = vi.fn().mockResolvedValue({ transactionHash: "0xfull" });
    Object.assign(client as Record<string, unknown>, { postRedeem: redeemOne });

    await expect(gw.redeemPositions(["cond-a", "cond-b"])).resolves.toMatchObject({
      status: "submitted",
      conditionIds: ["cond-a", "cond-b"],
      txHash: "0xfull",
    });
    expect(redeemOne).toHaveBeenCalledTimes(2);
  });

  it("redeemPositions reports each fallback condition's OWN transaction, not the first one's", async () => {
    // The sequential fallback broadcasts one transaction per condition, so a single flat txHash
    // cannot describe the batch: it keeps whichever hash came back first. Without the per-condition
    // map the caller stamps 0xaaa on cond-b too, and cond-b's redeem_log row points at a
    // transaction that never touched it — an on-chain check of that row confirms the wrong redeem.
    const redeemOne = vi
      .fn()
      .mockResolvedValueOnce({ transactionHash: "0xaaa", gasUsed: 111 })
      .mockResolvedValueOnce({ transactionHash: "0xbbb", gasUsed: 222 });
    Object.assign(client as Record<string, unknown>, { postRedeem: redeemOne });

    const result = await gw.redeemPositions(["cond-a", "cond-b"]);

    expect(result.txByCondition).toEqual({
      "cond-a": { txHash: "0xaaa", gasUsed: 111 },
      "cond-b": { txHash: "0xbbb", gasUsed: 222 },
    });
    // The flat fields stay as a batch summary for callers that predate the map.
    expect(result.txHash).toBe("0xaaa");
  });

  it("redeemPositions omits txByCondition on the batch path, where one transaction really covers all", async () => {
    // A client-side batch redeem settles every condition in ONE transaction, so the flat txHash is
    // correct for all of them. Emitting a map here would be a lie of precision, and the caller reads
    // the map's absence as exactly that signal.
    const redeemBatch = vi.fn().mockResolvedValue({ transactionHash: "0xbatch" });
    Object.assign(client as Record<string, unknown>, { redeemPositions: redeemBatch });

    const result = await gw.redeemPositions(["cond-a", "cond-b"]);

    expect(result.txByCondition).toBeUndefined();
    expect(result.txHash).toBe("0xbatch");
  });

  it("mergePositions does not use batch fallback that drops merge amount", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const mergeBatch = vi.fn().mockResolvedValue(undefined);
    Object.assign(client as Record<string, unknown>, {
      mergePositions: mergeBatch,
    });

    // The amount-dropping batch method must stay untouched — and, having no usable merge API,
    // the call must reject rather than report a merge that never happened.
    await expect(
      gw.mergePositions([
        { conditionId: "cond-1", amount: 10 },
        { conditionId: "cond-2", amount: 20 },
      ]),
    ).rejects.toThrow(/mergePositions unsupported/);

    expect(mergeBatch).not.toHaveBeenCalled();
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining("mergePositions skipped"),
      expect.objectContaining({ code: "KRABS_MERGE_UNSUPPORTED" }),
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

  describe("getMarketFeeInfo TTL cache", () => {
    const conditionId = "0xcond";

    it("returns rate/exponent/takerOnly from fd block on first call", async () => {
      client.getClobMarketInfo.mockResolvedValueOnce({ fd: { r: 0.04, e: 1, to: false } });
      const info = await gw.getMarketFeeInfo(conditionId);
      expect(info).toEqual({ rate: 0.04, exponent: 1, takerOnly: false });
      expect(client.getClobMarketInfo).toHaveBeenCalledOnce();
    });

    it("returns null when fd is absent", async () => {
      client.getClobMarketInfo.mockResolvedValueOnce({});
      const info = await gw.getMarketFeeInfo(conditionId);
      expect(info).toBeNull();
    });

    it("returns diagnostic no-fee-info when fd and base fee fields are absent", async () => {
      client.getClobMarketInfo.mockResolvedValueOnce({});
      const result = await gw.getMarketFeeInfoResult(conditionId);
      expect(result).toMatchObject({
        status: "api_no_fee_info",
        info: null,
        diagnostic: {
          fieldShape: "no_fee_fields",
          fdPresent: false,
          takerBaseFeePresent: false,
          makerBaseFeePresent: false,
        },
      });
    });

    it("returns diagnostic unsupported when only base fee fields are present", async () => {
      client.getClobMarketInfo.mockResolvedValueOnce({ tbf: 1000, mbf: 1000 });
      const result = await gw.getMarketFeeInfoResult(conditionId);
      expect(result).toMatchObject({
        status: "api_unsupported_fee_info",
        info: null,
        diagnostic: {
          fieldShape: "base_fee_only",
          fdPresent: false,
          takerBaseFeePresent: true,
          makerBaseFeePresent: true,
        },
      });
    });

    it("returns diagnostic invalid when fd is present without a finite rate", async () => {
      client.getClobMarketInfo.mockResolvedValueOnce({ fd: { e: 1, to: true } });
      const result = await gw.getMarketFeeInfoResult(conditionId);
      expect(result).toMatchObject({
        status: "api_invalid_fee_info",
        info: null,
        diagnostic: {
          fieldShape: "fd_invalid",
          fdPresent: true,
        },
      });
    });

    it("returns diagnostic api_error when the CLOB market info call throws", async () => {
      client.getClobMarketInfo.mockRejectedValueOnce(new Error("CLOB down"));
      const result = await gw.getMarketFeeInfoResult(conditionId);
      expect(result).toMatchObject({
        status: "api_error",
        info: null,
        diagnostic: {
          fieldShape: "unknown",
        },
      });
    });

    it("defaults exponent to 0 when fd.e is absent (matches SDK `fd?.e ?? 0`)", async () => {
      client.getClobMarketInfo.mockResolvedValueOnce({ fd: { r: 0.04, to: true } });
      const info = await gw.getMarketFeeInfo(conditionId);
      expect(info).toEqual({ rate: 0.04, exponent: 0, takerOnly: true });
    });

    it("defaults exponent to 0 when fd.e is non-finite (NaN)", async () => {
      client.getClobMarketInfo.mockResolvedValueOnce({ fd: { r: 0.04, e: NaN, to: false } });
      const info = await gw.getMarketFeeInfo(conditionId);
      expect(info).toEqual({ rate: 0.04, exponent: 0, takerOnly: false });
    });

    it("serves repeated calls from cache while TTL is fresh", async () => {
      client.getClobMarketInfo.mockResolvedValueOnce({ fd: { r: 0.04, e: 1, to: false } });
      const a = await gw.getMarketFeeInfo(conditionId);
      const b = await gw.getMarketFeeInfo(conditionId);
      expect(a).toEqual(b);
      expect(client.getClobMarketInfo).toHaveBeenCalledOnce();
    });

    it("re-fetches after the hit TTL expires", async () => {
      const start = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(start);
      client.getClobMarketInfo
        .mockResolvedValueOnce({ fd: { r: 0.04, e: 1, to: false } })
        .mockResolvedValueOnce({ fd: { r: 0.05, e: 1, to: true } });

      await gw.getMarketFeeInfo(conditionId);
      vi.spyOn(Date, "now").mockReturnValue(start + 5 * 60_000 + 1);
      const second = await gw.getMarketFeeInfo(conditionId);
      expect(second).toEqual({ rate: 0.05, exponent: 1, takerOnly: true });
      expect(client.getClobMarketInfo).toHaveBeenCalledTimes(2);
    });

    it("negatively caches transient failures with a short TTL and re-fetches after it", async () => {
      const start = 1_700_000_000_000;
      vi.spyOn(Date, "now").mockReturnValue(start);
      client.getClobMarketInfo
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValueOnce({ fd: { r: 0.04, e: 1, to: false } });

      const first = await gw.getMarketFeeInfo(conditionId);
      const cached = await gw.getMarketFeeInfo(conditionId);
      expect(first).toBeNull();
      expect(cached).toBeNull();
      expect(client.getClobMarketInfo).toHaveBeenCalledOnce();

      vi.spyOn(Date, "now").mockReturnValue(start + 30_000 + 1);
      const refreshed = await gw.getMarketFeeInfo(conditionId);
      expect(refreshed).toEqual({ rate: 0.04, exponent: 1, takerOnly: false });
      expect(client.getClobMarketInfo).toHaveBeenCalledTimes(2);
    });
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

    const tokenId = createTokenId("9876543210123456789");
    const book = await gw.getOrderBook(tokenId);
    expect(book.tokenId).toBe("9876543210123456789");
    expect(book.bestBid).toBe(0.5);
    expect(book.bestAsk).toBe(0.55);
  });

  it("getTickSize returns parsed number", async () => {
    client.getTickSize.mockResolvedValue("0.001");
    const tick = await gw.getTickSize(createTokenId("9876543210123456789"));
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

  it("getMarkets rejects when SDK rejects", async () => {
    // withTimeout was deleted (Task 6 — Promise.race did not abort the axios request).
    // Real timeout enforcement is via axios.defaults.timeout (45 s, set at runtime init).
    // Here we verify that a plain SDK rejection propagates correctly.
    client.getMarkets.mockRejectedValue(new Error("axios timeout"));
    await expect(gw.getMarkets()).rejects.toThrow("axios timeout");
  });

  it("getOrderBook returns empty book on SDK failure", async () => {
    client.getOrderBook.mockRejectedValue(new Error("timeout"));
    const tokenId = createTokenId("9876543210123456789");
    const book = await gw.getOrderBook(tokenId);
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
    expect(book.bestBid).toBeNull();
  });

  it("getOrderBook returns empty book when SDK rejects", async () => {
    // withTimeout was deleted (Task 6 — Promise.race did not abort the axios request).
    // Real timeout enforcement is via axios.defaults.timeout (45 s, set at runtime init).
    // Here we verify that an SDK rejection (e.g. axios timeout) returns the empty-book fallback.
    client.getOrderBook.mockRejectedValue(new Error("axios timeout"));
    const tokenId = createTokenId("9876543210123456789");
    const book = await gw.getOrderBook(tokenId);
    expect(book.bids).toEqual([]);
    expect(book.asks).toEqual([]);
    expect(book.bestBid).toBeNull();
  });

  it("getTickSize returns default 0.01 on SDK failure", async () => {
    client.getTickSize.mockRejectedValue(new Error("fetch failed"));
    const tick = await gw.getTickSize(createTokenId("9876543210123456789"));
    expect(tick).toBe(0.01);
  });

  it("getMarketPricing constructs URL with repeated clob_token_ids params", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
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
    });

    try {
      await gw.getMarketPricing(["tok-a", "tok-b"]);

      const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(calledUrl).toContain("clob_token_ids=tok-a&clob_token_ids=tok-b");
      expect(calledUrl).toContain("gamma-api.polymarket.com/markets");
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getOrderBooks parses batched CLOB book responses by token id", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            asset_id: "tok-a",
            bids: [
              { price: "0.09", size: "40" },
              { price: "0.11", size: "25" },
            ],
            asks: [
              { price: "0.15", size: "30" },
              { price: "0.12", size: "10" },
            ],
            min_order_size: "5",
          },
          {
            token_id: "tok-b",
            bids: [
              { price: "0.19", size: "9" },
              { price: "0.21", size: "15" },
            ],
            asks: [
              { price: "0.25", size: "18" },
              { price: "0.23", size: "7" },
            ],
          },
        ]),
    });

    try {
      const result = await gw.getOrderBooks(["tok-a", "tok-b"]);
      expect(result.get("tok-a")!.bestBid).toBe(0.11);
      expect(result.get("tok-a")!.bestAsk).toBe(0.12);
      expect(result.get("tok-a")!.minOrderSize).toBe(5);
      expect(result.get("tok-b")!.bestBid).toBe(0.21);
      expect(result.get("tok-b")!.bestAsk).toBe(0.23);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getOrderBooks retries transient fetch failures before succeeding", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed: getaddrinfo ENOTFOUND clob.polymarket.com"))
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              asset_id: "tok-a",
              bids: [{ price: "0.10", size: "10" }],
              asks: [{ price: "0.12", size: "8" }],
            },
          ]),
      });
    globalThis.fetch = fetchMock;

    try {
      const result = await gw.getOrderBooks(["tok-a"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.get("tok-a")!.bestBid).toBe(0.1);
      expect(result.get("tok-a")!.bestAsk).toBe(0.12);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing extracts pricing when Gamma returns stringified clobTokenIds and outcomePrices", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
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
    });

    try {
      const result = await gw.getMarketPricing(["tok-a"]);
      expect(result.size).toBe(2);
      expect(result.get("tok-a")!.bestBid).toBe(0.44);
      expect(result.get("tok-a")!.bestAsk).toBe(0.46);
      expect(result.get("tok-a")!.bookSource).toBe("gamma");
      expect(result.get("tok-b")!.bestBid).toBeNull();
      expect(result.get("tok-b")!.bestAsk).toBeNull();
      expect(result.get("tok-b")!.bookSource).toBe("gamma-fallback");
      expect(result.get("tok-a")!.minOrderSize).toBeNull();
      expect(result.get("tok-b")!.minOrderSize).toBeNull();
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

  it("getMarketPricing throws on non-retryable HTTP error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
    });

    try {
      await expect(gw.getMarketPricing(["9876543210123456789"])).rejects.toThrow(
        "Gamma pricing request failed: 400",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing drains response body on non-retryable HTTP error to release socket", async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      body: { cancel: cancelMock },
    });

    try {
      await expect(gw.getMarketPricing(["9876543210123456789"])).rejects.toThrow(
        "Gamma pricing request failed: 400",
      );
      expect(cancelMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing retries Gamma 5xx responses before succeeding", async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        body: { cancel: cancelMock },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              clobTokenIds: ["9876543210123456789"],
              outcomePrices: "[0.45]",
              bestBid: 0.44,
              bestAsk: 0.46,
            },
          ]),
      });
    globalThis.fetch = fetchMock;

    try {
      const result = await gw.getMarketPricing(["9876543210123456789"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(cancelMock).toHaveBeenCalledTimes(1);
      expect(result.get("9876543210123456789")!.bestBid).toBe(0.44);
      expect(result.get("9876543210123456789")!.bestAsk).toBe(0.46);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getOrderBooks drains response body on HTTP error to release socket", async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      body: { cancel: cancelMock },
    });

    try {
      await expect(gw.getOrderBooks(["9876543210123456789"])).rejects.toThrow(
        "CLOB books request failed: 502",
      );
      expect(cancelMock).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fetchWithRetry passes AbortSignal.timeout to fetch so sockets release on timeout", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    globalThis.fetch = fetchMock;

    try {
      await gw.getMarketPricing(["9876543210123456789"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing does not call CLOB books endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    globalThis.fetch = fetchMock;

    try {
      await expect(gw.getMarketPricing(["9876543210123456789"])).resolves.toEqual(new Map());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).not.toBe("https://clob.polymarket.com/books");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing retries transient fetch failures before succeeding", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("request timed out after 15000ms"))
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              clobTokenIds: ["9876543210123456789"],
              outcomePrices: "[0.45]",
              bestBid: 0.44,
              bestAsk: 0.46,
            },
          ]),
      });
    globalThis.fetch = fetchMock;

    try {
      const result = await gw.getMarketPricing(["9876543210123456789"]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.get("9876543210123456789")!.bestBid).toBe(0.44);
      expect(result.get("9876543210123456789")!.bestAsk).toBe(0.46);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("healthCheck returns ok on success", async () => {
    client.getOk.mockResolvedValue("OK");
    const health = await gw.healthCheck();
    expect(health.ok).toBe(true);
  });

  it("createMarketPricingStream subscribes to Polymarket market WS and merges pricing updates", async () => {
    const socket = new FakeMarketSocket();
    gw = new LiveMarketDataGateway({
      client,
      createWebSocket: () => socket,
    });

    const updates: Array<{
      tokenId: string;
      bestBid: number | null;
      bestAsk: number | null;
      lastTradePrice: number | null;
      hasBook: boolean;
      tickSize: number | null;
    }> = [];
    const stream = gw.createMarketPricingStream({
      onUpdates: async (next) => {
        updates.push(
          ...next.map((update) => ({
            tokenId: update.tokenId,
            bestBid: update.pricing.bestBid,
            bestAsk: update.pricing.bestAsk,
            lastTradePrice: update.pricing.lastTradePrice,
            hasBook: update.book != null,
            tickSize: update.tickSize ?? null,
          })),
        );
      },
    });

    stream.setTokenIds(["tok-stream"]);
    stream.setFullBookTokenIds?.("hot-set", ["tok-stream"]);
    socket.emitOpen();

    expect(JSON.parse(socket.sent[0]!)).toEqual({
      type: "market",
      assets_ids: ["tok-stream"],
      custom_feature_enabled: true,
    });

    socket.emitJson({
      event_type: "best_bid_ask",
      asset_id: "tok-stream",
      best_bid: "0.07",
      best_ask: "0.09",
      timestamp: "1766789469958",
    });
    socket.emitJson({
      event_type: "last_trade_price",
      asset_id: "tok-stream",
      price: "0.08",
      timestamp: "1766789469958",
    });
    socket.emitJson({
      event_type: "book",
      asset_id: "tok-stream",
      bids: [
        { price: "0.06", size: "10" },
        { price: "0.07", size: "20" },
      ],
      asks: [
        { price: "0.10", size: "30" },
        { price: "0.09", size: "5" },
      ],
      min_order_size: "5",
      timestamp: "1766789469958",
    });
    socket.emitJson({
      event_type: "price_change",
      asset_id: "tok-stream",
      timestamp: "1766789470958",
      price_changes: [{ price: "0.11", best_bid: "0.10", best_ask: "0.12" }],
    });
    socket.emitJson({
      event_type: "tick_size_change",
      asset_id: "tok-stream",
      new_tick_size: "0.05",
      timestamp: "1766789471958",
    });

    // R73b suppresses last-trade-only frames before IPC; state still carries forward.
    await vi.waitFor(() => {
      expect(updates).toEqual([
        {
          tokenId: "tok-stream",
          bestBid: 0.07,
          bestAsk: 0.09,
          lastTradePrice: null,
          hasBook: false,
          tickSize: null,
        },
        {
          tokenId: "tok-stream",
          bestBid: 0.07,
          bestAsk: 0.09,
          lastTradePrice: 0.08,
          hasBook: true,
          tickSize: null,
        },
        {
          tokenId: "tok-stream",
          bestBid: 0.1,
          bestAsk: 0.12,
          lastTradePrice: 0.08,
          hasBook: false,
          tickSize: null,
        },
        {
          tokenId: "tok-stream",
          bestBid: 0.1,
          bestAsk: 0.12,
          lastTradePrice: 0.08,
          hasBook: false,
          tickSize: 0.05,
        },
      ]);
    });

    stream.close();
  });

  it("createMarketPricingStream updates subscriptions on the same socket", () => {
    const sockets: FakeMarketSocket[] = [];
    gw = new LiveMarketDataGateway({
      client,
      createWebSocket: () => {
        const socket = new FakeMarketSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const stream = gw.createMarketPricingStream({
      onUpdates: vi.fn(),
    });

    stream.setTokenIds(["tok-a", "tok-b"]);
    sockets[0]!.emitOpen();
    stream.setTokenIds(["tok-b", "tok-c"]);

    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "market",
        assets_ids: ["tok-a", "tok-b"],
        custom_feature_enabled: true,
      },
      {
        operation: "unsubscribe",
        assets_ids: ["tok-a"],
      },
      {
        operation: "subscribe",
        assets_ids: ["tok-c"],
        custom_feature_enabled: true,
      },
    ]);

    stream.close();
  });

  it("createMarketPricingStream shards subscriptions when token count exceeds per-socket cap", () => {
    const sockets: FakeMarketSocket[] = [];
    gw = new LiveMarketDataGateway({
      client,
      createWebSocket: () => {
        const socket = new FakeMarketSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const stream = gw.createMarketPricingStream({
      onUpdates: vi.fn(),
      onError: vi.fn(),
    });

    const tokenIds = Array.from({ length: 501 }, (_, index) => `tok-${index}`);
    const sortedTokenIds = [...tokenIds].sort();
    stream.setTokenIds(tokenIds);
    sockets[0]!.emitOpen();
    sockets[1]!.emitOpen();

    expect(sockets).toHaveLength(2);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: "market",
      assets_ids: sortedTokenIds.slice(0, 500),
      custom_feature_enabled: true,
    });
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({
      type: "market",
      assets_ids: sortedTokenIds.slice(500),
      custom_feature_enabled: true,
    });

    stream.close();
  });

  it("createMarketPricingStream reconnects after pong timeout", () => {
    vi.useFakeTimers();
    try {
      const sockets: DeferredCloseMarketSocket[] = [];
      gw = new LiveMarketDataGateway({
        client,
        createWebSocket: () => {
          const socket = new DeferredCloseMarketSocket();
          sockets.push(socket);
          return socket;
        },
      });

      const onError = vi.fn();
      const onGapDetected = vi.fn();
      const stream = gw.createMarketPricingStream({
        onUpdates: vi.fn(),
        onError,
        onGapDetected,
      });

      stream.setTokenIds(["tok-a"]);
      sockets[0]!.emitOpen();
      vi.advanceTimersByTime(10_000);
      expect(sockets[0]!.sent).toContain("PING");
      vi.advanceTimersByTime(15_000);
      expect(onGapDetected).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "pong-timeout", tokenIds: ["tok-a"] }),
      );
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ code: "MARKET_WS_PONG_TIMEOUT", shardId: 0, tokenCount: 1 }),
      );
      vi.advanceTimersByTime(1_100);

      expect(sockets).toHaveLength(2);

      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("createMarketPricingStream accepts PONG heartbeat responses", () => {
    vi.useFakeTimers();
    try {
      const sockets: DeferredCloseMarketSocket[] = [];
      gw = new LiveMarketDataGateway({
        client,
        createWebSocket: () => {
          const socket = new DeferredCloseMarketSocket();
          sockets.push(socket);
          return socket;
        },
      });

      const onError = vi.fn();
      const onGapDetected = vi.fn();
      const stream = gw.createMarketPricingStream({
        onUpdates: vi.fn(),
        onError,
        onGapDetected,
      });

      stream.setTokenIds(["tok-a"]);
      sockets[0]!.emitOpen();
      vi.advanceTimersByTime(10_000);
      expect(sockets[0]!.sent).toContain("PING");
      sockets[0]!.emitText("PONG");
      vi.advanceTimersByTime(15_001);

      expect(onGapDetected).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(1);

      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("createMarketPricingStream treats invalid payload as a gap without crashing", async () => {
    const socket = new FakeMarketSocket();
    gw = new LiveMarketDataGateway({
      client,
      createWebSocket: () => socket,
    });

    const onError = vi.fn();
    const onGapDetected = vi.fn();
    const stream = gw.createMarketPricingStream({
      onUpdates: vi.fn(),
      onError,
      onGapDetected,
    });

    stream.setTokenIds(["tok-a"]);
    socket.emitOpen();
    socket.emitText("{not-json");
    await vi.waitFor(() => {
      expect(onGapDetected).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "invalid-payload",
          timestamp: expect.any(Number),
          tokenIds: ["tok-a"],
        }),
      );
    });
    expect(onError).toHaveBeenCalled();

    stream.close();
  });

  it("createMarketPricingStream forwards additive lifecycle events", async () => {
    const socket = new FakeMarketSocket();
    gw = new LiveMarketDataGateway({
      client,
      createWebSocket: () => socket,
    });

    const lifecycleEvents: unknown[] = [];
    const stream = gw.createMarketPricingStream({
      onUpdates: vi.fn(),
      onLifecycleEvents: async (events) => {
        lifecycleEvents.push(...events);
      },
    });

    stream.setTokenIds(["tok-stream"]);
    socket.emitOpen();
    socket.emitJson({
      event_type: "market_resolved",
      condition_id: "cond-1",
      market: "market-1",
      slug: "market-one",
      assets_ids: ["tok-stream"],
      winning_asset_id: "tok-stream",
      timestamp: "1766789469958",
    });
    socket.emitJson({
      event_type: "new_market",
      condition_id: "cond-2",
      market: "market-2",
      slug: "market-two",
      question: "Will two happen?",
      active: true,
      assets_ids: ["tok-new"],
      timestamp: "1766789469958",
    });

    // The ingress queue drains asynchronously; waitFor lets both items process.
    await vi.waitFor(() => {
      expect(lifecycleEvents).toEqual([
        {
          type: "market_resolved",
          conditionId: "cond-1",
          marketId: "market-1",
          slug: "market-one",
          tokenIds: [createTokenId("tok-stream")],
          winningTokenId: createTokenId("tok-stream"),
          timestamp: 1766789469958,
        },
        {
          type: "new_market",
          conditionId: "cond-2",
          marketId: "market-2",
          slug: "market-two",
          question: "Will two happen?",
          active: true,
          tokenIds: [createTokenId("tok-new")],
          timestamp: 1766789469958,
        },
      ]);
    });

    stream.close();
  });

  it("createMarketPricingStream caps per-window latency samples under a WS event storm", async () => {
    const socket = new FakeMarketSocket();
    gw = new LiveMarketDataGateway({
      client,
      createWebSocket: () => socket,
    });

    const stream = gw.createMarketPricingStream({ onUpdates: vi.fn() });
    stream.setTokenIds(["tok-a"]);
    socket.emitOpen();

    const burst = 15_000;
    const baseTimestamp = Date.now();
    for (let i = 0; i < burst; i++) {
      socket.emitJson({
        event_type: "best_bid_ask",
        asset_id: "tok-a",
        best_bid: "0.10",
        best_ask: "0.12",
        timestamp: String(baseTimestamp + i),
      });
    }

    const snapshot = stream.getMetricsSnapshot?.();
    expect(snapshot).toBeDefined();
    expect(snapshot!.wsEventsReceived).toBe(burst);
    expect(snapshot!.wsLatencyMs?.count).toBeLessThanOrEqual(10_000);
    expect(snapshot!.wsLatencyMs?.count).toBeGreaterThan(0);

    stream.close();
  });

  it("ignores stale WS timestamps when computing latency metrics", async () => {
    const socket = new FakeMarketSocket();
    gw = new LiveMarketDataGateway({
      client,
      createWebSocket: () => socket,
    });

    const stream = gw.createMarketPricingStream({ onUpdates: vi.fn() });
    stream.setTokenIds(["tok-a"]);
    socket.emitOpen();

    socket.emitJson({
      event_type: "best_bid_ask",
      asset_id: "tok-a",
      best_bid: "0.10",
      best_ask: "0.12",
      timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    const snapshot = stream.getMetricsSnapshot?.();
    expect(snapshot).toBeDefined();
    expect(snapshot!.wsLatencyMs).toBeNull();

    stream.close();
  });

  it("getMarketPricing copies acceptingOrders + enableOrderBook when both true", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            clobTokenIds: '["tok-a"]',
            bestBid: 0.4,
            bestAsk: 0.5,
            acceptingOrders: true,
            enableOrderBook: true,
          },
        ]),
    });
    try {
      const result = await gw.getMarketPricing(["tok-a"]);
      expect(result.get("tok-a")!.acceptingOrders).toBe(true);
      expect(result.get("tok-a")!.enableOrderBook).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing copies acceptingOrders + enableOrderBook as false when Gamma reports false", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            clobTokenIds: '["tok-a"]',
            bestBid: 0.4,
            bestAsk: 0.5,
            acceptingOrders: false,
            enableOrderBook: false,
          },
        ]),
    });
    try {
      const result = await gw.getMarketPricing(["tok-a"]);
      expect(result.get("tok-a")!.acceptingOrders).toBe(false);
      expect(result.get("tok-a")!.enableOrderBook).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("getMarketPricing fail-closes liveness to false when fields are absent", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          {
            clobTokenIds: '["tok-a"]',
            bestBid: 0.4,
            bestAsk: 0.5,
            /* acceptingOrders and enableOrderBook omitted */
          },
        ]),
    });
    try {
      const result = await gw.getMarketPricing(["tok-a"]);
      expect(result.get("tok-a")!.acceptingOrders).toBe(false);
      expect(result.get("tok-a")!.enableOrderBook).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("SharedMarketPricingStreamHub", () => {
  it("strips full-book depth for views without narrow full-book interest", async () => {
    const socket = new FakeMarketSocket();
    const hub = new SharedMarketPricingStreamHub({
      createWebSocket: () => socket,
    });
    const updatesA: Array<{ hasBook: boolean }> = [];
    const updatesB: Array<{ hasBook: boolean }> = [];
    const viewA = hub.createStream({
      onUpdates: async (updates) => {
        updatesA.push(...updates.map((update) => ({ hasBook: update.book != null })));
      },
    });
    const viewB = hub.createStream({
      onUpdates: async (updates) => {
        updatesB.push(...updates.map((update) => ({ hasBook: update.book != null })));
      },
    });

    viewA.setTokenIds(["tok-a"]);
    viewB.setTokenIds(["tok-a"]);
    viewA.setFullBookTokenIds?.("hot-set", ["tok-a"]);
    socket.emitOpen();
    socket.emitJson({
      event_type: "book",
      asset_id: "tok-a",
      bids: [{ price: "0.04", size: "10" }],
      asks: [{ price: "0.05", size: "10" }],
      min_order_size: "5",
      timestamp: "1766789469958",
    });

    await vi.waitFor(() => {
      expect(updatesA).toEqual([{ hasBook: true }]);
      expect(updatesB).toEqual([{ hasBook: false }]);
    });
    expect(viewA.getMetricsSnapshot?.()?.fullBookTokenCount).toBe(1);

    viewA.close();
    viewB.close();
  });

  it("rebuilds cached view token set after setTokenIds", async () => {
    const socket = new FakeMarketSocket();
    const hub = new SharedMarketPricingStreamHub({
      createWebSocket: () => socket,
    });
    const seenTokenIds: string[] = [];
    const view = hub.createStream({
      onUpdates: async (updates) => {
        seenTokenIds.push(...updates.map((update) => update.tokenId));
      },
    });

    view.setTokenIds(["tok-a"]);
    socket.emitOpen();
    socket.emitJson({
      event_type: "best_bid_ask",
      asset_id: "tok-a",
      best_bid: "0.10",
      best_ask: "0.11",
      timestamp: "1766789469958",
    });
    await vi.waitFor(() => {
      expect(seenTokenIds).toEqual(["tok-a"]);
    });

    view.setTokenIds(["tok-b"]);
    socket.emitJson({
      event_type: "best_bid_ask",
      asset_id: "tok-a",
      best_bid: "0.12",
      best_ask: "0.13",
      timestamp: "1766789469959",
    });
    socket.emitJson({
      event_type: "best_bid_ask",
      asset_id: "tok-b",
      best_bid: "0.20",
      best_ask: "0.21",
      timestamp: "1766789469960",
    });

    await vi.waitFor(() => {
      expect(seenTokenIds).toEqual(["tok-a", "tok-b"]);
    });
    expect(view.getMetricsSnapshot?.()?.hubFilterChecked).toBe(3);
    expect(view.getMetricsSnapshot?.()?.hubFilterPassed).toBe(2);
    view.close();
  });

  it("rebuilds cached full-book token set after setFullBookTokenIds", async () => {
    const socket = new FakeMarketSocket();
    const hub = new SharedMarketPricingStreamHub({
      createWebSocket: () => socket,
    });
    const hasBook: boolean[] = [];
    const view = hub.createStream({
      onUpdates: async (updates) => {
        hasBook.push(...updates.map((update) => update.book != null));
      },
    });

    view.setTokenIds(["tok-a"]);
    view.setFullBookTokenIds?.("hot-set", ["tok-a"]);
    socket.emitOpen();
    socket.emitJson({
      event_type: "book",
      asset_id: "tok-a",
      bids: [{ price: "0.04", size: "10" }],
      asks: [{ price: "0.05", size: "10" }],
      min_order_size: "5",
      timestamp: "1766789469958",
    });
    await vi.waitFor(() => {
      expect(hasBook).toEqual([true]);
    });

    view.setFullBookTokenIds?.("hot-set", []);
    socket.emitJson({
      event_type: "book",
      asset_id: "tok-a",
      bids: [{ price: "0.06", size: "10" }],
      asks: [{ price: "0.07", size: "10" }],
      min_order_size: "5",
      timestamp: "1766789469959",
    });

    await vi.waitFor(() => {
      expect(hasBook).toEqual([true, false]);
    });
    view.close();
  });

  it("reference-counts narrow full-book interest across views and reasons", () => {
    const socket = new FakeMarketSocket();
    const hub = new SharedMarketPricingStreamHub({
      createWebSocket: () => socket,
    });
    const viewA = hub.createStream({ onUpdates: vi.fn() });
    const viewB = hub.createStream({ onUpdates: vi.fn() });

    viewA.setTokenIds(["tok-a"]);
    viewB.setTokenIds(["tok-a"]);
    viewA.setFullBookTokenIds?.("hot-set", ["tok-a"]);
    expect(viewA.getMetricsSnapshot?.()?.narrowSubscribeCount).toBe(1);
    expect(viewA.getMetricsSnapshot?.()?.narrowUnsubscribeCount).toBe(0);

    viewB.setFullBookTokenIds?.("open-order", ["tok-a"]);
    expect(viewA.getMetricsSnapshot?.()?.narrowSubscribeCount).toBe(1);
    expect(viewA.getMetricsSnapshot?.()?.fullBookTokenCount).toBe(1);

    viewA.setFullBookTokenIds?.("hot-set", []);
    expect(viewA.getMetricsSnapshot?.()?.narrowUnsubscribeCount).toBe(0);

    viewB.setFullBookTokenIds?.("open-order", []);
    expect(viewA.getMetricsSnapshot?.()?.narrowUnsubscribeCount).toBe(1);
    expect(viewA.getMetricsSnapshot?.()?.fullBookTokenCount).toBe(0);

    viewA.close();
    viewB.close();
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
