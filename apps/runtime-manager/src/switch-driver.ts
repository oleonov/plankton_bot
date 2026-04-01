import type { SwitchRequest } from "@plankton/domain";
import type {
  SwitchRequestRepository,
  RuntimeControlStateRepository,
  StateTransitionRepository,
} from "@plankton/domain";
import { SwitchState } from "@plankton/domain";
import type Database from "better-sqlite3";
import type { ContainerControl } from "./container-control.js";

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

const MAX_TRANSIENT_ERRORS = 10;

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("EACCES") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("socket hang up") ||
    msg.includes("connect EHOSTUNREACH")
  );
}

/**
 * Drives the profile-switch state machine one transition per tick().
 * Each handler is idempotent so crash recovery works via normal ticking.
 * Transient Docker/proxy errors are retried up to MAX_TRANSIENT_ERRORS
 * before permanently failing the switch.
 */
export class SwitchDriver {
  private transientErrorCount = 0;

  constructor(
    private readonly db: Database.Database,
    private readonly switchRepo: SwitchRequestRepository,
    private readonly controlRepo: RuntimeControlStateRepository,
    private readonly transitionRepo: StateTransitionRepository,
    private readonly container: ContainerControl,
    private readonly restartTimeoutS: number,
    private readonly log: Logger,
  ) {}

