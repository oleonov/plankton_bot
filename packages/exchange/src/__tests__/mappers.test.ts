import { describe, it, expect, afterEach } from "vitest";
import {
  toDomainSide,
  toSdkSide,
  toSdkTickSize,
  mapOpenOrder,
  mapTrade,
  mapTradeToPersonalFills,
  mapMarket,
  mapOrderBook,
  mapBalance,
  mapGammaMarket,
  mapGammaPricing,
} from "../mappers.js";
import { createTokenId } from "@krabs/domain";

describe("side mapping", () => {
  it("toDomainSide converts BUY/SELL to buy/sell", () => {
    expect(toDomainSide("BUY")).toBe("buy");
    expect(toDomainSide("SELL")).toBe("sell");
    expect(toDomainSide("buy")).toBe("buy");
    expect(toDomainSide("Sell")).toBe("sell");
  });

  it("toDomainSide throws on unknown side", () => {
    expect(() => toDomainSide("HOLD")).toThrow('Unknown order side: "HOLD"');
    expect(() => toDomainSide("")).toThrow('Unknown order side: ""');
  });

  it("toSdkSide converts buy/sell to BUY/SELL", () => {
    expect(toSdkSide("buy")).toBe("BUY");
    expect(toSdkSide("sell")).toBe("SELL");
  });
});

describe("toSdkTickSize", () => {
  it("converts number to string", () => {
    expect(toSdkTickSize(0.01)).toBe("0.01");
    expect(toSdkTickSize(0.001)).toBe("0.001");
  });
});

describe("mapOpenOrder", () => {
  it("maps SDK order to domain ExchangeOrder", () => {
    const order = mapOpenOrder({
      id: "ord-123",
      asset_id: "tok-abc",
      side: "BUY",
      original_size: "100",
      size_matched: "30",
      price: "0.55",
      status: "LIVE",
      created_at: 1700000000000,
    });

    expect(order.orderId).toBe("ord-123");
    expect(order.tokenId).toBe("tok-abc");
    expect(order.side).toBe("buy");
    expect(order.sizeTotal).toBe(100);
    expect(order.sizeFilled).toBe(30);
    expect(order.sizeRemaining).toBe(70);
    expect(order.status).toBe("OPEN");
    expect(order.price).toBe(0.55);
    expect(order.createdAt).toBe(1700000000000);
  });

  it("maps MATCHED status to FILLED", () => {
    const order = mapOpenOrder({ status: "MATCHED" });
    expect(order.status).toBe("FILLED");
  });

  it("maps CANCELED to CANCELLED", () => {
    const order = mapOpenOrder({ status: "CANCELED" });
    expect(order.status).toBe("CANCELLED");
  });
});

