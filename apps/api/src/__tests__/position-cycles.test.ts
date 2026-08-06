import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bootstrapDatabase, type DbConnection } from "@krabs/db";
import type { AppConfig } from "@krabs/config";
import { buildServer } from "../server.js";
import { stubLedgerPool, MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

const TEST_API_KEY = "test-key-position-cycles";

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

interface PositionCycle {
  positionId: string;
  tokenId: string;
  status: string;
  lastActionAt: string;
  heldDurationMs: number;
  investedUsd: number;
  returnedUsd: number;
  sellReturnedUsd: number;
  settlementReturnedUsd: number;
  remainingMarkUsd: number;
  remainingLiquidationUsd: number;
  realizedPnlUsd: number | null;
  unrealizedPnlUsd: number;
  netPnlUsd: number | null;
  accountingConfidence: "HIGH" | "MED" | "LOW";
  accountingReasons: string[];
  buyCount: number;
  sellCount: number;
  entrySources: string[];
  exitSources: string[];
  sourceBreakdown: {
    exits: Array<{ source: string; returnedUsd: number; pnlUsd: number | null }>;
  };
  operations: Array<{ type: string; source: string; usd: number; stepPnlUsd: number | null }>;
}

interface PositionCyclesResponse {
  ok: boolean;
  data: {
    summary: {
      closedRealizedPnlUsd: number;
      openNetPnlUsd: number;
      winners: number;
      losers: number;
      accountingWarningCount: number;
    };
    accountingWarnings: PositionCycle[];
    cycles: PositionCycle[];
    pagination: { totalCount: number; totalPages: number };
  };
}

let conn: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function authHeaders() {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

function seedMarket(tokenId: string, conditionId: string, slug: string, outcome = "Yes") {
  conn.db
    .prepare(
      `INSERT INTO markets (token_id, condition_id, slug, question, outcome, tick_size)
       VALUES (?, ?, ?, ?, ?, 0.01)`,
    )
    .run(tokenId, conditionId, slug, slug.replace(/-/g, " "), outcome);
}

function seedPosition(input: {
  positionId: string;
  tokenId: string;
  conditionId: string;
  status: "open" | "closed" | "dust";
  size: number;
  avgEntry: number;
  costBasis: number;
  realizedPnl: number;
  openedAt: string;
  closedAt?: string | null;
  currentValue?: number | null;
  liquidationValue?: number | null;
}) {
  conn.db
    .prepare(
      `INSERT INTO positions
         (position_id, token_id, condition_id, side, size, avg_entry_price, cost_basis_usdc,
          current_value_usdc, liquidation_value_usdc, realized_pnl, status, opened_at, closed_at, updated_at)
       VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.positionId,
      input.tokenId,
      input.conditionId,
      input.size,
      input.avgEntry,
      input.costBasis,
      input.currentValue ?? null,
      input.liquidationValue ?? null,
      input.realizedPnl,
      input.status,
      input.openedAt,
      input.closedAt ?? null,
      input.closedAt ?? input.openedAt,
    );
}

function seedOrderFill(input: {
  fillId: string;
  orderId: string;
  tokenId: string;
  conditionId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  source: string;
  filledAt: string;
}) {
  conn.db
    .prepare(
      `INSERT INTO orders
         (order_id, client_order_id, token_id, condition_id, side, order_type, post_only, price,
          size, size_usdc, status, decision_rule_id, signal_reason, bot_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'limit', 1, ?, ?, ?, 'filled', ?, ?, 'test-run', ?, ?)`,
    )
    .run(
      input.orderId,
      `client-${input.orderId}`,
      input.tokenId,
      input.conditionId,
      input.side,
      input.price,
      input.size,
      input.price * input.size,
      input.source,
      input.source,
      input.filledAt,
      input.filledAt,
    );
  conn.db
    .prepare(
      `INSERT INTO fills
         (fill_id, order_id, token_id, condition_id, side, price, size, size_usdc,
          liquidity_role, fee, filled_at, decision_rule_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'maker', 0, ?, ?)`,
    )
    .run(
      input.fillId,
      input.orderId,
      input.tokenId,
      input.conditionId,
      input.side,
      input.price,
      input.size,
      input.price * input.size,
      input.filledAt,
      input.source,
    );
}

function seedBuyLot(input: {
  positionId: string;
  tokenId: string;
  conditionId: string;
  fillId: string;
  orderId: string;
  price: number;
  size: number;
  source: string;
  filledAt: string;
  remainingSize?: number;
}) {
  seedOrderFill({ ...input, side: "buy" });
  conn.db
    .prepare(
      `INSERT INTO inventory_lots
         (lot_id, position_id, token_id, side, size, remaining_size, entry_price, cost_usdc, fill_id, created_at)
       VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `lot-${input.fillId}`,
      input.positionId,
      input.tokenId,
      input.size,
      input.remainingSize ?? 0,
      input.price,
      input.price * input.size,
      input.fillId,
      input.filledAt,
    );
}

function seedSellPnl(input: {
  positionId: string;
  tokenId: string;
  conditionId: string;
  fillId: string;
  orderId: string;
  price: number;
  size: number;
  source: string;
  pnl: number;
  filledAt: string;
}) {
  seedOrderFill({ ...input, side: "sell" });
  conn.db
    .prepare("INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at) VALUES (?, ?, ?, ?)")
    .run(input.fillId, input.positionId, input.pnl, input.filledAt);
}

function seedSellFillWithoutPnl(input: {
  tokenId: string;
  conditionId: string;
  fillId: string;
  orderId: string;
  price: number;
  size: number;
  source: string;
  filledAt: string;
}) {
  seedOrderFill({ ...input, side: "sell" });
}

async function withSavepoint<T>(name: string, fn: () => Promise<T>): Promise<T> {
  conn.db.exec(`SAVEPOINT ${name}`);
  try {
    return await fn();
  } finally {
    conn.db.exec(`ROLLBACK TO ${name}`);
    conn.db.exec(`RELEASE ${name}`);
  }
}

async function fetchCycles(url = "/api/v1/pnl/position-cycles?period=all&pageSize=50") {
  const res = await app.inject({ method: "GET", url, headers: authHeaders() });
  expect(res.statusCode).toBe(200);
  return res.json<PositionCyclesResponse>();
}

function readMigration(filename: string): string {
  return readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "packages",
      "db",
      "src",
      "migrations",
      filename,
    ),
    "utf-8",
  );
}

