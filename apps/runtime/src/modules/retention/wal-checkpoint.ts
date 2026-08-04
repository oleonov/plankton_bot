import { Worker } from "node:worker_threads";

/** Shape of the `wal_checkpoint` pragma's own result row. */
export interface CheckpointResult {
  busy?: number;
  log?: number;
  checkpointed?: number;
}

export interface WalCheckpointOutcome {
  result: CheckpointResult | null;
  error: string | null;
  /**
   * True only when the deadline expired and this outcome was produced for a worker that is STILL
   * RUNNING. Every other path — message, error, exit — means the thread reported and is on its way
   * out with its connection already closed (the worker closes before it posts), so nothing is left
   * to wait for. Distinguishing the two matters: treating a worker that answered as abandoned makes
   * the next scheduled attempt skip itself for no reason.
   */
  abandoned: boolean;
  /**
   * Resolves when the worker thread has actually exited — which on the normal path is LATER than the
   * outcome the caller already holds, because the worker posts its verdict and only then runs off
   * the end of its script. What makes that safe is not the exit but the ORDER inside the worker: it
   * closes its connection BEFORE it posts, so by the time a verdict exists there is no second reader
   * left on the ledger, whatever the thread's own bookkeeping is still doing.
   *
   * After a timeout that ordering has not happened yet, and this becomes the ONLY handle on a thread
   * still holding an open connection. A caller that starts the next checkpoint while this is pending
   * adds a second reader to a file the first one is already failing to reclaim.
   *
   * Resolves with the thread's OWN exit code, and that code is the only thing that distinguishes
   * abandoning a wedged worker from terminating it: an abandoned one finishes its pragma, posts its
   * verdict, closes and exits `0`, while `terminate()` posts nothing and exits `1`. Every other
   * observable — the outcome object, the WAL bytes, even how long the exit takes — is identical
   * between the two, because sqlite truncates inside the native call before a termination can land.
   * `null` means no thread was ever created (the constructor itself threw).
   */
  workerExit: Promise<number | null>;
}

/**
 * The worker entry point sits next to this file in both layouts — `<runtime>/src/modules/retention/`
 * under tsx/vitest and `<runtime>/dist/modules/retention/` in production — so the extension of THIS
 * module's own URL is the reliable way to pick the sibling that actually exists. Hardcoding `.js`
 * breaks every test run; hardcoding `.ts` breaks production.
 */
function workerEntryUrl(): URL {
  const suffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./wal-checkpoint-worker${suffix}`, import.meta.url);
}

/**
 * Run a WAL checkpoint in a worker thread and resolve with the pragma's own verdict, or null when
 * the worker could not produce one. Never rejects: a checkpoint is pure maintenance, and the caller
 * decides what a missing verdict means (it treats it exactly like `busy`, i.e. not truncated, retry
 * next pass).
 *
 * `timeoutMs` bounds the WAIT, not the work. Without it a worker wedged on an unresponsive
 * filesystem never posts, never errors and never exits, and the retention pass awaiting it stays
 * in-flight forever — which makes `stop()` hang forever too, because it awaits that pass. So the
 * outcome is resolved on the deadline and the caller stops being hostage to the thread.
 *
 * The thread itself is then ABANDONED, never terminated. `terminate()` cannot interrupt a
 * synchronous native call — the only state a wedged checkpoint is ever in — so it buys nothing, and
 * what it costs was measured rather than assumed: a terminated worker posts NO verdict and exits 1
 * with its connection never closed, while an abandoned one finishes its pragma, reports
 * `{busy: 1, …}`, closes and exits 0. Neither aborts the process here, because `wal_checkpoint`
 * reports contention as a result ROW rather than throwing — so this is not the decision-persistence
 * crash, where the SQLITE_BUSY THROW forced better-sqlite3 to allocate a JS Error inside a
 * terminating isolate and `ToLocalChecked()` took the process down. That throw path is still
 * reachable from here under a real I/O failure — disk-full being exactly the condition that makes
 * a checkpoint urgent — which is the second reason not to leave a terminating isolate lying in it.
 * `unref` is what keeps the abandoned thread from holding the process open in the meantime.
 */
export function runWalCheckpointOffThread(
  dbPath: string,
  busyTimeoutMs: number,
  timeoutMs: number,
): Promise<WalCheckpointOutcome> {
  return new Promise((resolve) => {
    let exited!: (code: number | null) => void;
    const workerExit = new Promise<number | null>((r) => (exited = r));

    let settled = false;
    const settle = (
      result: CheckpointResult | null,
      error: string | null,
      abandoned = false,
    ): void => {
      if (settled) return;
      settled = true;
      resolve({ result, error, abandoned, workerExit });
    };

    let worker: Worker;
    try {
      worker = new Worker(workerEntryUrl(), { workerData: { dbPath, busyTimeoutMs } });
    } catch (err) {
      exited(null);
      settle(null, err instanceof Error ? err.message : String(err));
      return;
    }

    const deadline = setTimeout(() => {
      settle(null, `checkpoint worker did not finish within ${timeoutMs}ms`, true);
      worker.unref();
    }, timeoutMs);
    // The runtime must not be held open by a maintenance timer that has nothing to report yet.
    if (typeof deadline.unref === "function") deadline.unref();

    worker.on(
      "message",
      (msg: { ok: boolean; result?: CheckpointResult | null; error?: string }) => {
        clearTimeout(deadline);
        if (msg.ok) settle(msg.result ?? null, null);
        else settle(null, msg.error ?? "checkpoint worker reported failure");
      },
    );
    worker.on("error", (err: Error) => {
      clearTimeout(deadline);
      settle(null, err.message);
    });
    // A worker that exits without a message produced no verdict — resolve rather than hang the
    // retention pass forever. `settle` is idempotent, so the normal exit-after-message is a no-op.
    worker.on("exit", (code: number) => {
      clearTimeout(deadline);
      exited(code);
      settle(null, `checkpoint worker exited with code ${code}`);
    });
  });
}
