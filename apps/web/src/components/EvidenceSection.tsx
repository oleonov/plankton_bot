import { useState } from "react";
import { ScoreBars } from "./ScoreBars.tsx";
import type { FamilyEvidenceDTO } from "../api/types.ts";

function EvidenceStat({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div style={{ marginBottom: 2 }}>
      <span style={{ fontSize: 10, color: "var(--text-muted)", marginRight: 6 }}>{label}:</span>
      <span style={{ fontSize: 11 }}>{value ?? "\u2014"}</span>
    </div>
  );
}

export function EvidenceSection({ evidence }: { evidence: FamilyEvidenceDTO | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!evidence) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{ cursor: "pointer", fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "\u25BC" : "\u25B6"} Evidence
      </div>
      {expanded && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
          <div>
            <EvidenceStat label="Trades" value={evidence.localTradeCount} />
            <EvidenceStat label="Markets" value={evidence.localMarketCount} />
            <EvidenceStat
              label="Realized PnL (FIFO)"
              value={fmtUsd(evidence.localRealizedPnlFifo)}
            />
            <EvidenceStat label="Tail-Adj PnL" value={fmtUsd(evidence.tailAdjustedPnl)} />
            <EvidenceStat
              label="Evidence Score"
              value={evidence.evidenceScore?.toFixed(2) ?? null}
            />
            <EvidenceStat label="Repricing Exits" value={evidence.repricingExitCount} />
          </div>
          <ScoreBars
            recurrence={evidence.recurrenceScore}
            recycle={evidence.recycleScore}
            liveViability={evidence.liveViabilityScore}
            toxicity={evidence.toxicityPenalty}
          />
        </div>
      )}
    </div>
  );
}

function fmtUsd(v: number | null): string | null {
  if (v == null) return null;
  return `$${v.toFixed(2)}`;
}
