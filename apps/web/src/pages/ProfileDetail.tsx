import { useParams, Link } from "react-router-dom";
import { useProfileDetail } from "../api/hooks.ts";
import { formatAgo } from "../utils/format.ts";
import type { ProfileDTO } from "../api/types.ts";

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

export function ProfileDetail() {
  const { profileId } = useParams<{ profileId: string }>();
  const { data, isLoading } = useProfileDetail(profileId ?? null);

  if (isLoading || !data)
    return (
      <div className="page" style={{ fontSize: 12 }}>
        Loading...
      </div>
    );

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
        <SummaryTab profile={data.profile} />
      </div>
    </div>
  );
}
