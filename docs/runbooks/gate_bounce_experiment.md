# Runbook — GATE entry + bounce-exit live experiment

Operator guide for the live experiment that replicates plankton's round-trip (enter cheap on a
long-lived market without waiting for R23's dip → sell the bounce). Plan:
`docs/plans/2026-07-15-gate-bounce-live-experiment.md` (entry) and
`docs/plans/2026-07-16-bounce-exit-ladder-redesign.md` (laddered exit, this revision). All code ships
**default-OFF**; this runbook is the ONLY way to turn it on, and it is reversible.

> **Governing principles (CLAUDE.md):** replicate plankton first; every parameter is research-backed.
> The values below are FIXED from research — do not tune them before the replication is validated.

## 1. What it does (when enabled)

- **GATE entry** (alongside live R23, only when R23 does NOT fire): a first-entry BUY on markets that
  are **cheap (mid 0.01–0.15)** and **long-lived (≥30 days lifespan)**, no dip required. Size capped
  at **$2/position** (micro cap enforced at sizing AND execution).
- **Bounce-exit** (only on GATE-lane positions; R23 positions keep D8/D9): a **3-rung laddered exit**
  that scales out in tranches instead of selling the whole position at one flat target:
  - **Rung prices are entry-price-tiered.** Rung 0's target is `firstTradePrice × (1 + tierGain)`,
    where `tierGain` comes from a 7-band table keyed by how cheap the first entry was (cheaper entries
    get a bigger first-rung target, since plankton's realized bounce is larger the deeper he bought):
    `≤0.02→+36%, ≤0.03→+27%, ≤0.05→+19%, ≤0.08→+15%, ≤0.15→+15%, ≤0.35→+12%, ≤1.00→+8%`.
    Rungs 1 and 2 step up geometrically off that same first-entry anchor: `+22%` per rung
    (`firstTradePrice × (1+tierGain) × (1+0.22)^rungIndex`, tick-rounded once — never compounded off
    an already-rounded price, and never off the live VWAP/avgEntryPrice).
  - **Rung sizes are 30% / 40% / 30%** of the position's original size (the size at the moment the
    ladder's first rung was placed) — front- and back-loaded lighter, mid-tranche heaviest.
  - Each rung rests as a **post-only maker SELL** (GTC limit order) — no crossing the spread. This
    replicates the observed **88% of plankton's sells resting above/at the bid** (44% ≥ ask, 44%
    inside the spread).
  - **Add-invariant by construction**: `firstTradePrice`/`firstTradeAt` are captured once on the very
    first BUY fill and never mutated by later fills, so rung _prices_ cannot re-anchor to a new VWAP.
    Rung _sizes_ are pinned to the position size recorded on the very first rung ever placed (persisted
    in that rung's own order metadata and read back on every cycle), not to the live cumulative-buy
    total — so a hypothetical add landing after the ladder starts cannot silently re-inflate every
    rung's size either. (GATE is a first-entry lane and Track A blocks down-adds on it in practice, but
    the exit is defensively add-invariant regardless — see
    `apps/runtime/src/modules/algo-decision/__tests__/decision-planner-bounce-exit.test.ts`.)
  - **Near-resolution taker backstop** (replaces the old flat 4h timeout): if a GATE position is still
    open within `backstopTtcHours` (24h) of the market's resolution/end date, cancel any resting
    ladder rungs and force-exit the remainder at the live best bid (marketable taker, not post-only).
    This reuses Sub-Track Q.D's existing Mode-A/Mode-B near-resolution activation logic
    (`evaluateQdPreResolutionExit`), scoped to the whole GATE entry band (`avgEntryPrice <=
gateEntry.maxPrice`, **inclusive** of 0.15) rather than re-implementing a separate check.

Research basis (see `docs/plans/2026-07-16-bounce-exit-ladder-redesign.md` §Research): GATE band =
H5/H1 robust zone. The old flat **+25.7% / 4h** target was plankton's **leg-level** median realized
round-trip (17,688 `analysis_fifo_matches` rows, 96% positive, median hold 1.44h) — it captures the
median but caps every winner at the same target, discarding the tail. Re-deriving the
**whole-position** exit multiple (`avgSell / avgBuy` per closed position, `analysis_market_summary`,
n=13,472) shows the realistic distribution is **p25 1.10x, p50 1.24x (+24%), p75 1.61x, p90 2.98x
(+198%)** — a long right tail the flat target throws away. The ladder is designed to capture the
median (rung 0, sized closest to the historical target) while letting rungs 1–2 rest at successively
higher prices to keep exposure to the p90-style outsized winners plankton actually realizes.

## 2. Enable (operator-applied config — code stays OFF)

Edit `control.db` → `profile_settings.execution_policy_json` for the **live-lite** profile and add/set
the two blocks (hot-reloadable; bump `runtime_control_state.execution_policy_version`). Both blocks are
`enabled:false, mode:"off"` by default — this turns them on to `micro_live` scoped to a whitelist:

```jsonc
"gateEntry": {
  "enabled": true,
  "mode": "micro_live",
  "minLifespanDays": 30,      // FIXED (research)
  "minPrice": 0.01,           // FIXED (tick/dust floor)
  "maxPrice": 0.15,           // FIXED (research)
  "microMaxOrderUsdc": 2,     // tiny cap
  "whitelistConditionIds": ["0x…", "0x…"]   // see §3
},
"bounceExit": {
  "enabled": true,
  "mode": "micro_live",
  "targetTiers": [            // FIXED (research) — entry-price-tiered rung-0 target
    { "maxPrice": 0.02, "gainPct": 0.36 },
    { "maxPrice": 0.03, "gainPct": 0.27 },
    { "maxPrice": 0.05, "gainPct": 0.19 },
    { "maxPrice": 0.08, "gainPct": 0.15 },
    { "maxPrice": 0.15, "gainPct": 0.15 },
    { "maxPrice": 0.35, "gainPct": 0.12 },
    { "maxPrice": 1.0,  "gainPct": 0.08 }
  ],
  "ladderFractions": [0.3, 0.4, 0.3],  // FIXED (research) — 3-rung scale-out
  "ladderStepPct": 0.22,               // FIXED (research) — +22% per rung
  "backstopTtcHours": 24,              // FIXED (research) — near-resolution taker force-exit window
  "microMaxOrderUsdc": 2,
  "whitelistConditionIds": ["0x…", "0x…"]   // SAME set as gateEntry
}
```

