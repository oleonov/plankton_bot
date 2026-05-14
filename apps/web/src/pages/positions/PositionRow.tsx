import type { PositionDTO } from "../../api/types.ts";
import { PhaseIcon } from "./PhaseIcon.tsx";
import {
  deriveMarketState,
  deriveResolutionTag,
  endsMsFrom,
  fmtAgo,
  fmtEndsLabel,
  fmtMoney,
  fmtPct,
  getPositionFullPnl,
  getPositionFullPnlBasis,
  getPositionUnrealizedPnl,
  outcomeKind,
  PHASE_META,
  urgencyClass,
  type Density,
} from "./lib.ts";

interface Props {
  position: PositionDTO;
  density: Density;
  selected: boolean;
  showBuys: boolean;
  showPct: boolean;
  onSelect: (p: PositionDTO) => void;
}

export function PositionRow({
  position: p,
  density,
  selected,
  showBuys,
  showPct,
  onSelect,
}: Props) {
  const unrealizedPnl = getPositionUnrealizedPnl(p);
  const fullPnl = getPositionFullPnl(p);
  const fullPnlBasis = getPositionFullPnlBasis(p);
  const endsMs = endsMsFrom(p.endDate);
  const mstate = deriveMarketState(p.status);
  const resTag = deriveResolutionTag(p.resolutionStatus, p.endDate);
  const isDust = p.status === "dust";
  const densCls =
    density === "compact" ? "density-compact" : density === "spacious" ? "density-spacious" : "";
  const unrealizedCls = unrealizedPnl > 0.005 ? "pos" : unrealizedPnl < -0.005 ? "neg" : "flat";
  const fullPnlCls = fullPnl > 0.005 ? "pos" : fullPnl < -0.005 ? "neg" : "flat";
  const sideCls = p.lastAction === "BUY" ? "buy" : p.lastAction === "SELL" ? "sell" : "none";
  const sideGlyph = p.lastAction === "BUY" ? "▲" : p.lastAction === "SELL" ? "▼" : "·";
  const outKind = outcomeKind(p.outcome);
  const uCls = urgencyClass(endsMs);
  const ago = fmtAgo(p.lastActionAt);

  const handleKey = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(p);
    }
  };

  return (
    <tr
      className={"p2-row " + densCls + (selected ? " selected" : "")}
      data-state={p.phase}
      data-testid={`position-row-${p.positionId}`}
      onClick={() => onSelect(p)}
      onKeyDown={handleKey}
      tabIndex={0}
      role="button"
      aria-label={`Open details for ${p.question ?? p.positionId}`}
    >
      <td className="p2-rail" />

      {/* Market */}
      <td className="l">
        <div className="p2-mkt">
          <span className="p2-q" title={p.question ?? undefined}>
            {p.question ?? p.slug ?? "—"}
          </span>
          <span className="p2-m">
            {p.outcome && <span className={"p2-outcome " + outKind}>{p.outcome}</span>}
            <span className="p2-pid">{p.positionId}</span>
            {isDust && <span className="p2-dust">dust</span>}
          </span>
        </div>
      </td>

      {/* Phase */}
      <td className="l">
        <span className="p2-phase">
          <span className="p2-ic">
            <PhaseIcon phase={p.phase} />
          </span>
          <span className="p2-col">
            <span className="p2-lbl">
              {PHASE_META[p.phase].label}
              {showBuys && p.buyCount > 0 && p.phase !== "S0" && (
                <span className="p2-buys" title={`${p.buyCount} buys, ${p.sellCount} sells`}>
                  {Array.from({ length: Math.min(p.buyCount, 5) }).map((_, i) => (
                    <i key={i} />
                  ))}
                </span>
              )}
            </span>
            <span className="p2-sub">
              {p.phase} · {p.buyCount}B / {p.sellCount}S
            </span>
          </span>
        </span>
      </td>

      {/* Last action */}
      <td className="l">
        <span className="p2-lact">
          <span className={"p2-arr " + sideCls} aria-hidden="true">
            {sideGlyph}
          </span>
          <span className="p2-col">
            <span className="p2-t">{p.lastAction ?? "—"}</span>
            {ago && <span className="p2-ago">{ago}</span>}
          </span>
        </span>
      </td>

      {/* Size · Basis */}
      <td className="p2-num">
        <span className="p2-price">{p.size.toFixed(2)}</span>
        <span className="p2-small">
          @ ${p.avgEntryPrice.toFixed(4)} · {fmtMoney(p.costBasisUsdc)}
        </span>
      </td>

      {/* Value */}
      <td className="p2-num">
        <span className="p2-price">
          {p.currentValueUsdc != null ? fmtMoney(p.currentValueUsdc) : "—"}
        </span>
      </td>

      {/* P&L (unrealized) */}
      <td>
        <span className={"p2-pnl " + unrealizedCls}>
          <span>{unrealizedPnl === 0 ? "$0.00" : fmtMoney(unrealizedPnl, { showSign: true })}</span>
          {showPct && p.costBasisUsdc > 0 && (
            <span className="p2-pct">{fmtPct(unrealizedPnl, p.costBasisUsdc)}</span>
          )}
        </span>
      </td>

      {/* Full P&L (lifetime) */}
      <td>
        <span className={"p2-pnl " + fullPnlCls}>
          <span>{fullPnl === 0 ? "$0.00" : fmtMoney(fullPnl, { showSign: true })}</span>
          {showPct && fullPnlBasis > 0 && (
            <span className="p2-pct">{fmtPct(fullPnl, fullPnlBasis)}</span>
          )}
        </span>
      </td>

      {/* Market state */}
      <td className="l">
        <span className="p2-mstate">
          <span className={"p2-tag " + mstate}>{mstate.toUpperCase()}</span>
          {resTag && <span className={"p2-tag " + resTag}>{resTag.toUpperCase()}</span>}
          {isDust && <span className="p2-tag dust">DUST</span>}
        </span>
      </td>

      {/* Ends */}
      <td>
        <span className={"p2-ends " + uCls}>
          <span className="p2-endsTop">{fmtEndsLabel(endsMs)}</span>
          <span className="p2-rel">
            {!Number.isFinite(endsMs) ? "" : endsMs < 0 ? "overdue" : "to resolve"}
          </span>
        </span>
      </td>
    </tr>
  );
}
