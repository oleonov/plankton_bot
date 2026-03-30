import type Database from "better-sqlite3";
import type { ProfileSettingsRepository, ProfileSettings } from "@plankton/domain";
import type { ProfileId } from "@plankton/domain";

export class SqliteProfileSettingsRepository implements ProfileSettingsRepository {
  constructor(private readonly db: Database.Database) {}

  get(profileId: ProfileId): ProfileSettings | null {
    const row = this.db
      .prepare("SELECT * FROM profile_settings WHERE profile_id = ?")
      .get(profileId) as Record<string, unknown> | undefined;
    return row ? rowToSettings(row) : null;
  }

  save(settings: ProfileSettings): void {
    this.db
      .prepare(
        `INSERT INTO profile_settings (profile_id, initial_balance_usdc, envelope_json, risk_caps_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           initial_balance_usdc = excluded.initial_balance_usdc,
           envelope_json = excluded.envelope_json,
           risk_caps_json = excluded.risk_caps_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        settings.profileId,
        settings.initialBalanceUsdc,
        settings.envelopeJson,
        settings.riskCapsJson,
        settings.updatedAt,
      );
  }
}

function rowToSettings(row: Record<string, unknown>): ProfileSettings {
  return {
    profileId: row.profile_id as ProfileId,
    initialBalanceUsdc: (row.initial_balance_usdc as number) ?? null,
    envelopeJson: (row.envelope_json as string) ?? null,
    riskCapsJson: (row.risk_caps_json as string) ?? null,
    updatedAt: row.updated_at as string,
  };
}
