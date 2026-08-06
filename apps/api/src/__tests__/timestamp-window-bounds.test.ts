import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootstrapDatabase, bootstrapLedgerDb, type DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { LedgerPool } from "../ledger-pool.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-key-timestamp-window-bounds";
const DAY_MS = 24 * 60 * 60_000;

function testConfig(): AppConfig {
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
  };
}

// SQLite legacy `datetime('now')` rendering: space separator, no fractional seconds, no zone suffix.
function toSpaceFormat(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

// Polymarket `closedTime` -> positions.closed_at rendering: same shape as toSpaceFormat plus a
// literal "+00" suffix. `julianday()` requires a `+HH:MM` modifier, so a bare "+00" is malformed —
// only `ledgerInstant()` (which strips it before parsing) can compare this shape at all.
function toGammaFormat(d: Date): string {
  return `${toSpaceFormat(d)}+00`;
}

// Every assertion below rests on a seeded row sharing a UTC calendar day with a cutoff the ROUTE
// derives from its own `Date.now()` at request time — that is the only span where ' ' sorting below
// 'T' can produce a wrong answer. With a live clock the property is probabilistic: a run that starts
// within a few minutes of UTC midnight puts row and cutoff on different days, where a raw TEXT
// compare is correct in both renderings, so the counterfactual claims would silently pass against
// the unfixed code. Only `Date` is faked — `setInterval`/`setTimeout` stay real so the SSE test's
// poll loop and its 8 s timeout still work — and the instant is pinned mid-day UTC so the
// minute-scale offsets below have room in both directions.
const FROZEN_NOW = new Date("2026-08-05T12:00:00.000Z");

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });

  conn = bootstrapDatabase(":memory:");
  const db = conn.db;

  const nowMs = Date.now();
  // Mirrors the routes' own `Date.now() - 7 * DAY_MS` / `- DAY_MS`. The handler recomputes these
  // a few ms later at request time; the minute-scale offsets below absorb that drift.
  const since7d = new Date(nowMs - 7 * DAY_MS);

  const insertPosition = db.prepare(
    `INSERT INTO positions (position_id, token_id, side, avg_entry_price, realized_pnl, status,
       opened_at, closed_at, updated_at)
     VALUES (?, ?, 'buy', 0.05, ?, 'closed', ?, ?, ?)`,
  );

  // (a) Gamma "+00" closed_at, 2 min INSIDE the 7d window, same calendar day as the cutoff.
  // Pre-fix `closed_at >= ?` is a plain TEXT compare against the ISO-rendered bind: on a shared
  // calendar day, `' '` (0x20, at the date/time separator) sorts below `'T'` (0x54) no matter what
  // the following time digits are, so this row compared as "before" the cutoff and was dropped —
  // not merely mis-ordered, excluded from the count entirely.
  // `updated_at` is seeded ISO on every row below: it was measured split only in the SQLite space
  // rendering, never in Gamma's, so reusing `closed_at`'s value there would fabricate a shape no
  // writer emits. Nothing under test reads it — the SSE suite covers that column separately.
  const openedA = new Date(since7d.getTime() - 3 * DAY_MS).toISOString();
  const insideA = new Date(since7d.getTime() + 2 * 60_000);
  const closedA = toGammaFormat(insideA);
  insertPosition.run(
    "pos-gamma-inside",
    "tok-gamma-inside",
    5,
    openedA,
    closedA,
    insideA.toISOString(),
  );

  // (b1) SQLite space-format closed_at, 6 min INSIDE the window, same calendar day as the cutoff.
  // Same lexical defect as (a) minus the "+00" suffix — isolates the space-vs-T ordering bug from
  // the malformed-offset (julianday-NULL) bug so each assertion pins a distinct failure mode.
  const openedB1 = new Date(since7d.getTime() - 3 * DAY_MS).toISOString();
  const insideB1 = new Date(since7d.getTime() + 6 * 60_000);
  const closedB1 = toSpaceFormat(insideB1);
  insertPosition.run(
    "pos-space-inside",
    "tok-space-inside",
    5,
    openedB1,
    closedB1,
    insideB1.toISOString(),
  );

  // (b2) SQLite space-format closed_at, 6 min OUTSIDE the window (before the cutoff), same
  // calendar day. Pre-fix the lexical compare excludes this row too — space sorts below the ISO
  // bind on that day regardless of the real time — so it "passes" by coincidence, not by correct
  // date math. Kept as a control: the fix must not overcorrect and start counting same-day rows
  // that are genuinely outside the window.
  const openedB2 = new Date(since7d.getTime() - 3 * DAY_MS).toISOString();
  const outsideB2 = new Date(since7d.getTime() - 6 * 60_000);
  const closedB2 = toSpaceFormat(outsideB2);
  insertPosition.run(
    "pos-space-outside",
    "tok-space-outside",
    5,
    openedB2,
    closedB2,
    outsideB2.toISOString(),
  );

  // (c) readExitMultiples: closed_at in Gamma format, filled_at in ISO format, same calendar day,
  // comfortably inside the window (anchored 1 day before "now", away from the (a)/(b) boundary).
  // Pre-fix `f.filled_at <= p.closed_at` compares an ISO (T) string against the Gamma (space+"+00")
  // string on that day: T always sorts ABOVE space there, so `<=` read false even though the fill
  // is chronologically 5 minutes earlier — the position's exit multiple was silently dropped from
  // the aggregate rather than just mis-ranked.
  const anchorC = new Date(nowMs - DAY_MS);
  const openedC = new Date(anchorC.getTime() - 2 * DAY_MS).toISOString();
  const closedC = toGammaFormat(anchorC);
  const filledC = new Date(anchorC.getTime() - 5 * 60_000).toISOString();
  insertPosition.run(
    "pos-exit-multiple",
    "tok-exit-multiple",
    5,
    openedC,
    closedC,
    anchorC.toISOString(),
  );

  const insertOrder = db.prepare(
    `INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type,
       price, size, size_usdc, status, bot_run_id, decision_rule_id, created_at, updated_at)
     VALUES (?, ?, ?, '', 'sell', 'limit', ?, ?, ?, 'filled', 'test-run', ?, ?, ?)`,
  );
  const insertFill = db.prepare(
    `INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
       liquidity_role, fee, decision_rule_id, filled_at)
     VALUES (?, ?, ?, '', 'sell', ?, ?, ?, 'maker', 0, ?, ?)`,
  );

  // Multiple = size_usdc / size / avg_entry_price = 15 / 100 / 0.05 = 3.0, clears the >= 2.0 floor.
  insertOrder.run(
    "ord-exit-multiple",
    "c-exit-multiple",
    "tok-exit-multiple",
    0.15,
    100,
    15,
    null,
    filledC,
    filledC,
  );
  insertFill.run(
    "fill-exit-multiple",
    "ord-exit-multiple",
    "tok-exit-multiple",
    0.15,
    100,
    15,
    null,
    filledC,
  );

  // (d) R23 metrics: an order + a fill created 5 min BEFORE the 24h cutoff, same calendar day.
  // Pre-fix `created_at >= datetime(?)` renders the BIND (not the column) into space format via
  // SQLite's `datetime()`, so an ISO `created_at`/`filled_at` on the same day always sorts above
  // it (T > space there) regardless of the real time — counting an order/fill placed before the
  // window opened.
  const r23Cutoff = new Date(nowMs - DAY_MS);
  const r23CreatedAt = new Date(r23Cutoff.getTime() - 5 * 60_000).toISOString();
  insertOrder.run(
    "ord-r23-before-cutoff",
    "c-r23-before-cutoff",
    "tok-r23",
    0.02,
    50,
    1,
    "R23_DIP_TRIGGER",
    r23CreatedAt,
    r23CreatedAt,
  );
  insertFill.run(
    "fill-r23-before-cutoff",
    "ord-r23-before-cutoff",
    "tok-r23",
    0.02,
    50,
    1,
    "R23_DIP_TRIGGER",
    r23CreatedAt,
  );

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
  vi.useRealTimers();
});

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

