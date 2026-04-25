import { useCallback, useMemo, useState } from "react";
import { useAllPositions } from "../../api/hooks.ts";
import type { PositionDTO } from "../../api/types.ts";
import { Pagination } from "../../components/Pagination.tsx";
import { GroupHeader } from "./GroupHeader.tsx";
import {
  countsByPhase,
  deriveMarketState,
  groupPositions,
  matchesSearch,
  type PhaseFilter,
} from "./lib.ts";
import { PositionDrawer } from "./PositionDrawer.tsx";
import { PositionRow } from "./PositionRow.tsx";
import { PositionsToolbar } from "./PositionsToolbar.tsx";
import { useTweaks } from "./useTweaks.ts";
import type { Density } from "./lib.ts";
import "./positions.css";

const PAGE_SIZE = 50;

// Display knobs locked to the operator-approved layout. They used to live in a
// floating Tweaks panel — that surface was removed; only the toolbar-driven
// prefs (groupBy, hideClosed, hideDust) remain user-configurable.
const ROW_DENSITY: Density = "spacious";
const SHOW_PHASE_BUY_COUNT = false;
const SHOW_PNL_PERCENT = true;

export function PositionsPage() {
  const [tweaks, updateTweak] = useTweaks();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PhaseFilter>("all");
  const [selected, setSelected] = useState<PositionDTO | null>(null);
  const [page, setPage] = useState(1);

  const resetPage = useCallback(() => setPage(1), []);

  const { data, isLoading } = useAllPositions();
  const rows = useMemo<PositionDTO[]>(() => data?.items ?? [], [data]);
  const truncated = data?.truncated ?? false;

  const counts = useMemo(() => countsByPhase(rows), [rows]);

  const filtered = useMemo(() => {
    let out = rows;
    if (tweaks.hideClosedByDefault) {
      out = out.filter((p) => deriveMarketState(p.status) !== "closed");
    }
    if (tweaks.hideDust) {
      out = out.filter((p) => p.status !== "dust");
    }
    if (filter !== "all") {
      out = out.filter((p) => p.phase === filter);
    }
    if (query.trim()) {
      out = out.filter((p) => matchesSearch(p, query));
    }
    return out;
  }, [rows, tweaks.hideClosedByDefault, tweaks.hideDust, filter, query]);

  const filteredCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(filteredCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageSlice = useMemo(
    () => filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filtered, safePage],
  );

  const groups = useMemo(
    () => groupPositions(pageSlice, tweaks.groupBy),
    [pageSlice, tweaks.groupBy],
  );

  const pageStart = filteredCount > 0 ? (safePage - 1) * PAGE_SIZE + 1 : 0;
  const pageEnd = pageStart + pageSlice.length - 1;
  const pageInfo =
    filteredCount > 0 ? `${pageStart}\u2013${pageEnd} of ${filteredCount}` : undefined;

  return (
    <div className="positions-v2" data-testid="positions-v2">
      <div className="p2-head">
        <h1>Positions</h1>
        <span className="p2-count">({rows.length})</span>
      </div>

      <PositionsToolbar
        query={query}
        onQueryChange={(v) => {
          setQuery(v);
          resetPage();
        }}
        filter={filter}
        onFilterChange={(v) => {
          setFilter(v);
          resetPage();
        }}
        counts={counts}
        hideClosed={tweaks.hideClosedByDefault}
        onHideClosedChange={(v) => {
          updateTweak({ hideClosedByDefault: v });
          resetPage();
        }}
        hideDust={tweaks.hideDust}
        onHideDustChange={(v) => {
          updateTweak({ hideDust: v });
          resetPage();
        }}
        groupBy={tweaks.groupBy}
        onGroupByChange={(v) => updateTweak({ groupBy: v })}
      />

      {truncated ? (
        <div
          className="p2-truncation-notice"
          data-testid="positions-truncated-notice"
          role="status"
        >
          Showing the first 10,000 positions. Additional rows are hidden — narrow filters or contact
          support if your ledger exceeds this cap.
        </div>
      ) : null}

      <div className="p2-tablewrap">
        {isLoading ? (
          <div className="p2-loading">Loading…</div>
        ) : (
          <table className="p2-table">
            <thead>
              <tr>
                <th style={{ width: 4, padding: 0 }} aria-hidden="true" />
                <th className="l">Market</th>
                <th className="l">Phase</th>
                <th className="l">Last action</th>
                <th>Size · Basis</th>
                <th>Value</th>
                <th>PnL</th>
                <th className="l">Market state</th>
                <th>Ends</th>
              </tr>
            </thead>
            <tbody>
              {groups.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p2-empty-table">
                    {rows.length === 0
                      ? "No positions."
                      : "No positions match the current filters."}
                  </td>
                </tr>
              ) : (
                groups.map((g) => (
                  <GroupFragment
                    key={g.key}
                    label={g.key}
                    items={g.items}
                    density={ROW_DENSITY}
                    showBuys={SHOW_PHASE_BUY_COUNT}
                    showPct={SHOW_PNL_PERCENT}
                    selectedId={selected?.positionId ?? null}
                    onSelect={setSelected}
                  />
                ))
              )}
            </tbody>
          </table>
        )}
      </div>

      <Pagination
        page={safePage}
        totalPages={totalPages}
        onPageChange={setPage}
        pageInfo={pageInfo}
      />

      <PositionDrawer position={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

interface GroupFragmentProps {
  label: string;
  items: PositionDTO[];
  density: Density;
  showBuys: boolean;
  showPct: boolean;
  selectedId: string | null;
  onSelect: (p: PositionDTO) => void;
}

function GroupFragment({
  label,
  items,
  density,
  showBuys,
  showPct,
  selectedId,
  onSelect,
}: GroupFragmentProps) {
  return (
    <>
      <GroupHeader label={label} count={items.length} />
      {items.map((p) => (
        <PositionRow
          key={p.positionId}
          position={p}
          density={density}
          selected={selectedId === p.positionId}
          showBuys={showBuys}
          showPct={showPct}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}
