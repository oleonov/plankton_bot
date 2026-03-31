import { describe, it, expect, vi, afterEach } from "vitest";
import { formatAgo, formatUptime } from "./format.ts";

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
});

describe("formatUptime", () => {
  it("formats 0 seconds", () => {
    expect(formatUptime(0)).toBe("0h 0m");
  });

  it("formats hours and minutes", () => {
    expect(formatUptime(7380)).toBe("2h 3m");
  });
});
