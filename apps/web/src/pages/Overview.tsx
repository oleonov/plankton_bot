import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useStatus, useMetrics, useFills, useOrders, useDashboardKpi } from "../api/hooks.ts";
import { PortfolioChart } from "../components/PortfolioChart.tsx";
import { TradingActivityPanel } from "../components/TradingActivityPanel.tsx";
import {
  PLANKTON_BASELINES,
  KPI_THRESHOLDS,
  SUB_METRIC_THRESHOLDS,
} from "../config/plankton-baselines.ts";
import { formatAgo, formatUsd } from "../utils/format.ts";
import type {
  DashboardKpiData,
  DashboardHealthSeverity,
  DashboardHealthCheck,
  DashboardWinrateCohort,
} from "../api/types.ts";

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

type KpiSeverity = DashboardHealthSeverity;

function severityFromValue(
  value: number,
  threshold: { green: number; yellow: number },
): KpiSeverity {
  if (value >= threshold.green) return "ok";
  if (value >= threshold.yellow) return "warn";
  return "crit";
}

function worseOf(...states: KpiSeverity[]): KpiSeverity {
  if (states.includes("crit")) return "crit";
  if (states.includes("warn")) return "warn";
  return "ok";
}

function statusLabel(severity: KpiSeverity): string {
  if (severity === "ok") return "OK";
  if (severity === "warn") return "Warn";
  return "Crit";
}

function formatPercent(value: number, fractionDigits = 1): string {
  return `${value.toFixed(fractionDigits)}%`;
}

function formatMultiple(value: number, fractionDigits = 1): string {
  return `${value.toFixed(fractionDigits)}×`;
}

