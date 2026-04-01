import { describe, it, expect, vi, afterEach } from "vitest";
import { formatAgo, formatUptime, formatTimestamp } from "./format.ts";

describe("formatAgo", () => {
  afterEach(() => vi.useRealTimers());

  it("returns 'never' for null", () => {
    expect(formatAgo(null)).toBe("never");
  });

  it("shows seconds for < 60s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T12:00:30Z"));
    expect(formatAgo("2026-03-29T12:00:00Z")).toBe("30s ago");
  });

  it("shows minutes for < 1h", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T12:45:00Z"));
    expect(formatAgo("2026-03-29T12:00:00Z")).toBe("45m ago");
  });

  it("shows hours and minutes for < 24h", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T14:42:00Z"));
    expect(formatAgo("2026-03-29T12:00:00Z")).toBe("2h 42m ago");
  });

  it("shows hours only when minutes are 0", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-29T15:00:00Z"));
    expect(formatAgo("2026-03-29T12:00:00Z")).toBe("3h ago");
  });

  it("shows days for < 30d", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    expect(formatAgo("2026-03-29T12:00:00Z")).toBe("3d ago");
  });

  it("shows months for >= 30d", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00Z"));
    expect(formatAgo("2026-03-29T12:00:00Z")).toBe("2mo ago");
  });

  it("treats SQLite datetime (no T, no Z) as UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T01:04:00Z"));
    // SQLite datetime() returns "2026-03-31 00:32:30" — no T, no Z
    expect(formatAgo("2026-03-31 00:32:30")).toBe("31m ago");
  });

  it("treats ISO without Z suffix as UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T01:04:00Z"));
    // Some paths produce "2026-03-31T00:32:30" without Z
    expect(formatAgo("2026-03-31T00:32:30")).toBe("31m ago");
  });

  it("handles negative timezone offset correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T06:00:00Z"));
    // -05:00 means the timestamp is UTC-5, so 01:00-05:00 = 06:00 UTC → 0s ago
    expect(formatAgo("2026-03-31T01:00:00-05:00")).toBe("0s ago");
  });

  it("handles positive timezone offset correctly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-31T01:00:00Z"));
    // +03:00 means 04:00+03:00 = 01:00 UTC → 0s ago
    expect(formatAgo("2026-03-31T04:00:00+03:00")).toBe("0s ago");
  });
});

describe("formatTimestamp", () => {
  afterEach(() => vi.useRealTimers());

  it("returns dash for null", () => {
    expect(formatTimestamp(null)).toBe("\u2014");
  });

  it("shows only time for today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T14:38:00Z"));
    // Same day in UTC
    expect(formatTimestamp("2026-04-01T09:15:00Z")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("shows time + short date for this year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T14:00:00Z"));
    // 5 days ago — always a different day regardless of timezone
    const result = formatTimestamp("2026-04-05T12:00:00Z");
    expect(result).toMatch(/\d{2}:\d{2}, \d{1,2} \w{3}$/);
  });

  it("shows time + date + year for different year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T14:00:00Z"));
    const result = formatTimestamp("2025-12-25T10:00:00Z");
    expect(result).toMatch(/\d{2}:\d{2}, \d{1,2} \w{3} 2025$/);
  });

  it("uses 24h format", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T20:00:00Z"));
    const result = formatTimestamp("2026-04-01T17:05:00Z");
    // Should NOT contain AM/PM
    expect(result).not.toMatch(/[AP]M/i);
    // Should be in HH:MM format
    expect(result).toMatch(/^\d{2}:\d{2}/);
  });

  it("handles SQLite datetime format (no Z)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T14:00:00Z"));
    const result = formatTimestamp("2026-04-01 09:15:00");
    expect(result).toMatch(/^\d{2}:\d{2}/);
  });
});

describe("formatUptime", () => {
  it("formats 0 seconds", () => {
    expect(formatUptime(0)).toBe("0h 0m");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(7380)).toBe("2h 3m");
  });
});
