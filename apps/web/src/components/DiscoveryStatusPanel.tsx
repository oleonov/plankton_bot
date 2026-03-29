import { useDiscoveryStatus, useTriggerScan } from "../api/hooks.ts";
import { formatAgo } from "../utils/format.ts";
import type { DiscoveryStatusDTO } from "../api/types.ts";

function formatElapsed(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function scanLabel(status: DiscoveryStatusDTO): string {
  if (status.activeRun?.status === "running")
    return `Running (${formatElapsed(status.activeRun.startedAt)})`;
  if (status.activeRun?.status === "queued") return "Queued";
  return "Idle";
}

function lastSuccessLabel(status: DiscoveryStatusDTO): string {
  if (!status.lastSuccessfulRun) return "Never";
  const ago = formatAgo(status.lastSuccessfulRun.finishedAt);
  const count = status.lastSuccessfulRun.stats?.candidatesUpserted ?? 0;
  return `${ago} (${count} candidates)`;
}

export function DiscoveryStatusPanel() {
  const { data: status } = useDiscoveryStatus();
  const trigger = useTriggerScan();

  if (!status) return null;

  const busy = !!status.activeRun;
  const offline = status.workerState === "offline";
  const failed = status.lastRun?.status === "failed" && !status.activeRun;

  return (
    <div
      style={{
        background: "var(--bg-card)",
        borderRadius: 6,
        marginBottom: 12,
        border: `1px solid ${offline ? "var(--red)" : failed ? "var(--orange)" : "var(--border)"}`,
        padding: "8px 12px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        fontSize: 12,
      }}
    >
      {offline && (
        <span style={{ color: "var(--red)", fontWeight: 700 }}>Worker offline</span>
      )}
      {failed && (
        <span style={{ color: "var(--orange)", fontWeight: 700 }}>Last scan failed</span>
      )}
      <span>
        <b>Last scan:</b> {lastSuccessLabel(status)}
      </span>
      <span>
        <b>Status:</b> {scanLabel(status)}
      </span>
      <span style={{ color: "var(--text-dim)" }}>Auto-scan: hourly</span>
      <button
        className="btn-primary"
        style={{ marginLeft: "auto" }}
        disabled={busy || trigger.isPending}
        onClick={() => trigger.mutate()}
      >
        {trigger.isPending ? "Starting..." : "Scan now"}
      </button>
    </div>
  );
}
