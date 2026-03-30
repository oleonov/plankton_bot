import type Database from "better-sqlite3";
import type { ProfileRepository, Profile } from "@plankton/domain";
import type { ProfileId } from "@plankton/domain";

export class SqliteProfileRepository implements ProfileRepository {
  constructor(private readonly db: Database.Database) {}

  findAll(): Profile[] {
    const rows = this.db.prepare("SELECT * FROM profiles").all() as Record<string, unknown>[];
    return rows.map(rowToProfile);
  }

  findById(profileId: ProfileId): Profile | null {
    const row = this.db.prepare("SELECT * FROM profiles WHERE profile_id = ?").get(profileId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToProfile(row) : null;
  }

  save(profile: Profile): void {
    this.db
      .prepare(
        `INSERT INTO profiles (profile_id, display_name, description, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           display_name = excluded.display_name,
           description = excluded.description`,
      )
      .run(profile.profileId, profile.displayName, profile.description, profile.createdAt);
  }
}

function rowToProfile(row: Record<string, unknown>): Profile {
  return {
    profileId: row.profile_id as ProfileId,
    displayName: row.display_name as string,
    description: (row.description as string) ?? null,
    createdAt: row.created_at as string,
  };
}
