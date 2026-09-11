import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessEventBus } from "@krabs/event-bus";
import {
  bootstrapLedgerDb,
  bootstrapControlDb,
  SqliteOrderRepository,
  SqliteFillRepository,
  SqlitePositionRepository,
  SqliteSettlementLedgerRepository,
  SqliteMarketResolutionRepository,
  SqliteInventoryLotRepository,
  SqliteAlgoTokenModeStateRepository,
  SqliteOrderPriceCooldownRepository,
} from "@krabs/db";
import {
  createOrderId,
  createTokenId,
  createCommandId,
  parseInstantMs,
  RESOLVED_LOSER_LOCAL_CANCEL_REASON,
  DEFAULT_EXECUTION_POLICY,
} from "@krabs/domain";
import type { ExchangeGateway, ExchangeFill, MarketRepository, Order } from "@krabs/domain";
import {
  reconcileOrders,
  type OrderReconcilerDeps,
} from "../modules/reconciliation/order-reconciler.js";
import { registerCancelIntent } from "../modules/reconciliation/order-status-resolver.js";
import { UserOrderStreamModule } from "../modules/reconciliation/user-order-stream-module.js";
import { RiskInventoryModule } from "../modules/risk-inventory/risk-inventory-module.js";
import { importExchangeFills } from "../modules/reconciliation/fill-reconciler.js";
import { discardStrandedFillAlert } from "../stranded-fill-alert.js";
import { ReconciliationModule } from "../modules/reconciliation/reconciliation-module.js";
import { ExchangeStateStore } from "../modules/execution/exchange-state-store.js";
import { OrderLifetimeModule } from "../modules/order-lifetime/order-lifetime-module.js";
import { SamePriceCooldownModule } from "../modules/same-price-cooldown/same-price-cooldown-module.js";
import { PositionSettler } from "../modules/resolution/position-settler.js";
import { ExecutionModule } from "../modules/execution/execution-module.js";
import {
  assertBounceForAllOwnershipInvariant,
  BounceForAllNullOwnerError,
  runOwnershipInvariantStartupGate,
} from "../modules/exit-ownership/assert-bounce-for-all-invariant.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => log,
} as any;
const created = "2026-08-01T00:00:10.500Z",
  settled = "2026-08-02T00:00:00.000Z";
const canonical = {
  conditionId: "condition",
  closed: true,
  acceptingOrders: false,
  enableOrderBook: false,
  tokens: [
    { tokenId: "loser", outcome: "No", winner: false },
    { tokenId: "winner", outcome: "Yes", winner: true },
  ],
};

