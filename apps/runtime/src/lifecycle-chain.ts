/**
 * Serializes lifecycle transitions so the LAST caller decides the final state.
 *
 * Joining "the teardown that happens to be running" is not enough. Two interleavings survive it:
 * `start()` → `stop()` lets the start resume AFTER the stop finished and re-open everything the
 * stop just tore down; `stop` → `start` → `stop` lets the start win even though the latest intent
 * was to stop. Both end with a component the supervisor believes is down while its subscriptions
 * are live. Running every transition in call order, one at a time, is what makes the final state
 * match the final call.
 */

/**
 * Bound on how long a transition may WAIT for the ones queued ahead of it — never on the
 * transition's own work.
 *
 * Serializing behind a predecessor introduces a failure mode the unserialized code did not have:
 * a `start()` that never settles (a gateway promise that never resolves) makes every later
 * transition wait forever, so a SIGTERM hangs in `supervisor.stop()`, no module is ever stopped
 * and no database is ever closed. A stop that gives up on the wait can overlap a wedged start —
 * which is strictly better than a process that cannot shut down at all, and only ever happens when
 * something is already broken.
 */
export interface LifecycleWaitLimit {
  readonly ms: number;
  /** Invoked when the ceiling is reached and the transition proceeds anyway. */
  readonly onExpired: () => void;
}

/**
 * Every `stop()` waits at most this long for a transition already in progress.
 *
 * Sized against the container's SIGTERM grace, not against a healthy start: a wait that can outlast
 * the grace window is indistinguishable from no escape at all, because SIGKILL arrives first. It is
 * one term of the shutdown budget `docker-compose.yml`'s `stop_grace_period` is derived from — that
 * comment carries the full arithmetic, and neither number may be raised without redoing it.
 */
export const LIFECYCLE_STOP_WAIT_MS = 5_000;

/**
 * Hard ceiling on the WHOLE module teardown, applied by the runtime's signal handler.
 *
 * The per-module ceilings bound each individual wait, but the shutdown is a SEQUENCE of them: with
 * two dozen modules, "every wait is bounded" does not make their sum bounded, and a single stalled
 * stop pushes the total past the container's grace period — at which point SIGKILL lands before any
 * database is closed, which is the exact outcome every one of those ceilings exists to prevent.
 * One ceiling over the whole sequence is what actually makes the budget true. Walking away is
 * strictly better than being killed: the modules left running are killed by `process.exit` moments
 * later either way, the difference is that this path closes the ledger first.
 */
export const RUNTIME_STOP_WAIT_MS = 40_000;

/**
 * A transition that never ran because a later one already did.
 *
 * A dropped `start()` that RESOLVES tells its caller the runtime is up when no module was started —
 * `Supervisor.start()` would return normally with the phase left at `STOPPED`. The drop is a real
 * failure of that call, so it must be reported as one; a log line is not a result.
 */
export class LifecycleSupersededError extends Error {
  constructor(what: string) {
    super(`${what} superseded by a later lifecycle transition`);
    this.name = "LifecycleSupersededError";
  }
}

/**
 * Handed to a transition so work ALREADY IN FLIGHT can notice it lost.
 *
 * Dropping queued transitions is not enough on its own: a `start()` that is already past its first
 * await keeps running after a `stop()` gives up waiting for it, and re-installs timers and
 * subscriptions on modules the stop has already walked past. Only the transition itself can undo
 * that, and only if it is told — so every start checks this at its await boundaries.
 */
export interface LifecycleToken {
  /** True once a LATER transition gave up waiting for this one and proceeded without it. */
  readonly superseded: boolean;
}

/**
 * Wait for `promise` to settle, but for at most `limit.ms` — then report it and proceed anyway.
 *
 * Never rejects. Every caller is on a teardown path, where a failure in the thing being waited for
 * must not cancel the teardown itself: the point of the wait is to be polite about work already in
 * flight, and politeness that can abort a shutdown is worse than no wait at all.
 */
export function waitAtMost(promise: Promise<unknown>, limit: LifecycleWaitLimit): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      limit.onExpired();
      resolve();
    }, limit.ms);
    // A shutdown escape hatch must not itself keep the process alive.
    if (typeof timer.unref === "function") timer.unref();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    void promise.then(done, done);
  });
}

