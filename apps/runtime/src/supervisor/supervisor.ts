import type { RuntimeModule, EventBus, RuntimePhase } from "@plankton/domain";
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

  async start(): Promise<void> {
    await this.transitionTo("INITIALIZING");

    const started: Array<[string, RuntimeModule]> = [];

    for (const [name, mod] of this.modules) {
      this.log.info({ module: name }, "starting module");
      try {
        await mod.start();
        started.push([name, mod]);
        this.log.info({ module: name }, "module started");
      } catch (err) {
        this.log.error({ module: name, err }, "module failed to start");

        // Roll back already-started modules in reverse order
        for (const [startedName, startedMod] of [...started].reverse()) {
          this.log.info({ module: startedName }, "rolling back module");
          try {
            await startedMod.stop();
          } catch (stopErr) {
            this.log.error({ module: startedName, err: stopErr }, "rollback stop failed");
          }
        }

        await this.transitionTo("ERROR");
        throw err;
      }
    }

    await this.transitionTo("READY");
  }

  async stop(): Promise<void> {
    if (this.phase === "STOPPED" || this.phase === "SHUTTING_DOWN") return;
    await this.transitionTo("SHUTTING_DOWN");

    for (const [name, mod] of [...this.modules].reverse()) {
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