  async tick(): Promise<void> {
    const request = this.switchRepo.findActive();
    if (!request) return;

    try {
      await this.advance(request);
      this.transientErrorCount = 0; // reset on success
    } catch (err) {
      if (isTransientError(err) && this.transientErrorCount < MAX_TRANSIENT_ERRORS) {
        this.transientErrorCount++;
        this.log.warn(
          {
            switchId: request.switchId,
            state: request.state,
            attempt: this.transientErrorCount,
            err,
          },
          "transient Docker/proxy error, will retry",
        );
        return; // don't fail — retry on next tick
      }

      this.log.error(
        {
          switchId: request.switchId,
          state: request.state,
          transientAttempts: this.transientErrorCount,
          err,
        },
        "switch tick failed permanently",
      );
      this.transientErrorCount = 0;
      this.transitionTo(request.switchId, request.state, SwitchState.Failed);
      this.switchRepo.updateState(
        request.switchId,
        SwitchState.Failed,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** On startup, log any in-flight switch. Normal tick() handles recovery. */
  recover(): void {
    const request = this.switchRepo.findActive();
    if (request) {
      this.log.info(
        { switchId: request.switchId, state: request.state },
        "recovering in-flight switch",
      );
    }
  }

  private async advance(request: SwitchRequest): Promise<void> {
    switch (request.state) {
      case SwitchState.Requested:
        return this.toPausing(request);
      case SwitchState.Pausing:
        return this.toStopping(request);
      case SwitchState.Stopping:
        return this.toPreparing(request);
      case SwitchState.PreparingTarget:
        return this.toStarting(request);
      case SwitchState.StartingTarget:
        return this.toReadyPaused(request);
      case SwitchState.ReadyPaused:
        return this.toCompleted(request);
    }
  }

  // ── State handlers (each idempotent) ──────────────────────────────────

  private toPausing(req: SwitchRequest): void {
    this.db
      .prepare(
        `INSERT INTO operator_commands (action, reason, scope, initiator_type, initiator, status, created_at)
         VALUES ('pause', 'profile switch', 'global', 'runtime_manager', ?, 'pending', datetime('now'))`,
      )
      .run(req.switchId);
    this.transitionAndUpdate(req, SwitchState.Pausing);
  }

  private async toStopping(req: SwitchRequest): Promise<void> {
    const state = this.controlRepo.get();
    if (!state?.paused) return; // wait for runtime to pause

    // Wait for drain: check heartbeat for drain_complete or execution_idle status
    const heartbeat = this.db
      .prepare(
        "SELECT status_json FROM service_heartbeats WHERE service_name = 'runtime' ORDER BY last_heartbeat_at DESC LIMIT 1",
      )
      .get() as { status_json: string | null } | undefined;
    if (heartbeat?.status_json) {
      try {
        const status = JSON.parse(heartbeat.status_json);
        // If runtime is still draining (has in-flight work), wait
        if (status.executionQueueSize > 0 || status.inFlightTasks > 0) return;
      } catch {
        // Malformed JSON — proceed (conservative: don't block forever)
      }
    }

    await this.container.stop(this.restartTimeoutS);
    this.transitionAndUpdate(req, SwitchState.Stopping);
  }

  private async toPreparing(req: SwitchRequest): Promise<void> {
    if (await this.container.isRunning()) return; // wait for container to stop

    this.db
      .prepare(
        "UPDATE runtime_control_state SET desired_profile = ?, updated_at = datetime('now') WHERE id = 1",
      )
      .run(req.toProfile);
    this.transitionAndUpdate(req, SwitchState.PreparingTarget);
  }

  private async toStarting(req: SwitchRequest): Promise<void> {
    await this.container.start();
    this.transitionAndUpdate(req, SwitchState.StartingTarget);
  }

  private async toReadyPaused(req: SwitchRequest): Promise<void> {
    const state = this.controlRepo.get();

    // Detect failed preflight — runtime publishes 'failed' status and exits
    if (state?.runtimeStatus === "failed") {
      this.log.warn({ switchId: req.switchId }, "runtime preflight failed during switch");
      this.transitionTo(req.switchId, req.state, SwitchState.Failed);
      this.switchRepo.updateState(
        req.switchId,
        SwitchState.Failed,
        "runtime startup preflight failed",
      );
      return;
    }

    // Detect dead container (runtime exited without publishing any state)
    if (!(await this.container.isRunning()) && state?.runtimeStatus !== "ready_paused") {
      this.log.warn({ switchId: req.switchId }, "runtime container died during startup");
      this.transitionTo(req.switchId, req.state, SwitchState.Failed);
      this.switchRepo.updateState(
        req.switchId,
        SwitchState.Failed,
        "runtime container exited during startup",
      );
      return;
    }

    if (state?.runtimeStatus !== "ready_paused") return; // wait for startup

    // Verify fresh heartbeat matches current run/instance (spec Section 4.2)
    if (state.currentRunId && state.currentInstanceId) {
      const heartbeat = this.db
        .prepare(
          "SELECT run_id, instance_id FROM service_heartbeats WHERE service_name = 'runtime' AND instance_id = ? LIMIT 1",
        )
        .get(state.currentInstanceId) as { run_id: string; instance_id: string } | undefined;

      if (!heartbeat || heartbeat.run_id !== state.currentRunId) return; // stale state, wait for fresh heartbeat
    }

    this.transitionAndUpdate(req, SwitchState.ReadyPaused);
  }

  private toCompleted(req: SwitchRequest): void {
    this.transitionTo(req.switchId, SwitchState.ReadyPaused, SwitchState.Completed);
    this.switchRepo.updateState(req.switchId, SwitchState.Completed);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private transitionAndUpdate(
    req: SwitchRequest,
    newState:
      | typeof SwitchState.Pausing
      | typeof SwitchState.Stopping
      | typeof SwitchState.PreparingTarget
      | typeof SwitchState.StartingTarget
      | typeof SwitchState.ReadyPaused,
  ): void {
    this.transitionTo(req.switchId, req.state, newState);
    this.switchRepo.updateState(req.switchId, newState);
    this.log.info(
      { switchId: req.switchId, from: req.state, to: newState },
      "switch state transition",
    );
  }

  private transitionTo(switchId: string, from: string, to: string): void {
    this.transitionRepo.insert({
      entityType: "switch_request",
      entityId: switchId,
      fromState: from,
      toState: to,
      triggerType: "runtime_manager",
      initiator: "runtime_manager",
      reason: `profile switch: ${from} -> ${to}`,
      scoresSnapshot: null,
    });
  }
}
