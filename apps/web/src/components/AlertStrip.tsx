import { Link } from "react-router-dom";
import { useFamilies, useStatus } from "../api/hooks.ts";
import { useSSEState } from "../api/sse.tsx";

export function AlertStrip() {
  const { data: families } = useFamilies();
  const { data: status } = useStatus();
  const sseState = useSSEState();

  const alerts: string[] = [];

  const quarantined = families?.filter((f) => f.state?.runtimeMode === "quarantine") ?? [];
  if (quarantined.length > 0) {
    const names = quarantined.map((f) => f.familyKey).join(", ");
    alerts.push(`${quarantined.length} families quarantined \u2014 ${names}`);
  }

  if (status?.marketDataStale) alerts.push("Market data stale");
  if (sseState === "disconnected") alerts.push("SSE disconnected");

  if (alerts.length === 0) return null;

  return (
    <div style={{
      background: "var(--red-bg)",
      borderBottom: "1px solid #6d2b2b",
      padding: "6px 16px",
      fontSize: 11,
      color: "#ef9a9a",
      display: "flex",
      alignItems: "center",
      gap: 12,
    }}>
      <span style={{ fontWeight: 700, color: "var(--red)" }}>&#9888;</span>
      <span>{alerts.join(" \u2022 ")}</span>
      <Link to="/risk" style={{ marginLeft: "auto", color: "var(--red)", fontSize: 10 }}>
        View in Risk &rarr;
      </Link>
    </div>
  );
}
