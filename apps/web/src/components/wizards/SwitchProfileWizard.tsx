import { useState } from "react";
import { WizardPanel } from "../WizardPanel.tsx";
import { useProfiles, useSwitchProfile } from "../../api/hooks.ts";

const STEPS = ["Select Target Profile", "Ledger Reset Policy", "Review", "Confirm"];

function RadioOption({
  label,
  description,
  selected,
  onSelect,
}: {
  label: string;
  description?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div className={`radio-option ${selected ? "selected" : ""}`} onClick={onSelect}>
      <input type="radio" checked={selected} onChange={onSelect} />
      <div>
        <div>{label}</div>
        {description && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{description}</div>
        )}
      </div>
    </div>
  );
}

export function SwitchProfileWizard({ onClose }: { onClose: () => void }) {
  const { data } = useProfiles();
  const switchMutation = useSwitchProfile();
  const [step, setStep] = useState(0);
  const [target, setTarget] = useState("");
  const [resetPolicy, setResetPolicy] = useState<"preserve" | "archive-reset">("preserve");
  const [confirmText, setConfirmText] = useState("");

  const current = data?.runtimeState?.current_profile;
  const profiles = data?.profiles.filter((p) => p.profile_id !== current) ?? [];
  const targetProfile = data?.profiles.find((p) => p.profile_id === target);

  const needsTypedConfirm = resetPolicy === "archive-reset";
  const canConfirm = !needsTypedConfirm || confirmText === "ARCHIVE";

  function handleConfirm() {
    switchMutation.mutate(
      { toProfile: target, ledgerResetPolicy: resetPolicy, reason: "operator switch" },
      { onSuccess: onClose },
    );
  }

  const footer = (
    <>
      {step > 0 && (
        <button className="btn-secondary" onClick={() => setStep(step - 1)}>
          Back
        </button>
      )}
      {step < 3 && (
        <button
          className="btn-success"
          disabled={step === 0 && !target}
          onClick={() => setStep(step + 1)}
        >
          Next
        </button>
      )}
      {step === 3 && (
        <button
          className="btn-success"
          disabled={!canConfirm || switchMutation.isPending}
          onClick={handleConfirm}
        >
          {switchMutation.isPending ? "Switching..." : "Confirm Switch"}
        </button>
      )}
    </>
  );

  return (
    <WizardPanel title="Switch Profile" steps={STEPS} currentStep={step} onClose={onClose} footer={footer}>
      {step === 0 && (
        <div className="radio-group">
          {profiles.map((p) => (
            <RadioOption
              key={p.profile_id}
              label={p.display_name}
              description={p.description ?? undefined}
              selected={target === p.profile_id}
              onSelect={() => setTarget(p.profile_id)}
            />
          ))}
          {profiles.length === 0 && (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>No other profiles available</div>
          )}
        </div>
      )}
      {step === 1 && (
        <div className="radio-group">
          <RadioOption
            label="Preserve existing data"
            description="Keep all positions, orders, and fills in the target profile"
            selected={resetPolicy === "preserve"}
            onSelect={() => setResetPolicy("preserve")}
          />
          <RadioOption
            label="Archive & reset"
            description="Archive current ledger data and start fresh"
            selected={resetPolicy === "archive-reset"}
            onSelect={() => setResetPolicy("archive-reset")}
          />
        </div>
      )}
      {step === 2 && (
        <div style={{ fontSize: 13 }}>
          <div className="label" style={{ marginBottom: 8 }}>Switch Summary</div>
          <div className="profile-stat">
            <span className="label">From</span>
            <span>{current ?? "none"}</span>
          </div>
          <div className="profile-stat">
            <span className="label">To</span>
            <span style={{ color: "var(--blue)" }}>{targetProfile?.display_name ?? target}</span>
          </div>
          <div className="profile-stat">
            <span className="label">Ledger Policy</span>
            <span>{resetPolicy === "preserve" ? "Preserve data" : "Archive & reset"}</span>
          </div>
          {resetPolicy === "archive-reset" && (
            <div style={{ marginTop: 12, padding: 10, background: "var(--red-bg)", borderRadius: 4, fontSize: 12, color: "#ef9a9a" }}>
              Warning: Archive & reset will clear all ledger data in the target profile.
            </div>
          )}
        </div>
      )}
      {step === 3 && (
        <div>
          {needsTypedConfirm ? (
            <div className="typed-confirm">
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                Type <strong>ARCHIVE</strong> to confirm the reset:
              </div>
              <input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="ARCHIVE"
                autoFocus
              />
              <div className="hint">This action cannot be undone.</div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Click "Confirm Switch" to proceed.
            </div>
          )}
          {switchMutation.isError && (
            <div style={{ marginTop: 12, color: "var(--red)", fontSize: 12 }}>
              Error: {switchMutation.error.message}
            </div>
          )}
        </div>
      )}
    </WizardPanel>
  );
}
