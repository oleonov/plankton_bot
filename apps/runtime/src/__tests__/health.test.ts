import { describe, it, expect } from "vitest";
import type { RuntimeModule } from "@plankton/domain";
import { collectHealth } from "../supervisor/health.js";

function okModule(): RuntimeModule {
  return {
    async start() {},
    async stop() {},
    async healthCheck() {
      return { ok: true, detail: "running" };
    },
  };
}

function failModule(): RuntimeModule {
  return {
    async start() {},
    async stop() {},
    async healthCheck() {
      throw new Error("check failed");
    },
  };
}

describe("collectHealth", () => {
  it("aggregates module health checks", async () => {
    const modules: Array<[string, RuntimeModule]> = [
      ["a", okModule()],
      ["b", okModule()],
    ];

    const snapshot = await collectHealth("READY", false, modules);

    expect(snapshot.phase).toBe("READY");
    expect(snapshot.paused).toBe(false);
    expect(snapshot.modules.a).toEqual({ ok: true, detail: "running" });
    expect(snapshot.modules.b).toEqual({ ok: true, detail: "running" });
    expect(snapshot.timestamp).toBeGreaterThan(0);
  });

  it("catches thrown healthCheck and reports ok: false", async () => {
    const modules: Array<[string, RuntimeModule]> = [
      ["good", okModule()],
      ["bad", failModule()],
    ];

    const snapshot = await collectHealth("READY", false, modules);

    expect(snapshot.modules.good!.ok).toBe(true);
    expect(snapshot.modules.bad!.ok).toBe(false);
    expect(snapshot.modules.bad!.detail).toBe("healthCheck threw");
  });

  it("reflects paused state", async () => {
    const snapshot = await collectHealth("READY", true, []);
    expect(snapshot.paused).toBe(true);
  });
});
