import { useState } from "react";
import { useRiskEvents } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { formatTimestamp } from "../utils/format.ts";

export function RiskEvents() {
  const [eventType, setEventType] = useState("");
  const [page, setPage] = useState(1);

  const { data: riskEvents } = useRiskEvents({
    eventType: eventType || undefined,
    limit: 50,
    page,
  });
  const totalCount = riskEvents?.totalCount ?? 0;
  const pageStart = totalCount > 0 ? (page - 1) * 50 + 1 : 0;
  const pageEnd = pageStart + ((riskEvents?.items.length ?? 0) - 1);
  const pageInfo = totalCount > 0 ? `${pageStart}\u2013${pageEnd} of ${totalCount}` : undefined;
  const totalPages = riskEvents?.totalPages ?? Math.max(1, Math.ceil(totalCount / 50));

  return (
    <div className="page">
      {/* Recent Risk Events */}
      <div className="page-title">Recent Risk Events</div>
      <div className="filter-bar">
        <select
          value={eventType}
          onChange={(e) => {
            setEventType(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All types</option>
          <option value="max_exposure_breach">Exposure Breach</option>
          <option value="stale_signal">Stale Signal</option>
          <option value="reconciliation_drift">Recon Drift</option>
        </select>
      </div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Severity</th>
            <th>Family</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {riskEvents?.items.map((e) => (
            <tr key={e.id}>
              <td style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {formatTimestamp(e.createdAt)}
              </td>
              <td>{e.eventType}</td>
              <td>
                <Badge value={e.severity} type="severity" />
              </td>
              <td>{e.familyId ?? "\u2014"}</td>
              <td>{e.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} pageInfo={pageInfo} />
    </div>
  );
}
