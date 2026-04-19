import { useState } from "react";
import { useOrders, useFills } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { MarketLink } from "../components/MarketLink.tsx";
import { SortTh } from "../components/SortTh.tsx";
import { formatTimeLeft, formatTimestamp } from "../utils/format.ts";
import { useSort, sortItems } from "../utils/useSort.ts";
import type { OrderDTO, FillDTO } from "../api/types.ts";

const orderAccessors: Record<string, (o: OrderDTO) => string | number | null> = {
  orderId: (o) => o.orderId,
  market: (o) => o.question,
  side: (o) => o.side,
  price: (o) => o.price,
  size: (o) => o.size,
  status: (o) => o.status,
  ends: (o) => o.endDate,
  updated: (o) => o.updatedAt,
};

const fillAccessors: Record<string, (f: FillDTO) => string | number | null> = {
  fillId: (f) => f.fillId,
  market: (f) => f.question,
  side: (f) => f.side,
  price: (f) => f.price,
  size: (f) => f.size,
  usdc: (f) => f.sizeUsdc,
  filledAt: (f) => f.filledAt,
};

export function OrdersFills() {
  const [tab, setTab] = useState<"orders" | "fills">("orders");
  const [orderStatus, setOrderStatus] = useState("");
  const [page, setPage] = useState(1);
  const orderSort = useSort();
  const fillSort = useSort();

  const orders = useOrders(
    tab === "orders" ? { status: orderStatus || undefined, limit: 50, page } : {},
  );
  const fills = useFills(tab === "fills" ? { limit: 50, page } : {});
  const activeData = tab === "orders" ? orders.data : fills.data;
  const totalCount = activeData?.totalCount ?? 0;
  const pageStart = totalCount > 0 ? (page - 1) * 50 + 1 : 0;
  const pageEnd = pageStart + ((activeData?.items.length ?? 0) - 1);
  const pageInfo = totalCount > 0 ? `${pageStart}\u2013${pageEnd} of ${totalCount}` : undefined;
  const totalPages = activeData?.totalPages ?? Math.max(1, Math.ceil(totalCount / 50));

  return (
    <div className="page">
      <div className="tab-bar">
        <div
          className={`tab ${tab === "orders" ? "active" : ""}`}
          onClick={() => {
            setTab("orders");
            setPage(1);
          }}
        >
          Orders
        </div>
        <div
          className={`tab ${tab === "fills" ? "active" : ""}`}
          onClick={() => {
            setTab("fills");
            setPage(1);
          }}
        >
          Fills
        </div>
      </div>

      <div className="filter-bar">
        {tab === "orders" && (
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
        )}
      </div>

      {tab === "orders" ? (
        <>
          <table>
            <thead>
              <tr>
                <SortTh
                  label="Order"
                  sortKey="orderId"
                  sort={orderSort.sort}
                  onToggle={orderSort.toggle}
                />
                <SortTh
                  label="Market"
                  sortKey="market"
                  sort={orderSort.sort}
                  onToggle={orderSort.toggle}
                />
                <SortTh
                  label="Side"
                  sortKey="side"
                  sort={orderSort.sort}
                  onToggle={orderSort.toggle}
                />
                <SortTh
                  label="Price"
                  sortKey="price"
                  sort={orderSort.sort}
                  onToggle={orderSort.toggle}
                />
                <SortTh
                  label="Size"
                  sortKey="size"
                  sort={orderSort.sort}
                  onToggle={orderSort.toggle}
                />
                <SortTh
                  label="Status"
                  sortKey="status"
                  sort={orderSort.sort}
                  onToggle={orderSort.toggle}
                />
                <SortTh
                  label="Ends"
                  sortKey="ends"
                  sort={orderSort.sort}
                  onToggle={orderSort.toggle}
                />
                <SortTh
                  label="Updated"
                  sortKey="updated"
                  sort={orderSort.sort}
                  onToggle={orderSort.toggle}
                />
              </tr>
            </thead>
            <tbody>
              {sortItems(orders.data?.items ?? [], orderSort.sort, orderAccessors).map((o) => {
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
                    <td>
                      <div
                        style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
                      >
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
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            pageInfo={pageInfo}
          />
        </>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <SortTh
                  label="Fill"
                  sortKey="fillId"
                  sort={fillSort.sort}
                  onToggle={fillSort.toggle}
                />
                <SortTh
                  label="Market"
                  sortKey="market"
                  sort={fillSort.sort}
                  onToggle={fillSort.toggle}
                />
                <SortTh
                  label="Side"
                  sortKey="side"
                  sort={fillSort.sort}
                  onToggle={fillSort.toggle}
                />
                <SortTh
                  label="Price"
                  sortKey="price"
                  sort={fillSort.sort}
                  onToggle={fillSort.toggle}
                />
                <SortTh
                  label="Size"
                  sortKey="size"
                  sort={fillSort.sort}
                  onToggle={fillSort.toggle}
                />
                <SortTh
                  label="USDC"
                  sortKey="usdc"
                  sort={fillSort.sort}
                  onToggle={fillSort.toggle}
                />
                <th>Exec</th>
                <SortTh
                  label="Filled At"
                  sortKey="filledAt"
                  sort={fillSort.sort}
                  onToggle={fillSort.toggle}
                />
              </tr>
            </thead>
            <tbody>
              {sortItems(fills.data?.items ?? [], fillSort.sort, fillAccessors).map((f) => (
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
                    <div
                      style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
                    >
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
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            pageInfo={pageInfo}
          />
        </>
      )}
    </div>
  );
}
