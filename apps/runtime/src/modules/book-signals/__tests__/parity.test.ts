import Database, { type Database as BetterSqliteDatabase } from "better-sqlite3";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTokenId, type PriceLevel, type TokenId } from "@krabs/domain";
import { describe, expect, it } from "vitest";
import { TrackCBookSignalsProvider } from "../book-signals-provider.js";

interface Point1Fixture {
  readonly anchor_ts: number;
  readonly asset_id: string;
  readonly slug: string;
  readonly signals: {
    readonly bid_movement_30m: number | null;
    readonly bid_persistence_s: number | null;
    readonly public_trade_count_1h: number | null;
    readonly bid_depth_top3: number | null;
  };
}

interface WssRow {
  readonly id: number;
  readonly ts_utc: number;
  readonly event_type: "book" | "price_change" | "last_trade_price";
  readonly payload_json: string;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../../");
const fixturesPath = path.join(
  repoRoot,
  "research_plankton/track_c/point_1_islivebook_results.json",
);
const observerShardsDir = path.join(repoRoot, "research_plankton/data/observer_shards");

describe("Track G observer parity", () => {
  it("matches the São Paulo anchor that exposed parsable-state divergence", () => {
    const fixture = loadPoint1Fixtures().find(
      (item) => item.slug === "highest-temperature-in-sao-paulo-on-may-27-2026-18c",
    );
    if (!fixture) throw new Error("Missing São Paulo parity fixture");

    const signals = replayFixture(fixture);
    expect(signals.bidPersistenceS).toBe(141);
    expect(signals.bidMovement30m).toBe(fixture.signals.bid_movement_30m);
    expect(signals.publicTradeCount1h).toBe(fixture.signals.public_trade_count_1h);
    expect(signals.depthTop3).toBe(fixture.signals.bid_depth_top3);
  });

  it("matches the Wuhan anchor that exposed depthTop3 sum-order divergence", () => {
    const fixture = loadPoint1Fixtures().find(
      (item) => item.slug === "highest-temperature-in-wuhan-on-may-29-2026-25c",
    );
    if (!fixture) throw new Error("Missing Wuhan parity fixture");

    const signals = replayFixture(fixture);
    expect(signals.depthTop3).toBe(170.76);
    expect(signals.bidPersistenceS).toBe(fixture.signals.bid_persistence_s);
    expect(signals.bidMovement30m).toBe(fixture.signals.bid_movement_30m);
    expect(signals.publicTradeCount1h).toBe(fixture.signals.public_trade_count_1h);
  });

  it("matches observer signal values byte-for-byte on 30 point-1 anchors", () => {
    const fixtures = loadPoint1Fixtures().slice(0, 30);
    expect(fixtures).toHaveLength(30);

    for (const fixture of fixtures) {
      const signals = replayFixture(fixture);
      expect(signals.bidPersistenceS, fixture.slug).toBe(fixture.signals.bid_persistence_s);
      expect(signals.bidMovement30m, fixture.slug).toBe(fixture.signals.bid_movement_30m);
      expect(signals.publicTradeCount1h, fixture.slug).toBe(
        fixture.signals.public_trade_count_1h,
      );
      expect(signals.depthTop3, fixture.slug).toBe(fixture.signals.bid_depth_top3);
    }
  }, 60_000);
});

function replayFixture(fixture: Point1Fixture) {
  const tokenId = createTokenId(fixture.asset_id);
  const anchorMs = fixture.anchor_ts * 1000;
  const provider = new TrackCBookSignalsProvider();
  provider.setOpenPositionTokenIds([tokenId]);
  for (const row of loadRowsForFixture(fixture)) {
    replayRow(provider, tokenId, row);
  }
  return provider.getBookSignals(tokenId, anchorMs);
}

function loadPoint1Fixtures(): Point1Fixture[] {
  const data = JSON.parse(readFixtureFile(fixturesPath)) as unknown;
  const root = requireRecord(data, "point_1_islivebook_results.json root");
  const fixtures = requireRecord(root.fixtures, "fixtures");
  const alive = requireFixtureArray(fixtures.alive_anchors, "fixtures.alive_anchors");
  const dead = requireFixtureArray(fixtures.dead_anchors, "fixtures.dead_anchors");
  return [...alive, ...dead];
}

function loadRowsForFixture(fixture: Point1Fixture): WssRow[] {
  const stateStart = fixture.anchor_ts - 1800;
  const tradeStart = fixture.anchor_ts - 3600;
  const rows: WssRow[] = [];
  for (const dbPath of observerShardPaths()) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      if (!hasWssEventsTable(db)) continue;
      const rawRows = db
        .prepare(
          `SELECT id, ts_utc, event_type, payload_json
             FROM wss_events
            WHERE asset_id = ?
              AND (
                (event_type IN ('book', 'price_change') AND ts_utc >= ? AND ts_utc <= ?)
                OR (event_type = 'last_trade_price' AND ts_utc >= ? AND ts_utc < ?)
              )
            ORDER BY ts_utc ASC, id ASC`,
        )
        .all(fixture.asset_id, stateStart, fixture.anchor_ts, tradeStart, fixture.anchor_ts);
      for (const row of rawRows) {
        if (!isWssRow(row)) {
          throw new Error(`Malformed wss_events row for ${fixture.slug}`);
        }
        rows.push(row);
      }
    } finally {
      db.close();
    }
  }
  rows.sort((left, right) => left.ts_utc - right.ts_utc || left.id - right.id);
  return rows;
}

