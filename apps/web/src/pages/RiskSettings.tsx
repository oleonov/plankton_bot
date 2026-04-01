import { useState } from "react";
import { useProfiles, useProfileDetail, useUpdateProfileSettings } from "../api/hooks.ts";

interface RiskCaps {
  dailyLossCap?: number;
  dailyNotionalCap?: number;
  maxNewMarketsPerDay?: number;
  maxOpenFamilies?: number;
  maxTotalExposureUsdc?: number;
}

function parseRiskCaps(json: string | null): RiskCaps {
  if (!json) return {};
  try {
    return JSON.parse(json) as RiskCaps;
  } catch {
    return {};
  }
}

function RiskForm({ profileId }: { profileId: string }) {
  const { data: detail, dataUpdatedAt } = useProfileDetail(profileId);
  const update = useUpdateProfileSettings(profileId);

  if (!detail) return <div style={{ fontSize: 12, padding: 16 }}>Loading...</div>;

  return (
    <RiskFormInner
      key={dataUpdatedAt}
      riskCapsJson={detail.settings?.risk_caps_json ?? null}
      update={update}
    />
  );
}

function RiskFormInner({
  riskCapsJson,
  update,
}: {
  riskCapsJson: string | null;
  update: ReturnType<typeof useUpdateProfileSettings>;
}) {
  const caps = parseRiskCaps(riskCapsJson);
  const [dailyLossCap, setDailyLossCap] = useState(caps.dailyLossCap?.toString() ?? "");
  const [dailyNotionalCap, setDailyNotionalCap] = useState(caps.dailyNotionalCap?.toString() ?? "");
  const [maxNewMarkets, setMaxNewMarkets] = useState(caps.maxNewMarketsPerDay?.toString() ?? "");
  const [maxFamilies, setMaxFamilies] = useState(caps.maxOpenFamilies?.toString() ?? "");
  const [maxExposure, setMaxExposure] = useState(caps.maxTotalExposureUsdc?.toString() ?? "");

  const handleSave = () => {
    const riskCaps: RiskCaps = {};
    if (dailyLossCap) riskCaps.dailyLossCap = Number(dailyLossCap);
    if (dailyNotionalCap) riskCaps.dailyNotionalCap = Number(dailyNotionalCap);
    if (maxNewMarkets) riskCaps.maxNewMarketsPerDay = Number(maxNewMarkets);
    if (maxFamilies) riskCaps.maxOpenFamilies = Number(maxFamilies);
    if (maxExposure) riskCaps.maxTotalExposureUsdc = Number(maxExposure);
    update.mutate({ riskCapsJson: JSON.stringify(riskCaps) });
  };

  return (
    <div className="card">
      <div className="settings-form">
        <div className="form-field">
          <label>Daily Loss Cap (USDC)</label>
          <input
            type="number"
            value={dailyLossCap}
            onChange={(e) => setDailyLossCap(e.target.value)}
            placeholder="No limit"
          />
        </div>
        <div className="form-field">
          <label>Daily Notional Cap (USDC)</label>
          <input
            type="number"
            value={dailyNotionalCap}
            onChange={(e) => setDailyNotionalCap(e.target.value)}
            placeholder="No limit"
          />
        </div>
        <div className="form-field">
          <label>Max New Markets / Day</label>
          <input
            type="number"
            value={maxNewMarkets}
            onChange={(e) => setMaxNewMarkets(e.target.value)}
            placeholder="No limit"
          />
        </div>
        <div className="form-field">
          <label>Max Open Families</label>
          <input
            type="number"
            value={maxFamilies}
            onChange={(e) => setMaxFamilies(e.target.value)}
            placeholder="No limit"
          />
        </div>
        <div className="form-field">
          <label>Max Total Exposure (USDC)</label>
          <input
            type="number"
            value={maxExposure}
            onChange={(e) => setMaxExposure(e.target.value)}
            placeholder="No limit"
          />
        </div>
        <div>
          <button className="btn-success" onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? "Saving..." : "Save"}
          </button>
          {update.isSuccess && (
            <span style={{ marginLeft: 8, color: "var(--green)", fontSize: 11 }}>Saved</span>
          )}
          {update.isError && (
            <span style={{ marginLeft: 8, color: "var(--red)", fontSize: 11 }}>Error</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function RiskSettings() {
  const { data } = useProfiles();
  const profiles = data?.profiles ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeId = selectedId ?? profiles[0]?.profile_id ?? null;

  return (
    <div className="page">
      <div className="page-title">Risk Settings</div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
        Configure risk caps per profile. Empty fields mean no limit.
      </p>
      <div className="profile-tabs">
        {profiles.map((p) => (
          <button
            key={p.profile_id}
            className={`profile-tab ${activeId === p.profile_id ? "active" : ""}`}
            onClick={() => setSelectedId(p.profile_id)}
          >
            {p.display_name}
          </button>
        ))}
      </div>
      {activeId && <RiskForm profileId={activeId} />}
    </div>
  );
}
