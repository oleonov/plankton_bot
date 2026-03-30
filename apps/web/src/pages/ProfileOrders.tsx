import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useProfileOrders, useFamilies } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { MarketLink } from "../components/MarketLink.tsx";
import { formatTimeLeft } from "../utils/format.ts";

export function ProfileOrders() {
  const { profileId } = useParams<{ profileId: string }>();
  const [familyId, setFamilyId] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();

  const { data: families } = useFamilies();
  const orders = useProfileOrders(profileId, {
    status: orderStatus || undefined,
    familyId: familyId || undefined,
    limit: 50,
    cursor,
  });

  return (
    <div className="page">
      <Link to={`/profiles/${profileId}`} style={{ fontSize: 12, color: "var(--text-muted)" }}>
        &larr; Back to Profile
      </Link>
      <div className="page-title" style={{ marginTop: 8 }}>
        Orders — Profile {profileId?.slice(0, 12)}
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
        <select
          value={orderStatus}
          onChange={(e) => {
            setOrderStatus(e.target.value);
            setCursor(undefined);
          }}
        >
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="open">Open</option>
          <option value="filled">Filled</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      <table>
        <thead>
          <tr>
            <th>Order</th>
            <th>Market</th>
            <th>Family</th>
            <th>Side</th>
            <th>Price</th>
            <th>Size</th>
            <th>Status</th>
            <th>Ends</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {orders.data?.items.map((o) => {
            const ends = formatTimeLeft(o.endDate);
            return (
              <tr key={o.orderId}>
                <td style={{ fontSize: 11, color: "var(--blue)" }}>{o.orderId.slice(0, 12)}</td>
                <td>
                  <MarketLink
                    slug={o.slug}
                    eventSlug={o.eventSlug}
                    question={o.question}
                    outcome={o.outcome}
                  />
                </td>
                <td>{o.familyId.slice(0, 12)}</td>
                <td
                  style={{
                    color: o.side === "buy" ? "var(--green)" : "var(--red)",
                    fontWeight: 600,
                  }}
                >
                  {o.side.toUpperCase()}
                </td>
                <td>${o.price.toFixed(4)}</td>
                <td>{o.size.toFixed(2)}</td>
                <td>
                  <Badge value={o.status} />
                </td>
                <td style={{ color: ends.color, fontSize: 12 }}>{ends.text}</td>
                <td style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {new Date(o.updatedAt).toLocaleTimeString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Pagination nextCursor={orders.data?.nextCursor ?? null} onNext={setCursor} />
    </div>
  );
}
