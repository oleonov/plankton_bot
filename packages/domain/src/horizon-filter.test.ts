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

  it("non-daily horizon + any endDate returns true (permissive)", () => {
    expect(matchesHorizon("weekly", "2026-12-31T00:00:00Z", now)).toBe(true);
    expect(matchesHorizon("monthly", "2027-06-01T00:00:00Z", now)).toBe(true);
  });

  it("daily horizon + endDate yesterday returns true (within -1 day tolerance)", () => {
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
