import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapControlDb, openDatabase, SqliteOrderRepository } from "@krabs/db";
import {
  createCommandId,
  createOrderId,
  createTokenId,
  readPendingBuyRecovery,
  type ExchangeGateway,
  type PlaceOrderCommand,
} from "@krabs/domain";
import { pendingBuyFixture, incidentIds } from "./fixtures/pending-buy-recovery.js";
import {
  applyOrderVerdict,
  inOrderLifecycleLane,
  persistTerminalVerdictInLane,
} from "../modules/reconciliation/order-status-resolver.js";
import { importExchangeFills } from "../modules/reconciliation/fill-reconciler.js";
import { runOwnershipInvariantStartupGate } from "../modules/exit-ownership/assert-bounce-for-all-invariant.js";
import { UserOrderStreamModule } from "../modules/reconciliation/user-order-stream-module.js";

function fixture() {
  const f = pendingBuyFixture();
  onTestFinished(f.close);
  return f;
}

async function started(
  f: ReturnType<typeof fixture>,
  overrides?: Parameters<typeof f.execution>[0],
) {
  const adopted = await f.adopt();
  const execution = f.execution(overrides);
  execution.beginStartupFence();
  execution.acknowledgeStartupTransitions(adopted.drainTargets);
  const control = bootstrapControlDb(":memory:");
  const gate = {
    ledgerDb: f.conn.db,
    controlDb: control.db,
    applyToAllMarkets: true,
    log: f.deps.log,
    buyRecovery: {
      orderIds: adopted.drainTargets.flatMap((target) =>
        target.orders.map((order) => order.orderId),
      ),
      orderRepo: f.deps.orderRepo,
      isTransitionTarget: (id: ReturnType<typeof createOrderId>) =>
        execution.hasTransitionTarget(id),
    },
  };
  try {
    runOwnershipInvariantStartupGate(gate);
    await execution.start();
    await execution.seedStartupTransitions(adopted.drainTargets);
    runOwnershipInvariantStartupGate({ ...gate, phase: "pre-fence-release" });
  } finally {
    control.close();
  }
  execution.endStartupFence();
  return execution;
}

function current(f: ReturnType<typeof fixture>, index = 0) {
  return f.deps.orderRepo.findById(f.orders[index]!.orderId)!;
}

