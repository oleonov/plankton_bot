/**
 * Normalizes raw risk_events rows into operator-facing DTOs.
 * Shared by GET /risk-events and SSE risk:event.
 */

export interface RiskEventDTO {
  id: number;
  eventType: string;
  summary: string;
  severity: "critical" | "warning" | "info";
  createdAt: string;
}

interface RawRiskEvent {
  id: number;
  event_type: string;
  payload: string; // NOT NULL in DB schema
  created_at: string;
}

type SeverityLevel = "critical" | "warning" | "info";

interface EventRule {
  severity: SeverityLevel;
  summary: (payload: Record<string, unknown>) => string;
}

function summarizeFamilyModeEvent(
  payload: Record<string, unknown>,
  targetState: string,
): string {
  if (payload.source === "system") {
    const previousState =
      typeof payload.previousState === "string" && payload.previousState.length > 0
        ? `${payload.previousState} -> `
        : "";
    return `auto-demoted ${previousState}${targetState}: ${payload.reason ?? "no reason"}`;
  }

  if (targetState === "quarantine") {
    return `quarantined: ${payload.reason ?? "no reason"}`;
  }

  return `set to ${targetState}: ${payload.reason ?? "no reason"}`;
}

const EVENT_RULES: Record<string, EventRule> = {
  family_quarantined: {
    severity: "critical",
    summary: (p) => summarizeFamilyModeEvent(p, "quarantine"),
  },
  max_exposure_breach: {
    severity: "critical",
    summary: (p) =>
      `Exposure breach: $${p.currentExposure ?? "?"} > $${p.limit ?? "?"}`,
  },
  stale_signal: {
    severity: "warning",
    summary: (p) => `Stale signal: ${p.signalName ?? "unknown"}`,
  },
  reconciliation_drift: {
    severity: "warning",
    summary: (p) => `Reconciliation drift: ${p.details ?? "detected"}`,
  },
  signal_rejected: {
    severity: "info",
    summary: (p) => {
      // rawReason already contains the human-readable detail (e.g., "dust positions 6 >= max 3")
      // Prefer it over the normalized reasonCode when available
      const reason = (p.rawReason as string) || (p.reasonCode as string) || "rejected";
      return reason;
    },
  },
  family_reduce_only: {
    severity: "warning",
    summary: (p) => summarizeFamilyModeEvent(p, "reduce-only"),
  },
  family_activated: {
    severity: "info",
    summary: (p) => `activated: ${p.reason ?? "no reason"}`,
  },
};

export function normalizeRiskEvent(row: RawRiskEvent): RiskEventDTO {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;

  const rule = EVENT_RULES[row.event_type];
  const severity: SeverityLevel = rule?.severity ?? "info";
  const summary = rule
    ? rule.summary(payload)
    : `${row.event_type} on system`;

  return {
    id: row.id,
    eventType: row.event_type,
    summary,
    severity,
    createdAt: row.created_at,
  };
}
