/**
 * Execution Queue — bounded concurrency with per-token mutex.
 *
 * Global concurrency cap (default 4) limits parallel gateway calls.
 * Per-token promise-chain mutex ensures at most one in-flight operation
 * per token (prevents conflicting place+cancel on the same token).
 *
 * FIFO ordering. Errors in individual commands do not break the queue.
 */

import type { PlaceOrderCommand, CancelOrderCommand, TokenId } from "@krabs/domain";
import type { Logger } from "../../logger.js";

type Command = PlaceOrderCommand | CancelOrderCommand;
type QueueItem = {
  readonly command: Command;
  readonly resolve?: () => void;
  readonly reject?: (error: unknown) => void;
};

/**
 * One deadline shared by every generation a shutdown awaits — a per-generation timeout would let
 * a stream of successors extend the wait without bound. Cancelling matters because the timer
 * otherwise outlives a fast shutdown and keeps the loop alive for the full timeout.
 */
function withDeadline(ms: number): { expired: Promise<"timeout">; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { expired, cancel: () => clearTimeout(timer) };
}

/**
 * Await generation after generation of in-flight work until nothing is left or the deadline
 * expires, and report whether quiescence was actually REACHED.
 *
 * `inFlight` is ONE generation, not the work that remains: a finishing command's `finally` can
 * start its successor — typically the same-token command its own lock was blocking — which was
 * never in the awaited snapshot. Awaiting the snapshot alone therefore returns while a freshly
 * started command is executing, and the caller then releases that command's deferred idempotency
 * mark and unwinds its reservation out from under it.
 *
 * Shared by the queued and queue-less execution paths: the module without a queue calls the
 * executor directly, and the same interleaving reaches it through a bus handler that dispatches
 * during another command's teardown.
 *
 * Every promise handed in must already be settled-successfully (`.then(noop, noop)`) — a rejection
 * inside `Promise.all` would abandon the wait and report a drain that never happened.
 */
export async function drainGenerations(
  inFlight: ReadonlySet<Promise<void>>,
  timeoutMs: number,
): Promise<boolean> {
  if (inFlight.size === 0) return true;
  const deadline = withDeadline(timeoutMs);
  try {
    while (inFlight.size > 0) {
      const generation = Promise.all([...inFlight]).then(() => "drained" as const);
      if ((await Promise.race([generation, deadline.expired])) === "timeout") break;
    }
  } finally {
    deadline.cancel();
  }
  return inFlight.size === 0;
}

export interface ExecutionQueueConfig {
  maxConcurrency: number;
  shutdownTimeoutMs: number;
  execute: (cmd: Command) => Promise<void>;
  resolveTokenId: (cmd: Command) => TokenId;
  log: Logger;
}

