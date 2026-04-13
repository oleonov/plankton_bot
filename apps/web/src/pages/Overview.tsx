import { Link } from "react-router-dom";
import type { FamilyMetric } from "../api/types.ts";
import { useStatus, useMetrics, useMetricsFamilies, useFills, useOrders } from "../api/hooks.ts";
import { PortfolioChart } from "../components/PortfolioChart.tsx";
import { TradingActivityPanel } from "../components/TradingActivityPanel.tsx";
import { formatAgo, formatUsd } from "../utils/format.ts";

function tradingStateColor(state?: string): string {
  switch (state) {
    case "ACTIVELY_TRADING":
      return "var(--green)";
    case "PROBING_ONLY":
      return "var(--blue, #42a5f5)";
    case "EXITS_ONLY":
      return "var(--orange)";
    case "ALIVE_BUT_BLOCKED":
      return "#cc8800";
    case "PAUSED":
      return "var(--red)";
    case "NO_SIGNALS":
      return "#666";
    default:
      return "#666";
  }
}

function tradingStateLabel(state?: string): string {
  switch (state) {
    case "ACTIVELY_TRADING":
      return "ACTIVELY TRADING";
    case "PROBING_ONLY":
      return "PROBING ONLY";
    case "EXITS_ONLY":
      return "EXITS ONLY";
    case "ALIVE_BUT_BLOCKED":
      return "BLOCKED BY LIMITS";
    case "PAUSED":
      return "PAUSED";
    case "NO_SIGNALS":
      return "NO SIGNALS";
    default:
      return "UNKNOWN";
  }
}

function getExecutionWatchFamilies(familyMetrics: FamilyMetric[]): FamilyMetric[] {
  return familyMetrics
    .filter((family) => {
      const execution = family.executionTelemetry24h;
      if (!execution || execution.totalFills === 0) return false;
      return (
        execution.takerFills > 0 ||
        execution.unknownFills > 0 ||
        (execution.feeLeakageRatio ?? 0) > 0
      );
    })
    .sort((left, right) => {
      const leftExecution = left.executionTelemetry24h;
      const rightExecution = right.executionTelemetry24h;
      const feeDelta =
        (rightExecution?.explicitFeesUsdc ?? 0) - (leftExecution?.explicitFeesUsdc ?? 0);
      if (feeDelta !== 0) return feeDelta;
      const takerDelta = (rightExecution?.takerFills ?? 0) - (leftExecution?.takerFills ?? 0);
      if (takerDelta !== 0) return takerDelta;
      return left.familyKey.localeCompare(right.familyKey);
    });
}

function formatExecutionWatch(metric: FamilyMetric): string {
  const execution = metric.executionTelemetry24h;
  if (!execution) return metric.familyKey;
  const parts: string[] = [];
  if (execution.takerFills > 0) parts.push(`${execution.takerFills} taker`);
  if (execution.unknownFills > 0) parts.push(`${execution.unknownFills} unknown`);
  if (execution.explicitFeesUsdc > 0) parts.push(`$${execution.explicitFeesUsdc.toFixed(3)} fees`);
  return `${metric.familyKey} · ${parts.join(" · ")}`;
}

function formatExecutionRejects(rejects?: Record<string, number>): string | null {
  if (!rejects) return null;
  const entries = Object.entries(rejects).filter(([, count]) => count > 0);
  if (entries.length === 0) return null;
  return entries
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([code, count]) => `${code}:${count}`)
    .join(", ");
}

function getFamilyMode(metric: FamilyMetric): string {
  return metric.effectiveMode ?? metric.runtimeMode;
}

function BalanceCard({ status }: { status: import("../api/types.ts").StatusData }) {
  const isLive = status.runtimeMode === "live-lite";
  const dim = { color: "var(--text-dim)" };

  // Top number: wallet balance (live-lite) or virtual balance (paper/sim)
  const topBalance = isLive ? status.walletBalanceUsdc : status.balanceUsdc;

  // If-close-all: top balance + current value of open positions
  const ifCloseAll = topBalance != null ? topBalance + status.totalCurrentValueUsdc : null;

  // Invested vs cap
  const invested = status.totalOpenValueUsdc;
  const cap = isLive ? status.liveLite?.maxOpenValueUsdc : status.initialBalanceUsdc;

  return (
    <div className={`card ${isLive ? "card-accent-green" : ""}`}>
      <div className="label" style={isLive ? undefined : dim}>
        Balance
      </div>
      <div className="value-lg" style={isLive ? { color: "var(--green)" } : dim}>
        {formatUsd(topBalance)}
      </div>
      <div className="value-sm" style={dim}>
        {ifCloseAll != null ? `${formatUsd(ifCloseAll)} if close all` : ""}
      </div>
      <div className="value-sm" style={dim}>
        {cap != null
          ? `${formatUsd(invested)} cost basis / ${formatUsd(cap)} ${isLive ? "cap" : "initial"}`
          : `${formatUsd(invested)} cost basis`}
      </div>
    </div>
  );
}

