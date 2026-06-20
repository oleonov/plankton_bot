import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SqliteTradingCalendarRepository } from "./trading-calendar-repository.js";

function readMigration(): string {
  return readFileSync(
    path.join(import.meta.dirname, "..", "migrations", "075_trading_calendar_exceptions.sql"),
    "utf-8",
  );
}

describe("SqliteTradingCalendarRepository", () => {
  it("looks up closed and early-close exceptions", () => {
    const db = new Database(":memory:");
    db.exec(readMigration());
    const repo = new SqliteTradingCalendarRepository(db);

    expect(repo.findException("US_EQUITY", "2026-06-19")).toMatchObject({
      calendarId: "US_EQUITY",
      date: "2026-06-19",
      status: "closed",
      reason: "Juneteenth National Independence Day",
      verificationStatus: "verified_official",
    });
    expect(repo.findException("US_EQUITY", "2026-11-27")).toMatchObject({
      status: "early_close",
      openTimeLocal: "09:30",
      closeTimeLocal: "13:00",
    });
    db.close();
  });

  it("returns no exception for regular weekdays and weekends", () => {
    const db = new Database(":memory:");
    db.exec(readMigration());
    const repo = new SqliteTradingCalendarRepository(db);

    expect(repo.findException("US_EQUITY", "2026-06-18")).toBeNull();
    expect(repo.findException("US_EQUITY", "2026-06-20")).toBeNull();
    expect(repo.findException("US_EQUITY", "2026-07-02")).toBeNull();
    expect(repo.findException("US_EQUITY", "2026-07-03")).toMatchObject({
      status: "closed",
      reason: "Independence Day observed",
    });
    db.close();
  });

  it("seeds metadata and at least ten years of exceptions", () => {
    const db = new Database(":memory:");
    db.exec(readMigration());
    const repo = new SqliteTradingCalendarRepository(db);

    expect(repo.getMetadata("US_EQUITY")).toMatchObject({
      timezone: "America/New_York",
      regularOpenTimeLocal: "09:30",
      regularCloseTimeLocal: "16:00",
      verifiedThroughDate: "2028-12-31",
      provisionalThroughDate: "2036-12-31",
    });
    expect(repo.listExceptions("US_EQUITY").length).toBeGreaterThan(100);
    expect(repo.findException("US_EQUITY", "2036-06-19")).toMatchObject({
      status: "closed",
      verificationStatus: "provisional",
    });
    db.close();
  });

  it("enforces one exception per calendar/date", () => {
    const db = new Database(":memory:");
    db.exec(readMigration());

    expect(() =>
      db
        .prepare(
          `INSERT INTO trading_calendar_exceptions (
            id, calendar_id, date, status, timezone, reason, source, verification_status
          ) VALUES ('dup', 'US_EQUITY', '2026-06-19', 'closed', 'America/New_York',
            'dup', 'test', 'provisional')`,
        )
        .run(),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});
