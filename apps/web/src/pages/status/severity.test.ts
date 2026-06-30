import { describe, expect, it } from "vitest";
import type { Sev, SystemHealthData } from "../../api/types.ts";
import { analyze } from "./severity.ts";

function base(): SystemHealthData {
  const mod = (nm: string, s: Sev = "ok"): SystemHealthData["modules"][number] => ({
    nm,
    s,
    since: "4d 6h",
    detail: "ok",
    hist: [],
  });
  const res = (nm: string, val: number): SystemHealthData["resources"][number] => ({
    nm,
    val,
    max: 100,
    unit: "% used",
    sub: ["", ""],
    good: "low",
  });
  return {
    version: "v61",
    deploy: "now",
    sha: "abc",
    dirty: false,
    tradingState: "RUNNING",
    paused: false,
    pauseReason: null,
    uptimePct: 100,
    uptodayHist: [],
    marketDataStale: false,
    reconDrift: false,
    modules: [
      mod("scanner"),
      mod("market data"),
      mod("strategy"),
      mod("risk"),
      mod("execution"),
      mod("reconciliation"),
      mod("redeem"),
      mod("manager / API"),
    ],
    resources: [res("Disk · krabs-data", 62), res("Memory", 61)],
    deps: [{ nm: "CLOB API", s: "ok", lat: 100, err: 0, hist: [] }],
    errors: {
      l50_1h: 0,
      l60_1h: 0,
      l50_24h: 0,
      l60_24h: 0,
      breakers: "closed",
      hist: [],
      top: [],
    },
    db: {
      ledger: 1,
      control: 1,
      wal: 1,
      locked: 0,
      migration: "applied",
      retention: "ok",
      acctWarnings: 0,
      unknownAcct: 0,
      lastVacuum: "n/a",
    },
    shadow: [],
  };
}

describe("status severity model", () => {
  it("a clean state is OK with an empty problem list", () => {
    const { global, probs } = analyze(base());
    expect(global).toBe("ok");
    expect(probs).toHaveLength(0);
  });

  it("paused bot is CRITICAL and PAUSED is the first problem", () => {
    const d = base();
    d.paused = true;
    d.pauseReason = "risk circuit breaker";
    const { global, probs } = analyze(d);
    expect(global).toBe("crit");
    expect(probs[0]?.sev).toBe("crit");
    expect(probs[0]?.msg).toContain("PAUSED");
  });

  it("accounting warnings raise WARNING", () => {
    const d = base();
    d.db.acctWarnings = 2;
    const { global, probs } = analyze(d);
    expect(global).toBe("warn");
    expect(probs.some((p) => p.sev === "warn" && /accounting warning/.test(p.msg))).toBe(true);
  });

  it("stale market data (crit module) raises CRITICAL", () => {
    const d = base();
    d.marketDataStale = true;
    const market = d.modules.find((m) => m.nm === "market data")!;
    market.s = "crit";
    market.detail = "STALE";
    const { global, probs } = analyze(d);
    expect(global).toBe("crit");
    expect(probs.some((p) => p.sev === "crit" && /market data/.test(p.msg))).toBe(true);
  });

  it("reconciliation drift (crit module) raises CRITICAL", () => {
    const d = base();
    d.reconDrift = true;
    const recon = d.modules.find((m) => m.nm === "reconciliation")!;
    recon.s = "crit";
    recon.detail = "drift detected";
    const { global } = analyze(d);
    expect(global).toBe("crit");
  });

  it("a circuit breaker open raises CRITICAL", () => {
    const d = base();
    d.errors.breakers = "1 open";
    const { global, sections } = analyze(d);
    expect(global).toBe("crit");
    expect(sections.errors).toBe("crit");
  });

  it("disk >=90% used is CRITICAL via the resources band", () => {
    const d = base();
    d.resources[0]!.val = 92;
    const { global, sections } = analyze(d);
    expect(sections.resources).toBe("crit");
    expect(global).toBe("crit");
  });

  it("invariant: hero color and problem list never disagree", () => {
    const states: SystemHealthData[] = [
      base(),
      (() => {
        const d = base();
        d.paused = true;
        return d;
      })(),
      (() => {
        const d = base();
        d.db.acctWarnings = 1;
        return d;
      })(),
      (() => {
        const d = base();
        d.modules[1]!.s = "crit";
        return d;
      })(),
    ];
    for (const d of states) {
      const { global, probs } = analyze(d);
      if (global === "ok") expect(probs).toHaveLength(0);
      else expect(probs.length).toBeGreaterThan(0);
    }
  });
});
