import { Link } from "react-router-dom";
import {
  useStatus,
  useMetrics,
  usePnlSeries,
  useMetricsFamilies,
  useFills,
  useOrders,
} from "../api/hooks.ts";
import { PnlChart } from "../components/PnlChart.tsx";
import { formatAgo } from "../utils/format.ts";

function tradingStateColor(state?: string): string {
  switch (state) {
    case "ACTIVELY_TRADING": return "var(--green)";
    case "PROBING_ONLY": return "var(--blue, #42a5f5)";
    case "EXITS_ONLY": return "var(--orange)";
    case "ALIVE_BUT_BLOCKED": return "#cc8800";
    case "PAUSED": return "var(--red)";
    case "NO_SIGNALS": return "#666";
    default: return "#666";
  }
}

function tradingStateLabel(state?: string): string {
  switch (state) {
    case "ACTIVELY_TRADING": return "ACTIVELY TRADING";
    case "PROBING_ONLY": return "PROBING ONLY";
    case "EXITS_ONLY": return "EXITS ONLY";
    case "ALIVE_BUT_BLOCKED": return "BLOCKED BY LIMITS";
    case "PAUSED": return "PAUSED";
    case "NO_SIGNALS": return "NO SIGNALS";
    default: return "UNKNOWN";
  }
}

