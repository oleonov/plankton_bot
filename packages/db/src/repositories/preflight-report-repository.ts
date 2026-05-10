import type Database from "better-sqlite3";
import type { PreflightReportRepository, PreflightReport } from "@krabs/domain";
import { createReportId, createSwitchId } from "@krabs/domain";
import type { ReportId, SwitchId, ProfileId, PreflightKind, PreflightStatus } from "@krabs/domain";

export class SqlitePreflightReportRepository implements PreflightReportRepository {
  constructor(private readonly db: Database.Database) {}

  save(report: PreflightReport): void {
    this.db
      .prepare(
        `INSERT INTO preflight_reports
         (report_id, switch_request_id, profile, kind, status,
          blockers_json, warnings_json, info_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(report_id) DO UPDATE SET
           switch_request_id = excluded.switch_request_id,
           profile = excluded.profile,
           kind = excluded.kind,
           status = excluded.status,
           blockers_json = excluded.blockers_json,
           warnings_json = excluded.warnings_json,
           info_json = excluded.info_json`,
      )
      .run(
        report.reportId,
        report.switchRequestId,
        report.profile,
        report.kind,
        report.status,
        report.blockersJson,
        report.warningsJson,
        report.infoJson,
        report.createdAt,
      );
  }

  findById(reportId: ReportId): PreflightReport | null {
    const row = this.db
      .prepare("SELECT * FROM preflight_reports WHERE report_id = ?")
      .get(reportId) as Record<string, unknown> | undefined;
    return row ? rowToReport(row) : null;
  }

  findBySwitchRequest(switchId: SwitchId): PreflightReport[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM preflight_reports WHERE switch_request_id = ? ORDER BY created_at DESC",
      )
      .all(switchId) as Record<string, unknown>[];
    return rows.map(rowToReport);
  }

  findLatestByProfile(profile: ProfileId): PreflightReport | null {
    const row = this.db
      .prepare("SELECT * FROM preflight_reports WHERE profile = ? ORDER BY created_at DESC LIMIT 1")
      .get(profile) as Record<string, unknown> | undefined;
    return row ? rowToReport(row) : null;
  }
}

function rowToReport(row: Record<string, unknown>): PreflightReport {
  return {
    reportId: createReportId(row.report_id as string),
    switchRequestId: row.switch_request_id ? createSwitchId(row.switch_request_id as string) : null,
    profile: row.profile as ProfileId,
    kind: row.kind as PreflightKind,
    status: row.status as PreflightStatus,
    blockersJson: (row.blockers_json as string) ?? null,
    warningsJson: (row.warnings_json as string) ?? null,
    infoJson: (row.info_json as string) ?? null,
    createdAt: row.created_at as string,
  };
}