export class LifecycleChain {
  /** Null means idle — nothing to queue behind, so the next transition can start immediately. */
  private tail: Promise<void> | null = null;
  private seq = 0;
  /**
   * Sequence of the last transition that proceeded WITHOUT its predecessor settling. Anything still
   * QUEUED at that moment is older intent than the one that escaped, so it must not run afterwards.
   */
  private escapedSeq = 0;

  /**
   * @param onSuperseded reports a transition dropped because a later one already ran. It is a
   * silent no-op by default only because the chain has no logger of its own; every real caller
   * passes one, since a dropped `start()` resolves as if it had succeeded.
   */
  constructor(private readonly onSuperseded: () => void = () => undefined) {}

  run(
    transition: (token: LifecycleToken) => Promise<void>,
    waitLimit?: LifecycleWaitLimit,
  ): Promise<void> {
    const seq = ++this.seq;
    const predecessor = this.tail;
    // Read live, never snapshotted: the escape that supersedes this transition usually happens
    // WHILE it runs, which is the only case a queued-only check cannot catch.
    const isSuperseded = (): boolean => this.escapedSeq > seq;
    const token: LifecycleToken = {
      get superseded(): boolean {
        return isSuperseded();
      },
    };
    // The chain is claimed BEFORE the transition is invoked, not after it settles. The event bus
    // dispatches handlers SYNCHRONOUSLY, so a transition that publishes an event can be re-entered
    // from inside its own first statements — `Supervisor.start()` publishes INITIALIZING, and a
    // handler that calls `stop()` runs before `start()` has yielded even once. Assigning the tail
    // afterwards leaves that re-entrant call looking at an idle chain, and the two transitions run
    // concurrently: exactly the case this class exists to serialize.
    let release!: () => void;
    const claim = new Promise<void>((resolve) => (release = resolve));
    this.tail = claim;

    // An idle chain starts the transition SYNCHRONOUSLY. Deferring it by even one microtask
    // changes observable behaviour: a `stop()` latches the queue closed in its first synchronous
    // statements, and a command admitted in that gap would reach a queue still accepting.
    const next =
      predecessor === null
        ? invoke(transition, token)
        : awaitPredecessor(predecessor, waitLimit, () => {
            this.escapedSeq = seq;
          }).then(() => {
            // A LATER transition gave up waiting and already ran. This one never started, so it is
            // stale intent: running it now applies an older decision on top of a newer one. That is
            // `stop A → start B → stop C` with C's ceiling expiring — B would subscribe AFTER C
            // unsubscribed, leaving live handlers on a module the supervisor reports as stopped.
            if (isSuperseded()) {
              this.onSuperseded();
              // Rejected, not resolved: nothing ran, and the caller must not read that as success.
              return Promise.reject(new LifecycleSupersededError("queued lifecycle transition"));
            }
            return invoke(transition, token);
          });

    // Settled successfully either way so one rejection cannot poison every later transition; the
    // returned promise still rejects for the caller that asked for THIS one.
    void next
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        release();
        // Only if nothing queued behind it in the meantime — otherwise the chain is still busy.
        if (this.tail === claim) this.tail = null;
      });
    return next;
  }
}

/** A synchronous throw would leave the chain's tail unset; keep every failure on the promise path. */
function invoke(
  transition: (token: LifecycleToken) => Promise<void>,
  token: LifecycleToken,
): Promise<void> {
  try {
    return transition(token);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Never rejects — a predecessor that failed must not cancel the transition queued behind it. */
function awaitPredecessor(
  predecessor: Promise<void>,
  waitLimit: LifecycleWaitLimit | undefined,
  onEscape: () => void,
): Promise<void> {
  if (waitLimit == null) return predecessor;
  return waitAtMost(predecessor, {
    ms: waitLimit.ms,
    onExpired: () => {
      // Recorded BEFORE the transition proceeds, so anything still queued behind the wedged
      // predecessor is already marked stale by the time it gets its turn.
      onEscape();
      waitLimit.onExpired();
    },
  });
}
