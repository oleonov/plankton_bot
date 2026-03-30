import { NavLink, Outlet } from "react-router-dom";
import { useStatus, usePause, useResume } from "../api/hooks.ts";
import { useSSEState } from "../api/sse.tsx";
import { Badge } from "./Badge.tsx";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { AlertStrip } from "./AlertStrip.tsx";
import { DemotionAlertStrip } from "./DemotionAlertStrip.tsx";
import { useProposals } from "../api/hooks.ts";

function ProposalBadge() {
  const { data: proposals } = useProposals();
  const count = proposals?.length ?? 0;
  if (count === 0) return null;
  return (
    <span
      style={{
        background: "var(--orange)",
        color: "#000",
        borderRadius: 8,
        padding: "1px 5px",
        fontSize: 9,
        fontWeight: 700,
        marginLeft: 4,
      }}
    >
      {count}
    </span>
  );
}

function TopBar() {
  const { data: status } = useStatus();
  const sseState = useSSEState();
  const pause = usePause();
  const resume = useResume();

  const sseIndicator =
    sseState === "connected" ? (
      <span style={{ color: "var(--green)" }}>&#9679;</span>
    ) : sseState === "reconnecting" ? (
      <span style={{ color: "var(--orange)" }}>&#9676;</span>
    ) : (
      <span style={{ color: "var(--red)" }}>&#10005;</span>
    );

  return (
    <div className="top-bar">
      <span style={{ fontWeight: 700, color: "var(--blue)", fontSize: 15 }}>PLANKTON</span>
      {status && (
        <>
          <Badge value={status.runtimeMode} type="mode" />
          <Badge value={status.paused ? "PAUSED" : "RUNNING"} type="mode" />
          {status.runtimeMode === "live-lite" && (
            <span
              style={{
                background: "var(--red)",
                color: "white",
                padding: "2px 8px",
                borderRadius: 3,
                fontWeight: 700,
                fontSize: 10,
              }}
            >
              LIVE-LITE
            </span>
          )}
          <span style={{ fontSize: 11 }}>
            ${status.totalOpenValueUsdc?.toFixed(2) ?? "0.00"}
          </span>
          {sseIndicator}
        </>
      )}
      <span style={{ marginLeft: "auto" }}>
        {status?.paused ? (
          <ConfirmAction
            key="resume-action"
            label="&#9654; RESUME"
            confirmText="Resume trading?"
            variant="success"
            onConfirm={(r) => resume.mutate(r)}
            isPending={resume.isPending}
          />
        ) : (
          <ConfirmAction
            key="pause-action"
            label="&#9646;&#9646; PAUSE"
            confirmText="Pause all trading?"
            variant="danger"
            onConfirm={(r) => pause.mutate(r)}
            isPending={pause.isPending}
          />
        )}
      </span>
    </div>
  );
}

const NAV_ITEMS: { to: string; label: string; badge?: boolean }[] = [
  { to: "/control", label: "Control" },
  { to: "/profiles", label: "Profiles" },
  { to: "/families", label: "Families" },
  { to: "/discovery", label: "Discovery", badge: true },
];

const NAV_ITEMS_2: { to: string; label: string }[] = [
  { to: "/positions", label: "Positions" },
  { to: "/orders", label: "Orders" },
  { to: "/risk", label: "Risk" },
];

const NAV_ITEMS_3: { to: string; label: string }[] = [
  { to: "/settings", label: "Settings" },
  { to: "/audit", label: "Audit" },
];

export function Layout() {
  return (
    <div className="app-shell">
      <TopBar />
      <nav className="left-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to}>
            {item.label}
            {item.badge && <ProposalBadge />}
          </NavLink>
        ))}
        <div className="separator" />
        {NAV_ITEMS_2.map((item) => (
          <NavLink key={item.to} to={item.to}>
            {item.label}
          </NavLink>
        ))}
        <div className="separator" />
        {NAV_ITEMS_3.map((item) => (
          <NavLink key={item.to} to={item.to}>
            {item.label}
          </NavLink>
        ))}
        <div style={{ flex: 1 }} />
        <button
          className="left-nav-logout"
          onClick={() => {
            fetch("/api/v1/auth/logout", { method: "POST" })
              .then(() => window.location.reload())
              .catch(() => window.location.reload());
          }}
        >
          Logout
        </button>
      </nav>
      <div className="main-content">
        <AlertStrip />
        <DemotionAlertStrip />
        <Outlet />
      </div>
    </div>
  );
}
