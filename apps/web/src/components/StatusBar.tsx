import { useEffect, useState } from "react";
import { useStatus, usePause, useResume } from "../api/hooks.ts";
import { useSSEState } from "../api/sse.tsx";
import type { StatusData } from "../api/types.ts";
import { Badge } from "./Badge.tsx";
import { ConfirmAction } from "./ConfirmAction.tsx";
import { formatUptime, formatAgo } from "../utils/format.ts";

type RuntimeDisplayState =
  | "RUNNING"
  | "PAUSED"
  | "STARTING"
  | "STOPPING"
  | "STOPPED"
  | "FAILED"
  | "STALE"
  | "UNKNOWN";

function runtimeDisplayState(status: StatusData | undefined, nowMs: number): RuntimeDisplayState {
  if (!status) return "UNKNOWN";

  const lifecycle = status.runtimeState;
  if (lifecycle === "starting") return "STARTING";
  if (lifecycle === "stopping") return "STOPPING";
  if (lifecycle === "stopped") return "STOPPED";
  if (lifecycle === "failed") return "FAILED";
  if (lifecycle !== "running" && lifecycle !== "ready_paused") return "UNKNOWN";

  const threshold = status.runtimeHeartbeatFreshnessMs;
  const heartbeatAtMs = Date.parse(status.runtimeHeartbeatAt ?? "");
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    !Number.isFinite(heartbeatAtMs)
  ) {
    return "UNKNOWN";
  }
  if (heartbeatAtMs > nowMs) return "UNKNOWN";
  if (nowMs - heartbeatAtMs >= threshold) return "STALE";
  if (status.runtimeAlive !== true) return "UNKNOWN";
  return lifecycle === "ready_paused" ? "PAUSED" : "RUNNING";
}

export function StatusBar() {
  const { data: status, isError } = useStatus();
  const sseState = useSSEState();
  const pause = usePause();
  const resume = useResume();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const refreshClock = () => setNowMs(Date.now());
    const restoreClock = () => {
      if (document.visibilityState !== "hidden") refreshClock();
    };
    const timer = window.setInterval(refreshClock, 1_000);
    document.addEventListener("visibilitychange", restoreClock);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", restoreClock);
    };
  }, []);

  const runtimeState = runtimeDisplayState(status, nowMs);
  const uptime =
    (runtimeState === "RUNNING" || runtimeState === "PAUSED") &&
    typeof status?.uptimeSeconds === "number" &&
    Number.isFinite(status.uptimeSeconds)
      ? formatUptime(status.uptimeSeconds)
      : "—";

  const sseIndicator =
    isError && !status ? (
      <span style={{ color: "var(--red)" }}>API: status unavailable</span>
    ) : sseState === "connected" ? (
      <span style={{ color: "var(--green)" }}>&#9679; API: connected</span>
    ) : sseState === "reconnecting" ? (
      <span style={{ color: "var(--orange)" }}>&#9676; API: reconnecting</span>
    ) : (
      <span style={{ color: "var(--red)" }}>&#10005; API: disconnected</span>
    );
  const topInfraAlert = status?.infraAlerts?.[0] ?? null;
  const showExecutionMode =
    status && (status.marketDataSource !== "live" || status.executionMode !== "live");
  const reconciliationKind = status?.reconciliation?.kind;
  const showLegacyReconDrift = !reconciliationKind && status?.reconciliationDriftDetected;

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
      <Badge value={runtimeState} type="mode" />
      {showExecutionMode && (
        <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
          data:{status.marketDataSource} exec:{status.executionMode}
        </span>
      )}
      <span>uptime: {uptime}</span>
      {status && <span>recon: {formatAgo(status.lastReconciliationAt)}</span>}
      {status && (
        <span>
          mktdata:{" "}
          {status.marketDataStale ? (
            <span className="badge badge-red">STALE</span>
          ) : (
            <span className="badge badge-green">FRESH</span>
          )}
        </span>
      )}
      {status?.marketDataPoll?.active && (
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>refreshing prices</span>
      )}
      {reconciliationKind === "position_drift" && (
        <span className="badge badge-red" style={{ fontWeight: 700 }}>
          POSITION DRIFT
        </span>
      )}
      {(reconciliationKind === "unresolved_missing" ||
        reconciliationKind === "other_drift" ||
        showLegacyReconDrift) && (
        <span className="badge badge-red" style={{ fontWeight: 700 }}>
          RECON DRIFT
        </span>
      )}
      {reconciliationKind === "acknowledged_external_state_unknown" && (
        <span className="badge badge-orange" style={{ fontWeight: 700 }}>
          EXTERNAL STATE UNKNOWN
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
      {status && (
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
      )}
    </div>
  );
}
