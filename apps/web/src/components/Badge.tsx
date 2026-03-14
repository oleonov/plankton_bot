const MODE_STYLES: Record<string, string> = {
  active: "badge-green",
  "reduce-only": "badge-orange",
  quarantine: "badge-red",
  simulation: "badge-green",
  paper: "badge-orange",
  "paper-trade": "badge-orange",
  "live-lite": "badge-red",
};

const STATUS_STYLES: Record<string, string> = {
  open: "badge-green",
  pending: "badge-orange",
  "partially-filled": "badge-orange",
  filled: "badge-blue",
  cancelled: "badge-red",
  closed: "badge-red",
  dust: "badge-orange",
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "badge-red",
  warning: "badge-orange",
  info: "badge-blue",
};

export function Badge({ value, type = "status" }: { value: string; type?: "mode" | "status" | "severity" }) {
  const map = type === "mode" ? MODE_STYLES : type === "severity" ? SEVERITY_STYLES : STATUS_STYLES;
  const cls = map[value] ?? "badge-blue";
  return <span className={`badge ${cls}`}>{value}</span>;
}
