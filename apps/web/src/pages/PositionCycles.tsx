import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { usePositionCycles } from "../api/hooks.ts";
import type { PositionCycleDTO, PositionCycleOperationDTO } from "../api/types.ts";
import { Pagination } from "../components/Pagination.tsx";
import { MarketLink } from "../components/MarketLink.tsx";
import { fmtDuration, fmtMoney, fmtPct } from "./positions/lib.ts";
import { formatTimestamp } from "../utils/format.ts";

const PAGE_SIZE = 25;

const STATUS_LABEL: Record<string, string> = {
  CLOSED_PROFIT: "CLOSED PROFIT",
  CLOSED_LOSS: "CLOSED LOSS",
  OPEN_PROFIT: "OPEN PROFIT",
  OPEN_LOSS: "OPEN LOSS",
  DUST_OPEN: "DUST OPEN",
  HELD_TO_LOSING_RESOLUTION: "LOST @ RESOLUTION",
  UNKNOWN_ACCT: "UNKNOWN ACCT",
};

const FLAG_META: Record<string, { label: string; icon: string; tone: string; title: string }> = {
  dust: { label: "Dust", icon: "o", tone: "neutral", title: "Small remainder / dust position" },
  no_live_exit: { label: "No live exit", icon: "x", tone: "warn", title: "No active SELL order" },
  low_liq: {
    label: "Low liq",
    icon: "L",
    tone: "warn",
    title: "Liquidation value is far below mark",
  },
  resolution: {
    label: "Resolution",
    icon: "R",
    tone: "reso",
    title: "Closed by market resolution",
  },
  acct_mismatch: {
    label: "Acct mismatch",
    icon: "!",
    tone: "warn",
    title: "Ledger does not reconcile",
  },
  incomplete_basis: {
    label: "Incomplete basis",
    icon: "∅",
    tone: "warn",
    title: "Cost basis incomplete",
  },
};

type FilterState = {
  period: "24h" | "7d" | "30d" | "all";
  status: "all" | "open" | "closed" | "dust" | "resolution" | "acct_warnings";
  pnl: "all" | "profit" | "loss" | "zero";
  source: string;
  band: string;
  sort: "worst_pnl" | "best_pnl" | "newest" | "longest_held" | "dust_value";
};

const DEFAULT_FILTERS: FilterState = {
  period: "24h",
  status: "all",
  pnl: "all",
  source: "all",
  band: "all",
  sort: "worst_pnl",
};