describe("durable pending BUY recovery", () => {
  it("keeps shared discovery correct across registration and completion rollbacks", () => {
    const f = fixture();
    const other = new SqliteOrderRepository(f.conn.db);
    expect(f.deps.orderRepo.findPendingBuyRecovery()).toEqual([]);
    const register = () =>
      other.registerPendingBuyRecovery(f.orders, f.orders[0]!.orderId, f.observations);
    expect(() =>
      f.conn.db.transaction(() => {
        register();
        expect(f.deps.orderRepo.findPendingBuyRecovery()).toHaveLength(2);
        throw new Error("outer rollback");
      })(),
    ).toThrow("outer rollback");
    expect(f.deps.orderRepo.findPendingBuyRecovery()).toEqual([]);
    register();
    expect(() =>
      f.conn.db.transaction(() => {
        expect(
          other.completePendingBuyRecovery(current(f), f.remote(0, "CANCELLED"), () => true),
        ).toBe(true);
        expect(f.deps.orderRepo.sumOpenBuyNotional("remaining")).toBeCloseTo(0.69);
        throw new Error("completion rollback");
      })(),
    ).toThrow("completion rollback");
    expect(f.deps.orderRepo.sumOpenBuyNotional("remaining")).toBeCloseTo(1.38);
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(false);
  });

  it("refreshes external marker commits, terminal rows and completion across connections and restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pending-buy-discovery-"));
    const path = join(dir, "ledger.db");
    const f = pendingBuyFixture(path);
    const external = openDatabase(path);
    onTestFinished(async () => {
      external.close();
      await f.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const other = new SqliteOrderRepository(external.db);
    expect(f.deps.orderRepo.findPendingBuyRecovery()).toEqual([]);
    other.registerPendingBuyRecovery(f.orders, f.orders[0]!.orderId, f.observations);
    external.db.prepare("UPDATE orders SET status = 'filled'").run();
    expect(f.deps.orderRepo.sumOpenBuyNotional("remaining")).toBeCloseTo(1.38);
    expect(f.deps.orderRepo.findPendingBuyRecovery()).toHaveLength(2);
    expect(other.completePendingBuyRecovery(current(f), f.remote(0, "CANCELLED"), () => true)).toBe(
      true,
    );
    expect(f.deps.orderRepo.sumOpenBuyNotional("remaining")).toBeCloseTo(0.69);
    const restarted = openDatabase(path);
    try {
      expect(new SqliteOrderRepository(restarted.db).sumOpenBuyNotional("remaining")).toBeCloseTo(
        0.69,
      );
    } finally {
      restarted.close();
    }
  });

  it("does not retain discovery from a transaction that rolls back before cache initialization", () => {
    const f = fixture();
    expect(() =>
      f.conn.db.transaction(() => {
        f.deps.orderRepo.registerPendingBuyRecovery(f.orders, f.orders[0]!.orderId, f.observations);
        expect(f.deps.orderRepo.findPendingBuyRecovery()).toHaveLength(2);
        throw new Error("initial rollback");
      })(),
    ).toThrow("initial rollback");
    expect(f.deps.orderRepo.findPendingBuyRecovery()).toEqual([]);
    f.deps.orderRepo.registerPendingBuyRecovery(f.orders, f.orders[0]!.orderId, f.observations);
    expect(f.deps.orderRepo.findPendingBuyRecovery()).toHaveLength(2);
  });

  it.each([false, true])(
    "does not examine historical metadata on hot calls (protected=%s)",
    async (protectedOrders) => {
      const f = fixture();
      let examined = 0;
      f.conn.db.function("like", (pattern: string, value: string | null) => {
        expect(pattern).toBe("%pendingBuyRecovery%");
        examined++;
        return value?.includes("pendingBuyRecovery") ? 1 : 0;
      });
      if (protectedOrders) await f.adopt();
      f.deps.orderRepo.sumOpenBuyNotional("remaining");
      for (const count of [0, 5_000]) {
        f.conn.db.transaction(() => {
          for (let index = 0; index < count; index++) {
            f.deps.orderRepo.save({
              ...f.orders[0]!,
              orderId: createOrderId(`historical-${index}`),
              clientOrderId: `historical-${index}` as PlaceOrderCommand["clientOrderId"],
              status: "cancelled",
            });
          }
        })();
        examined = 0;
        const anotherRepository = new SqliteOrderRepository(f.conn.db);
        expect(anotherRepository.sumOpenBuyNotional("remaining")).toBeCloseTo(1.38);
        expect(anotherRepository.sumOpenBuyNotional()).toBeCloseTo(1.38);
        expect(examined).toBe(0);
      }
    },
  );

  it.each(["open", "filled", "cancelled", "rejected"])(
    "holds a saved but unapplied %s BUY against another token's actual execution admission",
    async (status) => {
      const f = fixture();
      const control = bootstrapControlDb(":memory:");
      onTestFinished(() => control.close());
      control.db
        .prepare(
          "INSERT INTO profile_summaries (profile_id, wallet_balance_usdc) VALUES ('live-lite', 2)",
        )
        .run();
      const execution = await started(f, {
        controlDb: control.db,
        activeProfile: "live-lite" as any,
        walletBufferPct: 0,
        walletBufferMinUsdc: 0,
        runtimeControl: { isPaused: () => false },
      });
      await importExchangeFills([f.fill(0, 100)], { ...f.deps, bus: f.bus });
      f.conn.db
        .prepare("UPDATE orders SET status = ? WHERE order_id = ?")
        .run(status, incidentIds[0]);
      expect(f.deps.fillRepo.findUnreconciled()).toHaveLength(1);
      const rejected: string[] = [];
      f.bus.subscribe("OrderRejected", async (event) => {
        rejected.push(event.reason);
      });
      const command: PlaceOrderCommand = {
        type: "PlaceOrderCommand",
        commandId: createCommandId("other-token-buy"),
        clientOrderId: "other-token-buy" as PlaceOrderCommand["clientOrderId"],
        source: "strategy",
        tokenId: createTokenId("other-token"),
        conditionId: f.orders[0]!.conditionId,
        side: "buy",
        orderType: "GTC",
        price: 0.1,
        size: 10,
        tickSize: 0.001,
        negRisk: false,
        sequenceInTick: 0,
        signalReason: null,
      };
      await f.bus.publish("PlaceOrderRequested", { command, timestamp: Date.now() });
      expect(rejected).toEqual(["reserved-usdc-limit"]);
      expect(execution.getDiagnostics().reservedBuyUsdc).toBeCloseTo(1.38);
      expect(f.gateway.placeOrder).not.toHaveBeenCalled();
      expect(f.gateway.prepareOrder).not.toHaveBeenCalled();
      expect(f.gateway.submitPreparedOrder).not.toHaveBeenCalled();
      await f.adopt();
      expect(f.deps.fillRepo.findUnreconciled()).toHaveLength(0);
      expect(execution.getDiagnostics().reservedBuyUsdc).toBeCloseTo(0.78);
    },
  );

  it("requires exact terminal proof after a successful cancel and persists the owned reason", async () => {
    const f = fixture();
    f.gateway.cancelOrder.mockImplementation(async ({ orderId }) => {
      if (orderId === incidentIds[1]) f.observations.set(orderId, f.remote(1, "CANCELLED"));
      return { success: true };
    });
    const execution = await started(f);
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(false);
    expect(execution.hasTransitionTarget(current(f).orderId)).toBe(true);
    expect(readPendingBuyRecovery(current(f, 1))!.completed).toBe(true);
    expect(current(f, 1).cancelReason).toBe("startup_pending_buy_recovery");
    expect(execution.hasTransitionTarget(current(f, 1).orderId)).toBe(false);
    expect(f.gateway.placeOrder).not.toHaveBeenCalled();
  });
  it("owns both exact incident cancellations, rejects forged commands, and never resubmits", async () => {
    const f = fixture();
    const execution = await started(f);
    expect(execution.getSubmitUnknownRecoveryContexts()).toHaveLength(2);
    expect(f.gateway.cancelOrder.mock.calls.map(([args]) => args.orderId).sort()).toEqual(
      [...incidentIds].sort(),
    );
    for (const order of f.orders) {
      expect(execution.hasTransitionTarget(order.orderId)).toBe(true);
      await f.bus.publish("CancelOrderRequested", {
        command: {
          type: "CancelOrderCommand",
          commandId: createCommandId(`forged-${order.orderId}`),
          orderId: order.orderId,
          reason: "startup_pending_buy_recovery",
        },
        timestamp: Date.now(),
      });
    }
    expect(f.gateway.cancelOrder).toHaveBeenCalledTimes(2);
    await execution.seedStartupTransitions((await f.adopt()).drainTargets);
    expect(f.gateway.cancelOrder).toHaveBeenCalledTimes(2);
    expect(f.gateway.placeOrder).not.toHaveBeenCalled();
    expect(f.gateway.prepareOrder).not.toHaveBeenCalled();
    expect(f.gateway.submitPreparedOrder).not.toHaveBeenCalled();
    expect(execution.isExactNullStartupTokenQuarantined(f.orders[0]!.tokenId)).toBe(true);
  });

  it("survives near-completion, working evidence and restart without losing reservation or either target", async () => {
    const f = fixture();
    const execution = await started(f);
    await importExchangeFills([f.fill(0, 114.6)], { ...f.deps, bus: f.bus });
    expect(current(f).status).not.toBe("filled");
    expect(f.deps.orderRepo.sumOpenBuyNotional("remaining")).toBeCloseTo(1.38);
    f.observations.set(incidentIds[0], f.remote(0, "PARTIALLY_FILLED", 114.6));
    await execution
      .getSubmitUnknownRecoveryContexts()
      .find((context) => context.order.orderId === current(f).orderId)!
      .observe();
    expect(current(f).status).toBe("partially-filled");
    await execution.stop();
    const restarted = await started(f);
    expect(current(f).status).not.toBe("filled");
    expect(f.deps.fillRepo.findUnreconciled()).toHaveLength(0);
    expect(f.deps.orderRepo.sumOpenBuyNotional("remaining")).toBeCloseTo((230 - 114.6) * 0.006);
    expect(f.deps.inventoryLotRepo.findByTokenId(f.orders[0]!.tokenId)).toHaveLength(1);
    f.orders.forEach((order) => expect(restarted.hasTransitionTarget(order.orderId)).toBe(true));
  });

  it("blocks terminal observation across inventory rollback and restores active-marked terminal rows", async () => {
    const f = fixture();
    await f.adopt();
    f.history([f.fill(0, 4)]);
    f.observations.set(incidentIds[0], f.remote(0, "CANCELLED", 4));
    f.conn.db.exec(`CREATE TRIGGER fail_recovery_lot BEFORE INSERT ON inventory_lots
      BEGIN SELECT RAISE(ABORT, 'inventory rollback'); END`);
    const result = await f.adopt();
    expect(result.skippedInventoryDrift).toBe(1);
    expect(f.deps.fillRepo.findUnreconciled()).toHaveLength(1);
    expect(f.deps.positionRepo.findActiveByTokenId(f.orders[0]!.tokenId)).toHaveLength(0);
    await applyOrderVerdict({
      ...f.deps,
      orderId: current(f).orderId,
      exchange: f.remote(0, "CANCELLED", 4),
      recoveryOwner: () => true,
    });
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(false);
    f.conn.db.prepare("UPDATE orders SET status = 'filled' WHERE order_id = ?").run(incidentIds[0]);
    expect(f.deps.orderRepo.findPendingBuyRecovery()).toHaveLength(2);
    expect(f.deps.orderRepo.sumOpenBuyNotional("remaining")).toBeCloseTo(1.38);
    f.conn.db.exec("DROP TRIGGER fail_recovery_lot");
    f.history([]);
    const execution = await started(f);
    expect(f.deps.fillRepo.findUnreconciled()).toHaveLength(0);
    expect(f.deps.inventoryLotRepo.findByTokenId(f.orders[0]!.tokenId)).toHaveLength(1);
    await execution.stop();
    await f.adopt();
    expect(f.deps.inventoryLotRepo.findByTokenId(f.orders[0]!.tokenId)).toHaveLength(1);
  });

  it("requires exact proof, durable higher matched coverage and all applied lots before releasing each member", async () => {
    const f = fixture();
    const execution = await started(f);
    const context = execution
      .getSubmitUnknownRecoveryContexts()
      .find((item) => item.order.orderId === current(f).orderId)!;
    await context.applyExact(f.remote(0, "CANCELLED", 4));
    await context.applyExact(f.remote(0, "CANCELLED", 0));
    expect(execution.hasTransitionTarget(current(f).orderId)).toBe(true);
    await importExchangeFills([f.fill(0, 4)], { ...f.deps, bus: f.bus });
    await context.applyExact(f.remote(0, "CANCELLED", 4));
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(false);
    f.observations.set(incidentIds[0], f.remote(0, "CANCELLED", 4));
    await f.adopt();
    const lot = f.deps.inventoryLotRepo.findByTokenId(f.orders[0]!.tokenId)[0]!;
    f.conn.db
      .prepare("UPDATE inventory_lots SET remaining_size = 0 WHERE lot_id = ?")
      .run(lot.lotId);
    await context.applyExact(null);
    expect(execution.hasTransitionTarget(current(f).orderId)).toBe(true);
    await context.applyExact(f.remote(0, "CANCELLED", 4));
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(true);
    expect(execution.hasTransitionTarget(current(f).orderId)).toBe(false);
    expect(execution.isExactNullStartupTokenQuarantined(f.orders[0]!.tokenId)).toBe(true);
    const sibling = execution.getSubmitUnknownRecoveryContexts()[0]!;
    await sibling.applyExact(f.remote(1, "CANCELLED", 0));
    expect(execution.hasTransitionTarget(current(f, 1).orderId)).toBe(false);
    expect(execution.isExactNullStartupTokenQuarantined(f.orders[0]!.tokenId)).toBe(false);
  });

  it("rejects repository bypasses, forged identity, and stale completion without terminal publication", async () => {
    const f = fixture();
    const execution = await started(f);
    const order = current(f);
    const repo = f.deps.orderRepo;
    expect(() => repo.updateStatus(order.orderId, "filled")).toThrow("protected");
    expect(() => repo.updateStatus(order.orderId, "open", "new-identity")).toThrow("protected");
    expect(() => repo.save({ ...order, status: "cancelled" })).toThrow("protected");
    expect(() => repo.save({ ...order, size: 200 })).toThrow("protected");
    expect(() => repo.updateMetadata(order.orderId, {})).toThrow("protected");
    expect(() => repo.updateMetadataIfUnchanged(order.orderId, order.metadata!, {})).toThrow(
      "protected",
    );
    expect(() => repo.updateMetadataBulk([{ orderId: order.orderId, metadata: {} }])).toThrow(
      "protected",
    );
    expect(() =>
      repo.replacePendingIdentity(order.orderId, {
        ...order,
        orderId: createOrderId("replacement"),
      }),
    ).toThrow("protected");
    expect(() =>
      repo.replaceCancelledRecoveryIdentity(order.orderId, order, order.metadata!),
    ).toThrow("protected");
    const published = vi.spyOn(f.bus, "publish");
    await inOrderLifecycleLane(String(order.orderId), () =>
      persistTerminalVerdictInLane(
        {
          ...f.deps,
          bus: f.bus,
          orderId: order.orderId,
          exchange: f.remote(0, "CANCELLED"),
          publish: true,
        },
        order,
        { status: "cancelled", reason: "bypass" },
        0,
      ),
    );
    expect(published).not.toHaveBeenCalledWith("OrderCancelled", expect.anything());
    const context = execution.getSubmitUnknownRecoveryContexts()[0]!;
    await context.applyExact({ ...f.remote(0, "CANCELLED"), price: 0.007 });
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(false);
    await execution.stop();
    await context.applyExact(f.remote(0, "CANCELLED"));
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(false);
  });

  it("routes user-stream terminal observations through current exact recovery proof", async () => {
    const f = fixture();
    const execution = await started(f);
    let callbacks!: Parameters<NonNullable<ExchangeGateway["createUserEventStream"]>>[0];
    f.gateway.createUserEventStream = (handlers) => {
      callbacks = handlers;
      return { close: vi.fn(), setConditionIds: vi.fn() };
    };
    const stream = new UserOrderStreamModule({
      ...f.deps,
      gateway: f.gateway,
      bus: f.bus,
      exactNullStartupQuarantine: execution,
    });
    onTestFinished(() => stream.stop());
    await stream.start();
    const event = {
      type: "order" as const,
      event: "CANCELLATION" as const,
      ...f.remote(0, "CANCELLED"),
      timestamp: Date.now(),
    };
    await callbacks.onOrderEvents([event]);
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(false);
    f.observations.set(incidentIds[0], f.remote(0, "CANCELLED"));
    await callbacks.onOrderEvents([{ ...event, event: "UPDATE", timestamp: event.timestamp + 1 }]);
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(true);
    expect(execution.hasTransitionTarget(current(f, 1).orderId)).toBe(true);
  });

  it.each(["second unknown", "unowned sibling", "wrong size", "extra remote", "malformed marker"])(
    "fails closed: %s",
    async (failure) => {
      const f = fixture();
      if (failure === "second unknown") {
        f.deps.orderRepo.updateStatus(f.orders[1]!.orderId, "pending");
        f.observations.set(incidentIds[1], null);
      }
      if (failure === "unowned sibling")
        f.conn.db
          .prepare("UPDATE orders SET position_id = NULL WHERE order_id = ?")
          .run(incidentIds[1]);
      if (failure === "wrong size")
        f.observations.set(incidentIds[1], { ...f.remote(1), sizeTotal: 115 });
      if (failure === "extra remote")
        f.observations.set("foreign", { ...f.remote(1), orderId: "foreign" });
      if (failure === "malformed marker")
        f.conn.db
          .prepare("UPDATE orders SET metadata_json = ? WHERE order_id = ?")
          .run('{"pendingBuyRecovery":{}}', incidentIds[0]);
      await expect(f.adopt()).rejects.toThrow(/pending BUY/);
    },
  );

  it("checks BUY barriers at both gates regardless of ownership flag and preserves unrelated violations", async () => {
    const f = fixture();
    await f.adopt();
    const control = bootstrapControlDb(":memory:");
    onTestFinished(() => control.close());
    const gate = {
      ledgerDb: f.conn.db,
      controlDb: control.db,
      applyToAllMarkets: false,
      log: f.deps.log,
      buyRecovery: {
        orderIds: f.orders.map((order) => order.orderId),
        orderRepo: f.deps.orderRepo,
        isTransitionTarget: () => false,
      },
    };
    for (const phase of ["pre-start", "pre-fence-release"] as const) {
      expect(() => runOwnershipInvariantStartupGate({ ...gate, phase })).toThrow(
        "neither terminal nor barrier-held",
      );
    }
    f.conn.db.prepare("UPDATE orders SET status = 'filled' WHERE order_id = ?").run(incidentIds[0]);
    expect(() => runOwnershipInvariantStartupGate(gate)).toThrow(
      "neither terminal nor barrier-held",
    );
    gate.buyRecovery.isTransitionTarget = () => true;
    expect(() => runOwnershipInvariantStartupGate(gate)).not.toThrow();
    f.conn.db.prepare("UPDATE positions SET status = 'open', size = 1").run();
    expect(() => runOwnershipInvariantStartupGate({ ...gate, applyToAllMarkets: true })).toThrow(
      "exit-ownership",
    );
    f.conn.db.prepare("DELETE FROM orders WHERE order_id = ?").run(incidentIds[0]);
    expect(() => runOwnershipInvariantStartupGate(gate)).toThrow(
      "neither terminal nor barrier-held",
    );
  });

  it("assigns recovery-created positions with the normal owner policy on offline-fill restart and repeat restart", async () => {
    const f = fixture();
    const execution = await started(f);
    await execution.stop();
    f.history([f.fill(0, 4)]);
    const restarted = await started(f);
    const position = f.deps.positionRepo.findActiveByTokenId(f.orders[0]!.tokenId)[0]!;
    expect(position.exitOwner).toBe("bounce");
    expect(position.positionId).not.toBe(f.orders[0]!.positionId);
    expect(f.deps.resolveNewExitOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionRuleId: "EXECUTION_PROFILE_SCALE_IN",
      }),
      null,
      expect.any(String),
    );
    await restarted.stop();
    await started(f);
    expect(f.deps.positionRepo.findActiveByTokenId(f.orders[0]!.tokenId)).toHaveLength(1);
  });

  it.each([1, 2])(
    "repairs a proven null-owner recovery creation with %s applied fills",
    async (count) => {
      const f = fixture();
      await f.adopt();
      f.history(Array.from({ length: count }, (_, index) => f.fill(0, 4, `repair-${index}`)));
      const resolve = f.deps.resolveNewExitOwner.getMockImplementation()!;
      f.deps.resolveNewExitOwner.mockImplementation(() => null);
      await f.adopt();
      const position = f.deps.positionRepo.findActiveByTokenId(f.orders[0]!.tokenId)[0]!;
      // Creation and repair share the resolver; suppress repair for this interrupted boot too.
      expect(position.exitOwner).toBeNull();
      f.deps.resolveNewExitOwner.mockImplementation(resolve);
      f.history([]);
      expect((await f.adopt()).repairedExactLocalExitOwners).toBe(1);
      expect(f.deps.positionRepo.findById(position.positionId)?.exitOwner).toBe("bounce");
    },
  );

  it.each(["unreconciled", "missing lot", "wrong token", "wrong condition", "wrong original size"])(
    "does not complete or reduce reservation with %s inventory evidence",
    async (failure) => {
      const f = fixture();
      await f.adopt();
      f.history([f.fill(0, 4)]);
      await f.adopt();
      const order = current(f);
      const db = f.conn.db;
      if (failure === "unreconciled") db.prepare("UPDATE fills SET reconciled = 0").run();
      if (failure === "missing lot") db.prepare("DELETE FROM inventory_lots").run();
      if (failure === "wrong token")
        db.prepare("UPDATE inventory_lots SET token_id = 'foreign'").run();
      if (failure === "wrong condition")
        db.prepare("UPDATE positions SET condition_id = 'foreign' WHERE position_id <> ?").run(
          order.positionId,
        );
      if (failure === "wrong original size") db.prepare("UPDATE inventory_lots SET size = 3").run();
      await applyOrderVerdict({
        ...f.deps,
        orderId: order.orderId,
        exchange: f.remote(0, "CANCELLED", 4),
        recoveryOwner: () => true,
      });
      expect(readPendingBuyRecovery(current(f))!.completed).toBe(false);
      expect(f.deps.orderRepo.sumOpenBuyNotional("remaining")).toBeCloseTo(1.38);
    },
  );

  it.each(["foreign source", "wrong original quantity", "wrong condition"])(
    "keeps null ownership fatal when recovery lineage has %s",
    async (failure) => {
      const f = fixture();
      await f.adopt();
      f.history([f.fill(0, 4)]);
      const resolver = f.deps.resolveNewExitOwner.getMockImplementation()!;
      f.deps.resolveNewExitOwner.mockImplementation(() => null);
      await f.adopt();
      const position = f.deps.positionRepo.findActiveByTokenId(f.orders[0]!.tokenId)[0]!;
      if (failure === "wrong original quantity")
        f.conn.db.prepare("UPDATE inventory_lots SET size = 3").run();
      if (failure === "wrong condition")
        f.conn.db.prepare("UPDATE fills SET condition_id = 'foreign'").run();
      if (failure === "foreign source") {
        f.deps.orderRepo.save({
          ...f.orders[0]!,
          orderId: createOrderId("foreign-source"),
          clientOrderId: "foreign-client" as (typeof f.orders)[number]["clientOrderId"],
          exchangeOrderId: "foreign-source",
          status: "filled",
        });
        f.conn.db.prepare("UPDATE fills SET order_id = 'foreign-source'").run();
      }
      f.history([]);
      f.deps.resolveNewExitOwner.mockImplementation(resolver);
      expect((await f.adopt()).repairedExactLocalExitOwners).toBe(0);
      expect(f.deps.positionRepo.findById(position.positionId)?.exitOwner).toBeNull();
    },
  );

  it("atomically registers both identities and refuses completion against changed evidence", async () => {
    const f = fixture();
    const repo = f.deps.orderRepo;
    expect(() =>
      repo.registerPendingBuyRecovery(
        [f.orders[0]!, { ...f.orders[1]!, size: 115 }],
        f.orders[0]!.orderId,
        f.observations,
      ),
    ).toThrow("registration changed");
    expect(repo.findPendingBuyRecovery()).toHaveLength(0);
    await f.adopt();
    const snapshot = current(f);
    repo.observePendingBuyRecovery(snapshot.orderId, f.remote(0, "PARTIALLY_FILLED", 4));
    expect(repo.completePendingBuyRecovery(snapshot, f.remote(0, "CANCELLED", 0), () => true)).toBe(
      false,
    );
    expect(readPendingBuyRecovery(current(f))!.matched).toBe(4);
    expect(readPendingBuyRecovery(current(f))!.completed).toBe(false);
  });

  it("reconstructs the remaining sibling after the unknown anchor completes and the process restarts", async () => {
    const f = fixture();
    const execution = await started(f);
    f.observations.set(incidentIds[0], f.remote(0, "CANCELLED"));
    await execution
      .getSubmitUnknownRecoveryContexts()
      .find((context) => context.order.orderId === current(f).orderId)!
      .observe();
    await execution.stop();
    const restarted = await started(f);
    expect(restarted.hasTransitionTarget(current(f).orderId)).toBe(false);
    expect(restarted.hasTransitionTarget(current(f, 1).orderId)).toBe(true);
    expect(restarted.getSubmitUnknownRecoveryContexts()).toHaveLength(1);
    expect(f.deps.orderRepo.sumOpenBuyNotional("remaining")).toBeCloseTo(0.69);
  });
});
