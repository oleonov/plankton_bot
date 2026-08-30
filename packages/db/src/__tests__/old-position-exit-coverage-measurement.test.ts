import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const measurementPath = fileURLToPath(
  new URL("../../../../research/old_position_exit_coverage_2026-08-29.sql", import.meta.url),
);

describe("old position exit coverage measurement", () => {
  it("returns aggregate-only coverage and exclusion buckets in query-only mode", () => {
    const db = new Database(":memory:");
    createFixture(db);
    db.pragma("query_only = ON");
    const sql = readFileSync(measurementPath, "utf8");
    expect(sql).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|ATTACH|DETACH)\b/i,
    );

    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));

    expect(byBucket.get("active_tradable_no_working_sell")).toMatchObject({
      position_count: 6,
      never_had_sell_count: 5,
      lost_sell_count: 1,
    });
    expect(byBucket.get("intentional_working_sell_coverage")?.position_count).toBe(1);
    expect(byBucket.get("resolved_or_redeem")?.position_count).toBe(1);
    expect(byBucket.get("sub_min_5_share_floor")?.position_count).toBe(1);
    expect(byBucket.get("senior_owner_or_qd")?.position_count).toBe(2);
    expect(byBucket.get("actionable_missing_coverage")?.position_count).toBe(3);
    expect(Object.keys(rows[0] ?? {})).toEqual([
      "bucket",
      "position_count",
      "size_shares",
      "marked_value_usdc",
      "never_had_sell_count",
      "lost_sell_count",
    ]);
  });
});

function createFixture(db: Database.Database): void {
  db.exec(`
    CREATE TABLE positions (
      position_id TEXT PRIMARY KEY, token_id TEXT, size REAL, current_value_usdc REAL,
      status TEXT, exit_owner TEXT, opened_at TEXT
    );
    CREATE TABLE markets (
      token_id TEXT PRIMARY KEY, condition_id TEXT, active INTEGER, tradable INTEGER, end_date TEXT
    );
    CREATE TABLE orders (
      order_id TEXT PRIMARY KEY, token_id TEXT, position_id TEXT, side TEXT, status TEXT,
      decision_rule_id TEXT, created_at TEXT
    );
    CREATE TABLE market_resolutions (condition_id TEXT, detected_at TEXT);
    CREATE TABLE settlement_ledger (position_id TEXT, settled_at TEXT);
    CREATE TABLE risk_events (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, payload TEXT, created_at TEXT);

    INSERT INTO markets VALUES
      ('t-never', 'c-never', 1, 1, NULL), ('t-lost', 'c-lost', 1, 1, NULL),
      ('t-working', 'c-working', 1, 1, NULL), ('t-resolved', 'c-resolved', 1, 1, NULL),
      ('t-dust', 'c-dust', 1, 1, NULL), ('t-senior', 'c-senior', 1, 1, NULL),
      ('t-qd-cleared', 'c-qd-cleared', 1, 1, NULL), ('t-qd-active', 'c-qd-active', 1, 1, NULL);
    INSERT INTO positions VALUES
      ('p-never', 't-never', 10, 1, 'open', NULL, '2026-08-01T00:00:00Z'),
      ('p-lost', 't-lost', 10, 1, 'open', NULL, '2026-08-01T00:00:00Z'),
      ('p-working', 't-working', 10, 1, 'open', NULL, '2026-08-01T00:00:00Z'),
      ('p-resolved', 't-resolved', 10, 1, 'open', NULL, '2026-08-01T00:00:00Z'),
      ('p-dust', 't-dust', 4.999, 0.1, 'dust', NULL, '2026-08-01T00:00:00Z'),
      ('p-senior', 't-senior', 10, 1, 'open', 'profile', '2026-08-01T00:00:00Z'),
      ('p-qd-cleared', 't-qd-cleared', 10, 1, 'open', NULL, '2026-08-01T00:00:00Z'),
      ('p-qd-active', 't-qd-active', 10, 1, 'open', NULL, '2026-08-01T00:00:00Z');
    INSERT INTO orders VALUES
      ('o-lost', 't-lost', 'p-lost', 'sell', 'cancelled', 'PROFILE_LADDER', '2026-08-02T00:00:00Z'),
      ('o-working', 't-working', 'p-working', 'sell', 'open', 'BOUNCE_EXIT_TARGET', '2026-08-02T00:00:00Z'),
      ('o-future', 't-never', 'p-never', 'sell', 'open', 'BOUNCE_EXIT_TARGET', '2026-08-29 15:00:00');
    INSERT INTO market_resolutions VALUES
      ('c-resolved', '2026-08-20T00:00:00Z'),
      ('c-lost', '2026-08-29 15:00:00');
    INSERT INTO risk_events (event_type, payload, created_at) VALUES
      ('track_q_d', '{"tokenId":"t-qd-cleared","qdWouldActivate":true}', '2026-08-20T10:00:00Z'),
      ('track_q_d', '{"tokenId":"t-qd-cleared","qdWouldActivate":false}', '2026-08-20T11:00:00Z'),
      ('track_q_d', '{"tokenId":"t-qd-active","qdWouldActivate":false}', '2026-08-20T12:00:00Z'),
      ('track_q_d', '{"tokenId":"t-qd-active","qdWouldActivate":true}', '2026-08-20T12:00:00Z'),
      ('track_q_d', '{"tokenId":"t-qd-active","qdWouldActivate":false}', '2026-08-29 15:00:00');
  `);
}
