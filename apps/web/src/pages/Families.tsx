import { useState } from "react";
import { useFamilies } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { FamilyActions } from "../components/FamilyActions.tsx";

export function Families() {
  const { data: families, isLoading } = useFamilies();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isLoading) return <div className="page">Loading...</div>;

  return (
    <div className="page">
      <div className="page-title">Families</div>
      <table>
        <thead>
          <tr><th>Family</th><th>Mode</th><th>Open Value</th><th>Positions</th><th>Tail Cost</th><th>Tail-Adj PnL</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {families?.map((f) => {
            const mode = f.state?.runtimeMode ?? "unknown";
            return (
              <tr
                key={f.familyId}
                style={mode === "quarantined" ? { background: "rgba(239,83,80,0.06)" } : undefined}
                onClick={() => setExpanded(expanded === f.familyId ? null : f.familyId)}
              >
                <td style={{ cursor: "pointer", color: "var(--blue)" }}>{f.familyKey}</td>
                <td><Badge value={mode} type="mode" /></td>
                <td>${(f.state?.openValueUsdc ?? 0).toFixed(2)}</td>
                <td>{f.state?.openPositionCount ?? 0} ({f.state?.dustPositionCount ?? 0} dust)</td>
                <td style={{ color: "var(--orange)" }}>${(f.state?.currentTailCostUsdc ?? 0).toFixed(2)}</td>
                <td style={{ color: (f.state?.tailAdjustedPnlLive ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                  {(f.state?.tailAdjustedPnlLive ?? 0) >= 0 ? "+" : ""}${(f.state?.tailAdjustedPnlLive ?? 0).toFixed(2)}
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <FamilyActions familyId={f.familyId} mode={mode} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
