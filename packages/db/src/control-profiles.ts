import type Database from "better-sqlite3";
import { ProfileId } from "@plankton/domain";

export interface ControlProfileSeed {
  readonly profileId: string;
  readonly displayName: string;
  readonly description: string;
}

export const CONTROL_PROFILES: readonly ControlProfileSeed[] = [
  {
    profileId: ProfileId.Simulation,
    displayName: "Simulation",
    description: "In-memory simulated execution",
  },
  {
    profileId: ProfileId.Paper,
    displayName: "Paper",
    description: "Live market data, simulated orders",
  },
  {
    profileId: ProfileId.LiveLite,
    displayName: "Live-Lite",
    description: "Real orders with envelope caps",
  },
];

export function ensureControlProfiles(
  db: Database.Database,
  now = new Date().toISOString(),
): void {
  const insertProfile = db.prepare(
    "INSERT OR IGNORE INTO profiles (profile_id, display_name, description, created_at) VALUES (?, ?, ?, ?)",
  );
  for (const profile of CONTROL_PROFILES) {
    insertProfile.run(profile.profileId, profile.displayName, profile.description, now);
  }
}
