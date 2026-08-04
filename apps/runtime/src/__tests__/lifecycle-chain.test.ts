import { describe, it, expect, vi } from "vitest";
import { LifecycleChain, LifecycleSupersededError, waitAtMost } from "../lifecycle-chain.js";

describe("LifecycleChain", () => {
  it("serializes a transition that re-enters the chain synchronously", async () => {
    // The event bus dispatches handlers SYNCHRONOUSLY, so a transition that publishes an event can
    // be re-entered from inside its own first statements — `Supervisor.start()` publishes
    // INITIALIZING, and a handler that calls `stop()` runs before the start has yielded once.
    // Claiming the chain only AFTER the transition returns leaves that re-entrant call looking at
    // an idle chain, and the two run concurrently: `INITIALIZING → SHUTTING_DOWN → module.stop →
    // module.start → READY → STOPPED`, i.e. phase STOPPED with the module still live.
    const chain = new LifecycleChain();
    const order: string[] = [];
    let inner!: Promise<void>;

    const outer = chain.run(async () => {
      order.push("outer:start");
      inner = chain.run(async () => {
        order.push("inner:start");
        await Promise.resolve();
        order.push("inner:end");
      });
      await Promise.resolve();
      order.push("outer:end");
    });

    await Promise.all([outer, inner]);

    expect(order).toEqual(["outer:start", "outer:end", "inner:start", "inner:end"]);
  });

  it("stops anyway when the transition ahead of it never settles", async () => {
    // Serializing stop behind start introduces a failure mode the unserialized code did not have:
    // a `start()` whose gateway promise never resolves makes SIGTERM hang forever inside
    // `supervisor.stop()` — no module stopped, no database closed, `process.exit()` never reached.
    // The escape only ever fires when something is already wedged, and overlapping a wedged start
    // beats a process that cannot shut down at all.
    vi.useFakeTimers();
    try {
      const chain = new LifecycleChain();
      const onExpired = vi.fn();
      let stopped = false;

      void chain.run(() => new Promise<void>(() => undefined));
      // Deliberately not awaited: without the escape this promise never settles, and awaiting it
      // would turn a clean assertion into a test timeout that says far less about what broke.
      void chain.run(
        async () => {
          stopped = true;
        },
        { ms: 5_000, onExpired },
      );

      await vi.advanceTimersByTimeAsync(4_999);
      expect(stopped).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(onExpired).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire the escape when the predecessor settles in time", async () => {
    vi.useFakeTimers();
    try {
      const chain = new LifecycleChain();
      const onExpired = vi.fn();
      const order: string[] = [];

      const first = chain.run(async () => {
        await new Promise((r) => setTimeout(r, 100));
        order.push("first");
      });
      const second = chain.run(
        async () => {
          order.push("second");
        },
        { ms: 5_000, onExpired },
      );

      await vi.advanceTimersByTimeAsync(100);
      await Promise.all([first, second]);

      expect(order).toEqual(["first", "second"]);
      expect(onExpired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a queued transition that a later escape has already overtaken", async () => {
    // The ceiling only ever lets the LATEST caller past a wedged transition — it does not reorder
    // the ones still queued behind it. `stop A → start B → stop C` with A wedged and C's ceiling
    // expiring runs C, and then runs B when A finally settles: the start subscribes AFTER the stop
    // unsubscribed, leaving live handlers on a module the supervisor reports as stopped. B never
    // started, so by the time its turn comes it is older intent than a decision already applied.
    vi.useFakeTimers();
    try {
      const onSuperseded = vi.fn();
      const chain = new LifecycleChain(onSuperseded);
      const order: string[] = [];
      let releaseWedged!: () => void;

      const wedgedStop = chain.run(() => new Promise<void>((r) => (releaseWedged = r)));
      const startB = chain.run(async () => {
        order.push("start B");
      });
      const stopC = chain.run(
        async () => {
          order.push("stop C");
        },
        { ms: 5_000, onExpired: () => undefined },
      );

      await vi.advanceTimersByTimeAsync(5_000);
      expect(order).toEqual(["stop C"]);

      releaseWedged();
      // Reported as a failure, not silently resolved: `Supervisor.start()` returning normally for a
      // start that never ran tells its caller the runtime is up while the phase is STOPPED and
      // every module is down. A log line is not a result.
      await expect(startB).rejects.toBeInstanceOf(LifecycleSupersededError);
      await Promise.all([wedgedStop, stopC]);

      expect(order).toEqual(["stop C"]);
      expect(onSuperseded).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells a RUNNING transition that a later one overtook it", async () => {
    // Dropping queued transitions is not enough. A start that is already past its first await —
    // waiting on `exchangeGateway.getBalances()`, say — is not queued, so nothing drops it: the stop
    // gives up waiting, walks the module list backwards, and then the start resumes and re-installs
    // timers and subscriptions on the modules the stop already passed. `STOPPED` with live handlers.
    // Only the transition itself can undo that, and only if the chain tells it.
    vi.useFakeTimers();
    try {
      const chain = new LifecycleChain();
      let release!: () => void;
      const seenBeforeEscape: boolean[] = [];
      const seenAfterEscape: boolean[] = [];

      const wedgedStart = chain.run(async (token) => {
        seenBeforeEscape.push(token.superseded);
        await new Promise<void>((r) => (release = r));
        seenAfterEscape.push(token.superseded);
      });
      void chain.run(async () => undefined, { ms: 5_000, onExpired: () => undefined });

      await vi.advanceTimersByTimeAsync(5_000);
      release();
      await wedgedStart;

      expect(seenBeforeEscape).toEqual([false]);
      expect(seenAfterEscape).toEqual([true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the next transition even after the previous one rejects", async () => {
    const chain = new LifecycleChain();
    const order: string[] = [];

    const failing = chain.run(async () => {
      order.push("failing");
      throw new Error("start failed halfway");
    });
    const cleanup = chain.run(async () => {
      order.push("cleanup");
    });

    await expect(failing).rejects.toThrow("start failed halfway");
    await cleanup;
    expect(order).toEqual(["failing", "cleanup"]);
  });
});

describe("waitAtMost", () => {
  it("stops waiting at the ceiling and reports it exactly once", async () => {
    // Every teardown wait is bounded through this one function, so the bound is only as true as
    // this test: `worker.terminate()` cannot interrupt a native synchronous better-sqlite3 call and
    // settles only when the write lock is released, i.e. never within any budget worth writing down.
    vi.useFakeTimers();
    try {
      const onExpired = vi.fn();
      let settled = false;

      // Deliberately not awaited: an unbounded wait would turn a clean assertion into a timeout.
      void waitAtMost(new Promise<void>(() => undefined), { ms: 2_000, onExpired }).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(1_999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(onExpired).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a failed wait cancel the teardown around it", async () => {
    // The worker thread dying mid-shutdown is the ORDINARY case here — it is being terminated. If
    // that rejection propagated, the shutdown handler would skip closing the databases, which is
    // the outcome the whole bound exists to prevent.
    const onExpired = vi.fn();

    await expect(
      waitAtMost(Promise.reject(new Error("worker exited")), { ms: 2_000, onExpired }),
    ).resolves.toBeUndefined();
    expect(onExpired).not.toHaveBeenCalled();
  });
});
