import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  parseExecutionPolicyJson,
  serializeExecutionPolicy,
  type ExecutionPolicy,
  type OperatorCommand,
} from "@krabs/domain";
import { readExecutionPolicyVersion } from "@krabs/db";

type Deps = {
  controlDb: Database.Database;
  ledgerDb: Database.Database;
  profileId: string;
  inFlightMakerBuys: () => number;
  now?: () => number;
  activationId?: () => string;
};
type Result =
  | { status: "applied"; activationId: string; completedAt: string }
  | { status: "rejected"; reason: string };
type FenceResult =
  | { status: "fenced"; activationId: string }
  | { status: "pending"; reason: string }
  | { status: "rejected"; reason: string };
type Transition = { policy: ExecutionPolicy; activationId: string } | { reason: string };
type CommandRow = {
  action: string;
  target_id: string | null;
  reason: string | null;
  status: string;
  applied_at: string | null;
  initiator_type: string;
  initiator: string | null;
};
type Context = { row: CommandRow; parsed: ReturnType<typeof parseExecutionPolicyJson> };

export class PermanentR23ActivationCoordinator {
  constructor(private readonly deps: Deps) {}

  isRuntimeReadyPaused(): boolean {
    const state = this.deps.controlDb
      .prepare("SELECT runtime_status AS status, paused FROM runtime_control_state WHERE id=1")
      .get() as { status: string | null; paused: number } | undefined;
    return state?.status === "ready_paused" && state.paused === 1;
  }

  activate(command: OperatorCommand, expectedVersion: number): Result {
    if (!validVersion(expectedVersion)) return rejected("invalid-expected-version");
    try {
      return this.deps.ledgerDb
        .transaction(() => {
          if (this.deps.inFlightMakerBuys() !== 0) return rejected("maker-reservation-active");
          const blocked = this.deps.ledgerDb
            .prepare(
              `SELECT 1 FROM orders WHERE side='buy'
               AND status IN ('pending','open','partially-filled') AND entry_style='maker'
               AND decision_rule_id='R23_DIP_TRIGGER' AND signal_reason='probe-entry' LIMIT 1`,
            )
            .get();
          const intent = this.deps.ledgerDb
            .prepare(
              `SELECT 1 FROM maker_capture_reprice_intents
               WHERE status IN ('cancel_pending','ready','submitted') LIMIT 1`,
            )
            .get();
          if (blocked || intent) return rejected("old-bid-lineage-active");
          const completedAt = new Date((this.deps.now ?? Date.now)()).toISOString();
          return this.commit(command, expectedVersion, completedAt, (policy) => {
            if (policy.makerEntry.permanentR23ActivationId != null)
              return { reason: "execution-policy-not-activatable" };
            const activationId = (this.deps.activationId ?? randomUUID)();
            const activation = {
              permanentR23ActivationId: activationId,
              permanentR23ActivatedAtUtc: completedAt,
            };
            return {
              activationId,
              policy: {
                ...policy,
                makerEntry: {
                  ...policy.makerEntry,
                  mode: "micro_live",
                  ...activation,
                  captureBookReprice: { enabled: true, maxRepricesPerRoot: 5 },
                },
                bounceAskCapture: {
                  ...policy.bounceAskCapture,
                  enabled: true,
                  ...activation,
                  maxRepricesPerRoot: 5,
                },
              },
            };
          });
        })
        .immediate();
    } catch (error) {
      return rejected(error instanceof Error ? error.message : "activation-failed");
    }
  }

  fenceDeactivation(
    command: OperatorCommand,
    expectedVersion: number,
    activationId: string,
  ): FenceResult {
    if (
      !validVersion(expectedVersion) ||
      !activationId ||
      command.action !== "deactivate_permanent_r23"
    )
      return rejected("invalid-deactivation");
    try {
      return this.deps.controlDb
        .transaction(() => {
          const context = this.readContext(command);
          if ("reason" in context) return rejected(context.reason);
          const { row, parsed } = context;
          if (row.status !== "pending") return rejected("operator-command-not-pending");
          if (parsed.issues.length) return rejected("execution-policy-not-activatable");
          if (!exactPermanentTuple(parsed.policy, activationId))
            return rejected("permanent-activation-mismatch");
          if (!this.isRuntimeReadyPaused())
            return parsed.policy.makerEntry.mode === "off"
              ? { status: "pending" as const, reason: "runtime-not-ready-paused" }
              : rejected("runtime-not-ready-paused");
          if (parsed.policy.makerEntry.mode === "off")
            return { status: "fenced" as const, activationId };
          if (readExecutionPolicyVersion(this.deps.controlDb) !== expectedVersion)
            return rejected("execution-policy-version-conflict");
          const fencedAt = new Date((this.deps.now ?? Date.now)()).toISOString();
          const policy = {
            ...parsed.policy,
            makerEntry: { ...parsed.policy.makerEntry, mode: "off" as const },
          };
          this.writePolicy(policy, fencedAt, expectedVersion);
          return { status: "fenced" as const, activationId };
        })
        .immediate();
    } catch (error) {
      return rejected(error instanceof Error ? error.message : "deactivation-fence-failed");
    }
  }

