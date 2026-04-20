import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { bootstrapDatabase } from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import type { AppConfig } from "@plankton/config";
import { buildServer } from "../server.js";
import { stubLedgerPool } from "./test-helpers.js";

const TEST_API_KEY = "test-key-portfolio-series";

function testConfig(): AppConfig {
  return {
    runtimeMode: "simulation",
    logLevel: "error",
    dbPath: "",
    marketDataPollIntervalMs: 30_000,
    marketDataStaleThresholdMs: 120_000,
    strategyScanIntervalMs: 5_000,
    fillPollIntervalMs: 5_000,
    enableInventoryAutoMerge: false,
    executionMaxConcurrency: 4,
    polyApiKey: undefined,
    polyApiSecret: undefined,
    polyPassphrase: undefined,
    polyPrivateKey: undefined,
    planktonApiKey: TEST_API_KEY,
    planktonApiPort: 0,
    planktonAuthUsername: undefined,
    planktonAuthPassword: undefined,
    planktonSessionSecret: undefined,
    trustProxy: false,
  };
}

function auth() {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  // Monolithic bootstrap lacks control-only tables; create for fallback test
  conn.db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS profile_settings (
      profile_id           TEXT PRIMARY KEY,
      initial_balance_usdc REAL,
      relayer_json         TEXT
    );

    CREATE TABLE IF NOT EXISTS runtime_control_state (
      id INTEGER PRIMARY KEY,
      current_profile TEXT,
      desired_profile TEXT
    );
  `);
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

beforeEach(() => {
  conn.db.prepare("DELETE FROM portfolio_snapshots").run();
});

afterEach(() => {
  vi.restoreAllMocks();
  conn.db.prepare("DELETE FROM runtime_control_state").run();
  conn.db.prepare("DELETE FROM profile_settings WHERE profile_id = 'live-lite'").run();
  conn.db.prepare("DELETE FROM profiles WHERE profile_id = 'live-lite'").run();
  conn.db.prepare("DELETE FROM portfolio_snapshots WHERE profile = 'live-lite'").run();
});

function insertSnapshot(
  profile: string,
  equityUsdc: number,
  realizedPnlUsdc: number,
  positionValueUsdc: number,
  openValueUsdc: number,
  capturedAt: string,
) {
  conn.db
    .prepare(
      `INSERT INTO portfolio_snapshots (profile, equity_usdc, realized_pnl_usdc, position_value_usdc, open_value_usdc, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(profile, equityUsdc, realizedPnlUsdc, positionValueUsdc, openValueUsdc, capturedAt);
}

function minutesAgo(m: number): string {
  return new Date(Date.now() - m * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

describe("GET /metrics/portfolio-series", () => {
  it("returns empty items and zero baseline when no snapshots exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(0);
    expect(body.data.baseline).toBe(0);
    expect(body.data.currentEquity).toBe(0);
    expect(body.data.portfolioPnl).toBe(0);
    expect(body.data.interval).toBe("1d");
  });

  it("returns correct items with downsampled points", async () => {
    // Insert snapshots at different times, two within the same 5-minute bucket
    const t1 = minutesAgo(30);
    const t2 = minutesAgo(28); // same 5-min bucket as t1 if they round the same
    const t3 = minutesAgo(10);

    insertSnapshot("simulation", 100, 0, 50, 40, t1);
    insertSnapshot("simulation", 102, 1, 52, 40, t2); // should replace t1 in same bucket
    insertSnapshot("simulation", 110, 5, 60, 40, t3);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=1d",
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // Downsampling keeps the last snapshot per bucket (MAX(id))
    // t1 and t2 are 2 minutes apart — may or may not be same bucket depending
    // on exact minute boundaries, but we always get at least 2 distinct buckets
    expect(body.data.items.length).toBeGreaterThanOrEqual(2);
    // Last item should be the most recent snapshot
    const last = body.data.items[body.data.items.length - 1];
    expect(last.equityUsdc).toBe(110);
    expect(last.realizedPnlUsdc).toBe(5);
    expect(last.positionValueUsdc).toBe(60);
    expect(last.openValueUsdc).toBe(40);
  });

  it("returns openValueUsdc so the UI can chart holdings P/L instead of wallet equity", async () => {
    insertSnapshot("simulation", 100, 0, 12, 10, minutesAgo(30));
    insertSnapshot("simulation", 105, 1, 15, 10, minutesAgo(5));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=1d",
      headers: auth(),
    });
    const body = res.json();

    expect(body.ok).toBe(true);
    expect(body.data.items[0].openValueUsdc).toBe(10);
    expect(body.data.items[1].positionValueUsdc - body.data.items[1].openValueUsdc).toBe(5);
  });

  it("baseline is the first raw snapshot in the window", async () => {
    insertSnapshot("simulation", 100, 0, 50, 40, minutesAgo(60));
    insertSnapshot("simulation", 120, 10, 70, 40, minutesAgo(30));
    insertSnapshot("simulation", 130, 15, 80, 40, minutesAgo(5));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=1d",
      headers: auth(),
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    // Baseline should be the first snapshot's equity (100)
    expect(body.data.baseline).toBe(100);
  });

  it("portfolioPnl equals currentEquity minus baseline", async () => {
    insertSnapshot("simulation", 100, 0, 50, 40, minutesAgo(60));
    insertSnapshot("simulation", 125, 12, 75, 40, minutesAgo(5));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=1d",
      headers: auth(),
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.currentEquity).toBe(125);
    expect(body.data.baseline).toBe(100);
    expect(body.data.portfolioPnl).toBe(25);
  });

  it("different intervals use different bucket sizes", async () => {
    // Seed snapshots every 10 minutes for the past 2 hours
    for (let i = 120; i >= 0; i -= 10) {
      insertSnapshot("simulation", 100 + i, i, 50 + i, 40, minutesAgo(i));
    }

    const res1d = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=1d",
      headers: auth(),
    });
    const res1w = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=1w",
      headers: auth(),
    });

    const body1d = res1d.json();
    const body1w = res1w.json();

    // 1d uses 5-minute buckets, 1w uses 15-minute buckets
    // With 13 snapshots every 10 min, 5-min buckets yield ~13 points,
    // 15-min buckets yield fewer (each bucket covers 15 min)
    expect(body1d.data.items.length).toBeGreaterThanOrEqual(body1w.data.items.length);
  });

  it("uses raw snapshots for long intervals when history is still sparse", async () => {
    insertSnapshot("simulation", 100, 0, 50, 40, minutesAgo(60));
    insertSnapshot("simulation", 103, 2, 53, 40, minutesAgo(40));
    insertSnapshot("simulation", 107, 4, 57, 40, minutesAgo(20));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=1m",
      headers: auth(),
    });
    const body = res.json();

    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(3);
    expect(body.data.items[0].equityUsdc).toBe(100);
    expect(body.data.items[1].equityUsdc).toBe(103);
    expect(body.data.items[2].equityUsdc).toBe(107);
  });

  it("falls back to initial_balance_usdc when no snapshots exist", async () => {
    // Seed profile_settings with an initial balance
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc)
         VALUES ('simulation', 10000)`,
      )
      .run();

    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=1d",
        headers: auth(),
      });
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.data.items).toHaveLength(0);
      expect(body.data.baseline).toBe(10000);
      expect(body.data.currentEquity).toBe(10000);
      expect(body.data.portfolioPnl).toBe(0);
    } finally {
      conn.db.prepare("DELETE FROM profile_settings WHERE profile_id = 'simulation'").run();
    }
  });

  it("uses initial balance as baseline for 1d when coverage is incomplete", async () => {
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc)
         VALUES ('simulation', 10000)`,
      )
      .run();

    try {
      insertSnapshot("simulation", 10020, 10, 20, 15, minutesAgo(30));
      insertSnapshot("simulation", 10025, 12, 25, 15, minutesAgo(5));

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=1d",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.coverageComplete).toBe(false);
      expect(body.data.baseline).toBe(10000);
      expect(body.data.currentEquity).toBe(10025);
      expect(body.data.portfolioPnl).toBe(25);
      expect(body.data.historyStart).toBeTruthy();
    } finally {
      conn.db.prepare("DELETE FROM profile_settings WHERE profile_id = 'simulation'").run();
    }
  });

  it("falls back to defaultInitialBalanceUsdc when profile_settings balance is null", async () => {
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profiles (profile_id, display_name, created_at)
         VALUES ('live-lite', 'Live-Lite', '2026-03-30T00:00:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS runtime_control_state (
           id INTEGER PRIMARY KEY,
           current_profile TEXT,
           desired_profile TEXT
         )`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO runtime_control_state (id, current_profile, desired_profile)
         VALUES (1, 'live-lite', 'live-lite')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc)
         VALUES ('live-lite', NULL)`,
      )
      .run();

    insertSnapshot("live-lite", 77.5, 0, 5, 40, minutesAgo(30));
    insertSnapshot("live-lite", 76.6, 0, 4, 40, minutesAgo(5));

    const fallbackApp = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
      defaultInitialBalanceUsdc: 100,
    });

    try {
      const res = await fallbackApp.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=1d",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.coverageComplete).toBe(false);
      expect(body.data.baseline).toBe(100);
      expect(body.data.currentEquity).toBe(76.6);
      expect(body.data.portfolioPnl).toBeCloseTo(-23.4, 6);
    } finally {
      await fallbackApp.close();
    }
  });

  it("uses Polymarket user-pnl-api for live-lite when relayer funderAddress is configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00Z"));

    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profiles (profile_id, display_name, created_at)
         VALUES ('live-lite', 'Live-Lite', '2026-03-30T12:00:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS runtime_control_state (
           id INTEGER PRIMARY KEY,
           current_profile TEXT,
           desired_profile TEXT
         )`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO runtime_control_state (id, current_profile, desired_profile)
         VALUES (1, 'live-lite', 'live-lite')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc, relayer_json)
         VALUES ('live-lite', NULL, ?)`,
      )
      .run('{"walletType":"proxy","funderAddress":"0xf00df00df00df00df00df00df00df00df00df00d"}');

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { t: Date.parse("2026-04-05T12:30:00Z") / 1000, p: -17.731754 },
          { t: Date.parse("2026-04-06T11:30:00Z") / 1000, p: -43.41244 },
        ],
      } as Response),
    );

    const liveLiteApp = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
      defaultInitialBalanceUsdc: 100,
    });

    try {
      const res = await liveLiteApp.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=1d",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.baseline).toBeCloseTo(-17.731754, 6);
      expect(body.data.currentEquity).toBeCloseTo(-43.41244, 6);
      expect(body.data.portfolioPnl).toBeCloseTo(-25.680686, 6);
      expect(body.data.coverageComplete).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.items[0].capturedAt).toBe("2026-04-05T12:30:00.000Z");
    } finally {
      vi.useRealTimers();
      await liveLiteApp.close();
    }
  });

  it("uses the first external 1d point as baseline when the profile is older than one day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T01:29:00Z"));

    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profiles (profile_id, display_name, created_at)
         VALUES ('live-lite', 'Live-Lite', '2026-04-03T01:29:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS runtime_control_state (
           id INTEGER PRIMARY KEY,
           current_profile TEXT,
           desired_profile TEXT
         )`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO runtime_control_state (id, current_profile, desired_profile)
         VALUES (1, 'live-lite', 'live-lite')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc, relayer_json)
         VALUES ('live-lite', NULL, ?)`,
      )
      .run('{"walletType":"proxy","funderAddress":"0xf00df00df00df00df00df00df00df00df00df00d"}');

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { t: Date.parse("2026-04-06T03:00:00Z") / 1000, p: -30.735004 },
          { t: Date.parse("2026-04-06T21:00:00Z") / 1000, p: -47.98143 },
        ],
      } as Response),
    );

    const liveLiteApp = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
      defaultInitialBalanceUsdc: 100,
    });

    try {
      const res = await liveLiteApp.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=1d",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.baseline).toBeCloseTo(-30.735004, 6);
      expect(body.data.currentEquity).toBeCloseTo(-47.98143, 6);
      expect(body.data.portfolioPnl).toBeCloseTo(-17.246426, 6);
      expect(body.data.coverageComplete).toBe(true);
    } finally {
      vi.useRealTimers();
      await liveLiteApp.close();
    }
  });

  it("uses zero baseline for external ALL interval so headline shows full cumulative", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T02:00:00Z"));

    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profiles (profile_id, display_name, created_at)
         VALUES ('live-lite', 'Live-Lite', '2026-04-04T02:00:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS runtime_control_state (
           id INTEGER PRIMARY KEY,
           current_profile TEXT,
           desired_profile TEXT
         )`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO runtime_control_state (id, current_profile, desired_profile)
         VALUES (1, 'live-lite', 'live-lite')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc, relayer_json)
         VALUES ('live-lite', NULL, ?)`,
      )
      .run('{"walletType":"proxy","funderAddress":"0xf00df00df00df00df00df00df00df00df00df00d"}');

    // Matches real Polymarket response for ALL interval — `p` is cumulative
    // all-time PnL. Headline for ALL should show the raw latest value, NOT
    // latest - firstPoint (which would hide the first $1 of loss).
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { t: Date.parse("2026-04-04T00:00:00Z") / 1000, p: -1 },
          { t: Date.parse("2026-04-05T00:00:00Z") / 1000, p: -7.103299 },
          { t: Date.parse("2026-04-06T00:00:00Z") / 1000, p: -17.76856 },
          { t: Date.parse("2026-04-07T00:00:00Z") / 1000, p: -48.15537 },
          { t: Date.parse("2026-04-07T02:00:00Z") / 1000, p: -48.10861 },
        ],
      } as Response),
    );

    const liveLiteApp = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
      defaultInitialBalanceUsdc: 100,
    });

    try {
      const res = await liveLiteApp.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=all",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.baseline).toBe(0);
      expect(body.data.currentEquity).toBeCloseTo(-48.10861, 6);
      expect(body.data.portfolioPnl).toBeCloseTo(-48.10861, 6);
      expect(body.data.coverageComplete).toBe(true);
    } finally {
      vi.useRealTimers();
      await liveLiteApp.close();
    }
  });

  it("uses zero baseline for external 1M interval even when profile covers the window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T02:00:00Z"));

    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profiles (profile_id, display_name, created_at)
         VALUES ('live-lite', 'Live-Lite', '2026-02-06T02:00:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS runtime_control_state (
           id INTEGER PRIMARY KEY,
           current_profile TEXT,
           desired_profile TEXT
         )`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO runtime_control_state (id, current_profile, desired_profile)
         VALUES (1, 'live-lite', 'live-lite')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc, relayer_json)
         VALUES ('live-lite', NULL, ?)`,
      )
      .run('{"walletType":"proxy","funderAddress":"0xf00df00df00df00df00df00df00df00df00df00d"}');

    // Profile is 60 days old — coverage WOULD be "complete" for 1M, but we
    // still want to show raw cumulative all-time P/L for 1W/1M/ALL headline.
    // Only 1D uses a rolling baseline.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { t: Date.parse("2026-03-08T00:00:00Z") / 1000, p: -1 },
          { t: Date.parse("2026-04-07T00:00:00Z") / 1000, p: -48.15537 },
        ],
      } as Response),
    );

    const liveLiteApp = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
      defaultInitialBalanceUsdc: 100,
    });

    try {
      const res = await liveLiteApp.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=1m",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.baseline).toBe(0);
      expect(body.data.portfolioPnl).toBeCloseTo(-48.15537, 6);
      expect(body.data.coverageComplete).toBe(false);
    } finally {
      vi.useRealTimers();
      await liveLiteApp.close();
    }
  });

  it("keeps zero baseline for external series when account history does not cover the full interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00Z"));

    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profiles (profile_id, display_name, created_at)
         VALUES ('live-lite', 'Live-Lite', '2026-04-03T12:00:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS runtime_control_state (
           id INTEGER PRIMARY KEY,
           current_profile TEXT,
           desired_profile TEXT
         )`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO runtime_control_state (id, current_profile, desired_profile)
         VALUES (1, 'live-lite', 'live-lite')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc, relayer_json)
         VALUES ('live-lite', NULL, ?)`,
      )
      .run('{"walletType":"proxy","funderAddress":"0xf00df00df00df00df00df00df00df00df00df00d"}');

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { t: Date.parse("2026-04-03T12:00:00Z") / 1000, p: -1 },
          { t: Date.parse("2026-04-06T12:00:00Z") / 1000, p: -43.41244 },
        ],
      } as Response),
    );

    const liveLiteApp = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
      defaultInitialBalanceUsdc: 100,
    });

    try {
      const res = await liveLiteApp.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=1w",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.baseline).toBe(0);
      expect(body.data.currentEquity).toBeCloseTo(-43.41244, 6);
      expect(body.data.portfolioPnl).toBeCloseTo(-43.41244, 6);
      expect(body.data.coverageComplete).toBe(false);
    } finally {
      vi.useRealTimers();
      await liveLiteApp.close();
    }
  });

  it("falls back to local snapshots when Polymarket user-pnl-api is unavailable", async () => {
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profiles (profile_id, display_name, created_at)
         VALUES ('live-lite', 'Live-Lite', '2026-03-30T00:00:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS runtime_control_state (
           id INTEGER PRIMARY KEY,
           current_profile TEXT,
           desired_profile TEXT
         )`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO runtime_control_state (id, current_profile, desired_profile)
         VALUES (1, 'live-lite', 'live-lite')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc, relayer_json)
         VALUES ('live-lite', NULL, ?)`,
      )
      .run('{"walletType":"proxy","funderAddress":"0xf00df00df00df00df00df00df00df00df00df00d"}');
    insertSnapshot("live-lite", 77.5, 0, 5, 40, minutesAgo(30));
    insertSnapshot("live-lite", 76.6, 0, 4, 40, minutesAgo(5));

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => [],
      } as Response),
    );

    const fallbackApp = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: stubLedgerPool(),
      defaultInitialBalanceUsdc: 100,
    });

    try {
      const res = await fallbackApp.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=1d",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.baseline).toBe(100);
      expect(body.data.currentEquity).toBe(76.6);
      expect(body.data.portfolioPnl).toBeCloseTo(-23.4, 6);
      expect(body.data.coverageComplete).toBe(false);
    } finally {
      await fallbackApp.close();
    }
  });

  it("uses initial balance as baseline for longer intervals when coverage is incomplete", async () => {
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc)
         VALUES ('simulation', 10000)`,
      )
      .run();

    try {
      insertSnapshot("simulation", 10020, 10, 20, 15, minutesAgo(30));
      insertSnapshot("simulation", 10025, 12, 25, 15, minutesAgo(5));

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=1w",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.coverageComplete).toBe(false);
      expect(body.data.baseline).toBe(10000);
      expect(body.data.currentEquity).toBe(10025);
      expect(body.data.portfolioPnl).toBe(25);
      expect(body.data.historyStart).toBeTruthy();
    } finally {
      conn.db.prepare("DELETE FROM profile_settings WHERE profile_id = 'simulation'").run();
    }
  });

  it("marks ALL as incomplete when the profile is older than snapshot history", async () => {
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profiles (profile_id, display_name, created_at)
         VALUES ('simulation', 'Simulation', '2026-03-01T00:00:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT OR REPLACE INTO profile_settings (profile_id, initial_balance_usdc)
         VALUES ('simulation', 10000)`,
      )
      .run();

    try {
      insertSnapshot("simulation", 10010, 5, 10, 8, minutesAgo(30));
      insertSnapshot("simulation", 10025, 12, 25, 8, minutesAgo(5));

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/metrics/portfolio-series?interval=all",
        headers: auth(),
      });
      const body = res.json();

      expect(body.ok).toBe(true);
      expect(body.data.coverageComplete).toBe(false);
      expect(body.data.baseline).toBe(10000);
      expect(body.data.portfolioPnl).toBe(25);
    } finally {
      conn.db.prepare("DELETE FROM profile_settings WHERE profile_id = 'simulation'").run();
    }
  });

  it("filters snapshots by the current profile", async () => {
    // Insert snapshots for simulation and paper profiles
    insertSnapshot("simulation", 100, 0, 50, 40, minutesAgo(30));
    insertSnapshot("paper", 200, 10, 150, 120, minutesAgo(30));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=1d",
      headers: auth(),
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    // Default profile is simulation, so paper data should be excluded
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].equityUsdc).toBe(100);
  });

  it("defaults to 1d interval for unknown values", async () => {
    insertSnapshot("simulation", 100, 0, 50, 40, minutesAgo(30));

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=invalid",
      headers: auth(),
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.interval).toBe("1d");
    expect(body.data.items).toHaveLength(1);
  });
});
