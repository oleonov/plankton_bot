import { useState } from "react";

export type SortDir = "asc" | "desc";
export type SortState<K extends string = string> = { key: K; dir: SortDir } | null;

export function useSort<K extends string>() {
  const [sort, setSort] = useState<SortState<K>>(null);

  const toggle = (key: K) => {
    setSort((prev) => {
      if (prev?.key === key) return prev.dir === "asc" ? { key, dir: "desc" } : null;
      return { key, dir: "asc" };
    });
  };

  return { sort, toggle } as const;
}

export function sortItems<T>(
  items: T[],
  sort: SortState,
  accessors: Record<string, (item: T) => string | number | null | undefined>,
): T[] {
  if (!sort) return items;
  const accessor = accessors[sort.key];
  if (!accessor) return items;
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const va = accessor(a);
    const vb = accessor(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
}
