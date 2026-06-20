import type { NormalizedMarket } from "./types.js";

export const US_EQUITY_CALENDAR_ID = "US_EQUITY";
export const US_EQUITY_TIMEZONE = "America/New_York";
export const US_EQUITY_REGULAR_CLOSE_LOCAL = "16:00";
export const US_EQUITY_REGULAR_OPEN_LOCAL = "09:30";

export type TradingCalendarStatus = "closed" | "early_close";
export type TradingCalendarVerificationStatus = "verified_official" | "provisional";
export type EffectiveResolutionSource = "nominal" | "us_equity_calendar";
export type EffectiveResolutionConfidence = "high" | "medium" | "low";
export type EffectiveResolutionMarketClass = "US_EQUITY_CLOSE" | "OTHER";

export interface TradingCalendarException {
  readonly calendarId: string;
  readonly date: string;
  readonly status: TradingCalendarStatus;
  readonly timezone: string;
  readonly openTimeLocal: string | null;
  readonly closeTimeLocal: string | null;
  readonly reason: string;
  readonly source: string;
  readonly sourceUrl: string | null;
  readonly verificationStatus: TradingCalendarVerificationStatus;
  readonly verifiedAt: string | null;
  readonly updatedAt: string;
}

export interface TradingCalendarMetadata {
  readonly calendarId: string;
  readonly timezone: string;
  readonly regularOpenTimeLocal: string;
  readonly regularCloseTimeLocal: string;
  readonly verifiedThroughDate: string;
  readonly provisionalThroughDate: string | null;
  readonly source: string;
  readonly sourceUrl: string | null;
  readonly updatedAt: string;
}

export interface TradingCalendarReader {
  findException(calendarId: string, date: string): TradingCalendarException | null;
  getMetadata(calendarId: string): TradingCalendarMetadata | null;
}

export type EffectiveResolutionMarketInput = Pick<
  NormalizedMarket,
  "slug" | "eventSlug" | "question" | "endDate" | "groupItemTitle" | "tags"
>;

export interface EffectiveResolutionInput {
  readonly market: EffectiveResolutionMarketInput;
  readonly nominalEndDate?: string | Date | null;
  readonly calendar: TradingCalendarReader;
}

export interface EffectiveResolutionResult {
  readonly effectiveResolutionAt: Date | null;
  readonly source: EffectiveResolutionSource;
  readonly calendarId: string | null;
  readonly confidence: EffectiveResolutionConfidence;
  readonly reason: string;
  readonly nominalEndDate: Date | null;
  readonly deltaHours: number | null;
  readonly marketClass: EffectiveResolutionMarketClass;
  readonly calendarCoverageMissing: boolean;
}

const HIGH_CONFIDENCE_CLOSE_SLUG =
  /(?:^|-)close-(?:at|above|below|between|under|over|greater-than|less-than)-/i;
const HIGH_CONFIDENCE_CLOSE_QUESTION =
  /\bclose(?:s)?\s+(?:at|above|below|between|under|over|greater than|less than)\s+\$?\d/i;
const TICKER_PARENS = /\([A-Z][A-Z0-9.]{0,5}\)/;
const EQUITY_INDEX_TEXT =
  /\b(?:s&p\s*500|spx|spy|nasdaq\s*100|ndx|qqq|dow\s*jones|dow|dji|dia|russell\s*2000|rut|iwm)\b/i;
const EQUITY_TAGS = new Set([
  "stock",
  "stocks",
  "equity",
  "equities",
  "etf",
  "etfs",
  "index",
  "indices",
  "nasdaq",
  "nyse",
  "s&p",
  "sp500",
  "finance",
]);
const CRYPTO_TEXT =
  /\b(?:btc|bitcoin|eth|ethereum|solana|sol|xrp|doge|crypto|cryptocurrency)\b/i;

export function classifyEffectiveResolutionMarket(
  market: Omit<EffectiveResolutionMarketInput, "endDate">,
): EffectiveResolutionMarketClass {
  const text = `${market.slug} ${market.eventSlug ?? ""} ${market.question ?? ""} ${
    market.groupItemTitle ?? ""
  }`;
  if (CRYPTO_TEXT.test(text)) return "OTHER";
  const tagSignal =
    market.tags?.some((tag) => EQUITY_TAGS.has(tag.trim().toLowerCase())) ?? false;
  const closeSignal =
    HIGH_CONFIDENCE_CLOSE_SLUG.test(market.slug) ||
    HIGH_CONFIDENCE_CLOSE_QUESTION.test(market.question ?? "");
  const equitySignal =
    tagSignal || TICKER_PARENS.test(market.question ?? "") || EQUITY_INDEX_TEXT.test(text);
  return closeSignal && equitySignal ? "US_EQUITY_CLOSE" : "OTHER";
}