export class ExecutionQueue {
  private readonly queue: QueueItem[] = [];
  private readonly tokenLocks = new Map<string, Promise<void>>();
  private activeCount = 0;
  private accepting = true;
  /** Latched by a completed {@link shutdown}: no command may be promoted out of the queue again. */
  private frozen = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly config: ExecutionQueueConfig) {}

  /** Number of queued commands + in-flight tasks. Zero means fully drained. */
  get pendingCount(): number {
    return this.queue.length + this.inFlight.size;
  }

  get diagnostics(): { queueDepth: number; activeCount: number; maxConcurrency: number } {
    return {
      queueDepth: this.queue.length,
      activeCount: this.activeCount,
      maxConcurrency: this.config.maxConcurrency,
    };
  }

  /** False when the queue refused the command (post-shutdown) — the caller must unwind it. */
  enqueue(cmd: Command): boolean {
    if (!this.accepting) {
      this.config.log.warn({ type: cmd.type }, "queue not accepting — command dropped");
      return false;
    }
    this.queue.push({ command: cmd });
    if (this.queue.length > 100) {
      this.config.log.warn({ depth: this.queue.length }, "execution queue depth exceeds 100");
    }
    this.drain();
    return true;
  }

  /** Recovery-only path: resolves only after this command's executor has fully settled. */
  enqueueAndWait(cmd: Command): Promise<boolean> {
    if (!this.accepting) return Promise.resolve(false);
    return new Promise<boolean>((resolve, reject) => {
      this.queue.push({ command: cmd, resolve: () => resolve(true), reject });
      this.drain();
    });
  }

  /**
   * Re-open after a {@link shutdown}. Without it a restarted module silently drops every
   * command for the life of the process: `accepting` stays false, so `enqueue` refuses and
   * nothing ever reaches the gateway. Anything the shutdown timeout abandoned in the queue
   * is drained now — it was accepted for dispatch and never rejected, so dropping it would
   * strand its reservation and its idempotency mark.
   */
  reopen(): void {
    this.accepting = true;
    this.frozen = false;
    this.drain();
  }

  /**
   * Drain to quiescence, bounded by `shutdownTimeoutMs` (see {@link drainGenerations}).
   *
   * Returns whether quiescence was actually REACHED. The deadline can return with work still
   * running, and a caller that treats the timeout as a clean drain re-creates the very defect the
   * generation loop closes — so the verdict has to be reported, not inferred.
   *
   * Whatever the verdict, NOTHING may start after it. The queue is latched closed here, not merely
   * left non-accepting: `accepting` gates {@link enqueue}, while promotion out of the queue happens
   * in {@link drain}, which the abandoned in-flight command calls from its own `finally` long after
   * this returned. That promotion put a command on the gateway while the module and the supervisor
   * had already reported themselves stopped. {@link reopen} unlatches it on the next start, and the
   * abandoned commands it left queued are drained then.
   */
  async shutdown(): Promise<{ drained: boolean }> {
    this.accepting = false;
    this.drain();
    try {
      if (this.pendingCount === 0) return { drained: true };
      // `inFlight` empty with a non-empty queue means drain() cannot start anything (no free
      // concurrency slot is possible when nothing is running), so there is no generation left to
      // await — the helper exits rather than spins.
      await drainGenerations(this.inFlight, this.config.shutdownTimeoutMs);
      if (this.pendingCount > 0) {
        this.config.log.warn(
          { abandoned: this.queue.length, stillRunning: this.inFlight.size },
          "shutdown timeout — commands abandoned",
        );
        return { drained: false };
      }
      return { drained: true };
    } finally {
      // Latched synchronously, before the verdict reaches the caller, so no `finally`-driven
      // promotion can slip into the gap between the two.
      this.frozen = true;
    }
  }

  /** In-flight tasks only. Deliberately NOT {@link pendingCount}: commands the shutdown deadline
   *  left QUEUED are covered by the latch and will never start, so they are not what a tail drain
   *  is waiting for. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Await the commands {@link shutdown} abandoned at its deadline, without letting anything new
   * start.
   *
   * Safe because the queue is latched: with `frozen` set, {@link drain} is a no-op, so a finishing
   * command's `finally` cannot promote its successor and every generation this awaits is one that
   * was already running. Unlatched, this would put fresh commands on the gateway while the
   * supervisor has already reported the module stopped.
   *
   * `shutdown` normally does the latching; reaching here without it is a wiring mistake, so this
   * latches too. Detecting that case and proceeding anyway would leave in place the exact defect
   * being detected — and its only other symptom is a gateway call nobody expected, long after the
   * module reported itself down. The error line stays because the caller still needs fixing.
   */
  async drainAbandoned(timeoutMs: number): Promise<boolean> {
    if (!this.frozen) {
      // Before the log, and before the first await, so no `finally`-driven promotion can slip in.
      this.frozen = true;
      this.config.log.error(
        { queued: this.queue.length, inFlight: this.inFlight.size },
        "tail drain requested before shutdown latched the queue — latching now, fix the caller",
      );
    }
    return drainGenerations(this.inFlight, timeoutMs);
  }

  private drain(): void {
    if (this.frozen) return;
    let i = 0;
    while (i < this.queue.length && this.activeCount < this.config.maxConcurrency) {
      const item = this.queue[i]!;
      const cmd = item.command;
      const tokenId = String(this.config.resolveTokenId(cmd));

      // Token already has an in-flight operation — skip (don't waste a concurrency slot)
      if (this.tokenLocks.has(tokenId)) {
        i++;
        continue;
      }

      // Remove from queue and execute
      this.queue.splice(i, 1);
      this.activeCount++;

      // Claimed BEFORE the executor is invoked, not after it returns. `execute` reaches a
      // SYNCHRONOUS publish, and a handler on that publish can call shutdown() from inside this very
      // stack frame — at which point the command is already out of `queue` and, with the claim
      // registered afterwards, not yet in `inFlight`. `pendingCount` would read zero, shutdown would
      // report a clean drain over a command that is mid-execution, and its idempotency mark would be
      // bulk-released with the reservation still live: the production defect, re-entered.
      let finished!: () => void;
      const claim = new Promise<void>((resolve) => (finished = resolve));
      this.tokenLocks.set(tokenId, claim);
      this.inFlight.add(claim);

      void this.invokeExecute(cmd)
        .then(item.resolve, (err) => {
          item.reject?.(err);
          this.config.log.error({ err, type: cmd.type }, "queue worker error");
        })
        .finally(() => {
          this.activeCount--;
          this.tokenLocks.delete(tokenId);
          this.inFlight.delete(claim);
          // Resolved after the bookkeeping above so a drain that wakes on it sees the final state,
          // and before `drain()` so the generation loop observes whatever this promotion starts.
          finished();
          this.drain();
        })
        // Nothing awaits this chain any more — the claim is what `drainGenerations` waits on — so a
        // throw from the logger or from `drain()` would surface as an unhandled rejection and take
        // the process down during shutdown.
        .catch((err) => this.config.log.error({ err }, "queue bookkeeping error"));
    }
  }

  /**
   * `activeCount` is incremented before the executor runs, so an executor that throws
   * SYNCHRONOUSLY would escape before the `.catch().finally()` chain is even installed: the slot
   * stays taken, the token stays locked, and the queue quietly loses capacity until it can start
   * nothing at all. Converting the throw into a rejection keeps every failure on the one path that
   * releases the accounting.
   */
  private invokeExecute(cmd: Command): Promise<void> {
    try {
      return this.config.execute(cmd);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
