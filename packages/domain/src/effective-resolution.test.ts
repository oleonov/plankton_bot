import { describe, expect, it } from "vitest";
import {
  US_EQUITY_CALENDAR_ID,
  resolveEffectiveResolutionAt,
  tradingCalendarCoverageDaysRemaining,
  zonedLocalDateTimeToUtc,
  type TradingCalendarException,
  type TradingCalendarMetadata,
  type TradingCalendarReader,
} from "./effective-resolution.js";

const METADATA: TradingCalendarMetadata = {
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

function reader(exceptions: TradingCalendarException[] = [], metadata = METADATA) {
  const byDate = new Map(exceptions.map((entry) => [entry.date, entry]));
  return {
    findException: (calendarId, date) =>
      calendarId === US_EQUITY_CALENDAR_ID ? (byDate.get(date) ?? null) : null,
    getMetadata: (calendarId) => (calendarId === US_EQUITY_CALENDAR_ID ? metadata : null),
  } satisfies TradingCalendarReader;
}

function exception(
  date: string,
  status: "closed" | "early_close",
  overrides: Partial<TradingCalendarException> = {},
): TradingCalendarException {
  return {
    calendarId: US_EQUITY_CALENDAR_ID,
    date,
    status,
    timezone: "America/New_York",
    openTimeLocal: status === "early_close" ? "09:30" : null,
    closeTimeLocal: status === "early_close" ? "13:00" : null,
    reason: status,
    source: "test",
    sourceUrl: null,
    verificationStatus: "verified_official",
    verifiedAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

const META_MARKET = {
  slug: "will-meta-close-between-560-and-570-week-june-19-2026",
  eventSlug: "meta-weekly-close-june-19-2026",
  question: "Will Meta (META) close at $560-$570 on June 19?",
  endDate: "2026-06-19T20:00:00.000Z",
  groupItemTitle: null,
  tags: ["stocks", "price-range"],
};

describe("effective resolution", () => {
  it("resolves Meta Juneteenth 2026 to the previous regular US equity close", () => {
    const resolved = resolveEffectiveResolutionAt({
      market: META_MARKET,
      calendar: reader([exception("2026-06-19", "closed", { reason: "Juneteenth" })]),
    });

    expect(resolved).toMatchObject({
      source: "us_equity_calendar",
      calendarId: US_EQUITY_CALENDAR_ID,
      confidence: "high",
      reason: "regular_session",
      marketClass: "US_EQUITY_CLOSE",
      calendarCoverageMissing: false,
    });
    expect(resolved.effectiveResolutionAt?.toISOString()).toBe("2026-06-18T20:00:00.000Z");
    expect(resolved.deltaHours).toBe(-24);
  });

  it("keeps a normal stock Friday at same-day 16:00 ET", () => {
    const resolved = resolveEffectiveResolutionAt({
      market: { ...META_MARKET, endDate: "2026-06-12T20:00:00.000Z" },
      calendar: reader(),
    });

    expect(resolved.effectiveResolutionAt?.toISOString()).toBe("2026-06-12T20:00:00.000Z");
    expect(resolved.reason).toBe("regular_session");
  });

  it("classifies ticker-less S&P 500 close markets even when Gamma tags are missing", () => {
    const resolved = resolveEffectiveResolutionAt({
      market: {
        slug: "will-the-sp-500-close-above-6000-on-june-19",
        eventSlug: "sp-500-june-19",
        question: "Will the S&P 500 close above 6000 on June 19?",
        endDate: "2026-06-19T20:00:00.000Z",
        groupItemTitle: null,
        tags: [],
      },
      calendar: reader([exception("2026-06-19", "closed", { reason: "Juneteenth" })]),
    });

    expect(resolved.marketClass).toBe("US_EQUITY_CLOSE");
    expect(resolved.source).toBe("us_equity_calendar");
    expect(resolved.effectiveResolutionAt?.toISOString()).toBe("2026-06-18T20:00:00.000Z");
  });

  it("uses explicit early close time and standard-time UTC offset", () => {
    const resolved = resolveEffectiveResolutionAt({
      market: { ...META_MARKET, endDate: "2026-11-27T21:00:00.000Z" },
      calendar: reader([
        exception("2026-11-27", "early_close", { reason: "Thanksgiving early close" }),
      ]),
    });

    expect(resolved.effectiveResolutionAt?.toISOString()).toBe("2026-11-27T18:00:00.000Z");
    expect(resolved.reason).toBe("Thanksgiving early close");
  });

  it("leaves crypto range markets on nominal endDate", () => {
    const resolved = resolveEffectiveResolutionAt({
      market: {
        slug: "will-the-price-of-bitcoin-be-between-84000-85000-on-june-19",
        eventSlug: "bitcoin-june-19",
        question: "Will Bitcoin be between $84,000 and $85,000 on June 19?",
        endDate: "2026-06-19T20:00:00.000Z",
        groupItemTitle: null,
        tags: ["crypto", "price-range"],
      },
      calendar: reader([exception("2026-06-19", "closed")]),
    });

    expect(resolved.source).toBe("nominal");
    expect(resolved.marketClass).toBe("OTHER");
    expect(resolved.effectiveResolutionAt?.toISOString()).toBe("2026-06-19T20:00:00.000Z");
  });

  it("does not classify crypto close markets as US equity", () => {
    const resolved = resolveEffectiveResolutionAt({
      market: {
        slug: "will-bitcoin-close-above-100000-on-june-19",
        eventSlug: "bitcoin-june-19",
        question: "Will Bitcoin close above $100,000 on June 19?",
        endDate: "2026-06-19T20:00:00.000Z",
        groupItemTitle: null,
        tags: ["crypto"],
      },
      calendar: reader([exception("2026-06-19", "closed")]),
    });

    expect(resolved.source).toBe("nominal");
    expect(resolved.marketClass).toBe("OTHER");
  });

  it("fails closed when US equity calendar coverage is missing", () => {
    const resolved = resolveEffectiveResolutionAt({
      market: { ...META_MARKET, endDate: "2037-01-09T21:00:00.000Z" },
      calendar: reader(),
    });

    expect(resolved).toMatchObject({
      source: "us_equity_calendar",
      confidence: "low",
      reason: "calendar_coverage_missing",
      calendarCoverageMissing: true,
    });
    expect(resolved.effectiveResolutionAt).toBeNull();
  });

  it("converts New York local session close independent of process timezone", () => {
    expect(zonedLocalDateTimeToUtc("2026-06-18", "16:00", "America/New_York").toISOString()).toBe(
      "2026-06-18T20:00:00.000Z",
    );
    expect(zonedLocalDateTimeToUtc("2026-11-27", "13:00", "America/New_York").toISOString()).toBe(
      "2026-11-27T18:00:00.000Z",
    );
  });

  it("computes verified coverage days in exchange timezone", () => {
    expect(tradingCalendarCoverageDaysRemaining(METADATA, "2027-06-30T12:00:00.000Z")).toBe(550);
  });
});
