import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useProfileFills, useFamilies } from "../api/hooks.ts";
import { Pagination } from "../components/Pagination.tsx";
import { MarketLink } from "../components/MarketLink.tsx";
import { formatTimestamp } from "../utils/format.ts";

export function ProfileFills() {
  const { profileId } = useParams<{ profileId: string }>();
  const [familyId, setFamilyId] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();

  const { data: families } = useFamilies();
  const fills = useProfileFills(profileId, { familyId: familyId || undefined, limit: 50, cursor });

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
            setCursor(undefined);
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
              <td style={{ fontSize: 11, color: "var(--text-dim)" }}>
                {formatTimestamp(f.filledAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pagination nextCursor={fills.data?.nextCursor ?? null} onNext={setCursor} />
    </div>
  );
}
