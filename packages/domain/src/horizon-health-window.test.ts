import { describe, it, expect } from "vitest";
import { isWithinHealthWindow } from "./horizon-filter.js";

describe("isWithinHealthWindow", () => {
  const now = new Date("2026-03-16T12:00:00Z");

  describe("daily horizon", () => {
    it("healthy — endDate 2 days ahead", () => {
      expect(isWithinHealthWindow("daily", "2026-03-18T12:00:00Z", now)).toBe(true);
    });

    it("unhealthy — endDate 30 minutes ahead (below minHours=1)", () => {
      expect(isWithinHealthWindow("daily", "2026-03-16T12:30:00Z", now)).toBe(false);
    });

    it("unhealthy — endDate 4 days ahead (above maxDays=3)", () => {
      expect(isWithinHealthWindow("daily", "2026-03-20T13:00:00Z", now)).toBe(false);
    });

    it("boundary — exactly minHours=1", () => {
      expect(isWithinHealthWindow("daily", "2026-03-16T13:00:00Z", now)).toBe(true);
    });

    it("boundary — exactly maxDays=3 (72 hours)", () => {
      expect(isWithinHealthWindow("daily", "2026-03-19T12:00:00Z", now)).toBe(true);
    });
  });

  describe("intraday-4h horizon", () => {
    it("healthy — endDate 4 hours ahead", () => {
      expect(isWithinHealthWindow("intraday-4h", "2026-03-16T16:00:00Z", now)).toBe(true);
    });

    it("unhealthy — endDate 10 minutes ahead (below minHours=0.5)", () => {
      expect(isWithinHealthWindow("intraday-4h", "2026-03-16T12:10:00Z", now)).toBe(false);
    });

    it("unhealthy — endDate 1 day ahead (above maxDays=0.33 ≈ 7.92h)", () => {
      expect(isWithinHealthWindow("intraday-4h", "2026-03-17T12:00:00Z", now)).toBe(false);
    });

    it("boundary — exactly minHours=0.5 (30 min)", () => {
      expect(isWithinHealthWindow("intraday-4h", "2026-03-16T12:30:00Z", now)).toBe(true);
    });
  });

  describe("deadline horizon", () => {
    it("healthy — endDate 10 days ahead", () => {
      expect(isWithinHealthWindow("deadline", "2026-03-26T12:00:00Z", now)).toBe(true);
    });

    it("unhealthy — endDate 12 hours ahead (below minHours=24)", () => {
      expect(isWithinHealthWindow("deadline", "2026-03-17T00:00:00Z", now)).toBe(false);
    });

    it("unhealthy — endDate 60 days ahead (above maxDays=30)", () => {
      expect(isWithinHealthWindow("deadline", "2026-05-15T12:00:00Z", now)).toBe(false);
    });
  });

  describe("null / invalid endDate", () => {
    it("null endDate returns true (permissive)", () => {
      expect(isWithinHealthWindow("daily", null, now)).toBe(true);
    });

    it("invalid endDate returns true (permissive)", () => {
      expect(isWithinHealthWindow("daily", "not-a-date", now)).toBe(true);
    });
  });

  describe("unknown horizon uses fallback (minHours=1, maxDays=7)", () => {
    it("healthy — endDate 3 days ahead", () => {
      expect(isWithinHealthWindow("unknown-horizon", "2026-03-19T12:00:00Z", now)).toBe(true);
    });

    it("unhealthy — endDate 30 minutes ahead", () => {
      expect(isWithinHealthWindow("unknown-horizon", "2026-03-16T12:30:00Z", now)).toBe(false);
    });

    it("unhealthy — endDate 10 days ahead", () => {
      expect(isWithinHealthWindow("unknown-horizon", "2026-03-26T12:00:00Z", now)).toBe(false);
    });
  });

  describe("past endDate", () => {
    it("endDate in the past returns false", () => {
      expect(isWithinHealthWindow("daily", "2026-03-15T00:00:00Z", now)).toBe(false);
    });

    it("endDate far in the past returns false", () => {
      expect(isWithinHealthWindow("deadline", "2025-01-01T00:00:00Z", now)).toBe(false);
    });
  });
});
