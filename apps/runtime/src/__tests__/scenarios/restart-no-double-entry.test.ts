import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapLedgerDb,
  SqliteFillRepository,
  SqliteInventoryLotRepository,
  SqliteLegStateRepository,
  SqliteMarketRepository,
  SqliteOrderRepository,
  SqlitePositionRepository,
} from "@krabs/db";
import {
  createBotRunId,
  createConditionId,
  createFillId,
  createOrderId,
  createPositionId,
  createTokenId,
  type ClientOrderId,
  type Signal,
} from "@krabs/domain";
import { runStartupPositionAdoption } from "../../startup-position-adoption.js";
import { AlgoRiskGateImpl } from "../../modules/risk-inventory/algo-risk-gate.js";

const TOKEN_ID = createTokenId("tok-btc-yes");
const COND_ID = createConditionId("cond-btc");

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

function makeProbeSignal(): Signal {
  return {
    signalId: "sig-probe",
    tokenId: TOKEN_ID,
    conditionId: COND_ID,
    side: "buy",
    suggestedPrice: 0.04,
    suggestedSize: 10,
    suggestedSizeUsdc: 0.4,
    reason: "probe-entry",
    strategyTick: Date.now(),
    sequenceInTick: 0,
    decisionRuleId: "FALLBACK",
    sizingRuleId: "FALLBACK",
    generatedAt: new Date().toISOString(),
  };
}

