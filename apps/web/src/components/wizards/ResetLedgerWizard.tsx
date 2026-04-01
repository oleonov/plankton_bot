import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { WizardPanel } from "../WizardPanel.tsx";
import { useProfiles } from "../../api/hooks.ts";
import { apiPost } from "../../api/client.ts";

const STEPS = ["Select Profile", "Impact Summary", "Confirm"];

export function ResetLedgerWizard({ onClose }: { onClose: () => void }) {
  const { data } = useProfiles();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [target, setTarget] = useState("");
  const [confirmText, setConfirmText] = useState("");

  const profiles = data?.profiles ?? [];
  const targetProfile = profiles.find((p) => p.profile_id === target);
  const isLiveLite = target === "live-lite";

  const resetMutation = useMutation({
    mutationFn: () => apiPost(`/api/v1/actions/ledger/${target}/reset`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["profiles"] });
      void qc.invalidateQueries({ queryKey: ["status"] });
      onClose();
    },
  });

  const footer = (
    <>
      {step > 0 && (
        <button className="btn-secondary" onClick={() => setStep(step - 1)}>
          Back
        </button>
      )}
      {step < 2 && (
        <button
          className="btn-success"
          disabled={!target || isLiveLite}
          onClick={() => setStep(step + 1)}
        >
          Next
        </button>
      )}
      {step === 2 && (
        <button
          className="btn-danger"
          disabled={confirmText !== "RESET" || resetMutation.isPending}
          onClick={() => resetMutation.mutate()}
        >
          {resetMutation.isPending ? "Resetting..." : "Reset Ledger"}
        </button>
      )}
    </>
  );

  return (
    <WizardPanel
      title="Reset Ledger"
      steps={STEPS}
      currentStep={step}
      onClose={onClose}
      footer={footer}
    >
      {step === 0 && (
        <div className="radio-group">
          {profiles.map((p) => {
            const blocked = p.profile_id === "live-lite";
            return (
              <div
                key={p.profile_id}
                className={`radio-option ${target === p.profile_id ? "selected" : ""}`}
                style={blocked ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
                onClick={() => !blocked && setTarget(p.profile_id)}
              >
                <input
                  type="radio"
                  checked={target === p.profile_id}
                  disabled={blocked}
                  onChange={() => !blocked && setTarget(p.profile_id)}
                />
                <div>
                  <div>{p.display_name}</div>
                  {blocked && (
                    <div style={{ fontSize: 11, color: "var(--red)", marginTop: 2 }}>
                      Live-lite ledger cannot be reset
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {step === 1 && targetProfile && (
        <div style={{ fontSize: 12 }}>
          <div className="label" style={{ marginBottom: 8 }}>
            Impact Summary
          </div>
          <div
            style={{
              padding: 12,
              background: "var(--red-bg)",
              borderRadius: 4,
              color: "#ef9a9a",
              marginBottom: 12,
            }}
          >
            The following data will be permanently deleted:
          </div>
          <div className="profile-stat">
            <span className="label">Profile</span>
            <span>{targetProfile.display_name}</span>
          </div>
          <div className="profile-stat">
            <span className="label">Open Positions</span>
            <span>{targetProfile.open_positions ?? 0}</span>
          </div>
          <div className="profile-stat">
            <span className="label">Open Orders</span>
            <span>{targetProfile.open_orders ?? 0}</span>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="typed-confirm">
          <div style={{ fontSize: 12, marginBottom: 8 }}>
            Type <strong>RESET</strong> to confirm:
          </div>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESET"
            autoFocus
          />
          <div className="hint">This action cannot be undone.</div>
          {resetMutation.isError && (
            <div style={{ marginTop: 8, color: "var(--red)" }}>
              Error: {resetMutation.error.message}
            </div>
          )}
        </div>
      )}
    </WizardPanel>
  );
}
