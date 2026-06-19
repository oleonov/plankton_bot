import type Database from "better-sqlite3";
import { assertSupportedRuntimeProfile, SUPPORTED_RUNTIME_PROFILE } from "@krabs/domain";

export interface ActiveProfile {
  profile: typeof SUPPORTED_RUNTIME_PROFILE;
  runtimeMode: typeof SUPPORTED_RUNTIME_PROFILE;
  desiredProfile: string | null;
  currentProfile: string | null;
  envMode: string | null;
}

/**
 * Resolve active profile from control.db runtime_control_state.
 * Falls back to envMode (RUNTIME_MODE) if no control state row exists.
 */
export function resolveActiveProfile(
  controlDb: Database.Database,
  envMode?: string,
): ActiveProfile {
  const row = controlDb
    .prepare("SELECT desired_profile, current_profile FROM runtime_control_state WHERE id = 1")
    .get() as { desired_profile: string | null; current_profile: string | null } | undefined;

  const profile = row?.desired_profile ?? envMode ?? null;
  try {
    assertSupportedRuntimeProfile(profile);
  } catch (err) {
    const context = `desired=${row?.desired_profile ?? "null"}, current=${
      row?.current_profile ?? "null"
    }, env=${envMode ?? "null"}, resolved=${profile ?? "null"}`;
    throw new Error(`${(err as Error).message} (${context})`);
  }
  return {
    profile,
    runtimeMode: profile,
    desiredProfile: row?.desired_profile ?? null,
    currentProfile: row?.current_profile ?? null,
    envMode: envMode ?? null,
  };
}
