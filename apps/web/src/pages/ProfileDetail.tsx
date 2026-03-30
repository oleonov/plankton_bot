import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useProfileDetail } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { formatAgo } from "../utils/format.ts";
import type { ProfileDTO, DeployedFamilyDTO } from "../api/types.ts";

function SummaryTab({ profile }: { profile: ProfileDTO }) {
  return (
    <div style={{ fontSize: 12 }}>
      <div className="profile-stat">
        <span className="label">Exposure</span>
        <span>${profile.total_exposure_usdc?.toFixed(2) ?? "0.00"}</span>
      </div>
      <div className="profile-stat">
        <span className="label">Balance</span>
        <span>${profile.balance_usdc?.toFixed(2) ?? "0.00"}</span>
      </div>
      <div className="profile-stat">
        <span className="label">Positions</span>
        <span>{profile.open_positions ?? 0}</span>
      </div>
      <div className="profile-stat">
        <span className="label">Open Orders</span>
        <span>{profile.open_orders ?? 0}</span>
      </div>
      <div className="profile-stat">
        <span className="label">Preflight Status</span>
        <span>{profile.last_preflight_status ?? "n/a"}</span>
      </div>
      <div className="profile-stat">
        <span className="label">Last Run</span>
        <span>{formatAgo(profile.last_run_at)}</span>
      </div>
      {profile.description && (
        <div className="profile-stat">
          <span className="label">Description</span>
          <span>{profile.description}</span>
        </div>
      )}
    </div>
  );
}

function FamiliesTab({ families }: { families: DeployedFamilyDTO[] }) {
  if (families.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-dim)" }}>No families deployed</div>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Family</th>
          <th>Category</th>
          <th>Regime</th>
          <th>Operator Mode</th>
          <th>Strategy Stage</th>
          <th>Deployment Stage</th>
        </tr>
      </thead>
      <tbody>
        {families.map((f) => (
          <tr key={f.family_id}>
            <td style={{ color: "var(--blue)" }}>{f.family_key}</td>
            <td>{f.primary_category}</td>
            <td>{f.regime}</td>
            <td>
              <Badge value={f.operator_mode} type="mode" />
            </td>
            <td>
              <Badge value={f.strategy_stage} />
            </td>
            <td>
              <Badge value={f.deployment_stage} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProfileDetail() {
  const { profileId } = useParams<{ profileId: string }>();
  const { data, isLoading } = useProfileDetail(profileId ?? null);
  const [tab, setTab] = useState<"summary" | "families">("summary");

  if (isLoading || !data) return <div className="page" style={{ fontSize: 12 }}>Loading...</div>;

  return (
    <div className="page">
      <Link to="/profiles" style={{ fontSize: 12, color: "var(--text-muted)" }}>
        &larr; Back to Profiles
      </Link>
      <div style={{ fontSize: 15, fontWeight: 700, margin: "12px 0" }}>
        {data.profile.display_name}
      </div>
      <div className="card">
        <div className="tab-bar">
          <div
            className={`tab ${tab === "summary" ? "active" : ""}`}
            onClick={() => setTab("summary")}
          >
            Summary
          </div>
          <div
            className={`tab ${tab === "families" ? "active" : ""}`}
            onClick={() => setTab("families")}
          >
            Deployed Families ({data.deployedFamilies.length})
          </div>
          <Link to={`/profiles/${profileId}/orders`} className="tab">
            Orders
          </Link>
          <Link to={`/profiles/${profileId}/positions`} className="tab">
            Positions
          </Link>
          <Link to={`/profiles/${profileId}/fills`} className="tab">
            Fills
          </Link>
        </div>
        {tab === "summary" && <SummaryTab profile={data.profile} />}
        {tab === "families" && <FamiliesTab families={data.deployedFamilies} />}
      </div>
    </div>
  );
}
