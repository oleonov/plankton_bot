import { useState } from "react";
import { useProfiles, useProfileDetail } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
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

function ProfileContent({ profileId }: { profileId: string }) {
  const { data, isLoading } = useProfileDetail(profileId);

  if (isLoading || !data) return <div style={{ fontSize: 12, padding: 16 }}>Loading...</div>;

  return (
    <div className="card">
      <SummaryTab profile={data.profile} />
    </div>
  );
}

function profileStatus(
  profileId: string,
  currentProfile: string | null,
  runtimeStatus: string,
): string {
  if (profileId !== currentProfile) return "stopped";
  // runtime_status: stopped | starting | ready_paused | running | stopping | failed
  if (runtimeStatus === "running") return "running";
  if (runtimeStatus === "ready_paused") return "paused";
  return runtimeStatus; // stopped, starting, stopping, failed — show as-is
}

export function Profiles() {
  const { data, isLoading } = useProfiles();
  const profiles = data?.profiles ?? [];
  const currentProfile = data?.runtimeState?.current_profile ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Auto-select first profile
  const activeId = selectedId ?? profiles[0]?.profile_id ?? null;

  if (isLoading) return <div className="page">Loading...</div>;

  return (
    <div className="page">
      <div className="page-title">Profiles</div>
      <div className="profile-tabs">
        {profiles.map((p) => (
          <button
            key={p.profile_id}
            className={`profile-tab ${activeId === p.profile_id ? "active" : ""}`}
            onClick={() => setSelectedId(p.profile_id)}
          >
            {p.display_name}
            <Badge
              value={profileStatus(
                p.profile_id,
                currentProfile,
                data?.runtimeState?.runtime_status ?? "stopped",
              )}
              type="status"
            />
          </button>
        ))}
      </div>
      {activeId && <ProfileContent profileId={activeId} />}
    </div>
  );
}
