import { classifyFetchError } from "@krabs/exchange";
import type { Logger } from "./logger.js";

// Matches the gateway's final transport backoff. Events provide the next attempt;
// this adds no retry loop on top of gateway retries or capture convergence timers.
export const CAPTURE_READ_RETRY_MS = 2_000;

export class CaptureWorkRunner {
  private readonly pending = new Map<string, () => Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private task: Promise<void> | null = null;
  private generation = 0;
  private accepting = false;

  constructor(
    private readonly log: Logger,
    private readonly now: () => number,
    private readonly control?: { isPaused(): boolean; generation?(): number },
  ) {}

  start(): void {
    this.generation++;
    this.accepting = true;
    this.retryAt.clear();
  }

  invalidate(): void {
    this.generation++;
    this.pending.clear();
  }

  discardPending(key: string): void {
    this.pending.delete(key);
  }

  guard(): () => boolean {
    const generation = this.generation;
    const controlGeneration = this.control?.generation?.();
    return () =>
      this.accepting &&
      generation === this.generation &&
      controlGeneration === this.control?.generation?.() &&
      !this.control?.isPaused();
  }

  schedule(key: string, operation: () => Promise<void>): void {
    const current = this.guard();
    if (!current()) return;
    this.pending.set(key, async () => {
      if (current()) await operation();
    });
    if (!this.task) {
      this.task = Promise.resolve()
        .then(() => this.run())
        .finally(() => {
          this.task = null;
          const next = this.pending.entries().next().value;
          if (next) this.schedule(...next);
        });
    }
  }

  private async run(): Promise<void> {
    while (this.pending.size > 0) {
      const [key, operation] = this.pending.entries().next().value!;
      this.pending.delete(key);
      try {
        await operation();
      } catch (err) {
        this.log.error({ err }, "capture work failed; durable state retained");
      }
    }
  }

  async read<T>(key: string, operation: () => Promise<T>): Promise<T | null> {
    const current = this.guard();
    const now = this.now();
    for (const [id, at] of this.retryAt) if (at <= now) this.retryAt.delete(id);
    if (this.retryAt.has(key)) return null;
    try {
      return await operation();
    } catch (err) {
      const classified = classifyFetchError(err);
      const reason =
        classified === "unknown" && err instanceof DOMException && err.name === "TimeoutError"
          ? "timeout"
          : classified;
      if (reason !== "timeout" && reason !== "server" && reason !== "rate_limit") throw err;
      if (!current()) return null;
      this.retryAt.set(key, this.now() + CAPTURE_READ_RETRY_MS);
      this.log.warn({ reason }, "capture transient read deferred");
      return null;
    }
  }

  async drain(): Promise<void> {
    await this.task;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.generation++;
    this.pending.clear();
    await this.drain();
    this.retryAt.clear();
  }
}
