import type Database from "better-sqlite3";

export interface ActiveProfile {
  profile: string;
  runtimeMode: string;
}

/**
 * Resolve active profile from control.db runtime_control_state.
 * Falls back to envMode (RUNTIME_MODE) if no control state row exists.
 * Defaults to 'simulation' if neither is set.
 */
export function resolveActiveProfile(
  controlDb: Database.Database,
  envMode?: string,
): ActiveProfile {
  const row = controlDb
    .prepare("SELECT desired_profile FROM runtime_control_state WHERE id = 1")
    .get() as { desired_profile: string | null } | undefined;

  const profile = row?.desired_profile ?? envMode ?? "simulation";
  return { profile, runtimeMode: profile };
}
