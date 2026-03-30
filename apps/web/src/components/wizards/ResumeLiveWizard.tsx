import { useState } from "react";
import { WizardPanel } from "../WizardPanel.tsx";
import { useProfiles, useProfileDetail, useResume } from "../../api/hooks.ts";

const STEPS = ["Preflight Report", "Caps Review", "Confirm"];

export function ResumeLiveWizard({ onClose }: { onClose: () => void }) {
  const { data: profilesData } = useProfiles();
  const currentId = profilesData?.runtimeState?.current_profile ?? null;
  const { data: detail } = useProfileDetail(currentId);
  const resumeMutation = useResume();
  const [step, setStep] = useState(0);
  const [confirmText, setConfirmText] = useState("");

  const profile = detail?.profile;
  const settings = detail?.settings;
  const families = detail?.deployedFamilies ?? [];
  const envelope = settings?.envelope_json ? tryParse(settings.envelope_json) : null;
  const canConfirm = confirmText === "RESUME LIVE";

  function handleConfirm() {
    resumeMutation.mutate("operator resume via wizard", { onSuccess: onClose });
  }

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
          disabled={!canConfirm || resumeMutation.isPending}
          onClick={handleConfirm}
        >
          {resumeMutation.isPending ? "Resuming..." : "Resume"}
        </button>
      )}
    </>
  );

  return (
    <WizardPanel title="Resume Live" steps={STEPS} currentStep={step} onClose={onClose} footer={footer}>
      {step === 0 && (
        <div style={{ fontSize: 12 }}>
          <div className="label" style={{ marginBottom: 8 }}>Preflight Report</div>
          <div className="profile-stat">
            <span className="label">Profile</span>
            <span>{profile?.display_name ?? currentId}</span>
          </div>
          <div className="profile-stat">
            <span className="label">Exposure</span>
            <span>${profile?.total_exposure_usdc?.toFixed(2) ?? "0.00"}</span>
          </div>
          <div className="profile-stat">
            <span className="label">Balance</span>
            <span>${profile?.balance_usdc?.toFixed(2) ?? "0.00"}</span>
          </div>
          <div className="profile-stat">
            <span className="label">Positions</span>
            <span>{profile?.open_positions ?? 0}</span>
          </div>
          <div className="profile-stat">
            <span className="label">Deployed Families</span>
            <span>{families.length}</span>
          </div>
        </div>
      )}
      {step === 1 && (
        <div style={{ fontSize: 12 }}>
          <div className="label" style={{ marginBottom: 8 }}>Envelope Caps</div>
          {envelope ? (
            Object.entries(envelope).map(([k, v]) => (
              <div key={k} className="profile-stat">
                <span className="label">{k}</span>
                <span>{String(v)}</span>
              </div>
            ))
          ) : (
            <div style={{ color: "var(--text-dim)" }}>No envelope configured</div>
          )}
        </div>
      )}
      {step === 2 && (
        <div className="typed-confirm">
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            Type <strong>RESUME LIVE</strong> to confirm:
          </div>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESUME LIVE"
            autoFocus
          />
          <div className="hint">This will resume live trading.</div>
          {resumeMutation.isError && (
            <div style={{ marginTop: 8, color: "var(--red)" }}>
              Error: {resumeMutation.error.message}
            </div>
          )}
        </div>
      )}
    </WizardPanel>
  );
}

function tryParse(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
