const MODE_STYLES: Record<string, string> = {
  simulation: "badge-green",
  paper: "badge-orange",
  "paper-trade": "badge-orange",
  "live-lite": "badge-red",
  PAUSED: "badge-red",
  RUNNING: "badge-green",
};

const STATUS_STYLES: Record<string, string> = {
  open: "badge-green",
  pending: "badge-orange",
  "partially-filled": "badge-orange",
  filled: "badge-blue",
  cancelled: "badge-red",
  closed: "badge-red",
  dust: "badge-orange",
  resolving: "badge-orange",
  settled: "badge-green",
  enabled: "badge-green",
  disabled: "badge-red",
};

const SEVERITY_STYLES: Record<string, string> = {
  critical: "badge-red",
  warning: "badge-orange",
  info: "badge-blue",
};

const LIVENESS_STYLES: Record<string, string> = {
  active: "badge-green",
  dormant: "badge-orange",
  unseen: "badge-blue",
};

const LIQUIDITY_STYLES: Record<string, string> = {
  maker: "badge-blue",
  taker: "badge-orange",
};

export function Badge({
  value,
  type = "status",
}: {
  value: string;
  type?: "mode" | "status" | "severity" | "liveness" | "liquidity";
}) {
  const map =
    type === "mode"
      ? MODE_STYLES
      : type === "severity"
        ? SEVERITY_STYLES
        : type === "liveness"
          ? LIVENESS_STYLES
          : type === "liquidity"
            ? LIQUIDITY_STYLES
            : STATUS_STYLES;
  const cls = map[value] ?? "badge-blue";
  return <span className={`badge ${cls}`}>{value}</span>;
}
