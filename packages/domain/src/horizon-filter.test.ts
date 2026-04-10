import { describe, it, expect } from "vitest";
import { matchesHorizon } from "./horizon-filter.js";

describe("matchesHorizon", () => {
  const now = new Date("2026-03-16T12:00:00Z");

  it("daily horizon + endDate tomorrow returns true", () => {
    expect(matchesHorizon("daily", "2026-03-17T00:00:00Z", now)).toBe(true);
  });

  it("daily horizon + endDate in 9 months returns false (long-dated)", () => {
    expect(matchesHorizon("daily", "2026-12-31T00:00:00Z", now)).toBe(false);
  });

  it("daily horizon + null endDate returns true (permissive)", () => {
    expect(matchesHorizon("daily", null, now)).toBe(true);
  });

  it("daily horizon + endDate 30 minutes ahead returns true for assignment", () => {
    expect(matchesHorizon("daily", "2026-03-16T12:30:00Z", now)).toBe(true);
  });

  it("intraday-4h horizon + endDate 4 hours ahead returns true", () => {
    expect(matchesHorizon("intraday-4h", "2026-03-16T16:00:00Z", now)).toBe(true);
  });

  it("intraday-4h horizon + endDate 10 minutes ahead returns true for assignment", () => {
    expect(matchesHorizon("intraday-4h", "2026-03-16T12:10:00Z", now)).toBe(true);
  });

  it("intraday-4h horizon + endDate 1 day ahead returns false", () => {
    expect(matchesHorizon("intraday-4h", "2026-03-17T12:00:00Z", now)).toBe(false);
  });

  it("intraday-4h horizon + December 2026 endDate returns false", () => {
    const aprilNow = new Date("2026-04-10T09:38:24.003Z");
    expect(matchesHorizon("intraday-4h", "2027-01-01T05:00:00Z", aprilNow)).toBe(false);
  });

  it("ad-hoc horizon uses a 14 day max window", () => {
    expect(matchesHorizon("ad-hoc", "2026-03-25T12:00:00Z", now)).toBe(true);
    expect(matchesHorizon("ad-hoc", "2026-04-01T12:00:00Z", now)).toBe(false);
  });

  it("deadline horizon uses a 30 day max window", () => {
    expect(matchesHorizon("deadline", "2026-03-17T00:00:00Z", now)).toBe(true);
    expect(matchesHorizon("deadline", "2026-03-26T12:00:00Z", now)).toBe(true);
    expect(matchesHorizon("deadline", "2026-05-15T12:00:00Z", now)).toBe(false);
  });

  it("unknown horizon uses fallback window", () => {
    expect(matchesHorizon("weekly", "2026-03-19T12:00:00Z", now)).toBe(true);
    expect(matchesHorizon("weekly", "2026-03-26T12:00:00Z", now)).toBe(false);
  });

  it("daily horizon + endDate yesterday returns true within assignment tolerance", () => {
    expect(matchesHorizon("daily", "2026-03-15T12:00:00Z", now)).toBe(true);
  });

  it("daily horizon + endDate 5 days ago returns false", () => {
    expect(matchesHorizon("daily", "2026-03-11T00:00:00Z", now)).toBe(false);
  });

  it("daily horizon + endDate exactly at maxDaysAhead boundary returns true", () => {
    expect(matchesHorizon("daily", "2026-03-19T12:00:00Z", now)).toBe(true);
  });

  it("daily horizon + endDate just beyond maxDaysAhead returns false", () => {
    expect(matchesHorizon("daily", "2026-03-20T00:00:00Z", now)).toBe(false);
  });

  it("daily horizon + invalid endDate returns true (permissive)", () => {
    expect(matchesHorizon("daily", "not-a-date", now)).toBe(true);
  });

  it("respects custom maxDaysAhead parameter", () => {
    expect(matchesHorizon("daily", "2026-03-23T00:00:00Z", now, 7)).toBe(true);
    expect(matchesHorizon("daily", "2026-03-23T00:00:00Z", now, 3)).toBe(false);
  });
});
