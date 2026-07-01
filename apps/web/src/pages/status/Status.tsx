import { useEffect, useMemo, useState } from "react";
import { useSystemHealth } from "../../api/hooks.ts";
import type { HistPoint, Sev, SystemHealthResource } from "../../api/types.ts";
import { analyze, resSev, SEV_WORD } from "./severity.ts";
import "./status.css";

const GAP_BARS = 45;

function histDate(t: number): string {
  return new Date(t).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function humanizeDuration(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s} secs`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} mins`;
  const h = Math.floor(m / 60);
  return `${h} hrs ${m % 60} mins`;
}

/** status.claude.com-style per-day hover text: date + outcome + duration. */
function histTitle(p: HistPoint): string {
  const date = histDate(p.t);
  if (p.s === "nodata") return `${date} — No data (before monitoring started).`;
  if (p.s === "maintenance")
    return `${date} — Deploy / warm-up  ${humanizeDuration(p.maintenanceSecs)} (planned).`;
  if (p.s === "paused") return `${date} — Paused by operator  ${humanizeDuration(p.pausedSecs)}.`;
  const extra =
    p.maintenanceSecs > 0 || p.pausedSecs > 0
      ? ` (${humanizeDuration(p.maintenanceSecs + p.pausedSecs)} deploy/pause)`
      : "";
  if (p.s === "ok") return `${date} — No downtime recorded on this day.${extra}`;
  const dur = humanizeDuration(p.s === "crit" ? p.critSecs : p.downSecs);
  const label = p.s === "crit" ? "Major outage" : "Partial outage";
  return `${date} — ${label}  ${dur}${p.detail ? ` · ${p.detail}` : ""}${extra}`;
}

function Gauge({ val, max, sev }: { val: number; max: number; sev: Sev }) {
  const R = 58,
    cx = 75,
    cy = 72,
    C = Math.PI * R;
  const frac = Math.min(1, max > 0 ? val / max : 0);
  const col =
    sev === "crit" ? "var(--st-red)" : sev === "warn" ? "var(--st-amber)" : "var(--st-green)";
  const arc = `M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}`;
  return (
    <svg width="150" height="86" viewBox="0 0 150 86" aria-hidden="true">
      <path d={arc} fill="none" stroke="#1a212b" strokeWidth="9" strokeLinecap="round" />
      <path
        d={arc}
        fill="none"
        stroke={col}
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={C * (1 - frac)}
        style={{ transition: "stroke-dashoffset .5s ease, stroke .3s" }}
      />
    </svg>
  );
}