beforeAll(async () => {
  conn = bootstrapDatabase(":memory:");
  const now = isoHoursAgo(1);
  const old = isoHoursAgo(240);

  seedMarket("tok-shared", "cond-shared", "shared-token-market");
  seedPosition({
    positionId: "pos-profit-1",
    tokenId: "tok-shared",
    conditionId: "cond-shared",
    status: "closed",
    size: 0,
    avgEntry: 0,
    costBasis: 0,
    realizedPnl: 0.5,
    openedAt: isoHoursAgo(10),
    closedAt: now,
  });
  seedBuyLot({
    positionId: "pos-profit-1",
    tokenId: "tok-shared",
    conditionId: "cond-shared",
    fillId: "buy-profit-1",
    orderId: "ord-buy-profit-1",
    price: 0.1,
    size: 10,
    source: "R23_DIP_TRIGGER",
    filledAt: isoHoursAgo(10),
  });
  seedSellPnl({
    positionId: "pos-profit-1",
    tokenId: "tok-shared",
    conditionId: "cond-shared",
    fillId: "sell-profit-1",
    orderId: "ord-sell-profit-1",
    price: 0.15,
    size: 10,
    source: "PROFILE_LADDER",
    pnl: 0.5,
    filledAt: now,
  });

  seedPosition({
    positionId: "pos-shared-reopen",
    tokenId: "tok-shared",
    conditionId: "cond-shared",
    status: "open",
    size: 4,
    avgEntry: 0.2,
    costBasis: 0.8,
    currentValue: 0.84,
    liquidationValue: 0.4,
    realizedPnl: 0,
    openedAt: isoHoursAgo(2),
  });
  seedBuyLot({
    positionId: "pos-shared-reopen",
    tokenId: "tok-shared",
    conditionId: "cond-shared",
    fillId: "buy-reopen-1",
    orderId: "ord-buy-reopen-1",
    price: 0.2,
    size: 4,
    source: "D3",
    filledAt: isoHoursAgo(2),
    remainingSize: 4,
  });

  seedMarket("tok-loss", "cond-loss", "scale-in-loss-market");
  seedPosition({
    positionId: "pos-scale-loss",
    tokenId: "tok-loss",
    conditionId: "cond-loss",
    status: "closed",
    size: 0,
    avgEntry: 0,
    costBasis: 0,
    realizedPnl: -0.6,
    openedAt: isoHoursAgo(9),
    closedAt: isoHoursAgo(3),
  });
  seedBuyLot({
    positionId: "pos-scale-loss",
    tokenId: "tok-loss",
    conditionId: "cond-loss",
    fillId: "buy-loss-1",
    orderId: "ord-buy-loss-1",
    price: 0.2,
    size: 10,
    source: "R23_DIP_TRIGGER",
    filledAt: isoHoursAgo(9),
  });
  seedBuyLot({
    positionId: "pos-scale-loss",
    tokenId: "tok-loss",
    conditionId: "cond-loss",
    fillId: "buy-loss-2",
    orderId: "ord-buy-loss-2",
    price: 0.1,
    size: 10,
    source: "D3",
    filledAt: isoHoursAgo(8),
  });
  seedSellPnl({
    positionId: "pos-scale-loss",
    tokenId: "tok-loss",
    conditionId: "cond-loss",
    fillId: "sell-loss-d7",
    orderId: "ord-sell-loss-d7",
    price: 0.16,
    size: 10,
    source: "D7",
    pnl: -0.4,
    filledAt: isoHoursAgo(4),
  });
  seedSellPnl({
    positionId: "pos-scale-loss",
    tokenId: "tok-loss",
    conditionId: "cond-loss",
    fillId: "sell-loss-d8",
    orderId: "ord-sell-loss-d8",
    price: 0.08,
    size: 10,
    source: "D8_PROFIT_RATIO",
    pnl: -0.2,
    filledAt: isoHoursAgo(3),
  });

  seedMarket("tok-resolution", "cond-resolution", "settlement-loss-market", "No");
  conn.db
    .prepare(
      `INSERT INTO market_resolutions (condition_id, resolution, resolved_at, detected_at, source, status)
       VALUES ('cond-resolution', 'Yes', ?, ?, 'test', 'settled')`,
    )
    .run(isoHoursAgo(1), isoHoursAgo(1));
  seedPosition({
    positionId: "pos-settlement-loss",
    tokenId: "tok-resolution",
    conditionId: "cond-resolution",
    status: "closed",
    size: 0,
    avgEntry: 0,
    costBasis: 0,
    realizedPnl: -1.1,
    openedAt: isoHoursAgo(12),
    closedAt: isoHoursAgo(1),
  });
  seedBuyLot({
    positionId: "pos-settlement-loss",
    tokenId: "tok-resolution",
    conditionId: "cond-resolution",
    fillId: "buy-settlement-1",
    orderId: "ord-buy-settlement-1",
    price: 0.3,
    size: 5,
    source: "R23_DIP_TRIGGER",
    filledAt: isoHoursAgo(12),
  });
  seedSellPnl({
    positionId: "pos-settlement-loss",
    tokenId: "tok-resolution",
    conditionId: "cond-resolution",
    fillId: "sell-settlement-1",
    orderId: "ord-sell-settlement-1",
    price: 0.4,
    size: 1,
    source: "D7",
    pnl: 0.1,
    filledAt: isoHoursAgo(6),
  });
  conn.db
    .prepare(
      `INSERT INTO settlement_ledger
         (settlement_id, condition_id, position_id, token_id, resolution, settlement_price, size, delta, settled_at)
       VALUES ('settlement-loss', 'cond-resolution', 'pos-settlement-loss', 'tok-resolution',
               'Yes', 0, 4, -1.2, ?)`,
    )
    .run(isoHoursAgo(1));

  seedMarket("tok-open", "cond-open", "open-loss-market");
  seedPosition({
    positionId: "pos-open-loss",
    tokenId: "tok-open",
    conditionId: "cond-open",
    status: "open",
    size: 20,
    avgEntry: 0.3,
    costBasis: 6,
    currentValue: 4,
    liquidationValue: 2,
    realizedPnl: 0,
    openedAt: isoHoursAgo(5),
  });
  seedBuyLot({
    positionId: "pos-open-loss",
    tokenId: "tok-open",
    conditionId: "cond-open",
    fillId: "buy-open-1",
    orderId: "ord-buy-open-1",
    price: 0.3,
    size: 20,
    source: "scale-in",
    filledAt: isoHoursAgo(5),
    remainingSize: 20,
  });

  seedMarket("tok-unknown", "cond-unknown", "unknown-accounting-market");
  seedPosition({
    positionId: "pos-unknown",
    tokenId: "tok-unknown",
    conditionId: "cond-unknown",
    status: "closed",
    size: 0,
    avgEntry: 0,
    costBasis: 0,
    realizedPnl: 0.2,
    openedAt: isoHoursAgo(4),
    closedAt: isoHoursAgo(2),
  });
  seedBuyLot({
    positionId: "pos-unknown",
    tokenId: "tok-unknown",
    conditionId: "cond-unknown",
    fillId: "buy-unknown-1",
    orderId: "ord-buy-unknown-1",
    price: 0.1,
    size: 10,
    source: "R23_DIP_TRIGGER",
    filledAt: isoHoursAgo(4),
  });
  seedSellPnl({
    positionId: "pos-unknown",
    tokenId: "tok-unknown",
    conditionId: "cond-unknown",
    fillId: "sell-unknown-1",
    orderId: "ord-sell-unknown-1",
    price: 0.15,
    size: 10,
    source: "D7",
    pnl: 0.5,
    filledAt: isoHoursAgo(2),
  });

  seedMarket("tok-small-drift", "cond-small-drift", "small-rounded-drift-market");
  seedPosition({
    positionId: "pos-small-drift",
    tokenId: "tok-small-drift",
    conditionId: "cond-small-drift",
    status: "closed",
    size: 0,
    avgEntry: 0,
    costBasis: 0,
    realizedPnl: 0.505,
    openedAt: isoHoursAgo(4),
    closedAt: isoHoursAgo(2),
  });
  seedBuyLot({
    positionId: "pos-small-drift",
    tokenId: "tok-small-drift",
    conditionId: "cond-small-drift",
    fillId: "buy-small-drift-1",
    orderId: "ord-buy-small-drift-1",
    price: 0.1,
    size: 10,
    source: "R23_DIP_TRIGGER",
    filledAt: isoHoursAgo(4),
  });
  seedSellPnl({
    positionId: "pos-small-drift",
    tokenId: "tok-small-drift",
    conditionId: "cond-small-drift",
    fillId: "sell-small-drift-1",
    orderId: "ord-sell-small-drift-1",
    price: 0.15,
    size: 10,
    source: "D7",
    pnl: 0.5,
    filledAt: isoHoursAgo(2),
  });

  seedMarket("tok-material-drift", "cond-material-drift", "material-drift-market");
  seedPosition({
    positionId: "pos-material-drift",
    tokenId: "tok-material-drift",
    conditionId: "cond-material-drift",
    status: "closed",
    size: 0,
    avgEntry: 0,
    costBasis: 0,
    realizedPnl: 0.2,
    openedAt: isoHoursAgo(4),
    closedAt: isoHoursAgo(2),
  });
  seedBuyLot({
    positionId: "pos-material-drift",
    tokenId: "tok-material-drift",
    conditionId: "cond-material-drift",
    fillId: "buy-material-drift-1",
    orderId: "ord-buy-material-drift-1",
    price: 0.1,
    size: 10,
    source: "R23_DIP_TRIGGER",
    filledAt: isoHoursAgo(4),
  });
  seedSellPnl({
    positionId: "pos-material-drift",
    tokenId: "tok-material-drift",
    conditionId: "cond-material-drift",
    fillId: "sell-material-drift-1",
    orderId: "ord-sell-material-drift-1",
    price: 0.15,
    size: 10,
    source: "D7",
    pnl: 0.5,
    filledAt: isoHoursAgo(2),
  });

  seedMarket(
    "tok-large-relative-drift",
    "cond-large-relative-drift",
    "large-relative-drift-market",
  );
  seedPosition({
    positionId: "pos-large-relative-drift",
    tokenId: "tok-large-relative-drift",
    conditionId: "cond-large-relative-drift",
    status: "closed",
    size: 0,
    avgEntry: 0,
    costBasis: 0,
    realizedPnl: 1000.05,
    openedAt: isoHoursAgo(4),
    closedAt: isoHoursAgo(2),
  });
  seedBuyLot({
    positionId: "pos-large-relative-drift",
    tokenId: "tok-large-relative-drift",
    conditionId: "cond-large-relative-drift",
    fillId: "buy-large-relative-drift-1",
    orderId: "ord-buy-large-relative-drift-1",
    price: 0.1,
    size: 100,
    source: "R23_DIP_TRIGGER",
    filledAt: isoHoursAgo(4),
  });
  seedSellPnl({
    positionId: "pos-large-relative-drift",
    tokenId: "tok-large-relative-drift",
    conditionId: "cond-large-relative-drift",
    fillId: "sell-large-relative-drift-1",
    orderId: "ord-sell-large-relative-drift-1",
    price: 10.1,
    size: 100,
    source: "D7",
    pnl: 1000,
    filledAt: isoHoursAgo(2),
  });

  seedMarket("tok-old", "cond-old", "old-cycle-market");
  seedPosition({
    positionId: "pos-old",
    tokenId: "tok-old",
    conditionId: "cond-old",
    status: "closed",
    size: 0,
    avgEntry: 0,
    costBasis: 0,
    realizedPnl: 1,
    openedAt: old,
    closedAt: old,
  });
  seedBuyLot({
    positionId: "pos-old",
    tokenId: "tok-old",
    conditionId: "cond-old",
    fillId: "buy-old-1",
    orderId: "ord-buy-old-1",
    price: 0.1,
    size: 10,
    source: "R23_DIP_TRIGGER",
    filledAt: old,
  });
  seedSellPnl({
    positionId: "pos-old",
    tokenId: "tok-old",
    conditionId: "cond-old",
    fillId: "sell-old-1",
    orderId: "ord-sell-old-1",
    price: 0.2,
    size: 10,
    source: "D7",
    pnl: 1,
    filledAt: old,
  });

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

describe("GET /pnl/position-cycles", () => {
  it("returns closed profitable cycles with BUY+SELL lifecycle P&L", async () => {
    const body = await fetchCycles();
    const cycle = body.data.cycles.find((c) => c.positionId === "pos-profit-1")!;
    expect(cycle.status).toBe("CLOSED_PROFIT");
    expect(cycle.investedUsd).toBeCloseTo(1);
    expect(cycle.sellReturnedUsd).toBeCloseTo(1.5);
    expect(cycle.returnedUsd).toBeCloseTo(1.5);
    expect(cycle.realizedPnlUsd).toBeCloseTo(0.5);
    expect(cycle.netPnlUsd).toBeCloseTo(0.5);
    expect(cycle.entrySources).toEqual(["R23_DIP_TRIGGER"]);
    expect(cycle.exitSources).toEqual(["PROFILE_LADDER"]);
    expect(cycle.operations.map((op) => op.type)).toEqual(["BUY", "SELL"]);
    expect(cycle.operations.map((op) => op.usd)).toEqual([-1, 1.5]);
  });

  it("keeps separate position cycles for the same token_id", async () => {
    const body = await fetchCycles();
    const shared = body.data.cycles.filter((c) => c.tokenId === "tok-shared");
    expect(shared.map((c) => c.positionId).sort()).toEqual(["pos-profit-1", "pos-shared-reopen"]);
  });

  it("handles scale-in losses and source-level exit P&L", async () => {
    const body = await fetchCycles();
    const cycle = body.data.cycles.find((c) => c.positionId === "pos-scale-loss")!;
    expect(cycle.status).toBe("CLOSED_LOSS");
    expect(cycle.buyCount).toBe(2);
    expect(cycle.sellCount).toBe(2);
    expect(cycle.investedUsd).toBeCloseTo(3);
    expect(cycle.realizedPnlUsd).toBeCloseTo(-0.6);
    expect(cycle.sourceBreakdown.exits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "D7", returnedUsd: 1.6, pnlUsd: -0.4 }),
        expect.objectContaining({ source: "D8_PROFIT_RATIO", returnedUsd: 0.8, pnlUsd: -0.2 }),
      ]),
    );
  });

  it("includes settlement/redeem P&L separately from sell proceeds", async () => {
    const body = await fetchCycles();
    const cycle = body.data.cycles.find((c) => c.positionId === "pos-settlement-loss")!;
    expect(cycle.status).toBe("HELD_TO_LOSING_RESOLUTION");
    expect(cycle.sellReturnedUsd).toBeCloseTo(0.4);
    expect(cycle.settlementReturnedUsd).toBeCloseTo(0);
    expect(cycle.returnedUsd).toBeCloseTo(0.4);
    expect(cycle.realizedPnlUsd).toBeCloseTo(-1.1);
    expect(cycle.accountingConfidence).toBe("MED");
    expect(cycle.exitSources).toEqual(expect.arrayContaining(["D7", "settlement"]));
  });

  it("shows open cycles with unrealized mark and separate liquidation value", async () => {
    const body = await fetchCycles();
    const cycle = body.data.cycles.find((c) => c.positionId === "pos-open-loss")!;
    expect(cycle.status).toBe("OPEN_LOSS");
    expect(cycle.remainingMarkUsd).toBeCloseTo(4);
    expect(cycle.remainingLiquidationUsd).toBeCloseTo(2);
    expect(cycle.unrealizedPnlUsd).toBeCloseTo(-2);
    expect(cycle.netPnlUsd).toBeCloseTo(-2);
    expect(cycle.accountingConfidence).toBe("MED");
  });

  it("uses money-scale tolerance for realized P&L ledger mismatch checks", async () => {
    const body = await fetchCycles();
    const smallDrift = body.data.cycles.find((c) => c.positionId === "pos-small-drift")!;
    const materialDrift = body.data.accountingWarnings.find(
      (c) => c.positionId === "pos-material-drift",
    )!;
    const largeRelativeDrift = body.data.cycles.find(
      (c) => c.positionId === "pos-large-relative-drift",
    )!;

    expect(smallDrift.status).toBe("CLOSED_PROFIT");
    expect(smallDrift.accountingReasons).not.toContain("ledger_mismatch");
    expect(materialDrift.status).toBe("UNKNOWN_ACCT");
    expect(materialDrift.accountingReasons).toContain("ledger_mismatch");
    expect(largeRelativeDrift.status).toBe("CLOSED_PROFIT");
    expect(largeRelativeDrift.accountingReasons).not.toContain("ledger_mismatch");
  });

  it("marks mismatched accounting as n/a and excludes it from summary P&L", async () => {
    const body = await fetchCycles();
    const unknown = body.data.accountingWarnings.find((c) => c.positionId === "pos-unknown")!;
    expect(unknown.status).toBe("UNKNOWN_ACCT");
    expect(unknown.realizedPnlUsd).toBeNull();
    expect(unknown.netPnlUsd).toBeNull();
    expect(unknown.accountingConfidence).toBe("LOW");
    expect(unknown.accountingReasons).toContain("ledger_mismatch");
    expect(body.data.summary.accountingWarningCount).toBe(2);
    // Known closed cycles sum to 1000.3; mismatched ledger deltas are excluded.
    expect(body.data.summary.closedRealizedPnlUsd).toBeCloseTo(1000.3);
  });

  it("clears a legacy orphan sell warning once the missing pnl_ledger row exists", async () =>
    withSavepoint("legacy_orphan_sell", async () => {
      seedMarket("tok-legacy-orphan", "cond-legacy-orphan", "legacy-orphan-sell-market");
      seedPosition({
        positionId: "pos-legacy-orphan",
        tokenId: "tok-legacy-orphan",
        conditionId: "cond-legacy-orphan",
        status: "closed",
        size: 0,
        avgEntry: 0.006,
        costBasis: 0,
        realizedPnl: 0.12631,
        openedAt: isoHoursAgo(40),
        closedAt: isoHoursAgo(30),
      });
      seedBuyLot({
        positionId: "pos-legacy-orphan",
        tokenId: "tok-legacy-orphan",
        conditionId: "cond-legacy-orphan",
        fillId: "buy-legacy-orphan",
        orderId: "ord-buy-legacy-orphan",
        price: 0.006,
        size: 7.43,
        source: "FALLBACK",
        filledAt: isoHoursAgo(40),
      });
      seedSellFillWithoutPnl({
        tokenId: "tok-legacy-orphan",
        conditionId: "cond-legacy-orphan",
        fillId: "sell-legacy-orphan",
        orderId: "ord-sell-legacy-orphan",
        price: 0.023,
        size: 7.43,
        source: "orphan-reconciled-test",
        filledAt: isoHoursAgo(30),
      });

      const before = await fetchCycles();
      const warning = before.data.accountingWarnings.find(
        (cycle) => cycle.positionId === "pos-legacy-orphan",
      )!;
      expect(warning.status).toBe("UNKNOWN_ACCT");
      expect(warning.accountingReasons).toContain("ledger_mismatch");

      conn.db
        .prepare(
          "INSERT INTO pnl_ledger (fill_id, position_id, delta, filled_at) VALUES (?, ?, ?, ?)",
        )
        .run("sell-legacy-orphan", "pos-legacy-orphan", 0.12631, isoHoursAgo(30));

      const after = await fetchCycles();
      expect(
        after.data.accountingWarnings.some((cycle) => cycle.positionId === "pos-legacy-orphan"),
      ).toBe(false);
      const reconciled = after.data.cycles.find(
        (cycle) => cycle.positionId === "pos-legacy-orphan",
      )!;
      expect(reconciled.status).toBe("CLOSED_PROFIT");
      expect(reconciled.realizedPnlUsd).toBeCloseTo(0.12631);
      expect(reconciled.netPnlUsd).toBeCloseTo(0.12631);
      expect(reconciled.returnedUsd).toBeCloseTo(0.17089);
    }));

  it("clears a duplicate resolution-cycle warning once the missing settlement row exists", async () =>
    withSavepoint("legacy_doge_settlement", async () => {
      seedMarket("tok-legacy-doge", "cond-legacy-doge", "legacy-doge-updown", "Down");
      conn.db
        .prepare(
          `INSERT INTO market_resolutions
             (condition_id, resolution, resolved_at, detected_at, source, status)
           VALUES ('cond-legacy-doge', 'algo-redeem', ?, ?, 'algo', 'detected')`,
        )
        .run(isoHoursAgo(50), isoHoursAgo(50));

      seedPosition({
        positionId: "pos-legacy-doge-first",
        tokenId: "tok-legacy-doge",
        conditionId: "cond-legacy-doge",
        status: "closed",
        size: 0,
        avgEntry: 0.01,
        costBasis: 0.525,
        realizedPnl: -0.525,
        openedAt: isoHoursAgo(50),
        closedAt: isoHoursAgo(49),
      });
      seedBuyLot({
        positionId: "pos-legacy-doge-first",
        tokenId: "tok-legacy-doge",
        conditionId: "cond-legacy-doge",
        fillId: "buy-legacy-doge-first",
        orderId: "ord-buy-legacy-doge-first",
        price: 0.01,
        size: 52.5,
        source: "probe-entry",
        filledAt: isoHoursAgo(50),
      });
      conn.db
        .prepare(
          `INSERT INTO settlement_ledger
             (settlement_id, condition_id, position_id, token_id, resolution,
              settlement_price, size, delta, settled_at)
           VALUES ('settle-legacy-doge-first', 'cond-legacy-doge', 'pos-legacy-doge-first',
                   'tok-legacy-doge', 'algo-redeem', 0, 52.5, -0.525, ?)`,
        )
        .run(isoHoursAgo(49));

      seedPosition({
        positionId: "pos-legacy-doge-second",
        tokenId: "tok-legacy-doge",
        conditionId: "cond-legacy-doge",
        status: "closed",
        size: 0,
        avgEntry: 0.01,
        costBasis: 0.525,
        realizedPnl: -0.525,
        openedAt: isoHoursAgo(48),
        closedAt: isoHoursAgo(47),
      });
      seedBuyLot({
        positionId: "pos-legacy-doge-second",
        tokenId: "tok-legacy-doge",
        conditionId: "cond-legacy-doge",
        fillId: "buy-legacy-doge-second",
        orderId: "ord-buy-legacy-doge-second",
        price: 0.01,
        size: 52.5,
        source: "probe-entry",
        filledAt: isoHoursAgo(48),
      });

      const before = await fetchCycles();
      const warning = before.data.accountingWarnings.find(
        (cycle) => cycle.positionId === "pos-legacy-doge-second",
      )!;
      expect(warning.status).toBe("UNKNOWN_ACCT");
      expect(warning.accountingReasons).toContain("ledger_mismatch");

      conn.db
        .prepare(
          `INSERT INTO settlement_ledger
             (settlement_id, condition_id, position_id, token_id, resolution,
              settlement_price, size, delta, settled_at)
           VALUES ('settle-legacy-doge-second', 'cond-legacy-doge', 'pos-legacy-doge-second',
                   'tok-legacy-doge', 'algo-redeem', 0, 52.5, -0.525, ?)`,
        )
        .run(isoHoursAgo(47));

      const after = await fetchCycles();
      expect(
        after.data.accountingWarnings.some(
          (cycle) => cycle.positionId === "pos-legacy-doge-second",
        ),
      ).toBe(false);
      const reconciled = after.data.cycles.find(
        (cycle) => cycle.positionId === "pos-legacy-doge-second",
      )!;
      expect(reconciled.status).toBe("HELD_TO_LOSING_RESOLUTION");
      expect(reconciled.settlementReturnedUsd).toBeCloseTo(0);
      expect(reconciled.realizedPnlUsd).toBeCloseTo(-0.525);
      expect(reconciled.netPnlUsd).toBeCloseTo(-0.525);
    }));

  it("backfill 080 turns a redeem-sweep zero-return close from CLOSED_PROFIT into a recorded loss", async () =>
    withSavepoint("redeem_sweep_backfill_080", async () => {
      // An exact allow-listed affected row (the screenshot case): closed with size 0
      // and realized_pnl 0, a single fully-settled buy lot, no sell pnl_ledger and no
      // settlement_ledger — the historical RedeemSweep.closeLocalPositions() bug.
      const positionId =
        "pos-70781911088713239237748492025950997105300640174486237821499168939935120968223-1782187061889";
      const tokenId =
        "70781911088713239237748492025950997105300640174486237821499168939935120968223";
      const conditionId = "0x835c0ca9914b5c6e3ce4b77e448b70c0808c30fabf39b64e6799a79c178a772e";

      seedMarket(tokenId, conditionId, "redeem-sweep-zero-return-market");
      seedPosition({
        positionId,
        tokenId,
        conditionId,
        status: "closed",
        size: 0,
        avgEntry: 0.006,
        costBasis: 0.99,
        realizedPnl: 0,
        openedAt: isoHoursAgo(60),
        closedAt: isoHoursAgo(50),
      });
      seedBuyLot({
        positionId,
        tokenId,
        conditionId,
        fillId: "buy-redeem-sweep-080",
        orderId: "ord-buy-redeem-sweep-080",
        price: 0.006,
        size: 165,
        source: "R23_DIP_TRIGGER",
        filledAt: isoHoursAgo(60),
      });

      // BUG: the unrecorded loss surfaces as a high-confidence break-even win.
      const before = await fetchCycles();
      const buggy = before.data.cycles.find((cycle) => cycle.positionId === positionId)!;
      expect(buggy.status).toBe("CLOSED_PROFIT");
      expect(buggy.realizedPnlUsd).toBeCloseTo(0);
      expect(buggy.netPnlUsd).toBeCloseTo(0);
      expect(buggy.accountingConfidence).toBe("HIGH");
      expect(before.data.accountingWarnings.some((c) => c.positionId === positionId)).toBe(false);

      conn.db.exec(readMigration("080_redeem_sweep_zero_return_pnl_backfill_20260630.sql"));

      // FIX: the settlement marker + ledger row + realized_pnl reconcile to a loss.
      const after = await fetchCycles();
      const fixed = after.data.cycles.find((cycle) => cycle.positionId === positionId)!;
      expect(fixed.status).toBe("HELD_TO_LOSING_RESOLUTION");
      expect(fixed.realizedPnlUsd).toBeCloseTo(-0.99);
      expect(fixed.netPnlUsd).toBeCloseTo(-0.99);
      expect(fixed.settlementReturnedUsd).toBeCloseTo(0);
      expect(fixed.returnedUsd).toBeCloseTo(0);
      expect(fixed.accountingConfidence).toBe("MED");
      expect(fixed.exitSources).toContain("settlement");
      expect(after.data.accountingWarnings.some((c) => c.positionId === positionId)).toBe(false);

      // Closed realized P&L drops by exactly the corrected loss; a pre-existing
      // healthy cycle is untouched.
      expect(after.data.summary.closedRealizedPnlUsd).toBeCloseTo(
        before.data.summary.closedRealizedPnlUsd - 0.99,
      );
      const profitBefore = before.data.cycles.find((c) => c.positionId === "pos-profit-1")!;
      const profitAfter = after.data.cycles.find((c) => c.positionId === "pos-profit-1")!;
      expect(profitAfter.status).toBe(profitBefore.status);
      expect(profitAfter.realizedPnlUsd).toBeCloseTo(profitBefore.realizedPnlUsd ?? 0);
    }));

  it("period filter drives summary and list", async () => {
    const all = await fetchCycles("/api/v1/pnl/position-cycles?period=all&pageSize=50");
    const last24h = await fetchCycles("/api/v1/pnl/position-cycles?period=24h&pageSize=50");
    expect(all.data.cycles.some((c) => c.positionId === "pos-old")).toBe(true);
    expect(last24h.data.cycles.some((c) => c.positionId === "pos-old")).toBe(false);
    expect(all.data.summary.closedRealizedPnlUsd).toBeGreaterThan(
      last24h.data.summary.closedRealizedPnlUsd,
    );
  });

  it("worst/best P&L sort excludes unknown accounting cycles", async () => {
    const worst = await fetchCycles(
      "/api/v1/pnl/position-cycles?period=all&sort=worst_pnl&pageSize=50",
    );
    expect(worst.data.cycles[0]!.positionId).toBe("pos-open-loss");
    expect(worst.data.cycles.findIndex((c) => c.positionId === "pos-unknown")).toBeGreaterThan(0);

    const best = await fetchCycles(
      "/api/v1/pnl/position-cycles?period=all&sort=best_pnl&pageSize=50",
    );
    expect(best.data.cycles[0]!.positionId).toBe("pos-large-relative-drift");
    expect(best.data.cycles.findIndex((c) => c.positionId === "pos-unknown")).toBeGreaterThan(0);
  });

  it("computes heldDurationMs and lastActionAt correctly when closed_at is a bare SQLite space timestamp", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Asia/Bangkok";
    try {
      await withSavepoint("timestamp_format_split", async () => {
        seedMarket("tok-ts-split", "cond-ts-split", "timestamp-split-market");
        seedPosition({
          positionId: "pos-ts-split",
          tokenId: "tok-ts-split",
          conditionId: "cond-ts-split",
          status: "closed",
          size: 0,
          avgEntry: 0.2,
          costBasis: 2,
          realizedPnl: 0.5,
          openedAt: "2026-08-05T01:00:00.000Z",
          // Same calendar day as openedAt, but rendered the way a legacy `datetime('now')`
          // partial UPDATE writes it: no zone designator at all, space instead of "T".
          closedAt: "2026-08-05 05:53:26",
        });
        seedBuyLot({
          positionId: "pos-ts-split",
          tokenId: "tok-ts-split",
          conditionId: "cond-ts-split",
          fillId: "buy-ts-split",
          orderId: "ord-buy-ts-split",
          price: 0.2,
          size: 10,
          source: "R23_DIP_TRIGGER",
          filledAt: "2026-08-05T01:00:00.000Z",
        });
        seedSellPnl({
          positionId: "pos-ts-split",
          tokenId: "tok-ts-split",
          conditionId: "cond-ts-split",
          fillId: "sell-ts-split",
          orderId: "ord-sell-ts-split",
          price: 0.25,
          size: 10,
          source: "PROFILE_LADDER",
          pnl: 0.5,
          filledAt: "2026-08-05T03:00:00.000Z",
        });

        const body = await fetchCycles();
        const cycle = body.data.cycles.find((c) => c.positionId === "pos-ts-split")!;
        // Under a host/TZ that reads the zone-less space form as LOCAL time, closed_at
        // (05:53:26) misparses to a UTC instant *before* both openedAt and the sell fill,
        // so it loses latestTimestamp() to the sell fill and heldDurationMs clamps to 0.
        // Parsed as UTC (the fix), closed_at is genuinely the latest of the three and the
        // hold is 01:00:00Z -> 05:53:26Z = 4h53m26s.
        expect(cycle.lastActionAt).toBe("2026-08-05 05:53:26");
        expect(cycle.heldDurationMs).toBe(17_606_000);
      });
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