describe("resolved loser administrative closure with real ledger repositories", () => {
  let conn: ReturnType<typeof bootstrapLedgerDb>;
  let deps: OrderReconcilerDeps & {
    bus: InProcessEventBus;
    orderRepo: SqliteOrderRepository;
    fillRepo: SqliteFillRepository;
  };
  let events: unknown[];
  const order = (): Order => deps.orderRepo.findById(createOrderId("sell"))!;
  const financialRows = () =>
    ["positions", "fills", "inventory_lots", "pnl_ledger", "settlement_ledger"].map((table) =>
      conn.db.prepare(`SELECT * FROM ${table}`).all(),
    );
  const inventoryModule = () =>
    new RiskInventoryModule({
      ...deps,
      positionRepo: deps.positionRepo!,
      runtimeMetrics: undefined,
      inventoryLotRepo: new SqliteInventoryLotRepository(conn.db),
      db: conn.db,
      markToMarketEnabled: false,
      emitStrandedFillAlert: discardStrandedFillAlert,
    });
  function partialSell() {
    conn.db
      .prepare(
        `INSERT INTO fills (fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,reconciled,filled_at)
      VALUES ('partial','sell','loser','condition','sell',0.2,2,0.4,1,'2026-08-01T00:01:00.000Z')`,
      )
      .run();
    conn.db
      .prepare(
        `INSERT INTO pnl_ledger (fill_id,position_id,delta,filled_at,created_at)
      VALUES ('partial','position',0.2,'2026-08-01T00:01:00.000Z','2026-08-01 00:01:01')`,
      )
      .run();
    deps.orderRepo.updateStatus(order().orderId, "partially-filled");
  }
  const lateFill = (): ExchangeFill => ({
    fillId: "late",
    orderId: "exchange",
    clientOrderId: "client",
    tokenId: order().tokenId,
    side: "sell",
    price: 0.2,
    size: 1,
    fee: 0,
    feeRateBps: 0,
    liquidityRole: "maker",
    timestamp: Date.parse("2026-08-01T00:02:00Z"),
  });

  beforeEach(() => {
    conn = bootstrapLedgerDb(":memory:");
    conn.db
      .prepare(
        `INSERT INTO positions (position_id,token_id,condition_id,side,size,status,opened_at,closed_at)
      VALUES ('position','loser','condition','buy',0,'closed','2026-08-01T00:00:00.000Z',?)`,
      )
      .run(settled);
    conn.db
      .prepare(
        `INSERT INTO orders (order_id,client_order_id,exchange_order_id,token_id,condition_id,
      position_id,side,order_type,price,size,size_usdc,status,bot_run_id,created_at)
      VALUES ('sell','client','exchange','loser','condition','position','sell','GTC',0.2,10,2,'open','run',?)`,
      )
      .run(created);
    conn.db
      .prepare(
        `INSERT INTO market_resolutions (condition_id,resolution,resolved_at,detected_at,source,raw_response,status)
      VALUES ('condition','Yes',?,?,'clob-api',?,'settled')`,
      )
      .run(settled, settled, JSON.stringify(canonical));
    conn.db
      .prepare(
        `INSERT INTO settlement_ledger (settlement_id,condition_id,position_id,token_id,resolution,
      settlement_price,size,delta,settled_at,created_at)
      VALUES ('settlement','condition','position','loser','Yes',0,8,-0.8,?,'2026-08-02 00:00:05')`,
      )
      .run(settled);
    const bus = new InProcessEventBus();
    events = [];
    bus.subscribe("OrderCancelled", async (event) => {
      events.push(event);
    });
    deps = {
      bus,
      log,
      orderRepo: new SqliteOrderRepository(conn.db),
      fillRepo: new SqliteFillRepository(conn.db),
      positionRepo: new SqlitePositionRepository(conn.db),
      settlementLedgerRepo: new SqliteSettlementLedgerRepository(conn.db),
      marketResolutionRepo: new SqliteMarketResolutionRepository(conn.db),
      suspiciousEmptyThreshold: 0,
      consecutiveMissThreshold: 3,
      consecutiveMissCounts: new Map(),
      gateway: {
        getOpenOrdersResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
        getOrderResult: vi.fn().mockResolvedValue({ ok: true, data: null }),
        getFillsResult: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      } as unknown as ExchangeGateway,
    };
  });
  afterEach(() => conn.close());

  it.each([false, true])(
    "passes the real startup ownership gate after one default module pass (partial=%s)",
    async (partial) => {
      if (partial) partialSell();
      const control = bootstrapControlDb(":memory:");
      const store = new ExchangeStateStore();
      const module = () =>
        new ReconciliationModule({
          bus: deps.bus,
          gateway: deps.gateway,
          orderRepo: deps.orderRepo,
          fillRepo: deps.fillRepo,
          positionRepo: deps.positionRepo!,
          marketResolutionRepo: deps.marketResolutionRepo!,
          settlementLedgerRepo: deps.settlementLedgerRepo!,
          marketRepo: { findByTokenId: () => null } as unknown as MarketRepository,
          log,
          reconcileIntervalMs: 60_000,
          exchangeStateStore: store,
        });
      const gate = () =>
        runOwnershipInvariantStartupGate({
          ledgerDb: conn.db,
          controlDb: control.db,
          applyToAllMarkets: true,
          log: { ...log, fatal: vi.fn() },
        });
      const before = financialRows();
      const reconciliation = module();
      try {
        expect(gate).toThrow(BounceForAllNullOwnerError);
        store.updateExchangeSellOrders(
          [{ orderId: "exchange", tokenId: order().tokenId, sizeRemaining: 10 }],
          Date.now(),
        );
        // index.ts invokes this before module subscriptions are started.
        await reconciliation.runReconciliation();
        expect(order()).toMatchObject({
          status: "cancelled",
          cancelReason: RESOLVED_LOSER_LOCAL_CANCEL_REASON,
          fillProgressShares: partial ? 2 : 0,
        });
        expect(gate).not.toThrow();
        expect(store.getOpenSellSizeForToken(order().tokenId) ?? 0).toBe(0);
        await reconciliation.runReconciliation();
        await module().runReconciliation();
        expect(gate).not.toThrow();
        expect(events).toHaveLength(1);
        expect(financialRows()).toEqual(before);
        expect(deps.gateway.getOrderResult).toHaveBeenCalledTimes(2);
        const lifetimeReads = vi
          .mocked(deps.gateway.getFillsResult!)
          .mock.calls.filter(([since]) => since === Date.parse("2026-08-01T00:00:09Z"));
        expect(lifetimeReads).toHaveLength(1);
      } finally {
        control.close();
      }
    },
  );

  it.each(["working", "failed", "history"])(
    "retains the first-miss SELL and fails ownership with %s evidence",
    async (evidence) => {
      if (evidence === "working")
        vi.mocked(deps.gateway.getOrderResult!).mockResolvedValue({
          ok: true,
          data: {
            orderId: "exchange",
            clientOrderId: "client",
            tokenId: order().tokenId,
            side: "sell",
            status: "OPEN",
            price: 0.2,
            sizeTotal: 10,
            sizeFilled: 0,
            sizeRemaining: 10,
            createdAt: Date.parse(created),
          },
        });
      if (evidence === "failed")
        vi.mocked(deps.gateway.getOrderResult!).mockResolvedValue({
          ok: false,
          reason: "server",
          attempts: 1,
        });
      if (evidence === "history")
        vi.mocked(deps.gateway.getFillsResult!).mockResolvedValue({
          ok: false,
          reason: "parse",
          attempts: 1,
        });
      const before = financialRows();
      await reconcileOrders(deps);
      expect(deps.gateway.getOrderResult).toHaveBeenCalledOnce();
      expect(order().status).toBe("open");
      expect(events).toEqual([]);
      expect(financialRows()).toEqual(before);
      expect(() => assertBounceForAllOwnershipInvariant(conn.db, true)).toThrow(
        BounceForAllNullOwnerError,
      );
    },
  );

  it.each([
    "UPDATE orders SET side='buy'",
    "UPDATE positions SET status='open',size=10,closed_at=NULL",
    "DELETE FROM settlement_ledger",
  ])("keeps generic missing orders behind threshold three: %s", async (sql) => {
    conn.db.exec(sql);
    const before = financialRows();
    await reconcileOrders(deps);
    await reconcileOrders(deps);
    expect(deps.consecutiveMissCounts!.get("exchange")).toBe(2);
    expect(deps.gateway.getOrderResult).not.toHaveBeenCalled();
    await reconcileOrders(deps);
    expect(deps.gateway.getOrderResult).toHaveBeenCalledExactlyOnceWith("exchange");
    expect(order().status).toBe("open");
    expect(deps.gateway.getFillsResult).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(financialRows()).toEqual(before);
  });

  it.each(["grace", "suspicious", "unreliable"])(
    "withholds eligible first-miss recovery for %s snapshots",
    async (guard) => {
      if (guard === "grace") deps.phantomGraceMs = Date.now() - Date.parse(created) + 60_000;
      if (guard === "suspicious") deps.suspiciousEmptyThreshold = 1;
      if (guard === "unreliable")
        vi.mocked(deps.gateway.getOpenOrdersResult!).mockResolvedValue({
          ok: false,
          reason: "server",
          attempts: 1,
        });
      const result = await reconcileOrders(deps);
      if (guard === "grace") expect(result.phantomsSkippedGrace).toBe(1);
      else
        expect(result.skipReason).toBe(
          guard === "suspicious" ? "suspicious_empty" : "unreliable_snapshot",
        );
      expect(deps.consecutiveMissCounts!.size).toBe(0);
      expect(deps.gateway.getOrderResult).not.toHaveBeenCalled();
      expect(deps.gateway.getFillsResult).not.toHaveBeenCalled();
      expect(order().status).toBe("open");
      expect(() => assertBounceForAllOwnershipInvariant(conn.db, true)).toThrow(
        BounceForAllNullOwnerError,
      );
    },
  );

  function settleCurrentClobResolution() {
    const settler = new PositionSettler(
      deps.positionRepo!,
      new SqliteInventoryLotRepository(conn.db),
      conn.db,
    );
    for (let attempt = 0; attempt < 3; attempt++) {
      conn.db.exec(
        "DELETE FROM settlement_ledger; UPDATE positions SET status='open',size=8,closed_at=NULL",
      );
      const resolvedAt = new Date().toISOString();
      conn.db
        .prepare("UPDATE market_resolutions SET resolved_at=?,detected_at=?")
        .run(resolvedAt, resolvedAt);
      settler.settle({
        conditionId: "condition",
        resolution: "Yes",
        resolvedAt,
        source: "clob-api",
        winnerTokenId: createTokenId("winner"),
        rawResponse: JSON.stringify(canonical),
        candidates: [
          {
            tokenId: order().tokenId,
            conditionId: "condition",
            slug: "fixture",
            outcome: "No",
            endDate: created,
            positionId: order().positionId!,
          },
        ],
      });
      const record = deps.settlementLedgerRepo!.findLocalClosureEvidence!(order())!.settlements[0]!;
      const inserted = parseInstantMs(record.createdAt!);
      // Retry only if the real clock crossed a second or landed exactly on its boundary.
      if (inserted < Date.parse(resolvedAt) && Date.parse(resolvedAt) < inserted + 1000)
        return record;
    }
    throw new Error(
      "Could not capture a millisecond resolution within the real SQLite insertion second",
    );
  }

  it.each(["before", "tie", "after", "precise-before"])(
    "uses the real settlement default without accepting ambiguous accounting: %s",
    async (timing) => {
      partialSell();
      const record = settleCurrentClobResolution();
      const inserted = parseInstantMs(record.createdAt!);
      expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(inserted).toBeLessThan(Date.parse(record.settledAt));
      const offset = timing === "tie" ? 0 : timing === "after" ? 500 : -1000;
      conn.db
        .prepare("UPDATE pnl_ledger SET created_at=?")
        .run(new Date(inserted + offset).toISOString());
      if (timing === "precise-before")
        conn.db
          .prepare("UPDATE settlement_ledger SET created_at=?")
          .run(new Date(inserted).toISOString());
      const before = financialRows();
      await reconcileOrders(deps);
      expect(order().status).toBe(timing === "before" ? "cancelled" : "partially-filled");
      expect(events).toHaveLength(timing === "before" ? 1 : 0);
      expect(financialRows()).toEqual(before);
    },
  );

  it("closes the eligible SELL while an unrelated prepared BUY awaits normal POST acknowledgement", async () => {
    const received = vi.fn(),
      updated = vi.fn();
    deps.bus.subscribe("FillReceived", received);
    deps.bus.subscribe("PositionUpdated", updated);
    let buyFill!: ExchangeFill;
    deps.gateway.prepareOrder = vi.fn().mockResolvedValue({
      orderId: "prepared-buy",
      __preparedOrderBrand: "PreparedOrder",
    });
    deps.gateway.submitPreparedOrder = vi.fn(async (_prepared, beforeInvoke) => {
      beforeInvoke?.();
      const pending = deps.orderRepo.findByExchangeOrderId("prepared-buy")!;
      expect(pending.status).toBe("pending");
      buyFill = {
        ...lateFill(),
        fillId: "pending-buy-fill",
        orderId: "prepared-buy",
        clientOrderId: null,
        tokenId: pending.tokenId,
        side: "buy",
        size: 10,
        timestamp: Date.now(),
      };
      vi.mocked(deps.gateway.getFillsResult!).mockResolvedValue({
        ok: true,
        data: [
          {
            ...lateFill(),
            fillId: "partial",
            size: 2,
            timestamp: Date.parse("2026-08-01T00:01:00Z"),
          },
          buyFill,
        ],
      });
      const before = financialRows();
      await reconcileOrders(deps);
      expect(order().status).toBe("cancelled");
      expect(events).toHaveLength(1);
      expect(deps.orderRepo.findById(pending.orderId)).toMatchObject({
        status: "pending",
        exchangeOrderId: "prepared-buy",
      });
      expect(financialRows()).toEqual(before);
      expect(received).not.toHaveBeenCalled();
      expect(updated).not.toHaveBeenCalled();
      return { kind: "accepted" as const, orderId: "prepared-buy" };
    });
    const execution = new ExecutionModule({
      ...deps,
      runtimeMetrics: undefined,
      marketRepo: {
        findByTokenId: () => ({ active: true, conditionId: "condition" }),
      } as unknown as MarketRepository,
      botRunId: order().botRunId,
      runtimeMode: "live-lite",
      runtimeControl: { isPaused: () => false },
    });
    const inventory = inventoryModule();
    await inventory.start();
    const sell = order();
    conn.db.prepare("DELETE FROM orders WHERE order_id=?").run(sell.orderId);
    await execution.start();
    deps.orderRepo.save(sell);
    partialSell();
    try {
      await deps.bus.publish("PlaceOrderRequested", {
        timestamp: Date.now(),
        command: {
          type: "PlaceOrderCommand",
          commandId: createCommandId("pending-buy"),
          clientOrderId: "pending-client" as any,
          source: "strategy",
          tokenId: createTokenId("unrelated"),
          conditionId: order().conditionId,
          side: "buy",
          size: 10,
          price: 0.2,
          orderType: "GTC",
          tickSize: 0.01,
          negRisk: false,
          sequenceInTick: 0,
          signalReason: null,
        },
      });
      expect(deps.gateway.submitPreparedOrder).toHaveBeenCalledOnce();
      const acknowledged = deps.orderRepo.findByExchangeOrderId("prepared-buy")!;
      expect(acknowledged.status).toBe("open");
      const result = await importExchangeFills([buyFill], {
        ...deps,
        deferPendingExactFills: true,
      });
      expect(result).toMatchObject({ imported: 1, deferred: 0 });
      expect(deps.orderRepo.findById(acknowledged.orderId)?.status).toBe("filled");
      expect(deps.fillRepo.findUnreconciled()).toEqual([]);
      expect(received).toHaveBeenCalledOnce();
      expect(updated).toHaveBeenCalledOnce();
      expect(deps.positionRepo!.findActiveByTokenId(buyFill.tokenId)[0]?.size).toBe(10);
    } finally {
      await execution.stop();
      await inventory.stop();
    }
  });

  it("selects closure fill candidates through indexes without scanning all fills", () => {
    partialSell();
    const prepare = vi.spyOn(conn.db, "prepare");
    const candidate = order();
    const evidence = deps.settlementLedgerRepo!.findLocalClosureEvidence!(candidate);
    const sql = prepare.mock.calls.find(([query]) => query.includes("AS fillId"))?.[0];
    prepare.mockRestore();
    expect(evidence?.fills.map((fill) => fill.fillId)).toEqual(["partial"]);
    expect(sql).toBeDefined();
    const plan = conn.db
      .prepare(`EXPLAIN QUERY PLAN ${sql!}`)
      .all(candidate.tokenId, candidate.orderId, ...Array(3).fill(candidate.positionId)) as {
      detail: string;
    }[];
    const details = plan.map((row) => row.detail).join("\n");
    expect(details).not.toMatch(/SCAN (?:f|fills)\b|CORRELATED/i);
    for (const index of [
      "idx_fills_token",
      "idx_fills_order",
      "idx_orders_position",
      "idx_inventory_lots_position",
    ]) {
      expect(details).toContain(index);
    }
    expect(details).toMatch(/SEARCH f USING INDEX sqlite_autoindex_fills_1/);
  });

  it("scans lots once per accounting batch as BUY candidates grow, retaining cross-position ambiguity", async () => {
    deps.orderRepo.save({
      ...order(),
      orderId: createOrderId("buy"),
      clientOrderId: "buy-client" as any,
      exchangeOrderId: "buy-exchange",
      side: "buy",
      status: "filled",
    });
    const insertFill = conn.db.prepare(`INSERT INTO fills
      (fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,reconciled,filled_at)
      VALUES (?,'buy','loser','condition','buy',0.1,10,1,1,'2026-08-01T00:00:11Z')`);
    const insertLot = conn.db.prepare(`INSERT INTO inventory_lots
      (lot_id,position_id,token_id,side,size,remaining_size,entry_price,cost_usdc,fill_id,created_at)
      VALUES (?,'position','loser','buy',10,0,0.1,1,?,'2026-08-01 00:00:12')`);
    const candidate = order();
    const prepare = conn.db.prepare.bind(conn.db);
    const scanCounts: number[] = [];
    for (let i = 0; i < 16; i++) {
      insertFill.run(`buy-${i}`);
      insertLot.run(`lot-${i}`, `buy-${i}`);
      if (i !== 0 && i !== 15) continue;
      const calls: { sql: string; all: ReturnType<typeof vi.spyOn> }[] = [];
      const spy = vi.spyOn(conn.db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        if (/FROM (?:inventory_lots|pnl_ledger) a\b/.test(sql))
          calls.push({ sql, all: vi.spyOn(statement, "all") });
        return statement;
      });
      const evidence = deps.settlementLedgerRepo!.findLocalClosureEvidence!(candidate);
      spy.mockRestore();
      expect(evidence?.fills).toHaveLength(i + 1);
      expect(evidence?.fills.every((fill) => fill.accounting.length === 1)).toBe(true);
      let scans = 0;
      for (const call of calls) {
        for (const args of call.all.mock.calls) {
          const plan = prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...args) as {
            detail: string;
          }[];
          expect(plan.some(({ detail }) => /CORRELATED/.test(detail))).toBe(false);
          scans += plan.filter(({ detail }) => /^SCAN a\b/.test(detail)).length;
        }
        call.all.mockRestore();
      }
      scanCounts.push(scans);
    }
    expect(scanCounts).toEqual([1, 1]);
    conn.db.exec(`INSERT INTO positions (position_id,token_id,condition_id,side,status)
      VALUES ('other','loser','condition','buy','closed');
      INSERT INTO inventory_lots SELECT 'ambiguous','other',token_id,side,size,remaining_size,
        entry_price,cost_usdc,fill_id,created_at FROM inventory_lots WHERE lot_id='lot-0'`);
    const evidence = deps.settlementLedgerRepo!.findLocalClosureEvidence!(candidate);
    expect(evidence?.fills.find((fill) => fill.fillId === "buy-0")?.accounting).toHaveLength(2);
    await reconcileOrders(deps);
    expect(order().status).toBe("open");
    expect(events).toEqual([]);
    expect(deps.gateway.getFillsResult).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "closes once, preserves all financial rows, and retains the reason after filled promotion (partial=%s)",
    async (partial) => {
      if (partial) partialSell();
      const before = financialRows();
      const write = vi.spyOn(deps.orderRepo, "updateStatus");
      registerCancelIntent("sell", "stale_exit_ttl");
      await reconcileOrders(deps);
      expect(order()).toMatchObject({
        status: "cancelled",
        cancelReason: RESOLVED_LOSER_LOCAL_CANCEL_REASON,
        fillProgressShares: partial ? 2 : 0,
      });
      expect(financialRows()).toEqual(before);
      expect(events).toHaveLength(1);
      expect(write).toHaveBeenCalledTimes(1);
      expect(deps.gateway.getFillsResult).toHaveBeenCalledWith(Date.parse("2026-08-01T00:00:09Z"));
      await reconcileOrders(deps);
      expect(events).toHaveLength(1);
      expect(deps.gateway.getFillsResult).toHaveBeenCalledTimes(1);
      deps.orderRepo.updateStatus(order().orderId, "filled");
      expect(new SqliteOrderRepository(conn.db).findLocallyClosedResolvedLosers()).toHaveLength(1);
    },
  );

  it.each([
    "UPDATE orders SET side='buy'",
    "UPDATE orders SET status='pending'",
    "UPDATE orders SET exchange_order_id=''",
    "UPDATE orders SET position_id=NULL",
    "UPDATE orders SET created_at='bad'",
    "UPDATE positions SET status='open'",
    "UPDATE positions SET size=1",
    "UPDATE positions SET closed_at=NULL",
    "UPDATE positions SET closed_at='bad'",
    "UPDATE positions SET opened_at='2026-08-03T00:00:00Z'",
    "UPDATE positions SET token_id='other'",
    "UPDATE positions SET condition_id='other'",
    "UPDATE market_resolutions SET status='detected'",
    "UPDATE market_resolutions SET resolution='unknown'",
    "UPDATE market_resolutions SET resolution='No'",
    "UPDATE market_resolutions SET source='manual'",
    "UPDATE market_resolutions SET raw_response='{}'",
    "UPDATE settlement_ledger SET settlement_price=1",
    "UPDATE settlement_ledger SET token_id='other'",
    "UPDATE settlement_ledger SET resolution='algo-redeem'",
    "UPDATE settlement_ledger SET settled_at='bad'",
    "UPDATE settlement_ledger SET created_at='2026-08-01T00:00:00Z'",
    "DELETE FROM settlement_ledger",
  ])("fails closed without a history scan: %s", async (sql) => {
    conn.db.exec(sql);
    await reconcileOrders(deps);
    expect(events).toEqual([]);
    expect(deps.gateway.getFillsResult).not.toHaveBeenCalled();
  });

  it.each([
    "submitUnknownRecoveryV1",
    "startupExitRecoveryBlockV1",
    "exitRecoveryFenceV1",
    "exitRecoveryChildV1",
  ])("excludes valid and malformed raw marker presence: %s", async (marker) => {
    for (const raw of [JSON.stringify({ [marker]: null }), `{"${marker}":`]) {
      conn.db.prepare("UPDATE orders SET metadata_json=?").run(raw);
      await reconcileOrders(deps);
      expect(events).toEqual([]);
      expect(deps.gateway.getFillsResult).not.toHaveBeenCalled();
      expect(() => assertBounceForAllOwnershipInvariant(conn.db, true)).toThrow(
        BounceForAllNullOwnerError,
      );
    }
  });

  it.each([
    "DELETE FROM pnl_ledger",
    "UPDATE fills SET reconciled=0",
    "UPDATE fills SET filled_at='bad'",
    "UPDATE fills SET condition_id='other'",
    "UPDATE fills SET side='buy'",
    "UPDATE fills SET filled_at='2026-07-31T00:00:00Z'",
    "UPDATE pnl_ledger SET created_at='2026-08-02T00:00:05.000Z'",
    "UPDATE pnl_ledger SET created_at='2026-08-02T00:00:06.000Z'",
  ])("blocks unproven partial accounting: %s", async (sql) => {
    partialSell();
    conn.db.exec(sql);
    const before = financialRows();
    await reconcileOrders(deps);
    expect(order().status).toBe("partially-filled");
    expect(events).toEqual([]);
    expect(financialRows()).toEqual(before);
    expect(deps.gateway.getFillsResult).not.toHaveBeenCalled();
  });

  it("blocks wrong-position accounting and ambiguous settlements", async () => {
    partialSell();
    conn.db
      .exec(`INSERT INTO positions (position_id,token_id,condition_id,side,status) VALUES ('other','other','condition','buy','closed');
      UPDATE pnl_ledger SET position_id='other'`);
    await reconcileOrders(deps);
    expect(events).toEqual([]);
    conn.db.exec(`UPDATE pnl_ledger SET position_id='position';
      INSERT INTO settlement_ledger SELECT 'second',condition_id,position_id,token_id,resolution,settlement_price,size,delta,settled_at,created_at FROM settlement_ledger`);
    await reconcileOrders(deps);
    expect(events).toEqual([]);
  });

  it("requires explicit Gamma finality and unambiguous losing token mapping", async () => {
    const raw = {
      conditionId: "condition",
      closed: true,
      umaResolutionStatus: "proposed",
      clobTokenIds: '["loser","winner"]',
      outcomes: '["No","Yes"]',
      outcomePrices: '["0","1"]',
    };
    const set = () =>
      conn.db
        .prepare("UPDATE market_resolutions SET source='gamma-api', raw_response=?")
        .run(JSON.stringify(raw));
    set();
    await reconcileOrders(deps);
    expect(events).toEqual([]);
    raw.umaResolutionStatus = "resolved";
    raw.clobTokenIds = '["loser","loser"]';
    set();
    await reconcileOrders(deps);
    expect(events).toEqual([]);
    raw.clobTokenIds = '["loser","winner"]';
    set();
    await reconcileOrders(deps);
    expect(order().status).toBe("cancelled");
  });

  it("shares one lifetime batch across candidates", async () => {
    deps.orderRepo.save({
      ...order(),
      orderId: createOrderId("second"),
      clientOrderId: "second-client" as any,
      exchangeOrderId: "second-exchange",
    });
    await reconcileOrders(deps);
    expect(deps.gateway.getFillsResult).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(2);
    expect(deps.gateway.getOrderResult).toHaveBeenCalledTimes(4);
  });

  it.each(["parse", "server", "missing"])(
    "requires reliable history (%s; pending trades are parse failures)",
    async (reason) => {
      if (reason === "missing") delete deps.gateway.getFillsResult;
      else
        vi.mocked(deps.gateway.getFillsResult!).mockResolvedValue({
          ok: false,
          reason: reason as "parse" | "server",
          attempts: 1,
        });
      await reconcileOrders(deps);
      expect(order().status).toBe("open");
      expect(events).toEqual([]);
    },
  );

  it("imports newly discovered history but refuses closure when accounting did not succeed", async () => {
    vi.mocked(deps.gateway.getFillsResult!).mockResolvedValue({ ok: true, data: [lateFill()] });
    await reconcileOrders(deps);
    expect(deps.fillRepo.findUnreconciled()).toHaveLength(1);
    expect(order().status).toBe("partially-filled");
    expect(events).toEqual([]);
  });

  it("requires BUY lot attribution before allowing the same settled cycle", async () => {
    deps.orderRepo.save({
      ...order(),
      orderId: createOrderId("buy"),
      clientOrderId: "buy-client" as any,
      exchangeOrderId: "buy-exchange",
      side: "buy",
      status: "filled",
      positionId: null,
    });
    conn.db
      .exec(`INSERT INTO fills (fill_id,order_id,token_id,condition_id,side,price,size,size_usdc,reconciled,filled_at)
      VALUES ('buy-fill','buy','loser','condition','buy',0.1,10,1,1,'2026-08-01T00:00:11.000Z')`);
    await reconcileOrders(deps);
    expect(events).toEqual([]);
    conn.db
      .exec(`INSERT INTO inventory_lots (lot_id,position_id,token_id,side,size,remaining_size,entry_price,cost_usdc,fill_id,created_at)
      VALUES ('lot','position','loser','buy',10,0,0.1,1,'buy-fill','2026-08-01 00:00:12')`);
    const before = financialRows();
    await reconcileOrders(deps);
    expect(order().status).toBe("cancelled");
    expect(financialRows()).toEqual(before);
  });

  it.each(["active", "quarantine", "context", "dependencies"])(
    "does not scan or close with %s",
    async (guard) => {
      if (guard === "active")
        conn.db.exec(`INSERT INTO positions (position_id,token_id,condition_id,side,status)
      VALUES ('active','loser','condition','buy','dust')`);
      if (guard === "dependencies") delete deps.settlementLedgerRepo;
      if (guard === "quarantine")
        deps.exactNullStartupQuarantine = {
          isExactNullStartupOrderQuarantined: () => true,
          observeExactNullStartupRemoteState: vi.fn(),
        } as any;
      if (guard === "context")
        deps.recoveryContexts = [
          { order: order(), isCurrent: () => true, observe: vi.fn() },
        ] as any;
      await reconcileOrders(deps);
      expect(order().status).toBe("open");
      expect(events).toEqual([]);
      expect(deps.gateway.getFillsResult).not.toHaveBeenCalled();
      expect(() => assertBounceForAllOwnershipInvariant(conn.db, true)).toThrow(
        BounceForAllNullOwnerError,
      );
    },
  );

  it("releases the cached reservation without TTL, cooldown, reprice or replacement effects", async () => {
    const store = new ExchangeStateStore();
    const modeStateRepo = new SqliteAlgoTokenModeStateRepository(conn.db);
    const cooldownRepo = new SqliteOrderPriceCooldownRepository(conn.db);
    const marketRepo = { findByTokenId: () => null } as unknown as MarketRepository;
    const chain = { get: vi.fn(), applyRepriceChainEvent: vi.fn() };
    const lifetime = new OrderLifetimeModule({
      ...deps,
      marketRepo,
      positionRepo: deps.positionRepo!,
      modeStateRepo,
      riskEventRepo: { insert: vi.fn() } as any,
      runtimeMetrics: { writeLatest: vi.fn() } as any,
      policy: () => DEFAULT_EXECUTION_POLICY.orderLifetime,
    });
    const cooldown = new SamePriceCooldownModule({ ...deps, cooldownRepo });
    vi.mocked(deps.gateway.getOpenOrdersResult!).mockResolvedValueOnce({
      ok: false,
      reason: "server",
      attempts: 1,
    });
    const reconciliation = new ReconciliationModule({
      bus: deps.bus,
      gateway: deps.gateway,
      orderRepo: deps.orderRepo,
      fillRepo: deps.fillRepo,
      log,
      marketRepo,
      reconcileIntervalMs: 60_000,
      fillCompletionTolerance: 0.005,
      exchangeStateStore: store,
      legStateRepo: chain as any,
      repriceChainPolicy: () => ({ enabled: true }) as any,
    });
    await lifetime.start();
    await cooldown.start();
    await reconciliation.start();
    try {
      const modes = conn.db.prepare("SELECT * FROM algo_token_mode_state").all();
      expect(modes).toHaveLength(1);
      store.updateExchangeSellOrders(
        [{ orderId: "exchange", tokenId: order().tokenId, sizeRemaining: 10 }],
        Date.now(),
      );
      expect(store.getOpenSellSizeForToken(order().tokenId)).toBe(10);
      const replacement = vi.fn();
      deps.bus.subscribe("PlaceOrderRequested", replacement);
      registerCancelIntent("sell", "stale_exit_ttl");
      await reconcileOrders(deps);
      expect(order().status).toBe("cancelled");
      expect(store.getOpenSellSizeForToken(order().tokenId)).toBeNull();
      expect(conn.db.prepare("SELECT * FROM algo_token_mode_state").all()).toEqual(modes);
      expect(conn.db.prepare("SELECT * FROM order_price_cooldowns").all()).toEqual([]);
      expect(chain.get).not.toHaveBeenCalled();
      expect(chain.applyRepriceChainEvent).not.toHaveBeenCalled();
      expect(replacement).not.toHaveBeenCalled();
    } finally {
      await reconciliation.stop();
      await cooldown.stop();
      await lifetime.stop();
    }
  });

  it("lets deferred final exact OPEN win and serializes concurrent closure attempts", async () => {
    let release!: (value: any) => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(deps.gateway.getOrderResult!)
      .mockResolvedValueOnce({ ok: true, data: null })
      .mockImplementationOnce(() => {
        entered();
        return new Promise((resolve) => {
          release = resolve;
        });
      });
    const pass = reconcileOrders(deps);
    await ready;
    release({ ok: true, data: { status: "OPEN", sizeFilled: 0 } });
    await pass;
    expect(order().status).toBe("open");
    expect(events).toEqual([]);
    const write = vi.spyOn(deps.orderRepo, "updateStatus");
    await Promise.all([reconcileOrders(deps), reconcileOrders(deps)]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(order().status).toBe("cancelled");
  });

  it.each(["identity", "quarantine", "context", "metadata", "settlement", "position", "fill"])(
    "rereads after the final exact await: %s",
    async (change) => {
      vi.mocked(deps.gateway.getOrderResult!)
        .mockResolvedValueOnce({ ok: true, data: null })
        .mockImplementationOnce(async () => {
          if (change === "identity") conn.db.exec("UPDATE orders SET client_order_id='changed'");
          if (change === "context") deps.recoveryContexts = [{ order: order() }] as any;
          if (change === "metadata")
            conn.db.exec(`UPDATE orders SET metadata_json='{"exitRecoveryChildV1":null}'`);
          if (change === "settlement") conn.db.exec("DELETE FROM settlement_ledger");
          if (change === "position") conn.db.exec("UPDATE positions SET size=1");
          if (change === "quarantine")
            deps.exactNullStartupQuarantine = {
              isExactNullStartupOrderQuarantined: () => true,
            } as any;
          if (change === "fill") partialSell();
          return { ok: true, data: null };
        });
      await reconcileOrders(deps);
      expect(events).toEqual([]);
      expect(order().status).not.toBe("cancelled");
    },
  );

  it.each([false, "before-start", "after-start"] as const)(
    "keeps late WSS discovery and failed inventory claims visible (locallyClosed=%s)",
    async (locallyClosed) => {
      let handlers: any;
      const conditions: string[][] = [];
      deps.gateway.createUserEventStream = (callbacks) => {
        handlers = callbacks;
        return {
          close: () => {},
          setConditionIds: (ids) => {
            conditions.push([...ids]);
          },
        };
      };
      const marketRepo = {
        findByTokenId: () => ({ conditionId: "condition" }),
      } as unknown as MarketRepository;
      const stream = new UserOrderStreamModule({ ...deps, marketRepo });
      const inventory = inventoryModule();
      await inventory.start();
      if (locallyClosed === "before-start") await reconcileOrders(deps);
      await stream.start();
      try {
        if (locallyClosed === "after-start") await reconcileOrders(deps);
        const before = financialRows();
        expect(conditions.at(-1)).toEqual(["condition"]);
        const received = vi.fn();
        deps.bus.subscribe("FillReceived", received);
        const fill = { ...lateFill(), size: 10 };
        const event = {
          type: "trade",
          tradeId: "late",
          status: "CONFIRMED",
          timestamp: lateFill().timestamp,
          fills: [fill],
        };
        await handlers.onTradeEvents([event]);
        await handlers.onTradeEvents([event]);
        await importExchangeFills([fill], { ...deps, bus: deps.bus });
        expect(deps.fillRepo.findUnreconciled()).toHaveLength(1);
        expect(received).toHaveBeenCalledTimes(1);
        expect(inventory.getDiagnostics().fillApplicationFailures).toBe(1);
        expect(order().status).toBe("filled");
        expect(financialRows().filter((_, i) => i !== 1)).toEqual(before.filter((_, i) => i !== 1));
        expect(conditions.at(-1)).toEqual(locallyClosed ? ["condition"] : []);
      } finally {
        await stream.stop();
        await inventory.stop();
      }
    },
  );
});
