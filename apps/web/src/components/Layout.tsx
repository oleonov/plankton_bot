import { NavLink, Outlet } from "react-router-dom";
import { StatusBar } from "./StatusBar.tsx";
import { AlertStrip } from "./AlertStrip.tsx";

const NAV_ITEMS = [
  { to: "/overview", label: "Overview" },
  { to: "/positions", label: "Positions" },
  { to: "/orders", label: "Orders/Fills" },
  { to: "/families", label: "Families" },
  { to: "/risk", label: "Risk" },
];

export function Layout() {
  return (
    <>
      <nav style={{
        background: "var(--bg-nav)",
        color: "var(--text)",
        padding: "8px 16px",
        display: "flex",
        alignItems: "center",
        gap: 24,
        fontSize: 13,
      }}>
        <span style={{ fontWeight: 700, color: "var(--blue)", fontSize: 15 }}>PLANKTON</span>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            style={({ isActive }) => ({
              padding: "4px 10px",
              background: isActive ? "#2a2a4a" : "transparent",
              borderRadius: 4,
              color: isActive ? "#fff" : "var(--text-muted)",
              textDecoration: "none",
            })}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <StatusBar />
      <AlertStrip />
      <Outlet />
    </>
  );
}
