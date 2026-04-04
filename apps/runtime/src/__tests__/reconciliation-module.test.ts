import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTokenId, createFamilyId, createOrderId } from "@plankton/domain";
import type {
  ExchangeGateway,
  ExchangeOrder,
  Order,
  PlaceOrderParams,
  CancelOrderParams,
  PlaceOrderResult,
  CancelOrderResult,
  ExchangeFill,
  ExchangeBalance,
  OrderRepository,
  FillRepository,
  TokenId,
  ClientOrderId,
  ReconciliationResult,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { ReconciliationModule } from "../modules/reconciliation/reconciliation-module.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const TOK = createTokenId("tok-yes");
const FAM = createFamilyId("fam-1");

function createMockGateway(): ExchangeGateway {
  return {
    placeOrder: vi
      .fn<(params: PlaceOrderParams) => Promise<PlaceOrderResult>>()
      .mockResolvedValue({ success: true, orderId: "sim-1" }),
    cancelOrder: vi
      .fn<(params: CancelOrderParams) => Promise<CancelOrderResult>>()
      .mockResolvedValue({ success: true }),
    cancelAllOrders: vi.fn().mockResolvedValue({ success: true }),
    getOpenOrders: vi.fn<() => Promise<ExchangeOrder[]>>().mockResolvedValue([]),
    getOpenOrdersForToken: vi
      .fn<(tokenId: TokenId) => Promise<ExchangeOrder[]>>()
      .mockResolvedValue([]),
    getFills: vi.fn<(sinceMs: number) => Promise<ExchangeFill[]>>().mockResolvedValue([]),
    getBalances: vi.fn<() => Promise<ExchangeBalance[]>>().mockResolvedValue([]),
    getPositionBalance: vi.fn<(tokenId: TokenId) => Promise<number>>().mockResolvedValue(0),
    healthCheck: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
  };
}

function createMockOrderRepo(): OrderRepository {
  return {
    save: vi.fn(),
    findById: vi.fn().mockReturnValue(null),
    findByClientOrderId: vi.fn().mockReturnValue(null),
    findByExchangeOrderId: vi.fn().mockReturnValue(null),
    findOpen: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    updateStatus: vi.fn(),
  };
}

function createMockFillRepo(): FillRepository {
  return {
    save: vi.fn(),
    exists: vi.fn().mockReturnValue(false),
    findByOrderId: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue([]),
    findRecent: vi.fn().mockReturnValue([]),
    findUnreconciled: vi.fn().mockReturnValue([]),
    markReconciled: vi.fn(),
    getLatestTimestamp: vi.fn().mockReturnValue(null),
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

function makeExchangeOrder(overrides?: Partial<ExchangeOrder>): ExchangeOrder {
  return {
    orderId: "ex-ord-1",
    clientOrderId: "plk_abc",
    tokenId: TOK,
    side: "buy",
    price: 0.5,
    sizeTotal: 10,
    sizeFilled: 0,
    sizeRemaining: 10,
    status: "OPEN",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeLocalOrder(overrides?: Partial<Order>): Order {
  return {
    orderId: createOrderId("ord-1"),
    clientOrderId: "plk_abc" as ClientOrderId,
    tokenId: TOK,
    familyId: FAM,
    side: "buy",
    orderType: "GTC",
    price: 0.5,
    size: 10,
    sizeUsdc: 5,
    status: "open",
    exchangeOrderId: "ex-ord-1",
    signalId: null,
    signalReason: null,
    botRunId: "run-1" as any,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeExchangeFill(overrides?: Partial<ExchangeFill>): ExchangeFill {
  return {
    fillId: "fill-ex-1",
    orderId: "ex-ord-1",
    clientOrderId: "plk_abc",
    tokenId: TOK,
    side: "buy",
    price: 0.5,
    size: 10,
    liquidityRole: "unknown",
    fee: 0.01,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("ReconciliationModule", () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let bus: InProcessEventBus;
  let orderRepo: ReturnType<typeof createMockOrderRepo>;
  let fillRepo: ReturnType<typeof createMockFillRepo>;
  let mod: ReconciliationModule;

  beforeEach(() => {
    gateway = createMockGateway();
    bus = new InProcessEventBus();
    orderRepo = createMockOrderRepo();
    fillRepo = createMockFillRepo();
    mod = new ReconciliationModule({
      gateway,
      bus,
      orderRepo,
      fillRepo,
      log: silentLog,
      reconcileIntervalMs: 60_000,
    });
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────

  describe("lifecycle", () => {
    it("healthCheck returns not started before start", async () => {
      const hc = await mod.healthCheck();
      expect(hc.ok).toBe(false);
      expect(hc.detail).toContain("not started");
    });

    it("start runs startup reconciliation and marks started", async () => {
      await mod.start();
      const hc = await mod.healthCheck();
      expect(hc.ok).toBe(true);
      expect(hc.detail).toContain("runs=1");
      await mod.stop();
    });

    it("stop clears interval and marks stopped", async () => {
      await mod.start();
      await mod.stop();
      const hc = await mod.healthCheck();
      expect(hc.ok).toBe(false);
    });
  });

  // ─── Clean reconciliation ──────────────────────────────────────────

  describe("clean reconciliation", () => {
    it("publishes ReconciliationComplete with clean=true when no drift", async () => {
      const events: ReconciliationResult[] = [];
      bus.subscribe("ReconciliationComplete", async (p) => {
        events.push(p.result);
      });

      await mod.start();
      await bus.drain();
      await mod.stop();

      expect(events).toHaveLength(1);
      expect(events[0]!.clean).toBe(true);
      expect(events[0]!.phantomOrders).toBe(0);
      expect(events[0]!.missingFills).toBe(0);
    });

    it("does not publish ReconciliationDriftDetected when clean", async () => {
      const drifts: unknown[] = [];
      bus.subscribe("ReconciliationDriftDetected", async (p) => {
        drifts.push(p);
      });

      await mod.start();
      await bus.drain();
      await mod.stop();

      expect(drifts).toHaveLength(0);
    });
  });

  // ─── Order reconciliation ─────────────────────────────────────────

  describe("order reconciliation", () => {
    it("cancels phantom local orders not on exchange", async () => {
      const local = makeLocalOrder({ exchangeOrderId: "ex-gone" });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      // exchange returns empty — order is gone
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const result = await mod.runReconciliation();

      expect(result.phantomOrders).toBe(1);
      expect(result.clean).toBe(false);
      expect(orderRepo.updateStatus).toHaveBeenCalledWith(local.orderId, "cancelled");
    });

    it("does not cancel local orders that exist on exchange", async () => {
      const local = makeLocalOrder({ exchangeOrderId: "ex-ord-1" });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-ord-1" })]);

      const result = await mod.runReconciliation();

      expect(result.phantomOrders).toBe(0);
      expect(orderRepo.updateStatus).not.toHaveBeenCalled();
    });

    it("detects unknown exchange orders without local match", async () => {
      orderRepo.findOpen = vi.fn().mockReturnValue([]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-mystery" })]);

      const result = await mod.runReconciliation();

      expect(result.clean).toBe(false);
      expect(result.details.some((d) => d.includes("unknown exchange order"))).toBe(true);
    });

    it("counts exchange and local open orders", async () => {
      const local = makeLocalOrder();
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi
        .fn()
        .mockResolvedValue([makeExchangeOrder({ orderId: "ex-ord-1" })]);

      const result = await mod.runReconciliation();

      expect(result.openOrdersExchange).toBe(1);
      expect(result.openOrdersLocal).toBe(1);
    });
  });

  // ─── Fill reconciliation ──────────────────────────────────────────

  describe("fill reconciliation", () => {
    it("imports missing fills from exchange and publishes FillReceived", async () => {
      const exFill = makeExchangeFill({ fillId: "fill-new" });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);

      // Need local order for familyId lookup
      const local = makeLocalOrder();
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(local);

      const fillEvents: any[] = [];
      bus.subscribe("FillReceived", async (p) => {
        fillEvents.push(p);
      });

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(1);
      expect(result.clean).toBe(false);
      expect(fillRepo.save).toHaveBeenCalledTimes(1);
      expect(fillEvents).toHaveLength(1);
      expect(fillEvents[0].fillId).toBe("fill-new");
    });

    it("skips fills already known locally", async () => {
      const exFill = makeExchangeFill({ fillId: "fill-known" });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(true);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(0);
      expect(fillRepo.save).not.toHaveBeenCalled();
    });

    it("skips fills with no matching local order", async () => {
      const exFill = makeExchangeFill({
        fillId: "fill-orphan",
        clientOrderId: "unknown-client",
      });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(null);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(null);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(0);
      expect(result.details.some((d) => d.includes("no matching local order"))).toBe(true);
    });

    it("matches fill via exchangeOrderId fallback when clientOrderId misses", async () => {
      const exFill = makeExchangeFill({
        fillId: "fill-fallback",
        clientOrderId: "",
        orderId: "ex-ord-1",
      });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);

      const local = makeLocalOrder();
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(null);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(local);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(1);
      expect(fillRepo.save).toHaveBeenCalledTimes(1);
      expect(orderRepo.findByExchangeOrderId).toHaveBeenCalledWith("ex-ord-1");
    });

    it("uses primary clientOrderId path when it matches (regression)", async () => {
      const exFill = makeExchangeFill({ fillId: "fill-primary" });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);

      const local = makeLocalOrder();
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(local);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(1);
      expect(orderRepo.findByExchangeOrderId).not.toHaveBeenCalled();
    });

    it("skips fill when both clientOrderId and exchangeOrderId miss", async () => {
      const exFill = makeExchangeFill({
        fillId: "fill-double-miss",
        clientOrderId: "",
        orderId: "ex-unknown",
      });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(null);
      orderRepo.findByExchangeOrderId = vi.fn().mockReturnValue(null);

      const result = await mod.runReconciliation();

      expect(result.missingFills).toBe(0);
      expect(result.details.some((d) => d.includes("no matching local order"))).toBe(true);
    });
  });

  // ─── Events ───────────────────────────────────────────────────────

  describe("events", () => {
    it("publishes ReconciliationDriftDetected with severity=critical for missing fills", async () => {
      const exFill = makeExchangeFill({ fillId: "fill-drift" });
      gateway.getFills = vi.fn().mockResolvedValue([exFill]);
      fillRepo.exists = vi.fn().mockReturnValue(false);
      orderRepo.findByClientOrderId = vi.fn().mockReturnValue(makeLocalOrder());

      const drifts: Array<{ severity: string; details: string }> = [];
      bus.subscribe("ReconciliationDriftDetected", async (p) => {
        drifts.push({ severity: p.severity, details: p.details });
      });

      await mod.runReconciliation();
      await bus.drain();

      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.severity).toBe("critical");
    });

    it("publishes ReconciliationDriftDetected with severity=warn for phantom orders only", async () => {
      const local = makeLocalOrder({ exchangeOrderId: "ex-gone" });
      orderRepo.findOpen = vi.fn().mockReturnValue([local]);
      gateway.getOpenOrders = vi.fn().mockResolvedValue([]);

      const drifts: Array<{ severity: string }> = [];
      bus.subscribe("ReconciliationDriftDetected", async (p) => {
        drifts.push({ severity: p.severity });
      });

      await mod.runReconciliation();
      await bus.drain();

      expect(drifts).toHaveLength(1);
      expect(drifts[0]!.severity).toBe("warn");
    });
  });

  // ─── Re-entrancy guard ────────────────────────────────────────────

  describe("re-entrancy", () => {
    it("prevents overlapping reconciliation runs", async () => {
      let resolveGateway: (() => void) | null = null;
      gateway.getOpenOrders = vi.fn().mockImplementation(
        () =>
          new Promise<ExchangeOrder[]>((resolve) => {
            resolveGateway = () => resolve([]);
          }),
      );

      const p1 = mod.runReconciliation();
      const p2 = mod.runReconciliation(); // should return immediately

      // p2 resolves immediately with the empty/last result
      const r2 = await p2;
      expect(r2.clean).toBe(true);

      // Now resolve p1
      resolveGateway!();
      await p1;

      // Only one call to gateway
      expect(gateway.getOpenOrders).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Periodic sinceMs ─────────────────────────────────────────────

  describe("periodic fill lookback", () => {
    it("uses sinceMs=0 on first run, then last run timestamp", async () => {
      await mod.runReconciliation();
      const firstCallSince = (gateway.getFills as any).mock.calls[0][0];
      expect(firstCallSince).toBe(0);

      await mod.runReconciliation();
      const secondCallSince = (gateway.getFills as any).mock.calls[1][0];
      expect(secondCallSince).toBeGreaterThan(0);
    });
  });
});