`targetGainPct` / `timeoutMs` are **vestigial** — leftover fields from the old flat-target design, kept
only so a pre-existing operator JSON round-trips through the parser without crashing. They are not
read by the live evaluator; do not set them expecting them to change behavior. Use `targetTiers` /
`ladderFractions` / `ladderStepPct` / `backstopTtcHours` instead — those are the fields that actually
drive the ladder.

Keep the two whitelists identical (a GATE entry and its bounce-exit must be on the same market set).
`LiveLiteGuard` envelope caps still apply on top; keep the experiment tiny.

## 3. Choosing the whitelist (a small, safe set)

Pick a handful of currently-open condition_ids that match the GATE band, verified on prod (read-only):

```sql
-- long-lived + cheap, currently open, not resolved (run via ssh root@your.server.ip docker exec …, readonly)
SELECT condition_id, slug, sig_mid, end_date, gamma_created_at
FROM markets
WHERE tradable = 1 AND sig_mid BETWEEN 0.01 AND 0.15
  AND julianday(end_date) - julianday('now') >= 30
ORDER BY sig_liquidity DESC
LIMIT 10;
```

Start with 3–5. Expand only after the first round-trips look sane.

## 4. Reading the readout (per-lane realized P&L)

Telemetry is derived from the durable `positions.entry_lane` (set from the first fill's rule) joined to
the SELL `orders.decision_rule_id` — no special log table. On prod `ledger-live-lite.db` (readonly):

```sql
-- realized P&L by entry lane (GATE vs R23), closed positions
SELECT entry_lane, COUNT(*) n,
       SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) wins,
       ROUND(100.0 * SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) winrate_pct,
       ROUND(SUM(realized_pnl), 2) sum_pnl
FROM positions WHERE status = 'closed' GROUP BY entry_lane;

-- how GATE positions exited (laddered maker rungs vs near-resolution backstop)
SELECT o.decision_rule_id, COUNT(*) n
FROM orders o JOIN positions p ON p.token_id = o.token_id
WHERE p.entry_lane = 'GATE' AND o.side = 'sell'
  AND o.decision_rule_id IN ('BOUNCE_EXIT_TARGET', 'BOUNCE_EXIT_BACKSTOP')
GROUP BY 1;

-- rung-level detail for filled BOUNCE_EXIT_TARGET orders (ladder index, anchor, fraction sold)
SELECT json_extract(o.metadata_json, '$.bounceRung.rungIndex') rung_index,
       json_extract(o.metadata_json, '$.bounceRung.anchorPrice') anchor_price,
       json_extract(o.metadata_json, '$.bounceRung.fraction') fraction,
       COUNT(*) n
FROM orders o
WHERE o.decision_rule_id = 'BOUNCE_EXIT_TARGET' AND o.side = 'sell' AND o.status = 'filled'
GROUP BY 1, 2, 3
ORDER BY rung_index;
```

## 5. Success criteria (research-backed GO/NO-GO)

Judge only after **≥ 30 resolved GATE round-trips** (fewer = extend, do not decide — mirrors the #3/#8
discipline). **GO** if, on the GATE lane:

- realized winrate and per-round-trip P&L are **materially above** our current hold-to-resolution
  baseline (**37% win / negative** across all closed positions), AND
- **a majority of exit fills are laddered maker rungs** (`BOUNCE_EXIT_TARGET`), not the near-resolution
  taker backstop (`BOUNCE_EXIT_BACKSTOP`) — mirroring the 88% resting-maker share observed in
  plankton's own sells, AND
- the realized per-position exit-multiple distribution is **directionally consistent with the tail
  plankton actually captures** — median around the historical leg-level +25.7% / whole-position +24%
  range, with visible upside from rung 1/2 fills materially above rung 0 (i.e. the ladder is capturing
  some of the p90-style +198% tail, not capping every winner at a single flat target the way the old
  design did).

Otherwise **extend** (need more n) or **NO-GO** (edge absent, or the backstop is doing most of the work
instead of the ladder). Only after a GO do we consider improving (principle #1: replicate first).

## 6. Rollback (reversible — mind open positions)

To stop opening NEW GATE positions: set `gateEntry` back to `"enabled": false, "mode": "off"` (bump the
version) — new GATE entries stop immediately, no deploy needed.

The bounce-exit (laddered maker rungs + near-resolution taker backstop) only runs while `bounceExit` is
`enabled:true, mode:"micro_live"`, and whitelisted. Disabling it does NOT orphan open GATE positions —
they simply fall back to the normal **D8/D9** exit stack (the same rules that manage R23 positions). But
that abandons the intended round-trip: instead of the laddered rungs / near-resolution backstop, the
position is then exited by D8/D9's hold-and-cut logic. So to preserve the experiment's exit behaviour for
in-flight positions, wind down in order: turn `gateEntry` off first (stop new entries), keep `bounceExit`
enabled until every open GATE position has gone flat, then disable `bounceExit`. If you disable
`bounceExit` immediately, expect open GATE positions to be exited by D8/D9 rather than the ladder/backstop
(safe, just not the tested path).
