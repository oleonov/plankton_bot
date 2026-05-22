import { useState } from "react";
import { useControlOverview, useStatus, usePause, useResume } from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { ConfirmAction } from "../components/ConfirmAction.tsx";
import { SwitchProfileWizard } from "../components/wizards/SwitchProfileWizard.tsx";
import { ResumeLiveWizard } from "../components/wizards/ResumeLiveWizard.tsx";
import { formatAgo } from "../utils/format.ts";
import type { ProfileDTO } from "../api/types.ts";

type Wizard = "switch" | "resume-live" | null;

function ProfileCard({
  profile,
  isCurrent,
  runtimePaused,
}: {
  profile: ProfileDTO;
  isCurrent: boolean;
  runtimePaused: boolean;
}) {
  const profileStatus = isCurrent ? (runtimePaused ? "paused" : "running") : "stopped";
  return (
    <div className={`profile-card ${isCurrent ? "current" : ""}`}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <h3>{profile.display_name}</h3>
        <Badge value={profileStatus} type="status" />
      </div>
      <div className="profile-stat">
        <span className="label">Exposure</span>
        <span>${profile.total_exposure_usdc?.toFixed(2) ?? "0.00"}</span>
      </div>
      <div className="profile-stat">
        <span className="label">Positions</span>
        <span>{profile.open_positions ?? 0}</span>
      </div>
      <div className="profile-stat">
        <span className="label">Last Run</span>
        <span>{formatAgo(profile.last_run_at)}</span>
      </div>
      {isCurrent && (
        <div style={{ marginTop: 6, fontSize: 10, color: "var(--green)", fontWeight: 600 }}>
          ACTIVE PROFILE
        </div>
      )}
    </div>
  );
}

export function ControlCenter() {
  const { data: overview } = useControlOverview();
  const { data: status } = useStatus();
  const pause = usePause();
  const resume = useResume();
  const [wizard, setWizard] = useState<Wizard>(null);

  if (!overview) return <div className="page">Loading...</div>;

  const { profiles, runtimeState } = overview;
  const currentProfile = runtimeState?.current_profile;
  const isLiveLite = status?.runtimeMode === "live-lite";

  return (
    <div className="page">
      <div className="page-title">Control Center</div>

      <div className="profile-cards">
        {profiles.map((p) => (
          <ProfileCard
            key={p.profile_id}
            profile={p}
            isCurrent={p.profile_id === currentProfile}
            runtimePaused={status?.paused ?? true}
          />
        ))}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="label" style={{ marginBottom: 8 }}>
          Quick Actions
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn-success" onClick={() => setWizard("switch")}>
            Switch Profile
          </button>
          {status?.paused ? (
            isLiveLite ? (
              <button className="btn-success" onClick={() => setWizard("resume-live")}>
                Resume Live
              </button>
            ) : (
              <ConfirmAction
                label="Resume"
                confirmText="Resume trading?"
                variant="success"
                showReason
                onConfirm={(reason) => resume.mutate(reason)}
                isPending={resume.isPending}
              />
            )
          ) : (
            <ConfirmAction
              label="Pause"
              confirmText="Pause trading?"
              variant="danger"
              showReason
              onConfirm={(reason) => pause.mutate(reason)}
              isPending={pause.isPending}
            />
          )}
        </div>
      </div>

      {wizard === "switch" && <SwitchProfileWizard onClose={() => setWizard(null)} />}
      {wizard === "resume-live" && <ResumeLiveWizard onClose={() => setWizard(null)} />}
    </div>
  );
}
