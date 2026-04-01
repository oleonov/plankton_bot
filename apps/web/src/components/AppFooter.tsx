import { useBuildInfo } from "../api/hooks.ts";

export function AppFooter() {
  const { data } = useBuildInfo();

  const version =
    data?.deployVersion != null ? `v${String(data.deployVersion).padStart(3, "0")}` : null;
  const sha = data?.sha?.slice(0, 7) ?? null;

  if (!version && !sha) return null;

  const label = [version, sha].filter(Boolean).join(" \u00b7 ");

  return (
    <footer
      style={{
        padding: "4px 16px",
        textAlign: "right",
        fontSize: 10,
        color: "var(--text-dim)",
        borderTop: "1px solid var(--border)",
        flexShrink: 0,
      }}
      title={data?.deployedAt ? `Deployed: ${data.deployedAt}` : undefined}
    >
      {label}
    </footer>
  );
}
