import type Database from "better-sqlite3";
import type { ProfileSettingsRepository, ProfileSettings } from "@krabs/domain";
import type { ProfileId, WalletMode } from "@krabs/domain";

export class SqliteProfileSettingsRepository implements ProfileSettingsRepository {
  constructor(private readonly db: Database.Database) {}

  get(profileId: ProfileId): ProfileSettings | null {
    const row = this.db
      .prepare("SELECT * FROM profile_settings WHERE profile_id = ?")
      .get(profileId) as Record<string, unknown> | undefined;
    return row ? rowToSettings(row) : null;
  }

  save(settings: ProfileSettings): void {
    const tx = this.db.transaction(() => {
      const prior = this.db
        .prepare("SELECT execution_policy_json FROM profile_settings WHERE profile_id = ?")
        .get(settings.profileId) as { execution_policy_json: string | null } | undefined;
      const priorPolicyJson = prior?.execution_policy_json ?? null;
      const nextPolicyJson = settings.executionPolicyJson ?? null;

      this.db
        .prepare(
          `INSERT INTO profile_settings
             (profile_id, initial_balance_usdc, envelope_json, risk_caps_json,
              wallet_mode, min_order_usdc, relayer_json, execution_policy_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id) DO UPDATE SET
             initial_balance_usdc = excluded.initial_balance_usdc,
             envelope_json = excluded.envelope_json,
             risk_caps_json = excluded.risk_caps_json,
             wallet_mode = excluded.wallet_mode,
             min_order_usdc = excluded.min_order_usdc,
             relayer_json = excluded.relayer_json,
             execution_policy_json = excluded.execution_policy_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          settings.profileId,
          settings.initialBalanceUsdc,
          settings.envelopeJson,
          settings.riskCapsJson,
          settings.walletMode ?? null,
          settings.minOrderUsdc ?? null,
          settings.relayerJson ?? null,
          nextPolicyJson,
          settings.updatedAt,
        );

      // ADR-015: bump execution_policy_version only on policy JSON change so
      // runtime hot-reload polling doesn't wake up on unrelated envelope/
      // risk/relayer edits. Tolerate DBs where the column doesn't exist yet
      // (older test fixtures).
      if (priorPolicyJson !== nextPolicyJson) {
        try {
          this.db
            .prepare(
              `UPDATE runtime_control_state
               SET execution_policy_version = execution_policy_version + 1,
                   updated_at = datetime('now')
               WHERE id = 1`,
            )
            .run();
        } catch (err) {
          const msg = err instanceof Error ? err.message : "";
          if (!msg.includes("no such column") && !msg.includes("no such table")) throw err;
        }
      }
    });
    tx();
  }
}

function rowToSettings(row: Record<string, unknown>): ProfileSettings {
  return {
    profileId: row.profile_id as ProfileId,
    initialBalanceUsdc: (row.initial_balance_usdc as number) ?? null,
    envelopeJson: (row.envelope_json as string) ?? null,
    riskCapsJson: (row.risk_caps_json as string) ?? null,
    walletMode: (row.wallet_mode as WalletMode) ?? null,
    minOrderUsdc: (row.min_order_usdc as number) ?? null,
    relayerJson: (row.relayer_json as string) ?? null,
    executionPolicyJson: (row.execution_policy_json as string) ?? null,
    updatedAt: row.updated_at as string,
  };
}
