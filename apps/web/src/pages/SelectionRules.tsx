import { useState } from "react";
import {
  useSelectionRules,
  useCreateSelectionRule,
  useUpdateSelectionRule,
  useDeleteSelectionRule,
  useSelectionPreview,
  useSelectionMatch,
  useEventSlugOptions,
  useProfiles,
} from "../api/hooks.ts";
import { Badge } from "../components/Badge.tsx";
import type { SelectionRule, SelectionRuleType } from "../api/types.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ruleTypeBadgeVariant(type: SelectionRuleType): string {
  if (type.startsWith("include")) return "green";
  return "red";
}

function normalizePattern(raw: string): string {
  return raw.trim().toLowerCase();
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
        No selection rules yet. Add one below.
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
  const [ruleType, setRuleType] = useState<SelectionRuleType>("include_prefix");
  const [pattern, setPattern] = useState("");
  const [note, setNote] = useState("");

  const normalized = normalizePattern(pattern);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!normalized) return;
    create.mutate(
      { profileId, ruleType, pattern: normalized, note: note.trim() || null },
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
        <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Type</label>
        <select
          data-testid="rule-type-select"
          value={ruleType}
          onChange={(e) => setRuleType(e.target.value as SelectionRuleType)}
          style={{ fontSize: 12, padding: "4px 8px" }}
        >
          <option value="include_prefix">include_prefix</option>
          <option value="exclude_prefix">exclude_prefix</option>
          <option value="include_slug">include_slug</option>
          <option value="exclude_slug">exclude_slug</option>
        </select>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Pattern</label>
        <input
          data-testid="pattern-input"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          placeholder="bitcoin-"
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

// ─── PreviewPanel ─────────────────────────────────────────────────────────────

interface PreviewPanelProps {
  profileId: string;
}

function PreviewPanel({ profileId }: PreviewPanelProps) {
  const [open, setOpen] = useState(false);
  const preview = useSelectionPreview(profileId);

  const includeCount =
    (preview.data?.matchedInclude.length ?? 0) + (preview.data?.step2FallbackInclude.length ?? 0);
  const excludeCount =
    (preview.data?.matchedExclude.length ?? 0) + (preview.data?.fallbackExclude.length ?? 0);

  return (
    <div style={{ marginTop: 24, border: "1px solid var(--border)", borderRadius: 6 }}>
      <button
        data-testid="preview-toggle"
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          textAlign: "left",
          background: "var(--bg-elevated)",
          border: "none",
          padding: "8px 14px",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          borderRadius: open ? "6px 6px 0 0" : 6,
        }}
      >
        {open ? "▼" : "▶"} Universe Preview
        {preview.data && (
          <span
            style={{ marginLeft: 8, fontWeight: 400, fontSize: 12, color: "var(--text-muted)" }}
          >
            {includeCount} INCLUDE · {excludeCount} EXCLUDE
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: "12px 14px" }}>
          {preview.isLoading && (
            <div style={{ color: "var(--text-dim)", fontSize: 12 }}>Loading preview…</div>
          )}
          {preview.isError && (
            <div style={{ color: "var(--red)", fontSize: 12 }}>
              Failed to load preview: {preview.error.message}
            </div>
          )}
          {preview.data && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <PreviewBucket
                label="Matched Include"
                rows={preview.data.matchedInclude}
                color="var(--green)"
              />
              <PreviewBucket
                label="Step-2 Fallback Include"
                rows={preview.data.step2FallbackInclude}
                color="var(--blue)"
              />
              <PreviewBucket
                label="Matched Exclude"
                rows={preview.data.matchedExclude}
                color="var(--red)"
              />
              <PreviewBucket
                label="Fallback Exclude"
                rows={preview.data.fallbackExclude}
                color="var(--orange)"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewBucket({
  label,
  rows,
  color,
}: {
  label: string;
  rows: Array<{ slug: string; eventSlug: string | null; winningRuleId: string | null }>;
  color: string;
}) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 11, color, marginBottom: 6 }}>
        {label} ({rows.length})
      </div>
      {rows.length === 0 ? (
        <div style={{ color: "var(--text-dim)", fontSize: 11 }}>None</div>
      ) : (
        <ul style={{ margin: 0, padding: "0 0 0 14px", fontSize: 11 }}>
          {rows.map((r) => (
            <li key={r.slug} style={{ fontFamily: "monospace", marginBottom: 2 }}>
              {r.slug}
              {r.winningRuleId && (
                <span style={{ color: "var(--text-dim)", marginLeft: 4 }}>
                  (rule: {r.winningRuleId.slice(0, 8)})
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── MatchDebugger ────────────────────────────────────────────────────────────

interface MatchDebuggerProps {
  profileId: string;
}

function MatchDebugger({ profileId }: MatchDebuggerProps) {
  const [eventSlug, setEventSlug] = useState("");
  const [marketSlug, setMarketSlug] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const eventSlugs = useEventSlugOptions(profileId);

  const match = useSelectionMatch(
    profileId,
    eventSlug,
    marketSlug,
    submitted && marketSlug.length > 0,
  );

  function handleTest(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
  }

  const filteredSlugs =
    eventSlugs.data?.filter((s) => s.toLowerCase().includes(eventSlug.toLowerCase())) ?? [];

  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Match Debugger</div>
      <form
        data-testid="match-debugger-form"
        onSubmit={handleTest}
        style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 4, position: "relative" }}>
          <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Event Slug</label>
          <input
            data-testid="event-slug-input"
            list="event-slugs-list"
            value={eventSlug}
            onChange={(e) => {
              setEventSlug(e.target.value);
              setSubmitted(false);
            }}
            placeholder="bitcoin-price-2026"
            style={{ fontSize: 12, padding: "4px 8px", minWidth: 200 }}
          />
          <datalist id="event-slugs-list">
            {filteredSlugs.slice(0, 20).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 11, color: "var(--text-muted)" }}>Market Slug</label>
          <input
            data-testid="market-slug-input"
            value={marketSlug}
            onChange={(e) => {
              setMarketSlug(e.target.value);
              setSubmitted(false);
            }}
            placeholder="bitcoin-above-100k"
            style={{ fontSize: 12, padding: "4px 8px", minWidth: 200 }}
          />
        </div>
        <button
          data-testid="match-test-button"
          type="submit"
          disabled={!marketSlug}
          style={{
            background: "var(--blue)",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            padding: "5px 14px",
            fontSize: 12,
            cursor: marketSlug ? "pointer" : "not-allowed",
          }}
        >
          Test
        </button>
      </form>
      {submitted && marketSlug && (
        <div style={{ marginTop: 12, fontSize: 12 }}>
          {match.isLoading && <span style={{ color: "var(--text-dim)" }}>Checking…</span>}
          {match.isError && (
            <span style={{ color: "var(--red)" }}>Error: {match.error.message}</span>
          )}
          {match.data && (
            <div data-testid="match-result" style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <span>
                Decision: <Badge value={match.data.decision} />
              </span>
              <span>
                Final Status:{" "}
                <strong
                  style={{
                    color: match.data.finalStatus === "INCLUDE" ? "var(--green)" : "var(--red)",
                  }}
                >
                  {match.data.finalStatus}
                </strong>
              </span>
              {match.data.winningRuleId && (
                <span style={{ color: "var(--text-muted)" }}>
                  Winning rule: {match.data.winningRuleId}
                </span>
              )}
              {match.data.step2Fallback && (
                <span style={{ color: "var(--blue)" }}>Step-2 fallback applied</span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── SelectionRules page ──────────────────────────────────────────────────────

export function SelectionRules() {
  const { data: profilesData } = useProfiles();
  const profiles = profilesData?.profiles ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const profileId = selectedId ?? profiles[0]?.profile_id ?? null;

  const { data: rules = [], isLoading, isError, error } = useSelectionRules(profileId ?? "");

  if (!profileId) {
    return (
      <div className="page">
        <div className="page-title">Selection Rules</div>
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>No profiles available.</div>
      </div>
    );
  }

  if (isLoading) return <div className="page">Loading selection rules…</div>;

  if (isError) {
    return (
      <div className="page">
        <div className="page-title">Selection Rules</div>
        <div data-testid="error-state" style={{ color: "var(--red)", fontSize: 13 }}>
          Failed to load: {error.message}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-title">Selection Rules</div>
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
        Rules are evaluated with specificity-wins logic: exact slug beats prefix; longer prefix
        wins; exclude beats include at the same tier.
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
        Heads up: canonical spec §0 STEP 1 only defines <code>include_prefix</code> seeded with
        three prefixes (bitcoin, ethereum, elon-musk). <code>exclude_prefix</code>,{" "}
        <code>include_slug</code>, <code>exclude_slug</code>, and precedence are operator extensions
        frozen in ADR-004. Review any rule beyond the seeded prefixes before shipping to live-lite.
      </p>

      <RulesTable rules={rules} profileId={profileId} />
      <CreateForm profileId={profileId} />
      <PreviewPanel profileId={profileId} />
      <MatchDebugger profileId={profileId} />
    </div>
  );
}
