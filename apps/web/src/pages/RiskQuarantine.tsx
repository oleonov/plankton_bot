import { useState } from "react";
import { useFamilies, useRiskEvents } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { FamilyActions } from "../components/FamilyActions.tsx";
import { Pagination } from "../components/Pagination.tsx";

export function RiskQuarantine() {
  const { data: families } = useFamilies();
  const [eventFamily, setEventFamily] = useState("");
  const [eventType, setEventType] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();

  const { data: riskEvents } = useRiskEvents({
    familyId: eventFamily || undefined,
    eventType: eventType || undefined,
    limit: 50,
    cursor,
  });

  const attentionFamilies = families?.filter(
    (f) => f.state?.runtimeMode === "quarantined" || f.state?.runtimeMode === "reduce-only"
  ) ?? [];

  return (
    <div className="page">
      {/* Families Requiring Attention */}
      {attentionFamilies.length > 0 && (
        <>
          <div className="page-title">Families Requiring Attention</div>
          <div className="grid-3" style={{ marginBottom: 24 }}>
            {attentionFamilies.map((f) => {
              const mode = f.state?.runtimeMode ?? "unknown";
              return (
                <div key={f.familyId} className={`card ${mode === "quarantined" ? "card-accent-red" : "card-accent-orange"}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 700 }}>{f.familyKey}</span>
                    <Badge value={mode} type="mode" />
                  </div>
                  {f.state?.quarantineReason && (
                    <div className="value-sm" style={{ marginTop: 4 }}>Reason: {f.state.quarantineReason}</div>
                  )}
                  <div className="value-sm">
                    ${(f.state?.openValueUsdc ?? 0).toFixed(2)} open &middot; {f.state?.openPositionCount ?? 0} positions
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <FamilyActions familyId={f.familyId} mode={mode} />
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Recent Risk Events */}
      <div className="page-title">Recent Risk Events</div>
      <div className="filter-bar">
        <select value={eventFamily} onChange={(e) => { setEventFamily(e.target.value); setCursor(undefined); }}>
          <option value="">All families</option>
          {families?.map((f) => <option key={f.familyId} value={f.familyId}>{f.familyKey}</option>)}
        </select>
        <select value={eventType} onChange={(e) => { setEventType(e.target.value); setCursor(undefined); }}>
          <option value="">All types</option>
          <option value="family_quarantined">Quarantined</option>
          <option value="max_exposure_breach">Exposure Breach</option>
          <option value="stale_signal">Stale Signal</option>
          <option value="reconciliation_drift">Recon Drift</option>
        </select>
      </div>
      <table>
        <thead>
          <tr><th>Time</th><th>Type</th><th>Severity</th><th>Family</th><th>Summary</th></tr>
        </thead>
        <tbody>
          {riskEvents?.items.map((e) => (
            <tr key={e.id}>
              <td style={{ fontSize: 11, color: "var(--text-dim)" }}>{new Date(e.createdAt).toLocaleTimeString()}</td>
              <td>{e.eventType}</td>
              <td><Badge value={e.severity} type="severity" /></td>
              <td>{e.familyId ?? "\u2014"}</td>
              <td>{e.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination nextCursor={riskEvents?.nextCursor ?? null} onNext={setCursor} />
    </div>
  );
}
