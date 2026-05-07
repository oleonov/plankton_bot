import { useState } from "react";
import {
  useSelectionRules,
  useCreateSelectionRule,
  useUpdateSelectionRule,
  useDeleteSelectionRule,
  useProfiles,
} from "../api/hooks.ts";
import type { SelectionRule, SelectionRuleType } from "../api/types.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ruleTypeBadgeVariant(type: SelectionRuleType): string {
  if (type.startsWith("include")) return "green";
  return "red";
}

function normalizePattern(raw: string): string {
  return raw.trim().toLowerCase();
}

function isManualExclusionRule(rule: SelectionRule): boolean {
  return rule.ruleType === "exclude_slug";
}

// ─── RulesTable ──────────────────────────────────────────────────────────────

interface RulesTableProps {
  rules: SelectionRule[];
  profileId: string;
}

function RulesTable({ rules, profileId }: RulesTableProps) {
  const update = useUpdateSelectionRule();
  const remove = useDeleteSelectionRule();

  function handleToggle(rule: SelectionRule) {
    update.mutate({ ruleId: rule.ruleId, profileId, patch: { enabled: !rule.enabled } });
  }

  function handleDelete(rule: SelectionRule) {
    if (!window.confirm(`Delete rule "${rule.pattern}"?`)) return;
    remove.mutate({ ruleId: rule.ruleId, profileId });
  }

  if (rules.length === 0) {
    return (
      <div
        data-testid="rules-empty"
        style={{ color: "var(--text-dim)", fontSize: 13, padding: "16px 0" }}
      >
        No manual market exclusions yet. Add one below.
      </div>
    );
  }

  return (
    <table data-testid="rules-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Pattern</th>
          <th>Enabled</th>
          <th>Note</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rules.map((rule) => (
          <tr key={rule.ruleId} data-testid={`rule-row-${rule.ruleId}`}>
            <td>
              <span
                className={`badge badge-${ruleTypeBadgeVariant(rule.ruleType)}`}
                style={{ fontFamily: "monospace", fontSize: 11 }}
              >
                {rule.ruleType}
              </span>
            </td>
            <td style={{ fontFamily: "monospace", fontSize: 12 }}>{rule.pattern}</td>
            <td>
              <button
                data-testid={`toggle-${rule.ruleId}`}
                onClick={() => handleToggle(rule)}
                disabled={update.isPending}
                style={{
                  background: rule.enabled ? "var(--green)" : "var(--bg-elevated)",
                  color: rule.enabled ? "#fff" : "var(--text-dim)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "2px 10px",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                {rule.enabled ? "Enabled" : "Disabled"}
              </button>
            </td>
            <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{rule.note ?? "—"}</td>
            <td>
              <button
                data-testid={`delete-${rule.ruleId}`}
                onClick={() => handleDelete(rule)}
                disabled={remove.isPending}
                style={{
                  background: "var(--red)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 4,
                  padding: "2px 8px",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── CreateForm ───────────────────────────────────────────────────────────────

interface CreateFormProps {
  profileId: string;
}

function CreateForm({ profileId }: CreateFormProps) {
  const create = useCreateSelectionRule();
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");

  const normalized = normalizePattern(pattern);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!normalized) return;
    create.mutate(
      { profileId, ruleType: "exclude_slug", pattern: normalized, note: note.trim() || null },
      {
        onSuccess: () => {
          setPattern("");
          setNote("");
        },
      },
    );
  }

  return (
    <form
      data-testid="create-form"
      onSubmit={handleSubmit}
      style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 16 }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Market Slug</label>
        <input
          data-testid="pattern-input"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="bitcoin-to-150k-by-2026"
          style={{ fontSize: 12, padding: "4px 8px", minWidth: 160 }}
        />
        {normalized && pattern !== normalized && (
          <span data-testid="normalized-preview" style={{ fontSize: 10, color: "var(--text-dim)" }}>
            normalized: {normalized}
          </span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Note</label>
        <input
          data-testid="note-input"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note"
          style={{ fontSize: 12, padding: "4px 8px", minWidth: 160 }}
        />
      </div>
      <button
        data-testid="submit-create"
        type="submit"
        disabled={!normalized || create.isPending}
        style={{
          background: "var(--blue)",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          padding: "5px 14px",
          fontSize: 12,
          cursor: normalized ? "pointer" : "not-allowed",
        }}
      >
        {create.isPending ? "Adding…" : "Add Rule"}
      </button>
      {create.isError && (
        <span style={{ color: "var(--red)", fontSize: 12 }}>{create.error.message}</span>
      )}
    </form>
  );
}

// ─── SelectionRules page ──────────────────────────────────────────────────────

export function SelectionRules() {
  const { data: profilesData } = useProfiles();
  const profiles = profilesData?.profiles ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const profileId = selectedId ?? profiles[0]?.profile_id ?? null;

  const { data: rules = [], isLoading, isError, error } = useSelectionRules(profileId ?? "");
  const exclusionRules = rules.filter(isManualExclusionRule);

  if (!profileId) {
    return (
      <div className="page">
        <div className="page-title">Market Exclusions</div>
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>No profiles available.</div>
      </div>
    );
  }

  if (isLoading) return <div className="page">Loading selection rules…</div>;

  if (isError) {
    return (
      <div className="page">
        <div className="page-title">Market Exclusions</div>
        <div data-testid="error-state" style={{ color: "var(--red)", fontSize: 13 }}>
          Failed to load: {error.message}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-title">Market Exclusions</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 8px" }}>
        <label
          htmlFor="selection-rules-profile"
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          Profile:
        </label>
        <select
          id="selection-rules-profile"
          value={profileId}
          onChange={(e) => setSelectedId(e.target.value)}
          style={{ fontFamily: "monospace", fontSize: 12 }}
        >
          {profiles.map((p) => (
            <option key={p.profile_id} value={p.profile_id}>
              {p.display_name ?? p.profile_id}
            </option>
          ))}
        </select>
      </div>
      <p style={{ color: "var(--text-muted)", fontSize: 12, margin: "0 0 8px" }}>
        v5.11 admission is driven by hard filters and watch-set tracking. This page is only a manual
        deny-list for individual market slugs.
      </p>
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: 12,
          margin: "0 0 16px",
          padding: "6px 8px",
          border: "1px solid var(--border-dim)",
          borderRadius: 4,
        }}
      >
        Hard filters: mid price below the policy ceiling, liquidity at or above the policy floor,
        and not in the v5.11/R9 zero-coverage category blacklist.
      </p>

      <RulesTable rules={exclusionRules} profileId={profileId} />
      <CreateForm profileId={profileId} />
    </div>
  );
}
