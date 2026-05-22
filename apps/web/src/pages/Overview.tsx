import { Link } from "react-router-dom";
import { useStatus, useMetrics, useFills, useOrders, useDashboardKpi } from "../api/hooks.ts";
import { PortfolioChart } from "../components/PortfolioChart.tsx";
import { TradingActivityPanel } from "../components/TradingActivityPanel.tsx";
import { PLANKTON_BASELINES, KPI_THRESHOLDS } from "../config/plankton-baselines.ts";
import { formatAgo, formatUsd } from "../utils/format.ts";
import type { DashboardKpiData } from "../api/types.ts";

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

function formatBuyCapacity(
  capacity?: NonNullable<import("../api/types.ts").StatusData["executionQueue"]>["buyCapacity"],
): string | null {
  if (!capacity?.enabled) return null;
  const parts = [
    `entry reserve ${formatUsd(capacity.minNewEntryWalletHeadroomUsdc)}`,
    `add reserve ${formatUsd(capacity.minAddWalletHeadroomUsdc)}`,
    `open buys ${capacity.openBuyOrderCount}/${capacity.maxOpenBuyOrders}`,
    `per token ${capacity.maxOpenBuyOrdersPerToken}`,
  ];
  if (capacity.newEntryCapacityUsdc != null) {
    parts.push(`entry cap ${formatUsd(capacity.newEntryCapacityUsdc)}`);
  }
  if (capacity.addCapacityUsdc != null) {
    parts.push(`add cap ${formatUsd(capacity.addCapacityUsdc)}`);
  }
  return parts.join(" · ");
}