export function PositionCycles() {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const query = usePositionCycles({ ...filters, page, pageSize: PAGE_SIZE });

  const setFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const data = query.data;
  const pageInfo = data
    ? pageRangeLabel(
        data.pagination.page,
        PAGE_SIZE,
        data.pagination.totalCount,
        data.cycles.length,
      )
    : undefined;

  return (
    <div className="page pnl-page">
      <header className="pnl-header">
        <div>
          <h1>
            Position Cycles{" "}
            <span className="pnl-header__count">({data?.pagination.totalCount ?? 0} cycles)</span>
          </h1>
          <div className="pnl-header__sub">read-only · P&amp;L</div>
        </div>
      </header>

      <SummaryCards data={data} period={filters.period} loading={query.isLoading} />
      <FilterBar filters={filters} onChange={setFilter} />
      <FlagLegend />

      {query.isLoading ? (
        <LoadingRows />
      ) : query.isError ? (
        <StatePanel
          tone="warn"
          title="Couldn't load position cycles"
          detail="The bot is unaffected. Retry the read-only query."
          action={<button onClick={() => void query.refetch()}>Retry</button>}
        />
      ) : !data ? (
        <StatePanel
          tone="neutral"
          title="No position cycles in this period"
          detail="Try widening the period or clearing filters."
        />
      ) : (
        <>
          {filters.status === "all" && data.accountingWarnings.length > 0 ? (
            <section className="pnl-warnings" data-testid="accounting-warnings">
              <div className="pnl-warnings__title">
                Accounting warnings{" "}
                <span>excluded from P&amp;L totals &amp; sort · realized / net hidden</span>
              </div>
              <div className="pnl-list">
                {data.accountingWarnings.map((cycle) => (
                  <PositionCycleRow
                    key={`warning-${cycle.positionId}`}
                    cycle={cycle}
                    expanded={expanded.has(cycle.positionId)}
                    onToggle={() => toggleExpanded(cycle.positionId)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {data.cycles.length === 0 ? (
            <StatePanel
              tone="neutral"
              title="No cycles match current filters"
              detail="Try clearing filters or widening the period."
            />
          ) : (
            <>
              <div className="pnl-list" data-testid="position-cycles-list">
                {data.cycles.map((cycle) => (
                  <PositionCycleRow
                    key={cycle.positionId}
                    cycle={cycle}
                    expanded={expanded.has(cycle.positionId)}
                    onToggle={() => toggleExpanded(cycle.positionId)}
                  />
                ))}
              </div>
              <Pagination
                page={data.pagination.page}
                totalPages={data.pagination.totalPages}
                onPageChange={setPage}
                pageInfo={pageInfo}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function SummaryCards({
  data,
  period,
  loading,
}: {
  data: ReturnType<typeof usePositionCycles>["data"];
  period: string;
  loading: boolean;
}) {
  const summary = data?.summary;
  return (
    <div className="pnl-summary">
      <SummaryCard
        title="Closed Realized P&L"
        period={period}
        value={loading ? "…" : moneyOrNa(summary?.closedRealizedPnlUsd ?? 0, true)}
        detail={`${summary?.closedCycleCount ?? 0} closed cycles`}
        tone={signTone(summary?.closedRealizedPnlUsd ?? 0)}
      />
      <SummaryCard
        title="Open Net P&L"
        period={period}
        value={loading ? "…" : moneyOrNa(summary?.openNetPnlUsd ?? 0, true)}
        detail={`by mark · liq ${moneyPlain(summary?.openLiquidationUsd ?? 0)} · mark ${moneyPlain(summary?.openMarkUsd ?? 0)}`}
        tone={signTone(summary?.openNetPnlUsd ?? 0)}
      />
      <SummaryCard
        title="Winners / Losers"
        period={period}
        value={`${summary?.winners ?? 0} / ${summary?.losers ?? 0}`}
        detail="known accounting only"
        tone="neutral"
      />
      <SummaryCard
        title="Dust / Stuck Exposure"
        period={period}
        value={moneyPlain(summary?.dustLiquidationUsd ?? 0)}
        detail={`${summary?.dustCount ?? 0} positions · liq value`}
        tone="neutral"
      />
      <SummaryCard
        title="Accounting Warnings"
        period={period}
        value={String(summary?.accountingWarningCount ?? 0)}
        detail="unknown / mismatch / low conf"
        tone={(summary?.accountingWarningCount ?? 0) > 0 ? "warn" : "neutral"}
      />
    </div>
  );
}

function SummaryCard({
  title,
  period,
  value,
  detail,
  tone,
}: {
  title: string;
  period: string;
  value: string;
  detail: string;
  tone: string;
}) {
  return (
    <div className="pnl-summary-card" data-tone={tone}>
      <div className="pnl-summary-card__title">
        {title} <span>{period}</span>
      </div>
      <div className="pnl-summary-card__value">{value}</div>
      <div className="pnl-summary-card__detail">{detail}</div>
    </div>
  );
}

function FilterBar({
  filters,
  onChange,
}: {
  filters: FilterState;
  onChange: <K extends keyof FilterState>(key: K, value: FilterState[K]) => void;
}) {
  return (
    <div className="pnl-filters">
      <div className="pnl-segmented" aria-label="Period">
        {(["24h", "7d", "30d", "all"] as const).map((period) => (
          <button
            key={period}
            className={filters.period === period ? "on" : ""}
            onClick={() => onChange("period", period)}
          >
            {period}
          </button>
        ))}
      </div>
      <select
        value={filters.status}
        onChange={(event) => onChange("status", event.target.value as FilterState["status"])}
      >
        <option value="all">all status</option>
        <option value="open">open</option>
        <option value="closed">closed</option>
        <option value="dust">dust</option>
        <option value="resolution">resolution</option>
        <option value="acct_warnings">acct warnings</option>
      </select>
      <div className="pnl-segmented" aria-label="P&L">
        {(["all", "profit", "loss", "zero"] as const).map((pnl) => (
          <button
            key={pnl}
            className={filters.pnl === pnl ? "on" : ""}
            onClick={() => onChange("pnl", pnl)}
          >
            {pnl}
          </button>
        ))}
      </div>
      <select value={filters.source} onChange={(event) => onChange("source", event.target.value)}>
        <option value="all">all sources</option>
        <option value="ProfileLadder">ProfileLadder</option>
        <option value="D3">D3</option>
        <option value="D4">D4</option>
        <option value="D7">D7</option>
        <option value="D8">D8</option>
        <option value="D9">D9</option>
        <option value="S4">S4</option>
        <option value="settlement">settlement</option>
        <option value="R23">R23</option>
        <option value="scale-in">scale-in</option>
      </select>
      <select value={filters.band} onChange={(event) => onChange("band", event.target.value)}>
        <option value="all">all bands</option>
        <option value="cheap">cheap</option>
        <option value="medium_low">medium_low</option>
        <option value="medium_high">medium_high</option>
        <option value="expensive">expensive</option>
      </select>
      <select
        value={filters.sort}
        onChange={(event) => onChange("sort", event.target.value as FilterState["sort"])}
      >
        <option value="worst_pnl">worst P&L</option>
        <option value="best_pnl">best P&L</option>
        <option value="newest">newest</option>
        <option value="longest_held">longest held</option>
        <option value="dust_value">dust value</option>
      </select>
    </div>
  );
}

function FlagLegend() {
  return (
    <div className="pnl-legend">
      Flags: <span>o Dust</span> · <span>x No live exit</span> · <span>L Low liq</span> ·{" "}
      <span>R Resolution</span> · <span>! Acct mismatch</span>
    </div>
  );
}

function PositionCycleRow({
  cycle,
  expanded,
  onToggle,
}: {
  cycle: PositionCycleDTO;
  expanded: boolean;
  onToggle: () => void;
}) {
  const tone = cycleTone(cycle);
  const visibleFlags = cycle.flags.slice(0, 3);
  const extraFlags = Math.max(0, cycle.flags.length - visibleFlags.length);
  return (
    <article
      className="pnl-cycle"
      data-tone={tone}
      data-testid={`position-cycle-${cycle.positionId}`}
    >
      <button className="pnl-cycle__head" onClick={onToggle} aria-expanded={expanded}>
        <div className="pnl-cycle__market">
          <div className="pnl-cycle__title">
            <MarketLink
              slug={cycle.slug}
              eventSlug={null}
              question={cycle.marketTitle}
              outcome={cycle.outcome}
            />
            {cycle.outcome ? <span className="pnl-outcome">{cycle.outcome}</span> : null}
          </div>
          <div className="pnl-cycle__meta">
            {formatShares(cycle.shares)} sh · {cycle.buyCount} buys / {cycle.sellCount} sells ·{" "}
            {cycle.closedAt ? "held" : "open"} {fmtDuration(cycle.heldDurationMs)}
          </div>
          <div className="pnl-cycle__source">
            entry {sourceLabel(cycle.entrySources)} · {cycle.exitSummary}
            {cycle.status === "UNKNOWN_ACCT" ? " · P&L unavailable" : ""}
          </div>
          <div className="pnl-flags">
            {visibleFlags.map((flag) => (
              <FlagBadge key={flag} flag={flag} />
            ))}
            {extraFlags > 0 ? <span className="pnl-flag pnl-flag--more">+{extraFlags}</span> : null}
          </div>
        </div>
        <StatusPill status={cycle.status} />
        <MoneyColumn label="Invested" value={moneyPlain(cycle.investedUsd)} />
        <MoneyColumn label="Returned" value={moneyPlain(cycle.returnedUsd)} />
        <MoneyColumn
          label={cycle.closedAt ? "Realized" : "Remaining"}
          value={
            cycle.closedAt
              ? moneyOrNa(cycle.realizedPnlUsd, true)
              : moneyPlain(cycle.remainingMarkUsd)
          }
          sub={cycle.closedAt ? undefined : `liq ${moneyPlain(cycle.remainingLiquidationUsd)}`}
        />
        <MoneyColumn
          label="Net P&L"
          value={moneyOrNa(cycle.netPnlUsd, true)}
          sub={netSubline(cycle)}
          strong
        />
        <span className={`pnl-chevron ${expanded ? "on" : ""}`}>⌄</span>
      </button>
      {expanded ? <ExpandedCycleDetails cycle={cycle} /> : null}
    </article>
  );
}

function MoneyColumn({
  label,
  value,
  sub,
  strong,
}: {
  label: string;
  value: string;
  sub?: string;
  strong?: boolean;
}) {
  return (
    <div className={`pnl-money ${strong ? "pnl-money--strong" : ""}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub ? <em>{sub}</em> : null}
    </div>
  );
}

function ExpandedCycleDetails({ cycle }: { cycle: PositionCycleDTO }) {
  const operationRows = useMemo(() => withRunningState(cycle.operations), [cycle.operations]);
  const quality = qualityStats(cycle);
  return (
    <div className="pnl-expanded" data-testid={`expanded-${cycle.positionId}`}>
      <div className="pnl-expanded__left">
        <div className="pnl-section-title">Operations history</div>
        <div className="pnl-ops">
          {operationRows.map((operation, index) => (
            <div className="pnl-op" data-type={operation.type} key={`${operation.time}-${index}`}>
              <div className="pnl-op__kind">{operation.type}</div>
              <div>
                <div className="pnl-op__line">
                  {operationVerb(operation)} {formatShares(operation.shares)} @{" "}
                  {operation.price == null ? "—" : `$${operation.price.toFixed(4)}`} ·{" "}
                  {operation.source}
                </div>
                <div className="pnl-op__state">
                  {formatTimestamp(operation.time)} · pos {formatShares(operation.positionAfter)} ·
                  avg {moneyPlain(operation.avgAfter, 4)} · cost {moneyPlain(operation.costAfter)} ·
                  realized {moneyOrNa(operation.realizedAfter, true)}
                </div>
              </div>
              <div className="pnl-op__cash">
                <b>{formatOperationCash(operation)}</b>
                <span>
                  {operation.stepPnlUsd == null ? "n/a" : moneyOrNa(operation.stepPnlUsd, true)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="pnl-expanded__right">
        <InfoBlock title="Returned Breakdown">
          <InfoRow label="Sell returned" value={moneyPlain(cycle.sellReturnedUsd)} />
          <InfoRow label="Settlement / redeem" value={moneyPlain(cycle.settlementReturnedUsd)} />
          <InfoRow label="Total returned" value={moneyPlain(cycle.returnedUsd)} strong />
        </InfoBlock>
        <InfoBlock
          title={
            cycle.status === "UNKNOWN_ACCT"
              ? "Entry / Exit Quality · price-only"
              : "Entry / Exit Quality"
          }
        >
          {cycle.closedAt ? (
            <>
              <InfoRow label="Avg entry" value={moneyPlain(quality.avgEntry, 4)} />
              <InfoRow
                label="Avg sell"
                value={quality.avgSell == null ? "—" : moneyPlain(quality.avgSell, 4)}
                tone={priceTone(quality.avgSell, quality.avgEntry)}
              />
              <InfoRow
                label="Best sell"
                value={quality.bestSell == null ? "—" : moneyPlain(quality.bestSell, 4)}
                tone={priceTone(quality.bestSell, quality.avgEntry)}
              />
              <InfoRow
                label="Worst sell"
                value={quality.worstSell == null ? "—" : moneyPlain(quality.worstSell, 4)}
                tone={priceTone(quality.worstSell, quality.avgEntry)}
              />
            </>
          ) : (
            <>
              <InfoRow label="Avg entry" value={moneyPlain(quality.avgEntry, 4)} />
              <InfoRow label="Remaining mark" value={moneyPlain(cycle.remainingMarkUsd)} />
              <InfoRow
                label="Liquidation value"
                value={moneyPlain(cycle.remainingLiquidationUsd)}
              />
              <InfoRow
                label="Unrealized P&L"
                value={moneyOrNa(cycle.unrealizedPnlUsd, true)}
                tone={signTone(cycle.unrealizedPnlUsd)}
              />
            </>
          )}
        </InfoBlock>
        <InfoBlock title="Result drivers">
          {cycle.sourceBreakdown.entries.map((entry) => (
            <InfoRow
              key={`entry-${entry.source}`}
              label={`Entry: ${entry.source}`}
              value={`${moneyPlain(entry.returnedUsd)} in (${entry.count})`}
            />
          ))}
          {cycle.sourceBreakdown.exits.length === 0 ? (
            <InfoRow label="Exit" value="no exits yet" />
          ) : (
            cycle.sourceBreakdown.exits.map((exit) => (
              <InfoRow
                key={`exit-${exit.source}`}
                label={`Exit: ${exit.source}`}
                value={`${moneyPlain(exit.returnedUsd)} ret / ${moneyOrNa(exit.pnlUsd, true)}`}
                tone={exit.pnlUsd == null ? "warn" : signTone(exit.pnlUsd)}
              />
            ))
          )}
        </InfoBlock>
        <AccountingBlock cycle={cycle} />
      </div>
    </div>
  );
}

function InfoBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pnl-info-block">
      <div className="pnl-section-title">{title}</div>
      {children}
    </section>
  );
}

function InfoRow({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: string;
  strong?: boolean;
}) {
  return (
    <div className="pnl-info-row" data-tone={tone}>
      <span>{label}</span>
      <b className={strong ? "strong" : ""}>{value}</b>
    </div>
  );
}

function AccountingBlock({ cycle }: { cycle: PositionCycleDTO }) {
  if (cycle.accountingConfidence === "HIGH") {
    return (
      <div className="pnl-accounting high">
        High confidence · ledger matched · cost basis complete
      </div>
    );
  }
  if (cycle.accountingConfidence === "MED") {
    return (
      <div className="pnl-accounting med">
        Medium confidence ·{" "}
        {cycle.accountingReasons.includes("open_remainder")
          ? "open / dust remainder"
          : "settlement involved"}
      </div>
    );
  }
  return (
    <div className="pnl-accounting low">
      <b>P&amp;L hidden until accounting is repaired</b>
      <div>
        {cycle.accountingReasons.map((reason) => (
          <span key={reason}>{reason.replace(/_/g, " ")}</span>
        ))}
      </div>
      <p>
        Net &amp; realized are n/a, not $0.00. This cycle is excluded from P&amp;L totals &amp; sort
        until reconciled.
      </p>
    </div>
  );
}

function FlagBadge({ flag }: { flag: string }) {
  const meta = FLAG_META[flag] ?? { label: flag, icon: "?", tone: "warn", title: flag };
  return (
    <span className={`pnl-flag pnl-flag--${meta.tone}`} title={meta.title}>
      <i>{meta.icon}</i>
      {meta.label}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className="pnl-status-pill" data-tone={statusTone(status)}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function StatePanel({
  tone,
  title,
  detail,
  action,
}: {
  tone: string;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="pnl-state" data-tone={tone}>
      <b>{title}</b>
      <span>{detail}</span>
      {action}
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="pnl-list">
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="pnl-skeleton" key={index} />
      ))}
    </div>
  );
}

interface RunningOperation extends PositionCycleOperationDTO {
  positionAfter: number;
  avgAfter: number;
  costAfter: number;
  realizedAfter: number | null;
}

function withRunningState(operations: PositionCycleOperationDTO[]): RunningOperation[] {
  let position = 0;
  let cost = 0;
  let realized = 0;
  return operations.map((operation) => {
    if (operation.type === "BUY" || operation.type === "SCALE") {
      const cashUsd = Math.abs(operation.usd);
      position += operation.shares;
      cost += cashUsd;
    } else {
      const cashUsd = Math.abs(operation.usd);
      if (operation.stepPnlUsd != null) {
        const removedCost = Math.max(0, cashUsd - operation.stepPnlUsd);
        cost = Math.max(0, cost - removedCost);
        realized += operation.stepPnlUsd;
      }
      position = Math.max(0, position - operation.shares);
    }
    return {
      ...operation,
      positionAfter: position,
      avgAfter: position > 0 ? cost / position : 0,
      costAfter: cost,
      realizedAfter:
        operation.stepPnlUsd == null && operation.type !== "BUY" && operation.type !== "SCALE"
          ? null
          : realized,
    };
  });
}

function qualityStats(cycle: PositionCycleDTO) {
  const buys = cycle.operations.filter(
    (operation) => operation.type === "BUY" || operation.type === "SCALE",
  );
  const sells = cycle.operations.filter((operation) => operation.type === "SELL");
  const buyShares = sum(buys.map((operation) => operation.shares));
  const avgEntry =
    buyShares > 0 ? sum(buys.map((operation) => Math.abs(operation.usd))) / buyShares : 0;
  const sellShares = sum(sells.map((operation) => operation.shares));
  const avgSell =
    sellShares > 0 ? sum(sells.map((operation) => Math.abs(operation.usd))) / sellShares : null;
  const sellPrices = sells
    .map((operation) => operation.price)
    .filter((price): price is number => price != null);
  return {
    avgEntry,
    avgSell,
    bestSell: sellPrices.length > 0 ? Math.max(...sellPrices) : null,
    worstSell: sellPrices.length > 0 ? Math.min(...sellPrices) : null,
  };
}

function operationVerb(operation: PositionCycleOperationDTO): string {
  if (operation.type === "BUY") return "Bought";
  if (operation.type === "SCALE") return "Scaled";
  if (operation.type === "SETTLE") return "Settled";
  return "Sold";
}

function formatOperationCash(operation: PositionCycleOperationDTO): string {
  const direction = operation.type === "BUY" || operation.type === "SCALE" ? "spent" : "received";
  return `${moneyOrNa(operation.usd, true)} ${direction}`;
}

function sourceLabel(sources: string[]): string {
  return sources.length > 0 ? sources.join(" + ") : "—";
}

function netSubline(cycle: PositionCycleDTO): string {
  if (cycle.netPnlUsd == null) return "P&L hidden · accounting unresolved";
  if (cycle.closedAt)
    return cycle.netPnlPct == null ? "" : fmtPct(cycle.netPnlUsd, cycle.investedUsd);
  return `by mark · real ${moneyOrNa(cycle.realizedPnlUsd, true)} · unr ${moneyOrNa(cycle.unrealizedPnlUsd, true)} · liq ${moneyPlain(cycle.remainingLiquidationUsd)}`;
}

function cycleTone(cycle: PositionCycleDTO): string {
  if (cycle.status === "UNKNOWN_ACCT") return "warn";
  if (cycle.status === "HELD_TO_LOSING_RESOLUTION") return "reso";
  if (cycle.status === "DUST_OPEN") return "neutral";
  return signTone(cycle.netPnlUsd ?? 0);
}

function statusTone(status: string): string {
  if (status === "UNKNOWN_ACCT") return "warn";
  if (status === "HELD_TO_LOSING_RESOLUTION") return "reso";
  if (status === "DUST_OPEN") return "neutral";
  if (status.endsWith("PROFIT")) return "pos";
  return "neg";
}

function priceTone(price: number | null, avgEntry: number): string | undefined {
  if (price == null || avgEntry <= 0) return undefined;
  if (price > avgEntry) return "pos";
  if (Math.abs(price - avgEntry) < 0.000001) return "warn";
  return "neg";
}

function signTone(value: number): "pos" | "neg" | "neutral" {
  if (value > 0.000001) return "pos";
  if (value < -0.000001) return "neg";
  return "neutral";
}

function moneyPlain(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(digits)}`;
}

function moneyOrNa(value: number | null | undefined, showSign = false): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return fmtMoney(value, { showSign });
}

function formatShares(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function pageRangeLabel(page: number, pageSize: number, total: number, count: number): string {
  if (total <= 0) return "0 of 0 cycles";
  const from = (page - 1) * pageSize + 1;
  const to = from + count - 1;
  return `${from}\u2013${to} of ${total} cycles`;
}