export function Overview() {
  const { data: status } = useStatus();
  const { data: metrics } = useMetrics();
  const { data: familyMetrics } = useMetricsFamilies();
  const { data: recentFills } = useFills({ limit: 1 });
  const { data: recentOrders } = useOrders({ limit: 1 });

  if (!status || !metrics) return <div className="page">Loading...</div>;

  const dustCount = metrics.positions.dust ?? 0;
  const modeCounts = status.familyModeCounts ?? null;
  const countFamiliesByMode = (mode: string): number =>
    familyMetrics?.filter((family) => getFamilyMode(family) === mode).length ?? 0;
  const activeCount = modeCounts?.active ?? countFamiliesByMode("active");
  const probeOnlyCount = modeCounts?.["probe-only"] ?? countFamiliesByMode("probe-only");
  const reduceOnlyCount = modeCounts?.["reduce-only"] ?? countFamiliesByMode("reduce-only");
  const quarantinedCount = modeCounts?.quarantine ?? countFamiliesByMode("quarantine");
  const countedEnabledFamilies = modeCounts
    ? Object.entries(modeCounts)
        .filter(([mode]) => mode !== "_disabled")
        .reduce((sum, [, count]) => sum + count, 0)
    : null;
  const enabledFamilyCount =
    status.liveLite?.familyAllowlist.length ??
    countedEnabledFamilies ??
    familyMetrics?.length ??
    status.activeFamilyCount;
  const tailAdjPnl = metrics.totalRealizedPnl - status.totalTailCostUsdc;
  const execution = status.executionTelemetry24h;
  const executionWatch = familyMetrics ? getExecutionWatchFamilies(familyMetrics) : [];
  const topExecutionWatch = executionWatch[0];
  const makerPct = execution?.makerRatio != null ? Math.round(execution.makerRatio * 100) : null;
  const leakagePct = execution?.feeLeakageRatio != null ? execution.feeLeakageRatio * 100 : null;
  const familyCardSummary = [
    probeOnlyCount > 0 ? `${probeOnlyCount} probe-only` : null,
    quarantinedCount > 0 ? `${quarantinedCount} quarantined` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="page">
      {/* Primary status cards */}
      <div className="grid-5" style={{ marginBottom: 16 }}>
        <div className="card card-accent-green">
          <div className="label">Runtime Mode</div>
          <div className="value-lg text-green">{status.runtimeMode.toUpperCase()}</div>
          <div className="value-sm">{status.paused ? "Paused" : "Not paused"}</div>
        </div>
        <BalanceCard status={status} />
        <Link to="/positions" style={{ textDecoration: "none" }}>
          <div
            className="card card-accent-blue"
            style={{ cursor: "pointer", display: "flex", flexDirection: "column" }}
          >
            <div className="label">Positions / Min</div>
            <div className="value-lg text-blue">{status.positionsOpenedLastMin}</div>
            <div style={{ marginTop: "auto" }}>
              <div className="value-sm">{dustCount} dust</div>
            </div>
          </div>
        </Link>
        <Link to="/orders" style={{ textDecoration: "none" }}>
          <div className="card card-accent-blue" style={{ cursor: "pointer" }}>
            <div className="label">Orders / Min</div>
            <div className="value-lg text-blue">{status.ordersPlacedLastMin}</div>
          </div>
        </Link>
        <Link to="/families" style={{ textDecoration: "none" }}>
          <div className="card card-accent-purple" style={{ cursor: "pointer" }}>
            <div className="label">Enabled Families</div>
            <div className="value-lg text-purple">{enabledFamilyCount}</div>
            <div className="value-sm">{familyCardSummary || "\u00a0"}</div>
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
              Families: {status.liveLite.familyAllowlist.length}
              {status.familyModeCounts &&
                (() => {
                  const disabled = status.familyModeCounts._disabled ?? 0;
                  const modes = Object.entries(status.familyModeCounts)
                    .filter(([k]) => k !== "_disabled")
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([mode, count]) => `${count} ${mode}`)
                    .join(", ");
                  return (
                    <>
                      {" "}
                      ({modes})
                      {disabled > 0 && (
                        <span style={{ color: "var(--text-dim)", marginLeft: 8 }}>
                          + {disabled} disabled
                        </span>
                      )}
                    </>
                  );
                })()}
            </span>
            <span>Wallet: {(status.liveLite.walletMode ?? "eoa").toUpperCase()}</span>
            <span>
              Min order: $
              {status.liveLite.minOrderUsdc != null ? status.liveLite.minOrderUsdc.toFixed(2) : "—"}
            </span>
            <span>
              Caps: ${status.liveLite.maxOpenValueUsdc} total / ${status.liveLite.maxOrderUsdc} per
              order / {status.liveLite.maxActiveMarkets} markets
            </span>
          </div>
        </div>
      )}

      {/* Tail Risk + Financial */}
      <div className="grid-4" style={{ marginBottom: 16 }}>
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
          <div className="label">Current Value</div>
          <div className="value-lg text-orange">{formatUsd(status.totalCurrentValueUsdc)}</div>
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
        <div className="card card-accent-blue">
          <div className="label">Execution Quality</div>
          <div className="value-lg text-blue">{makerPct != null ? `${makerPct}%` : "—"}</div>
          <div className="value-sm">
            {execution && execution.totalFills > 0
              ? `${execution.makerFills} maker · ${execution.takerFills} taker · ${execution.unknownFills} unknown`
              : "No fills in 24h"}
          </div>
          <div className="value-sm">
            {execution && execution.totalFills > 0
              ? `$${execution.explicitFeesUsdc.toFixed(3)} fees · ${leakagePct?.toFixed(2) ?? "0.00"}% leakage`
              : "Awaiting execution telemetry"}
          </div>
          <div
            className="value-sm"
            style={{
              color: topExecutionWatch ? "var(--orange)" : "var(--text-dim)",
            }}
          >
            {familyMetrics == null
              ? "Loading family telemetry"
              : topExecutionWatch
                ? `Watch: ${formatExecutionWatch(topExecutionWatch)}${executionWatch.length > 1 ? ` · +${executionWatch.length - 1} more` : ""}`
                : "All families clean in 24h"}
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
                {status.executionQueue && (
                  <>
                    {" · "}
                    exec {status.executionQueue.activeCount ?? 0} active /{" "}
                    {status.executionQueue.queueDepth ?? 0} queued /{" "}
                    {status.executionQueue.maxConcurrency ?? "∞"} max
                    {" · "}
                    reserved buy {formatUsd(status.executionQueue.reservedBuyUsdc ?? 0)}
                    {status.executionQueue.freeUsdcForNewOrders != null && (
                      <> / free {formatUsd(status.executionQueue.freeUsdcForNewOrders)}</>
                    )}
                    {(status.executionQueue.cancelReplacePendingCount ?? 0) > 0 && (
                      <> · replace locks {status.executionQueue.cancelReplacePendingCount}</>
                    )}
                    {(status.executionQueue.internalReservationRejectsLast10m ?? 0) > 0 && (
                      <>
                        {" · "}
                        reservation rejects{" "}
                        {status.executionQueue.internalReservationRejectsLast10m}
                      </>
                    )}
                    {formatExecutionRejects(status.executionQueue.gatewayRejectsLast10mByCode) && (
                      <>
                        {" · "}
                        gateway rejects{" "}
                        {formatExecutionRejects(status.executionQueue.gatewayRejectsLast10mByCode)}
                      </>
                    )}
                  </>
                )}
              </span>
            )}
          </div>
          {status.tradingState === "ALIVE_BUT_BLOCKED" && status.signalActivity && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--orange)" }}>
              All {status.signalActivity.signalsRejectedLast10m} entry signals were rejected by risk
              limits
            </div>
          )}
          {status.tradingState === "NO_SIGNALS" && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-dim)" }}>
              {status.signalActivity?.candidatesConsideredLast10m != null &&
              status.signalActivity.candidatesConsideredLast10m > 0
                ? `${status.signalActivity.candidatesConsideredLast10m} candidates considered — ${status.signalActivity.blockedByResolutionBufferLast10m ?? 0} in resolution buffer, ${status.signalActivity.blockedByWindowLast10m ?? 0} outside active window, ${status.signalActivity.blockedByPerFamilyTickLimitLast10m ?? 0} per-family tick limited`
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

      {/* Portfolio Chart + Trading Activity side by side */}
      <div className="grid-2" style={{ marginBottom: 16 }}>
        <PortfolioChart />
        <TradingActivityPanel />
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
                <td style={{ color: "var(--text-muted)" }}>Last order placed</td>
                <td style={{ textAlign: "right" }}>
                  {formatAgo(recentOrders?.items[0]?.createdAt ?? null)}
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
            {probeOnlyCount > 0 && (
              <div
                style={{ flex: probeOnlyCount, background: "var(--blue, #42a5f5)" }}
                title={`${probeOnlyCount} probe-only`}
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
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
              gap: 8,
              marginTop: 10,
              fontSize: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--green)" }}>
                {activeCount}
              </div>
              <div className="value-sm">active</div>
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--blue, #42a5f5)" }}>
                {probeOnlyCount}
              </div>
              <div className="value-sm">probe-only</div>
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
