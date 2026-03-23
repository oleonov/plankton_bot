import { useState } from "react";
import { usePositions, useFamilies } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { MarketLink } from "../components/MarketLink.tsx";

export function Positions() {
  const [familyId, setFamilyId] = useState("");
  const [dustOnly, setDustOnly] = useState(false);
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("");

  const { data: positions, isLoading } = usePositions({
    familyId: familyId || undefined,
    dust: dustOnly || undefined,
    status: status || undefined,
    sort: sort || undefined,
  });
  const { data: families } = useFamilies();

  return (
    <div className="page">
      <div className="filter-bar">
        <span style={{ fontWeight: 700 }}>Positions</span>
        <span style={{ color: "var(--text-muted)" }}>({positions?.length ?? 0})</span>
        <select value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
          <option value="">All families</option>
          {families?.map((f) => <option key={f.familyId} value={f.familyId}>{f.familyKey}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="dust">Dust</option>
          <option value="closed">Closed</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={dustOnly} onChange={(e) => setDustOnly(e.target.checked)} />
          Dust only
        </label>
        <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="">Default sort</option>
          <option value="tail_cost">Tail cost desc</option>
        </select>
      </div>

      {isLoading ? <div>Loading...</div> : (
        <table>
          <thead>
            <tr>
              <th>Position</th><th>Market</th><th>Family</th><th>Size</th>
              <th>Avg Entry</th><th>Cost Basis</th><th>Value</th><th>PnL</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {positions?.map((p) => (
              <tr key={p.positionId} style={p.status === "dust" ? { background: "rgba(255,152,0,0.06)" } : undefined}>
                <td style={{ color: "var(--blue)", fontSize: 11 }}>{p.positionId.slice(0, 12)}</td>
                <td><MarketLink slug={p.slug} eventSlug={p.eventSlug} question={p.question} outcome={p.outcome} /></td>
                <td>{p.familyId.slice(0, 12)}</td>
                <td>{p.size.toFixed(2)}</td>
                <td>${p.avgEntryPrice.toFixed(4)}</td>
                <td>${p.costBasisUsdc.toFixed(2)}</td>
                <td>{p.currentValueUsdc != null ? `$${p.currentValueUsdc.toFixed(2)}` : "\u2014"}</td>
                <td style={{ color: p.realizedPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                  {p.realizedPnl >= 0 ? "+" : ""}${p.realizedPnl.toFixed(2)}
                </td>
                <td><Badge value={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
