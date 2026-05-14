import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapDatabase, type DbConnection } from "@krabs/db";
import { createTokenId } from "@krabs/domain";
import { LatestUsablePriceLookup } from "../market-snapshot-pricing.js";

const TOKEN = createTokenId("tok-price");
const OTHER_TOKEN = createTokenId("tok-other-price");
const NOW_MS = Date.parse("2026-05-14T12:00:00.000Z");

describe("LatestUsablePriceLookup", () => {
  let conn: DbConnection;

  beforeEach(() => {
    conn = bootstrapDatabase(":memory:");
    insertMarket(String(TOKEN));
    insertMarket(String(OTHER_TOKEN));
  });

  afterEach(() => {
    conn.close();
  });

  it("returns midpoint from the latest row with bid and ask", () => {
    insertSnapshot(String(TOKEN), -60_000, { bestBid: 0.19, bestAsk: 0.21, lastPrice: 0.99 });

    expect(new LatestUsablePriceLookup(conn.db).findUsablePrice(TOKEN, NOW_MS)).toBeCloseTo(0.2);
  });

  it("iterates past an all-null latest row to an earlier bid and ask midpoint", () => {
    insertSnapshot(String(TOKEN), -30_000, {});
    insertSnapshot(String(TOKEN), -60_000, { bestBid: 0.01, bestAsk: 0.02 });

    expect(new LatestUsablePriceLookup(conn.db).findUsablePrice(TOKEN, NOW_MS)).toBeCloseTo(0.015);
  });

  it("returns last_price when no row has a usable bid and ask pair", () => {
    insertSnapshot(String(TOKEN), -30_000, { bestBid: null, bestAsk: null, lastPrice: 0.37 });

    expect(new LatestUsablePriceLookup(conn.db).findUsablePrice(TOKEN, NOW_MS)).toBeCloseTo(0.37);
  });

  it("prefers any bid and ask midpoint over a newer last_price", () => {
    insertSnapshot(String(TOKEN), -30_000, { lastPrice: 0.9 });
    insertSnapshot(String(TOKEN), -60_000, { bestBid: 0.3, bestAsk: 0.5 });

    expect(new LatestUsablePriceLookup(conn.db).findUsablePrice(TOKEN, NOW_MS)).toBeCloseTo(0.4);
  });

  it("ignores snapshots outside the 7-day default window", () => {
    insertSnapshot(String(TOKEN), -(7 * 24 * 60 * 60 * 1000 + 1), {
      bestBid: 0.3,
      bestAsk: 0.5,
      lastPrice: 0.4,
    });

    expect(new LatestUsablePriceLookup(conn.db).findUsablePrice(TOKEN, NOW_MS)).toBeNull();
  });

  it("respects maxRowsScanned", () => {
    insertSnapshot(String(TOKEN), -10_000, {});
    insertSnapshot(String(TOKEN), -20_000, {});
    insertSnapshot(String(TOKEN), -30_000, { bestBid: 0.2, bestAsk: 0.4 });

    expect(
      new LatestUsablePriceLookup(conn.db, { maxRowsScanned: 2 }).findUsablePrice(TOKEN, NOW_MS),
    ).toBeNull();
  });

  it("returns null when there are no rows for the token", () => {
    insertSnapshot(String(OTHER_TOKEN), -10_000, { bestBid: 0.2, bestAsk: 0.4 });

    expect(new LatestUsablePriceLookup(conn.db).findUsablePrice(TOKEN, NOW_MS)).toBeNull();
  });

  it("does not use zero bid or ask as a midpoint", () => {
    insertSnapshot(String(TOKEN), -10_000, { bestBid: 0, bestAsk: 0.4 });

    expect(new LatestUsablePriceLookup(conn.db).findUsablePrice(TOKEN, NOW_MS)).toBeNull();
  });

  it("does not use zero last_price", () => {
    insertSnapshot(String(TOKEN), -10_000, { lastPrice: 0 });

    expect(new LatestUsablePriceLookup(conn.db).findUsablePrice(TOKEN, NOW_MS)).toBeNull();
  });

  it("does not use negative values", () => {
    insertSnapshot(String(TOKEN), -10_000, {
      bestBid: -0.1,
      bestAsk: 0.4,
      lastPrice: -0.2,
    });

    expect(new LatestUsablePriceLookup(conn.db).findUsablePrice(TOKEN, NOW_MS)).toBeNull();
  });

  function insertMarket(tokenId: string): void {
    conn.db
      .prepare(
        `INSERT INTO markets
           (token_id, condition_id, slug, question, outcome, tick_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tokenId,
        `cond-${tokenId}`,
        `slug-${tokenId}`,
        "Question?",
        "Yes",
        0.01,
        new Date(NOW_MS).toISOString(),
        new Date(NOW_MS).toISOString(),
      );
  }

  function insertSnapshot(
    tokenId: string,
    offsetMs: number,
    values: {
      bestBid?: number | null;
      bestAsk?: number | null;
      lastPrice?: number | null;
    },
  ): void {
    conn.db
      .prepare(
        `INSERT INTO market_snapshots
           (token_id, best_bid, best_ask, last_price, captured_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        tokenId,
        values.bestBid ?? null,
        values.bestAsk ?? null,
        values.lastPrice ?? null,
        new Date(NOW_MS + offsetMs).toISOString(),
      );
  }
});