  finalizeDeactivation(
    command: OperatorCommand,
    activationId: string,
    completedAt: string,
  ): Result {
    if (!activationId || command.action !== "deactivate_permanent_r23")
      return rejected("invalid-deactivation");
    try {
      return this.deps.controlDb
        .transaction(() => {
          const context = this.readContext(command);
          if ("reason" in context) return rejected(context.reason);
          const { row, parsed } = context;
          if (row.status === "applied" && row.applied_at)
            return { status: "applied" as const, activationId, completedAt: row.applied_at };
          if (row.status !== "pending") return rejected("operator-command-not-pending");
          if (!this.isRuntimeReadyPaused()) return rejected("runtime-not-ready-paused");
          if (parsed.issues.length || parsed.policy.makerEntry.mode !== "off")
            return rejected("execution-policy-not-finalizable");
          if (!exactPermanentTuple(parsed.policy, activationId))
            return rejected("permanent-activation-mismatch");
          this.completeCommand(command, activationId, completedAt);
          return { status: "applied" as const, activationId, completedAt };
        })
        .immediate();
    } catch (error) {
      return rejected(error instanceof Error ? error.message : "deactivation-finalize-failed");
    }
  }

  private commit(
    command: OperatorCommand,
    expectedVersion: number,
    completedAt: string,
    transition: (policy: ExecutionPolicy) => Transition,
  ): Result {
    return this.deps.controlDb
      .transaction(() => {
        const context = this.readContext(command);
        if ("reason" in context) return rejected(context.reason);
        const { row, parsed } = context;
        const currentId = parsed.policy.makerEntry.permanentR23ActivationId;
        if (row.status === "applied" && row.applied_at && currentId)
          return {
            status: "applied",
            activationId: currentId,
            completedAt: row.applied_at,
          } as const;
        if (row.status !== "pending") return rejected("operator-command-not-pending");
        if (!this.isRuntimeReadyPaused()) return rejected("runtime-not-ready-paused");
        if (readExecutionPolicyVersion(this.deps.controlDb) !== expectedVersion)
          return rejected("execution-policy-version-conflict");
        if (parsed.issues.length) return rejected("execution-policy-not-activatable");
        const next = transition(parsed.policy);
        if ("reason" in next) return rejected(next.reason);
        this.writePolicy(next.policy, completedAt, expectedVersion);
        this.completeCommand(command, next.activationId, completedAt);
        return { status: "applied", activationId: next.activationId, completedAt } as const;
      })
      .immediate();
  }

  private readContext(command: OperatorCommand): Context | { reason: string } {
    const row = this.deps.controlDb
      .prepare(
        `SELECT action,target_id,reason,status,applied_at,initiator_type,initiator
         FROM operator_commands WHERE id=?`,
      )
      .get(command.id) as CommandRow | undefined;
    if (!sameCommand(row, command)) return { reason: "operator-command-drift" };
    const stored = this.deps.controlDb
      .prepare("SELECT execution_policy_json AS json FROM profile_settings WHERE profile_id=?")
      .get(this.deps.profileId) as { json: string | null } | undefined;
    return stored
      ? { row, parsed: parseExecutionPolicyJson(stored.json) }
      : { reason: "profile-not-found" };
  }

  private completeCommand(command: OperatorCommand, activationId: string, completedAt: string) {
    this.deps.controlDb
      .prepare(
        `INSERT INTO operator_actions
         (action_id,action,target_type,target_id,reason,performed_at) VALUES (?,?, 'bot',?,?,?)`,
      )
      .run(randomUUID(), command.action, activationId, command.reason, completedAt);
    const applied = this.deps.controlDb
      .prepare(
        "UPDATE operator_commands SET status='applied',applied_at=? WHERE id=? AND status='pending'",
      )
      .run(completedAt, command.id);
    if (applied.changes !== 1) throw new Error("operator-command-cas-failed");
  }

  private writePolicy(policy: ExecutionPolicy, at: string, expectedVersion: number) {
    this.deps.controlDb
      .prepare(
        "UPDATE profile_settings SET execution_policy_json=?,updated_at=? WHERE profile_id=?",
      )
      .run(serializeExecutionPolicy(policy), at, this.deps.profileId);
    const version = this.deps.controlDb
      .prepare(
        `UPDATE runtime_control_state SET execution_policy_version=execution_policy_version+1,
         updated_at=? WHERE id=1 AND execution_policy_version=?`,
      )
      .run(at, expectedVersion);
    if (version.changes !== 1) throw new Error("execution-policy-version-conflict");
  }
}

function sameCommand(row: CommandRow | undefined, command: OperatorCommand): row is CommandRow {
  return (
    !!row &&
    row.action === command.action &&
    row.target_id === command.targetId &&
    row.reason === command.reason &&
    row.initiator_type === command.initiatorType &&
    row.initiator === command.initiator
  );
}
const validVersion = (value: number) => Number.isSafeInteger(value) && value >= 0;
const rejected = (reason: string) => ({ status: "rejected" as const, reason });
const exactPermanentTuple = (policy: ExecutionPolicy, activationId: string) =>
  policy.makerEntry.permanentR23ActivationId === activationId &&
  policy.makerEntry.permanentR23ActivatedAtUtc != null &&
  policy.makerEntry.permanentR23ActivatedAtUtc ===
    policy.bounceAskCapture.permanentR23ActivatedAtUtc &&
  policy.bounceAskCapture.permanentR23ActivationId === activationId &&
  policy.bounceAskCapture.enabled;
