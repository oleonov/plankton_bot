import { useState } from "react";
import { useProfiles, useProfileDetail, useUpdateProfileSettings } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";

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

function ProfileRiskForm({ profileId, displayName }: { profileId: string; displayName: string }) {
  const { data: detail } = useProfileDetail(profileId);
  const update = useUpdateProfileSettings(profileId);
  const caps = parseRiskCaps(detail?.settings?.risk_caps_json ?? null);

  const [dailyLossCap, setDailyLossCap] = useState<string>("");
  const [dailyNotionalCap, setDailyNotionalCap] = useState<string>("");
  const [maxNewMarkets, setMaxNewMarkets] = useState<string>("");
  const [maxFamilies, setMaxFamilies] = useState<string>("");
  const [maxExposure, setMaxExposure] = useState<string>("");
  const [initialized, setInitialized] = useState(false);

  if (detail?.settings && !initialized) {
    setDailyLossCap(String(caps.dailyLossCap ?? ""));
    setDailyNotionalCap(String(caps.dailyNotionalCap ?? ""));
    setMaxNewMarkets(String(caps.maxNewMarketsPerDay ?? ""));
    setMaxFamilies(String(caps.maxOpenFamilies ?? ""));
    setMaxExposure(String(caps.maxTotalExposureUsdc ?? ""));
    setInitialized(true);
  }

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
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{displayName}</span>
        <Badge value={profileId} type="mode" />
      </div>
      <div className="settings-form">
        <div className="form-field">
          <label>Daily Loss Cap (USDC)</label>
          <input type="number" value={dailyLossCap} onChange={(e) => setDailyLossCap(e.target.value)} placeholder="No limit" />
        </div>
        <div className="form-field">
          <label>Daily Notional Cap (USDC)</label>
          <input type="number" value={dailyNotionalCap} onChange={(e) => setDailyNotionalCap(e.target.value)} placeholder="No limit" />
        </div>
        <div className="form-field">
          <label>Max New Markets / Day</label>
          <input type="number" value={maxNewMarkets} onChange={(e) => setMaxNewMarkets(e.target.value)} placeholder="No limit" />
        </div>
        <div className="form-field">
          <label>Max Open Families</label>
          <input type="number" value={maxFamilies} onChange={(e) => setMaxFamilies(e.target.value)} placeholder="No limit" />
        </div>
        <div className="form-field">
          <label>Max Total Exposure (USDC)</label>
          <input type="number" value={maxExposure} onChange={(e) => setMaxExposure(e.target.value)} placeholder="No limit" />
        </div>
        <div>
          <button className="btn-success" onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? "Saving..." : "Save"}
          </button>
          {update.isSuccess && <span style={{ marginLeft: 8, color: "var(--green)", fontSize: 11 }}>Saved</span>}
          {update.isError && <span style={{ marginLeft: 8, color: "var(--red)", fontSize: 11 }}>Error saving</span>}
        </div>
      </div>
    </div>
  );
}

export function RiskSettings() {
  const { data } = useProfiles();
  const profiles = data?.profiles ?? [];

  return (
    <div className="page">
      <div className="page-title">Risk Settings</div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
        Configure risk caps per profile. Empty fields mean no limit.
      </p>
      {profiles.map((p) => (
        <ProfileRiskForm key={p.profile_id} profileId={p.profile_id} displayName={p.display_name} />
      ))}
      {profiles.length === 0 && (
        <div className="card" style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading profiles...</div>
      )}
    </div>
  );
}
