import { describe, it, expect, beforeEach, vi } from "vitest";
import type { RuntimeModule, RuntimePhase } from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import pino from "pino";
import { LifecycleSupersededError, LIFECYCLE_STOP_WAIT_MS } from "../lifecycle-chain.js";
import { Supervisor } from "../supervisor/supervisor.js";

const log = pino({ level: "silent" });

function createTestModule(_name: string): RuntimeModule & { started: boolean; stopped: boolean } {
  const mod = {
    started: false,
    stopped: false,
    async start() {
      mod.started = true;
    },
    async stop() {
      mod.stopped = true;
    },
    async healthCheck() {
      return { ok: mod.started } as const;
    },
  };
  return mod;
}

function createFailingModule(): RuntimeModule {
  return {
    async start() {
      throw new Error("boom");
    },
    async stop() {},
    async healthCheck() {
      return { ok: false };
    },
  };
}

describe("Supervisor", () => {
  let bus: InProcessEventBus;

  beforeEach(() => {
    bus = new InProcessEventBus();
  });

  it("starts all modules and transitions to READY", async () => {
    const modA = createTestModule("a");
    const modB = createTestModule("b");

    const supervisor = new Supervisor({
      modules: [
        ["a", modA],
        ["b", modB],
      ],
      bus,
      log,
    });

    await supervisor.start();

    expect(modA.started).toBe(true);
    expect(modB.started).toBe(true);
    expect(supervisor.getPhase()).toBe("READY");
  });

  it("stops modules in reverse order and transitions to STOPPED", async () => {
    const order: string[] = [];
    const modA: RuntimeModule = {
      async start() {},
      async stop() {
        order.push("a");
      },
      async healthCheck() {
        return { ok: true };
      },
    };
    const modB: RuntimeModule = {
      async start() {},
      async stop() {
        order.push("b");
      },
      async healthCheck() {
        return { ok: true };
      },
    };

    const supervisor = new Supervisor({
      modules: [
        ["a", modA],
        ["b", modB],
      ],
      bus,
      log,
    });

    await supervisor.start();
    await supervisor.stop();

    expect(order).toEqual(["b", "a"]);
    expect(supervisor.getPhase()).toBe("STOPPED");
  });

  it("transitions to ERROR and rolls back started modules on start failure", async () => {
    const good = createTestModule("good");
    const bad = createFailingModule();

    const supervisor = new Supervisor({
      modules: [
        ["good", good],
        ["bad", bad],
      ],
      bus,
      log,
    });

    await expect(supervisor.start()).rejects.toThrow("boom");
    expect(supervisor.getPhase()).toBe("ERROR");
    // good was started then rolled back
    expect(good.started).toBe(true);
    expect(good.stopped).toBe(true);
  });

  it("emits RuntimePhaseChanged events", async () => {
    const phases: RuntimePhase[] = [];
    bus.subscribe("RuntimePhaseChanged", async (payload) => {
      phases.push(payload.phase);
    });

    const supervisor = new Supervisor({
      modules: [],
      bus,
      log,
    });

    await supervisor.start();
    await supervisor.stop();

    expect(phases).toEqual(["INITIALIZING", "READY", "SHUTTING_DOWN", "STOPPED"]);
  });

  it("stop is idempotent", async () => {
    const supervisor = new Supervisor({ modules: [], bus, log });
    await supervisor.start();
    await supervisor.stop();
    await supervisor.stop(); // should not throw
    expect(supervisor.getPhase()).toBe("STOPPED");
  });

  it("pause/resume toggling works", async () => {
    const supervisor = new Supervisor({ modules: [], bus, log });
    expect(supervisor.isPaused()).toBe(false);
    supervisor.setPaused(true);
    expect(supervisor.isPaused()).toBe(true);
    supervisor.setPaused(false);
    expect(supervisor.isPaused()).toBe(false);
  });

  it("can be paused immediately after start (start-paused pattern)", async () => {
    const mod = createTestModule("a");
    const supervisor = new Supervisor({ modules: [["a", mod]], bus, log });

    await supervisor.start();
    supervisor.setPaused(true);

    expect(supervisor.getPhase()).toBe("READY");
    expect(supervisor.isPaused()).toBe(true);
    expect(mod.started).toBe(true);

    await supervisor.stop();
  });

  it("STOPPED event handlers complete before stop() resolves", async () => {
    let handlerRan = false;
    bus.subscribe("RuntimePhaseChanged", async (payload) => {
      if (payload.phase === "STOPPED") {
        // Simulate async work in STOPPED handler
        await new Promise((r) => setTimeout(r, 10));
        handlerRan = true;
      }
    });

    const supervisor = new Supervisor({ modules: [], bus, log });
    await supervisor.start();
    await supervisor.stop();

    expect(handlerRan).toBe(true);
  });

  it("continues stopping remaining modules when one module stop throws", async () => {
    const modA: RuntimeModule = {
      async start() {},
      async stop() {
        throw new Error("stop fail");
      },
      async healthCheck() {
        return { ok: true };
      },
    };
    const modB = createTestModule("b");

    const supervisor = new Supervisor({
      modules: [
        ["a", modA],
        ["b", modB],
      ],
      bus,
      log,
    });

    await supervisor.start();
    await supervisor.stop();

    expect(modB.stopped).toBe(true);
    expect(supervisor.getPhase()).toBe("STOPPED");
  });

  it("a stop overlapping a start does not leave a half-up runtime", async () => {
    // Start walks the module list forward, stop walks it backward. Overlapped, they interleave:
    // the stop tears down the late modules while the start is still bringing the early ones up,
    // and the run ends reporting STOPPED with live streams and timers behind it. Per-module
    // guards cannot fix that — the mixed state is a property of the ORDER, not of one module.
    const live = new Set<string>();
    let releaseFirstStart!: () => void;
    const held = new Promise<void>((r) => {
      releaseFirstStart = r;
    });

    const makeModule = (name: string, gate?: Promise<void>): RuntimeModule => ({
      async start() {
        if (gate) await gate;
        live.add(name);
      },
      async stop() {
        live.delete(name);
      },
      async healthCheck() {
        return { ok: live.has(name) };
      },
    });

    const supervisor = new Supervisor({
      modules: [
        ["early", makeModule("early", held)],
        ["late", makeModule("late")],
      ],
      bus,
      log,
    });

    const starting = supervisor.start();
    const stopping = supervisor.stop();
    releaseFirstStart();
    await Promise.all([starting, stopping]);

    // The last requested transition was the stop, so nothing may remain live under it.
    expect([...live]).toEqual([]);
    expect(supervisor.getPhase()).toBe("STOPPED");
  });

  it("a start overlapping a stop leaves the runtime UP, not partly torn down", async () => {
    // The mirror case: the LAST caller decides. A stop that resumed after the restart had
    // already brought modules up would tear down a runtime nobody asked to stop.
    const live = new Set<string>();
    let releaseStop!: () => void;
    const held = new Promise<void>((r) => {
      releaseStop = r;
    });

    const makeModule = (name: string): RuntimeModule => ({
      async start() {
        live.add(name);
      },
      async stop() {
        await held;
        live.delete(name);
      },
      async healthCheck() {
        return { ok: live.has(name) };
      },
    });

    const supervisor = new Supervisor({
      modules: [
        ["a", makeModule("a")],
        ["b", makeModule("b")],
      ],
      bus,
      log,
    });

    await supervisor.start();
    const stopping = supervisor.stop();
    const restarting = supervisor.start();
    releaseStop();
    await Promise.all([stopping, restarting]);

    expect([...live].sort()).toEqual(["a", "b"]);
    expect(supervisor.getPhase()).toBe("READY");
  });
  it("a start still in flight when the stop gives up waiting does not resurrect modules", async () => {
    // Dropping QUEUED transitions does not cover this one: the start is already running, so nothing
    // drops it. It is parked inside a module's `start()` — waiting on `getBalances()` in production
    // — when the stop's ceiling expires; the stop then walks the module list backwards past a
    // module that has installed nothing yet, publishes STOPPED, and only afterwards does the start
    // resume and bring that module (and every module after it) up under a runtime reported as down.
    vi.useFakeTimers();
    try {
      const live = new Set<string>();
      const startAttempts: string[] = [];
      let releaseSlowStart!: () => void;
      const slowStart = new Promise<void>((r) => {
        releaseSlowStart = r;
      });

      const makeModule = (name: string, gate?: Promise<void>): RuntimeModule => ({
        async start() {
          startAttempts.push(name);
          if (gate) await gate;
          live.add(name);
        },
        async stop() {
          live.delete(name);
        },
        async healthCheck() {
          return { ok: live.has(name) };
        },
      });

      const supervisor = new Supervisor({
        modules: [
          ["publisher", makeModule("publisher", slowStart)],
          ["later", makeModule("later")],
        ],
        bus,
        log,
      });

      const starting = supervisor.start();
      const stopping = supervisor.stop();

      await vi.advanceTimersByTimeAsync(LIFECYCLE_STOP_WAIT_MS);
      await stopping;
      expect(supervisor.getPhase()).toBe("STOPPED");

      releaseSlowStart();
      // Truthful result: the start did not start the runtime, so it must not resolve as if it had.
      await expect(starting).rejects.toBeInstanceOf(LifecycleSupersededError);

      expect([...live]).toEqual([]);
      // Not merely "undone afterwards": every module started here is subscriptions and timers to
      // undo, and each of those starts can wedge exactly like this one — on a runtime the stop has
      // already reported STOPPED, and inside a grace period already partly spent.
      expect(startAttempts).toEqual(["publisher"]);
      expect(supervisor.getPhase()).toBe("STOPPED");
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not report READY when the stop overtook the LAST module's start", async () => {
    // The loop's boundary check cannot cover the final module: there is no next iteration. Its start
    // is an await like every other, so the same escape lands there — and the only thing left after
    // it is `transitionTo("READY")`, published over a runtime the stop already reported STOPPED.
    vi.useFakeTimers();
    try {
      let releaseStart!: () => void;
      let live = false;
      const supervisor = new Supervisor({
        modules: [
          [
            "only",
            {
              async start() {
                await new Promise<void>((r) => {
                  releaseStart = r;
                });
                live = true;
              },
              async stop() {
                live = false;
              },
              async healthCheck() {
                return { ok: live };
              },
            },
          ],
        ],
        bus,
        log,
      });

      const starting = supervisor.start();
      const stopping = supervisor.stop();

      await vi.advanceTimersByTimeAsync(LIFECYCLE_STOP_WAIT_MS);
      await stopping;

      releaseStart();
      await expect(starting).rejects.toBeInstanceOf(LifecycleSupersededError);

      expect(live).toBe(false);
      expect(supervisor.getPhase()).toBe("STOPPED");
    } finally {
      vi.useRealTimers();
    }
  });
  it("a losing start does not tear down the modules a newer successful start owns", async () => {
    // The escape does not end the losing start — it only stops anyone waiting for it. Once the stop
    // that escaped settles, a RESTART is free to run and reach READY on the same module INSTANCES.
    // When the parked start finally resumes it holds those same instances in its rollback list, so
    // undoing "its" start would tear down a runtime that is legitimately up: phase READY, modules
    // down. Which start last brought a module up is the only thing that tells the two apart.
    vi.useFakeTimers();
    try {
      const live = new Set<string>();
      const startAttempts: string[] = [];
      let releaseSlowStart!: () => void;
      const slowStart = new Promise<void>((r) => {
        releaseSlowStart = r;
      });

      const makeModule = (name: string, gateFirstCall = false): RuntimeModule => {
        let calls = 0;
        return {
          async start() {
            startAttempts.push(name);
            // Only the FIRST start parks — the restart behind it must be able to complete.
            if (gateFirstCall && ++calls === 1) await slowStart;
            live.add(name);
          },
          async stop() {
            live.delete(name);
          },
          async healthCheck() {
            return { ok: live.has(name) };
          },
        };
      };

      const supervisor = new Supervisor({
        modules: [
          ["publisher", makeModule("publisher", true)],
          ["later", makeModule("later")],
        ],
        bus,
        log,
      });

      const losingStart = supervisor.start();
      const escapingStop = supervisor.stop();
      await vi.advanceTimersByTimeAsync(LIFECYCLE_STOP_WAIT_MS);
      await escapingStop;
      expect(supervisor.getPhase()).toBe("STOPPED");

      // The restart runs because the escaped stop's claim has settled — nothing about the still-live
      // first start blocks it.
      await supervisor.start();
      expect(supervisor.getPhase()).toBe("READY");
      expect([...live].sort()).toEqual(["later", "publisher"]);

      releaseSlowStart();
      await expect(losingStart).rejects.toBeInstanceOf(LifecycleSupersededError);

      // The whole point: the restart's runtime survives the loser's rollback intact.
      expect([...live].sort()).toEqual(["later", "publisher"]);
      expect(supervisor.getPhase()).toBe("READY");
      expect(startAttempts).toEqual(["publisher", "publisher", "later"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a start waits for an in-flight stop of the same module instead of racing it", async () => {
    // Ownership cannot cover this one. It is read BEFORE `mod.stop()` is awaited, and the damage
    // happens INSIDE that await: a real stop clears its state first and releases the resource after
    // (market-data closes its stream past an await). Overtaken there, that stop resumes long after a
    // NEW start re-created the resource and closes the one the live runtime is streaming on —
    // re-reading ownership after the await only reports it, afterwards.
    //
    // The escape is what opens the window: it releases the lifecycle chain's tail to a transition
    // that did nothing, so the queue is idle again while the real teardown is still running inside a
    // module. Serializing per module is what closes it.
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let stream: string | null = null;
      let opened = 0;
      let releaseStop!: () => void;
      const stopGate = new Promise<void>((r) => {
        releaseStop = r;
      });

      const supervisor = new Supervisor({
        modules: [
          [
            "stream",
            {
              async start() {
                events.push("start");
                stream = `stream-${++opened}`;
              },
              async stop() {
                events.push("stop-begin");
                await stopGate;
                // Released AFTER the await, the way a real teardown drops its socket last.
                stream = null;
                events.push("stop-end");
              },
              async healthCheck() {
                return { ok: stream !== null };
              },
            },
          ],
        ],
        bus,
        log,
      });

      await supervisor.start();
      expect(stream).toBe("stream-1");

      const parkedStop = supervisor.stop();
      const escapingStop = supervisor.stop();
      await vi.advanceTimersByTimeAsync(LIFECYCLE_STOP_WAIT_MS);
      await escapingStop;

      // The chain is idle again — but the first stop is still inside the module.
      const restart = supervisor.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events).toEqual(["start", "stop-begin"]);
      expect(supervisor.getPhase()).toBe("INITIALIZING");

      releaseStop();
      await Promise.all([parkedStop, restart]);

      // The restart's stream outlives the stop that was parked across it.
      expect(stream).toBe("stream-2");
      expect(events).toEqual(["start", "stop-begin", "stop-end", "start"]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a start waits for the whole teardown, not just the module the stop already reached", async () => {
    // TWO modules, because one cannot expose this. A start walks the list FORWARD and a stop walks
    // it BACKWARD, so the module the start reaches first is the one the stop reaches LAST — and
    // until the stop gets there it has published nothing about it. With a single module the parked
    // stop is necessarily also the first module the restart meets, which hides the gap entirely.
    //
    // Here the parked teardown is inside `late`, so a per-module wait lets the restart sail straight
    // past `early` and bring it up; the parked stop then continues its reverse walk into `early` and
    // tears down what the restart just started — phase READY over a dead module.
    vi.useFakeTimers();
    try {
      const live = new Set<string>();
      const startAttempts: string[] = [];
      let releaseStop!: () => void;
      const stopGate = new Promise<void>((r) => {
        releaseStop = r;
      });

      const makeModule = (name: string, parkOnStop: boolean): RuntimeModule => ({
        async start() {
          startAttempts.push(name);
          live.add(name);
        },
        async stop() {
          if (parkOnStop) await stopGate;
          live.delete(name);
        },
        async healthCheck() {
          return { ok: live.has(name) };
        },
      });

      const supervisor = new Supervisor({
        modules: [
          ["early", makeModule("early", false)],
          ["late", makeModule("late", true)],
        ],
        bus,
        log,
      });

      await supervisor.start();
      expect(startAttempts).toEqual(["early", "late"]);

      const parkedStop = supervisor.stop();
      const escapingStop = supervisor.stop();
      await vi.advanceTimersByTimeAsync(LIFECYCLE_STOP_WAIT_MS);
      await escapingStop;

      // The lifecycle chain is idle again, but the real teardown is still parked inside `late` and
      // has not yet reached `early`.
      const restart = supervisor.start();
      await vi.advanceTimersByTimeAsync(10_000);

      // Nothing re-started: the restart is holding at the gate, not walking past `early`.
      expect(startAttempts).toEqual(["early", "late"]);
      expect([...live].sort()).toEqual(["early", "late"]);

      releaseStop();
      await Promise.all([parkedStop, restart]);

      // The teardown ran to completion FIRST, then the restart brought both modules back up — so
      // `early` is started exactly once by the restart and survives it.
      expect(startAttempts).toEqual(["early", "late", "early", "late"]);
      expect([...live].sort()).toEqual(["early", "late"]);
      expect(supervisor.getPhase()).toBe("READY");
    } finally {
      vi.useRealTimers();
    }
  });
  it("a module start that REJECTS while superseded reports supersession, not a startup failure", async () => {
    // Every await boundary in the loop is checked — except the rejecting one. A module whose start
    // fails BECAUSE the escaped stop tore its resource away is not a startup failure: reporting it as
    // one forces the phase to ERROR over the winning stop's STOPPED, and hands index.ts a plain
    // error rather than a supersession, so the startup path shuts down a teardown it does not own.
    vi.useFakeTimers();
    try {
      const live = new Set<string>();
      let rejectStart!: (err: Error) => void;
      const gate = new Promise<void>((_resolve, reject) => {
        rejectStart = reject;
      });

      const supervisor = new Supervisor({
        modules: [
          [
            "ok",
            {
              async start() {
                live.add("ok");
              },
              async stop() {
                live.delete("ok");
              },
              async healthCheck() {
                return { ok: live.has("ok") };
              },
            },
          ],
          [
            "rejects",
            {
              async start() {
                await gate;
              },
              async stop() {},
              async healthCheck() {
                return { ok: false };
              },
            },
          ],
        ],
        bus,
        log,
      });

      const losingStart = supervisor.start();
      const escapingStop = supervisor.stop();
      await vi.advanceTimersByTimeAsync(LIFECYCLE_STOP_WAIT_MS);
      await escapingStop;
      expect(supervisor.getPhase()).toBe("STOPPED");

      rejectStart(new Error("resource closed by the concurrent stop"));
      await expect(losingStart).rejects.toBeInstanceOf(LifecycleSupersededError);

      expect(supervisor.getPhase()).toBe("STOPPED");
      expect([...live]).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
