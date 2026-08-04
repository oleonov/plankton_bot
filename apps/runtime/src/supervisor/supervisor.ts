import type { RuntimeModule, EventBus, RuntimePhase } from "@krabs/domain";
import {
  LifecycleChain,
  LifecycleSupersededError,
  LIFECYCLE_STOP_WAIT_MS,
  type LifecycleToken,
} from "../lifecycle-chain.js";
import type { Logger } from "../logger.js";

export interface SupervisorConfig {
  /** Ordered list of [name, module] pairs -- started in order, stopped in reverse. */
  modules: Array<[string, RuntimeModule]>;
  bus: EventBus;
  log: Logger;
  /** Shutdown timeout in ms for bus drain. Default: 10_000. */
  shutdownTimeoutMs?: number;
}

export class Supervisor {
  private phase: RuntimePhase = "INITIALIZING";
  private readonly modules: Array<[string, RuntimeModule]>;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private readonly shutdownTimeoutMs: number;
  private paused = false;
  /**
   * A start walks the module list forward while a stop walks it backward. Overlapped, they
   * interleave into a runtime that is half up and half down — e.g. `phase: "STOPPED"` while
   * market-data streams and timers a concurrent start re-created are still live. Per-module
   * guards cannot fix that: the mixed state is a property of the ORDER, not of any one module.
   */
  private readonly lifecycle = new LifecycleChain(() =>
    this.log.error(
      { phase: this.phase },
      "lifecycle transition superseded by a later one — dropped",
    ),
  );
  /**
   * Which start brought each module up, so a LOSING start never tears down a WINNER's modules.
   *
   * A start that a stop overtook can still be alive after that stop finished and a fresh start
   * succeeded: `start S1 → stop S2 escapes → start S3 reaches READY → S1 resumes`. S1's rollback
   * holds the same module INSTANCES S3 just restarted, so undoing "its" start would stop a runtime
   * that is legitimately up — phase `READY`, subscriptions gone. Identity is not enough to tell the
   * two apart, only WHICH start last brought the module up is.
   */
  private startGeneration = 0;
  private readonly moduleOwner = new Map<string, number>();
  /**
   * The teardown RUN in flight, so a START waits out the WHOLE of it before touching any module.
   *
   * Ownership alone cannot cover this: it is read BEFORE `mod.stop()` is awaited, and the damage
   * happens INSIDE that await. A stop that parks partway through — clearing state first, releasing
   * the resource after — can be overtaken by the winning stop and then by a whole new start, and
   * resume to release a resource the NEW generation created: `market-data` closing the stream the
   * current READY runtime is streaming on.
   *
   * Per-MODULE waiting cannot cover it either, and the asymmetry of the two traversals is why: a
   * start walks the list FORWARD while a stop walks it BACKWARD, so at every instant the stop has
   * published nothing for the modules the start reaches first. With order `A, B` a stop parked
   * inside `B.stop()` has registered nothing for A, a start sails past A and brings it up, and the
   * parked stop then resumes into A and tears it straight back down — READY reported over a dead
   * module. The traversals overlap by construction; only a whole-run gate closes it.
   *
   * Two teardowns can be in flight at once — a losing start's rollback and the winning stop hold the
   * same module instances — so the entry CHAINS rather than replaces, and is built from settled
   * results because a module that throws on stop must not make every later start reject. Reset to
   * null once settled, so the chain cannot grow across a long-lived process's restarts.
   *
   * Deliberately one-directional. A stop NEVER waits on a start — that asymmetry is exactly what
   * lets a shutdown escape a start parked in a module — but a start always waits on a stop, because
   * a module that is still stopping has nothing to start on top of.
   */
  private stopRun: Promise<void> | null = null;

  constructor(config: SupervisorConfig) {
    this.modules = config.modules;
    this.bus = config.bus;
    this.log = config.log.child({ component: "supervisor" });
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 10_000;
  }

  getPhase(): RuntimePhase {
    return this.phase;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.log.info({ paused }, "runtime pause state changed");
  }

  start(): Promise<void> {
    return this.lifecycle.run((token) => this.executeStart(token));
  }

  private async executeStart(token: LifecycleToken): Promise<void> {
    const generation = ++this.startGeneration;
    await this.transitionTo("INITIALIZING");

    // Once, before the FIRST module — not per module. A teardown still walking the list has nothing
    // this start can build on top of, and this is the only point at which the two traversals are
    // guaranteed not to overlap: nothing is started yet, so there is no module the parked stop can
    // still resume into. See `stopRun` for why waiting per module cannot achieve that.
    await this.stopRun;

    const started: Array<[string, RuntimeModule]> = [];

    for (const [name, mod] of this.modules) {
      // Checked at every await boundary, not once at the top. A `stop()` that gave up waiting for
      // this start walks the module list backwards WHILE the start walks it forwards: the modules
      // it already passed are down, and every module this loop starts from here on is one the stop
      // will never revisit — a runtime reported STOPPED with live timers and subscriptions.
      if (token.superseded) await this.abortSupersededStart(started, generation);
      this.log.info({ module: name }, "starting module");
      try {
        await mod.start();
        // Claimed only when nobody NEWER holds it. A start that lost the race still has to be able
        // to undo what it just brought up when the module is unowned — that is what the rollback
        // below is for — but it must not take a module a later start already owns, or that rollback
        // would tear down a runtime that is legitimately READY.
        const owner = this.moduleOwner.get(name);
        if (owner === undefined || owner === generation) this.moduleOwner.set(name, generation);
        started.push([name, mod]);
        this.log.info({ module: name }, "module started");
      } catch (err) {
        this.log.error({ module: name, err }, "module failed to start");
        // A rejection is an await boundary like any other. Without this check a module whose start
        // fails BECAUSE the escaped stop tore its resource out from under it is reported as an
        // ordinary startup failure: the phase is forced to ERROR over the winning stop's STOPPED,
        // and the caller in index.ts sees a plain error rather than a supersession, closing down a
        // shutdown it does not own.
        if (token.superseded) await this.abortSupersededStart(started, generation);
        await this.rollback(started, generation);
        await this.transitionTo("ERROR");
        throw err;
      }
    }

    // The last module's start is an await too, and READY over a STOPPED phase is the same lie.
    if (token.superseded) await this.abortSupersededStart(started, generation);

    await this.transitionTo("READY");
  }

