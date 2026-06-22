import {
  DEFAULT_FEE_SCHEDULE_CONFIG,
  selectFeeSchedulePeriod,
  type FeeScheduleConfig,
  type FeeScheduleProvider,
  type FeeScheduleQuote,
  type FeeScheduleRequest,
  type MarketFeeInfo,
  type MarketFeeInfoDiagnostic,
  type MarketFeeInfoResult,
  type MarketFeeInfoStatus,
} from "@krabs/domain";

type FeeGateway = {
  getMarketFeeInfo?: (conditionId: string) => Promise<MarketFeeInfo | null>;
  getMarketFeeInfoResult?: (conditionId: string) => Promise<MarketFeeInfoResult>;
};

type RuntimeMetrics = {
  writeCounter?: (metricName: string, value?: number, labels?: string | null) => void;
  writeEvent?: (
    metricName: string,
    value?: number,
    labels?: string | null,
    capturedAt?: string,
  ) => void;
  writeLatest?: (
    metricName: string,
    value?: number,
    labels?: string | null,
    capturedAt?: string,
  ) => void;
};

export interface HybridFeeScheduleProviderDeps {
  feeGateway: FeeGateway;
  runtimeMetrics?: RuntimeMetrics | undefined;
  nowMs?: () => number;
}

export function createHybridFeeScheduleProvider(
  deps: HybridFeeScheduleProviderDeps,
): FeeScheduleProvider {
  let lastDegradedEventAtMs = Number.NEGATIVE_INFINITY;
  let lastActivePeriodMetricKey: string | null = null;
  const nowMs = () => deps.nowMs?.() ?? Date.now();

  return {
    resolve: async (request: FeeScheduleRequest): Promise<FeeScheduleQuote> => {
      const config = request.config ?? DEFAULT_FEE_SCHEDULE_CONFIG;
      const period = config.enabled ? selectFeeSchedulePeriod(config, request) : null;
      const asOfMs = Number.isFinite(request.asOfMs) ? request.asOfMs : nowMs();
      const makerRebateFraction = 0;
      if (period) {
        const labels = JSON.stringify({ periodId: period.periodId });
        const metricKey = `${period.periodId}|${period.startsAtUtc}|${period.endsAtUtc ?? ""}`;
        if (metricKey !== lastActivePeriodMetricKey) {
          lastActivePeriodMetricKey = metricKey;
          if (deps.runtimeMetrics?.writeLatest) {
            deps.runtimeMetrics.writeLatest(
              "fee_schedule_active_period",
              1,
              labels,
              new Date(asOfMs).toISOString(),
            );
          } else {
            deps.runtimeMetrics?.writeCounter?.("fee_schedule_active_period_total", 1, labels);
          }
        }
      }

      if (
        config.apiPrimaryEnabled &&
        request.conditionId &&
        (deps.feeGateway.getMarketFeeInfoResult || deps.feeGateway.getMarketFeeInfo)
      ) {
        try {
          const result = await resolveMarketFeeInfo(deps.feeGateway, request.conditionId);
          const info = result.info;
          if (info && Number.isFinite(info.rate) && Number.isFinite(info.exponent)) {
            deps.runtimeMetrics?.writeCounter?.("fee_schedule_provider_api_success", 1);
            deps.runtimeMetrics?.writeCounter?.(
              "fee_schedule_provider_source",
              1,
              JSON.stringify({ source: period ? "mixed" : "api" }),
            );
            return {
              baseRate: info.rate,
              exponent: info.exponent,
              takerOnly: info.takerOnly,
              makerRebateFraction,
              source: period ? "mixed" : "api",
              periodId: period?.periodId ?? "api_fd_no_schedule",
              effectiveAtMs: period ? Date.parse(period.startsAtUtc) : asOfMs,
              validUntilMs: period?.endsAtUtc ? Date.parse(period.endsAtUtc) : null,
              // v1 exposes TTL metadata for future provider caches; it does not cache quotes.
              ttlMs: config.apiTtlMs,
              confidence: "high",
              warnings: period ? [] : ["no_active_fee_schedule_period"],
            };
          }
          recordDegraded(result.status === "ok" ? "api_invalid_fee_info" : result.status, config, {
            diagnostic: result.diagnostic,
          });
        } catch {
          recordDegraded("api_error", config);
        }
      }

      if (period && config.scheduleFallbackEnabled) {
        deps.runtimeMetrics?.writeCounter?.("fee_schedule_provider_schedule_fallback", 1);
        deps.runtimeMetrics?.writeCounter?.(
          "fee_schedule_provider_source",
          1,
          JSON.stringify({ source: "schedule" }),
        );
        return {
          baseRate: period.baseRate ?? 0,
          exponent: period.exponent ?? 1,
          takerOnly: period.takerOnly ?? false,
          makerRebateFraction,
          source: "schedule",
          periodId: period.periodId,
          effectiveAtMs: Date.parse(period.startsAtUtc),
          validUntilMs: period.endsAtUtc ? Date.parse(period.endsAtUtc) : null,
          ttlMs: null,
          confidence: "medium",
          warnings: ["api_fee_info_unavailable"],
        };
      }

      deps.runtimeMetrics?.writeCounter?.(
        "fee_schedule_provider_source",
        1,
        JSON.stringify({ source: "fallback" }),
      );
      return {
        baseRate: 0,
        exponent: 1,
        takerOnly: false,
        makerRebateFraction: 0,
        source: "fallback",
        periodId: period ? "fallback_schedule_disabled" : "fallback_no_schedule",
        effectiveAtMs: asOfMs,
        validUntilMs: null,
        ttlMs: null,
        confidence: "low",
        warnings: period
          ? ["schedule_fallback_disabled", "api_fee_info_unavailable"]
          : ["no_active_fee_schedule_period"],
      };
    },
  };

  async function resolveMarketFeeInfo(
    feeGateway: FeeGateway,
    conditionId: string,
  ): Promise<MarketFeeInfoResult> {
    if (feeGateway.getMarketFeeInfoResult) {
      return feeGateway.getMarketFeeInfoResult(conditionId);
    }
    const info = await feeGateway.getMarketFeeInfo?.(conditionId);
    return {
      status: info ? "ok" : "api_no_fee_info",
      info: info ?? null,
      diagnostic: {
        fieldShape: info ? "fd" : "unknown",
        fdPresent: !!info,
        takerBaseFeePresent: false,
        makerBaseFeePresent: false,
        message: info
          ? "legacy getMarketFeeInfo returned info"
          : "legacy getMarketFeeInfo returned null",
      },
    };
  }

  function recordDegraded(
    reason: MarketFeeInfoStatus,
    config: FeeScheduleConfig,
    opts: { diagnostic?: MarketFeeInfoDiagnostic | undefined } = {},
  ): void {
    const labels = JSON.stringify({
      reason,
      ...(opts.diagnostic ? { fieldShape: opts.diagnostic.fieldShape } : {}),
    });
    deps.runtimeMetrics?.writeCounter?.("fee_schedule_provider_api_failure", 1, labels);
    const capturedAt = nowMs();
    const cooldownMs = config.degradedEventCooldownMs;
    if (capturedAt - lastDegradedEventAtMs < cooldownMs) return;
    lastDegradedEventAtMs = capturedAt;
    deps.runtimeMetrics?.writeEvent?.(
      "fee_schedule_provider_degraded",
      1,
      labels,
      new Date(capturedAt).toISOString(),
    );
  }
}
