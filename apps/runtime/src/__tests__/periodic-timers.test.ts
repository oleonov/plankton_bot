import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodicTimers } from "../periodic-timers.js";

const makeLog = () => {
  const warn = vi.fn();
  const log = { warn, error: vi.fn(), info: vi.fn(), child: () => log } as any;
  return { log, warn };
};

describe("PeriodicTimers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a throwing tick inside the timer", () => {
    // A timer callback has no handler above it: an escaping throw is an uncaught exception and Node
    // ends the process. These ticks write to SQLite, so SQLITE_BUSY is a routine outcome, not an
    // exotic one — and during teardown the process would die while `shutdown()` is still awaiting.
    const { log, warn } = makeLog();
    const timers = new PeriodicTimers(log);
    let ticks = 0;
    timers.every("exploding", 1_000, () => {
      ticks++;
      throw new Error("SQLITE_BUSY: database is locked");
    });

    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
    expect(ticks).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ timer: "exploding" }),
      "periodic timer tick failed",
    );
  });

  it("stopAll cancels every registered timer in one call", () => {
    // The whole point of the registry: teardown cancels the timers BEFORE its long await, without
    // having to remember each handle at a second, far-away call site.
    const { log } = makeLog();
    const timers = new PeriodicTimers(log);
    let a = 0;
    let b = 0;
    timers.every("a", 1_000, () => a++);
    timers.every("b", 500, () => b++);

    vi.advanceTimersByTime(1_000);
    expect([a, b]).toEqual([1, 2]);

    timers.stopAll();
    vi.advanceTimersByTime(10_000);
    expect([a, b]).toEqual([1, 2]);
  });

  it("returns the handle so the caller still owns the ref decision", () => {
    const { log } = makeLog();
    const timers = new PeriodicTimers(log);
    const handle = timers.every("unreffed", 1_000, () => {});
    expect(typeof handle.unref).toBe("function");
    timers.stopAll();
  });
});