function replayRow(provider: TrackCBookSignalsProvider, tokenId: TokenId, row: WssRow): void {
  const payload = requireRecord(JSON.parse(row.payload_json) as unknown, "payload_json");
  const ts = row.ts_utc * 1000;
  if (row.event_type === "last_trade_price") {
    provider.ingestLastTradePrice({
      tokenId,
      ts,
      price: numberOrNull(payload.price ?? payload.last_trade_price),
    });
    return;
  }
  if (row.event_type === "price_change") {
    provider.ingestTopOfBook({
      tokenId,
      ts,
      bestBid: numberOrNull(payload.best_bid),
      bestAsk: numberOrNull(payload.best_ask),
    });
    return;
  }
  const bids = parsePriceLevels(payload.bids ?? payload.buys);
  const asks = parsePriceLevels(payload.asks ?? payload.sells);
  provider.ingestTopOfBook({
    tokenId,
    ts,
    bestBid: bestBidFromLevels(bids),
    bestAsk: bestAskFromLevels(asks),
  });
  provider.ingestBook({ tokenId, ts, bids });
}

function parsePriceLevels(raw: unknown): PriceLevel[] {
  if (!Array.isArray(raw)) return [];
  const levels: PriceLevel[] = [];
  for (const value of raw) {
    const level = parsePriceLevel(value);
    if (level) levels.push(level);
  }
  return levels;
}

function parsePriceLevel(value: unknown): PriceLevel | null {
  if (Array.isArray(value)) {
    const price = numberOrNull(value[0]);
    const size = numberOrNull(value[1]);
    return price == null || size == null ? null : { price, size };
  }
  const record = asRecord(value);
  if (!record) return null;
  const price = numberOrNull(record.price);
  const size = numberOrNull(record.size);
  return price == null || size == null ? null : { price, size };
}

function bestBidFromLevels(levels: readonly PriceLevel[]): number | null {
  if (levels.length === 0) return null;
  return Math.max(...levels.map((level) => level.price));
}

function bestAskFromLevels(levels: readonly PriceLevel[]): number | null {
  if (levels.length === 0) return null;
  return Math.min(...levels.map((level) => level.price));
}

function observerShardPaths(): string[] {
  return readdirSync(observerShardsDir)
    .filter((file) => file.endsWith(".db"))
    .map((file) => path.join(observerShardsDir, file))
    .filter((file) => existsSync(file));
}

function hasWssEventsTable(db: BetterSqliteDatabase): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wss_events'")
    .get();
  return asRecord(row)?.name === "wss_events";
}

function readFixtureFile(filePath: string): string {
  if (!existsSync(filePath)) throw new Error(`Missing fixture file: ${filePath}`);
  return readFileSync(filePath, "utf8");
}

function requireFixtureArray(value: unknown, label: string): Point1Fixture[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requirePoint1Fixture(item, `${label}[${index}]`));
}

function requirePoint1Fixture(value: unknown, label: string): Point1Fixture {
  const record = requireRecord(value, label);
  const signals = requireRecord(record.signals, `${label}.signals`);
  if (typeof record.anchor_ts !== "number") throw new Error(`${label}.anchor_ts must be number`);
  if (typeof record.asset_id !== "string") throw new Error(`${label}.asset_id must be string`);
  if (typeof record.slug !== "string") throw new Error(`${label}.slug must be string`);
  return {
    anchor_ts: record.anchor_ts,
    asset_id: record.asset_id,
    slug: record.slug,
    signals: {
      bid_movement_30m: nullableNumber(signals.bid_movement_30m, `${label}.bid_movement_30m`),
      bid_persistence_s: nullableNumber(signals.bid_persistence_s, `${label}.bid_persistence_s`),
      public_trade_count_1h: nullableNumber(
        signals.public_trade_count_1h,
        `${label}.public_trade_count_1h`,
      ),
      bid_depth_top3: nullableNumber(signals.bid_depth_top3, `${label}.bid_depth_top3`),
    },
  };
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be number or null`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new Error(`${label} must be an object`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isWssRow(value: unknown): value is WssRow {
  const record = asRecord(value);
  if (!record) return false;
  return (
    typeof record.id === "number" &&
    typeof record.ts_utc === "number" &&
    (record.event_type === "book" ||
      record.event_type === "price_change" ||
      record.event_type === "last_trade_price") &&
    typeof record.payload_json === "string"
  );
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
