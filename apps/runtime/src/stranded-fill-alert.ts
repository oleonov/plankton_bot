import type { RiskEventRepository } from "@krabs/domain";
import type { Logger } from "./logger.js";

export const STRANDED_FILL_ALERT_CODE = "UNRECONCILED_FILLS_STRANDED";
export const STRANDED_FILL_EVENT_TYPE = "unreconciled_fills_stranded";
export const STRANDED_FILL_ALERT_COOLDOWN_MS = 30 * 60_000;

export interface UnreconciledState {
  count: number;
  oldestAgeMs: number;
  stale: boolean;
}

export type StrandedFillAlertEmitter = (state: UnreconciledState, nowMs: number) => void;

export const discardStrandedFillAlert: StrandedFillAlertEmitter = () => {};

type InfraAlertInput = {
  code: string;
  severity: "warning" | "error";
  source: string;
  message: string;
  details?: Record<string, unknown>;
};

export function composeStrandedFillAlertEmitter(deps: {
  riskEventRepo: RiskEventRepository;
  recordInfraAlert: (alert: InfraAlertInput) => void;
  log: Pick<Logger, "warn">;
}): StrandedFillAlertEmitter {
  let lastAlertAt: number | undefined;
  return (state, nowMs) => {
    if (
      !state.stale ||
      (lastAlertAt !== undefined && nowMs - lastAlertAt < STRANDED_FILL_ALERT_COOLDOWN_MS)
    )
      return;
    let delivered = 0;
    for (const [name, deliver] of [
      [
        "risk_event",
        () =>
          deps.riskEventRepo.insert({
            eventType: STRANDED_FILL_EVENT_TYPE,
            payload: { count: state.count, oldestAgeMs: state.oldestAgeMs, nowMs },
          }),
      ],
      [
        "infra_alert",
        () =>
          deps.recordInfraAlert({
            code: STRANDED_FILL_ALERT_CODE,
            severity: "error",
            source: "risk-inventory",
            message: `${state.count} unreconciled fill(s), oldest ${Math.round(state.oldestAgeMs / 60_000)}m`,
            details: { count: state.count, oldestAgeMs: state.oldestAgeMs },
          }),
      ],
    ] as const) {
      try {
        deliver();
        delivered++;
      } catch (err) {
        deps.log.warn({ err, sink: name }, "stranded-fill alert sink failed");
      }
    }
    if (delivered === 2) lastAlertAt = nowMs;
  };
}
