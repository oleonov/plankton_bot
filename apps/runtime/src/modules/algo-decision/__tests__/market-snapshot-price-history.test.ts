import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createTokenId, type NormalizedMarket } from "@krabs/domain";
import { MarketSnapshotPriceHistoryProvider } from "../market-snapshot-price-history.js";

describe("MarketSnapshotPriceHistoryProvider", () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  function setupDb(): Database.Database {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE market_snapshots (
        token_id TEXT NOT NULL,
        best_bid REAL,
        best_ask REAL,
        last_price REAL,
        captured_at TEXT NOT NULL
      );
    `);
    return db;
  }

  function makeMarket(
    tokenId: string,
    price: { bid?: number | null; ask?: number | null; mid?: number | null },
    snapshotTs: number,
  ): NormalizedMarket {
    const bestBid = price.bid ?? null;
    const bestAsk = price.ask ?? null;
    const midPrice =
      price.mid ??
      (bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk));
    return {
      tokenId: createTokenId(tokenId),
      conditionId: `cond-${tokenId}`,
      slug: tokenId,
      eventSlug: null,
      eventMarketCount: 1,
      question: tokenId,
      outcome: "Yes",
      regime: null,
      horizon: null,
      endDate: null,
      active: true,
      tradable: true,
      tickSize: 0.01,
      negRisk: false,
      acceptingOrders: true,
      enableOrderBook: true,
      bestBid,
      bestAsk,
      midPrice,
      spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : null,
      gammaCreatedAt: null,
      snapshotTs,
    };
  }

  it("computes the max normalized midpoint inside the requested window", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const insert = conn.prepare(
      "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("tok", 0.09, 0.11, null, "2026-05-18T10:00:00.000Z");
    insert.run("tok", 0.18, 0.22, null, "2026-05-18T11:00:00.000Z");
    insert.run("tok", 0.15, 0.17, null, "2026-05-18T12:00:00.000Z");
    insert.run("tok", 0.48, 0.52, null, "2026-05-17T11:59:59.000Z");

    const provider = new MarketSnapshotPriceHistoryProvider(conn);

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 24 * 60 * 60_000, now)).toBeCloseTo(
      0.2,
      8,
    );
  });

  it("falls back to last_price and returns null when no window rows have price", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const insert = conn.prepare(
      "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("tok", null, null, 0.07, "2026-05-18T11:00:00.000Z");
    insert.run("other", null, null, null, "2026-05-18T11:00:00.000Z");

    const provider = new MarketSnapshotPriceHistoryProvider(conn);

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now)).toBe(0.07);
    expect(provider.maxMidpointInWindow(createTokenId("other"), 60 * 60_000, now)).toBeNull();
    expect(provider.maxMidpointInWindow(createTokenId("missing"), 60 * 60_000, now)).toBeNull();
  });

  it("computes midpoint range stats for entry fresh-edge telemetry", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const insert = conn.prepare(
      "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("tok", 0.09, 0.11, null, "2026-05-18T11:10:00.000Z");
    insert.run("tok", 0.29, 0.31, null, "2026-05-18T11:30:00.000Z");
    insert.run("tok", null, null, 0.2, "2026-05-18T11:50:00.000Z");
    insert.run("tok", 0.79, 0.81, null, "2026-05-18T10:59:59.000Z");

    const provider = new MarketSnapshotPriceHistoryProvider(conn);

    expect(provider.midpointStatsInWindow(createTokenId("tok"), 60 * 60_000, now)).toMatchObject({
      minMidpoint: 0.1,
      maxMidpoint: 0.3,
      minAtMs: Date.parse("2026-05-18T11:10:00.000Z"),
      maxAtMs: Date.parse("2026-05-18T11:30:00.000Z"),
      firstMidpoint: 0.1,
      lastMidpoint: 0.2,
      sampleCount: 3,
    });
  });

  it("caches window max results briefly to avoid per-tick full DB rescans", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const insert = conn.prepare(
      "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("tok", 0.09, 0.11, null, "2026-05-18T11:00:00.000Z");

    const provider = new MarketSnapshotPriceHistoryProvider(conn);

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now)).toBeCloseTo(
      0.1,
      8,
    );

    insert.run("tok", 0.29, 0.31, null, "2026-05-18T12:00:01.000Z");

    expect(
      provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now + 1_000),
    ).toBeCloseTo(0.1, 8);
    expect(
      provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now + 61_000),
    ).toBeCloseTo(0.3, 8);
  });

  it("tracks window max cache hit rate", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    conn
      .prepare(
        "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("tok", 0.09, 0.11, null, "2026-05-18T11:00:00.000Z");
    const provider = new MarketSnapshotPriceHistoryProvider(conn);

    provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now);
    provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now + 1_000);

    expect(provider.getWindowMaxCacheMetrics()).toMatchObject({
      invocations: 2,
      hits: 1,
      misses: 1,
      hitRate: 0.5,
      entries: 1,
    });
  });

  it("serves window max from observed in-memory samples without sync DB fallback", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    conn
      .prepare(
        "INSERT INTO market_snapshots (token_id, best_bid, best_ask, last_price, captured_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("tok", 0.49, 0.51, null, "2026-05-18T11:00:00.000Z");
    const provider = new MarketSnapshotPriceHistoryProvider(conn, { syncMissLookup: false });

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now)).toBeNull();

    provider.observeMarket(makeMarket("tok", { bid: 0.09, ask: 0.11 }, now - 10_000));
    provider.observeMarket(makeMarket("tok", { bid: 0.19, ask: 0.21 }, now - 5_000));

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now)).toBeCloseTo(
      0.2,
      8,
    );
  });

  it("evicts cached window maxima when a fresher market sample is observed", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const provider = new MarketSnapshotPriceHistoryProvider(conn, { syncMissLookup: false });

    provider.observeMarket(makeMarket("tok", { bid: 0.09, ask: 0.11 }, now - 10_000));
    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now)).toBeCloseTo(
      0.1,
      8,
    );

    provider.observeMarket(makeMarket("tok", { bid: 0.29, ask: 0.31 }, now - 1_000));

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60 * 60_000, now)).toBeCloseTo(
      0.3,
      8,
    );
  });

  it("globally prunes expired samples and invalidates cached maxima immediately", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const provider = new MarketSnapshotPriceHistoryProvider(conn, {
      syncMissLookup: false,
      memorySampleMaxAgeMs: 1_000,
    });

    provider.observeMarket(makeMarket("stale", { mid: 0.4 }, now - 2_000));
    expect(provider.maxMidpointInWindow(createTokenId("stale"), 60_000, now - 1_500)).toBe(0.4);

    provider.observeMarket(makeMarket("fresh", { mid: 0.2 }, now));

    const metrics = provider.snapshotMemoryMetrics(now);
    expect(provider.maxMidpointInWindow(createTokenId("stale"), 60_000, now)).toBeNull();
    expect(metrics).toEqual({
      tokenCount: 1,
      sampleCount: 1,
      samplesPerTokenP50: 1,
      samplesPerTokenP95: 1,
      samplesPerTokenMax: 1,
      observedSamples: 2,
      agePrunedSamples: 1,
      capacityPrunedSamples: 0,
      evictedTokens: 0,
      evictedSamples: 0,
      maxAgeMs: 1_000,
      maxSamplesPerToken: 2_000,
    });
  });

  it("distinguishes capacity pruning and reports samples-per-token percentiles", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const provider = new MarketSnapshotPriceHistoryProvider(conn, {
      syncMissLookup: false,
      memorySampleMaxPerToken: 2,
    });

    provider.observeMarket(makeMarket("two", { mid: 0.1 }, now - 2));
    provider.observeMarket(makeMarket("two", { mid: 0.2 }, now - 1));
    provider.observeMarket(makeMarket("two", { mid: 0.3 }, now));
    provider.observeMarket(makeMarket("one", { mid: 0.4 }, now));

    expect(provider.snapshotMemoryMetrics(now)).toMatchObject({
      tokenCount: 2,
      sampleCount: 3,
      samplesPerTokenP50: 1,
      samplesPerTokenP95: 2,
      samplesPerTokenMax: 2,
      observedSamples: 4,
      agePrunedSamples: 0,
      capacityPrunedSamples: 1,
    });
  });

  it("explicitly evicts a token's samples and window cache", () => {
    const conn = setupDb();
    const now = Date.parse("2026-05-18T12:00:00.000Z");
    const provider = new MarketSnapshotPriceHistoryProvider(conn, { syncMissLookup: false });

    provider.observeMarket(makeMarket("tok", { mid: 0.4 }, now));
    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60_000, now)).toBe(0.4);

    provider.evictToken(createTokenId("tok"));

    expect(provider.maxMidpointInWindow(createTokenId("tok"), 60_000, now + 1)).toBeNull();
    expect(provider.snapshotMemoryMetrics(now + 1)).toMatchObject({
      tokenCount: 0,
      sampleCount: 0,
      samplesPerTokenP50: null,
      samplesPerTokenP95: null,
      samplesPerTokenMax: null,
      evictedTokens: 1,
      evictedSamples: 1,
    });
  });
});
