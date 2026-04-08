import { useStatus, usePause, useResume } from "../api/hooks.ts";
import { useSSEState } from "../api/sse.tsx";
import { Badge } from "./Badge.tsx";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { formatUptime, formatAgo } from "../utils/format.ts";

export function StatusBar() {
  const { data: status } = useStatus();
  const sseState = useSSEState();
  const pause = usePause();
  const resume = useResume();

  if (!status) return null;

  const sseIndicator =
    sseState === "connected" ? (
      <span style={{ color: "var(--green)" }}>&#9679; connected</span>
    ) : sseState === "reconnecting" ? (
      <span style={{ color: "var(--orange)" }}>&#9676; reconnecting</span>
    ) : (
      <span style={{ color: "var(--red)" }}>&#10005; disconnected</span>
    );
  const topInfraAlert = status.infraAlerts?.[0] ?? null;

  return (
    <div
      style={{
        background: "var(--bg-status)",
        color: "var(--text-muted)",
        padding: "6px 16px",
        display: "flex",
        alignItems: "center",
        gap: 16,
        fontSize: 11,
        borderBottom: "1px solid var(--border)",
      }}
    >
      <Badge value={status.runtimeMode} type="mode" />
      <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 4 }}>
        data:{status.marketDataSource} exec:{status.executionMode}
      </span>
      {status.runtimeMode === "live-lite" && (
        <span
          style={{
            background: "var(--red)",
            color: "white",
            padding: "2px 8px",
            borderRadius: 3,
            fontWeight: 700,
            fontSize: 10,
            letterSpacing: 0.5,
          }}
        >
          ⚠ LIVE-LITE — real orders on exchange
        </span>
      )}
      <Badge value={status.paused ? "PAUSED" : "RUNNING"} type="mode" />
      <span>uptime: {formatUptime(status.uptimeSeconds)}</span>
      <span>recon: {formatAgo(status.lastReconciliationAt)}</span>
      <span>
        mktdata:{" "}
        {status.marketDataStale ? (
          <span className="badge badge-red">STALE</span>
        ) : (
          <span className="badge badge-green">FRESH</span>
        )}
      </span>
      {status.marketDataPoll?.active && (
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>refreshing prices</span>
      )}
      {status.reconciliationDriftDetected && (
        <span className="badge badge-red" style={{ fontWeight: 700 }}>
          RECON DRIFT
        </span>
      )}
      {topInfraAlert && (
        <span
          className={topInfraAlert.severity === "error" ? "badge badge-red" : "badge badge-orange"}
          style={{
            maxWidth: 420,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={topInfraAlert.message}
        >
          {topInfraAlert.message}
        </span>
      )}
      {sseIndicator}
      <span style={{ marginLeft: "auto" }}>
        {status.paused ? (
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
