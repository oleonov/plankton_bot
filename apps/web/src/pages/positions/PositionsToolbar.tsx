import type { PhaseFilter, GroupBy } from "./lib.ts";

interface Props {
  query: string;
  onQueryChange: (v: string) => void;
  filter: PhaseFilter;
  onFilterChange: (v: PhaseFilter) => void;
  counts: Record<PhaseFilter, number>;
  hideClosed: boolean;
  onHideClosedChange: (v: boolean) => void;
  hideDust: boolean;
  onHideDustChange: (v: boolean) => void;
  groupBy: GroupBy;
  onGroupByChange: (v: GroupBy) => void;
}

const CHIPS: Array<{ key: PhaseFilter; label: string; state?: string }> = [
  { key: "all", label: "All" },
  { key: "S1", label: "First", state: "S1" },
  { key: "S2", label: "Accum.", state: "S2" },
  { key: "S3", label: "Distrib.", state: "S3" },
  { key: "S0", label: "Idle", state: "S0" },
];

export function PositionsToolbar({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  counts,
  hideClosed,
  onHideClosedChange,
  hideDust,
  onHideDustChange,
  groupBy,
  onGroupByChange,
}: Props) {
  return (
    <div className="p2-toolbar">
      <div className="p2-search">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <input
          aria-label="Search positions"
          placeholder="search market or id…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
      </div>

      <div className="p2-chipgroup" role="tablist" aria-label="Phase filter">
        {CHIPS.map((c) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={filter === c.key}
            data-state={c.state}
            className={"p2-chip " + (filter === c.key ? "on" : "")}
            onClick={() => onFilterChange(c.key)}
          >
            {c.state ? <i className="p2-dot" aria-hidden="true" /> : null}
            {c.label}
            <span className="p2-n">{counts[c.key] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="p2-divider" aria-hidden="true" />

      <label className="p2-toggle">
        <input
          type="checkbox"
          checked={hideClosed}
          onChange={(e) => onHideClosedChange(e.target.checked)}
        />
        Hide closed
      </label>
      <label className="p2-toggle">
        <input
          type="checkbox"
          checked={hideDust}
          onChange={(e) => onHideDustChange(e.target.checked)}
        />
        Hide dust
      </label>

      <div style={{ flex: 1 }} />

      <select
        className="p2-sortsel"
        aria-label="Group by"
        value={groupBy}
        onChange={(e) => onGroupByChange(e.target.value as GroupBy)}
      >
        <option value="lastAction">Group: Last action</option>
        <option value="phase">Group: Phase (S0–S3)</option>
        <option value="pnl">Group: PnL</option>
        <option value="ends">Group: Ends</option>
        <option value="none">Group: No Group</option>
      </select>
    </div>
  );
}