function formatOrderCapacity(
  queue?: NonNullable<import("../api/types.ts").StatusData["executionQueue"]>,
): string | null {
  if (!queue) return null;
  const parts: string[] = [];
  if (queue.sellCapacity?.enabled) {
    parts.push(
      `sells ${queue.sellCapacity.openSellOrderCount}/${queue.sellCapacity.maxOpenSellOrders}`,
      `sell/token ${queue.sellCapacity.maxOpenSellOrdersPerToken}`,
    );
  }
  if (queue.orderCapacity?.enabled) {
    parts.push(
      `total ${queue.orderCapacity.openOrdersTotal}/${queue.orderCapacity.maxOpenOrdersTotal}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function exitsOnlyMessage(status: import("../api/types.ts").StatusData): string {
  const capacity = status.executionQueue?.buyCapacity;
  if (capacity?.entriesBlocked) {
    if (capacity.maxOpenBuyOrders > 0 && capacity.openBuyOrderCount >= capacity.maxOpenBuyOrders) {
      return `Entry capacity exhausted — open BUY order limit reached (${capacity.openBuyOrderCount}/${capacity.maxOpenBuyOrders})`;
    }
    if (capacity.newEntryCapacityUsdc != null && capacity.newEntryCapacityUsdc <= 0) {
      return `Entry capacity exhausted — new entries need ${formatUsd(
        capacity.minNewEntryWalletHeadroomUsdc,
      )} usable wallet headroom after order placement`;
    }
    return `Entry capacity exhausted — new entries need ${formatUsd(
      capacity.minNewEntryWalletHeadroomUsdc,
    )} usable wallet headroom after order placement`;
  }
  if (capacity?.addsBlocked) {
    if (capacity.maxOpenBuyOrders > 0 && capacity.openBuyOrderCount >= capacity.maxOpenBuyOrders) {
      return `Add-buy capacity exhausted — open BUY order limit reached (${capacity.openBuyOrderCount}/${capacity.maxOpenBuyOrders})`;
    }
    if (capacity.addCapacityUsdc != null && capacity.addCapacityUsdc <= 0) {
      return `Add-buy capacity exhausted — adds need ${formatUsd(
        capacity.minAddWalletHeadroomUsdc,
      )} usable wallet headroom after order placement`;
    }
    return `Add-buy capacity exhausted — adds need ${formatUsd(
      capacity.minAddWalletHeadroomUsdc,
    )} usable wallet headroom after order placement`;
  }
  if (
    status.executionQueue?.freeUsdcForNewOrders != null &&
    status.executionQueue.freeUsdcForNewOrders <= 0
  ) {
    return "Wallet buy budget exhausted — only exit signals are active";
  }
  return "Only exit signals active — no new entries being opened";
}

type KpiTone = "green" | "orange" | "red";

function thresholdTone(value: number, threshold: { green: number; yellow: number }): KpiTone {
  if (value >= threshold.green) return "green";
  if (value >= threshold.yellow) return "orange";
  return "red";
}

function healthTone(kpi: DashboardKpiData): KpiTone {
  const health = kpi.health;
  const warningCount = [
    kpi.stuck_positions_count > 0,
    health.lag_p95_ms >= 500,
    health.restarts_24h > 0,
    health.oom_24h > 0,
    health.paused,
    health.mode.toLowerCase() !== "live-lite",
  ].filter(Boolean).length;
  if (kpi.stuck_positions_count >= 4 || warningCount >= 2) return "red";
  if (warningCount === 1) return "orange";
  return "green";
}

function toneAccent(tone: KpiTone): string {
  return `card-accent-${tone}`;
}

function toneBadge(tone: KpiTone): string {
  if (tone === "green") return "badge-green";
  if (tone === "orange") return "badge-orange";
  return "badge-red";
}

function toneColor(tone: KpiTone): string {
  if (tone === "green") return "var(--green)";
  if (tone === "orange") return "var(--orange)";
  return "var(--red)";
}

function toneLabel(tone: KpiTone): string {
  if (tone === "green") return "OK";
  if (tone === "orange") return "WARN";
  return "ALERT";
}

function formatKpiPercent(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatKpiMultiple(value: number): string {
  return `${value.toFixed(1).replace(/\.0$/, "")}×`;
}

function KpiBadge({ tone, testId }: { tone: KpiTone; testId: string }) {
  return (
    <span className={`badge ${toneBadge(tone)}`} data-testid={testId}>
      {toneLabel(tone)}
    </span>
  );
}

function DashboardKpiRow({ kpi }: { kpi?: DashboardKpiData }) {
  if (!kpi) {
    return (
      <div className="grid-4" style={{ marginBottom: 16 }}>
        {["WINRATE 7d", "EXIT MULTIPLE 7d", "FILLS 24h", "HEALTH"].map((label) => (
          <div className="card" key={label}>
            <div className="label">{label}</div>
            <div className="value-lg">—</div>
            <div className="value-sm">Loading KPI snapshot</div>
          </div>
        ))}
      </div>
    );
  }

  const winrateTone = thresholdTone(kpi.winrate_7d.value, KPI_THRESHOLDS.winrate);
  const exitTone = thresholdTone(kpi.exit_multiple_7d.median, KPI_THRESHOLDS.exitMultiple);
  const fillsTone = thresholdTone(kpi.fills_24h.total, KPI_THRESHOLDS.fillsDaily);
  const makerTone = thresholdTone(kpi.fills_24h.maker_ratio, KPI_THRESHOLDS.makerRatio);
  const healthStatusTone = healthTone(kpi);

  return (
    <div className="grid-4" style={{ marginBottom: 16 }}>
      <div className={`card ${toneAccent(winrateTone)}`} data-testid="kpi-winrate-card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div className="label">WINRATE 7d</div>
          <KpiBadge tone={winrateTone} testId="kpi-winrate-status" />
        </div>
        <div className="value-lg" style={{ color: toneColor(winrateTone) }}>
          {formatKpiPercent(kpi.winrate_7d.value)}
        </div>
        <div className="value-sm">/ {formatKpiPercent(PLANKTON_BASELINES.winrate)} Plankton</div>
        <div className="value-sm">
          {kpi.winrate_7d.wins} win · {kpi.winrate_7d.losses} loss · {kpi.winrate_7d.total} closed
        </div>
        <div
          className="value-sm"
          style={{ borderTop: "1px solid var(--border)", marginTop: 10, paddingTop: 10 }}
        >
          SELL: {formatKpiPercent(kpi.winrate_7d.sell_closed_pct)} · Resolved:{" "}
          {formatKpiPercent(kpi.winrate_7d.resolved_closed_pct)}
        </div>
      </div>

      <div className={`card ${toneAccent(exitTone)}`} data-testid="kpi-exit-multiple-card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div className="label">EXIT MULTIPLE 7d</div>
          <KpiBadge tone={exitTone} testId="kpi-exit-multiple-status" />
        </div>
        <div className="value-lg" style={{ color: toneColor(exitTone) }}>
          {formatKpiMultiple(kpi.exit_multiple_7d.median)}
        </div>
        <div className="value-sm">
          / {formatKpiMultiple(PLANKTON_BASELINES.exitMultipleMedian)} Plankton
        </div>
        <div className="value-sm">
          P90: {formatKpiMultiple(kpi.exit_multiple_7d.p90)} /{" "}
          {formatKpiMultiple(PLANKTON_BASELINES.exitMultipleP90)} · n=
          {kpi.exit_multiple_7d.count}
        </div>
      </div>

      <div className={`card ${toneAccent(fillsTone)}`} data-testid="kpi-fills-card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div className="label">FILLS 24h</div>
          <KpiBadge tone={fillsTone} testId="kpi-fills-status" />
        </div>
        <div className="value-lg" style={{ color: toneColor(fillsTone) }}>
          {kpi.fills_24h.total} fills
        </div>
        <div className="value-sm">
          Maker: {formatKpiPercent(kpi.fills_24h.maker_ratio)} /{" "}
          {formatKpiPercent(PLANKTON_BASELINES.makerRatio)} Plankton
        </div>
        <div className="value-sm">
          {kpi.fills_24h.maker} maker · {kpi.fills_24h.taker} taker
        </div>
        <div className="value-sm">
          maker quality{" "}
          <span
            className={
              makerTone === "green"
                ? "text-green"
                : makerTone === "orange"
                  ? "text-orange"
                  : "text-red"
            }
          >
            {toneLabel(makerTone)}
          </span>
        </div>
      </div>

      <div className={`card ${toneAccent(healthStatusTone)}`} data-testid="kpi-health-card">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div className="label">HEALTH</div>
          <KpiBadge tone={healthStatusTone} testId="kpi-health-status" />
        </div>
        <div className="value-lg" style={{ color: toneColor(healthStatusTone) }}>
          {healthStatusTone === "green" ? "All systems normal" : "Needs attention"}
        </div>
        <div className="value-sm">{kpi.stuck_positions_count} stuck positions</div>
        <div className="value-sm">
          WS {kpi.health.ws_tracked} · lag p95 {kpi.health.lag_p95_ms.toFixed(0)}ms
        </div>
        <div className="value-sm">
          Restarts {kpi.health.restarts_24h} · OOM {kpi.health.oom_24h}
        </div>
        <div className="value-sm">
          Mode: {kpi.health.mode.toUpperCase()}
          {kpi.health.paused ? " · PAUSED" : ""}
        </div>
        <div className="value-sm" style={{ marginTop: 12 }}>
          <Link to="/debug">/debug -&gt;</Link>
        </div>
      </div>
    </div>
  );
}

function BalanceCard({ status }: { status: import("../api/types.ts").StatusData }) {
  const isLive = status.runtimeMode === "live-lite";
  const dim = { color: "var(--text-dim)" };
  const headerLabelStyle = {
    color: "var(--text-muted)",
    fontSize: 12,
    fontWeight: 500,
    textTransform: "none" as const,
    letterSpacing: 0,
  };

  const polymarketPortfolio = isLive ? status.polymarketPortfolio : null;

  // Top number: wallet balance (live-lite) or virtual balance (paper/sim)
  const topBalance =
    polymarketPortfolio?.availableUsdc ?? (isLive ? status.walletBalanceUsdc : status.balanceUsdc);

  // If-close-all: top balance + current value of open positions
  const ifCloseAll =
    polymarketPortfolio?.portfolioUsdc ??
    (topBalance != null ? topBalance + status.totalCurrentValueUsdc : null);

  // Invested vs cap
  const positionValue = polymarketPortfolio?.positionValueUsdc ?? status.totalOpenValueUsdc;
  const cap = isLive ? status.liveLite?.maxOpenValueUsdc : status.initialBalanceUsdc;

  return (
    <div
      className={`card ${isLive ? "card-accent-green" : ""}`}
      data-testid="overview-balance-card"
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 16,
          marginBottom: 10,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={headerLabelStyle}>Portfolio</div>
          <div
            className="value-lg"
            style={{
              fontSize: 32,
              lineHeight: 1.1,
              marginTop: 8,
              color: isLive ? "var(--green)" : "var(--text)",
            }}
          >
            {formatUsd(ifCloseAll)}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0, paddingTop: 2 }}>
          <div style={headerLabelStyle}>Available to trade</div>
          <div
            className="value-lg"
            style={{
              marginTop: 8,
              fontSize: 16,
              lineHeight: 1.1,
              color: isLive ? "var(--green)" : "var(--text)",
            }}
          >
            {formatUsd(topBalance)}
          </div>
        </div>
      </div>
      <div className="value-sm" style={dim}>
        {cap != null
          ? `${formatUsd(positionValue)} position value / ${formatUsd(cap)} ${
              isLive ? "cap" : "initial"
            }`
          : `${formatUsd(positionValue)} position value`}
      </div>
    </div>
  );
}

export function Overview() {
  const { data: status } = useStatus();
  const { data: metrics } = useMetrics();
  const { data: dashboardKpi } = useDashboardKpi();
  const { data: recentFills } = useFills({ limit: 1 });
  const { data: recentOrders } = useOrders({ limit: 1 });

  if (!status || !metrics) return <div className="page">Loading...</div>;

  const dustCount = metrics.positions.dust ?? 0;
  const openConditionCount = status.openConditionCount;
  const execution = status.executionTelemetry24h;
  const makerPct = execution?.makerRatio != null ? Math.round(execution.makerRatio * 100) : null;
  const leakagePct = execution?.feeLeakageRatio != null ? execution.feeLeakageRatio * 100 : null;

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
            <div className="label">Open Positions</div>
            <div className="value-lg text-blue">{status.openPositionCount}</div>
            <div style={{ marginTop: "auto" }}>
              <div className="value-sm">{dustCount} dust</div>
              <div className="value-sm">{status.positionsOpenedLastMin} in last min</div>
            </div>
          </div>
        </Link>
        <Link to="/orders" style={{ textDecoration: "none" }}>
          <div
            className="card card-accent-blue"
            style={{ cursor: "pointer", display: "flex", flexDirection: "column" }}
          >
            <div className="label">Open Orders</div>
            <div className="value-lg text-blue">{status.openOrderCount}</div>
            <div style={{ marginTop: "auto" }}>
              <div className="value-sm">{status.ordersPlacedLastMin} in last min</div>
            </div>
          </div>
        </Link>
        <Link to="/selection-rules" style={{ textDecoration: "none" }}>
          <div className="card card-accent-purple" style={{ cursor: "pointer" }}>
            <div className="label">Active Markets</div>
            <div className="value-lg text-purple">{openConditionCount}</div>
            <div className="value-sm">
              <span style={{ fontSize: 11 }}>View selection rules</span>
            </div>
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

      <DashboardKpiRow kpi={dashboardKpi} />

      {/* Financial */}
      <div className="grid-3" style={{ marginBottom: 16 }}>
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
          <div className="value-sm" style={{ color: "var(--text-dim)" }}>
            {execution && execution.totalFills > 0
              ? "Execution telemetry available"
              : "No recent fills"}
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
                    {formatBuyCapacity(status.executionQueue.buyCapacity) && (
                      <>
                        {" · "}
                        capacity {formatBuyCapacity(status.executionQueue.buyCapacity)}
                      </>
                    )}
                    {formatOrderCapacity(status.executionQueue) && (
                      <>
                        {" · "}
                        {formatOrderCapacity(status.executionQueue)}
                      </>
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
                ? `${status.signalActivity.candidatesConsideredLast10m} candidates considered — ${status.signalActivity.blockedByResolutionBufferLast10m ?? 0} in resolution buffer, ${status.signalActivity.blockedByWindowLast10m ?? 0} outside active window`
                : "No signals produced — markets may be outside active window or in resolution buffer"}
            </div>
          )}
          {status.tradingState === "EXITS_ONLY" && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--orange)" }}>
              {exitsOnlyMessage(status)}
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
            Open Conditions
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 8,
              marginTop: 10,
              fontSize: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: "var(--green)" }}>
                {openConditionCount}
              </div>
              <div className="value-sm">open conditions</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
