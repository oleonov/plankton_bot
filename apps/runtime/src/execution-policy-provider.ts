/**
 * ADR-015 — Version-polled execution-policy provider.
 *
 * Reads `profile_settings.execution_policy_json` and watches
 * `runtime_control_state.execution_policy_version`. On version change, the
 * provider reparses the JSON payload and atomically swaps the in-memory
 * snapshot. Invalid JSON keeps the last-good snapshot and logs an error —
 * live-lite must not crash on a bad write.
 *
 * Patterned after `RefreshableSelectionRuleEngine`: the main loop (or each
 * signal conversion) calls `refreshIfStale()`; the bridge reads
 * `snapshot()` to pick up the current policy.
 */
import type Database from "better-sqlite3";
import type { ExecutionPolicy, ProfileId, ProfileSettings } from "@plankton/domain";
import {
  DEFAULT_EXECUTION_POLICY,
  parseExecutionPolicyJson,
  type ParseResult,
} from "@plankton/domain";
import { readExecutionPolicyVersion } from "@plankton/db";
import type { ProfileSettingsRepository } from "@plankton/domain";
import type { Logger } from "./logger.js";

export interface ExecutionPolicyProviderDeps {
  controlDb: Database.Database;
  profileSettingsRepo: ProfileSettingsRepository;
  log: Logger;
  profileId: ProfileId;
}

export class ExecutionPolicyProvider {
  private readonly log: Logger;
  private currentPolicy: ExecutionPolicy;
  private currentVersion: number;
  private lastParsedJson: string | null;

  constructor(private readonly deps: ExecutionPolicyProviderDeps) {
    this.log = deps.log.child({ component: "execution-policy-provider" });
    // Seed with safe defaults BEFORE loadFromDb(): if the persisted JSON is
    // invalid on bootstrap, loadFromDb's "keep last-good" path returns
    // `this.currentPolicy` — which must be a valid snapshot, not undefined.
    this.currentPolicy = DEFAULT_EXECUTION_POLICY;
    this.lastParsedJson = null;
    this.currentVersion = readExecutionPolicyVersion(deps.controlDb);
    const initial = this.loadFromDb("bootstrap");
    this.currentPolicy = initial.policy;
    this.lastParsedJson = initial.sourceJson;
    this.log.info(
      {
        profileId: String(deps.profileId),
        version: this.currentVersion,
        policy: summarizePolicy(this.currentPolicy),
      },
      "execution policy loaded",
    );
  }

  /** Current policy snapshot. Callers must re-read on every use path. */
  snapshot(): ExecutionPolicy {
    return this.currentPolicy;
  }

  /** Version last observed from `runtime_control_state`. */
  version(): number {
    return this.currentVersion;
  }

  /**
   * Reload the policy if the DB version advanced. Safe to call frequently —
   * the hot path is a single integer read.
   */
  refreshIfStale(): boolean {
    const nextVersion = readExecutionPolicyVersion(this.deps.controlDb);
    if (nextVersion === this.currentVersion) return false;
    const loaded = this.loadFromDb("version-change");
    if (loaded.policy === this.currentPolicy) {
      // Validation failed, kept last-good snapshot.
      this.currentVersion = nextVersion;
      return false;
    }
    this.log.info(
      {
        profileId: String(this.deps.profileId),
        oldVersion: this.currentVersion,
        newVersion: nextVersion,
        oldPolicy: summarizePolicy(this.currentPolicy),
        newPolicy: summarizePolicy(loaded.policy),
      },
      "execution policy reloaded",
    );
    this.currentPolicy = loaded.policy;
    this.lastParsedJson = loaded.sourceJson;
    this.currentVersion = nextVersion;
    return true;
  }

  /** Test-only: force a reload even when version is unchanged. */
  forceReload(): void {
    const loaded = this.loadFromDb("force");
    this.currentPolicy = loaded.policy;
    this.lastParsedJson = loaded.sourceJson;
  }

  private loadFromDb(trigger: string): {
    policy: ExecutionPolicy;
    sourceJson: string | null;
  } {
    const settings = this.safeGetSettings();
    const sourceJson = settings?.executionPolicyJson ?? null;
    if (sourceJson == null) {
      return { policy: DEFAULT_EXECUTION_POLICY, sourceJson: null };
    }
    if (sourceJson === this.lastParsedJson) {
      return { policy: this.currentPolicy, sourceJson };
    }
    const result: ParseResult = parseExecutionPolicyJson(sourceJson);
    if (result.issues.length > 0) {
      this.log.error(
        {
          profileId: String(this.deps.profileId),
          trigger,
          issues: result.issues,
        },
        "execution policy JSON invalid; keeping last-good snapshot",
      );
      // Keep prior policy by returning the current snapshot; signal via object
      // identity that no swap occurred.
      return { policy: this.currentPolicy, sourceJson: this.lastParsedJson };
    }
    return { policy: result.policy, sourceJson };
  }

  private safeGetSettings(): ProfileSettings | null {
    try {
      return this.deps.profileSettingsRepo.get(this.deps.profileId);
    } catch (err) {
      this.log.error(
        { err, profileId: String(this.deps.profileId) },
        "failed to read profile settings for execution policy",
      );
      return null;
    }
  }
}

function summarizePolicy(policy: ExecutionPolicy): Record<string, unknown> {
  return {
    entryPriceCeiling: policy.entryPriceCeiling,
    exitOrderTtlMs: policy.exitOrderTtlMs,
    entryMinMarketAgeSeconds: policy.entryMinMarketAgeSeconds,
    marketSelection: policy.marketSelection,
    deadSideGuard: policy.deadSideGuard,
    pricing: policy.pricing,
    telemetry: policy.telemetry,
  };
}
