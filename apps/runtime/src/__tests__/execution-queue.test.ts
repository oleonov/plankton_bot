import { describe, it, expect, vi } from "vitest";
import { ExecutionQueue } from "../modules/execution/execution-queue.js";
import { createTokenId, createCommandId, createConditionId } from "@krabs/domain";
import type { PlaceOrderCommand, CancelOrderCommand, ClientOrderId } from "@krabs/domain";

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

  it("does not return from shutdown while a same-token successor is still executing", async () => {
    // The successor is invisible to a snapshot of `inFlight`: it is promoted by the FIRST
    // command's own `finally` -> `drain()`, long after `shutdown()` took its snapshot. Returning
    // there is what lets ExecutionModule.stop() release the successor's deferred idempotency mark
    // and unwind its reservation while it is still running — recreating the entry_unknown_min
    // tight loop across a restart.
    const running = new Set<string>();
    const execute = vi.fn(async (cmd: PlaceOrderCommand | CancelOrderCommand) => {
      const id = String((cmd as PlaceOrderCommand).commandId);
      running.add(id);
      await new Promise((r) => setTimeout(r, 20));
      running.delete(id);
    });

    const queue = new ExecutionQueue({
      maxConcurrency: 4,
      shutdownTimeoutMs: 5000,
      execute,
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    // Same token on purpose: the mutex holds the second back until the first completes.
    const token = createTokenId("tok-same");
    queue.enqueue(makePlaceCmd({ commandId: createCommandId("first"), tokenId: token }));
    queue.enqueue(makePlaceCmd({ commandId: createCommandId("successor"), tokenId: token }));

    await queue.shutdown();

    expect(execute).toHaveBeenCalledTimes(2);
    expect([...running]).toEqual([]);
    expect(queue.pendingCount).toBe(0);
  });

  it("shares one deadline across generations instead of restarting it per generation", async () => {
    // A per-generation timeout would let a chain of same-token successors extend the shutdown
    // without bound — 5 × 40 ms of work must not be allowed to outlast a 60 ms budget.
    //
    // Asserted as a COUNT under fake timers, not as elapsed wall-clock: a loaded CI box can
    // deliver a 60 ms timer late enough to blow any real-time threshold with correct code, and
    // "how many commands the budget admitted" is the property under test anyway.
    vi.useFakeTimers();
    try {
      const execute = vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 40));
      });

      const queue = new ExecutionQueue({
        maxConcurrency: 1,
        shutdownTimeoutMs: 60,
        execute,
        resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
        log: silentLog,
      });

      const token = createTokenId("tok-chain");
      for (let i = 0; i < 5; i++) {
        queue.enqueue(makePlaceCmd({ commandId: createCommandId(`c${i}`), tokenId: token }));
      }

      silentLog.warn.mockClear();
      // The count is sampled AT the moment the shutdown returns, and only then is the clock run
      // past the whole 5 × 40 ms chain. Stopping the clock at the deadline instead would make a
      // per-generation timer HANG this test rather than fail it, and a timeout says far less than
      // a number: sampled this way, the broken variant reports "admitted all five".
      let admittedAtReturn = -1;
      const shutdown = queue.shutdown().then((result) => {
        admittedAtReturn = execute.mock.calls.length;
        return result;
      });
      await vi.advanceTimersByTimeAsync(500);
      const { drained } = await shutdown;

      // One shared 60 ms budget admits the command started at t=0 and its successor promoted at
      // t=40, and stops there. A per-generation timer restarts at every completion, so all five
      // 40 ms commands would run — and the shutdown would then claim quiescence it never enforced.
      expect(admittedAtReturn).toBe(2);
      expect(drained).toBe(false);
      expect(silentLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ abandoned: expect.any(Number) }),
        "shutdown timeout — commands abandoned",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a timed-out shutdown as NOT drained, and a clean one as drained", async () => {
    // The caller releases deferred idempotency marks on the strength of this flag. A shutdown
    // that returned at its deadline with work still running must never be mistaken for quiescence.
    let release!: () => void;
    const execute = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );

    const queue = new ExecutionQueue({
      maxConcurrency: 1,
      shutdownTimeoutMs: 20,
      execute,
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    queue.enqueue(makePlaceCmd({ commandId: createCommandId("stuck") }));
    expect(await queue.shutdown()).toEqual({ drained: false });

    release();
    queue.reopen();
    expect(await queue.shutdown()).toEqual({ drained: true });
  });

  it("keeps its accounting intact when the executor throws synchronously", async () => {
    // `activeCount` is incremented before the executor runs. A synchronous throw that escaped
    // before the `.finally()` was installed would strand the slot and the token lock, and the
    // queue would silently lose capacity until it could start nothing at all.
    const execute = vi.fn((cmd: PlaceOrderCommand | CancelOrderCommand) => {
      if (String((cmd as PlaceOrderCommand).commandId) === "sync-throw") {
        throw new Error("synchronous executor failure");
      }
      return Promise.resolve();
    });

    const queue = new ExecutionQueue({
      maxConcurrency: 1,
      shutdownTimeoutMs: 1000,
      execute,
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    const token = createTokenId("tok-sync");
    queue.enqueue(makePlaceCmd({ commandId: createCommandId("sync-throw"), tokenId: token }));
    queue.enqueue(makePlaceCmd({ commandId: createCommandId("after"), tokenId: token }));

    expect(await queue.shutdown()).toEqual({ drained: true });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queue.diagnostics.activeCount).toBe(0);
    expect(queue.pendingCount).toBe(0);
  });

  it("promotes nothing once a timed-out shutdown has returned", async () => {
    // `accepting` gates enqueue, but promotion out of the queue happens in `drain()` — which the
    // abandoned in-flight command calls from its own `finally`, long after the shutdown reported
    // `{drained:false}` and `ExecutionModule.stop()` set `started = false`. The successor it
    // promotes reaches the gateway while the module and the supervisor both report stopped.
    const started: string[] = [];
    let releaseFirst!: () => void;
    const execute = vi.fn((cmd: PlaceOrderCommand | CancelOrderCommand) => {
      started.push(String((cmd as PlaceOrderCommand).commandId));
      if (started.length > 1) return Promise.resolve();
      return new Promise<void>((r) => {
        releaseFirst = r;
      });
    });

    const queue = new ExecutionQueue({
      maxConcurrency: 1,
      shutdownTimeoutMs: 20,
      execute,
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    const token = createTokenId("tok-frozen");
    queue.enqueue(makePlaceCmd({ commandId: createCommandId("a"), tokenId: token }));
    queue.enqueue(makePlaceCmd({ commandId: createCommandId("b"), tokenId: token }));

    expect(await queue.shutdown()).toEqual({ drained: false });
    expect(started).toEqual(["a"]);

    // The command the shutdown abandoned now finishes — the exact moment the old code promoted
    // its same-token successor onto a stopped module.
    releaseFirst();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a"]);

    // Only a restart may release it: the command was accepted and never rejected, so `reopen()`
    // still has to drain it rather than strand its reservation and idempotency mark.
    queue.reopen();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(["a", "b"]);
  });

  it("does not report a clean drain when a command shuts the queue down from inside its own frame", async () => {
    // `execute` reaches a SYNCHRONOUS publish, and a handler on it can call shutdown() from inside
    // this very `drain()` frame: the command is already spliced out of `queue`, and a claim
    // registered only after `execute` RETURNS is not in `inFlight` yet either. `pendingCount` reads
    // zero, the shutdown reports a clean drain over a command that is mid-execution, and the caller
    // bulk-releases its idempotency mark with the reservation still live — the production defect.
    let releaseCommand!: () => void;
    let commandFinished = false;
    let verdict: { drained: boolean } | null = null;
    let shuttingDown!: Promise<void>;

    const queue: ExecutionQueue = new ExecutionQueue({
      maxConcurrency: 2,
      shutdownTimeoutMs: 5_000,
      execute: () => {
        shuttingDown = queue.shutdown().then((v) => {
          verdict = v;
        });
        return new Promise<void>((r) => (releaseCommand = r)).then(() => {
          commandFinished = true;
        });
      },
      resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
      log: silentLog,
    });

    queue.enqueue(makePlaceCmd());
    await new Promise((r) => setTimeout(r, 0));
    expect(verdict).toBeNull();

    releaseCommand();
    await shuttingDown;

    expect(commandFinished).toBe(true);
    expect(verdict).toEqual({ drained: true });
  });

  describe("drainAbandoned — the teardown budget left over once every module is down", () => {
    /** A queue whose shutdown deadline is short enough to abandon a held command deterministically. */
    function makeHangingQueue(maxConcurrency: number): {
      queue: ExecutionQueue;
      started: string[];
      completed: string[];
      release: () => void;
    } {
      const started: string[] = [];
      const completed: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const queue = new ExecutionQueue({
        maxConcurrency,
        shutdownTimeoutMs: 20,
        execute: async (cmd) => {
          const id = String((cmd as PlaceOrderCommand).commandId);
          started.push(id);
          await held;
          completed.push(id);
        },
        resolveTokenId: (cmd) => (cmd as PlaceOrderCommand).tokenId,
        log: silentLog,
      });
      return { queue, started, completed, release: () => release() };
    }

    it("lets a command the shutdown deadline abandoned run to completion", async () => {
      // `shutdown()`'s bound is a SCHEDULING decision — it runs while two dozen other modules are
      // still queued behind it. What it abandons can be a POST the exchange has already accepted,
      // and a process that exits before that command's own `finally` persists the order leaves the
      // order live on the exchange with no local row.
      const { queue, completed, release } = makeHangingQueue(2);
      queue.enqueue(makePlaceCmd());

      expect(await queue.shutdown()).toEqual({ drained: false });
      expect(queue.inFlightCount).toBe(1);
      expect(completed).toEqual([]);

      const tail = queue.drainAbandoned(5_000);
      release();

      expect(await tail).toBe(true);
      expect(completed).toEqual(["cmd-1"]);
      expect(queue.inFlightCount).toBe(0);
    });

    it("never promotes a command the deadline left QUEUED — the latch is what makes the tail safe", async () => {
      // A tail that re-opened the queue would put a fresh command on the gateway after the
      // supervisor already reported the module stopped. Two DIFFERENT tokens, so what holds the
      // second one back is the concurrency cap and then the latch — not the per-token mutex.
      const { queue, started, release } = makeHangingQueue(1);
      queue.enqueue(makePlaceCmd({ commandId: createCommandId("cmd-a") }));
      queue.enqueue(
        makePlaceCmd({ commandId: createCommandId("cmd-b"), tokenId: createTokenId("tok-2") }),
      );

      expect(await queue.shutdown()).toEqual({ drained: false });
      // What a tail drain waits for is the RUNNING command, not the one still in the queue: the
      // latch guarantees the queued one can never start, so counting it would make the tail wait
      // out its whole deadline for work that will never exist.
      expect(queue.inFlightCount).toBe(1);
      expect(queue.pendingCount).toBe(2);

      const tail = queue.drainAbandoned(5_000);
      release();

      expect(await tail).toBe(true);
      expect(started).toEqual(["cmd-a"]);
      expect(queue.pendingCount).toBe(1);
    });

    it("latches — not just reports — a tail drain that arrives before the queue was frozen", async () => {
      // The entire safety argument is `frozen`. Reaching here without it is a wiring mistake, and
      // detecting it is only half the answer: the promotion the log warns about happens anyway,
      // one `finally` later. Two DIFFERENT tokens at concurrency 1, so what holds the second one
      // back is the concurrency cap and then the latch — not the per-token mutex — which makes the
      // promotion observable instead of something the log merely asserts.
      const { queue, started, release } = makeHangingQueue(1);
      queue.enqueue(makePlaceCmd({ commandId: createCommandId("cmd-a") }));
      queue.enqueue(
        makePlaceCmd({ commandId: createCommandId("cmd-b"), tokenId: createTokenId("tok-2") }),
      );
      silentLog.error.mockClear();

      const tail = queue.drainAbandoned(5_000);
      release();
      await tail;

      expect(silentLog.error).toHaveBeenCalledWith(
        expect.objectContaining({ inFlight: 1, queued: 1 }),
        expect.stringContaining("before shutdown latched the queue"),
      );
      // cmd-a's `finally` ran while the tail was awaiting it. Unlatched, that promotes cmd-b onto
      // the gateway — the module is already reported down, so nobody is left to await it.
      expect(started).toEqual(["cmd-a"]);
      expect(queue.pendingCount).toBe(1);
    });
  });
});
