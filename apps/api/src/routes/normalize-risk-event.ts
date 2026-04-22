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

const EVENT_RULES: Record<string, EventRule> = {
  max_exposure_breach: {
    severity: "critical",
    summary: (p) => `Exposure breach: $${p.currentExposure ?? "?"} > $${p.limit ?? "?"}`,
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
  // Legacy/deprecated event types — kept for backward-compat so historical rows
  // in risk_events render with a readable summary and sensible severity.
  // These types are no longer emitted by the runtime, but preserve the
  // original operator-facing fields (source, previousState, newState) so that
  // auto-demotion transitions like `scaled -> reduce-only` stay visible in the
  // UI/API when browsing history.
  family_quarantined: {
    severity: "critical",
    summary: (p) => summarizeLegacyFamilyMode(p, "quarantine"),
  },
  family_reduce_only: {
    severity: "warning",
    summary: (p) => summarizeLegacyFamilyMode(p, "reduce-only"),
  },
  family_activated: {
    severity: "info",
    summary: (p) => summarizeLegacyFamilyMode(p, "active"),
  },
  stale_signal: {
    severity: "warning",
    summary: (p) => `Stale signal: ${p.signalName ?? "unknown"}`,
  },
};

function summarizeLegacyFamilyMode(payload: Record<string, unknown>, targetState: string): string {
  const reason = typeof payload.reason === "string" ? payload.reason : "no reason";
  const source = typeof payload.source === "string" ? payload.source : null;
  const previousState =
    typeof payload.previousState === "string" && payload.previousState.length > 0
      ? payload.previousState
      : null;
  const newState =
    typeof payload.newState === "string" && payload.newState.length > 0
      ? payload.newState
      : targetState;

  // Canonical historical shape for auto-demotion used source:"system" together
  // with previousState/newState. Preserve that exact rendering so historical
  // rows keep the `auto-demoted <from> -> <to>: <reason>` operator context.
  if (source === "system") {
    const transition = previousState ? `${previousState} -> ${newState}` : newState;
    return `auto-demoted ${transition}: ${reason}`;
  }

  if (previousState && previousState !== newState) {
    return `${previousState} -> ${newState}: ${reason}`;
  }

  if (targetState === "quarantine") return `quarantined: ${reason}`;
  if (targetState === "active") return `activated: ${reason}`;
  return `set to ${newState}: ${reason}`;
}

export function normalizeRiskEvent(row: RawRiskEvent): RiskEventDTO {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;

  const rule = EVENT_RULES[row.event_type];
  const severity: SeverityLevel = rule?.severity ?? "info";
  const summary = rule ? rule.summary(payload) : `${row.event_type} on system`;

  return {
    id: row.id,
    eventType: row.event_type,
    summary,
    severity,
    createdAt: row.created_at,
  };
}
