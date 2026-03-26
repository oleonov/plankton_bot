import { useState, Fragment } from "react";
import { useFamilies, useFamilyPositions, useFamilyOrders } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { FamilyActions } from "../components/FamilyActions.tsx";

function FamilyDetail({ familyId }: { familyId: string }) {
  const { data: positions } = useFamilyPositions(familyId);
  const { data: orders } = useFamilyOrders(familyId);

  return (
    <tr>
      <td colSpan={8} style={{ padding: "8px 16px", background: "var(--bg-elevated)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <div
              style={{ fontWeight: 700, fontSize: 11, marginBottom: 6, color: "var(--text-muted)" }}
            >
              Positions ({positions?.length ?? 0})
            </div>
            {positions && positions.length > 0 ? (
              <table style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Size</th>
                    <th>Value</th>
                    <th>PnL</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.positionId}>
                      <td>{p.tokenId.slice(0, 12)}</td>
                      <td>{p.size.toFixed(2)}</td>
                      <td>
                        {p.currentValueUsdc != null
                          ? `$${p.currentValueUsdc.toFixed(2)}`
                          : "\u2014"}
                      </td>
                      <td style={{ color: p.realizedPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                        {p.realizedPnl >= 0 ? "+" : ""}${p.realizedPnl.toFixed(2)}
                      </td>
                      <td>
                        <Badge value={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>No positions</div>
            )}
          </div>
          <div>
            <div
              style={{ fontWeight: 700, fontSize: 11, marginBottom: 6, color: "var(--text-muted)" }}
            >
              Orders ({orders?.items?.length ?? 0})
            </div>
            {orders?.items && orders.items.length > 0 ? (
              <table style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Side</th>
                    <th>Size</th>
                    <th>Price</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.items.map((o) => (
                    <tr key={o.orderId}>
                      <td>{o.tokenId.slice(0, 12)}</td>
                      <td>{o.side}</td>
                      <td>{o.size.toFixed(2)}</td>
                      <td>${o.price.toFixed(4)}</td>
                      <td>
                        <Badge value={o.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>No orders</div>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function utilizationColor(current: number, max: number): string {
  const pct = current / max;
  if (pct > 0.9) return "var(--red)";
  if (pct > 0.7) return "var(--orange)";
  return "var(--text)";
}

export function Families() {
  const { data: families, isLoading } = useFamilies();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (isLoading) return <div className="page">Loading...</div>;

  return (
    <div className="page">
      <div className="page-title">Families</div>
      <table>
        <thead>
          <tr>
            <th>Family</th>
            <th>Mode</th>
            <th>Open Value</th>
            <th>Positions</th>
            <th>Markets</th>
            <th>Tail Cost</th>
            <th>Tail-Adj PnL</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {families?.map((f) => {
            const operatorMode = f.state?.runtimeMode ?? "unknown";
            const displayMode = f.state?.effectiveMode ?? operatorMode;
            const isExpanded = expanded === f.familyId;
            return (
              <Fragment key={f.familyId}>
                <tr
                  style={operatorMode === "quarantine" ? { background: "rgba(239,83,80,0.06)" } : undefined}
                  onClick={() => setExpanded(isExpanded ? null : f.familyId)}
                >
                  <td style={{ cursor: "pointer", color: "var(--blue)" }}>
                    {isExpanded ? "\u25BC" : "\u25B6"} {f.familyKey}
                  </td>
                  <td>
                    <Badge value={operatorMode} type="mode" />
                    {f.state?.effectiveMode && f.state.effectiveMode !== operatorMode && (
                      <div style={{ fontSize: 10, color: "var(--orange)", marginTop: 2 }}>
                        eff: {displayMode}
                        {f.state.derivedModeReason && ` — ${f.state.derivedModeReason}`}
                      </div>
                    )}
                  </td>
                  <td style={{ color: f.caps ? utilizationColor(f.state?.openValueUsdc ?? 0, f.caps.maxOpenValueUsdc) : undefined }}>
                    ${(f.state?.openValueUsdc ?? 0).toFixed(0)}
                    {f.caps && <span style={{ color: "var(--text-dim)", fontSize: 11 }}> / ${f.caps.maxOpenValueUsdc}</span>}
                  </td>
                  <td>
                    {f.state?.openPositionCount ?? 0}
                    {f.state?.openDustCount ? ` (${f.state.openDustCount} dust)` : ""}
                  </td>
                  <td style={{ color: f.caps ? utilizationColor(f.state?.activeMarketCount ?? 0, f.caps.maxActiveMarkets) : undefined }}>
                    {f.state?.activeMarketCount ?? 0}
                    {f.caps && <span style={{ color: "var(--text-dim)", fontSize: 11 }}> / {f.caps.maxActiveMarkets}</span>}
                  </td>
                  <td style={{ color: "var(--orange)" }}>
                    ${(f.state?.currentTailCostUsdc ?? 0).toFixed(2)}
                  </td>
                  <td
                    style={{
                      color:
                        (f.state?.tailAdjustedPnlLive ?? 0) >= 0 ? "var(--green)" : "var(--red)",
                    }}
                  >
                    {(f.state?.tailAdjustedPnlLive ?? 0) >= 0 ? "+" : ""}$
                    {(f.state?.tailAdjustedPnlLive ?? 0).toFixed(2)}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <FamilyActions familyId={f.familyId} mode={operatorMode} />
                  </td>
                </tr>
                {isExpanded && <FamilyDetail familyId={f.familyId} />}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
