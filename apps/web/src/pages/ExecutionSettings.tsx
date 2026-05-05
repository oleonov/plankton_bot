import { useState } from "react";
import { useProfiles, useExecutionPolicy, useUpdateExecutionPolicy } from "../api/hooks.ts";
import type {
  DeadSideGuardMode,
  ExecutionPolicyDTO,
  PricingMode,
  PricingOneSidedPolicy,
  PricingSpreadPolicy,
} from "../api/types.ts";

function numOr(value: string, fallback: number): number {
  if (value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function ExecutionPolicyForm({ profileId }: { profileId: string }) {
  const { data, isLoading, dataUpdatedAt } = useExecutionPolicy(profileId);
  const update = useUpdateExecutionPolicy(profileId);

  if (isLoading || !data) return <div style={{ fontSize: 12, padding: 16 }}>Loading...</div>;

  return (
    <ExecutionPolicyFormInner
      key={dataUpdatedAt}
      policy={data.policy}
      version={data.version}
      issues={data.issues}
      update={update}
    />
  );
}

function ExecutionPolicyFormInner({
  policy,
  version,
  issues,
  update,
}: {
  policy: ExecutionPolicyDTO;
  version: number;
  issues: string[];
  update: ReturnType<typeof useUpdateExecutionPolicy>;
}) {
  const [entryPriceCeiling, setEntryPriceCeiling] = useState(policy.entryPriceCeiling.toString());
  const [exitOrderTtlMs, setExitOrderTtlMs] = useState(policy.exitOrderTtlMs.toString());
  const [entryMinMarketAge, setEntryMinMarketAge] = useState(
    policy.entryMinMarketAgeSeconds.toString(),
  );

  const [dsgMode, setDsgMode] = useState<DeadSideGuardMode>(policy.deadSideGuard.mode);
  const [dsgAskCeiling, setDsgAskCeiling] = useState(policy.deadSideGuard.askCeiling.toString());
  const [dsgMaxTime, setDsgMaxTime] = useState(policy.deadSideGuard.maxTimeToEndMs.toString());

  const [pricingMode, setPricingMode] = useState<PricingMode>(policy.pricing.mode);
  const [maxEntrySpread, setMaxEntrySpread] = useState(
    policy.pricing.maxEntrySpreadTicks.toString(),
  );
  const [maxExitSpread, setMaxExitSpread] = useState(policy.pricing.maxExitSpreadTicks.toString());
  const [maxImprovement, setMaxImprovement] = useState(
    policy.pricing.maxImprovementTicks.toString(),
  );
  const [wideSpread, setWideSpread] = useState<PricingSpreadPolicy>(
    policy.pricing.wideSpreadPolicy,
  );
  const [oneSided, setOneSided] = useState<PricingOneSidedPolicy>(policy.pricing.oneSidedPolicy);

  const [deadSideCanary, setDeadSideCanary] = useState(policy.telemetry.deadSideCanary);
  const [pricingShadow, setPricingShadow] = useState(policy.telemetry.pricingShadow);

  const handleSave = () => {
    const next: ExecutionPolicyDTO = {
      version: 1,
      entryPriceCeiling: numOr(entryPriceCeiling, policy.entryPriceCeiling),
      exitOrderTtlMs: numOr(exitOrderTtlMs, policy.exitOrderTtlMs),
      entryMinMarketAgeSeconds: numOr(entryMinMarketAge, policy.entryMinMarketAgeSeconds),
      deadSideGuard: {
        mode: dsgMode,
        askCeiling: numOr(dsgAskCeiling, policy.deadSideGuard.askCeiling),
        maxTimeToEndMs: numOr(dsgMaxTime, policy.deadSideGuard.maxTimeToEndMs),
      },
      pricing: {
        mode: pricingMode,
        maxEntrySpreadTicks: numOr(maxEntrySpread, policy.pricing.maxEntrySpreadTicks),
        maxExitSpreadTicks: numOr(maxExitSpread, policy.pricing.maxExitSpreadTicks),
        maxImprovementTicks: numOr(maxImprovement, policy.pricing.maxImprovementTicks),
        wideSpreadPolicy: wideSpread,
        oneSidedPolicy: oneSided,
      },
      telemetry: { deadSideCanary, pricingShadow },
    };
    update.mutate(next);
  };

  const errorMessage =
    update.isError && update.error instanceof Error ? update.error.message : null;

  return (
    <div className="card">
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 10 }}>
        Version {version} · Stored as <code>profile_settings.execution_policy_json</code>. Runtime
        hot-reloads on save — no restart required.
      </div>

      {issues.length > 0 && (
        <div
          style={{
            padding: "6px 10px",
            marginBottom: 10,
            fontSize: 11,
            background: "var(--bg-warning, #3a2f00)",
            color: "var(--yellow, #d4b000)",
            borderRadius: 3,
          }}
        >
          Stored JSON has validation issues — using defaults for invalid fields:
          <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
            {issues.map((i, idx) => (
              <li key={idx}>{i}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="settings-form">
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 4,
          }}
        >
          Entry / Exit
        </div>
        <div className="form-field">
          <label>Entry Price Ceiling (0.05 – 0.99)</label>
          <input
            type="number"
            step="0.01"
            value={entryPriceCeiling}
            onChange={(e) => setEntryPriceCeiling(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>Exit Order TTL (ms, 10 000 – 3 600 000)</label>
          <input
            type="number"
            value={exitOrderTtlMs}
            onChange={(e) => setExitOrderTtlMs(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>Min Market Age before first BUY (s, 0 – 172 800)</label>
          <input
            type="number"
            value={entryMinMarketAge}
            onChange={(e) => setEntryMinMarketAge(e.target.value)}
          />
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
            Spec §1.7 R1 floor: 2 504 s. <code>0</code> disables the gate (sim only).
          </div>
        </div>

        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 12,
          }}
        >
          Dead-Side Guard
        </div>
        <div className="form-field">
          <label>Mode</label>
          <select value={dsgMode} onChange={(e) => setDsgMode(e.target.value as DeadSideGuardMode)}>
            <option value="observe">observe (log only)</option>
            <option value="enforce">enforce (block entries)</option>
            <option value="off">off</option>
          </select>
        </div>
        <div className="form-field">
          <label>Ask Ceiling (≤ 0.20)</label>
          <input
            type="number"
            step="0.01"
            value={dsgAskCeiling}
            onChange={(e) => setDsgAskCeiling(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>Max Time To End (ms)</label>
          <input type="number" value={dsgMaxTime} onChange={(e) => setDsgMaxTime(e.target.value)} />
        </div>

        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 12,
          }}
        >
          Pricing (ADR-014)
        </div>
        <div className="form-field">
          <label>Mode</label>
          <select
            value={pricingMode}
            onChange={(e) => setPricingMode(e.target.value as PricingMode)}
          >
            <option value="edge">edge (ADR-006 D1, bestBid for BUY / bestAsk for SELL)</option>
            <option value="bounded-midpoint">bounded-midpoint (ADR-014)</option>
          </select>
        </div>
        <div className="form-field">
          <label>Max Entry Spread (ticks)</label>
          <input
            type="number"
            value={maxEntrySpread}
            onChange={(e) => setMaxEntrySpread(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>Max Exit Spread (ticks)</label>
          <input
            type="number"
            value={maxExitSpread}
            onChange={(e) => setMaxExitSpread(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>Max Improvement (ticks)</label>
          <input
            type="number"
            value={maxImprovement}
            onChange={(e) => setMaxImprovement(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label>Wide Spread Policy</label>
          <select
            value={wideSpread}
            onChange={(e) => setWideSpread(e.target.value as PricingSpreadPolicy)}
          >
            <option value="edge">edge (fall back to edge price)</option>
            <option value="skip">skip</option>
          </select>
        </div>
        <div className="form-field">
          <label>One-Sided Book Policy</label>
          <select
            value={oneSided}
            onChange={(e) => setOneSided(e.target.value as PricingOneSidedPolicy)}
          >
            <option value="edge">edge (fall back to edge price)</option>
            <option value="skip">skip</option>
          </select>
        </div>

        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginTop: 12,
          }}
        >
          Telemetry
        </div>
        <div className="form-field">
          <label>
            <input
              type="checkbox"
              checked={deadSideCanary}
              onChange={(e) => setDeadSideCanary(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Dead-side canary (shadow observations)
          </label>
        </div>
        <div className="form-field">
          <label>
            <input
              type="checkbox"
              checked={pricingShadow}
              onChange={(e) => setPricingShadow(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Pricing shadow (bounded-midpoint canary)
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <button className="btn-success" onClick={handleSave} disabled={update.isPending}>
            {update.isPending ? "Saving..." : "Save"}
          </button>
          {update.isSuccess && (
            <span style={{ marginLeft: 8, color: "var(--green)", fontSize: 11 }}>Saved</span>
          )}
          {errorMessage && (
            <span style={{ marginLeft: 8, color: "var(--red)", fontSize: 11 }}>{errorMessage}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function ExecutionSettings() {
  const { data } = useProfiles();
  const profiles = data?.profiles ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeId = selectedId ?? profiles[0]?.profile_id ?? null;

  return (
    <div className="page">
      <div className="page-title">Execution Settings</div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
        ADR-015. Dead-side guard, bounded-midpoint pricing, entry ceiling, exit TTL — per profile.
        Runtime polls for updates; changes take effect within seconds without a restart.
      </p>
      <div className="profile-tabs">
        {profiles.map((p) => (
          <button
            key={p.profile_id}
            className={`profile-tab ${activeId === p.profile_id ? "active" : ""}`}
            onClick={() => setSelectedId(p.profile_id)}
          >
            {p.display_name}
          </button>
        ))}
      </div>
      {activeId && <ExecutionPolicyForm profileId={activeId} />}
    </div>
  );
}
