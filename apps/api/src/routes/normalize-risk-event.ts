/**
 * Normalizes raw risk_events rows into operator-facing DTOs.
 * Shared by GET /risk-events and SSE risk:event.
 */

export interface RiskEventDTO {
  id: number;
  eventType: string;
  familyId: string | null;
  summary: string;
  severity: "critical" | "warning" | "info";
  createdAt: string;
}

interface RawRiskEvent {
  id: number;
  event_type: string;
  family_id: string | null;
  payload: string; // NOT NULL in DB schema
  created_at: string;
}

type SeverityLevel = "critical" | "warning" | "info";

interface EventRule {
  severity: SeverityLevel;
  summary: (familyId: string | null, payload: Record<string, unknown>) => string;
}

function summarizeFamilyModeEvent(
  familyId: string | null,
  payload: Record<string, unknown>,
  targetState: string,
): string {
  if (payload.source === "system") {
    const previousState =
      typeof payload.previousState === "string" && payload.previousState.length > 0
        ? `${payload.previousState} -> `
        : "";
    return `${familyId ?? "unknown"} auto-demoted ${previousState}${targetState}: ${payload.reason ?? "no reason"}`;
  }

  if (targetState === "quarantine") {
    return `${familyId ?? "unknown"} quarantined: ${payload.reason ?? "no reason"}`;
  }

  return `${familyId ?? "unknown"} set to ${targetState}: ${payload.reason ?? "no reason"}`;
}

const EVENT_RULES: Record<string, EventRule> = {
  family_quarantined: {
    severity: "critical",
    summary: (fid, p) => summarizeFamilyModeEvent(fid, p, "quarantine"),
  },
  max_exposure_breach: {
    severity: "critical",
    summary: (fid, p) =>
      `Exposure breach on ${fid ?? "unknown"}: $${p.currentExposure ?? "?"} > $${p.limit ?? "?"}`,
  },
  stale_signal: {
    severity: "warning",
    summary: (fid, p) => `Stale signal for ${fid ?? "unknown"}: ${p.signalName ?? "unknown"}`,
  },
  reconciliation_drift: {
    severity: "warning",
    summary: (_fid, p) => `Reconciliation drift: ${p.details ?? "detected"}`,
  },
  signal_rejected: {
    severity: "info",
    summary: (fid, p) => {
      // rawReason already contains the human-readable detail (e.g., "dust positions 6 >= max 3")
      // Prefer it over the normalized reasonCode when available
      const reason = (p.rawReason as string) || (p.reasonCode as string) || "rejected";
      return `${fid ?? "unknown"}: ${reason}`;
    },
  },
  family_reduce_only: {
    severity: "warning",
    summary: (fid, p) => summarizeFamilyModeEvent(fid, p, "reduce-only"),
  },
  family_activated: {
    severity: "info",
    summary: (fid, p) => `${fid ?? "unknown"} activated: ${p.reason ?? "no reason"}`,
  },
};

export function normalizeRiskEvent(row: RawRiskEvent): RiskEventDTO {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;

  const rule = EVENT_RULES[row.event_type];
  const severity: SeverityLevel = rule?.severity ?? "info";
  const summary = rule
    ? rule.summary(row.family_id, payload)
    : `${row.event_type} on ${row.family_id ?? "system"}`;

  return {
    id: row.id,
    eventType: row.event_type,
    familyId: row.family_id,
    summary,
    severity,
    createdAt: row.created_at,
  };
}
