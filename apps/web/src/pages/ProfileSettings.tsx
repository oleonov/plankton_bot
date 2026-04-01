import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useProfileSettings, useUpdateProfileSettings } from "../api/hooks.ts";

type FeedbackState = { type: "success" | "error"; message: string } | null;

function SettingsFormInner({
  settings,
  profileId,
}: {
  settings: {
    initial_balance_usdc?: number | null;
    envelope_json?: string | null;
    risk_caps_json?: string | null;
  };
  profileId: string;
}) {
  const update = useUpdateProfileSettings(profileId);

  const [balance, setBalance] = useState(settings.initial_balance_usdc?.toString() ?? "");
  const [envelope, setEnvelope] = useState(settings.envelope_json ?? "");
  const [riskCaps, setRiskCaps] = useState(settings.risk_caps_json ?? "");
  const [feedback, setFeedback] = useState<FeedbackState>(null);

  function handleSave() {
    setFeedback(null);
    update.mutate(
      {
        initialBalanceUsdc: balance ? Number(balance) : undefined,
        envelopeJson: envelope || undefined,
        riskCapsJson: riskCaps || undefined,
      },
      {
        onSuccess: () => setFeedback({ type: "success", message: "Settings saved" }),
        onError: (err) => setFeedback({ type: "error", message: err.message }),
      },
    );
  }

  return (
    <div className="settings-form">
      <div className="form-field">
        <label>Initial Balance (USDC)</label>
        <input
          type="number"
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          placeholder="1000"
        />
      </div>
      <div className="form-field">
        <label>Envelope JSON</label>
        <input
          value={envelope}
          onChange={(e) => setEnvelope(e.target.value)}
          placeholder='{"maxOpenValueUsdc": 500, ...}'
        />
      </div>
      <div className="form-field">
        <label>Risk Caps JSON</label>
        <input
          value={riskCaps}
          onChange={(e) => setRiskCaps(e.target.value)}
          placeholder='{"maxDrawdownUsdc": 100, ...}'
        />
      </div>
      <div>
        <button className="btn-success" onClick={handleSave} disabled={update.isPending}>
          {update.isPending ? "Saving..." : "Save Settings"}
        </button>
        {feedback && (
          <span
            style={{
              marginLeft: 12,
              fontSize: 12,
              color: feedback.type === "success" ? "var(--green)" : "var(--red)",
            }}
          >
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  );
}

function SettingsForm({ profileId }: { profileId: string }) {
  const { data: settings, isLoading, dataUpdatedAt } = useProfileSettings(profileId);

  if (isLoading || !settings) return <div style={{ fontSize: 12 }}>Loading settings...</div>;

  return <SettingsFormInner key={dataUpdatedAt} settings={settings} profileId={profileId} />;
}

export function ProfileSettings() {
  const { profileId } = useParams<{ profileId: string }>();

  if (!profileId) return <div className="page">No profile selected</div>;

  return (
    <div className="page">
      <Link to="/settings/risk" style={{ fontSize: 12, color: "var(--text-muted)" }}>
        &larr; Back to Settings
      </Link>
      <div className="page-title" style={{ marginTop: 8 }}>
        Profile Settings — {profileId.slice(0, 12)}
      </div>
      <div className="card">
        <SettingsForm profileId={profileId} />
      </div>
    </div>
  );
}