describe("mapTrade", () => {
  it("maps SDK trade to domain ExchangeFill", () => {
    const fill = mapTrade({
      id: "fill-1",
      taker_order_id: "ord-1",
      client_order_id: "cloid-1",
      asset_id: "tok-x",
      side: "SELL",
      size: "50",
      price: "0.60",
      trader_side: "TAKER",
      fee_rate_bps: "200",
      match_time: "2026-01-15T12:00:00Z",
    });

    expect(fill.fillId).toBe("fill-1");
    expect(fill.orderId).toBe("ord-1");
    expect(fill.clientOrderId).toBe("cloid-1");
    expect(fill.tokenId).toBe("tok-x");
    expect(fill.side).toBe("sell");
    expect(fill.size).toBe(50);
    expect(fill.price).toBe(0.6);
    expect(fill.liquidityRole).toBe("taker");
    expect(fill.feeRateBps).toBe(200);
    // fee = 50 * (200/10000) * 0.60 * (1 - 0.60) = 50 * 0.02 * 0.6 * 0.4 = 1 * 0.24 = 0.24
    expect(fill.fee).toBeCloseTo(0.24);
  });

  it("clientOrderId defaults to empty when SDK omits it", () => {
    const fill = mapTrade({
      id: "fill-2",
      taker_order_id: "ord-2",
      side: "BUY",
    });
    expect(fill.orderId).toBe("ord-2");
    expect(fill.clientOrderId).toBe("");
    expect(fill.liquidityRole).toBe("unknown");
  });

  it("maps trader_side=MAKER to maker liquidity role", () => {
    const fill = mapTrade({
      id: "fill-maker",
      taker_order_id: "ord-maker",
      side: "BUY",
      trader_side: "MAKER",
    });

    expect(fill.liquidityRole).toBe("maker");
  });

  it("maker fills have fee = 0 regardless of feeRateBps", () => {
    const fill = mapTrade({
      id: "fill-maker-zero",
      taker_order_id: "ord-maker-zero",
      asset_id: "tok-x",
      side: "BUY",
      size: "100",
      price: "0.50",
      trader_side: "MAKER",
      fee_rate_bps: "1000",
      match_time: "2026-04-07T00:00:00Z",
    });

    expect(fill.liquidityRole).toBe("maker");
    expect(fill.fee).toBe(0);
  });

  it("falls back to a valid current timestamp when match_time is invalid", () => {
    const before = Date.now();
    const fill = mapTrade({
      id: "fill-invalid-ts",
      taker_order_id: "ord-invalid-ts",
      side: "BUY",
      match_time: "not-a-real-time",
    });
    const after = Date.now();

    expect(fill.timestamp).toBeGreaterThanOrEqual(before);
    expect(fill.timestamp).toBeLessThanOrEqual(after);
  });

  it("extracts our taker trade from the top-level trade row", () => {
    const fills = mapTradeToPersonalFills(
      {
        id: "trade-top",
        taker_order_id: "ord-top",
        asset_id: "tok-yes",
        side: "BUY",
        size: "43.5",
        price: "0.11",
        fee_rate_bps: "1000",
        match_time: "2026-04-05T00:00:00Z",
        maker_address: "0xabc",
        trader_side: "TAKER",
      },
      "0xAbC",
    );

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      fillId: "trade-top",
      orderId: "ord-top",
      tokenId: "tok-yes",
      side: "buy",
      price: 0.11,
      liquidityRole: "taker",
    });
    expect(fills[0]!.size).toBeCloseTo(43.5, 5);
    expect(fills[0]!.sizeUsdc).toBeCloseTo(4.785, 6);
  });

  it("maps taker BUY fills to wallet gross shares and keeps fee separate", () => {
    const fills = mapTradeToPersonalFills(
      {
        id: "prod-btc-range-fill",
        taker_order_id: "ord-prod",
        asset_id: "73976077398962667521435505129491282127737376858530335388935291503156562864432",
        side: "BUY",
        size: "1170",
        price: "0.001",
        fee_rate_bps: "1000",
        match_time: "2026-04-26T14:04:48.000Z",
        maker_address: "0xf00df00df00df00df00df00df00df00df00df00d",
        trader_side: "TAKER",
      },
      "0xf00df00df00df00df00df00df00df00df00df00d",
    );

    expect(fills).toHaveLength(1);
    expect(fills[0]!.size).toBeCloseTo(1170, 5);
    expect(fills[0]!.sizeUsdc).toBeCloseTo(1.17, 6);
    expect(fills[0]!.fee).toBeGreaterThan(0);
  });

  it("extracts our maker fills from nested maker_orders instead of the top-level row", () => {
    const fills = mapTradeToPersonalFills(
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
            maker_address: "0xOurS",
            asset_id: "tok-our-yes",
            side: "BUY",
            matched_amount: "43.47",
            price: "0.11",
            fee_rate_bps: "1000",
          },
          {
            order_id: "ord-other",
            maker_address: "0xother",
            asset_id: "tok-other",
            side: "SELL",
            matched_amount: "999",
            price: "0.99",
            fee_rate_bps: "1000",
          },
        ],
      },
      "0xours",
    );

    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      fillId: "trade-maker#maker:0",
      orderId: "ord-ours",
      tokenId: "tok-our-yes",
      side: "buy",
      size: 43.47,
      price: 0.11,
      liquidityRole: "maker",
    });
  });
});

