import { useEffect, useMemo, useState } from "react";
import { useSystemHealth } from "../../api/hooks.ts";
import type { Sev, SystemHealthResource } from "../../api/types.ts";
import { analyze, resSev, SEV_WORD } from "./severity.ts";
import "./status.css";

const GAP_BARS = 40;

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

/** Statuspage-style uptime/history bar. Empty history => neutral "gap" bars. */
function HistBar({ hist, width }: { hist: Sev[]; width?: number }) {
  const bars: Sev[] | "gap"[] = hist.length > 0 ? hist : (Array(GAP_BARS).fill("gap") as "gap"[]);
  return (
    <div className="uptime" style={width ? { width } : undefined}>
      {bars.map((s, i) => (
        <i
          key={i}
          className={s === "gap" ? "gap" : s}
          style={{ height: s === "ok" ? "55%" : "100%" }}
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

  return (
    <div className="status-page">
      {/* hero */}
      <div className="hero" data-sev={SEV_WORD[global]}>
        <div>
          <div className="lite">
            <div className="lamp">
              <span className="ic">{global === "ok" ? "✓" : global === "warn" ? "!" : "✕"}</span>
            </div>
            <div>
              <div className="st">{SEV_WORD[global]}</div>
              <div className="sub">
                {global === "ok"
                  ? "All systems nominal — no active problems"
                  : `${probs.length} issue${probs.length > 1 ? "s" : ""} need attention`}
              </div>
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
            <span className="lab">uptime today · {data.uptimePct}%</span>
            <HistBar hist={data.uptodayHist} width={200} />
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
                    {x.lat !== null && x.s !== "crit"
                      ? " ms"
                      : x.s === "crit"
                        ? " no resp"
                        : " reachable"}
                  </span>
                </div>
                <div className={"err" + (typeof x.err === "number" && x.err > 1 ? " bad" : "")}>
                  {x.err === null ? "n/a" : `${x.err}%`} err
                </div>
              </div>
              <Spark data={x.hist} sev={x.s} />
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
