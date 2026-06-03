import { readdirSync, readFileSync } from "node:fs";
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
  readonly best_bid?: number | null;
  readonly best_ask?: number | null;
  readonly bids?: readonly (readonly [number, number])[];
  readonly price?: number | null;
}

interface CommittedParityFixture extends Point1Fixture {
  readonly anchor_index: number;
  readonly events: readonly WssRow[];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../../");
const committedFixturesDir = path.join(
  repoRoot,
  "apps/runtime/src/modules/book-signals/__tests__/fixtures",
);

describe("Track G observer parity", () => {
  it("matches the São Paulo anchor that exposed parsable-state divergence", () => {
    const fixture = loadParityFixtures().find(
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
    const fixture = loadParityFixtures().find(
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
    const fixtures = loadParityFixtures();
    expect(fixtures).toHaveLength(30);

    for (const fixture of fixtures) {
      const signals = replayFixture(fixture);
      expect(signals.bidPersistenceS, fixture.slug).toBe(fixture.signals.bid_persistence_s);
      expect(signals.bidMovement30m, fixture.slug).toBe(fixture.signals.bid_movement_30m);
      expect(signals.publicTradeCount1h, fixture.slug).toBe(fixture.signals.public_trade_count_1h);
      expect(signals.depthTop3, fixture.slug).toBe(fixture.signals.bid_depth_top3);
    }
  }, 60_000);
});

function replayFixture(fixture: CommittedParityFixture) {
  const tokenId = createTokenId(fixture.asset_id);
  const anchorMs = fixture.anchor_ts * 1000;
  const provider = new TrackCBookSignalsProvider();
  provider.setOpenPositionTokenIds([tokenId]);
  for (const row of fixture.events) {
    replayRow(provider, tokenId, row);
  }
  return provider.getBookSignals(tokenId, anchorMs);
}

function loadParityFixtures(): CommittedParityFixture[] {
  // CI uses compact committed fixtures extracted from local observer shard DBs.
  // The DB-backed parity replay is intentionally dev-only because observer
  // shards are local research artifacts and are not committed.
  return readdirSync(committedFixturesDir)
    .filter((file) => /^parity-anchor-\d+\.json$/.test(file))
    .sort()
    .map((file) =>
      requireCommittedParityFixture(
        JSON.parse(readFixtureFile(path.join(committedFixturesDir, file))) as unknown,
        file,
      ),
    );
}

function replayRow(provider: TrackCBookSignalsProvider, tokenId: TokenId, row: WssRow): void {
  const ts = row.ts_utc * 1000;
  if (row.event_type === "last_trade_price") {
    provider.ingestLastTradePrice({
      tokenId,
      ts,
      price: row.price ?? null,
    });
    return;
  }
  if (row.event_type === "price_change") {
    provider.ingestTopOfBook({
      tokenId,
      ts,
      bestBid: row.best_bid ?? null,
      bestAsk: row.best_ask ?? null,
    });
    return;
  }
  provider.ingestTopOfBook({
    tokenId,
    ts,
    bestBid: row.best_bid ?? null,
    bestAsk: row.best_ask ?? null,
  });
  const bids = parseCommittedPriceLevels(row.bids ?? []);
  provider.ingestBook({ tokenId, ts, bids });
}

function parseCommittedPriceLevels(raw: readonly (readonly [number, number])[]): PriceLevel[] {
  return raw.map(([price, size]) => ({ price, size }));
}

function readFixtureFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function requireCommittedParityFixture(value: unknown, label: string): CommittedParityFixture {
  const record = requireRecord(value, label);
  const signals = requireRecord(record.signals, `${label}.signals`);
  const events = requireWssRows(record.events, `${label}.events`);
  if (typeof record.anchor_index !== "number") {
    throw new Error(`${label}.anchor_index must be number`);
  }
  if (typeof record.anchor_ts !== "number") throw new Error(`${label}.anchor_ts must be number`);
  if (typeof record.asset_id !== "string") throw new Error(`${label}.asset_id must be string`);
  if (typeof record.slug !== "string") throw new Error(`${label}.slug must be string`);
  return {
    anchor_index: record.anchor_index,
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
    events,
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
  if (
    !(
      typeof record.id === "number" &&
      typeof record.ts_utc === "number" &&
      (record.event_type === "book" ||
        record.event_type === "price_change" ||
        record.event_type === "last_trade_price")
    )
  ) {
    return false;
  }
  if (record.event_type === "book") return isOptionalLevelArray(record.bids);
  return true;
}

function requireWssRows(value: unknown, label: string): WssRow[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    if (!isWssRow(item)) throw new Error(`${label}[${index}] is malformed`);
    return item;
  });
}

function isOptionalLevelArray(value: unknown): value is readonly (readonly [number, number])[] {
  if (value == null) return true;
  if (!Array.isArray(value)) return false;
  return value.every(
    (level) =>
      Array.isArray(level) &&
      level.length === 2 &&
      typeof level[0] === "number" &&
      typeof level[1] === "number",
  );
}
