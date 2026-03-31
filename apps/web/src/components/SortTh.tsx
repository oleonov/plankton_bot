import type { SortState } from "../utils/useSort.ts";

interface SortThProps {
  label: string;
  sortKey: string;
  sort: SortState;
  onToggle: (key: string) => void;
}

export function SortTh({ label, sortKey, sort, onToggle }: SortThProps) {
  const active = sort?.key === sortKey;
  return (
    <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => onToggle(sortKey)}>
      {label}
      {active && (sort.dir === "asc" ? " \u25B2" : " \u25BC")}
    </th>
  );
}
