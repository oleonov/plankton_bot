import type Database from "better-sqlite3";
import type {
  TradingCalendarException,
  TradingCalendarMetadata,
  TradingCalendarRepository,
} from "@krabs/domain";

type CalendarExceptionRow = {
  calendar_id: string;
  date: string;
  status: "closed" | "early_close";
  timezone: string;
  open_time_local: string | null;
  close_time_local: string | null;
  reason: string;
  source: string;
  source_url: string | null;
  verification_status: "verified_official" | "provisional";
  verified_at: string | null;
  updated_at: string;
};

type CalendarMetadataRow = {
  calendar_id: string;
  timezone: string;
  regular_open_time_local: string;
  regular_close_time_local: string;
  verified_through_date: string;
  provisional_through_date: string | null;
  source: string;
  source_url: string | null;
  updated_at: string;
};

export class SqliteTradingCalendarRepository implements TradingCalendarRepository {
  constructor(private readonly db: Database.Database) {}

  findException(calendarId: string, date: string): TradingCalendarException | null {
    const row = this.db
      .prepare(
        `SELECT calendar_id, date, status, timezone, open_time_local, close_time_local,
                reason, source, source_url, verification_status, verified_at, updated_at
           FROM trading_calendar_exceptions
          WHERE calendar_id = ? AND date = ?
          LIMIT 1`,
      )
      .get(calendarId, date) as CalendarExceptionRow | undefined;
    return row ? mapException(row) : null;
  }

  getMetadata(calendarId: string): TradingCalendarMetadata | null {
    const row = this.db
      .prepare(
        `SELECT calendar_id, timezone, regular_open_time_local, regular_close_time_local,
                verified_through_date, provisional_through_date, source, source_url, updated_at
           FROM trading_calendar_metadata
          WHERE calendar_id = ?
          LIMIT 1`,
      )
      .get(calendarId) as CalendarMetadataRow | undefined;
    return row ? mapMetadata(row) : null;
  }

  listExceptions(calendarId: string): TradingCalendarException[] {
    const rows = this.db
      .prepare(
        `SELECT calendar_id, date, status, timezone, open_time_local, close_time_local,
                reason, source, source_url, verification_status, verified_at, updated_at
           FROM trading_calendar_exceptions
          WHERE calendar_id = ?
          ORDER BY date ASC`,
      )
      .all(calendarId) as CalendarExceptionRow[];
    return rows.map(mapException);
  }
}

function mapException(row: CalendarExceptionRow): TradingCalendarException {
  return {
    calendarId: row.calendar_id,
    date: row.date,
    status: row.status,
    timezone: row.timezone,
    openTimeLocal: row.open_time_local,
    closeTimeLocal: row.close_time_local,
    reason: row.reason,
    source: row.source,
    sourceUrl: row.source_url,
    verificationStatus: row.verification_status,
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at,
  };
}

function mapMetadata(row: CalendarMetadataRow): TradingCalendarMetadata {
  return {
    calendarId: row.calendar_id,
    timezone: row.timezone,
    regularOpenTimeLocal: row.regular_open_time_local,
    regularCloseTimeLocal: row.regular_close_time_local,
    verifiedThroughDate: row.verified_through_date,
    provisionalThroughDate: row.provisional_through_date,
    source: row.source,
    sourceUrl: row.source_url,
    updatedAt: row.updated_at,
  };
}
