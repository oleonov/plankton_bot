import { useState } from "react";
import { useProposals, usePromoteFamily, useDismissProposal, useStatus } from "../api/hooks.ts";
import { SCALED_DEFAULTS } from "@plankton/domain";
import { ScoreBars } from "./ScoreBars.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { CapsEditor, useCapsEditor } from "./CapsEditor.tsx";

function parseScores(snapshot: string | null) {
  if (!snapshot) return { recurrence: null, recycle: null, liveViability: null, toxicity: null };
  try {
    const obj = JSON.parse(snapshot);
    return {
      recurrence: obj.recurrence ?? null,
      recycle: obj.recycle ?? null,
      liveViability: obj.liveViability ?? null,
      toxicity: obj.toxicity ?? null,
    };
  } catch {
    return { recurrence: null, recycle: null, liveViability: null, toxicity: null };
  }
}

function ProposalRow({
  proposal,
}: {
  proposal: {
    id: number;
    familyId: string;
    currentState: string;
    proposedState: string;
    reason: string;
    scoresSnapshot: string | null;
  };
}) {
  const promote = usePromoteFamily(proposal.familyId);
  const dismiss = useDismissProposal(proposal.id);
  const { data: statusData } = useStatus();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const scores = parseScores(proposal.scoresSnapshot);
  const runtimeMode = statusData?.runtimeMode;
  const caps = useCapsEditor(SCALED_DEFAULTS);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "8px 12px",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 12 }}>{proposal.familyId}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          {proposal.currentState} &rarr; {proposal.proposedState}
        </div>
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
          {proposal.reason}
        </div>
      </div>
      <ScoreBars {...scores} />
      <div style={{ display: "flex", gap: 4 }}>
        <button
          className="btn-success"
          onClick={() => setConfirmOpen(true)}
          disabled={promote.isPending}
        >
          Approve
        </button>
        <ConfirmDialog
          open={confirmOpen}
          title={`Promote ${proposal.familyId}?`}
          description={`${proposal.currentState} -> ${proposal.proposedState}: ${proposal.reason}`}
          runtimeMode={runtimeMode}
          disableConfirm={caps.hasErrors}
          onConfirm={() => {
            setConfirmOpen(false);
            promote.mutate(caps.values);
          }}
          onCancel={() => setConfirmOpen(false)}
        >
          <CapsEditor input={caps.input} setInput={caps.setInput} />
        </ConfirmDialog>
        <ConfirmAction
          label="Dismiss"
          confirmText={`Dismiss proposal?`}
          variant="danger"
          onConfirm={(r) => dismiss.mutate(r)}
          isPending={dismiss.isPending}
        />
      </div>
    </div>
  );
}

export function ProposalPanel() {
  const { data: proposals } = useProposals();
  const [collapsed, setCollapsed] = useState(false);

  if (!proposals || proposals.length === 0) return null;

  return (
    <div
      style={{
        background: "var(--bg-card)",
        borderRadius: 6,
        marginBottom: 12,
        border: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          borderBottom: collapsed ? "none" : "1px solid var(--border)",
        }}
        onClick={() => setCollapsed(!collapsed)}
      >
        <span style={{ fontWeight: 700, fontSize: 12 }}>
          {collapsed ? "\u25B6" : "\u25BC"} Pending Proposals ({proposals.length})
        </span>
      </div>
      {!collapsed && proposals.map((p) => <ProposalRow key={p.id} proposal={p} />)}
    </div>
  );
}
