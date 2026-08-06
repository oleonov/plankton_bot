import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { bootstrapDatabase } from "@krabs/db";
import type { DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

function json(res: { json: () => unknown }): any {
  return res.json();
}

const TEST_API_KEY = "test-key-trading-activity";

function testConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    runtimeMode: undefined,
    logLevel: "error",
    dbPath: "",
    marketDataPollIntervalMs: 30_000,
    marketDataStaleThresholdMs: 120_000,
    marketScanIntervalMs: 300_000,
    strategyScanIntervalMs: 5_000,
    fillPollIntervalMs: 5_000,
    enableInventoryAutoMerge: false,
    executionMaxConcurrency: 4,
    executionWalletBufferPct: 0.03,
    executionWalletBufferMinUsdc: 0.25,
    polyApiKey: undefined,
    polyApiSecret: undefined,
    polyPassphrase: undefined,
    polyPrivateKey: undefined,
    krabsApiKey: TEST_API_KEY,
    krabsApiPort: 0,
    krabsAuthUsername: undefined,
    krabsAuthPassword: undefined,
    krabsSessionSecret: undefined,
    allowSellSizeClamp: true,

    executionSellBalanceRejectBlockEnabled: true,

    executionSellBalanceRejectBlockMs: 60000,

    executionSellExchangeReservedEnabled: true,
    trustProxy: false,
    ...MARKET_DATA_TEST_DEFAULTS,
    ...overrides,
  };
}

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  app = await buildServer({
    config: testConfig(),
    controlDb: conn.db,
    ledgerDb: conn.db,
    ledgerPool: stubLedgerPool(),
  });
});

afterAll(async () => {
  await app.close();
  conn.close();
});

function insertSnapshot(
  state: string,
  produced: number,
  approved: number,
  rejected: number,
  capturedAt: string,
) {
  conn.db
    .prepare(
      `INSERT INTO trading_state_snapshots (trading_state, signals_produced, signals_approved, signals_rejected, captured_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(state, produced, approved, rejected, capturedAt);
}

describe("GET /metrics/trading-activity", () => {
  it("returns snapshots within the requested window", async () => {
    conn.db.prepare("DELETE FROM trading_state_snapshots").run();

    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString();

    insertSnapshot("ACTIVELY_TRADING", 100, 20, 80, fifteenDaysAgo);
    insertSnapshot("ALIVE_BUT_BLOCKED", 50, 0, 50, twoDaysAgo);
    insertSnapshot("PROBING_ONLY", 30, 5, 25, oneDayAgo);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/trading-activity",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0].tradingState).toBe("ALIVE_BUT_BLOCKED");
    expect(body.data.items[1].tradingState).toBe("PROBING_ONLY");
  });

  it("returns empty array when no data", async () => {
    conn.db.prepare("DELETE FROM trading_state_snapshots").run();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/trading-activity",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(0);
  });

  it("clamps days param to 1-14: zero defaults to 14", async () => {
    conn.db.prepare("DELETE FROM trading_state_snapshots").run();

    const thirteenDaysAgo = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
    insertSnapshot("PROBING_ONLY", 10, 1, 9, thirteenDaysAgo);

    // days=0 should clamp to 14, so a 13-day-old snapshot should be included
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/trading-activity?days=0",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
  });

  it("clamps days param to 1-14: value above 14 is clamped to 14", async () => {
    conn.db.prepare("DELETE FROM trading_state_snapshots").run();

    const thirteenDaysAgo = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

    insertSnapshot("PROBING_ONLY", 10, 1, 9, thirteenDaysAgo);
    insertSnapshot("ACTIVELY_TRADING", 20, 2, 18, fifteenDaysAgo);

    // days=30 should clamp to 14, so the 15-day-old snapshot is excluded
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/trading-activity?days=30",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].tradingState).toBe("PROBING_ONLY");
  });

  it("respects valid days param within range", async () => {
    conn.db.prepare("DELETE FROM trading_state_snapshots").run();

    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();

    insertSnapshot("PROBING_ONLY", 10, 1, 9, oneDayAgo);
    insertSnapshot("ACTIVELY_TRADING", 20, 2, 18, sixDaysAgo);

    // days=3 — only the 1-day-old snapshot should be included
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/trading-activity?days=3",
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].tradingState).toBe("PROBING_ONLY");
  });

  it("keeps a same-day space-form row that is chronologically inside the window but lexically outside it, in chronological order", async () => {
    conn.db.prepare("DELETE FROM trading_state_snapshots").run();

    // The route's `since` cutoff is derived from local-time `Date.setDate()`, so pin the host TZ to
    // UTC as well as freezing the instant itself — otherwise the calendar-day math below could land
    // on a different day depending on the machine's ambient timezone.
    const originalTz = process.env.TZ;
    process.env.TZ = "UTC";
    vi.useFakeTimers({ toFake: ["Date"] });
    const NOW_MS = Date.parse("2026-08-05T08:53:21.000Z");
    vi.setSystemTime(NOW_MS);
    try {
      // days=1 -> since = 2026-08-04T08:53:21.000Z (the ISO cutoff bind).
      // Chronologically INSIDE the window (20:00 on 08-04 is after the cutoff, same calendar day)
      // but rendered in SQLite's space form. ' ' (0x20) < 'T' (0x54), so a raw
      // `captured_at >= <ISO cutoff>` compares this row's string BELOW the cutoff and drops it from
      // the window — exactly the bug wrapping both sides in `ledgerInstant()` exists to fix.
      insertSnapshot("SPACE_INSIDE", 1, 1, 0, "2026-08-04 20:00:00");
      // Also inside the window, ISO rendering, chronologically LATER than SPACE_INSIDE — proves the
      // returned order is chronological, not merely "everything after the cutoff, any order".
      insertSnapshot("ISO_INSIDE", 2, 2, 0, "2026-08-04T23:00:00.000Z");
      // Genuinely OUTSIDE the window (more than a full day before the cutoff, cross-day comparison
      // so unaffected by the bug) — the control: a handler that just returns every row can't satisfy
      // the assertion below either.
      insertSnapshot("OUTSIDE_CONTROL", 3, 3, 0, "2026-08-03T00:00:00.000Z");

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metrics/trading-activity?days=1",
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(body.ok).toBe(true);
      expect(body.data.items.map((item: { tradingState: string }) => item.tradingState)).toEqual([
        "SPACE_INSIDE",
        "ISO_INSIDE",
      ]);
    } finally {
      vi.useRealTimers();
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
