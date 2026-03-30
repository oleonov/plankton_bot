import type Database from "better-sqlite3";
import type { ProfileSummaryRepository, ProfileSummary } from "@plankton/domain";
import type { ProfileId, PreflightStatus } from "@plankton/domain";

export class SqliteProfileSummaryRepository implements ProfileSummaryRepository {
  constructor(private readonly db: Database.Database) {}

  get(profileId: ProfileId): ProfileSummary | null {
    const row = this.db
      .prepare("SELECT * FROM profile_summaries WHERE profile_id = ?")
      .get(profileId) as Record<string, unknown> | undefined;
    return row ? rowToSummary(row) : null;
  }

  getAll(): ProfileSummary[] {
    const rows = this.db.prepare("SELECT * FROM profile_summaries").all() as Record<
      string,
      unknown
    >[];
    return rows.map(rowToSummary);
  }

  save(summary: ProfileSummary): void {
    this.db
      .prepare(
        `INSERT INTO profile_summaries
         (profile_id, paused, last_run_at, open_orders, open_positions,
          total_exposure_usdc, balance_usdc, last_preflight_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET
           paused = excluded.paused,
           last_run_at = excluded.last_run_at,
           open_orders = excluded.open_orders,
           open_positions = excluded.open_positions,
           total_exposure_usdc = excluded.total_exposure_usdc,
           balance_usdc = excluded.balance_usdc,
           last_preflight_status = excluded.last_preflight_status,
           updated_at = excluded.updated_at`,
      )
      .run(
        summary.profileId,
        summary.paused ? 1 : 0,
        summary.lastRunAt,
        summary.openOrders,
        summary.openPositions,
        summary.totalExposureUsdc,
        summary.balanceUsdc,
        summary.lastPreflightStatus,
        summary.updatedAt,
      );
  }
}

function rowToSummary(row: Record<string, unknown>): ProfileSummary {
  return {
    profileId: row.profile_id as ProfileId,
    paused: row.paused === 1,
    lastRunAt: (row.last_run_at as string) ?? null,
    openOrders: row.open_orders as number,
    openPositions: row.open_positions as number,
    totalExposureUsdc: row.total_exposure_usdc as number,
    balanceUsdc: (row.balance_usdc as number) ?? null,
    lastPreflightStatus: (row.last_preflight_status as PreflightStatus) ?? null,
    updatedAt: row.updated_at as string,
  };
}
