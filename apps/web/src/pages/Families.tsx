import { useState, Fragment } from "react";
import {
  useFamiliesScoped,
  useFamilyPositions,
  useFamilyOrders,
  useFamilyEvidence,
  useFamilyTransitions,
} from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import { FamilyActions } from "../components/FamilyActions.tsx";
import { EvidenceSection } from "../components/EvidenceSection.tsx";
import { SortTh } from "../components/SortTh.tsx";
import { formatAgo } from "../utils/format.ts";
import { useSort, sortItems } from "../utils/useSort.ts";
import type { FamilyDTO } from "../api/types.ts";

function formatExecMakerPct(family: FamilyDTO): string {
  const ratio = family.executionTelemetry24h?.makerRatio;
  if (ratio == null) return "\u2014";
  return `${Math.round(ratio * 100)}% maker`;
}

function isLiveFamily(family: FamilyDTO): boolean {
  return (family.liveness ?? "unseen") === "active";
}

function TransitionTimeline({ familyId }: { familyId: string }) {
  const { data: transitions } = useFamilyTransitions(familyId);
  if (!transitions || transitions.length === 0) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 700, fontSize: 11, marginBottom: 6, color: "var(--text-muted)" }}>
        Transitions ({transitions.length})
      </div>
      <table style={{ fontSize: 11 }}>
        <thead>
          <tr>
            <th>When</th>
            <th>From</th>
            <th>To</th>
            <th>Trigger</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {transitions.map((t) => (
            <tr key={t.id}>
              <td>{formatAgo(t.createdAt)}</td>
              <td>
                <Badge value={t.fromState} />
              </td>
              <td>
                <Badge value={t.toState} />
              </td>
              <td>{t.triggerType}</td>
              <td
                style={{
                  maxWidth: 200,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t.reason}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FamilyDetail({ family }: { family: FamilyDTO }) {
  const familyId = family.familyId;
  const { data: positions } = useFamilyPositions(familyId);
  const { data: orders } = useFamilyOrders(familyId);
  const { data: evidence } = useFamilyEvidence(familyId);
  const execution = family.executionTelemetry24h;
  const makerPct = execution?.makerRatio != null ? Math.round(execution.makerRatio * 100) : null;
  const leakagePct = execution?.feeLeakageRatio != null ? execution.feeLeakageRatio * 100 : null;

  return (
    <tr>
      <td colSpan={10} style={{ padding: "8px 16px", background: "var(--bg-elevated)" }}>
        {evidence && <EvidenceSection evidence={evidence} familyId={familyId} />}
        <TransitionTimeline familyId={familyId} />
        <div style={{ marginBottom: 12 }}>
          <div
            style={{ fontWeight: 700, fontSize: 11, marginBottom: 6, color: "var(--text-muted)" }}
          >
            Execution (24h)
          </div>
          {execution && execution.totalFills > 0 ? (
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 11 }}>
              <span style={{ color: "var(--blue)", fontWeight: 700 }}>{makerPct}% maker</span>
              <span>
                {execution.makerFills} maker / {execution.takerFills} taker /{" "}
                {execution.unknownFills} unknown
              </span>
              <span>vol ${execution.volumeUsdc.toFixed(2)}</span>
              <span>fees ${execution.explicitFeesUsdc.toFixed(3)}</span>
              <span>leakage {leakagePct?.toFixed(2) ?? "0.00"}%</span>
              <span>last fill {formatAgo(execution.lastFillAt)}</span>
            </div>
          ) : (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>No fills in the last 24h</div>
          )}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <div
              style={{ fontWeight: 700, fontSize: 11, marginBottom: 6, color: "var(--text-muted)" }}
            >
              Positions ({positions?.length ?? 0})
            </div>
            {positions && positions.length > 0 ? (
              <table style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Size</th>
                    <th>Value</th>
                    <th>PnL</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.positionId}>
                      <td>{p.tokenId.slice(0, 12)}</td>
                      <td>{p.size.toFixed(2)}</td>
                      <td>
                        {p.currentValueUsdc != null
                          ? `$${p.currentValueUsdc.toFixed(2)}`
                          : "\u2014"}
                      </td>
                      <td style={{ color: p.realizedPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                        {p.realizedPnl >= 0 ? "+" : ""}${p.realizedPnl.toFixed(2)}
                      </td>
                      <td>
                        <Badge value={p.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>No positions</div>
            )}
          </div>
          <div>
            <div
              style={{ fontWeight: 700, fontSize: 11, marginBottom: 6, color: "var(--text-muted)" }}
            >
              Orders ({orders?.items?.length ?? 0})
            </div>
            {orders?.items && orders.items.length > 0 ? (
              <table style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Side</th>
                    <th>Size</th>
                    <th>Price</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.items.map((o) => (
                    <tr key={o.orderId}>
                      <td>{o.tokenId.slice(0, 12)}</td>
                      <td>{o.side}</td>
                      <td>{o.size.toFixed(2)}</td>
                      <td>${o.price.toFixed(4)}</td>
                      <td>
                        <div
                          style={{
                            display: "flex",
                            gap: 6,
                            alignItems: "center",
                            flexWrap: "wrap",
                          }}
                        >
                          <Badge value={o.status} />
                          {o.postOnly ? <Badge value="post-only" /> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>No orders</div>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function utilizationColor(current: number, max: number): string {
  const pct = current / max;
  if (pct > 0.9) return "var(--red)";
  if (pct > 0.7) return "var(--orange)";
  return "var(--text)";
}

const familyAccessors: Record<string, (f: FamilyDTO) => string | number | null> = {
  mode: (f) => f.state?.runtimeMode ?? "",
  promotion: (f) => f.promotionState,
  openValue: (f) => f.state?.openValueUsdc ?? 0,
  positions: (f) => f.state?.openPositionCount ?? 0,
  markets: (f) => f.state?.activeMarketCount ?? 0,
  tailCost: (f) => f.state?.currentTailCostUsdc ?? 0,
  tailAdjPnl: (f) => f.state?.tailAdjustedPnlLive ?? 0,
  execMaker: (f) => f.executionTelemetry24h?.makerRatio ?? -1,
};

export function Families() {
  const [scope, setScope] = useState<"profile" | "all">("profile");
  const { data, isLoading } = useFamiliesScoped(scope);
  const families = data?.items ?? [];
  const meta = data?.meta ?? null;
  const [expanded, setExpanded] = useState<string | null>(null);
  const { sort, toggle } = useSort();

  // If API returned "all" despite requesting "profile" (no active profile),
  // sync the toggle to match
  const effectiveScope = meta?.scope ?? "all";

  if (isLoading) return <div className="page">Loading...</div>;

  const sorted =
    effectiveScope === "profile" && !sort
      ? [...families].sort(
          (a, b) => (a.deployment?.priority ?? 999) - (b.deployment?.priority ?? 999),
        )
      : sortItems(families, sort, familyAccessors);

  return (
    <div className="page">
      <div className="page-title">Families</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <div
          style={{
            display: "inline-flex",
            borderRadius: 6,
            overflow: "hidden",
            border: "1px solid var(--border)",
          }}
        >
          <button
            onClick={() => setScope("profile")}
            disabled={meta?.profile == null}
            style={{
              padding: "4px 12px",
              fontSize: 12,
              fontWeight: effectiveScope === "profile" ? 700 : 400,
              background: effectiveScope === "profile" ? "var(--blue)" : "transparent",
              color: effectiveScope === "profile" ? "#fff" : "var(--text)",
              border: "none",
              cursor: meta?.profile == null ? "not-allowed" : "pointer",
              opacity: meta?.profile == null ? 0.4 : 1,
            }}
          >
            Current Profile
          </button>
          <button
            onClick={() => setScope("all")}
            style={{
              padding: "4px 12px",
              fontSize: 12,
              fontWeight: effectiveScope === "all" ? 700 : 400,
              background: effectiveScope === "all" ? "var(--blue)" : "transparent",
              color: effectiveScope === "all" ? "#fff" : "var(--text)",
              border: "none",
              cursor: "pointer",
            }}
          >
            All Families
          </button>
        </div>
        {meta && (
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            {families.length}
            {effectiveScope === "profile" && meta.totalCatalogCount > families.length
              ? ` of ${meta.totalCatalogCount}`
              : ""}{" "}
            families
            {meta.profile ? ` (${meta.profile})` : ""}
          </span>
        )}
      </div>
      <table>
        <thead>
          <tr>
            <th>Family</th>
            <SortTh label="Mode" sortKey="mode" sort={sort} onToggle={toggle} />
            <SortTh label="Promotion" sortKey="promotion" sort={sort} onToggle={toggle} />
            <SortTh label="Open Value" sortKey="openValue" sort={sort} onToggle={toggle} />
            <SortTh label="Positions" sortKey="positions" sort={sort} onToggle={toggle} />
            <SortTh label="Markets" sortKey="markets" sort={sort} onToggle={toggle} />
            <SortTh label="Tail Cost" sortKey="tailCost" sort={sort} onToggle={toggle} />
            <SortTh label="Tail-Adj PnL" sortKey="tailAdjPnl" sort={sort} onToggle={toggle} />
            <SortTh label="Exec 24h" sortKey="execMaker" sort={sort} onToggle={toggle} />
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => {
            const operatorMode = f.state?.runtimeMode ?? "unknown";
            const displayMode = f.state?.effectiveMode ?? operatorMode;
            const isExpanded = expanded === f.familyId;
            return (
              <Fragment key={f.familyId}>
                <tr
                  style={{
                    ...(operatorMode === "quarantine"
                      ? { background: "rgba(239,83,80,0.06)" }
                      : undefined),
                    ...(effectiveScope === "profile" && !isLiveFamily(f)
                      ? { opacity: 0.6 }
                      : undefined),
                    ...(effectiveScope === "all" && meta?.profile != null && !f.deployment?.enabled
                      ? { opacity: 0.45 }
                      : undefined),
                  }}
                  onClick={() => setExpanded(isExpanded ? null : f.familyId)}
                >
                  <td style={{ cursor: "pointer", color: "var(--blue)" }}>
                    {isExpanded ? "\u25BC" : "\u25B6"}{" "}
                    <span data-family-key={f.familyKey}>{f.familyKey}</span>
                    <span style={{ marginLeft: 8 }}>
                      <Badge value={f.liveness ?? "unseen"} type="liveness" />
                    </span>
                  </td>
                  <td>
                    <Badge value={operatorMode} type="mode" />
                    {f.deployment && f.deployment.deploymentStage !== "live" && (
                      <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: 4 }}>
                        {f.deployment.deploymentStage}
                      </span>
                    )}
                    {f.deployment && !f.deployment.enabled && <Badge value="disabled" />}
                    {f.state?.effectiveMode && f.state.effectiveMode !== operatorMode && (
                      <div style={{ fontSize: 10, color: "var(--orange)", marginTop: 2 }}>
                        eff: {displayMode}
                        {f.state.derivedModeReason && ` — ${f.state.derivedModeReason}`}
                      </div>
                    )}
                  </td>
                  <td>
                    {f.promotionState ? <Badge value={f.promotionState} /> : "\u2014"}
                    {f.probeSubstate && (
                      <span
                        className={`badge ${
                          f.probeSubstate === "warming-up"
                            ? "badge-blue"
                            : f.probeSubstate === "retained"
                              ? "badge-orange"
                              : "badge-orange"
                        }`}
                      >
                        {f.probeSubstate}
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      color: f.caps
                        ? utilizationColor(f.state?.openValueUsdc ?? 0, f.caps.maxOpenValueUsdc)
                        : undefined,
                    }}
                  >
                    ${(f.state?.openValueUsdc ?? 0).toFixed(0)}
                    {f.caps && (
                      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                        {" "}
                        / ${f.caps.maxOpenValueUsdc}
                      </span>
                    )}
                  </td>
                  <td>
                    {f.state?.openPositionCount ?? 0}
                    {f.state?.openDustCount ? ` (${f.state.openDustCount} dust)` : ""}
                  </td>
                  <td
                    style={{
                      color: f.caps
                        ? utilizationColor(f.state?.activeMarketCount ?? 0, f.caps.maxActiveMarkets)
                        : undefined,
                    }}
                  >
                    {f.state?.activeMarketCount ?? 0}
                    {f.caps && (
                      <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
                        {" "}
                        / {f.caps.maxActiveMarkets}
                      </span>
                    )}
                  </td>
                  <td style={{ color: "var(--orange)" }}>
                    ${(f.state?.currentTailCostUsdc ?? 0).toFixed(2)}
                  </td>
                  <td
                    style={{
                      color:
                        (f.state?.tailAdjustedPnlLive ?? 0) >= 0 ? "var(--green)" : "var(--red)",
                    }}
                  >
                    {(f.state?.tailAdjustedPnlLive ?? 0) >= 0 ? "+" : ""}$
                    {(f.state?.tailAdjustedPnlLive ?? 0).toFixed(2)}
                  </td>
                  <td>
                    {f.executionTelemetry24h && f.executionTelemetry24h.totalFills > 0 ? (
                      <div>
                        <div style={{ fontWeight: 700, color: "var(--blue)" }}>
                          {formatExecMakerPct(f)}
                        </div>
                        <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
                          {f.executionTelemetry24h.takerFills} taker · $
                          {f.executionTelemetry24h.explicitFeesUsdc.toFixed(3)}
                        </div>
                      </div>
                    ) : (
                      <span style={{ color: "var(--text-dim)" }}>&mdash;</span>
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <FamilyActions familyId={f.familyId} mode={operatorMode} />
                  </td>
                </tr>
                {isExpanded && <FamilyDetail family={f} />}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