export function Overview() {
  const { data: status } = useStatus();
  const { data: metrics } = useMetrics();
  const { data: pnlData } = usePnlSeries();
  const { data: familyMetrics } = useMetricsFamilies();
  const { data: recentFills } = useFills({ limit: 1 });
  const { data: recentOrders } = useOrders({ limit: 1 });

  if (!status || !metrics) return <div className="page">Loading...</div>;

  const dustCount = metrics.positions.dust ?? 0;
  const quarantinedCount = familyMetrics?.filter((f) => f.runtimeMode === "quarantine").length ?? 0;
  const reduceOnlyCount = familyMetrics?.filter((f) => f.runtimeMode === "reduce-only").length ?? 0;
  const activeCount = familyMetrics?.filter((f) => f.runtimeMode === "active").length ?? 0;
  const tailAdjPnl = metrics.totalRealizedPnl - status.totalTailCostUsdc;

  return (
    <div className="page">
      {/* Primary status cards */}
      <div className="grid-4" style={{ marginBottom: 16 }}>
        <div className="card card-accent-green">
          <div className="label">Runtime Mode</div>
          <div className="value-lg text-green">{status.runtimeMode.toUpperCase()}</div>
          <div className="value-sm">{status.paused ? "Paused" : "Not paused"}</div>
        </div>
        <Link to="/positions" style={{ textDecoration: "none" }}>
          <div className="card card-accent-blue" style={{ cursor: "pointer" }}>
            <div className="label">Open Positions</div>
            <div className="value-lg text-blue">{status.openPositionCount}</div>
            <div className="value-sm">{dustCount} dust</div>
          </div>
        </Link>
        <Link to="/orders" style={{ textDecoration: "none" }}>
          <div className="card card-accent-blue" style={{ cursor: "pointer" }}>
            <div className="label">Open Orders</div>
            <div className="value-lg text-blue">{status.openOrderCount}</div>
            <div className="value-sm">&nbsp;</div>
          </div>
        </Link>
        <Link to="/families" style={{ textDecoration: "none" }}>
          <div className="card card-accent-purple" style={{ cursor: "pointer" }}>
            <div className="label">Active Families</div>
            <div className="value-lg text-purple">{status.activeFamilyCount}</div>
            <div className="value-sm">{quarantinedCount} quarantined</div>
          </div>
        </Link>
      </div>

      {status.liveLite && (
        <div
          className="card"
          style={{
            marginBottom: 16,
            border: "1px solid var(--red)",
            borderLeft: "3px solid var(--red)",
            padding: "10px 16px",
            fontSize: 12,
          }}
        >
          <div className="label" style={{ color: "var(--red)", fontWeight: 700, marginBottom: 6 }}>
            Live-Lite Envelope
          </div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <span>
              Allowlist: {status.liveLite.familyAllowlist.join(", ")} (
              {status.liveLite.familyAllowlist.length} family)
            </span>
            <span>Max: {status.liveLite.maxFamilies} family</span>
            <span>
              Caps: ${status.liveLite.maxOpenValueUsdc} total / ${status.liveLite.maxOrderUsdc} per
              order / {status.liveLite.maxActiveMarkets} markets
            </span>
          </div>
        </div>
      )}

      {/* Tail Risk + Financial */}
      <div className="grid-3" style={{ marginBottom: 16 }}>
        <div
          className="card"
          style={{ border: "1px solid var(--orange)", borderLeft: "3px solid var(--orange)" }}
        >
          <div className="label" style={{ color: "var(--orange)", fontWeight: 700 }}>
            Tail Risk
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
            <div>
              <div className="label">Tail Cost</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--orange)" }}>
                ${status.totalTailCostUsdc.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="label">Tail-Adj PnL</div>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 700,
                  color: tailAdjPnl >= 0 ? "var(--green)" : "var(--red)",
                }}
              >
                {tailAdjPnl >= 0 ? "+" : ""}${tailAdjPnl.toFixed(0)}
              </div>
            </div>
          </div>
          <div className="value-sm" style={{ marginTop: 6 }}>
            {dustCount} dust positions
          </div>
        </div>
        <div className="card card-accent-orange">
          <div className="label">Open Value</div>
          <div className="value-lg text-orange">${status.totalOpenValueUsdc.toFixed(0)}</div>
          <div className="value-sm">across {status.openPositionCount} positions</div>
        </div>
        <div className="card card-accent-green">
          <div className="label">Realized PnL</div>
          <div
            className="value-lg"
            style={{ color: metrics.totalRealizedPnl >= 0 ? "var(--green)" : "var(--red)" }}
          >
            {metrics.totalRealizedPnl >= 0 ? "+" : ""}${metrics.totalRealizedPnl.toFixed(0)}
          </div>
          <div className="value-sm">
            {metrics.fills.count} fills &middot; vol ${metrics.fills.volumeUsdc.toFixed(0)}
          </div>
        </div>
      </div>

      {/* Trading Activity */}
      {status && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="label">Trading Activity (10m window)</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
            <span
              style={{
                padding: "4px 10px",
                borderRadius: 4,
                fontSize: 13,
                fontWeight: 700,
                color: "#fff",
                background: tradingStateColor(status.tradingState),
              }}
            >
              {tradingStateLabel(status.tradingState)}
            </span>
            {status.signalActivity && (
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
                {status.signalActivity.signalsProducedLast10m} produced
                {" · "}
                {status.signalActivity.signalsApprovedLast10m} approved
                {status.signalActivity.lastEntryApprovedAt && (
                  <> ({formatAgo(status.signalActivity.lastEntryApprovedAt)})</>
                )}
                {" · "}
                {status.signalActivity.signalsRejectedLast10m} rejected
                {status.signalActivity.lastSignalRejectedAt && (
                  <> ({formatAgo(status.signalActivity.lastSignalRejectedAt)})</>
                )}
                {status.signalActivity.approvalRate != null && (
                  <> · {status.signalActivity.approvalRate}% approval</>
                )}
              </span>
            )}
          </div>
          {status.tradingState === "ALIVE_BUT_BLOCKED" && status.signalActivity && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--orange)" }}>
              All {status.signalActivity.signalsRejectedLast10m} entry signals were rejected by risk limits
            </div>
          )}
          {status.tradingState === "NO_SIGNALS" && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-dim)" }}>
              {status.signalActivity?.candidatesConsideredLast10m != null &&
              status.signalActivity.candidatesConsideredLast10m > 0
                ? `${status.signalActivity.candidatesConsideredLast10m} candidates considered — ${status.signalActivity.blockedByResolutionBufferLast10m ?? 0} in resolution buffer, ${status.signalActivity.blockedByWeekendLast10m ?? 0} blocked by weekend, ${status.signalActivity.blockedByWindowLast10m ?? 0} outside active window`
                : "No signals produced — markets may be outside active window or in resolution buffer"}
            </div>
          )}
          {status.tradingState === "PROBING_ONLY" && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--blue, #42a5f5)" }}>
              Only probe entries allowed — all families in derived probe-only mode
            </div>
          )}
          {status.tradingState === "EXITS_ONLY" && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--orange)" }}>
              Only exit signals active — no new entries being opened
            </div>
          )}
        </div>
      )}

      {/* PnL Chart */}
      <div style={{ marginBottom: 16 }}>
        <PnlChart data={pnlData?.items ?? []} tailCostUsdc={status.totalTailCostUsdc} />
      </div>

      {/* Bottom row */}
      <div className="grid-2">
        <div className="card">
          <div className="label" style={{ marginBottom: 10 }}>
            Last Events
          </div>
          <table>
            <tbody>
              <tr>
                <td style={{ color: "var(--text-muted)" }}>Last fill</td>
                <td style={{ textAlign: "right" }}>
                  {formatAgo(recentFills?.items[0]?.filledAt ?? null)}
                </td>
              </tr>
              <tr>
                <td style={{ color: "var(--text-muted)" }}>Last order</td>
                <td style={{ textAlign: "right" }}>
                  {formatAgo(recentOrders?.items[0]?.updatedAt ?? null)}
                </td>
              </tr>
              <tr>
                <td style={{ color: "var(--text-muted)" }}>Last reconciliation</td>
                <td style={{ textAlign: "right" }}>{formatAgo(status.lastReconciliationAt)}</td>
              </tr>
              <tr>
                <td style={{ color: "var(--text-muted)" }}>Last market data</td>
                <td style={{ textAlign: "right" }}>{formatAgo(status.marketDataLastUpdateAt)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="card">
          <div className="label" style={{ marginBottom: 10 }}>
            Family Health
          </div>
          <div style={{ display: "flex", gap: 2, height: 18, borderRadius: 3, overflow: "hidden" }}>
            {activeCount > 0 && (
              <div
                style={{ flex: activeCount, background: "var(--green)" }}
                title={`${activeCount} active`}
              />
            )}
            {reduceOnlyCount > 0 && (
              <div
                style={{ flex: reduceOnlyCount, background: "var(--orange)" }}
                title={`${reduceOnlyCount} reduce-only`}
              />
            )}
            {quarantinedCount > 0 && (
              <div
                style={{ flex: quarantinedCount, background: "var(--red)" }}
                title={`${quarantinedCount} quarantined`}
              />
            )}
          </div>
          <div className="grid-3" style={{ marginTop: 10, fontSize: 12 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--green)" }}>
                {activeCount}
              </div>
              <div className="value-sm">active</div>
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--orange)" }}>
                {reduceOnlyCount}
              </div>
              <div className="value-sm">reduce-only</div>
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--red)" }}>
                {quarantinedCount}
              </div>
              <div className="value-sm">quarantined</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
