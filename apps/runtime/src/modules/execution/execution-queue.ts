/**
 * Execution Queue — bounded concurrency with per-token mutex.
 *
 * Global concurrency cap (default 4) limits parallel gateway calls.
 * Per-token promise-chain mutex ensures at most one in-flight operation
 * per token (prevents conflicting place+cancel on the same token).
 *
 * FIFO ordering. Errors in individual commands do not break the queue.
 */

import type { PlaceOrderCommand, CancelOrderCommand, TokenId } from "@plankton/domain";
import type { Logger } from "../../logger.js";

type Command = PlaceOrderCommand | CancelOrderCommand;

export interface ExecutionQueueConfig {
  maxConcurrency: number;
  shutdownTimeoutMs: number;
  execute: (cmd: Command) => Promise<void>;
  resolveTokenId: (cmd: Command) => TokenId;
  log: Logger;
}

export class ExecutionQueue {
  private readonly queue: Command[] = [];
  private readonly tokenLocks = new Map<string, Promise<void>>();
  private activeCount = 0;
  private accepting = true;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly config: ExecutionQueueConfig) {}

  enqueue(cmd: Command): void {
    if (!this.accepting) {
      this.config.log.warn({ type: cmd.type }, "queue not accepting — command dropped");
      return;
    }
    this.queue.push(cmd);
    if (this.queue.length > 100) {
      this.config.log.warn({ depth: this.queue.length }, "execution queue depth exceeds 100");
    }
    this.drain();
  }

  async shutdown(): Promise<void> {
    this.accepting = false;

    // Drain remaining queue items
    this.drain();

    // Wait for all in-flight with timeout
    if (this.inFlight.size > 0 || this.queue.length > 0) {
      const allDone = Promise.all([...this.inFlight]);
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, this.config.shutdownTimeoutMs),
      );
      await Promise.race([allDone, timeout]);

      if (this.queue.length > 0) {
        this.config.log.warn(
          { abandoned: this.queue.length },
          "shutdown timeout — commands abandoned",
        );
      }
    }
  }

  private drain(): void {
    let i = 0;
    while (i < this.queue.length && this.activeCount < this.config.maxConcurrency) {
      const cmd = this.queue[i]!;
      const tokenId = String(this.config.resolveTokenId(cmd));

      // Token already has an in-flight operation — skip (don't waste a concurrency slot)
      if (this.tokenLocks.has(tokenId)) {
        i++;
        continue;
      }

      // Remove from queue and execute
      this.queue.splice(i, 1);
      this.activeCount++;

      const promise = this.config
        .execute(cmd)
        .catch((err) => this.config.log.error({ err, type: cmd.type }, "queue worker error"))
        .finally(() => {
          this.activeCount--;
          this.tokenLocks.delete(tokenId);
          this.inFlight.delete(promise);
          this.drain();
        });

      this.tokenLocks.set(tokenId, promise);
      this.inFlight.add(promise);
    }
  }
}