function Spark({ data, sev }: { data: number[]; sev: Sev }) {
  const w = 120,
    h = 30;
  if (data.length < 2)
    return <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" />;
  const mn = Math.min(...data),
    mx = Math.max(...data, 1),
    rng = mx - mn || 1;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - 2 - ((v - mn) / rng) * (h - 4)}`)
    .join(" ");
  const col =
    sev === "crit" ? "var(--st-red)" : sev === "warn" ? "var(--st-amber)" : "var(--st-green)";
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ display: "block" }}
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={col}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}

/**
 * Statuspage-style per-day history bar. The API always returns a full window
 * (nodata for un-sampled days); the empty fallback is only a defensive guard.
 * Every bar carries a native-title tooltip — including green/ok and nodata days.
 */
function HistBar({ hist, width }: { hist: HistPoint[]; width?: number }) {
  const points: HistPoint[] =
    hist.length > 0
      ? hist
      : Array.from({ length: GAP_BARS }, () => ({
          t: 0,
          s: "nodata" as const,
          downSecs: 0,
          critSecs: 0,
          maintenanceSecs: 0,
          pausedSecs: 0,
        }));
  const barHeight = (s: HistPoint["s"]): string =>
    s === "ok"
      ? "55%"
      : s === "nodata"
        ? "40%"
        : s === "maintenance" || s === "paused"
          ? "70%"
          : "100%";
  return (
    <div className="uptime" style={width ? { width } : undefined}>
      {points.map((p, i) => (
        <i
          key={i}
          className={p.s}
          style={{ height: barHeight(p.s) }}
          title={p.t ? histTitle(p) : undefined}
        />
      ))}
    </div>
  );
}

function statusWord(s: Sev): string {
  return s === "ok" ? "healthy" : s === "warn" ? "degraded" : "down";
}

function resourceValue(r: SystemHealthResource): string {
  return r.dec ? r.val.toFixed(r.dec) : String(r.val);
}

export function Status() {
  const { data, isLoading, isError, dataUpdatedAt } = useSystemHealth();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const analysis = useMemo(() => (data ? analyze(data) : null), [data]);

  if (isLoading) {
    return (
      <div className="status-page">
        <div className="state">Loading system health…</div>
      </div>
    );
  }
  if (isError || !data || !analysis) {
    return (
      <div className="status-page">
        <div className="state">Could not load system health.</div>
      </div>
    );
  }

  const { global, sections, probs } = analysis;
  const secs = Math.max(0, Math.round((now - dataUpdatedAt) / 1000));
  const windowDays = data.uptodayHist.length || GAP_BARS;
  // Unknown until the first sample — render "—", never a fabricated 100%.
  const uptimePctTxt = data.uptimePct === null ? "—" : `${data.uptimePct}%`;
  const maxErr = Math.max(...data.errors.hist.map((h) => h.n), 1);
  const lockedDot =
    data.db.locked === null
      ? "unk"
      : data.db.locked >= 4
        ? "crit"
        : data.db.locked > 0
          ? "warn"
          : "ok";
  const acctDot =
    data.db.acctWarnings === null || data.db.unknownAcct === null
      ? "unk"
      : data.db.acctWarnings > 0
        ? "warn"
        : "ok";

  // Pause is intentional, not an outage: an amber "PAUSED" hero (unless a real
  // crit also exists, which still shows red).
  const heroPaused = data.paused && global !== "crit";
  const heroSev: Sev = heroPaused ? "warn" : global;
  const heroWord = heroPaused ? "PAUSED" : SEV_WORD[global];
  const heroIcon = heroPaused ? "⏸" : global === "ok" ? "✓" : global === "warn" ? "!" : "✕";
  const heroSub = heroPaused
    ? `Trading paused by operator${data.pauseReason ? ` · ${data.pauseReason}` : ""}`
    : global === "ok"
      ? "All systems nominal — no active problems"
      : `${probs.length} issue${probs.length > 1 ? "s" : ""} need attention`;

  return (
    <div className="status-page">
      {/* hero */}
      <div className="hero" data-sev={SEV_WORD[heroSev]}>
        <div>
          <div className="lite">
            <div className="lamp">
              <span className="ic">{heroIcon}</span>
            </div>
            <div>
              <div className="st">{heroWord}</div>
              <div className="sub">{heroSub}</div>
            </div>
          </div>
          {probs.length > 0 ? (
            <div className="probs">
              {probs.map((p, i) => (
                <div className="prob" key={i}>
                  <span className={"sevtag " + p.sev}>{p.sev === "crit" ? "CRIT" : "WARN"}</span>
                  <span className="msg">{p.msg}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="none">
              ✓ No critical or warning conditions in the last refresh cycle.
            </div>
          )}
        </div>
        <div className="hmeta">
          <span className="upd">
            <span className="live" />
            updated {secs}s ago
          </span>
          <span className={"trade " + (data.paused ? "pause" : "run")}>
            {data.paused ? `⏸ paused · ${data.pauseReason ?? "manual"}` : "▶ running"}
          </span>
          <div className="uptoday">
            <span className="lab">
              uptime · last {windowDays}d · {uptimePctTxt}
            </span>
            <HistBar hist={data.uptodayHist} width={200} />
            <div className="upfoot">
              <span>{windowDays}d ago</span>
              <span>{uptimePctTxt} uptime</span>
              <span>today</span>
            </div>
          </div>
          <div className="kv">
            <span className="k">version</span>
            <span className="v">{data.version}</span>
            <span className="k">deploy</span>
            <span className="v">{data.deploy}</span>
            <span className="k">sha</span>
            <span className="v">
              {data.sha || "—"}
              {data.dirty && <span className="dirty"> ·dirty</span>}
            </span>
          </div>
        </div>
      </div>

      {/* modules */}
      <div className="sec">
        <div className="sec-h">
          <span className="t">System modules</span>
          <span className="ln" />
          <span className="age">live · 5–15s</span>
        </div>
        <div className="modgrid">
          {data.modules.map((m) => (
            <div className="mtile" key={m.nm}>
              <div className="top">
                <span className={"ring " + m.s} />
                <span className="nm">{m.nm}</span>
                <span className={"stat " + m.s}>{statusWord(m.s)}</span>
              </div>
              <HistBar hist={m.hist} />
              <div className="ft">
                <span>{m.since} up</span>
                <span>{m.detail}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* resources */}
      <div className="sec">
        <div className="sec-h">
          <span className="t">Host resources</span>
          <span className="ln" />
          <span className="age">30–60s</span>
        </div>
        <div className="gauges">
          {data.resources.map((r) => {
            const s = resSev(r);
            return (
              <div className="gtile" key={r.nm}>
                <span className="gl">{r.nm}</span>
                <div className="gwrap">
                  <Gauge val={r.val} max={r.max} sev={s} />
                  <div className="gval">
                    <div className={"v " + s}>{resourceValue(r)}</div>
                    <div className="u">{r.unit}</div>
                  </div>
                </div>
                <div className="gsub">
                  <span>{r.sub[0]}</span>
                  <span>{r.sub[1]}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* dependencies */}
      <div className="sec">
        <div className="sec-h">
          <span className="t">External dependencies</span>
          <span className="ln" />
          <span className="age">reachability</span>
        </div>
        <div className="deps">
          {data.deps.map((x) => (
            <div className="dtile" key={x.nm}>
              <div className="top">
                <span className={"ring " + x.s} />
                <span className="nm">{x.nm}</span>
                <span className={"pill " + x.s}>
                  {x.s === "crit" ? "DOWN" : x.s === "warn" ? "SLOW" : "OK"}
                </span>
              </div>
              <div className="row">
                <div className="big">
                  {x.s === "crit" ? "—" : x.lat !== null ? x.lat : "·"}
                  <span className="u">
                    {x.s === "crit" ? " no resp" : x.lat !== null ? " ms" : " not sampled"}
                  </span>
                </div>
                <div className={"err" + (typeof x.err === "number" && x.err > 1 ? " bad" : "")}>
                  {x.err === null ? "n/a" : `${x.err}%`} err
                </div>
              </div>
              {x.hist.length >= 2 ? (
                <Spark data={x.hist} sev={x.s} />
              ) : (
                <div className="depnote">latency history not sampled · Phase 2</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* errors + db */}
      <div className="sec">
        <div className="twocol">
          <div className="panel">
            <div className="ph">
              <span className={"sd " + sections.errors} />
              <span className="pt">Errors · last 24h</span>
            </div>
            <div className="errstat">
              <div className="es">
                <span className={"n " + (data.errors.l50_24h > 0 ? "l50" : "ok")}>
                  {data.errors.l50_24h}
                </span>
                <span className="k">level 50 · 24h</span>
              </div>
              <div className="es">
                <span className={"n " + (data.errors.l60_24h > 0 ? "l60" : "ok")}>
                  {data.errors.l60_24h}
                </span>
                <span className="k">level 60 · 24h</span>
              </div>
              <div className="es">
                <span className={"n " + (data.errors.breakers !== "closed" ? "l60" : "ok")}>
                  {data.errors.breakers === "closed" ? "0" : data.errors.breakers.split(" ")[0]}
                </span>
                <span className="k">breakers open</span>
              </div>
            </div>
            <div className="barspark">
              {data.errors.hist.map((h, i) => (
                <i
                  key={i}
                  className={h.crit ? "crit" : h.n > 0 ? "has" : ""}
                  style={{ height: Math.max(8, (h.n / maxErr) * 100) + "%" }}
                  title={`${new Date(h.t).toLocaleString("en-GB", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })} — ${h.n} error${h.n === 1 ? "" : "s"}`}
                />
              ))}
            </div>
            <div className="barspark-x">
              <span>−24h</span>
              <span>−12h</span>
              <span>now</span>
            </div>
            <div className="codes">
              {data.errors.top.length === 0 ? (
                <div className="empty">No operational errors in the window.</div>
              ) : (
                data.errors.top.map((e, i) => (
                  <div className="crow" key={i}>
                    <span className={"lv " + e.lv}>{e.lv === "l60" ? "L60" : "L50"}</span>
                    <span className="code">{e.code}</span>
                    <span className="when">
                      ×{e.cnt} · {e.when}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="panel">
            <div className="ph">
              <span className={"sd " + sections.db} />
              <span className="pt">Database &amp; storage</span>
            </div>
            <div className="dbrow">
              <span className="nm">ledger-live-lite.db</span>
              <span className="track">
                <i
                  className="ok"
                  style={{ width: Math.min(100, (data.db.ledger / 1024) * 100) + "%" }}
                />
              </span>
              <span className="v">{data.db.ledger} MB</span>
            </div>
            <div className="dbrow">
              <span className="nm">control.db</span>
              <span className="track">
                <i
                  className="ok"
                  style={{ width: Math.min(100, (data.db.control / 1024) * 100) + "%" }}
                />
              </span>
              <span className="v">{data.db.control} MB</span>
            </div>
            <div className="dbrow">
              <span className="nm">WAL (-wal)</span>
              <span className="track">
                <i
                  className={data.db.wal > 120 ? "crit" : data.db.wal > 60 ? "warn" : "ok"}
                  style={{ width: Math.min(100, (data.db.wal / 256) * 100) + "%" }}
                />
              </span>
              <span className="v">{data.db.wal} MB</span>
            </div>
            <div className="dbflags">
              <span className="dbflag">
                <span className={"d " + lockedDot} />
                SQLite locked {data.db.locked === null ? "n/a" : `×${data.db.locked}`}
              </span>
              <span className="dbflag">
                <span className="d ok" />
                migration {data.db.migration}
              </span>
              <span className="dbflag">
                <span className={"d " + acctDot} />
                acct warnings {data.db.acctWarnings ?? "n/a"} · UNKNOWN{" "}
                {data.db.unknownAcct ?? "n/a"}
              </span>
              <span className="dbflag">
                <span className="d unk" />
                retention {data.db.retention}
              </span>
              <span className="dbflag">
                <span className="d unk" />
                vacuum {data.db.lastVacuum}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* shadow registry */}
      <div className="sec">
        <div className="sec-h">
          <span className="t">Shadow / experiments</span>
          <span className="ln" />
          <span className="age">{data.shadow.length} registered</span>
        </div>
        <div className="exps">
          {data.shadow.map((e, i) => (
            <div className="exp" key={i}>
              <div className="ei">
                <div className="en">{e.nm}</div>
              </div>
              <span className="added">added {e.added}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="foot">
        <span className="lg">
          <span className="d ok" />
          OK — fresh, no drift, deps responding
        </span>
        <span className="sep">·</span>
        <span className="lg">
          <span className="d warn" />
          WARNING — degraded, take a look
        </span>
        <span className="sep">·</span>
        <span className="lg">
          <span className="d crit" />
          CRITICAL — page operator now
        </span>
        <span className="cad">refresh: modules 5–15s · resources/DB 30–60s</span>
      </div>
    </div>
  );
}
