import { describe, it, expect } from "vitest";
import { sortItems, type SortState } from "../../utils/useSort.ts";

interface Item {
  name: string;
  value: number;
  label: string | null;
}

const accessors: Record<string, (i: Item) => string | number | null> = {
  name: (i) => i.name,
  value: (i) => i.value,
  label: (i) => i.label,
};

const items: Item[] = [
  { name: "banana", value: 30, label: "B" },
  { name: "apple", value: 10, label: null },
  { name: "cherry", value: 20, label: "A" },
];

describe("sortItems", () => {
  it("returns original order when sort is null", () => {
    expect(sortItems(items, null, accessors)).toBe(items);
  });

  it("sorts strings ascending", () => {
    const sort: SortState = { key: "name", dir: "asc" };
    const result = sortItems(items, sort, accessors);
    expect(result.map((i) => i.name)).toEqual(["apple", "banana", "cherry"]);
  });

  it("sorts strings descending", () => {
    const sort: SortState = { key: "name", dir: "desc" };
    const result = sortItems(items, sort, accessors);
    expect(result.map((i) => i.name)).toEqual(["cherry", "banana", "apple"]);
  });

  it("sorts numbers ascending", () => {
    const sort: SortState = { key: "value", dir: "asc" };
    const result = sortItems(items, sort, accessors);
    expect(result.map((i) => i.value)).toEqual([10, 20, 30]);
  });

  it("sorts numbers descending", () => {
    const sort: SortState = { key: "value", dir: "desc" };
    const result = sortItems(items, sort, accessors);
    expect(result.map((i) => i.value)).toEqual([30, 20, 10]);
  });

  it("pushes nulls to the end regardless of direction", () => {
    const asc: SortState = { key: "label", dir: "asc" };
    const desc: SortState = { key: "label", dir: "desc" };
    expect(sortItems(items, asc, accessors).map((i) => i.label)).toEqual(["A", "B", null]);
    expect(sortItems(items, desc, accessors).map((i) => i.label)).toEqual(["B", "A", null]);
  });

  it("does not mutate the original array", () => {
    const sort: SortState = { key: "value", dir: "asc" };
    const original = [...items];
    sortItems(items, sort, accessors);
    expect(items).toEqual(original);
  });

  it("returns original when sort key is unknown", () => {
    const sort: SortState = { key: "unknown", dir: "asc" };
    expect(sortItems(items, sort, accessors)).toBe(items);
  });
});
