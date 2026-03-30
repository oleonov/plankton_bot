import { useNavigate } from "react-router-dom";
import { useProfiles } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { formatAgo } from "../utils/format.ts";
import type { ProfileDTO } from "../api/types.ts";

function ProfileListCard({
  profile,
  onClick,
}: {
  profile: ProfileDTO;
  onClick: () => void;
}) {
  return (
    <div className="profile-card" onClick={onClick}>
      <h3>{profile.display_name}</h3>
      <div className="profile-stat">
        <span className="label">Status</span>
        <Badge value={profile.paused ? "paused" : "running"} type="status" />
      </div>
      <div className="profile-stat">
        <span className="label">Positions</span>
        <span>{profile.open_positions ?? 0}</span>
      </div>
      <div className="profile-stat">
        <span className="label">Last Run</span>
        <span>{formatAgo(profile.last_run_at)}</span>
      </div>
    </div>
  );
}

export function Profiles() {
  const { data, isLoading } = useProfiles();
  const navigate = useNavigate();

  if (isLoading) return <div className="page">Loading...</div>;

  const profiles = data?.profiles ?? [];

  return (
    <div className="page">
      <div className="page-title">Profiles</div>
      <div className="profile-cards">
        {profiles.map((p) => (
          <ProfileListCard
            key={p.profile_id}
            profile={p}
            onClick={() => navigate(`/profiles/${p.profile_id}`)}
          />
        ))}
      </div>
    </div>
  );
}
