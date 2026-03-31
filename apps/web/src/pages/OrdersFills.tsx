import { useState } from "react";
import { useOrders, useFills, useFamilies } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { MarketLink } from "../components/MarketLink.tsx";
import { SortTh } from "../components/SortTh.tsx";
import { formatTimeLeft } from "../utils/format.ts";
import { useSort, sortItems } from "../utils/useSort.ts";
import type { OrderDTO, FillDTO } from "../api/types.ts";

const orderAccessors: Record<string, (o: OrderDTO) => string | number | null> = {
  orderId: (o) => o.orderId,
  market: (o) => o.question,
  family: (o) => o.familyId,
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
  family: (f) => f.familyId,
  side: (f) => f.side,
  price: (f) => f.price,
  size: (f) => f.size,
  usdc: (f) => f.sizeUsdc,
  filledAt: (f) => f.filledAt,
};

export function OrdersFills() {
  const [tab, setTab] = useState<"orders" | "fills">("orders");
  const [familyId, setFamilyId] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const orderSort = useSort();
  const fillSort = useSort();

  const { data: families } = useFamilies();
  const orders = useOrders(
    tab === "orders"
      ? { status: orderStatus || undefined, familyId: familyId || undefined, limit: 50, cursor }
      : {},
  );
  const fills = useFills(
    tab === "fills" ? { familyId: familyId || undefined, limit: 50, cursor } : {},
  );

  return (
    <div className="page">
      <div className="tab-bar">
        <div
          className={`tab ${tab === "orders" ? "active" : ""}`}
          onClick={() => {
            setTab("orders");
            setCursor(undefined);
          }}
        >
          Orders
        </div>
        <div
          className={`tab ${tab === "fills" ? "active" : ""}`}
          onClick={() => {
            setTab("fills");
            setCursor(undefined);
          }}
        >
          Fills
        </div>
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
        {tab === "orders" && (
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
        )}
      </div>

      {tab === "orders" ? (
        <>
          <table>
            <thead>
              <tr>
                <SortTh label="Order" sortKey="orderId" sort={orderSort.sort} onToggle={orderSort.toggle} />
                <SortTh label="Market" sortKey="market" sort={orderSort.sort} onToggle={orderSort.toggle} />
                <SortTh label="Family" sortKey="family" sort={orderSort.sort} onToggle={orderSort.toggle} />
                <SortTh label="Side" sortKey="side" sort={orderSort.sort} onToggle={orderSort.toggle} />
                <SortTh label="Price" sortKey="price" sort={orderSort.sort} onToggle={orderSort.toggle} />
                <SortTh label="Size" sortKey="size" sort={orderSort.sort} onToggle={orderSort.toggle} />
                <SortTh label="Status" sortKey="status" sort={orderSort.sort} onToggle={orderSort.toggle} />
                <SortTh label="Ends" sortKey="ends" sort={orderSort.sort} onToggle={orderSort.toggle} />
                <SortTh label="Updated" sortKey="updated" sort={orderSort.sort} onToggle={orderSort.toggle} />
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
        </>
      ) : (
        <>
          <table>
            <thead>
              <tr>
                <SortTh label="Fill" sortKey="fillId" sort={fillSort.sort} onToggle={fillSort.toggle} />
                <SortTh label="Market" sortKey="market" sort={fillSort.sort} onToggle={fillSort.toggle} />
                <SortTh label="Family" sortKey="family" sort={fillSort.sort} onToggle={fillSort.toggle} />
                <SortTh label="Side" sortKey="side" sort={fillSort.sort} onToggle={fillSort.toggle} />
                <SortTh label="Price" sortKey="price" sort={fillSort.sort} onToggle={fillSort.toggle} />
                <SortTh label="Size" sortKey="size" sort={fillSort.sort} onToggle={fillSort.toggle} />
                <SortTh label="USDC" sortKey="usdc" sort={fillSort.sort} onToggle={fillSort.toggle} />
                <SortTh label="Filled At" sortKey="filledAt" sort={fillSort.sort} onToggle={fillSort.toggle} />
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
                    {new Date(f.filledAt).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination nextCursor={fills.data?.nextCursor ?? null} onNext={setCursor} />
        </>
      )}
    </div>
  );
}
