import { useState } from "react";
import { useOrders, useFills, useFamilies } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { Pagination } from "../components/Pagination.tsx";

export function OrdersFills() {
  const [tab, setTab] = useState<"orders" | "fills">("orders");
  const [familyId, setFamilyId] = useState("");
  const [orderStatus, setOrderStatus] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();

  const { data: families } = useFamilies();
  const orders = useOrders(tab === "orders" ? { status: orderStatus || undefined, familyId: familyId || undefined, limit: 50, cursor } : {});
  const fills = useFills(tab === "fills" ? { familyId: familyId || undefined, limit: 50, cursor } : {});

  return (
    <div className="page">
      <div className="tab-bar">
        <div className={`tab ${tab === "orders" ? "active" : ""}`} onClick={() => { setTab("orders"); setCursor(undefined); }}>Orders</div>
        <div className={`tab ${tab === "fills" ? "active" : ""}`} onClick={() => { setTab("fills"); setCursor(undefined); }}>Fills</div>
      </div>

      <div className="filter-bar">
        <select value={familyId} onChange={(e) => { setFamilyId(e.target.value); setCursor(undefined); }}>
          <option value="">All families</option>
          {families?.map((f) => <option key={f.familyId} value={f.familyId}>{f.familyKey}</option>)}
        </select>
        {tab === "orders" && (
          <select value={orderStatus} onChange={(e) => { setOrderStatus(e.target.value); setCursor(undefined); }}>
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
              <tr><th>Order</th><th>Family</th><th>Token</th><th>Side</th><th>Price</th><th>Size</th><th>Status</th><th>Updated</th></tr>
            </thead>
            <tbody>
              {orders.data?.items.map((o) => (
                <tr key={o.orderId}>
                  <td style={{ fontSize: 11, color: "var(--blue)" }}>{o.orderId.slice(0, 12)}</td>
                  <td>{o.familyId.slice(0, 12)}</td>
                  <td>{o.tokenId.slice(0, 12)}</td>
                  <td style={{ color: o.side === "buy" ? "var(--green)" : "var(--red)", fontWeight: 600 }}>{o.side.toUpperCase()}</td>
                  <td>${o.price.toFixed(4)}</td>
                  <td>{o.size.toFixed(2)}</td>
                  <td><Badge value={o.status} /></td>
                  <td style={{ fontSize: 11, color: "var(--text-dim)" }}>{new Date(o.updatedAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination nextCursor={orders.data?.nextCursor ?? null} onNext={setCursor} />
        </>
      ) : (
        <>
          <table>
            <thead>
              <tr><th>Fill</th><th>Family</th><th>Token</th><th>Side</th><th>Price</th><th>Size</th><th>USDC</th><th>Filled At</th></tr>
            </thead>
            <tbody>
              {fills.data?.items.map((f) => (
                <tr key={f.fillId}>
                  <td style={{ fontSize: 11, color: "var(--blue)" }}>{f.fillId.slice(0, 12)}</td>
                  <td>{f.familyId.slice(0, 12)}</td>
                  <td>{f.tokenId.slice(0, 12)}</td>
                  <td style={{ color: f.side === "buy" ? "var(--green)" : "var(--red)", fontWeight: 600 }}>{f.side.toUpperCase()}</td>
                  <td>${f.price.toFixed(4)}</td>
                  <td>{f.size.toFixed(2)}</td>
                  <td>${f.sizeUsdc.toFixed(2)}</td>
                  <td style={{ fontSize: 11, color: "var(--text-dim)" }}>{new Date(f.filledAt).toLocaleTimeString()}</td>
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
