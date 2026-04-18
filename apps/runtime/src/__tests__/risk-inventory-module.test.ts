import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createFillId,
  createOrderId,
  createPositionId,
  createLotId,
  createCommandId,
  createConditionId,
} from "@plankton/domain";
import { LiveLiteGuard } from "../live-lite-guard.js";
import type {
  PositionRepository,
  InventoryLotRepository,
  OrderRepository,
  Position,
  InventoryLot,
  Order,
  Signal,
  ClientOrderId,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { RiskInventoryModule } from "../modules/risk-inventory/risk-inventory-module.js";

// ─── Test helpers ────────────────────────────────────────────────────────

const TOK_ID = createTokenId("tok-yes");
const COND_ID = createConditionId("cond-btc");

function makeSignal(overrides?: Partial<Signal>): Signal {
  return {
    signalId: "sig-1",
    tokenId: TOK_ID,
    conditionId: COND_ID,
    side: "buy",
    suggestedPrice: 0.5,
    suggestedSize: 10,
    suggestedSizeUsdc: 5,
    reason: "probe-entry",
    strategyTick: Date.now(),
    sequenceInTick: 0,
    decisionRuleId: null,
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockPositionRepo(position?: Position | Position[] | null): PositionRepository {
  const positions = Array.isArray(position) ? position : position ? [position] : [];
  return {
    save: vi.fn(),
    findByTokenId: vi
      .fn()
      .mockImplementation(
        (tokenId: ReturnType<typeof createTokenId>) =>
          positions.find((entry) => String(entry.tokenId) === String(tokenId)) ?? null,
      ),
    findOpen: vi.fn().mockReturnValue(positions.filter((entry) => entry.status === "open")),
    findDust: vi.fn().mockReturnValue(positions.filter((entry) => entry.status === "dust")),
    findAll: vi.fn().mockReturnValue(positions),
    findOpenByEntryStyle: vi.fn().mockReturnValue([]),
  };
}

function createMockLotRepo(): InventoryLotRepository {
  return {
    save: vi.fn(),
    findByTokenId: vi.fn().mockReturnValue([]),
    findOpen: vi.fn().mockReturnValue([]),
    consumeFifo: vi.fn().mockReturnValue([]),
    settleAll: vi.fn(),
  };
}

function createMockOrderRepo(order?: Order | null): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(order ?? null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
    sumOpenBuyNotional: vi.fn().mockReturnValue(0),
  };
}

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

const mockDb = {
  prepare: vi.fn().mockReturnValue({ run: vi.fn() }),
} as any;

// ─── Tests ───────────────────────────────────────────────────────────────

describe("RiskInventoryModule", () => {
  let bus: InProcessEventBus;
  let positionRepo: ReturnType<typeof createMockPositionRepo>;
  let lotRepo: ReturnType<typeof createMockLotRepo>;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let fillRepo: { markReconciled: ReturnType<typeof vi.fn> };
  let mod: RiskInventoryModule;

  function createModule(liveLiteGuard?: LiveLiteGuard) {
    return new RiskInventoryModule({
      bus,
      positionRepo,
      inventoryLotRepo: lotRepo,
      orderRepo,
      fillRepo,
      log: silentLog,
      db: mockDb,
      liveLiteGuard,
    });
  }

  beforeEach(() => {
    bus = new InProcessEventBus();
    positionRepo = createMockPositionRepo();
    lotRepo = createMockLotRepo();
    orderRepo = createMockOrderRepo();
    fillRepo = { markReconciled: vi.fn() };
    mod = createModule();
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────

  it("healthCheck returns not-ok before start", async () => {
    const h = await mod.healthCheck();
    expect(h.ok).toBe(false);
  });

  it("healthCheck returns ok after start", async () => {
    await mod.start();
    const h = await mod.healthCheck();
    expect(h.ok).toBe(true);
    await mod.stop();
  });

  // ─── Signal approval ───────────────────────────────────────────────

  it("approves valid entry signal for active family", async () => {
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(approved).toHaveLength(1);
    expect(approved[0].signal.signalId).toBe("sig-1");

    await mod.stop();
  });

  // ─── Fill handling: buy ───────────────────────────────────────────

  it("creates new position on buy fill", async () => {
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: "plk_abc" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    // Position was created
    expect(positionRepo.save).toHaveBeenCalledTimes(1);
    expect(posUpdates).toHaveLength(1);
    expect(posUpdates[0].position.size).toBe(10);
    expect(posUpdates[0].position.avgEntryPrice).toBe(0.5);
    expect(posUpdates[0].position.status).toBe("open");

    // Lot was created
    expect(lotRepo.save).toHaveBeenCalledTimes(1);

    await mod.stop();
  });

  it("sets entryStyle='spray' on new position from spray-entry fill", async () => {
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-spray"),
      orderId: createOrderId("ord-spray"),
      clientOrderId: "plk_spray" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: "spray-entry",
      timestamp: Date.now(),
    });

    expect(posUpdates).toHaveLength(1);
    expect(posUpdates[0].position.entryStyle).toBe("spray");

    await mod.stop();
  });

  it("sets entryStyle='probe' on new position from probe-entry fill", async () => {
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-probe"),
      orderId: createOrderId("ord-probe"),
      clientOrderId: "plk_probe" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: "probe-entry",
      timestamp: Date.now(),
    });

    expect(posUpdates).toHaveLength(1);
    expect(posUpdates[0].position.entryStyle).toBe("probe");

    await mod.stop();
  });

  it("scales into existing position on buy fill", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      conditionId: COND_ID,

      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);
    mod = createModule();
    await mod.start();

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-2"),
      orderId: createOrderId("ord-2"),
      clientOrderId: "plk_def" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.6,
      size: 10,
      sizeUsdc: 6,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    // Position updated with new avg price
    const saved = (positionRepo.save as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Position;
    expect(saved.size).toBe(20); // 10 + 10
    expect(saved.costBasisUsdc).toBe(10); // 4 + 6
    expect(saved.avgEntryPrice).toBe(0.5); // 10/20

    await mod.stop();
  });

  // ─── Fill handling: sell with FIFO ────────────────────────────────

  it("applies sell fill with FIFO lot consumption", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      conditionId: COND_ID,

      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);

    // FIFO consumption returns consumed lots
    const consumedLot: InventoryLot = {
      lotId: createLotId("lot-1"),
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,

      side: "buy",
      size: 10,
      remainingSize: 5, // 5 remaining after consuming 5
      entryPrice: 0.4,
      costUsdc: 4,
      fillId: createFillId("fill-orig"),
      createdAt: new Date().toISOString(),
    };
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockReturnValue([
      { lot: consumedLot, consumed: 5 },
    ]);
    // After consumption, lots still open
    (lotRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([
      { ...consumedLot, remainingSize: 5 },
    ]);

    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-sell"),
      orderId: createOrderId("ord-sell"),
      clientOrderId: "plk_sell" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "sell" as const,
      price: 0.6,
      size: 5,
      sizeUsdc: 3,
      liquidityRole: "unknown",
      fee: 0.01,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(lotRepo.consumeFifo).toHaveBeenCalledWith(createPositionId("pos-1"), 5);

    // Position updated
    expect(posUpdates).toHaveLength(1);
    const updatedPos = posUpdates[0].position as Position;
    expect(updatedPos.size).toBe(5); // 10 - 5
    expect(updatedPos.status).toBe("open");
    // Realized PnL: (5 * 0.6) - (5 * 0.4) - 0.01 fee = 3.0 - 2.0 - 0.01 = 0.99
    expect(updatedPos.realizedPnl).toBeCloseTo(0.99, 2);

    await mod.stop();
  });

  it("closes position when fully sold", async () => {
    const existingPos: Position = {
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,
      conditionId: COND_ID,

      side: "buy",
      size: 10,
      avgEntryPrice: 0.4,
      costBasisUsdc: 4,
      currentValueUsdc: 5,
      realizedPnl: 0,
      status: "open",
      entryStyle: null,
      openedAt: new Date().toISOString(),
      closedAt: null,
      updatedAt: new Date().toISOString(),
    };
    positionRepo = createMockPositionRepo(existingPos);

    const consumedLot: InventoryLot = {
      lotId: createLotId("lot-1"),
      positionId: createPositionId("pos-1"),
      tokenId: TOK_ID,

      side: "buy",
      size: 10,
      remainingSize: 0,
      entryPrice: 0.4,
      costUsdc: 4,
      fillId: createFillId("fill-orig"),
      createdAt: new Date().toISOString(),
    };
    (lotRepo.consumeFifo as ReturnType<typeof vi.fn>).mockReturnValue([
      { lot: consumedLot, consumed: 10 },
    ]);
    (lotRepo.findOpen as ReturnType<typeof vi.fn>).mockReturnValue([]);

    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-sell-all"),
      orderId: createOrderId("ord-sell-all"),
      clientOrderId: "plk_sellall" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "sell" as const,
      price: 0.6,
      size: 10,
      sizeUsdc: 6,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    const updatedPos = posUpdates[0].position as Position;
    expect(updatedPos.size).toBe(0);
    expect(updatedPos.status).toBe("closed");
    expect(updatedPos.closedAt).not.toBeNull();
    // Realized PnL: (10 * 0.6) - (10 * 0.4) = 6 - 4 = 2
    expect(updatedPos.realizedPnl).toBeCloseTo(2, 2);

    await mod.stop();
  });

  // ─── Fill reconciliation marking ─────────────────────────────────

  it("marks fill as reconciled after successful applyFill", async () => {
    await mod.start();

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-1"),
      orderId: createOrderId("ord-1"),
      clientOrderId: "plk_test" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "buy" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0.01,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(fillRepo.markReconciled).toHaveBeenCalledWith([createFillId("fill-1")]);

    await mod.stop();
  });

  it("does NOT call markReconciled when applyFill throws", async () => {
    await mod.start();

    // Sell fill for a token with no existing position — applyFill will throw
    await bus.publish("FillReceived", {
      fillId: createFillId("fill-err"),
      orderId: createOrderId("ord-err"),
      clientOrderId: "plk_err" as ClientOrderId,
      tokenId: createTokenId("tok-nonexistent"),
      conditionId: COND_ID,
      side: "sell" as const,
      price: 0.5,
      size: 10,
      sizeUsdc: 5,
      liquidityRole: "unknown",
      fee: 0.01,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    expect(fillRepo.markReconciled).not.toHaveBeenCalled();

    await mod.stop();
  });

  // ─── Unsubscribe on stop ──────────────────────────────────────────

  it("does not process events after stop", async () => {
    await mod.start();
    await mod.stop();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(approved).toHaveLength(0);
  });

  // ─── Error resilience ─────────────────────────────────────────────

  it("rejects signal on internal error without crashing", async () => {
    // Make orderRepo.findByTokenId throw to trigger internal error path in AlgoRiskGate
    (orderRepo.findByTokenId as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("db explosion");
    });
    mod = createModule();
    await mod.start();

    const rejected: any[] = [];
    bus.subscribe("SignalRejected", async (p) => {
      rejected.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain("internal error");

    await mod.stop();
  });

  // ─── Null-family signals (algo critical path) ─────────────
  //
  // Per design spec: the algo trading path must flow through the risk gate
  // using only token-level checks (open-order dedup, token in-flight limit,
  // min order size). Family rules and live-lite family allowlist MUST NOT
  // be consulted.

  describe("null-family signals", () => {
    it("approves a null-family buy signal when token-level checks pass", async () => {
      mod = createModule();
      await mod.start();

      const approved: any[] = [];
      const rejected: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("SignalProduced", { signal: makeSignal() });

      expect(rejected).toHaveLength(0);
      expect(approved).toHaveLength(1);
      expect(approved[0].signal.tokenId).toBe(String(TOK_ID));

      await mod.stop();
    });

    it("still rejects null-family signals that fail token-level checks", async () => {
      // Simulate an existing open buy order on the same token — AlgoRiskGate
      // must reject with "token already has open buy order" regardless of family.
      const existingOrder: Order = {
        orderId: createOrderId("ord-nullfam-open"),
        clientOrderId: "plk_nullfam_open" as ClientOrderId,
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "buy",
        orderType: "GTC",
        postOnly: true,
        price: 0.5,
        size: 10,
        sizeUsdc: 5,
        status: "open",
        exchangeOrderId: "ex-nullfam-open",
        signalId: null,
        signalReason: "probe-entry",
        botRunId: "run-1" as any,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      (orderRepo.findByTokenId as ReturnType<typeof vi.fn>).mockReturnValue([existingOrder]);
      mod = createModule();
      await mod.start();

      const approved: any[] = [];
      const rejected: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("SignalProduced", { signal: makeSignal() });

      expect(approved).toHaveLength(0);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("token already has open buy order");

      await mod.stop();
    });

    it("processes fills and creates a position", async () => {
      mod = createModule();
      await mod.start();

      const posUpdates: any[] = [];
      bus.subscribe("PositionUpdated", async (p) => {
        posUpdates.push(p);
      });

      await bus.publish("FillReceived", {
        fillId: createFillId("fill-nullfam"),
        orderId: createOrderId("ord-nullfam"),
        clientOrderId: "coid-nullfam" as ClientOrderId,
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "buy" as const,
        price: 0.5,
        size: 10,
        sizeUsdc: 5,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        signalReason: "probe-entry",
        timestamp: Date.now(),
      });

      expect(posUpdates).toHaveLength(1);
      expect(posUpdates[0].position.size).toBe(10);

      await mod.stop();
    });
  });

  // ─── Live-lite allowlist check ────────────────────────────

  // NOTE: Live-lite family-level gates (allowlist, fee-tier, wallet mode) were removed
  // from AlgoRiskGate. These checks now live upstream. RiskInventoryModule accepts the
  // liveLiteGuard in deps for compatibility but AlgoRiskGate no longer uses it.

  it("approves signal regardless of live-lite allowlist (family gate removed)", async () => {
    const liveLiteGuard = new LiveLiteGuard({
      familyAllowlist: ["fam-other"],
      maxFamilies: 2,
      maxOpenValueUsdc: 500,
      maxOrderUsdc: 50,
      maxActiveMarkets: 3,
    });
    mod = createModule(liveLiteGuard);
    await mod.start();

    const approved: any[] = [];
    bus.subscribe("SignalApproved", async (p) => {
      approved.push(p);
    });

    await bus.publish("SignalProduced", { signal: makeSignal() });

    expect(approved).toHaveLength(1);

    await mod.stop();
  });

  // ─── Error resilience ─────────────────────────────────────

  it("logs error on orphan sell fill without fabricating PnL", async () => {
    // No existing position for the token
    positionRepo = createMockPositionRepo(null);
    mod = createModule();
    await mod.start();

    const posUpdates: any[] = [];
    bus.subscribe("PositionUpdated", async (p) => {
      posUpdates.push(p);
    });

    await bus.publish("FillReceived", {
      fillId: createFillId("fill-orphan"),
      orderId: createOrderId("ord-orphan"),
      clientOrderId: "plk_orphan" as ClientOrderId,
      tokenId: TOK_ID,
      conditionId: COND_ID,
      side: "sell" as const,
      price: 0.6,
      size: 5,
      sizeUsdc: 3,
      liquidityRole: "unknown",
      fee: 0,
      feeRateBps: 0,
      signalReason: null,
      timestamp: Date.now(),
    });

    // No position should be created — the error is caught by the module
    expect(posUpdates).toHaveLength(0);
    // No synthetic position saved
    expect(positionRepo.save).not.toHaveBeenCalled();

    await mod.stop();
  });

  // ─── Wave 5: mark-to-market (P2-1) ─────────────────────────────────

  describe("mark-to-market (P2-1)", () => {
    it("revalues open positions on NormalizedMarketUpdated", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-1"),
        tokenId: TOK_ID,
        conditionId: COND_ID,
  
        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: new Date().toISOString(),
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule();
      await mod.start();

      // Market moves from 0.05 to 0.08 → new value = 100 * 0.08 = 8.0
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,

            regime: "threshold" as any,
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.01,
            negRisk: false,
            bestBid: 0.07,
            bestAsk: 0.09,
            midPrice: 0.08,
            spread: 0.02,
            snapshotTs: Date.now(),
            eventMarketCount: 1,
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      // positionRepo.save should have been called with updated currentValueUsdc
      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedPos = saveCalls[saveCalls.length - 1][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(8.0, 2);
      expect(savedPos.status).toBe("open");

      await mod.stop();
    });

    it("reclassifies low-value open positions to dust on mark-to-market", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-dustify"),
        tokenId: TOK_ID,
        conditionId: COND_ID,
  
        side: "buy",
        size: 1,
        avgEntryPrice: 0.8,
        costBasisUsdc: 0.8,
        currentValueUsdc: 0.8,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: new Date().toISOString(),
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule();
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,

            regime: "threshold" as any,
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.01,
            negRisk: false,
            bestBid: 0.19,
            bestAsk: 0.21,
            midPrice: 0.2,
            spread: 0.02,
            snapshotTs: Date.now(),
            eventMarketCount: 1,
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      const saveCalls = (positionRepo.save as any).mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(1);
      const savedPos = saveCalls[saveCalls.length - 1][0];
      expect(savedPos.currentValueUsdc).toBeCloseTo(0.2, 2);
      expect(savedPos.status).toBe("dust");

      await mod.stop();
    });

    it("skips positions without live price data", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-1"),
        tokenId: TOK_ID,
        conditionId: COND_ID,
  
        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: new Date().toISOString(),
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule();
      await mod.start();

      // Market update with null midPrice → no revaluation
      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: createTokenId("tok-other"),
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,

            regime: "threshold" as any,
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.01,
            negRisk: false,
            bestBid: null,
            bestAsk: null,
            midPrice: null,
            spread: null,
            snapshotTs: Date.now(),
            eventMarketCount: 1,
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      // No save call for position (no price data matched)
      expect(positionRepo.save).not.toHaveBeenCalled();

      await mod.stop();
    });
  });

  // ─── Wave 5: operator diagnostics (P2-2) ───────────────────────────

  describe("operator diagnostics (P2-2)", () => {
    it("tracks approved and rejected signal counts per family", async () => {
      await mod.start();

      // Approve a probe-entry
      await bus.publish("SignalProduced", { signal: makeSignal() });
      await bus.drain();

      // Reject by making orderRepo.findByTokenId throw (triggers internal error path)
      (orderRepo.findByTokenId as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("db explosion");
      });
      await bus.publish("SignalProduced", {
        signal: makeSignal({ signalId: "sig-2" }),
      });
      await bus.drain();

      const diag = mod.getDiagnostics();
      expect(diag.signalsProcessed).toBe(2);
      expect(diag.signalsApproved).toBe(1);
      expect(diag.signalsRejected).toBe(1);

      await mod.stop();
    });

    it("tracks last signal reason (approved signals increment counter)", async () => {
      await mod.start();

      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "probe-entry" }),
      });
      await bus.drain();

      const diag = mod.getDiagnostics();
      expect(diag.signalsApproved).toBe(1);
      expect(diag.signalsProcessed).toBe(1);

      await mod.stop();
    });

    it("reports mark-to-market update count", async () => {
      const pos: Position = {
        positionId: createPositionId("pos-1"),
        tokenId: TOK_ID,
        conditionId: COND_ID,
  
        side: "buy",
        size: 100,
        avgEntryPrice: 0.05,
        costBasisUsdc: 5,
        currentValueUsdc: 5,
        realizedPnl: 0,
        status: "open",
        entryStyle: null,
        openedAt: new Date().toISOString(),
        closedAt: null,
        updatedAt: new Date().toISOString(),
      };
      positionRepo = createMockPositionRepo(pos);
      mod = createModule();
      await mod.start();

      await bus.publish("NormalizedMarketUpdated", {
        markets: [
          {
            tokenId: TOK_ID,
            conditionId: "c1",
            slug: "test",
            eventSlug: null,
            question: "test?",
            outcome: "YES" as const,

            regime: "threshold" as any,
            horizon: "daily",
            endDate: null,
            active: true,
            tradable: true,
            tickSize: 0.01,
            negRisk: false,
            bestBid: 0.07,
            bestAsk: 0.09,
            midPrice: 0.08,
            spread: 0.02,
            snapshotTs: Date.now(),
            eventMarketCount: 1,
          },
        ],
        timestamp: Date.now(),
      });
      await bus.drain();

      const diag = mod.getDiagnostics();
      expect(diag.markToMarketUpdates).toBe(1);

      await mod.stop();
    });

    it("healthCheck includes approved/rejected/mtm counts", async () => {
      await mod.start();

      await bus.publish("SignalProduced", { signal: makeSignal() });
      await bus.drain();

      const h = await mod.healthCheck();
      expect(h.detail).toContain("approved=1");
      expect(h.detail).toContain("rejected=0");
      expect(h.detail).toContain("mtm=0");

      await mod.stop();
    });
  });

  // ─── Per-family in-flight limiter (B2.2) ──────────────────────────

  describe("per-family in-flight limiter", () => {
    function makePlaceOrderRequested(
      signalReason: string | null = null,
      tokenId = TOK_ID,
    ) {
      return {
        command: {
          type: "PlaceOrderCommand" as const,
          commandId: createCommandId("cmd-1"),
          clientOrderId: "plk_test" as ClientOrderId,
          source: "strategy" as const,
          tokenId,
          conditionId: COND_ID,
          side: "buy" as const,
          size: 10,
          price: 0.5,
          orderType: "GTC" as const,
          tickSize: 0.01,
          negRisk: false,
          sequenceInTick: 0,
          signalReason,
        },
        timestamp: Date.now(),
      };
    }

    it("rejects entry signal when token already has a buy order in flight (token-in-flight-limit)", async () => {
      await mod.start();

      const rejected: any[] = [];
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      // Put 1 buy in flight for TOK_ID (limit is 1 per token)
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("token-in-flight-limit");

      await mod.stop();
    });

    it("allows entry signal after in-flight order is rejected (counter decremented)", async () => {
      await mod.start();

      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      // Put 1 buy in flight for TOK_ID
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested("probe-entry"));
      // Reject it — decrements tokenInFlight for TOK_ID
      await bus.publish("OrderRejected", {
        commandId: createCommandId("cmd-1"),
        clientOrderId: "plk_test" as ClientOrderId,
        tokenId: TOK_ID,
        conditionId: COND_ID,
        reason: "insufficient balance",
        errorCode: "INSUFFICIENT_BALANCE",
        signalReason: null,
        timestamp: Date.now(),
      });
      // Now token counter is 0 — signal should be approved
      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(approved).toHaveLength(1);

      await mod.stop();
    });

    it("decrements in-flight only once when a multi-fill order reaches filled", async () => {
      await mod.start();

      // Put 1 buy in flight for TOK_ID (fills the per-token limit of 1)
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());

      // Mock: order is "filled" (set before FillReceived, as importExchangeFills does)
      (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue({
        orderId: createOrderId("ord-1"),
  
        status: "filled",
        size: 10,
      });

      // Two fills for the same order (e.g. partial fills in one import batch)
      const fillBase = {
        orderId: createOrderId("ord-1"),
        clientOrderId: "plk_test" as ClientOrderId,
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "buy" as const,
        sizeUsdc: 2.5,
        liquidityRole: "unknown" as const,
        fee: 0,
        feeRateBps: 0,
        signalReason: null as string | null,
        timestamp: Date.now(),
      };
      await bus.publish("FillReceived", {
        ...fillBase,
        fillId: "fill-1" as any,
        price: 0.5,
        size: 5,
      });
      await bus.publish("FillReceived", {
        ...fillBase,
        fillId: "fill-2" as any,
        price: 0.5,
        size: 5,
      });

      // Counter should have decremented once (1 → 0), not twice (1 → -1 clamped to 0).
      // After decrement, token counter = 0, so next entry should be approved.
      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });
      expect(approved).toHaveLength(1);

      // Add 1 more PlaceOrderRequested to bring counter back to 1 (the per-token limit).
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      // Now at 1 in-flight for the token — next entry should be rejected
      const rejected: any[] = [];
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });
      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "probe-entry", signalId: "sig-check" as any }),
      });
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("token-in-flight-limit");

      await mod.stop();
    });

    it("does not apply in-flight limit to exit signals", async () => {
      await mod.start();

      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested());
      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "repricing-exit", side: "sell" }),
      });

      expect(approved).toHaveLength(1);

      await mod.stop();
    });

    it("rejects a second probe-entry for the same token while a probe order is already in flight", async () => {
      await mod.start();

      const rejected: any[] = [];
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested("probe-entry"));
      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("token-in-flight-limit");

      await mod.stop();
    });

    it("allows a probe-entry on a different token while another probe is in flight for the family", async () => {
      await mod.start();

      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested("probe-entry"));
      await bus.publish("SignalProduced", {
        signal: makeSignal({
          tokenId: createTokenId("tok-no"),
          signalId: "sig-other-token",
          reason: "probe-entry",
        }),
      });

      expect(approved).toHaveLength(1);

      await mod.stop();
    });

    it("allows a new probe-entry on the same token after the prior probe order fully fills", async () => {
      await mod.start();

      const approved: any[] = [];
      bus.subscribe("SignalApproved", async (p) => {
        approved.push(p);
      });

      const orderId = createOrderId("ord-probe");
      await bus.publish("PlaceOrderRequested", makePlaceOrderRequested("probe-entry"));
      (orderRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue({
        orderId,
  
        status: "filled",
        signalReason: "probe-entry",
      });

      await bus.publish("FillReceived", {
        fillId: createFillId("fill-probe"),
        orderId,
        clientOrderId: "plk_test" as ClientOrderId,
        tokenId: TOK_ID,
        conditionId: COND_ID,
        side: "buy",
        price: 0.5,
        size: 10,
        sizeUsdc: 5,
        liquidityRole: "unknown",
        fee: 0,
        feeRateBps: 0,
        signalReason: "probe-entry",
        timestamp: Date.now(),
      });

      await bus.publish("SignalProduced", {
        signal: makeSignal({ reason: "probe-entry", signalId: "sig-after-fill" }),
      });

      expect(approved).toHaveLength(1);

      await mod.stop();
    });

    it("rejects probe-entry when the token already has an open buy order", async () => {
      orderRepo = createMockOrderRepo();
      orderRepo.findByTokenId = vi.fn().mockReturnValue([
        {
          orderId: createOrderId("ord-open"),
          clientOrderId: "plk_open" as ClientOrderId,
          tokenId: TOK_ID,
          conditionId: COND_ID,
    
          side: "buy",
          orderType: "GTC",
          postOnly: true,
          price: 0.5,
          size: 10,
          sizeUsdc: 5,
          status: "open",
          exchangeOrderId: "ex-open" as any,
          signalId: null,
          signalReason: "probe-entry",
          botRunId: "run-1" as any,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } satisfies Order,
      ]);
      mod = createModule();
      await mod.start();

      const rejected: any[] = [];
      bus.subscribe("SignalRejected", async (p) => {
        rejected.push(p);
      });

      await bus.publish("SignalProduced", { signal: makeSignal({ reason: "probe-entry" }) });

      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toContain("token already has open buy order");

      await mod.stop();
    });
  });
});