  /**
   * Undo a start that a later `stop()` overtook.
   *
   * The stop cannot do this itself: it already walked past these modules, and the one that was
   * mid-`start()` when the stop gave up had nothing to tear down at the time. Rolling back here
   * covers exactly that gap. The phase is deliberately left as the stop set it — this start lost,
   * so it does not get to decide the runtime's phase, not even to ERROR.
   */
  private async abortSupersededStart(
    started: Array<[string, RuntimeModule]>,
    generation: number,
  ): Promise<never> {
    this.log.error(
      { phase: this.phase, startedModules: started.length },
      "start superseded by a stop that gave up waiting — undoing the modules it started",
    );
    await this.rollback(started, generation);
    throw new LifecycleSupersededError("supervisor start");
  }

  /**
   * Stop, in reverse order, the modules a failed or superseded start had already brought up — and
   * ONLY those it still owns. A module whose ownership moved on was either already stopped by the
   * winning stop or re-started by a newer one; in both cases stopping it here undoes someone else's
   * correct work.
   */
  private rollback(started: Array<[string, RuntimeModule]>, generation: number): Promise<void> {
    return this.trackStopRun(this.executeRollback(started, generation));
  }

  private async executeRollback(
    started: Array<[string, RuntimeModule]>,
    generation: number,
  ): Promise<void> {
    for (const [name, mod] of [...started].reverse()) {
      if (this.moduleOwner.get(name) !== generation) {
        this.log.warn({ module: name }, "rollback skipped — module no longer owned by this start");
        continue;
      }
      this.moduleOwner.delete(name);
      this.log.info({ module: name }, "rolling back module");
      try {
        await mod.stop();
      } catch (err) {
        this.log.error({ module: name, err }, "rollback stop failed");
      }
    }
  }

  /**
   * Publish a teardown as the in-flight stop run.
   *
   * Called with the run's promise BEFORE the callee's first await can yield, so there is no window
   * in which a teardown is walking the module list but is invisible to `executeStart`.
   */
  private trackStopRun(run: Promise<void>): Promise<void> {
    const chained = Promise.allSettled([this.stopRun, run]).then(() => undefined);
    this.stopRun = chained;
    void chained.then(() => {
      // Only when nothing chained onto it in the meantime — otherwise a teardown is still running.
      if (this.stopRun === chained) this.stopRun = null;
    });
    return run;
  }

  stop(): Promise<void> {
    return this.lifecycle.run(() => this.trackStopRun(this.executeStop()), {
      ms: LIFECYCLE_STOP_WAIT_MS,
      onExpired: () =>
        this.log.error(
          { waitMs: LIFECYCLE_STOP_WAIT_MS, phase: this.phase },
          "lifecycle transition never settled — stopping anyway",
        ),
    });
  }

  private async executeStop(): Promise<void> {
    // Read INSIDE the serialized transition: a stop queued behind a start would otherwise decide
    // on the phase as it was when the call was made, not as it is when the stop actually runs.
    if (this.phase === "STOPPED" || this.phase === "SHUTTING_DOWN") return;
    await this.transitionTo("SHUTTING_DOWN");

    for (const [name, mod] of [...this.modules].reverse()) {
      // Released as this walk reaches the module, not in bulk afterwards: an overlapping start is
      // claiming modules forward while this loop releases them backward, and a bulk clear at the end
      // would also drop claims that start made after this loop had already passed them by.
      this.moduleOwner.delete(name);
      this.log.info({ module: name }, "stopping module");
      try {
        await mod.stop();
        this.log.info({ module: name }, "module stopped");
      } catch (err) {
        this.log.error({ module: name, err }, "module failed to stop");
      }
    }

    // Drain any inflight handlers from module stops
    this.log.info("draining event bus (pre-STOPPED)");
    try {
      await this.bus.drain(this.shutdownTimeoutMs);
    } catch (err) {
      this.log.warn({ err }, "event bus drain timed out (pre-STOPPED)");
    }

    // Publish STOPPED, then drain again so STOPPED handlers can complete
    await this.transitionTo("STOPPED");

    try {
      await this.bus.drain(this.shutdownTimeoutMs);
    } catch (err) {
      this.log.warn({ err }, "event bus drain timed out (post-STOPPED)");
    }
  }

  private async transitionTo(phase: RuntimePhase): Promise<void> {
    const prev = this.phase;
    this.phase = phase;
    this.log.info({ from: prev, to: phase }, "phase transition");
    await this.bus.publish("RuntimePhaseChanged", {
      phase,
      timestamp: Date.now(),
    });
  }
}