describe("mixed-format ledger timestamps — dashboard + R23 window bounds", () => {
  it("counts Gamma/space closed_at rows inside the window, drops the one outside it (a, b)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/kpi",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // pos-gamma-inside + pos-space-inside + pos-exit-multiple all qualify (in-window closed_at);
    // pos-space-outside is chronologically before the cutoff and must not be counted.
    expect(body.data.winrate_7d.total).toBe(3);
    expect(body.data.winrate_7d.wins).toBe(3);
  });

  it("attributes a sell fill to its position across a Gamma closed_at / ISO filled_at pair (c)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/kpi",
      headers: authHeaders(),
    });
    const body = res.json();
    expect(body.data.exit_multiple_7d.count).toBe(1);
    expect(body.data.exit_multiple_7d.median).toBeCloseTo(3.0, 5);
  });

  it("excludes an R23 order/fill created before the 24h cutoff despite matching calendar day (d)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/r23",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.orders_24h).toBe(0);
    expect(body.data.fills_24h).toBe(0);
  });

  it("counts sell-closed positions via SELL_CLOSED_WINRATE_PREDICATE across space/Gamma closed_at forms against a canonical-ms filled_at", async () => {
    // Isolates the predicate's OWN inner bound (`f.filled_at <= positions.closed_at`) from the
    // outer `closed_at >= since7d` bound already pinned by (a)/(b1)/(b2) above. Neither position
    // lands in settlement_ledger, so counting here can only come through the sell-fill branch —
    // exactly what SELL_CLOSED_WINRATE_PREDICATE's own NOT EXISTS requires.
    const nowMs = Date.now();
    const openedFar = new Date(nowMs - 3 * DAY_MS).toISOString();

    // Space-form closed_at, comfortably inside the 7d window, same calendar day as its own
    // filled_at. Pre-fix, ISO `filled_at` ('T') always sorts ABOVE a same-day space bound (' '),
    // so `filled_at <= closed_at` reads false even though the fill is 5 minutes EARLIER.
    const closedSpaceAt = new Date(nowMs - DAY_MS - 20 * 60_000);
    const filledSpaceAt = new Date(closedSpaceAt.getTime() - 5 * 60_000).toISOString();

    // Gamma-form closed_at ("+00" suffix), same isolation, different token/position so both
    // renderings are pinned independently of each other.
    const closedGammaAt = new Date(nowMs - DAY_MS - 30 * 60_000);
    const filledGammaAt = new Date(closedGammaAt.getTime() - 5 * 60_000).toISOString();

    const insertPosition = conn.db.prepare(
      `INSERT INTO positions (position_id, token_id, side, avg_entry_price, realized_pnl, status,
         opened_at, closed_at, updated_at)
       VALUES (?, ?, 'buy', 0.05, ?, 'closed', ?, ?, ?)`,
    );
    const insertOrder = conn.db.prepare(
      `INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type,
         price, size, size_usdc, status, bot_run_id, decision_rule_id, created_at, updated_at)
       VALUES (?, ?, ?, '', 'sell', 'limit', 0.1, 10, 1, 'filled', 'test-run', NULL, ?, ?)`,
    );
    const insertFill = conn.db.prepare(
      `INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
         liquidity_role, fee, filled_at)
       VALUES (?, ?, ?, '', 'sell', 0.1, 10, 1, 'maker', 0, ?)`,
    );

    // Win (realized_pnl > 0).
    insertPosition.run(
      "pos-sell-closed-space",
      "tok-sell-closed-space",
      5,
      openedFar,
      toSpaceFormat(closedSpaceAt),
      closedSpaceAt.toISOString(),
    );
    insertOrder.run(
      "ord-sell-closed-space",
      "c-sell-closed-space",
      "tok-sell-closed-space",
      filledSpaceAt,
      filledSpaceAt,
    );
    insertFill.run(
      "fill-sell-closed-space",
      "ord-sell-closed-space",
      "tok-sell-closed-space",
      filledSpaceAt,
    );

    // Loss (realized_pnl <= 0), so the fixed-vs-broken percentage split is unambiguous rather than
    // pegged at 100% either way.
    insertPosition.run(
      "pos-sell-closed-gamma",
      "tok-sell-closed-gamma",
      -3,
      openedFar,
      toGammaFormat(closedGammaAt),
      closedGammaAt.toISOString(),
    );
    insertOrder.run(
      "ord-sell-closed-gamma",
      "c-sell-closed-gamma",
      "tok-sell-closed-gamma",
      filledGammaAt,
      filledGammaAt,
    );
    insertFill.run(
      "fill-sell-closed-gamma",
      "ord-sell-closed-gamma",
      "tok-sell-closed-gamma",
      filledGammaAt,
    );

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/dashboard/kpi",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Sell-closed cohort = pos-exit-multiple (win, fixture (c) above) + the space-form win + the
    // Gamma-form loss seeded here = 2 wins / 3 total = 66.667%. Pre-fix, the raw
    // `filled_at <= closed_at` compare drops all three rows (same lexical defect for both
    // renderings), collapsing this to 0%. Both fixtures' opened_at postdate the v072 cutoff, so
    // the post_v072 cohort must show the identical figure while pre_v072 stays untouched.
    expect(body.data.winrate_7d.sell_closed_pct).toBeCloseTo(66.667, 2);
    expect(body.data.winrate_7d.cohorts.post_v072.sell_closed_pct).toBeCloseTo(66.667, 2);
  });
});

