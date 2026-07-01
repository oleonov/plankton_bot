/**
 * Status-screen severity model — the single source of truth for the hero color
 * AND the hero problem list. Both are derived here so they can never disagree
 * (the invariant: a clean problem list must render an OK hero). Ported from the
 * design prototype `analyze()` / `resSev()`; thresholds live only here.
 */
import { STATUS_SEV_RANK, worstStatusSev } from "@krabs/domain";
import type { Sev, SystemHealthData, SystemHealthResource } from "../../api/types.ts";

// Rank order + worst-of-many come from @krabs/domain so the client severity model
// and the server-side StatusHistorySampler can never drift.
const RANK = STATUS_SEV_RANK;

export function worst(arr: Sev[]): Sev {
  return worstStatusSev(arr);
}

export const SEV_WORD: Record<Sev, "OK" | "WARNING" | "CRITICAL"> = {
  ok: "OK",
  warn: "WARNING",
  crit: "CRITICAL",
};

/** Severity of a single resource gauge from its value/threshold band. */
export function resSev(r: SystemHealthResource): Sev {
  const pct = (r.val / r.max) * 100;
  if (r.good === "low") return pct >= 90 ? "crit" : pct >= 75 ? "warn" : "ok";
  return pct <= 10 ? "crit" : pct <= 25 ? "warn" : "ok";
}

export interface Problem {
  sev: "crit" | "warn";
  msg: string;
}

export interface Analysis {
  global: Sev;
  sections: Record<"modules" | "resources" | "deps" | "errors" | "db", Sev>;
  probs: Problem[];
}

export function analyze(d: SystemHealthData): Analysis {
  const probs: Problem[] = [];

  // modules
  for (const m of d.modules) {
    if (m.s === "crit") probs.push({ sev: "crit", msg: `${m.nm} — ${m.detail}` });
    else if (m.s === "warn") probs.push({ sev: "warn", msg: `${m.nm} degraded — ${m.detail}` });
  }
  // Pause is an intentional operator state, not an outage — it is surfaced as a
  // distinct amber "PAUSED" hero, not a crit problem, so it must NOT force crit here.

  // resources
  for (const r of d.resources) {
    const s = resSev(r);
    const unit = r.unit.includes("%") ? "%" : ` ${r.unit}`;
    if (s === "crit") probs.push({ sev: "crit", msg: `${r.nm} critical — ${r.val}${unit}` });
    else if (s === "warn") probs.push({ sev: "warn", msg: `${r.nm} high — ${r.val}${unit}` });
  }

  // deps — `err` may be null (unmeasured); never print a fabricated 0.
  for (const x of d.deps) {
    const errTxt = x.err === null ? "n/a" : `${x.err}%`;
    if (x.s === "crit") probs.push({ sev: "crit", msg: `${x.nm} down — ${errTxt} errors` });
    else if (x.s === "warn")
      probs.push({ sev: "warn", msg: `${x.nm} degraded — ${x.lat ?? "—"}ms · ${errTxt}` });
  }

  // errors
  if (d.errors.breakers !== "closed")
    probs.push({ sev: "crit", msg: `Circuit breaker ${d.errors.breakers}` });
  if (d.errors.l60_1h > 0)
    probs.push({ sev: "warn", msg: `${d.errors.l60_1h} level-60 error(s) in last 1h` });

  // db — only MEASURED values raise problems; unknown (null) never claims health.
  if (typeof d.db.locked === "number" && d.db.locked >= 4)
    probs.push({ sev: "crit", msg: `SQLite locked/busy ×${d.db.locked}` });
  if (typeof d.db.acctWarnings === "number" && d.db.acctWarnings > 0)
    probs.push({ sev: "warn", msg: `${d.db.acctWarnings} accounting warning(s)` });

  const lockedCrit = typeof d.db.locked === "number" && d.db.locked >= 4;
  const acctWarn = typeof d.db.acctWarnings === "number" && d.db.acctWarnings > 0;
  const sections: Analysis["sections"] = {
    modules: worst(d.modules.map((m) => m.s)),
    resources: worst(d.resources.map(resSev)),
    deps: worst(d.deps.map((x) => x.s)),
    errors:
      d.errors.breakers !== "closed"
        ? "crit"
        : d.errors.l60_1h > 0 || d.errors.l60_24h > 0
          ? "warn"
          : "ok",
    db: lockedCrit ? "crit" : acctWarn ? "warn" : "ok",
  };

  // `global` reflects real health only; pause is handled by the hero, not here.
  const global = worst(Object.values(sections));
  probs.sort((a, b) => RANK[b.sev] - RANK[a.sev]);
  return { global, sections, probs: probs.slice(0, 4) };
}
