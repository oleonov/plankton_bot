import { useState } from "react";
import { useCandidates, useCandidateAction } from "../api/hooks.ts";
import { ProposalPanel } from "../components/ProposalPanel.tsx";
import { CandidateDetail } from "../components/CandidateDetail.tsx";
import { Badge } from "../components/Badge.tsx";
import { formatAgo } from "../utils/format.ts";
import type { CandidateDTO } from "../api/types.ts";

const STATUS_BG: Record<string, string | undefined> = {
  ignore: "rgba(100,100,100,0.06)",
  "probe-candidate": "rgba(79,195,247,0.06)",
  "scaled-candidate": "rgba(76,175,80,0.06)",
};

function CandidateActions({ candidate }: { candidate: CandidateDTO }) {
  const review = useCandidateAction(candidate.candidateId, "review");
  const accept = useCandidateAction(candidate.candidateId, "accept");
  const reject = useCandidateAction(candidate.candidateId, "reject");

  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      {candidate.status === "discovered" && (
        <>
          <button className="btn-success" onClick={() => review.mutate()} disabled={review.isPending}>
            Review
          </button>
          <button className="btn-danger" onClick={() => reject.mutate()} disabled={reject.isPending}>
            Reject
          </button>
        </>
      )}
      {candidate.status === "reviewed" && (
        <>
          <button className="btn-success" onClick={() => accept.mutate()} disabled={accept.isPending}>
            Accept
          </button>
          <button className="btn-danger" onClick={() => reject.mutate()} disabled={reject.isPending}>
            Reject
          </button>
        </>
      )}
    </span>
  );
}

function ScoreCell({ value, color }: { value: number | null; color: string }) {
  if (value == null) return <td style={{ color: "var(--text-dim)" }}>&mdash;</td>;
  return <td style={{ color }}>{value.toFixed(2)}</td>;
}

function CandidateTable({
  candidates,
  onSelect,
}: {
  candidates: CandidateDTO[];
  onSelect: (id: string) => void;
}) {
  return (
    <table>
      <thead>
        <tr>
          <th>Family Key</th>
          <th>Regime</th>
          <th>Horizon</th>
          <th>Recurrence</th>
          <th>Viability</th>
          <th>Recommendation</th>
          <th>Confidence</th>
          <th>Status</th>
          <th>Last Seen</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((c) => (
          <tr
            key={c.candidateId}
            style={{ background: STATUS_BG[c.status], cursor: "pointer" }}
            onClick={() => onSelect(c.candidateId)}
          >
            <td style={{ color: "var(--blue)" }}>{c.familyKey}</td>
            <td>{c.regime}</td>
            <td>{c.horizon}</td>
            <ScoreCell value={c.recurrenceScore} color="var(--blue)" />
            <ScoreCell value={c.liveViabilityScore} color="#26a69a" />
            <td>
              <Badge value={c.gateRecommendation} />
            </td>
            <td>{c.patternConfidence}</td>
            <td>
              <Badge value={c.status} />
            </td>
            <td>{formatAgo(c.lastSeenAt)}</td>
            <td onClick={(e) => e.stopPropagation()}>
              <CandidateActions candidate={c} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Discovery() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [recFilter, setRecFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: candidates, isLoading } = useCandidates({
    status: statusFilter || undefined,
    recommendation: recFilter || undefined,
  });

  if (isLoading) return <div className="page">Loading...</div>;

  return (
    <div className="page">
      <div className="page-title">Family Discovery</div>
      <ProposalPanel />
      <div className="filter-bar">
        <label>
          Status:
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All</option>
            <option value="discovered">Discovered</option>
            <option value="reviewed">Reviewed</option>
            <option value="materialized">Materialized</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
        <label>
          Recommendation:
          <select value={recFilter} onChange={(e) => setRecFilter(e.target.value)}>
            <option value="">All</option>
            <option value="ignore">Ignore</option>
            <option value="monitor">Monitor</option>
            <option value="probe-candidate">Probe Candidate</option>
            <option value="scaled-candidate">Scaled Candidate</option>
          </select>
        </label>
      </div>
      <CandidateTable candidates={candidates ?? []} onSelect={setSelectedId} />
      {selectedId && (
        <CandidateDetail candidateId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