describe("events.ts SSE — mixed-format change-detection (Site 1 + Site 2)", () => {
  // Regression for the actual user-visible bug: a raw TEXT MAX()/`>` comparison never detects a
  // same-day space-format row as "newer" than an already-seen ISO row (' ' sorts below 'T'), so
  // takeSnapshot()'s change-detection silently no-ops and order:filled/order:cancelled/
  // position:updated are never emitted over SSE. Only `positions.updated_at` and
  // `orders.updated_at` were measured split on the live ledger, so only those two carry the
  // space-format rendering here; `fills.filled_at` is single-rendering (its sole writer binds ISO
  // explicitly) and is seeded ISO — its assertion is a canonical-fill smoke check, NOT a guard on
  // the raw string cursor: a numeric julianday snapshot paired with a matching numeric delta bind
  // emits this same fill once as well, so the assertion cannot tell the two implementations apart.
  // Only a query-plan assertion could pin the raw form. Rows are seeded via raw INSERT (a
  // repository would render ISO for all of them) and
  // asserted through the live `/events` route via `payloadAsStream: true`, which resolves the
  // inject() call as soon as headers are written instead of waiting for the (never-ending) SSE
  // response to finish.
  it("emits position:updated / order:filled for newer space-format rows against an ISO snapshot bind, and fill:new for a newer ISO fill", async () => {
    const nowMs = Date.now();
    const t0 = new Date(nowMs).toISOString();

    // Baseline rows exist BEFORE the SSE connection opens, so takeSnapshot()'s initial snapshot
    // captures their ISO instant. If the fix regresses to a raw TEXT MAX(), a same-day space-format
    // insert below never lexically exceeds this ISO string and the delta query never fires.
    conn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, avg_entry_price, realized_pnl, status,
           opened_at, updated_at)
         VALUES ('pos-sse-baseline', 'tok-sse-baseline', 'buy', 0.05, 0, 'open', ?, ?)`,
      )
      .run(t0, t0);
    conn.db
      .prepare(
        `INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type,
           price, size, size_usdc, status, bot_run_id, decision_rule_id, created_at, updated_at)
         VALUES ('ord-sse-baseline', 'c-sse-baseline', 'tok-sse-baseline', '', 'sell', 'limit', 0.1,
           10, 1, 'open', 'test-run', NULL, ?, ?)`,
      )
      .run(t0, t0);
    conn.db
      .prepare(
        `INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
           liquidity_role, fee, decision_rule_id, filled_at)
         VALUES ('fill-sse-baseline', 'ord-sse-baseline', 'tok-sse-baseline', '', 'sell', 0.1, 5, 0.5,
           'maker', 0, NULL, ?)`,
      )
      .run(t0);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/events?types=position,order,fill",
      headers: authHeaders(),
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    const stream = res.stream();

    let buffer = "";
    const sawAll = () =>
      buffer.includes("event: position:updated") &&
      buffer.includes("event: order:filled") &&
      buffer.includes("event: fill:new");
    const donePromise = new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (sawAll()) resolve();
      });
      stream.on("error", reject);
      setTimeout(
        () => reject(new Error(`timeout waiting for SSE events; buffer so far:\n${buffer}`)),
        8000,
      );
    });

    // Newer rows, 5 minutes after t0 but the SAME calendar day. `updated_at` carries the SQLite
    // legacy space format — exactly the shape a raw TEXT compare gets wrong — while the columns
    // measured single-rendering (`opened_at`, `orders.created_at`, `fills.filled_at`) stay ISO, so
    // the fixture never asserts against a rendering no writer can produce.
    const t1Iso = new Date(nowMs + 5 * 60_000).toISOString();
    const t1 = toSpaceFormat(new Date(nowMs + 5 * 60_000));
    conn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, avg_entry_price, realized_pnl, status,
           opened_at, updated_at)
         VALUES ('pos-sse-newer', 'tok-sse-newer', 'buy', 0.05, 0, 'open', ?, ?)`,
      )
      .run(t1Iso, t1);
    conn.db
      .prepare(
        `INSERT INTO orders (order_id, client_order_id, token_id, condition_id, side, order_type,
           price, size, size_usdc, status, bot_run_id, decision_rule_id, created_at, updated_at)
         VALUES ('ord-sse-newer', 'c-sse-newer', 'tok-sse-newer', '', 'sell', 'limit', 0.12, 10, 1.2,
           'filled', 'test-run', NULL, ?, ?)`,
      )
      .run(t1Iso, t1);
    conn.db
      .prepare(
        `INSERT INTO fills (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
           liquidity_role, fee, decision_rule_id, filled_at)
         VALUES ('fill-sse-newer', 'ord-sse-newer', 'tok-sse-newer', '', 'sell', 0.12, 10, 1.2,
           'maker', 0, NULL, ?)`,
      )
      .run(t1Iso);

    await donePromise;

    expect(buffer).toContain('"positionId":"pos-sse-newer"');
    expect(buffer).toContain('"orderId":"ord-sse-newer"');
    expect(buffer).toContain('"fillId":"fill-sse-newer"');

    // Best-effort cleanup so the interval stops polling once this test ends.
    const rawRes = (res.raw as unknown as { res?: { req?: { destroy?: () => void } } }).res;
    rawRes?.req?.destroy?.();
    stream.destroy();
  }, 15000);
});