describe("mapMarket", () => {
  it("maps SDK market to domain ClobMarket", () => {
    const market = mapMarket({
      condition_id: "cond-1",
      tokens: [
        { token_id: "tok-yes", outcome: "Yes" },
        { token_id: "tok-no", outcome: "No" },
      ],
      question: "Will X happen?",
      slug: "will-x-happen",
      end_date_iso: "2026-12-31",
      active: true,
      neg_risk: false,
      minimum_tick_size: 0.01,
    });

    expect(market.conditionId).toBe("cond-1");
    expect(market.tokens).toHaveLength(2);
    expect(market.tokens[0]!.tokenId).toBe("tok-yes");
    expect(market.question).toBe("Will X happen?");
    expect(market.active).toBe(true);
    expect(market.tickSize).toBe(0.01);
  });

  it("handles missing tokens array", () => {
    const market = mapMarket({ condition_id: "c1" });
    expect(market.tokens).toEqual([]);
  });

  it("CLOB-path leaves gammaCreatedAt null (Gamma is the only source)", () => {
    const market = mapMarket({
      condition_id: "c1",
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(market.gammaCreatedAt).toBeNull();
  });
});

describe("mapOrderBook", () => {
  it("maps SDK order book to domain OrderBookSnapshot", () => {
    const tokenId = createTokenId("tok-1");
    const book = mapOrderBook(tokenId, {
      bids: [
        { price: "0.50", size: "100" },
        { price: "0.49", size: "200" },
      ],
      asks: [{ price: "0.52", size: "150" }],
      min_order_size: "5",
    });

    expect(book.tokenId).toBe("tok-1");
    expect(book.bids).toHaveLength(2);
    expect(book.asks).toHaveLength(1);
    expect(book.bids[0]!.price).toBe(0.5);
    expect(book.bestBid).toBe(0.5);
    expect(book.bestAsk).toBe(0.52);
    expect(book.midPrice).toBe(0.51);
    expect(book.spread).toBeCloseTo(0.02);
    expect(book.minOrderSize).toBe(5);
  });

  it("sorts unsorted bid and ask levels before deriving best prices", () => {
    const tokenId = createTokenId("tok-1");
    const book = mapOrderBook(tokenId, {
      bids: [
        { price: "0.001", size: "9700" },
        { price: "0.004", size: "693.83" },
        { price: "0.002", size: "2213.62" },
      ],
      asks: [
        { price: "0.999", size: "9007.1" },
        { price: "0.054", size: "80" },
        { price: "0.01", size: "255" },
      ],
    });

    expect(book.bids.map((level) => level.price)).toEqual([0.004, 0.002, 0.001]);
    expect(book.asks.map((level) => level.price)).toEqual([0.01, 0.054, 0.999]);
    expect(book.bestBid).toBe(0.004);
    expect(book.bestAsk).toBe(0.01);
    expect(book.midPrice).toBe(0.007);
    expect(book.spread).toBeCloseTo(0.006);
  });

  it("handles empty order book", () => {
    const book = mapOrderBook(createTokenId("tok-1"), {});
    expect(book.bids).toEqual([]);
    expect(book.bestBid).toBeNull();
    expect(book.midPrice).toBeNull();
  });

  it("normalizes numeric second timestamps into milliseconds", () => {
    const tokenId = createTokenId("tok-1");
    const book = mapOrderBook(tokenId, {
      timestamp: "1712345678",
    });

    expect(book.timestamp).toBe(1712345678000);
  });
});

describe("mapBalance", () => {
  it("normalizes atomic units to human-readable USDC", () => {
    const balance = mapBalance({ balance: "8995487", allowance: "2000000000" });
    expect(balance.asset).toBe("USDC");
    expect(balance.available).toBeCloseTo(8.995487, 6);
    // locked is always 0 — SDK doesn't provide real locked collateral info;
    // actual locked amount is computed by reconciliation from open orders
    expect(balance.locked).toBe(0);
  });

  it("reports zero locked regardless of allowance", () => {
    const balance = mapBalance({ balance: "1000000", allowance: "500000" });
    expect(balance.available).toBe(1);
    expect(balance.locked).toBe(0);
  });
});

// ─── Gamma mapper tests ───────────────────────────────────────────────────

describe("mapGammaMarket", () => {
  // Default eventContext for tests not exercising event-size telemetry.
  const SINGLE_MARKET_EVENT = { slug: null, marketCount: 1 } as const;

  it("maps a typical Gamma response to ClobMarket", () => {
    const market = mapGammaMarket(
      {
        conditionId: "cond-gamma-1",
        clobTokenIds: ["tok-yes-1", "tok-no-1"],
        outcomes: ["Yes", "No"],
        question: "Will BTC hit 100k?",
        slug: "bitcoin-above-100k",
        endDate: "2026-06-30T00:00:00Z",
        active: true,
        negRisk: true,
        orderPriceMinTickSize: 0.001,
      },
      SINGLE_MARKET_EVENT,
    );

    expect(market.conditionId).toBe("cond-gamma-1");
    expect(market.tokens).toHaveLength(2);
    expect(market.tokens[0]!.tokenId).toBe("tok-yes-1");
    expect(market.tokens[0]!.outcome).toBe("Yes");
    expect(market.tokens[1]!.tokenId).toBe("tok-no-1");
    expect(market.tokens[1]!.outcome).toBe("No");
    expect(market.question).toBe("Will BTC hit 100k?");
    expect(market.slug).toBe("bitcoin-above-100k");
    // toCanonicalIso round-trips through Date.parse -> toISOString, which always
    // renders milliseconds — ".000Z" is expected, not a passthrough of the input.
    expect(market.endDate).toBe("2026-06-30T00:00:00.000Z");
    expect(market.active).toBe(true);
    expect(market.negRisk).toBe(true);
    expect(market.tickSize).toBe(0.001);
  });

  it("zips clobTokenIds and outcomes into tokens array", () => {
    const market = mapGammaMarket(
      {
        clobTokenIds: ["a", "b", "c"],
        outcomes: ["Yes", "No", "Maybe"],
      },
      SINGLE_MARKET_EVENT,
    );

    expect(market.tokens).toEqual([
      { tokenId: "a", outcome: "Yes", outcomeIndex: 0 },
      { tokenId: "b", outcome: "No", outcomeIndex: 1 },
      { tokenId: "c", outcome: "Maybe", outcomeIndex: 2 },
    ]);
  });

  it("uses orderPriceMinTickSize for tickSize", () => {
    const market = mapGammaMarket({ orderPriceMinTickSize: 0.0001 }, SINGLE_MARKET_EVENT);
    expect(market.tickSize).toBe(0.0001);
  });

  it("maps Gamma liquidity and per-token admission prices", () => {
    const market = mapGammaMarket(
      {
        clobTokenIds: ["yes", "no"],
        outcomes: ["Yes", "No"],
        outcomePrices: ["0.32", "0.68"],
        bestBid: "0.31",
        bestAsk: "0.33",
        liquidity: "250.5",
      },
      SINGLE_MARKET_EVENT,
    );

    expect(market.liquidity).toBe(250.5);
    expect(market.tokens[0]).toMatchObject({
      tokenId: "yes",
      bestBid: 0.31,
      bestAsk: 0.33,
      midPrice: 0.32,
    });
    expect(market.tokens[1]).toMatchObject({
      tokenId: "no",
      bestBid: null,
      bestAsk: null,
      midPrice: 0.68,
    });
  });

  // ADR-007: lifetime `volumeNum` is the source for the `volume24h` field
  // (historical-universe-filter proxy for spec §0 R1 `trade_count > 0`).
  it("ADR-007: maps Gamma `volumeNum` (lifetime) into `volume24h`", () => {
    const market = mapGammaMarket(
      {
        volumeNum: 1_568_499.88,
        volume24hr: 5_733.78, // rolling 24h — MUST be ignored for this field
      },
      SINGLE_MARKET_EVENT,
    );
    expect(market.volume24h).toBe(1_568_499.88);
  });

  it("ADR-007: `volume24h` is null when `volumeNum` is absent (CLOB-path emulation)", () => {
    const market = mapGammaMarket({}, SINGLE_MARKET_EVENT);
    expect(market.volume24h).toBeNull();
  });

  it("ADR-007: `volume24h` is 0 when `volumeNum` is 0 (never-traded market)", () => {
    const market = mapGammaMarket({ volumeNum: 0 }, SINGLE_MARKET_EVENT);
    expect(market.volume24h).toBe(0);
  });

  it("handles missing fields with defaults", () => {
    const market = mapGammaMarket({}, SINGLE_MARKET_EVENT);

    expect(market.conditionId).toBe("");
    expect(market.tokens).toEqual([]);
    expect(market.question).toBe("");
    expect(market.slug).toBe("");
    expect(market.endDate).toBe("");
    expect(market.active).toBe(false);
    expect(market.negRisk).toBe(false);
    expect(market.tickSize).toBe(0.01);
  });

  it("defaults outcome to empty string when outcomes array is shorter than clobTokenIds", () => {
    const market = mapGammaMarket(
      {
        clobTokenIds: ["tok-1", "tok-2"],
        outcomes: ["Yes"],
      },
      SINGLE_MARKET_EVENT,
    );

    expect(market.tokens[0]!.outcome).toBe("Yes");
    expect(market.tokens[1]!.outcome).toBe("");
  });

  it("parses JSON-stringified clobTokenIds and outcomes (Gamma event nesting)", () => {
    const market = mapGammaMarket(
      {
        conditionId: "cond-nested",
        clobTokenIds: '["tok-yes","tok-no"]',
        outcomes: '["Yes","No"]',
        slug: "will-bitcoin-reach-200k",
        active: true,
      },
      SINGLE_MARKET_EVENT,
    );

    expect(market.tokens).toHaveLength(2);
    expect(market.tokens[0]!.tokenId).toBe("tok-yes");
    expect(market.tokens[0]!.outcome).toBe("Yes");
    expect(market.tokens[1]!.tokenId).toBe("tok-no");
    expect(market.tokens[1]!.outcome).toBe("No");
  });

  it("eventContext is required — caller must pass marketCount explicitly (ADR-019 §D2)", () => {
    // No-eventContext call is a compile error post-ADR-019. Pinning the
    // explicit single-market shape here for binary events.
    const market = mapGammaMarket({ slug: "bitcoin-above-100k" }, { slug: null, marketCount: 1 });
    expect(market.eventMarketCount).toBe(1);
  });

  it("eventMarketCount carries multi-market event count (e.g. Super Bowl with 30 outcomes)", () => {
    const market = mapGammaMarket(
      { slug: "super-bowl-winner" },
      { slug: "super-bowl-2026", marketCount: 30 },
    );
    expect(market.eventMarketCount).toBe(30);
    expect(market.eventSlug).toBe("super-bowl-2026");
  });

  it("eventContext.slug propagates to eventSlug field", () => {
    const market = mapGammaMarket(
      { slug: "bitcoin-above-200k" },
      { slug: "bitcoin-price-event", marketCount: 1 },
    );
    expect(market.eventSlug).toBe("bitcoin-price-event");
    expect(market.eventMarketCount).toBe(1);
  });

  it("null eventContext.slug leaves eventSlug undefined (no key set)", () => {
    const market = mapGammaMarket({ slug: "some-market" }, { slug: null, marketCount: 5 });
    expect(market.eventSlug).toBeUndefined();
    expect(market.eventMarketCount).toBe(5);
  });

  // Step 0 §P1.9 — `gammaCreatedAt` is the source for spec §1.7 R14 `age_at_entry`.
  // Validate ISO round-trip, null for missing, null for invalid.
  it("normalizes Gamma createdAt ISO string through Date round-trip", () => {
    const market = mapGammaMarket({ createdAt: "2026-04-15T08:30:00Z" }, SINGLE_MARKET_EVENT);
    expect(market.gammaCreatedAt).toBe("2026-04-15T08:30:00.000Z");
  });

  it("preserves sub-second precision in createdAt round-trip", () => {
    const market = mapGammaMarket({ createdAt: "2026-04-15T08:30:00.123Z" }, SINGLE_MARKET_EVENT);
    expect(market.gammaCreatedAt).toBe("2026-04-15T08:30:00.123Z");
  });

  it("normalizes timezone-offset createdAt to UTC", () => {
    const market = mapGammaMarket({ createdAt: "2026-04-15T10:30:00+02:00" }, SINGLE_MARKET_EVENT);
    expect(market.gammaCreatedAt).toBe("2026-04-15T08:30:00.000Z");
  });

  it("returns null when createdAt is missing", () => {
    const market = mapGammaMarket({}, SINGLE_MARKET_EVENT);
    expect(market.gammaCreatedAt).toBeNull();
  });

  it("returns null when createdAt is empty string", () => {
    const market = mapGammaMarket({ createdAt: "" }, SINGLE_MARKET_EVENT);
    expect(market.gammaCreatedAt).toBeNull();
  });

  it("returns null when createdAt is whitespace only", () => {
    const market = mapGammaMarket({ createdAt: "   " }, SINGLE_MARKET_EVENT);
    expect(market.gammaCreatedAt).toBeNull();
  });

  it("returns null when createdAt is unparseable", () => {
    const market = mapGammaMarket({ createdAt: "not-a-date" }, SINGLE_MARKET_EVENT);
    expect(market.gammaCreatedAt).toBeNull();
  });

  it("returns null when createdAt is non-string (number)", () => {
    const market = mapGammaMarket({ createdAt: 1700000000 }, SINGLE_MARKET_EVENT);
    expect(market.gammaCreatedAt).toBeNull();
  });

  it("returns null when createdAt is null", () => {
    const market = mapGammaMarket({ createdAt: null }, SINGLE_MARKET_EVENT);
    expect(market.gammaCreatedAt).toBeNull();
  });

  // Track B §4.2 — group-item + event tags collected/persisted for future Track C.
  describe("Track B strike-classifier fields", () => {
    it("maps groupItemTitle, numeric-string groupItemThreshold, and event tags", () => {
      const market = mapGammaMarket(
        {
          slug: "will-spain-win-the-2026-fifa-world-cup-963",
          groupItemTitle: "Spain",
          groupItemThreshold: "21",
        },
        { slug: "fifa-world-cup-2026", marketCount: 32, tags: ["sports", "soccer"] },
      );
      expect(market.groupItemTitle).toBe("Spain");
      expect(market.groupItemThreshold).toBe("21");
      expect(market.tags).toEqual(["sports", "soccer"]);
    });

    it("coerces a numeric groupItemThreshold to string (§4.2 Gamma may send a number)", () => {
      const market = mapGammaMarket({ groupItemThreshold: 0 }, SINGLE_MARKET_EVENT);
      expect(market.groupItemThreshold).toBe("0");
    });

    it("treats empty/whitespace groupItemTitle as null", () => {
      const market = mapGammaMarket({ groupItemTitle: "   " }, SINGLE_MARKET_EVENT);
      expect(market.groupItemTitle).toBeNull();
    });

    it("defaults all three fields to null when absent", () => {
      const market = mapGammaMarket({}, SINGLE_MARKET_EVENT);
      expect(market.groupItemTitle).toBeNull();
      expect(market.groupItemThreshold).toBeNull();
      expect(market.tags).toBeNull();
    });

    it("tags default to null when eventContext omits them", () => {
      const market = mapGammaMarket({ slug: "x" }, { slug: "evt", marketCount: 2 });
      expect(market.tags).toBeNull();
    });
  });

  // Regression coverage for the production ingress bug: mapGammaMarket used to pass
  // `raw.endDate` through with a bare `String(...)`, so Gamma's zone-less
  // `YYYY-MM-DD HH:mm:ss` shape flowed straight to downstream `Date.parse` calls
  // (resolution/exit/ttc modules), which read a zone-less date-time as LOCAL time —
  // a 7h shift on a UTC+7 host. `toCanonicalIso` (shared with GammaResolutionClient
  // via @krabs/domain) now pins it to UTC at the mapper, the real
  // discovery ingress (market-discovery-gateway.ts -> mapGammaMarket).
  describe("endDate canonicalization (Gamma zone-less timestamp bug)", () => {
    const originalTz = process.env.TZ;

    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it("pins a zone-less endDate to UTC instead of the host-local timezone", () => {
      // Proves UTC pinning rather than host luck: on a UTC+7 host, naively
      // stripping/leaving the zone off (the pre-fix bug) would read
      // "2026-03-25 16:00:00" as 16:00 Bangkok time -> 09:00Z, a 7h shift of
      // the real market end time. Asserting under TZ=Asia/Bangkok makes a
      // local-time-parse regression fail this test even when CI itself runs UTC.
      process.env.TZ = "Asia/Bangkok";
      const market = mapGammaMarket({ endDate: "2026-03-25 16:00:00" }, SINGLE_MARKET_EVENT);
      expect(market.endDate).toBe("2026-03-25T16:00:00.000Z");
    });

    it("collapses an explicit bare +00 offset to the same instant", () => {
      process.env.TZ = "Asia/Bangkok";
      const market = mapGammaMarket({ endDate: "2026-03-25 16:00:00+00" }, SINGLE_MARKET_EVENT);
      expect(market.endDate).toBe("2026-03-25T16:00:00.000Z");
    });

    it("leaves an already-canonical endDate unchanged", () => {
      const market = mapGammaMarket({ endDate: "2026-03-25T16:00:00.000Z" }, SINGLE_MARKET_EVENT);
      expect(market.endDate).toBe("2026-03-25T16:00:00.000Z");
    });

    it("still falls back to '' for a missing/unparseable endDate (regression guard on the old contract)", () => {
      expect(mapGammaMarket({}, SINGLE_MARKET_EVENT).endDate).toBe("");
      expect(mapGammaMarket({ endDate: "not-a-date" }, SINGLE_MARKET_EVENT).endDate).toBe("");
    });
  });
});

describe("mapGammaPricing", () => {
  it("extracts bestBid, bestAsk, lastTradePrice", () => {
    const pricing = mapGammaPricing({
      bestBid: 0.45,
      bestAsk: 0.55,
      lastTradePrice: 0.5,
    });

    expect(pricing.bestBid).toBe(0.45);
    expect(pricing.bestAsk).toBe(0.55);
    expect(pricing.lastTradePrice).toBe(0.5);
  });

  it("returns null for missing pricing fields", () => {
    const pricing = mapGammaPricing({});

    expect(pricing.bestBid).toBeNull();
    expect(pricing.bestAsk).toBeNull();
    expect(pricing.lastTradePrice).toBeNull();
  });

  it("handles string numeric values by converting to number", () => {
    const pricing = mapGammaPricing({
      bestBid: "0.35",
      bestAsk: "0.65",
      lastTradePrice: "0.50",
    });

    expect(pricing.bestBid).toBe(0.35);
    expect(pricing.bestAsk).toBe(0.65);
    expect(pricing.lastTradePrice).toBe(0.5);
  });

  it("returns null when fields are explicitly null", () => {
    const pricing = mapGammaPricing({
      bestBid: null,
      bestAsk: null,
      lastTradePrice: null,
    });

    expect(pricing.bestBid).toBeNull();
    expect(pricing.bestAsk).toBeNull();
    expect(pricing.lastTradePrice).toBeNull();
  });
});