export function resolveEffectiveResolutionAt(
  input: EffectiveResolutionInput,
): EffectiveResolutionResult {
  const nominalEndDate = parseDate(input.nominalEndDate ?? input.market.endDate);
  const marketClass = classifyEffectiveResolutionMarket(input.market);
  if (marketClass !== "US_EQUITY_CLOSE") {
    return {
      effectiveResolutionAt: nominalEndDate,
      source: "nominal",
      calendarId: null,
      confidence: nominalEndDate == null ? "low" : "high",
      reason: "non_us_equity_market",
      nominalEndDate,
      deltaHours: 0,
      marketClass,
      calendarCoverageMissing: false,
    };
  }

  if (nominalEndDate == null) {
    return lowConfidenceMissing("missing_nominal_end_date", null, marketClass);
  }

  const metadata = input.calendar.getMetadata(US_EQUITY_CALENDAR_ID);
  if (metadata == null) {
    return lowConfidenceMissing("calendar_metadata_missing", nominalEndDate, marketClass);
  }
  if (!isCoveredByCalendar(nominalEndDate, metadata)) {
    return lowConfidenceMissing("calendar_coverage_missing", nominalEndDate, marketClass);
  }

  const nominalLocalDate = dateInTimeZone(nominalEndDate, metadata.timezone);
  const session = findLastOpenSession({
    calendar: input.calendar,
    metadata,
    calendarId: US_EQUITY_CALENDAR_ID,
    localDate: nominalLocalDate,
  });
  if (session == null) {
    return lowConfidenceMissing("calendar_open_session_missing", nominalEndDate, marketClass);
  }

  const effectiveResolutionAt = zonedLocalDateTimeToUtc(
    session.date,
    session.closeTimeLocal,
    metadata.timezone,
  );
  const deltaHours = (effectiveResolutionAt.getTime() - nominalEndDate.getTime()) / 3_600_000;
  return {
    effectiveResolutionAt,
    source: "us_equity_calendar",
    calendarId: US_EQUITY_CALENDAR_ID,
    confidence:
      compareLocalDates(session.date, metadata.verifiedThroughDate) <= 0 ? "high" : "medium",
    reason: session.reason,
    nominalEndDate,
    deltaHours,
    marketClass,
    calendarCoverageMissing: false,
  };
}

export function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = part(parts, "year");
  const month = part(parts, "month");
  const day = part(parts, "day");
  return `${year}-${month}-${day}`;
}

export function zonedLocalDateTimeToUtc(
  localDate: string,
  localTime: string,
  timeZone: string,
): Date {
  const { year, month, day } = parseLocalDate(localDate);
  const { hour, minute } = parseLocalTime(localTime);
  const desiredUtcLikeMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidateMs = desiredUtcLikeMs;
  for (let i = 0; i < 4; i++) {
    const observed = localPartsForUtc(candidateMs, timeZone);
    const observedUtcLikeMs = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
      0,
    );
    const offsetMs = observedUtcLikeMs - candidateMs;
    const nextMs = desiredUtcLikeMs - offsetMs;
    if (Math.abs(nextMs - candidateMs) < 1) return new Date(nextMs);
    candidateMs = nextMs;
  }
  return new Date(candidateMs);
}

export function tradingCalendarCoverageDaysRemaining(
  metadata: TradingCalendarMetadata,
  now: Date | number | string,
): number {
  const nowDate = dateInTimeZone(parseRequiredDate(now, "calendar coverage now"), metadata.timezone);
  const nowUtc = localDateToUtcDayMs(nowDate);
  const verifiedUtc = localDateToUtcDayMs(metadata.verifiedThroughDate);
  return Math.floor((verifiedUtc - nowUtc) / 86_400_000);
}

function lowConfidenceMissing(
  reason: string,
  nominalEndDate: Date | null,
  marketClass: EffectiveResolutionMarketClass,
): EffectiveResolutionResult {
  return {
    effectiveResolutionAt: null,
    source: "us_equity_calendar",
    calendarId: US_EQUITY_CALENDAR_ID,
    confidence: "low",
    reason,
    nominalEndDate,
    deltaHours: null,
    marketClass,
    calendarCoverageMissing: true,
  };
}

function findLastOpenSession(args: {
  calendar: TradingCalendarReader;
  metadata: TradingCalendarMetadata;
  calendarId: string;
  localDate: string;
}): { date: string; closeTimeLocal: string; reason: string } | null {
  let date = args.localDate;
  for (let i = 0; i < 14; i++) {
    const exception = args.calendar.findException(args.calendarId, date);
    if (exception?.status === "early_close" && exception.closeTimeLocal != null) {
      return { date, closeTimeLocal: exception.closeTimeLocal, reason: exception.reason };
    }
    if (!isWeekend(date) && exception?.status !== "closed") {
      return { date, closeTimeLocal: args.metadata.regularCloseTimeLocal, reason: "regular_session" };
    }
    date = addLocalDays(date, -1);
  }
  return null;
}

function isCoveredByCalendar(date: Date, metadata: TradingCalendarMetadata): boolean {
  const localDate = dateInTimeZone(date, metadata.timezone);
  const through = metadata.provisionalThroughDate ?? metadata.verifiedThroughDate;
  return compareLocalDates(localDate, through) <= 0;
}

function parseDate(value: string | Date | number | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function parseRequiredDate(value: string | Date | number, label: string): Date {
  const date = parseDate(value);
  if (date == null) throw new Error(`Invalid ${label}`);
  return date;
}

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

function localPartsForUtc(
  utcMs: number,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcMs));
  return {
    year: Number(part(parts, "year")),
    month: Number(part(parts, "month")),
    day: Number(part(parts, "day")),
    hour: Number(part(parts, "hour")),
    minute: Number(part(parts, "minute")),
    second: Number(part(parts, "second")),
  };
}

function parseLocalDate(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match == null) throw new Error(`Invalid local calendar date: ${value}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function parseLocalTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match == null) throw new Error(`Invalid local calendar time: ${value}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function isWeekend(localDate: string): boolean {
  const { year, month, day } = parseLocalDate(localDate);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function addLocalDays(localDate: string, days: number): string {
  const { year, month, day } = parseLocalDate(localDate);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

function localDateToUtcDayMs(localDate: string): number {
  const { year, month, day } = parseLocalDate(localDate);
  return Date.UTC(year, month - 1, day);
}

function compareLocalDates(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
