import { useState, useEffect } from "react";
import { useCandidates, useCandidateAction, useDiscoveryStatus, useStatus } from "../api/hooks.ts";
import { PROBE_DEFAULTS } from "@plankton/domain";
import { ProposalPanel } from "../components/ProposalPanel.tsx";
import { DiscoveryStatusPanel } from "../components/DiscoveryStatusPanel.tsx";
import { CandidateDetail } from "../components/CandidateDetail.tsx";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { CapsEditor, useCapsEditor } from "../components/CapsEditor.tsx";
import { Pagination } from "../components/Pagination.tsx";
import { Badge } from "../components/Badge.tsx";
import { formatAgo } from "../utils/format.ts";
import type { CandidateDTO } from "../api/types.ts";

const RECOMMENDATION_BG: Record<string, string | undefined> = {
  ignore: "rgba(100,100,100,0.06)",
  monitor: "rgba(255,193,7,0.06)",
  "probe-candidate": "rgba(79,195,247,0.06)",
  "scaled-candidate": "rgba(76,175,80,0.06)",
};

function MaterializedWarning({ materializedAt }: { materializedAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  if (!materializedAt) return null;
  const elapsed = now - new Date(materializedAt).getTime();
  if (elapsed < 60_000) return null;
  const isVeryStuck = elapsed > 300_000;
  return (
    <span
      className="badge badge-orange"
      title={isVeryStuck ? "Check runtime logs" : "Waiting for rules_reload"}
    >
      {isVeryStuck ? "Stuck — check runtime logs" : "Waiting for runtime reload"}
    </span>
  );
}

function ScoresPendingBadge() {
  return <span className="badge badge-orange">scores pending</span>;
}

function CandidateActions({ candidate }: { candidate: CandidateDTO }) {
  const accept = useCandidateAction(candidate.candidateId, "accept");
  const reject = useCandidateAction(candidate.candidateId, "reject");
  const { data: statusData } = useStatus();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectConfirmOpen, setRejectConfirmOpen] = useState(false);
  const caps = useCapsEditor(PROBE_DEFAULTS);

  const runtimeMode = statusData?.runtimeMode;
  const canApprove = candidate.status === "discovered" || candidate.status === "reviewed";

  if (!canApprove) return null;

  const approveDescription =
    runtimeMode === "live-lite"
      ? "This will materialize the candidate and add it to live-lite as a probe-only family. The bot will decide whether to trade it."
      : "This will materialize the candidate as a probe-only family.";

  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      <button
        className="btn-success"
        onClick={() => setConfirmOpen(true)}
        disabled={accept.isPending}
      >
        {accept.isPending ? "Approving..." : "Approve"}
      </button>
      <button
        className="btn-danger"
        onClick={() => setRejectConfirmOpen(true)}
        disabled={reject.isPending}
      >
        {reject.isPending ? "Rejecting..." : "Reject"}
      </button>
      <ConfirmDialog
        open={confirmOpen && !accept.isPending}
        title={`Approve ${candidate.familyKey}?`}
        description={approveDescription}
        runtimeMode={runtimeMode}
        disableConfirm={caps.hasErrors}
        onConfirm={() => {
          setConfirmOpen(false);
          accept.mutate(caps.values);
        }}
        onCancel={() => setConfirmOpen(false)}
      >
        <CapsEditor input={caps.input} setInput={caps.setInput} />
      </ConfirmDialog>
      <ConfirmDialog
        open={rejectConfirmOpen && !reject.isPending}
        title={`Reject ${candidate.familyKey}?`}
        description="This candidate will be hidden for 7 days (cooldown period)."
        onConfirm={() => {
          setRejectConfirmOpen(false);
          reject.mutate(undefined);
        }}
        onCancel={() => setRejectConfirmOpen(false)}
      />
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
            style={{ background: RECOMMENDATION_BG[c.gateRecommendation], cursor: "pointer" }}
            onClick={() => onSelect(c.candidateId)}
          >
            <td style={{ color: "var(--blue)" }}>{c.familyKey}</td>
            <td>{c.regime}</td>
            <td>{c.horizon}</td>
            {c.scoresUpdatedAt === null ? (
              <td colSpan={2}>
                <ScoresPendingBadge />
              </td>
            ) : (
              <>
                <ScoreCell value={c.recurrenceScore} color="var(--blue)" />
                <ScoreCell value={c.liveViabilityScore} color="#26a69a" />
              </>
            )}
            <td>
              <Badge value={c.gateRecommendation} />
            </td>
            <td>{c.patternConfidence}</td>
            <td>
              <Badge value={c.status} />
              {c.status === "materialized" && (
                <MaterializedWarning materializedAt={c.materializedAt} />
              )}
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
  const [confFilter, setConfFilter] = useState<string>("");
  const [cadenceFilter, setCadenceFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const { data, isLoading } = useCandidates({
    status: statusFilter || undefined,
    recommendation: recFilter || undefined,
    confidence: confFilter || undefined,
    cadence: cadenceFilter || undefined,
    page,
  });
  const candidates = data?.items;
  const { data: status } = useDiscoveryStatus();
  const totalCount = data?.totalCount ?? 0;
  const pageStart = totalCount > 0 ? (page - 1) * 50 + 1 : 0;
  const pageEnd = pageStart + ((candidates?.length ?? 0) - 1);
  const pageInfo = totalCount > 0 ? `${pageStart}\u2013${pageEnd} of ${totalCount}` : undefined;
  const totalPages = data?.totalPages ?? Math.max(1, Math.ceil(totalCount / 50));

  if (isLoading) return <div className="page">Loading...</div>;

  return (
    <div className="page">
      <div className="page-title">Family Discovery</div>
      <DiscoveryStatusPanel />
      <ProposalPanel />
      <div className="filter-bar">
        <label>
          Status:
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="discovered">Discovered</option>
            <option value="reviewed">Reviewed</option>
            <option value="materialized">Materialized</option>
            <option value="rejected">Rejected</option>
          </select>
        </label>
        <label>
          Recommendation:
          <select
            value={recFilter}
            onChange={(e) => {
              setRecFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="ignore">Ignore</option>
            <option value="monitor">Monitor</option>
            <option value="probe-candidate">Probe Candidate</option>
            <option value="scaled-candidate">Scaled Candidate</option>
          </select>
        </label>
        <label>
          Confidence:
          <select
            value={confFilter}
            onChange={(e) => {
              setConfFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label>
          Cadence:
          <select
            value={cadenceFilter}
            onChange={(e) => {
              setCadenceFilter(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="ad-hoc">Ad-hoc</option>
          </select>
        </label>
      </div>
      {(candidates ?? []).length === 0 ? (
        <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>
          {!status?.lastRun
            ? "Run your first scan to discover candidate families"
            : status?.activeRun?.status === "running"
              ? "Initial scan in progress..."
              : status?.lastRun?.status === "failed" && !status?.activeRun
                ? `Last scan failed: ${status.lastRun.error ?? "unknown error"}. Try scanning again.`
                : "No recurring market families found"}
        </div>
      ) : (
        <>
          <CandidateTable candidates={candidates!} onSelect={setSelectedId} />
          <Pagination
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
            pageInfo={pageInfo}
          />
        </>
      )}
      {selectedId && (
        <CandidateDetail candidateId={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
