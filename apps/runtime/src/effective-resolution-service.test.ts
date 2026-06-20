import { describe, expect, it, vi } from "vitest";
import {
  US_EQUITY_CALENDAR_ID,
  type TradingCalendarMetadata,
  type TradingCalendarRepository,
} from "@krabs/domain";
import { RuntimeEffectiveResolutionService } from "./effective-resolution-service.js";

const metadata: TradingCalendarMetadata = {
  calendarId: US_EQUITY_CALENDAR_ID,
  timezone: "America/New_York",
  regularOpenTimeLocal: "09:30",
  regularCloseTimeLocal: "16:00",
  verifiedThroughDate: "2028-12-31",
  provisionalThroughDate: "2036-12-31",
  source: "test",
  sourceUrl: null,
  updatedAt: "2026-06-20T00:00:00.000Z",
};

function repo(override: Partial<TradingCalendarRepository> = {}): TradingCalendarRepository {
  return {
    findException: () => null,
    getMetadata: () => metadata,
    listExceptions: () => [],
    ...override,
  };
}

describe("RuntimeEffectiveResolutionService", () => {
  it("does not warn when verified coverage is farther than 18 months", () => {
    const service = new RuntimeEffectiveResolutionService(repo());

    expect(service.coverageStatus("2026-06-20T00:00:00.000Z")).toMatchObject({
      daysRemaining: expect.any(Number),
      warn: false,
      calendarId: US_EQUITY_CALENDAR_ID,
    });
  });

  it("warns when verified coverage is within 18 months", () => {
    const service = new RuntimeEffectiveResolutionService(repo());

    expect(service.coverageStatus("2028-01-15T00:00:00.000Z")).toMatchObject({
      warn: true,
      calendarId: US_EQUITY_CALENDAR_ID,
    });
  });

  it("emits coverage gauge", () => {
    const metrics = { writeLatest: vi.fn() } as any;
    const service = new RuntimeEffectiveResolutionService(repo(), metrics);

    service.emitCoverageMetric("2026-06-20T00:00:00.000Z");

    expect(metrics.writeLatest).toHaveBeenCalledWith(
      "trading_calendar_coverage_days_remaining",
      expect.any(Number),
      JSON.stringify({ calendar_id: US_EQUITY_CALENDAR_ID }),
      expect.any(String),
    );
  });

  it("emits one infra alert when an equity close market is outside calendar coverage", () => {
    const metrics = { writeCounter: vi.fn() } as any;
    const infraAlert = vi.fn();
    const service = new RuntimeEffectiveResolutionService(repo(), metrics, infraAlert);

    const market = {
      slug: "will-meta-close-between-560-and-570-week-january-9-2037",
      eventSlug: "meta-weekly-close",
      question: "Will Meta (META) close at $560-$570 on January 9?",
      endDate: "2037-01-09T21:00:00.000Z",
      groupItemTitle: null,
      tags: ["stocks", "price-range"],
    };
    service.resolve(market);
    service.resolve(market);

    expect(metrics.writeCounter).toHaveBeenCalledWith(
      "effective_resolution_calendar_miss_total",
      1,
      JSON.stringify({ calendar_id: US_EQUITY_CALENDAR_ID }),
    );
    expect(infraAlert).toHaveBeenCalledTimes(1);
    expect(infraAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "EFFECTIVE_RESOLUTION_CALENDAR_MISSING",
        severity: "error",
      }),
    );
  });
});