describe("profiles.ts ordering (Site 3) — mixed-format updated_at", () => {
  let tmpDir: string;
  let ledgerConn: DbConnection;
  let pool: LedgerPool;
  let profilesApp: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    // profiles.ts requires a real per-profile ledger file via LedgerPool.get() (stubLedgerPool()
    // resolves every profile to null), so this spins up its own on-disk ledger + server instance
    // rather than reusing the shared in-memory `conn`/`app`.
    tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-profiles-sort-"));
    ledgerConn = bootstrapLedgerDb(path.join(tmpDir, "ledger-sort-test.db"));

    const nowMs = Date.now();
    const t0 = new Date(nowMs).toISOString();
    const t1Iso = new Date(nowMs + 5 * 60_000).toISOString();
    // Chronologically newer, same calendar day. Only `updated_at` is split on the live ledger, so
    // only it gets the legacy rendering; `opened_at` stays ISO like every writer emits.
    const t1 = toSpaceFormat(new Date(nowMs + 5 * 60_000));

    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, avg_entry_price, realized_pnl, status,
           opened_at, updated_at)
         VALUES ('pos-iso-older', 'tok-iso-older', 'buy', 0.05, 0, 'open', ?, ?)`,
      )
      .run(t0, t0);
    ledgerConn.db
      .prepare(
        `INSERT INTO positions (position_id, token_id, side, avg_entry_price, realized_pnl, status,
           opened_at, updated_at)
         VALUES ('pos-space-newer', 'tok-space-newer', 'buy', 0.05, 0, 'open', ?, ?)`,
      )
      .run(t1Iso, t1);

    pool = new LedgerPool(path.join(tmpDir, "control.db"));
    profilesApp = await buildServer({
      config: testConfig(),
      controlDb: conn.db,
      ledgerDb: conn.db,
      ledgerPool: pool,
    });
  });

  afterAll(async () => {
    await profilesApp.close();
    pool.closeAll();
    ledgerConn.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ranks the chronologically newest row first regardless of ISO-vs-space rendering", async () => {
    const res = await profilesApp.inject({
      method: "GET",
      url: "/api/v1/profiles/sort-test/positions",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.map((p: { positionId: string }) => p.positionId)).toEqual([
      "pos-space-newer",
      "pos-iso-older",
    ]);
  });
});

describe("portfolio-series.ts window bound (Site 4) — ISO cutoff vs space-form datetime('now')", () => {
  const cutoffMs = FROZEN_NOW.getTime() - 7 * DAY_MS; // route's own `interval=1w` cutoff

  const insideCapturedAt = new Date(cutoffMs + 2 * 60_000).toISOString();
  // Same calendar day as the cutoff but chronologically BEFORE it. Pre-fix, the route bound the
  // interval into `datetime('now', ?)` and compared the ISO column against that space-rendered
  // string: on a shared calendar day 'T' (0x54) always sorts above ' ' (0x20) regardless of the
  // real time, so this row was wrongly counted as inside the window — this is the case the fix
  // must exclude for the test to distinguish it from the old behavior.
  const cutoffDayBeforeCapturedAt = new Date(cutoffMs - 6 * 60_000).toISOString();
  const outsideCapturedAt = new Date(cutoffMs - 3 * DAY_MS).toISOString();

  beforeAll(() => {
    const insertSnapshot = conn.db.prepare(
      `INSERT INTO portfolio_snapshots
         (profile, equity_usdc, position_value_usdc, realized_pnl_usdc, open_value_usdc, captured_at)
       VALUES ('simulation', ?, 0, 0, 0, ?)`,
    );
    insertSnapshot.run(100, insideCapturedAt);
    insertSnapshot.run(90, cutoffDayBeforeCapturedAt);
    insertSnapshot.run(80, outsideCapturedAt);
  });

  it("includes the in-window row, drops the same-day-but-before-cutoff and the clearly-outside rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/metrics/portfolio-series?interval=1w",
      headers: authHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const capturedAts = body.data.items.map((p: { capturedAt: string }) => p.capturedAt);
    expect(capturedAts).toContain(insideCapturedAt);
    expect(capturedAts).not.toContain(cutoffDayBeforeCapturedAt);
    expect(capturedAts).not.toContain(outsideCapturedAt);
  });
});