function formatDeltaPp(delta: number): string {
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}${Math.abs(delta).toFixed(1)}pp`;
}

function formatDeltaMultiple(delta: number): string {
  const sign = delta >= 0 ? "+" : "−";
  return `${sign}${Math.abs(delta).toFixed(1)}×`;
}

function formatThousands(value: number): string {
  return value.toLocaleString("en-US");
}

function deltaClass(delta: number): string {
  if (delta > 0) return "kpi-delta--up";
  if (delta < 0) return "kpi-delta--down";
  return "kpi-delta--flat";
}

function deltaArrow(delta: number): string {
  if (delta > 0) return "▲";
  if (delta < 0) return "▼";
  return "·";
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function severityClass(severity: KpiSeverity, prefix: string): string {
  return `${prefix}--${severity}`;
}

interface ThresholdBarProps {
  segments: Array<{ flex: number; color: "red" | "amber" | "green" }>;
  baselinePercent: number;
  currentPercent: number;
  legend: ReadonlyArray<{ label: string; baseline?: boolean }>;
  testId?: string;
}

function ThresholdBar({
  segments,
  baselinePercent,
  currentPercent,
  legend,
  testId,
}: ThresholdBarProps) {
  const bl = clampPercent(baselinePercent);
  const cur = clampPercent(currentPercent);
  return (
    <>
      <div className="threshold-bar" data-testid={testId}>
        {segments.map((seg, i) => (
          <span
            key={i}
            className={`threshold-bar__seg threshold-bar__seg--${seg.color}`}
            style={{ flex: seg.flex }}
          />
        ))}
        <span className="threshold-bar__baseline" style={{ left: `${bl}%` }} />
        <span className="threshold-bar__current" style={{ left: `${cur}%` }} />
      </div>
      <div className="threshold-bar-legend">
        {legend.map((tick, i) => (
          <span key={i} className={tick.baseline ? "threshold-bar-legend__bl" : undefined}>
            {tick.label}
          </span>
        ))}
      </div>
    </>
  );
}

interface KpiCardShellProps {
  title: string;
  period: string;
  severity: KpiSeverity;
  testId: string;
  statusTestId: string;
  children: ReactNode;
}

function KpiCardShell({
  title,
  period,
  severity,
  testId,
  statusTestId,
  children,
}: KpiCardShellProps) {
  return (
    <article className="kpi-card" data-state={severity} data-testid={testId}>
      <header className="kpi-card__head">
        <span className="kpi-card__title">{title}</span>
        <span className="kpi-card__period">{period}</span>
        <span
          className={`kpi-status ${severityClass(severity, "kpi-status")}`}
          data-testid={statusTestId}
        >
          <span className="kpi-status__dot" />
          {statusLabel(severity)}
        </span>
      </header>
      {children}
    </article>
  );
}

function WinrateCohortBlock({
  cohort,
  cutoff,
  testId,
}: {
  cohort: DashboardWinrateCohort;
  cutoff: string;
  testId: "pre_v072" | "post_v072";
}) {
  const severity = severityFromValue(cohort.value, KPI_THRESHOLDS.winrate);
  return (
    <div
      className="kpi-cohort"
      data-state={severity}
      data-testid={`kpi-winrate-cohort-${testId}`}
      title={`v072 deploy cutoff: ${cutoff}`}
    >
      <div className="kpi-cohort__head">
        <span className="kpi-cohort__label">{cohort.label}</span>
        <span
          className={`kpi-cohort__value ${severityClass(severity, "kpi-cohort__value")}`}
          data-testid={`kpi-winrate-cohort-${testId}-value`}
        >
          {formatPercent(cohort.value)}
        </span>
      </div>
      <div className="kpi-cohort__line">
        <span>{formatThousands(cohort.total)} closed</span>
        <span>
          {formatThousands(cohort.wins)}W · {formatThousands(cohort.losses)}L
        </span>
      </div>
      <div className="kpi-cohort__line">
        <span>SELL {formatPercent(cohort.sell_closed_pct)}</span>
        <span>Resolved {formatPercent(cohort.resolved_closed_pct)}</span>
      </div>
      <div className="kpi-cohort__baseline">
        Plankton {formatPercent(PLANKTON_BASELINES.winrate)}
      </div>
    </div>
  );
}

function WinrateCard({ kpi }: { kpi: DashboardKpiData["winrate_7d"] }) {
  const severity = severityFromValue(kpi.value, KPI_THRESHOLDS.winrate);
  const delta = kpi.value - PLANKTON_BASELINES.winrate;
  const sellSeverity = severityFromValue(kpi.sell_closed_pct, SUB_METRIC_THRESHOLDS.sellClosed);
  const resolvedSeverity = severityFromValue(
    kpi.resolved_closed_pct,
    SUB_METRIC_THRESHOLDS.resolvedClosed,
  );
  return (
    <KpiCardShell
      title="Winrate"
      period="7d"
      severity={severity}
      testId="kpi-winrate-card"
      statusTestId="kpi-winrate-status"
    >
      <div className="kpi-card__primary">
        <span className="kpi-card__big">
          {kpi.value.toFixed(1)}
          <span className="unit">%</span>
        </span>
      </div>
      <div className={`kpi-card__delta ${deltaClass(delta)}`}>
        vs <b>{formatPercent(PLANKTON_BASELINES.winrate)} Plankton</b>{" "}
        <span className="arrow">{deltaArrow(delta)}</span>
        {formatDeltaPp(delta)}
      </div>
      <ThresholdBar
        segments={[
          { flex: 65, color: "red" },
          { flex: 15, color: "amber" },
          { flex: 20, color: "green" },
        ]}
        baselinePercent={PLANKTON_BASELINES.winrate}
        currentPercent={kpi.value}
        legend={[
          { label: "0%" },
          { label: "65" },
          { label: "80" },
          { label: "85 ┊ bl", baseline: true },
          { label: "100%" },
        ]}
      />
      <hr className="kpi-sep" />
      <div className="kpi-kvrow">
        <span className="kpi-kvrow__label">Closed</span>
        <span className="kpi-kvrow__value">{formatThousands(kpi.total)}</span>
        <span className="kpi-kvrow__bl">
          {formatThousands(kpi.wins)}W · {formatThousands(kpi.losses)}L
        </span>
      </div>
      <div className="kpi-kvrow kpi-kvrow--small">
        <span className="kpi-kvrow__label">SELL-closed</span>
        <span className={`kpi-kvrow__value ${severityClass(sellSeverity, "kpi-kvrow__value")}`}>
          {formatPercent(kpi.sell_closed_pct)}
        </span>
        <span className="kpi-kvrow__bl">
          / {Math.round(PLANKTON_BASELINES.winrateSellClosed)}% bl
        </span>
      </div>
      <div className="kpi-kvrow kpi-kvrow--small">
        <span className="kpi-kvrow__label">Resolved-closed</span>
        <span className={`kpi-kvrow__value ${severityClass(resolvedSeverity, "kpi-kvrow__value")}`}>
          {formatPercent(kpi.resolved_closed_pct)}
        </span>
        <span className="kpi-kvrow__bl">
          / {Math.round(PLANKTON_BASELINES.winrateResolved)}% bl
        </span>
      </div>
      <hr className="kpi-sep" />
      <div className="kpi-cohort-grid" aria-label="Winrate by v072 deployment cohort">
        <WinrateCohortBlock
          cohort={kpi.cohorts.pre_v072}
          cutoff={kpi.cohort_cutoff}
          testId="pre_v072"
        />
        <WinrateCohortBlock
          cohort={kpi.cohorts.post_v072}
          cutoff={kpi.cohort_cutoff}
          testId="post_v072"
        />
      </div>
    </KpiCardShell>
  );
}

function ExitMultipleCard({ kpi }: { kpi: DashboardKpiData["exit_multiple_7d"] }) {
  const severity = severityFromValue(kpi.median, KPI_THRESHOLDS.exitMultiple);
  const delta = kpi.median - PLANKTON_BASELINES.exitMultipleMedian;
  const currentPercent = (kpi.median / 6) * 100;
  return (
    <KpiCardShell
      title="Exit Multiple"
      period="7d"
      severity={severity}
      testId="kpi-exit-multiple-card"
      statusTestId="kpi-exit-multiple-status"
    >
      <div className="kpi-card__primary">
        <span className="kpi-card__big">
          {kpi.median.toFixed(1)}
          <span className="unit">×</span>
        </span>
      </div>
      <div className={`kpi-card__delta ${deltaClass(delta)}`}>
        median · vs <b>{formatMultiple(PLANKTON_BASELINES.exitMultipleMedian)} Plankton</b>{" "}
        <span className="arrow">{deltaArrow(delta)}</span>
        {formatDeltaMultiple(delta)}
      </div>
      <ThresholdBar
        segments={[
          { flex: 25, color: "red" },
          { flex: 17, color: "amber" },
          { flex: 58, color: "green" },
        ]}
        baselinePercent={50}
        currentPercent={currentPercent}
        legend={[
          { label: "0×" },
          { label: "1.5" },
          { label: "2.5" },
          { label: "3.0 ┊ bl", baseline: true },
          { label: "6×" },
        ]}
      />
      <hr className="kpi-sep" />
      <div className="kpi-kvrow">
        <span className="kpi-kvrow__label">P90</span>
        <span className="kpi-kvrow__value">{formatMultiple(kpi.p90)}</span>
        <span className="kpi-kvrow__bl">
          / {formatMultiple(PLANKTON_BASELINES.exitMultipleP90)} bl
        </span>
      </div>
      <div className="kpi-kvrow kpi-kvrow--small">
        <span className="kpi-kvrow__label">Sample (closed-via-sell)</span>
        <span className="kpi-kvrow__value">n={kpi.count}</span>
        <span className="kpi-kvrow__bl">filtered ≥2×</span>
      </div>
    </KpiCardShell>
  );
}

function FillsCard({ kpi }: { kpi: DashboardKpiData["fills_24h"] }) {
  const rateSeverity = severityFromValue(kpi.rate_per_position, KPI_THRESHOLDS.fillsRate);
  const makerSeverity = severityFromValue(kpi.maker_ratio, KPI_THRESHOLDS.makerRatio);
  const severity = worseOf(rateSeverity, makerSeverity);
  const makerDelta = kpi.maker_ratio - PLANKTON_BASELINES.makerRatio;
  const ratePercent = Math.min(100, (kpi.rate_per_position / 1.5) * 100);
  return (
    <KpiCardShell
      title="Fills"
      period="24h"
      severity={severity}
      testId="kpi-fills-card"
      statusTestId="kpi-fills-status"
    >
      <div
        className={`kpi-submetric kpi-submetric--first ${severityClass(rateSeverity, "kpi-submetric")}`}
      >
        <div>
          <div className="kpi-submetric__label">Total · rate</div>
          <div className="kpi-submetric__val" data-testid="kpi-fills-rate-value">
            {formatThousands(kpi.total)} · {kpi.rate_per_position.toFixed(2)}
            <span className="unit">/pos</span>
          </div>
        </div>
        <span className="kpi-submetric__bl">
          / {PLANKTON_BASELINES.fillsPerPositionPerDay.toFixed(2)} Plankton
        </span>
      </div>
      <ThresholdBar
        segments={[
          { flex: 15, color: "red" },
          { flex: 20, color: "amber" },
          { flex: 65, color: "green" },
        ]}
        baselinePercent={50}
        currentPercent={ratePercent}
        legend={[
          { label: "0" },
          { label: "0.22" },
          { label: "0.52" },
          { label: "0.75 ┊ bl", baseline: true },
          { label: "1.5+" },
        ]}
      />
      <div className={`kpi-submetric ${severityClass(makerSeverity, "kpi-submetric")}`}>
        <div>
          <div className="kpi-submetric__label">Maker ratio</div>
          <div className="kpi-submetric__val" data-testid="kpi-fills-maker-value">
            {kpi.maker_ratio.toFixed(1)}
            <span className="unit">%</span>
          </div>
        </div>
        <span className="kpi-submetric__bl">
          / {formatPercent(PLANKTON_BASELINES.makerRatio)} bl{" "}
          <span className={deltaClass(makerDelta)}>
            {deltaArrow(makerDelta)} {formatDeltaPp(makerDelta)}
          </span>
        </span>
      </div>
      <ThresholdBar
        segments={[
          { flex: 75, color: "red" },
          { flex: 13, color: "amber" },
          { flex: 12, color: "green" },
        ]}
        baselinePercent={PLANKTON_BASELINES.makerRatio}
        currentPercent={kpi.maker_ratio}
        legend={[
          { label: "0%" },
          { label: "75" },
          { label: "88" },
          { label: "91 ┊ bl", baseline: true },
          { label: "100%" },
        ]}
      />
      <div className="kpi-kvrow kpi-kvrow--small" style={{ marginTop: 6 }}>
        <span className="kpi-kvrow__label">Maker / Taker / Unk</span>
        <span className="kpi-kvrow__value">
          {kpi.maker} · {kpi.taker} · {kpi.unknown}
        </span>
        <span className="kpi-kvrow__bl">
          BUY {Math.round(PLANKTON_BASELINES.makerRatioBuy)}% · SELL{" "}
          {Math.round(PLANKTON_BASELINES.makerRatioSell)}% bl
        </span>
      </div>
    </KpiCardShell>
  );
}

function healthHeadline(kpi: DashboardKpiData): string {
  const severity = kpi.health.severity;
  if (severity === "ok") return "All systems normal";
  const parts: string[] = [];
  if (kpi.stuck_positions_count > 0) {
    parts.push(`${kpi.stuck_positions_count} stuck`);
  }
  if (kpi.health.mode.toLowerCase() === "degraded") {
    parts.push("degraded");
  } else if (kpi.health.paused) {
    parts.push("paused");
  } else if (kpi.health.oom_24h > 0) {
    parts.push(`${kpi.health.oom_24h} OOM`);
  } else if (kpi.health.restarts_24h > 0) {
    parts.push(`${kpi.health.restarts_24h} restart${kpi.health.restarts_24h === 1 ? "" : "s"}`);
  } else if (kpi.health.lag_p95_ms >= 200) {
    parts.push("WS lag");
  }
  return parts.length > 0 ? parts.join(" · ") : "Needs attention";
}

function HealthCard({ kpi }: { kpi: DashboardKpiData }) {
  const severity = kpi.health.severity;
  const issueCount = kpi.health.checks.filter((check) => check.severity !== "ok").length;
  const headline = healthHeadline(kpi);
  return (
    <KpiCardShell
      title="Health"
      period="live"
      severity={severity}
      testId="kpi-health-card"
      statusTestId="kpi-health-status"
    >
      <div className="kpi-card__primary">
        <span className="kpi-card__big kpi-card__big--sentence">{headline}</span>
      </div>
      <div className="kpi-card__delta">
        {issueCount} {issueCount === 1 ? "issue" : "issues"}
      </div>
      <div className="kpi-checks" data-testid="kpi-health-checks">
        {kpi.health.checks.map((check: DashboardHealthCheck) => (
          <div
            key={check.key}
            className={`kpi-check ${severityClass(check.severity, "kpi-check")}`}
            data-testid={`kpi-health-check-${check.key}`}
          >
            <span className="kpi-check__dot" />
            <span className="kpi-check__label">{check.label}</span>
            <span className="kpi-check__value">{check.value}</span>
          </div>
        ))}
      </div>
      <div className="kpi-card__footer">
        <span>
          WS tracked: {formatThousands(kpi.health.ws_tracked)}/
          {formatThousands(kpi.health.ws_total)}
        </span>
        <Link to="/debug">/debug →</Link>
      </div>
    </KpiCardShell>
  );
}

function DashboardKpiLoadingRow() {
  const placeholders = [
    { title: "Winrate", period: "7d" },
    { title: "Exit Multiple", period: "7d" },
    { title: "Fills", period: "24h" },
    { title: "Health", period: "live" },
  ];
  return (
    <div className="kpi-row">
      {placeholders.map(({ title, period }) => (
        <article className="kpi-card" key={title}>
          <header className="kpi-card__head">
            <span className="kpi-card__title">{title}</span>
            <span className="kpi-card__period">{period}</span>
          </header>
          <div className="kpi-card__primary">
            <span className="kpi-card__big">—</span>
          </div>
          <div className="kpi-card__delta">Loading KPI snapshot</div>
        </article>
      ))}
    </div>
  );
}

function DashboardKpiRow({ kpi }: { kpi?: DashboardKpiData }) {
  if (!kpi) {
    return <DashboardKpiLoadingRow />;
  }
  return (
    <div className="kpi-row">
      <WinrateCard kpi={kpi.winrate_7d} />
      <ExitMultipleCard kpi={kpi.exit_multiple_7d} />
      <FillsCard kpi={kpi.fills_24h} />
      <HealthCard kpi={kpi} />
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
