import { describe, it, expect } from "vitest";
import {
  STATUS_SERIES,
  STATUS_SEV_RANK,
  worstStatusSev,
  type StatusSev,
} from "./status-health.js";

describe("status-health shared helper", () => {
  it("ranks ok < warn < crit", () => {
    expect(STATUS_SEV_RANK.ok).toBeLessThan(STATUS_SEV_RANK.warn);
    expect(STATUS_SEV_RANK.warn).toBeLessThan(STATUS_SEV_RANK.crit);
  });

  it("worstStatusSev returns the highest-rank severity", () => {
    expect(worstStatusSev([])).toBe("ok");
    expect(worstStatusSev(["ok", "ok"])).toBe("ok");
    expect(worstStatusSev(["ok", "warn"])).toBe("warn");
    expect(worstStatusSev(["warn", "crit", "ok"])).toBe("crit");
  });

  it("exposes a closed, deduped series enum with uptime + 8 modules", () => {
    expect(STATUS_SERIES).toContain("uptime");
    const modules = STATUS_SERIES.filter((s) => s.startsWith("module:"));
    expect(modules).toHaveLength(8);
    expect(new Set(STATUS_SERIES).size).toBe(STATUS_SERIES.length);
  });

  it("covers every severity in the rank map", () => {
    const all: StatusSev[] = ["ok", "warn", "crit"];
    for (const s of all) expect(typeof STATUS_SEV_RANK[s]).toBe("number");
  });
});
