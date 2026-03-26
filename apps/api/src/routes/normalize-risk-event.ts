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

const EVENT_RULES: Record<string, EventRule> = {
  family_quarantined: {
    severity: "critical",
    summary: (fid, p) => `${fid ?? "unknown"} quarantined: ${p.reason ?? "no reason"}`,
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
    summary: (fid, p) =>
      `${fid ?? "unknown"}: ${p.reasonCode ?? "rejected"} — ${p.rawReason ?? ""}`,
  },
  family_reduce_only: {
    severity: "warning",
    summary: (fid, p) => `${fid ?? "unknown"} set to reduce-only: ${p.reason ?? "no reason"}`,
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
