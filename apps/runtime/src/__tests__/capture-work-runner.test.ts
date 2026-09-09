import { describe, expect, it, vi } from "vitest";
import { CaptureWorkRunner, CAPTURE_READ_RETRY_MS } from "../capture-work-runner.js";
import type { Logger } from "../logger.js";

describe("CaptureWorkRunner", () => {
  it("coalesces per identity, serializes reentrant successors and drains all owned work", async () => {
    const log = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const runner = new CaptureWorkRunner(log, () => 0);
    runner.start();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effects: string[] = [];
    runner.schedule("first", async () => {
      effects.push("read");
      await held;
      runner.schedule("first", async () => {
        effects.push("reentrant");
      });
      effects.push("command-completed");
    });
    await Promise.resolve();
    for (let i = 0; i < 100; i++)
      runner.schedule("market", async () => {
        effects.push(`market:${i}`);
      });
    expect(effects).toEqual(["read"]);
    release();
    await runner.drain();
    expect(effects).toEqual(["read", "command-completed", "market:99", "reentrant"]);
    await runner.stop();
  });

  it("defers classified transport failures without abandoning other identities or spinning", async () => {
    let now = 0;
    const log = { error: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const runner = new CaptureWorkRunner(log, () => now);
    runner.start();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("request timeout", "TimeoutError"))
      .mockResolvedValue("healthy");
    const results: unknown[] = [];
    runner.schedule("a", async () => {
      results.push(await runner.read("a", read));
    });
    runner.schedule("b", async () => {
      results.push("b");
    });
    await runner.drain();
    expect(results).toEqual([null, "b"]);
    expect(await runner.read("a", read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    now += CAPTURE_READ_RETRY_MS;
    expect(await runner.read("a", read)).toBe("healthy");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
    await runner.stop();
  });

  it("invalidates continuations and pending work while awaiting a held task on stop", async () => {
    const runner = new CaptureWorkRunner({ error: vi.fn() } as unknown as Logger, () => 0);
    runner.start();
    const current = runner.guard();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const effects = vi.fn();
    runner.schedule("active", async () => {
      await held;
      if (current()) effects();
    });
    await Promise.resolve();
    runner.schedule("pending", async () => {
      effects();
    });
    let stopped = false;
    const stop = runner.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    runner.start();
    expect(current()).toBe(false);
    expect(effects).not.toHaveBeenCalled();
    await runner.stop();
  });
});
