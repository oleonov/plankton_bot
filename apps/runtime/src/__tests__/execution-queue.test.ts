import { describe, it, expect, vi } from "vitest";
import { ExecutionQueue } from "../modules/execution/execution-queue.js";
import {
  createTokenId,
  createCommandId,
  createFamilyId,
  createConditionId,
} from "@plankton/domain";
import type { PlaceOrderCommand, CancelOrderCommand, ClientOrderId } from "@plankton/domain";

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => silentLog,
} as any;

function makePlaceCmd(overrides?: Partial<PlaceOrderCommand>): PlaceOrderCommand {
  return {
    type: "PlaceOrderCommand",
    commandId: createCommandId("cmd-1"),
    clientOrderId: "co-1" as ClientOrderId,
    source: "strategy",
    tokenId: createTokenId("tok-1"),
    conditionId: createConditionId("cond-1"),
    side: "buy",
    size: 10,
    price: 0.5,
    orderType: "GTC",
    tickSize: 0.01,
    negRisk: false,
    familyId: createFamilyId("fam-1"),
    sequenceInTick: 0,
    signalReason: null,
    ...overrides,
  };
}

describe("ExecutionQueue", () => {
  it("executes commands with bounded concurrency", async () => {
    const order: string[] = [];
    const execute = vi.fn(async (cmd: PlaceOrderCommand | CancelOrderCommand) => {
      order.push(String((cmd as PlaceOrderCommand).commandId));
      await new Promise((r) => setTimeout(r, 10));
    });

    const queue = new ExecutionQueue({
      maxConcurrency: 2,
      shutdownTimeoutMs: 5000,
      execute,
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    queue.enqueue(
      makePlaceCmd({ commandId: createCommandId("a"), tokenId: createTokenId("tok-a") }),
    );
    queue.enqueue(
      makePlaceCmd({ commandId: createCommandId("b"), tokenId: createTokenId("tok-b") }),
    );
    queue.enqueue(
      makePlaceCmd({ commandId: createCommandId("c"), tokenId: createTokenId("tok-c") }),
    );

    await queue.shutdown();

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("enforces per-token mutex (serializes same-token commands)", async () => {
    const callOrder: string[] = [];
    const execute = vi.fn(async (cmd: PlaceOrderCommand | CancelOrderCommand) => {
      callOrder.push(`start-${(cmd as PlaceOrderCommand).commandId}`);
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push(`end-${(cmd as PlaceOrderCommand).commandId}`);
    });

    const queue = new ExecutionQueue({
      maxConcurrency: 4,
      shutdownTimeoutMs: 5000,
      execute,
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    const sameToken = createTokenId("tok-same");
    queue.enqueue(makePlaceCmd({ commandId: createCommandId("x"), tokenId: sameToken }));
    queue.enqueue(makePlaceCmd({ commandId: createCommandId("y"), tokenId: sameToken }));

    await queue.shutdown();

    // x must complete before y starts (per-token mutex)
    const xEnd = callOrder.indexOf("end-x");
    const yStart = callOrder.indexOf("start-y");
    expect(xEnd).toBeLessThan(yStart);
  });

  it("rejects enqueue after shutdown starts", async () => {
    const execute = vi.fn(async () => {});
    const queue = new ExecutionQueue({
      maxConcurrency: 4,
      shutdownTimeoutMs: 5000,
      execute,
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    const promise = queue.shutdown();
    queue.enqueue(makePlaceCmd()); // should be silently dropped
    await promise;

    expect(execute).not.toHaveBeenCalled();
  });

  it("same-token commands do not waste concurrency slots for other tokens", async () => {
    const callOrder: string[] = [];
    const execute = vi.fn(async (cmd: PlaceOrderCommand | CancelOrderCommand) => {
      const id = String((cmd as PlaceOrderCommand).commandId);
      callOrder.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 50));
      callOrder.push(`end-${id}`);
    });

    const queue = new ExecutionQueue({
      maxConcurrency: 2,
      shutdownTimeoutMs: 5000,
      execute,
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    // Enqueue: 2 commands for tok-a, then 1 for tok-b
    queue.enqueue(
      makePlaceCmd({ commandId: createCommandId("a1"), tokenId: createTokenId("tok-a") }),
    );
    queue.enqueue(
      makePlaceCmd({ commandId: createCommandId("a2"), tokenId: createTokenId("tok-a") }),
    );
    queue.enqueue(
      makePlaceCmd({ commandId: createCommandId("b1"), tokenId: createTokenId("tok-b") }),
    );

    await queue.shutdown();

    expect(execute).toHaveBeenCalledTimes(3);

    // b1 should start concurrently with a1 (not blocked behind a2 waiting for a1)
    const _a1Start = callOrder.indexOf("start-a1");
    const b1Start = callOrder.indexOf("start-b1");
    const a1End = callOrder.indexOf("end-a1");

    // b1 starts before a1 ends — proves it ran concurrently, not blocked by a2
    expect(b1Start).toBeLessThan(a1End);
    // a2 starts after a1 ends (per-token mutex)
    const a2Start = callOrder.indexOf("start-a2");
    expect(a2Start).toBeGreaterThan(a1End - 1);
  });

  it("handles execute errors without breaking the queue", async () => {
    let callCount = 0;
    const execute = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("boom");
    });

    const queue = new ExecutionQueue({
      maxConcurrency: 4,
      shutdownTimeoutMs: 5000,
      execute,
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    queue.enqueue(
      makePlaceCmd({ commandId: createCommandId("fail"), tokenId: createTokenId("t1") }),
    );
    queue.enqueue(makePlaceCmd({ commandId: createCommandId("ok"), tokenId: createTokenId("t2") }));

    await queue.shutdown();

    expect(execute).toHaveBeenCalledTimes(2);
  });
});
