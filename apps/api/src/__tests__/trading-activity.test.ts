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
  opts: {
    version?: number | null;
    startedAt?: string | null;
    endedAt?: string | null;
    ordersAccepted?: number | null;
    orderNotionalUsdc?: number | null;
    fillsReceived?: number | null;
    fillNotionalUsdc?: number | null;
    rejectionReasons?: string | null;
  } = {},
) {
  const endMs = Date.parse(capturedAt);
  const startedAt = opts.startedAt ?? new Date(endMs - 10 * 60 * 1000).toISOString();
  conn.db
    .prepare(
      `INSERT INTO trading_state_snapshots
         (trading_state, signals_produced, signals_approved, signals_rejected, captured_at,
          window_version, window_started_at, window_ended_at, orders_accepted,
          order_notional_usdc, fills_received, fill_notional_usdc, rejection_reasons_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      state,
      produced,
      approved,
      rejected,
      capturedAt,
      opts.version === undefined ? 2 : opts.version,
      startedAt,
      opts.endedAt ?? capturedAt,
      opts.ordersAccepted ?? 0,
      opts.orderNotionalUsdc ?? 0,
      opts.fillsReceived ?? 0,
      opts.fillNotionalUsdc ?? 0,
      opts.rejectionReasons ?? "{}",
    );
}

function replaceActivityHeartbeat(
  windowStartedAtMs: number,
  capturedAt: string,
  botRunId = "run-current",
) {
  conn.db.prepare("DELETE FROM runtime_metrics WHERE metric_name = 'signal_activity'").run();
  conn.db.prepare("DELETE FROM bot_runs").run();
  conn.db
    .prepare("INSERT INTO bot_runs (run_id, mode, started_at) VALUES (?, 'simulation', ?)")
    .run(botRunId, new Date(windowStartedAtMs).toISOString());
  conn.db
    .prepare(
      `INSERT INTO runtime_metrics (metric_name, value, labels, captured_at)
       VALUES ('signal_activity', 1, ?, ?)`,
    )
    .run(JSON.stringify({ durableWindowStartedAtMs: windowStartedAtMs, botRunId }), capturedAt);
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
    insertSnapshot("ACTIVELY_TRADING", 30, 5, 25, oneDayAgo);

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
    expect(body.data.items[1].tradingState).toBe("ACTIVELY_TRADING");
    expect(body.data.coverage.gaps.at(-1).kind).toBe("missing");
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
    insertSnapshot("ACTIVELY_TRADING", 10, 1, 9, thirteenDaysAgo);

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

    insertSnapshot("ACTIVELY_TRADING", 10, 1, 9, thirteenDaysAgo);
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
    expect(body.data.items[0].tradingState).toBe("ACTIVELY_TRADING");
  });

  it("respects valid days param within range", async () => {
    conn.db.prepare("DELETE FROM trading_state_snapshots").run();

    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();

    insertSnapshot("ACTIVELY_TRADING", 10, 1, 9, oneDayAgo);
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
    expect(body.data.items[0].tradingState).toBe("ACTIVELY_TRADING");
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
      insertSnapshot("NO_SIGNALS", 1, 1, 0, "2026-08-04 20:00:00");
      // Also inside the window, ISO rendering, chronologically LATER than SPACE_INSIDE — proves the
      // returned order is chronological, not merely "everything after the cutoff, any order".
      insertSnapshot("ACTIVELY_TRADING", 2, 2, 0, "2026-08-04T23:00:00.000Z");
      // Genuinely OUTSIDE the window (more than a full day before the cutoff, cross-day comparison
      // so unaffected by the bug) — the control: a handler that just returns every row can't satisfy
      // the assertion below either.
      insertSnapshot("EXITS_ONLY", 3, 3, 0, "2026-08-03T00:00:00.000Z");

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metrics/trading-activity?days=1",
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = json(res);
      expect(body.ok).toBe(true);
      expect(body.data.items.map((item: { tradingState: string }) => item.tradingState)).toEqual([
        "NO_SIGNALS",
        "ACTIVELY_TRADING",
      ]);
    } finally {
      vi.useRealTimers();
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("returns only contained valid v2 intervals with union gaps and exclusion counts", async () => {
    conn.db.prepare("DELETE FROM trading_state_snapshots").run();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-04T12:00:00.000Z"));
    try {
      insertSnapshot("ACTIVELY_TRADING", 4, 2, 2, "2026-09-03T12:20:00.000Z", {
        startedAt: "2026-09-03T12:10:00.000Z",
        ordersAccepted: 2,
        orderNotionalUsdc: 3.5,
        fillsReceived: 1,
        fillNotionalUsdc: 1.25,
        rejectionReasons: '{"max_open_value":2}',
      });
      insertSnapshot("PAUSED", 0, 0, 0, "2026-09-04T11:50:00.000Z", {
        startedAt: "2026-09-04T11:40:00.000Z",
      });
      insertSnapshot("NO_SIGNALS", 0, 0, 0, "2026-09-03T12:05:00.000Z", {
        startedAt: "2026-09-03T11:55:00.000Z",
      });
      insertSnapshot("NO_SIGNALS", 0, 0, 0, "2026-09-03T12:50:00.000Z", {
        version: null,
        startedAt: null,
        endedAt: null,
      });
      insertSnapshot("NO_SIGNALS", 0, 0, 0, "2026-09-03T13:00:00.000Z", {
        startedAt: "2026-09-03T13:00:00.000Z",
        rejectionReasons: "[]",
      });
      replaceActivityHeartbeat(Date.parse("2026-09-04T11:50:00.000Z"), "2026-09-04T11:59:45.000Z");

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metrics/trading-activity?days=1",
        headers: authHeaders(),
      });
      const data = json(res).data;

      expect(data.items).toHaveLength(2);
      expect(data.items[0]).toMatchObject({
        windowVersion: 2,
        ordersAccepted: 2,
        orderNotionalUsdc: 3.5,
        fillsReceived: 1,
        fillNotionalUsdc: 1.25,
        rejectionReasons: { max_open_value: 2 },
      });
      expect(data.coverage).toMatchObject({
        coveredMs: 20 * 60 * 1000,
        gapMs: 23 * 60 * 60 * 1000 + 40 * 60 * 1000,
        gapCount: 3,
        excludedRows: { legacy: 1, invalid: 1, outsideRange: 1 },
      });
      expect(data.coverage.gaps.at(-1)).toMatchObject({
        startAt: "2026-09-04T11:50:00.000Z",
        endAt: "2026-09-04T12:00:00.000Z",
        kind: "collecting",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses only a fresh active-window heartbeat to distinguish restart gaps from collecting", async () => {
    conn.db.prepare("DELETE FROM trading_state_snapshots").run();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-09-04T12:00:00.000Z"));
    try {
      insertSnapshot("NO_SIGNALS", 0, 0, 0, "2026-09-04T11:52:00.000Z", {
        startedAt: "2026-09-04T11:42:00.000Z",
      });
      replaceActivityHeartbeat(Date.parse("2026-09-04T11:57:00.000Z"), "2026-09-04T11:59:45.000Z");

      const fresh = json(
        await app.inject({
          method: "GET",
          url: "/api/v1/metrics/trading-activity?days=1",
          headers: authHeaders(),
        }),
      ).data;
      expect(fresh.coverage.gaps.slice(-2)).toEqual([
        {
          startAt: "2026-09-04T11:52:00.000Z",
          endAt: "2026-09-04T11:57:00.000Z",
          durationMs: 300_000,
          kind: "missing",
        },
        {
          startAt: "2026-09-04T11:57:00.000Z",
          endAt: "2026-09-04T12:00:00.000Z",
          durationMs: 180_000,
          kind: "collecting",
        },
      ]);

      replaceActivityHeartbeat(Date.parse("2026-09-04T11:57:00.000Z"), "2026-09-04T11:58:00.000Z");
      const stale = json(
        await app.inject({
          method: "GET",
          url: "/api/v1/metrics/trading-activity?days=1",
          headers: authHeaders(),
        }),
      ).data;
      expect(stale.coverage.gaps.at(-1)).toMatchObject({
        startAt: "2026-09-04T11:52:00.000Z",
        endAt: "2026-09-04T12:00:00.000Z",
        kind: "missing",
      });
      expect(stale.coverage.gaps.some((gap: { kind: string }) => gap.kind === "collecting")).toBe(
        false,
      );

      replaceActivityHeartbeat(Date.parse("2026-09-04T11:57:00.000Z"), "not-a-timestamp");
      const malformed = json(
        await app.inject({
          method: "GET",
          url: "/api/v1/metrics/trading-activity?days=1",
          headers: authHeaders(),
        }),
      ).data;
      expect(malformed.coverage.gaps.at(-1)).toMatchObject({ kind: "missing" });
      expect(
        malformed.coverage.gaps.some((gap: { kind: string }) => gap.kind === "collecting"),
      ).toBe(false);

      replaceActivityHeartbeat(
        Date.parse("2026-09-04T11:57:00.000Z"),
        "2026-09-04T11:59:45.000Z",
        "run-previous",
      );
      conn.db
        .prepare("INSERT INTO bot_runs (run_id, mode, started_at) VALUES (?, 'simulation', ?)")
        .run("run-current", "2026-09-04T11:58:00.000Z");
      const restarted = json(
        await app.inject({
          method: "GET",
          url: "/api/v1/metrics/trading-activity?days=1",
          headers: authHeaders(),
        }),
      ).data;
      expect(restarted.coverage.gaps.at(-1)).toMatchObject({ kind: "missing" });
      expect(
        restarted.coverage.gaps.some((gap: { kind: string }) => gap.kind === "collecting"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
