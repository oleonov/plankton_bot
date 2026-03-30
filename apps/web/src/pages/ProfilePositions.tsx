import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useProfilePositions, useFamilies } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { MarketLink } from "../components/MarketLink.tsx";
import { formatAge, formatTimeLeft } from "../utils/format.ts";

export function ProfilePositions() {
  const { profileId } = useParams<{ profileId: string }>();
  const [familyId, setFamilyId] = useState("");
  const [status, setStatus] = useState("");

  const { data: positions, isLoading } = useProfilePositions(profileId, {
    familyId: familyId || undefined,
    status: status || undefined,
  });
  const { data: families } = useFamilies();

  return (
    <div className="page">
      <Link to={`/profiles/${profileId}`} style={{ fontSize: 12, color: "var(--text-muted)" }}>
        &larr; Back to Profile
      </Link>
      <div className="page-title" style={{ marginTop: 8 }}>
        Positions — Profile {profileId?.slice(0, 12)}
      </div>

      <div className="filter-bar">
        <span style={{ color: "var(--text-muted)" }}>({positions?.length ?? 0})</span>
        <select value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
          <option value="">All families</option>
          {families?.map((f) => (
            <option key={f.familyId} value={f.familyId}>
              {f.familyKey}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="dust">Dust</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      {isLoading ? (
        <div>Loading...</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Position</th>
              <th>Market</th>
              <th>Family</th>
              <th>Size</th>
              <th>Avg Entry</th>
              <th>Cost Basis</th>
              <th>Value</th>
              <th>PnL</th>
              <th>Status</th>
              <th>Age</th>
              <th>Ends</th>
            </tr>
          </thead>
          <tbody>
            {positions?.map((p) => {
              const ends = formatTimeLeft(p.endDate);
              return (
                <tr key={p.positionId}>
                  <td style={{ color: "var(--blue)", fontSize: 11 }}>
                    {p.positionId.slice(0, 12)}
                  </td>
                  <td>
                    <MarketLink
                      slug={p.slug}
                      eventSlug={p.eventSlug}
                      question={p.question}
                      outcome={p.outcome}
                    />
                  </td>
                  <td>{p.familyId.slice(0, 12)}</td>
                  <td>{p.size.toFixed(2)}</td>
                  <td>${p.avgEntryPrice.toFixed(4)}</td>
                  <td>${p.costBasisUsdc.toFixed(2)}</td>
                  <td>
                    {p.currentValueUsdc != null ? `$${p.currentValueUsdc.toFixed(2)}` : "\u2014"}
                  </td>
                  <td style={{ color: p.realizedPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                    {p.realizedPnl >= 0 ? "+" : ""}${p.realizedPnl.toFixed(2)}
                  </td>
                  <td>
                    <Badge value={p.status} />
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {formatAge(p.openedAt)}
                  </td>
                  <td style={{ color: ends.color, fontSize: 12 }}>{ends.text}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
