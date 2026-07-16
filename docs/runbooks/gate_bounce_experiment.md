# Runbook — GATE entry + bounce-exit live experiment

Operator guide for the live experiment that replicates plankton's round-trip (enter cheap on a
long-lived market without waiting for R23's dip → sell the bounce). Plan:
`docs/plans/2026-07-15-gate-bounce-live-experiment.md`. All code ships **default-OFF**; this runbook
is the ONLY way to turn it on, and it is reversible.

> **Governing principles (CLAUDE.md):** replicate plankton first; every parameter is research-backed.
> The values below are FIXED from research — do not tune them before the replication is validated.

## 1. What it does (when enabled)

- **GATE entry** (alongside live R23, only when R23 does NOT fire): a first-entry BUY on markets that
  are **cheap (mid 0.01–0.15)** and **long-lived (≥30 days lifespan)**, no dip required. Size capped
  at **$2/position** (micro cap enforced at sizing AND execution).
- **Bounce-exit** (only on GATE-lane positions; R23 positions keep D8/D9): on fill, rest a **post-only
  maker SELL at entry × 1.257** (+25.7%, plankton's median realized round-trip); if unfilled after
  **4h**, cancel it and **taker force-exit** the remainder.

Research basis (see plan §Research): GATE band = H5/H1 robust zone; +25.7% / 4h = median of plankton's
17,688 realized round-trips (p50 +25.7%, 96% positive, median hold 1.44h).

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
  "targetGainPct": 0.257,     // FIXED (+25.7%, research)
  "timeoutMs": 14400000,      // FIXED (4h, research)
  "microMaxOrderUsdc": 2,
  "whitelistConditionIds": ["0x…", "0x…"]   // SAME set as gateEntry
}
```

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

-- how GATE positions exited (target vs timeout)
SELECT o.decision_rule_id, COUNT(*) n
FROM orders o JOIN positions p ON p.token_id = o.token_id
WHERE p.entry_lane = 'GATE' AND o.side = 'sell'
  AND o.decision_rule_id IN ('BOUNCE_EXIT_TARGET', 'BOUNCE_EXIT_TIMEOUT')
GROUP BY 1;
```

## 5. Success criteria (research-backed GO/NO-GO)

Judge only after **≥ 30 resolved GATE round-trips** (fewer = extend, do not decide — mirrors the #3/#8
discipline). **GO** if, on the GATE lane:

- realized winrate and per-round-trip P&L are **materially above** our current hold-to-resolution
  baseline (**37% win / negative** across all closed positions), AND
- the exit profile is **directionally consistent with plankton's round-trip** — a majority of exits are
  the **maker target** (positive), not the 4h timeout, and net realized P&L is positive ex-tail.

Otherwise **extend** (need more n) or **NO-GO** (edge absent). Only after a GO do we consider improving
(principle #1: replicate first).

## 6. Rollback (reversible — mind open positions)

To stop opening NEW GATE positions: set `gateEntry` back to `"enabled": false, "mode": "off"` (bump the
version) — new GATE entries stop immediately, no deploy needed.

The bounce-exit (resting maker target + 4h timeout) only runs while `bounceExit` is `enabled:true,
mode:"micro_live"`, and whitelisted. Disabling it does NOT orphan open GATE positions — they simply fall
back to the normal **D8/D9** exit stack (the same rules that manage R23 positions). But that abandons the
intended round-trip: instead of the +25.7% maker bounce / 4h taker, the position is then exited by
D8/D9's hold-and-cut logic. So to preserve the experiment's exit behaviour for in-flight positions, wind
down in order: turn `gateEntry` off first (stop new entries), keep `bounceExit` enabled until every open
GATE position has gone flat, then disable `bounceExit`. If you disable `bounceExit` immediately, expect
open GATE positions to be exited by D8/D9 rather than the bounce rule (safe, just not the tested path).
