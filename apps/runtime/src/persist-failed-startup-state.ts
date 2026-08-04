import type { Database } from "better-sqlite3";

/** Structural on purpose: pino's logger satisfies it, and so does the startup gate's narrow one. */
export interface FailedStartupStateLogger {
  error(obj: object, msg: string): void;
}

/**
 * Leave `control.db` in a state a deploy's resume-intent cannot act on, BEFORE a startup abort
 * exits the process.
 *
 * `RuntimeStatePublisher.publishFailed()` only sets the status, so on its own it leaves
 * `paused = 0` — a stale `running, paused=0` row would survive an aborted boot and the next deploy
 * would resume straight onto it. The inner catch is the load-bearing half: an unwritable or locked
 * `control.db` must not replace the error being reported, or the operator ends up debugging a
 * SQLite write failure instead of the abort that actually happened.
 */
export function persistFailedStartupState(
  controlDb: Database,
  log: FailedStartupStateLogger,
  abort: string,
): void {
  try {
    controlDb
      .prepare(
        "UPDATE runtime_control_state SET runtime_status = 'failed', paused = 1, updated_at = datetime('now') WHERE id = 1",
      )
      .run();
  } catch (err) {
    log.error({ err }, `failed to persist failed/paused control state after ${abort}`);
  }
}
