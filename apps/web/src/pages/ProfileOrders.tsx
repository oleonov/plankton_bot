import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useProfileOrders } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { MarketLink } from "../components/MarketLink.tsx";
import { formatTimeLeft, formatTimestamp, formatUsd } from "../utils/format.ts";

function orderNotionalUsdc(order: { price: number; size: number }): number {
  return order.price * order.size;
}

export function ProfileOrders() {
  const { profileId } = useParams<{ profileId: string }>();
  const [orderStatus, setOrderStatus] = useState("");
  const [page, setPage] = useState(1);

  const orders = useProfileOrders(profileId, {
    status: orderStatus || undefined,
    limit: 50,
    page,
  });
  const totalCount = orders.data?.totalCount ?? 0;
  const pageStart = totalCount > 0 ? (page - 1) * 50 + 1 : 0;
  const pageEnd = pageStart + ((orders.data?.items.length ?? 0) - 1);
  const pageInfo = totalCount > 0 ? `${pageStart}\u2013${pageEnd} of ${totalCount}` : undefined;
  const totalPages = orders.data?.totalPages ?? Math.max(1, Math.ceil(totalCount / 50));

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
          value={orderStatus}
          onChange={(e) => {
            setOrderStatus(e.target.value);
            setPage(1);
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
            <th>Side</th>
            <th>Price</th>
            <th>Size</th>
            <th>Notional</th>
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
                <td>{formatUsd(orderNotionalUsdc(o))}</td>
                <td>
                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <Badge value={o.status} />
                    {o.postOnly ? <Badge value="post-only" /> : null}
                  </div>
                </td>
                <td style={{ color: ends.color, fontSize: 12 }}>{ends.text}</td>
                <td style={{ fontSize: 11, color: "var(--text-dim)" }}>
                  {formatTimestamp(o.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} pageInfo={pageInfo} />
    </div>
  );
}
