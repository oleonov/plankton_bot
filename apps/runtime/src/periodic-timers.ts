import type { Logger } from "./logger.js";

/**
 * Registry for the runtime's periodic timers, giving them the two properties a bare `setInterval`
 * in the entrypoint cannot have.
 *
 * A timer callback has no handler above it. Several of these write to SQLite, so a lock the
 * callback loses — `SQLITE_BUSY` once the connection's busy timeout expires — escapes as an
 * uncaught exception and Node terminates the process. During teardown that lands while `shutdown()`
 * is still awaiting the supervisor, so the final metric flush, the shutdown-state publish and
 * `process.exit(0)` never run. Hence both guarantees: every tick is wrapped, and every handle is
 * cancellable in ONE call at the top of teardown instead of after the long await the timers would
 * otherwise keep firing across.
 *
 * `every()` returns the handle so a caller can `.unref()` it; whether a timer holds the event loop
 * open is the caller's decision, cancellation is not.
 */
export class PeriodicTimers {
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  constructor(private readonly log: Logger) {}

  every(name: string, intervalMs: number, tick: () => void): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      try {
        tick();
      } catch (err) {
        this.log.warn({ err, timer: name }, "periodic timer tick failed");
      }
    }, intervalMs);
    this.timers.push(timer);
    return timer;
  }

  stopAll(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }
}

/**
 * What a component needs to schedule a recurring tick. Components that own a periodic timer take
 * this instead of calling `setInterval` themselves, so "is every entrypoint-owned timer wrapped and
 * cancelled at the top of teardown?" is answerable from a signature rather than by grepping for
 * `setInterval` and reasoning about each hit.
 */
export type TimerRegistry = Pick<PeriodicTimers, "every">;
