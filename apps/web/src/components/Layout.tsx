import { useState, useRef, useEffect } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useProposals } from "../api/hooks.ts";
import { StatusBar } from "./StatusBar.tsx";
import { AlertStrip } from "./AlertStrip.tsx";
import { DemotionAlertStrip } from "./DemotionAlertStrip.tsx";

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

function SettingsDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        className="nav-link"
        onClick={() => setOpen(!open)}
        style={{
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: 13,
          padding: "6px 12px",
        }}
      >
        Settings ▾
      </button>
      {open && (
        <div className="settings-dropdown">
          <button onClick={() => go("/control")}>Control Center</button>
          <button onClick={() => go("/profiles")}>Profiles</button>
          <button onClick={() => go("/settings/risk")}>Risk Settings</button>
          <button onClick={() => go("/audit")}>Audit Log</button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          background: "var(--bg-nav)",
          borderBottom: "1px solid var(--border)",
          padding: "0 16px",
          display: "flex",
          alignItems: "center",
          gap: 4,
          height: 40,
        }}
      >
        <span style={{ fontWeight: 700, color: "var(--blue)", fontSize: 15, marginRight: 12 }}>
          PLANKTON
        </span>
        <NavLink className="nav-link" to="/overview">Overview</NavLink>
        <NavLink className="nav-link" to="/positions">Positions</NavLink>
        <NavLink className="nav-link" to="/orders">Orders/Fills</NavLink>
        <NavLink className="nav-link" to="/families">Families</NavLink>
        <NavLink className="nav-link" to="/risk">Risk</NavLink>
        <NavLink className="nav-link" to="/discovery">
          Discovery
          <ProposalBadge />
        </NavLink>
        <SettingsDropdown />
        <span style={{ flex: 1 }} />
        <button
          className="nav-link"
          style={{
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: 13,
            padding: "6px 12px",
          }}
          onClick={() => {
            fetch("/api/v1/auth/logout", { method: "POST" })
              .then(() => window.location.reload())
              .catch(() => window.location.reload());
          }}
        >
          Logout
        </button>
      </header>
      <StatusBar />
      <AlertStrip />
      <DemotionAlertStrip />
      <div style={{ flex: 1, overflowY: "auto" }}>
        <Outlet />
      </div>
    </div>
  );
}
