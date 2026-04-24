import { useEffect } from "react";
import { Link } from "react-router-dom";
import type { PositionDTO } from "../../api/types.ts";
import { useFills } from "../../api/hooks.ts";
import { PhaseIcon } from "./PhaseIcon.tsx";
import {
  deriveMarketState,
  deriveResolutionTag,
  endsMsFrom,
  fmtAgo,
  fmtEndsLabel,
  fmtMoney,
  fmtPct,
  getPositionTotalPnl,
  PHASE_META,
} from "./lib.ts";

interface Props {
  position: PositionDTO | null;
  onClose: () => void;
}

export function PositionDrawer({ position, onClose }: Props) {
  useEffect(() => {
    if (!position) return;
    document.body.classList.add("p2-drawer-open");
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("p2-drawer-open");
      window.removeEventListener("keydown", onKey);
    };
  }, [position, onClose]);

  if (!position) return null;
  return (
    <>
      <div
        className="p2-drawerBackdrop"
        onClick={onClose}
        role="presentation"
        data-testid="position-drawer-backdrop"
      />
      <div
        className="p2-drawer on"
        role="dialog"
        aria-modal="true"
        aria-label={`Details for ${position.question ?? position.positionId}`}
        data-testid="position-drawer"
      >
        <DrawerBody position={position} onClose={onClose} />
      </div>
    </>
  );
}

function DrawerBody({ position, onClose }: { position: PositionDTO; onClose: () => void }) {
  const pnl = getPositionTotalPnl(position);
  const endsMs = endsMsFrom(position.endDate);
  const mstate = deriveMarketState(position.status);
  const resTag = deriveResolutionTag(position.resolutionStatus, position.endDate);
  const isDust = position.status === "dust";
  const meta = PHASE_META[position.phase];
  const fillsQ = useFills({ tokenId: position.tokenId, limit: 20 });
  const recent = fillsQ.data?.items ?? [];

  return (
    <>
      <header>
        <div>
          <div className="p2-mono" style={{ fontSize: 10, color: "var(--p2-fg-dim)", letterSpacing: ".08em" }}>
            {position.positionId}
          </div>
          <div style={{ fontSize: 14, marginTop: 2, color: "var(--p2-fg-strong)" }}>
            {position.question ?? position.slug ?? "—"}
          </div>
          <div style={{ marginTop: 6, display: "flex", gap: 6, alignItems: "center" }}>
            <span className="p2-phase" data-state={position.phase}>
              <span className="p2-ic" style={{ color: drawerIconColor(position.phase) }}>
                <PhaseIcon phase={position.phase} />
              </span>
              <span
                className="p2-lbl"
                style={{ color: drawerLabelColor(position.phase) }}
              >
                {meta.label}
              </span>
            </span>
            <span
              className="p2-mono"
              style={{ color: "var(--p2-fg-dim)", fontSize: 10 }}
            >
              · {position.phase} · buy_count={position.buyCount}, last={position.lastAction ?? "—"}
            </span>
          </div>
        </div>
        <button className="p2-close" onClick={onClose} aria-label="Close drawer">
          ×
        </button>
      </header>

      <div className="p2-body">
        <h3>Position</h3>
        <div className="p2-kv">
          <span className="p2-k">Outcome</span>
          <span className="p2-v">{position.outcome ?? "—"}</span>
          <span className="p2-k">Size</span>
          <span className="p2-v">{position.size.toFixed(2)}</span>
          <span className="p2-k">Avg entry</span>
          <span className="p2-v">${position.avgEntryPrice.toFixed(4)}</span>
          <span className="p2-k">Cost basis</span>
          <span className="p2-v">{fmtMoney(position.costBasisUsdc)}</span>
          <span className="p2-k">Value</span>
          <span className="p2-v">
            {position.currentValueUsdc != null ? fmtMoney(position.currentValueUsdc) : "—"}
          </span>
          <span className="p2-k">PnL</span>
          <span className={"p2-v " + (pnl > 0.005 ? "pos" : pnl < -0.005 ? "neg" : "")}>
            {pnl === 0 ? "$0.00" : fmtMoney(pnl, { showSign: true })}
            {position.costBasisUsdc > 0 && ` · ${fmtPct(pnl, position.costBasisUsdc)}`}
          </span>
        </div>

        <h3>State machine</h3>
        <div className="p2-kv">
          <span className="p2-k">Phase</span>
          <span className="p2-v">
            {position.phase} — {meta.label}
          </span>
          <span className="p2-k">buy_count</span>
          <span className="p2-v">{position.buyCount}</span>
          <span className="p2-k">sell_count</span>
          <span className="p2-v">{position.sellCount}</span>
          <span className="p2-k">last_action</span>
          <span className="p2-v">
            {position.lastAction ?? "—"}
            {position.lastActionAt && ` · ${fmtAgo(position.lastActionAt)}`}
          </span>
          <span className="p2-k">Market state</span>
          <span className="p2-v">
            {mstate}
            {resTag && ` · ${resTag}`}
            {isDust && " · dust"}
          </span>
          <span className="p2-k">Ends</span>
          <span className="p2-v">{fmtEndsLabel(endsMs)}</span>
        </div>

        <h3>Recent fills</h3>
        {fillsQ.isLoading ? (
          <div className="p2-empty">Loading…</div>
        ) : recent.length === 0 ? (
          <div className="p2-empty">No recent fills for this token.</div>
        ) : (
          <div>
            {recent.slice(0, 6).map((f) => (
              <div className="p2-fillrow" key={f.fillId}>
                <span className={"p2-side " + (f.side === "buy" ? "buy" : "sell")}>
                  {f.side === "buy" ? "▲" : "▼"}
                </span>
                <span>{f.side === "buy" ? "BUY" : "SELL"}</span>
                <span>{f.size.toFixed(2)}</span>
                <span>@ ${f.price.toFixed(4)}</span>
                <span className="p2-when">{fmtAgo(f.filledAt) || "—"}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <Link
            to={`/orders?tab=fills&tokenId=${encodeURIComponent(position.tokenId)}`}
            className="p2-iconbtn"
            style={{ padding: "6px 12px", textDecoration: "none" }}
          >
            View fills →
          </Link>
        </div>
      </div>
    </>
  );
}

function drawerLabelColor(phase: PositionDTO["phase"]): string {
  switch (phase) {
    case "S0":
      return "#97a2b2";
    case "S1":
      return "#9ec1ff";
    case "S2":
      return "var(--p2-violet-bright)";
    case "S3":
      return "var(--p2-amber-bright)";
  }
}

function drawerIconColor(phase: PositionDTO["phase"]): string {
  switch (phase) {
    case "S0":
      return "#5b6775";
    case "S1":
      return "#6ca0ff";
    case "S2":
      return "var(--p2-violet)";
    case "S3":
      return "var(--p2-amber)";
  }
}
