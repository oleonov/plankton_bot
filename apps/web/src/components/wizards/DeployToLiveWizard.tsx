import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { WizardPanel } from "../WizardPanel.tsx";
import { useFamilyEvidence } from "../../api/hooks.ts";
import { apiPost } from "../../api/client.ts";
import { Badge } from "../Badge.tsx";

const STEPS = ["Family Scorecard", "Deployment Config", "Confirm"];

export function DeployToLiveWizard({
  familyId,
  familyKey,
  onClose,
}: {
  familyId: string;
  familyKey: string;
  onClose: () => void;
}) {
  const { data: evidence } = useFamilyEvidence(familyId);
  const qc = useQueryClient();
  const deployMutation = useMutation({
    mutationFn: (stage: string) =>
      apiPost(`/api/v1/actions/family/${familyId}/deploy`, { deployment_stage: stage }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["families"] });
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      onClose();
    },
  });

  const [step, setStep] = useState(0);
  const [stage, setStage] = useState("live-probe");

  const footer = (
    <>
      {step > 0 && (
        <button className="btn-secondary" onClick={() => setStep(step - 1)}>
          Back
        </button>
      )}
      {step < 2 && (
        <button className="btn-success" onClick={() => setStep(step + 1)}>
          Next
        </button>
      )}
      {step === 2 && (
        <button
          className="btn-success"
          disabled={deployMutation.isPending}
          onClick={() => deployMutation.mutate(stage)}
        >
          {deployMutation.isPending ? "Deploying..." : "Deploy"}
        </button>
      )}
    </>
  );

  return (
    <WizardPanel title={`Deploy ${familyKey}`} steps={STEPS} currentStep={step} onClose={onClose} footer={footer}>
      {step === 0 && (
        <div style={{ fontSize: 12 }}>
          <div className="label" style={{ marginBottom: 8 }}>Validation Scores</div>
          {evidence ? (
            <>
              <ScoreRow label="Evidence Score" value={evidence.evidenceScore} />
              <ScoreRow label="Recurrence" value={evidence.recurrenceScore} />
              <ScoreRow label="Live Viability" value={evidence.liveViabilityScore} />
              <ScoreRow label="Toxicity Penalty" value={evidence.toxicityPenalty} />
              <div className="profile-stat">
                <span className="label">Promotion State</span>
                <span>{evidence.promotionState ? <Badge value={evidence.promotionState} /> : "n/a"}</span>
              </div>
              <div className="profile-stat">
                <span className="label">Tail-Adj PnL</span>
                <span>{evidence.tailAdjustedPnl?.toFixed(2) ?? "n/a"}</span>
              </div>
            </>
          ) : (
            <div style={{ color: "var(--text-dim)" }}>Loading evidence...</div>
          )}
        </div>
      )}
      {step === 1 && (
        <div className="radio-group">
          <div
            className={`radio-option ${stage === "live-probe" ? "selected" : ""}`}
            onClick={() => setStage("live-probe")}
          >
            <input type="radio" checked={stage === "live-probe"} onChange={() => setStage("live-probe")} />
            <div>
              <div>Live Probe</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                Conservative caps, limited markets
              </div>
            </div>
          </div>
          <div
            className={`radio-option ${stage === "live-scaled" ? "selected" : ""}`}
            onClick={() => setStage("live-scaled")}
          >
            <input type="radio" checked={stage === "live-scaled"} onChange={() => setStage("live-scaled")} />
            <div>
              <div>Live Scaled</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                Full caps, all eligible markets
              </div>
            </div>
          </div>
        </div>
      )}
      {step === 2 && (
        <div style={{ fontSize: 12 }}>
          <div className="label" style={{ marginBottom: 8 }}>Deployment Summary</div>
          <div className="profile-stat">
            <span className="label">Family</span>
            <span style={{ color: "var(--blue)" }}>{familyKey}</span>
          </div>
          <div className="profile-stat">
            <span className="label">Stage</span>
            <span><Badge value={stage} /></span>
          </div>
          {deployMutation.isError && (
            <div style={{ marginTop: 12, color: "var(--red)" }}>
              Error: {deployMutation.error.message}
            </div>
          )}
        </div>
      )}
    </WizardPanel>
  );
}

function ScoreRow({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="profile-stat">
      <span className="label">{label}</span>
      <span>{value != null ? value.toFixed(2) : "n/a"}</span>
    </div>
  );
}
