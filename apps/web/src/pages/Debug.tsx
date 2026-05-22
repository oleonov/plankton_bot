import type { ReactNode } from "react";
import { useCoverageMetrics, useR23Metrics } from "../api/hooks.ts";
import type { CoverageMetricsData, R23MetricsData } from "../api/types.ts";

function formatPct(value?: number | null): string {
  return value == null ? "—" : `${(value * 100).toFixed(0)}%`;
}

function formatMs(value?: number | null): string {
  return value == null ? "—" : `${value.toFixed(0)}ms`;
}

function formatTopCounts(counts?: Record<string, number>, limit = 5): string {
  const entries = Object.entries(counts ?? {})
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
  return entries.length > 0 ? entries.map(([key, count]) => `${key}:${count}`).join(", ") : "none";
}

function DebugCard({
  title,
  children,
  accent = "card-accent-blue",
}: {
  title: string;
  children: ReactNode;
  accent?: string;
}) {
  return (
    <div className={`card ${accent}`}>
      <div className="label" style={{ marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr>
      <td style={{ color: "var(--text-muted)" }}>{label}</td>
      <td style={{ textAlign: "right" }}>{value}</td>
    </tr>
  );
}

function RuntimeTimers({ coverage }: { coverage: CoverageMetricsData }) {
  const timers = [
    ["ipc decode", coverage.stage_ipc_decode_max_ms, coverage.stage_ipc_decode_p95_ms],
    [
      "worker batch",
      coverage.stage_handle_worker_batch_max_ms,
      coverage.stage_handle_worker_batch_p95_ms,
    ],
    ["hub dispatch", coverage.stage_hub_dispatch_max_ms, coverage.stage_hub_dispatch_p95_ms],
    [
      "coalescing flush",
      coverage.stage_coalescing_flush_max_ms,
      coverage.stage_coalescing_flush_p95_ms,
    ],
    [
      "latency summary",
      coverage.stage_latency_summary_max_ms,
      coverage.stage_latency_summary_p95_ms,
    ],
    [
      "diagnostics write",
      coverage.stage_diagnostics_write_max_ms,
      coverage.stage_diagnostics_write_p95_ms,
    ],
    [
      "metrics flush",
      coverage.stage_metrics_flush_total_max_ms,
      coverage.stage_metrics_flush_total_p95_ms,
    ],
    [
      "sqlite writes",
      coverage.stage_metrics_flush_sqlite_writes_max_ms,
      coverage.stage_metrics_flush_sqlite_writes_p95_ms,
    ],
    [
      "snapshot serialize",
      coverage.stage_metrics_flush_snapshot_serialize_max_ms,
      coverage.stage_metrics_flush_snapshot_serialize_p95_ms,
    ],
    [
      "risk approval",
      coverage.stage_risk_signal_approval_max_ms,
      coverage.stage_risk_signal_approval_p95_ms,
    ],
    [
      "signal bridge",
      coverage.stage_signal_to_order_bridge_max_ms,
      coverage.stage_signal_to_order_bridge_p95_ms,
    ],
    [
      "worker non-update",
      coverage.stage_worker_non_update_events_max_ms,
      coverage.stage_worker_non_update_events_p95_ms,
    ],
    [
      "discovery publish",
      coverage.stage_discovery_poll_publish_max_ms,
      coverage.stage_discovery_poll_publish_p95_ms,
    ],
  ] as const;

  return (
    <table>
      <tbody>
        <Row
          label="event loop p95 / max"
          value={`${formatMs(coverage.event_loop_lag_p95_ms)} / ${formatMs(
            coverage.event_loop_lag_max_ms,
          )}`}
        />
        <Row label="GC max" value={formatMs(coverage.gc_pause_max_ms)} />
        {timers.map(([label, maxMs, p95Ms]) => (
          <Row
            key={label}
            label={label}
            value={`${formatMs(p95Ms)} p95 · ${formatMs(maxMs)} max`}
          />
        ))}
      </tbody>
    </table>
  );
}

function CoverageDebug({ coverage }: { coverage: CoverageMetricsData }) {
  return (
    <>
      <div className="grid-3" style={{ marginBottom: 16 }}>
        <DebugCard title="WS throughput">
          <table>
            <tbody>
              <Row
                label="tracked / universe"
                value={`${coverage.ws_tracked} / ${coverage.universe_active}`}
              />
              <Row label="events/sec" value={coverage.events_per_sec.toFixed(1)} />
              <Row
                label="raw / parsed / noop"
                value={`${coverage.raw_ws_records_per_sec.toFixed(1)} / ${coverage.parsed_updates_per_sec.toFixed(1)} / ${coverage.noop_updates_per_sec.toFixed(1)} per sec`}
              />
              <Row label="emitted/sec" value={coverage.emitted_updates_per_sec.toFixed(1)} />
              <Row
                label="hub pass/check"
                value={`${coverage.hub_filter_passed_per_sec.toFixed(1)} / ${coverage.hub_filter_checked_per_sec.toFixed(1)} per sec`}
              />
            </tbody>
          </table>
        </DebugCard>

        <DebugCard title="Loop / GC / timers" accent="card-accent-orange">
          <RuntimeTimers coverage={coverage} />
        </DebugCard>

        <DebugCard title="V4 admission" accent="card-accent-purple">
          <table>
            <tbody>
              <Row label="admit rate" value={formatPct(coverage.v4_admit_rate)} />
              <Row
                label="admit / evaluated"
                value={`${coverage.v4_admit_count_total} / ${coverage.v4_evaluated_total}`}
              />
              <Row
                label="top categories"
                value={formatTopCounts(coverage.v4_admit_count_by_category)}
              />
              <Row
                label="reject reasons"
                value={formatTopCounts(coverage.v4_reject_count_by_reason)}
              />
            </tbody>
          </table>
        </DebugCard>
      </div>

      <div className="grid-3" style={{ marginBottom: 16 }}>
        <DebugCard title="Exit telemetry" accent="card-accent-green">
          <table>
            <tbody>
              <Row
                label="anchor modes"
                value={formatTopCounts(coverage.exit_anchor_mode_total, 10)}
              />
              <Row
                label="TTL tiers"
                value={formatTopCounts(coverage.exit_ttl_resolved_total, 10)}
              />
              <Row
                label="chain caps"
                value={formatTopCounts(coverage.exit_chain_cap_resolved_total, 10)}
              />
              <Row
                label="threshold suppressed"
                value={coverage.exit_reprice_suppressed_threshold_total}
              />
              <Row
                label="TTL cancels"
                value={`${coverage.exit_order_ttl_cancel_total} total · ${coverage.exit_order_ttl_cancel_near_resolution_total} near resolution`}
              />
            </tbody>
          </table>
        </DebugCard>

        <DebugCard title="Cooldown diagnostics" accent="card-accent-purple">
          <table>
            <tbody>
              <Row
                label="early suppressions"
                value={coverage.signals_suppressed_early_cooldown_total}
              />
              <Row label="registry size" value={coverage.cooldown_registry_size} />
              <Row
                label="signal unique"
                value={`${coverage.cooldown_signal_unique_signals_total} total · ${coverage.cooldown_signal_early_only_total} early · ${coverage.cooldown_signal_late_only_total} late`}
              />
              <Row
                label="price keys"
                value={`${coverage.cooldown_price_unique_price_keys_total} total · ${coverage.cooldown_price_early_and_late_total} both`}
              />
              <Row label="no price" value={coverage.cooldown_price_skipped_no_price_total} />
            </tbody>
          </table>
        </DebugCard>

        <DebugCard title="WS heartbeat / memory">
          <table>
            <tbody>
              <Row
                label="heartbeat"
                value={`${coverage.ws_heartbeat?.pongReceived ?? 0}/${coverage.ws_heartbeat?.pingSent ?? 0} pong/ping · ${coverage.ws_heartbeat?.timeoutFired ?? 0} timeouts`}
              />
              <Row
                label="worker lag"
                value={formatMs(coverage.ws_heartbeat?.workerEventLoopLagMaxMs)}
              />
              <Row
                label="RSS"
                value={`${coverage.ws_worker_memory?.rssMb.toFixed(1) ?? "—"} MiB`}
              />
              <Row
                label="heap used"
                value={`${coverage.ws_worker_memory?.heapUsedMb.toFixed(1) ?? "—"} MiB`}
              />
            </tbody>
          </table>
        </DebugCard>
      </div>
    </>
  );
}

function R23Debug({ metrics }: { metrics?: R23MetricsData }) {
  if (!metrics) {
    return (
      <DebugCard title="R23 Dip Trigger" accent="card-accent-purple">
        <div className="value-sm">Loading R23 metrics</div>
      </DebugCard>
    );
  }
  return (
    <DebugCard title="R23 Dip Trigger" accent="card-accent-purple">
      <table>
        <tbody>
          <Row
            label="checked / fired"
            value={`${metrics.current.checked} / ${metrics.current.fired}`}
          />
          <Row
            label="no history / no dip"
            value={`${metrics.current.no_history} / ${metrics.current.no_dip}`}
          />
          <Row label="cache hit rate" value={formatPct(metrics.current.cache_hit_rate)} />
          <Row label="orders / fills 24h" value={`${metrics.orders_24h} / ${metrics.fills_24h}`} />
          <Row label="fill notional 24h" value={`$${metrics.fill_notional_usdc_24h.toFixed(2)}`} />
        </tbody>
      </table>
    </DebugCard>
  );
}

export function Debug() {
  const { data: coverage } = useCoverageMetrics();
  const { data: r23Metrics } = useR23Metrics();

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <h1 style={{ fontSize: 18, marginBottom: 4 }}>Debug Metrics</h1>
          <div className="value-sm">Runtime instrumentation moved off Overview.</div>
        </div>
        <div className="value-sm">
          {coverage?.captured_at ? `captured ${coverage.captured_at}` : "awaiting snapshot"}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {coverage ? (
          <CoverageDebug coverage={coverage} />
        ) : (
          <div className="card">
            <div className="label">Debug metrics</div>
            <div className="value-sm">Loading coverage metrics</div>
          </div>
        )}
      </div>

      <div className="grid-2">
        <R23Debug metrics={r23Metrics} />
        <DebugCard title="HTTP errors" accent="card-accent-red">
          <table>
            <tbody>
              <Row
                label="last hour"
                value={coverage ? formatTopCounts(coverage.http_errors_by_class_1h, 10) : "—"}
              />
            </tbody>
          </table>
        </DebugCard>
      </div>
    </div>
  );
}
