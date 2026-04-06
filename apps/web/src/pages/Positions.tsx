import { useState, useCallback } from "react";
import { usePositions, useFamilies } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { MarketLink } from "../components/MarketLink.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { formatAge, formatTimeLeft } from "../utils/format.ts";

const PAGE_SIZE = 50;

function getPositionTotalPnl(position: {
  costBasisUsdc: number;
  currentValueUsdc: number | null;
  realizedPnl: number;
}): number {
  return position.realizedPnl + ((position.currentValueUsdc ?? 0) - position.costBasisUsdc);
}

export function Positions() {
  const [familyId, setFamilyId] = useState("");
  const [dustOnly, setDustOnly] = useState(false);
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("");
  const [page, setPage] = useState(1);

  const resetPagination = useCallback(() => {
    setPage(1);
  }, []);

  const { data, isLoading } = usePositions({
    familyId: familyId || undefined,
    dust: dustOnly || undefined,
    status: status || undefined,
    sort: sort || undefined,
    limit: PAGE_SIZE,
    page,
  });

  const positions = data?.items;
  const totalCount = data?.totalCount ?? 0;
  const { data: families } = useFamilies();

  const pageStart = totalCount > 0 ? (page - 1) * PAGE_SIZE + 1 : 0;
  const pageEnd = pageStart + (positions?.length ?? 0) - 1;
  const pageInfo = totalCount > 0 ? `${pageStart}\u2013${pageEnd} of ${totalCount}` : undefined;
  const totalPages = data?.totalPages ?? Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="page">
      <div className="filter-bar">
        <span style={{ fontWeight: 700 }}>Positions</span>
        <span style={{ color: "var(--text-muted)" }}>({totalCount})</span>
        <select
          value={familyId}
          onChange={(e) => {
            setFamilyId(e.target.value);
            resetPagination();
          }}
        >
          <option value="">All families</option>
          {families?.map((f) => (
            <option key={f.familyId} value={f.familyId}>
              {f.familyKey}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            resetPagination();
          }}
        >
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="dust">Dust</option>
          <option value="closed">Closed</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="checkbox"
            checked={dustOnly}
            onChange={(e) => {
              setDustOnly(e.target.checked);
              resetPagination();
            }}
          />
          Dust only
        </label>
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            resetPagination();
          }}
        >
          <option value="">Default sort</option>
          <option value="tail_cost">Tail cost desc</option>
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
              <th>Resolution</th>
            </tr>
          </thead>
          <tbody>
            {positions?.map((p) => {
              const ends = formatTimeLeft(p.endDate);
              const totalPnl = getPositionTotalPnl(p);
              return (
                <tr
                  key={p.positionId}
                  style={p.status === "dust" ? { background: "rgba(255,152,0,0.06)" } : undefined}
                >
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
                  <td style={{ color: totalPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                    {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
                  </td>
                  <td>
                    <Badge value={p.status} />
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-dim)" }}>
                    {formatAge(p.openedAt)}
                  </td>
                  <td style={{ color: ends.color, fontSize: 12 }}>{ends.text}</td>
                  <td>
                    {p.resolutionStatus === "detected" && <Badge value="resolving" />}
                    {p.resolutionStatus === "settled" && <Badge value="settled" />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} pageInfo={pageInfo} />
    </div>
  );
}
