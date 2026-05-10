import { describe, it, expect, beforeEach } from "vitest";
import type { RuntimeModule, RuntimePhase } from "@krabs/domain";
import { InProcessEventBus } from "@krabs/event-bus";
import pino from "pino";
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
});
