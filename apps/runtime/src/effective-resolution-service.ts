import {
  STRIKE_MIN_HORIZON_HOURS,
  US_EQUITY_CALENDAR_ID,
  resolveEffectiveResolutionAt,
  tradingCalendarCoverageDaysRemaining,
  type EffectiveResolutionResult,
  type EffectiveResolutionMarketInput,
  type TradingCalendarRepository,
} from "@krabs/domain";
import type { RuntimeMetricWriter } from "./runtime-metric-writer.js";

const COVERAGE_WARNING_DAYS = 548; // ~18 months.

export interface EffectiveResolutionGate {
  resolve(market: EffectiveResolutionMarketInput): EffectiveResolutionResult;
  toPreEntryFields(market: EffectiveResolutionMarketInput): {
    effectiveResolutionAt: string | null;
    effectiveResolutionCalendarMissing: boolean;
  };
  toBuyPlacementFields(market: EffectiveResolutionMarketInput): {
    effectiveResolutionAt: string | null;
    calendarMissing: boolean;
    appliesToBuy: boolean;
    minRunwayHours: number;
  };
  toBuyRunwayFields(
    market: EffectiveResolutionMarketInput,
    now: Date | number | string,
  ): {
    effectiveResolutionAt: string | null;
    effectiveRunwayHours: number | null;
    calendarMissing: boolean;
    appliesToBuy: boolean;
    marketClass: EffectiveResolutionResult["marketClass"];
    confidence: EffectiveResolutionResult["confidence"];
  };
  coverageStatus(now: Date | number | string): {
    daysRemaining: number | null;
    warn: boolean;
    calendarId: string;
  };
  emitCoverageMetric(now: Date | number | string): void;
}

export type EffectiveResolutionInfraAlertSink = (alert: {
  code: string;
  severity: "warning" | "error";
  source: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}) => void;

export class RuntimeEffectiveResolutionService implements EffectiveResolutionGate {
  private calendarMissAlerted = false;

  constructor(
    private readonly calendarRepo: TradingCalendarRepository,
    private readonly metrics?: RuntimeMetricWriter,
    private readonly infraAlert?: EffectiveResolutionInfraAlertSink,
  ) {}

  resolve(market: EffectiveResolutionMarketInput): EffectiveResolutionResult {
    const result = resolveEffectiveResolutionAt({ market, calendar: this.calendarRepo });
    this.recordResolution(result);
    return result;
  }

  toPreEntryFields(market: EffectiveResolutionMarketInput): {
    effectiveResolutionAt: string | null;
    effectiveResolutionCalendarMissing: boolean;
  } {
    const result = this.resolve(market);
    return {
      effectiveResolutionAt: result.effectiveResolutionAt?.toISOString() ?? null,
      effectiveResolutionCalendarMissing: result.calendarCoverageMissing,
    };
  }

  toBuyPlacementFields(market: EffectiveResolutionMarketInput): {
    effectiveResolutionAt: string | null;
    calendarMissing: boolean;
    appliesToBuy: boolean;
    minRunwayHours: number;
  } {
    const result = this.resolve(market);
    return {
      effectiveResolutionAt: result.effectiveResolutionAt?.toISOString() ?? null,
      calendarMissing: result.calendarCoverageMissing,
      appliesToBuy: result.marketClass === "US_EQUITY_CLOSE",
      minRunwayHours: STRIKE_MIN_HORIZON_HOURS,
    };
  }

  toBuyRunwayFields(
    market: EffectiveResolutionMarketInput,
    now: Date | number | string,
  ): {
    effectiveResolutionAt: string | null;
    effectiveRunwayHours: number | null;
    calendarMissing: boolean;
    appliesToBuy: boolean;
    marketClass: EffectiveResolutionResult["marketClass"];
    confidence: EffectiveResolutionResult["confidence"];
  } {
    const result = this.resolve(market);
    const nowDate = parseNow(now);
    return {
      effectiveResolutionAt: result.effectiveResolutionAt?.toISOString() ?? null,
      effectiveRunwayHours:
        result.effectiveResolutionAt == null
          ? null
          : (result.effectiveResolutionAt.getTime() - nowDate.getTime()) / 3_600_000,
      calendarMissing: result.calendarCoverageMissing,
      appliesToBuy: result.marketClass === "US_EQUITY_CLOSE",
      marketClass: result.marketClass,
      confidence: result.confidence,
    };
  }

  coverageStatus(now: Date | number | string): {
    daysRemaining: number | null;
    warn: boolean;
    calendarId: string;
  } {
    const metadata = this.calendarRepo.getMetadata(US_EQUITY_CALENDAR_ID);
    if (metadata == null) {
      return { daysRemaining: null, warn: true, calendarId: US_EQUITY_CALENDAR_ID };
    }
    const daysRemaining = tradingCalendarCoverageDaysRemaining(metadata, now);
    return {
      daysRemaining,
      warn: daysRemaining < COVERAGE_WARNING_DAYS,
      calendarId: metadata.calendarId,
    };
  }

  emitCoverageMetric(now: Date | number | string): void {
    const status = this.coverageStatus(now);
    if (status.daysRemaining != null) {
      this.metrics?.writeLatest(
        "trading_calendar_coverage_days_remaining",
        status.daysRemaining,
        JSON.stringify({ calendar_id: status.calendarId }),
        new Date().toISOString(),
      );
    }
  }

  private recordResolution(result: EffectiveResolutionResult): void {
    const calendarId = result.calendarId ?? "none";
    this.metrics?.writeCounter(
      "effective_resolution_resolved_total",
      1,
      JSON.stringify({
        source: result.source,
        calendar_id: calendarId,
        confidence: result.confidence,
      }),
    );
    if (result.calendarCoverageMissing) {
      this.metrics?.writeCounter(
        "effective_resolution_calendar_miss_total",
        1,
        JSON.stringify({ calendar_id: calendarId }),
      );
      if (!this.calendarMissAlerted) {
        this.calendarMissAlerted = true;
        this.infraAlert?.({
          code: "EFFECTIVE_RESOLUTION_CALENDAR_MISSING",
          severity: "error",
          source: "effective-resolution",
          message:
            "BUY orders blocked: high-confidence US equity close market is outside trading-calendar coverage.",
          details: {
            calendarId,
            reason: result.reason,
            confidence: result.confidence,
          },
        });
      }
    }
    if (result.deltaHours != null && result.source === "us_equity_calendar") {
      this.metrics?.writeCounter(
        "effective_resolution_delta_bucket",
        1,
        JSON.stringify({
          calendar_id: calendarId,
          bucket: bucketDeltaHours(result.deltaHours),
        }),
      );
    }
  }
}

function parseNow(now: Date | number | string): Date {
  const parsed = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(parsed.getTime())) return new Date();
  return parsed;
}

function bucketDeltaHours(deltaHours: number): string {
  const absolute = Math.abs(deltaHours);
  if (absolute < 1e-9) return "0h";
  if (absolute <= 3) return "<=3h";
  if (absolute <= 12) return "<=12h";
  if (absolute <= 24) return "<=24h";
  if (absolute <= 72) return "<=72h";
  return ">72h";
}