describe("Scenario: restart — no double-entry on existing open position", () => {
  const connections: Array<ReturnType<typeof bootstrapLedgerDb>> = [];

  afterEach(() => {
    while (connections.length > 0) {
      connections.pop()!.close();
    }
  });

  it("seeds leg_state from adopted fills AND gate blocks probe-entry on existing position", async () => {
    // ── Setup: simulate a DB as if the bot were restarted with an open
    // position at avgEntryPrice=0.15 and two historical BUY fills. leg_states
    // is intentionally empty to model the pre-fix restart drift.
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);

    marketRepo.save({
      tokenId: TOKEN_ID,
      conditionId: "cond-btc",
      slug: "bitcoin-above-68000",
      eventSlug: "bitcoin-april",
      question: "Will BTC be above 68k?",
      outcome: "YES",
      regime: "threshold",
      horizon: "daily",
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      active: true,
      tradable: true,
      tickSize: 0.01,
      negRisk: false,
      eventMarketCount: 1,
      gammaCreatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    orderRepo.save({
      orderId: createOrderId("ord-1"),
      clientOrderId: "coid-1" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      orderType: "GTC",
      postOnly: false,
      price: 0.15,
      size: 10,
      sizeUsdc: 1.5,
      status: "filled",
      exchangeOrderId: "ex-ord-1",
      signalId: null,
      signalReason: "probe-entry",
      botRunId: createBotRunId("prior-run"),
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
    });

    fillRepo.save({
      fillId: createFillId("f-1"),
      orderId: createOrderId("ord-1"),
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      price: 0.15,
      size: 6,
      sizeUsdc: 0.9,
      liquidityRole: "maker",
      fee: 0,
      feeRateBps: 0,
      filledAt: "2026-04-01T00:00:00Z",
    });
    fillRepo.save({
      fillId: createFillId("f-2"),
      orderId: createOrderId("ord-1"),
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      price: 0.15,
      size: 4,
      sizeUsdc: 0.6,
      liquidityRole: "maker",
      fee: 0,
      feeRateBps: 0,
      filledAt: "2026-04-01T00:05:00Z",
    });

    positionRepo.save({
      positionId: createPositionId("pos-1"),
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.15,
      costBasisUsdc: 1.5,
      currentValueUsdc: 0.4,
      realizedPnl: 0,
      status: "open",
      entryStyle: "probe",
      openedAt: "2026-04-01T00:00:00Z",
      closedAt: null,
      updatedAt: "2026-04-01T00:00:00Z",
    });

    expect(legStateRepo.get(TOKEN_ID)).toBeNull();

    // ── Act 1: run startup adoption. Gateway returns no new orphan fills —
    // all historical fills are already known. The adoption step must seed
    // leg_states from the ledger.
    const adoption = await runStartupPositionAdoption({
      gateway: { getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [] }) },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
      botRunId: createBotRunId("run-new"),
    });

    expect(adoption.seededLegStates).toBe(1);
    expect(adoption.positionsWithoutFills).toEqual([]);

    const seededLegState = legStateRepo.get(TOKEN_ID);
    expect(seededLegState).not.toBeNull();
    expect(seededLegState?.buyCount).toBe(2);
    expect(seededLegState?.firstTradePrice).toBe(0.15);
    expect(seededLegState?.lastAction).toBe("BUY");

    // ── Act 2: even if leg_state seeding had drifted, the defensive gate
    // must reject a fresh probe-entry against the same token.
    const gate = new AlgoRiskGateImpl(orderRepo, positionRepo, silentLog);
    const decision = await gate.evaluate(makeProbeSignal());

    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("open_position_exists");

    // ── Act 3: position count unchanged (no new order placed, no synthetic fill).
    expect(positionRepo.findOpen()).toHaveLength(1);
    expect(fillRepo.findByTokenId(TOKEN_ID)).toHaveLength(2);
  });

  it("second startup after first is idempotent: no extra seeding, gate still blocks", async () => {
    const conn = bootstrapLedgerDb(":memory:");
    connections.push(conn);

    const marketRepo = new SqliteMarketRepository(conn.db);
    const orderRepo = new SqliteOrderRepository(conn.db);
    const fillRepo = new SqliteFillRepository(conn.db);
    const positionRepo = new SqlitePositionRepository(conn.db);
    const inventoryLotRepo = new SqliteInventoryLotRepository(conn.db);
    const legStateRepo = new SqliteLegStateRepository(conn.db);

    marketRepo.save({
      tokenId: TOKEN_ID,
      conditionId: "cond-btc",
      slug: "bitcoin-above-68000",
      eventSlug: null,
      question: "Will BTC be above 68k?",
      outcome: "YES",
      regime: "threshold",
      horizon: "daily",
      endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      active: true,
      tradable: true,
      tickSize: 0.01,
      negRisk: false,
      eventMarketCount: 1,
      gammaCreatedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    orderRepo.save({
      orderId: createOrderId("ord-1"),
      clientOrderId: "coid-1" as ClientOrderId,
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      orderType: "GTC",
      postOnly: false,
      price: 0.15,
      size: 10,
      sizeUsdc: 1.5,
      status: "filled",
      exchangeOrderId: "ex-ord-1",
      signalId: null,
      signalReason: "probe-entry",
      botRunId: createBotRunId("prior-run"),
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
    });
    fillRepo.save({
      fillId: createFillId("f-1"),
      orderId: createOrderId("ord-1"),
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      price: 0.15,
      size: 10,
      sizeUsdc: 1.5,
      liquidityRole: "maker",
      fee: 0,
      feeRateBps: 0,
      filledAt: "2026-04-01T00:00:00Z",
    });
    positionRepo.save({
      positionId: createPositionId("pos-1"),
      tokenId: TOKEN_ID,
      conditionId: COND_ID,
      side: "buy",
      size: 10,
      avgEntryPrice: 0.15,
      costBasisUsdc: 1.5,
      currentValueUsdc: 1.5,
      realizedPnl: 0,
      status: "open",
      entryStyle: "probe",
      openedAt: "2026-04-01T00:00:00Z",
      closedAt: null,
      updatedAt: "2026-04-01T00:00:00Z",
    });

    const baseDeps = {
      gateway: { getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [] }) },
      marketRepo,
      orderRepo,
      fillRepo,
      positionRepo,
      inventoryLotRepo,
      legStateRepo,
      log: silentLog,
      db: conn.db,
    };

    const first = await runStartupPositionAdoption({ ...baseDeps, botRunId: createBotRunId("r1") });
    expect(first.seededLegStates).toBe(1);
    expect(first.alreadyPresentLegStates).toBe(0);

    const second = await runStartupPositionAdoption({
      ...baseDeps,
      botRunId: createBotRunId("r2"),
    });
    expect(second.seededLegStates).toBe(0);
    expect(second.alreadyPresentLegStates).toBe(1);

    const gate = new AlgoRiskGateImpl(orderRepo, positionRepo, silentLog);
    const decision = await gate.evaluate(makeProbeSignal());
    expect(decision.approved).toBe(false);
    expect(decision.rejectionReasons).toContain("open_position_exists");
  });
});
