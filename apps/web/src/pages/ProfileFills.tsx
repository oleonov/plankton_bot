import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useProfileFills, useFamilies } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { MarketLink } from "../components/MarketLink.tsx";
import { formatTimestamp } from "../utils/format.ts";

export function ProfileFills() {
  const { profileId } = useParams<{ profileId: string }>();
  const [familyId, setFamilyId] = useState("");
  const [page, setPage] = useState(1);

  const { data: families } = useFamilies();
  const fills = useProfileFills(profileId, { familyId: familyId || undefined, limit: 50, page });
  const totalCount = fills.data?.totalCount ?? 0;
  const pageStart = totalCount > 0 ? (page - 1) * 50 + 1 : 0;
  const pageEnd = pageStart + ((fills.data?.items.length ?? 0) - 1);
  const pageInfo = totalCount > 0 ? `${pageStart}\u2013${pageEnd} of ${totalCount}` : undefined;
  const totalPages = fills.data?.totalPages ?? Math.max(1, Math.ceil(totalCount / 50));

  return (
    <div className="page">
      <Link to={`/profiles/${profileId}`} style={{ fontSize: 12, color: "var(--text-muted)" }}>
        &larr; Back to Profile
      </Link>
      <div className="page-title" style={{ marginTop: 8 }}>
        Fills — Profile {profileId?.slice(0, 12)}
      </div>

      <div className="filter-bar">
        <select
          value={familyId}
          onChange={(e) => {
            setFamilyId(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All families</option>
          {families?.map((f) => (
            <option key={f.familyId} value={f.familyId}>
              {f.familyKey}
            </option>
          ))}
        </select>
      </div>

      <table>
        <thead>
          <tr>
            <th>Fill</th>
            <th>Market</th>
            <th>Family</th>
            <th>Side</th>
            <th>Price</th>
            <th>Size</th>
            <th>USDC</th>
            <th>Exec</th>
            <th>Filled At</th>
          </tr>
        </thead>
        <tbody>
          {fills.data?.items.map((f) => (
            <tr key={f.fillId}>
              <td style={{ fontSize: 11, color: "var(--blue)" }}>{f.fillId.slice(0, 12)}</td>
              <td>
                <MarketLink
                  slug={f.slug}
                  eventSlug={f.eventSlug}
                  question={f.question}
                  outcome={f.outcome}
                />
              </td>
              <td>{f.familyId.slice(0, 12)}</td>
              <td
                style={{
                  color: f.side === "buy" ? "var(--green)" : "var(--red)",
                  fontWeight: 600,
                }}
              >
                {f.side.toUpperCase()}
              </td>
              <td>${f.price.toFixed(4)}</td>
              <td>{f.size.toFixed(2)}</td>
              <td>${f.sizeUsdc.toFixed(2)}</td>
              <td>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <Badge value={f.liquidityRole ?? "unknown"} />
                  <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
                    fee ${(f.explicitFeeUsdc ?? f.fee).toFixed(3)}
                  </span>
                </div>
              </td>
              <td style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {formatTimestamp(f.filledAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} pageInfo={pageInfo} />
    </div>
  );
}
