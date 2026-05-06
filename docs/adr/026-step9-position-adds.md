# ADR-026 — Step 9: Position adds

## Status

Accepted — 2026-05-06

## Context

Step 9 of the trading pipeline ("Position adds") was audited against
the canonical algorithm spec
`research_plankton/plankton-analysis/06_algorithm_spec.md` v5.13
§11.1 (Position adds — R27 observational data) plus the split
pipeline doc
`research_plankton/plankton-analysis/pipeline_analysis/12_position_management.md`
(v5.13, restored 2026-05-05). The audit lives at
[`docs/audits/2026-05-06-step9-position-adds.md`](../audits/2026-05-06-step9-position-adds.md).

§11.1 is **purely empirical**: it reports add-event counts (52,220
adds across 7,064 legs with ≥2 BUYs out of 10,046 legs total),
add-timing distribution across the 9 buckets `<60s | 1-5min |
5-30min | 30min-1h | 1-3h | 3-12h | 12-24h | 1-7d | >7d`,
add-price-change-vs-first-BUY distribution (excluding <60s) across
the 8 buckets `below -50% | -50% to -25% | -25% to -10% | -10% to
0% | 0% to +10% | +10% to +25% | +25% to +50% | above +50%`, and a
per-leg `n_adds` distribution. It does not prescribe whether or
when to add; that decision lives in the runtime per ADR-011.

Tangential ADRs already in place:

- **ADR-011** — Operational extensions: TTL / cancel / repost /
  cooldown / `postOnly` are operational policy, not spec-derived.
- **ADR-024 (Step 7)** — Sizing telemetry on
  `decision_signal_log` (`sizing_rule_id`, `notional_bucket`).
  Step 9 extends the same table with adds telemetry.
- **ADR-025 (Step 8)** — Cancel telemetry on `orders`
  (`cancel_age_ms`, `cancel_age_bucket`,
  `fill_progress_shares`, `market_horizon`). Mirrors the
  `independently nullable` pattern Step 9 reuses for adds.

The audit identified four structural divergences (D1-D4) and one
recommendation (no behavioural change). This ADR maps them to D-A
through D-D:

- **D-A** locks the existing add-emission contract (4-tier reason
  ladder, two-layer risk gate, no `n_adds` cap) as canonical for
  v1 — answers audit framing (§11.1 is not prescriptive).
- **D-B** introduces denormalized adds telemetry on
  `decision_signal_log` — answers audit D1, D2, D3, D4.
- **D-C** centralizes the §11.1 bucket vocabularies in two
  domain-level helpers — answers audit D2 / D3 staleness risk.
- **D-D** records the deliberately-unwired Stage-9 dashboard
  surfaces — out of scope for this ADR but flagged for Step 10
  follow-up.

§11.4 Q1 (action source for adds without `order_id` / `order_hash`)
is not applicable to our own runtime; §11.4 Q2 (sell-size splits
as partial fills vs distinct exits) is deferred to Step 10.

## Decision

### D-A — 4-tier reason ladder + two-layer risk gate + uncapped `buy_count` accumulation is canonical for v1

The current add-emission contract is hereby canonical:

- **Reason ladder** (`packages/domain/src/algo-engine.ts:120-126`):
  every BUY signal carries one of four reasons keyed off
  `legState.buyCount`:
  - `buyCount === 0 → probe-entry` (first entry)
  - `buyCount === 1 → confirm-scale` (1st add)
  - `buyCount in [2, 3] → scale-in` (2nd–3rd adds)
  - `buyCount >= 4 → heavy-scale` (4th+ adds)
    Sells return `repricing-exit` and bypass this ladder.
- **Two-layer risk gate**
  (`apps/runtime/src/modules/risk-inventory/algo-risk-gate.ts:31-77`):
  - **Layer 1 — open-buy-order dedupe**: rejects any BUY signal
    when an order with `side === "buy"` and status in
    `{ pending, open, partially-filled }` exists for the same
    token. Reason-agnostic; blocks adds until the prior BUY
    fills and clears open-status.
  - **Layer 2 — open-position-exists**: rejects only when
    `signal.reason ∈ NEW_ENTRY_REASONS = { ProbeEntry }`.
    Scale-in reasons bypass this check and re-buy on the
    existing position by design.
- **`leg_states.buy_count` accumulates without cap**
  (`apps/runtime/src/modules/leg-state/update-leg-state-for-fill.ts:92-112`):
  every BUY fill increments `buyCount` on the existing leg row.
  No cap, no first-vs-add branching. Sell fills increment
  `sellCount` separately; close-and-reopen events reset the row
  via the existing leg-state-clear path.
- **`pendingEntries` in-flight gate**
  (`apps/runtime/src/modules/algo-decision/algo-decision-module.ts:773-786`)
  fires only on the `!legState` path: it caps at most one
  in-flight BUY signal **for the first entry**. Once the first
  leg row exists, sweep-tick adds are gated only by the risk
  gate (layer 1), not by `pendingEntries`.

Justification:

- **§11.1 is empirical, not prescriptive.** The spec reports
  observed add-event distributions across 101,152 trade rows
  but does not publish a deterministic add-trigger rule.
  ADR-011 reserves operational decisions to the runtime.
- **The 4-tier reason ladder mirrors the §11.1.4 `n_adds`
  bucketing.** The spec reports `n_adds` buckets `0 / 1 / 2-3
/ 4-10 / 11-30 / >30`. Our `confirm-scale | scale-in |
heavy-scale` split aligns with the `1 / 2-3 / >=4` boundary,
  collapsing the 4-10 / 11-30 / >30 spec buckets into a single
  `heavy-scale` operational class. Operators can subdivide
  later by inspecting the new `nth_buy_at_emit` column.
- **§11.1 add timing matches our risk-gate cadence.** §11.1
  reports only 9.88% of adds are <60s after the first BUY; the
  bulk lands in the 3h–7d tail. Layer 1 of the risk gate
  enforces "no second BUY signal until the first BUY fills",
  which structurally pushes consecutive adds past the
  median-fill latency rather than letting sweep-ticks fire
  multiple BUYs in the same second. This is alignment, not
  divergence.
- **No `n_adds` cap because §11.1.4 does not publish one.**
  The empirical distribution shows 2.50% of legs accumulate
  > 30 adds. Capping at any constant would falsify the
  > long-tail behaviour the spec characterizes. If operational
  > experience surfaces a runaway-add problem in production, a
  > DB-tunable cap can be added later (analogous to ADR-015's
  > `exitOrderTtlMs` lift).

### D-B — Denormalize adds telemetry onto `decision_signal_log` (audit D1 / D2 / D3 / D4)

Migration 048 adds six nullable columns to `decision_signal_log`:

- `is_add INTEGER` (0/1) — `1` when `side = 'BUY'` and
  `buy_count >= 1`; `0` for first BUYs (`buy_count = 0`); `NULL`
  for SELL / REDEEM. Computed at insert time; never recomputed.
- `add_age_ms INTEGER` — `signalTs - legState.firstTradeAt` in
  milliseconds. Populated only when `is_add = 1` AND the leg
  state has a finite `firstTradeAt`. `NULL` for first BUYs,
  sells, and add signals where the leg row has been reset.
- `add_age_bucket TEXT` — one of the 9 §11.1 strings (`<60s`,
  `1-5min`, `5-30min`, `30min-1h`, `1-3h`, `3-12h`, `12-24h`,
  `1-7d`, `>7d`) or `NULL`.
- `add_price_change_pct REAL` — `(price - firstTradePrice) /
firstTradePrice`. Populated only when `is_add = 1` AND
  `firstTradePrice > 0`. **Recorded for all adds, including
  those <60s** — the §11.1 "exclude <60s" filter is applied at
  query time, not at write time, so the raw distribution is
  preserved for future analysis.
- `add_price_change_bucket TEXT` — one of the 8 §11.1 strings
  (`below -50%`, `-50% to -25%`, `-25% to -10%`, `-10% to 0%`,
  `0% to +10%`, `+10% to +25%`, `+25% to +50%`, `above +50%`)
  or `NULL`.
- `nth_buy_at_emit INTEGER` — `buy_count + 1` when
  `side = 'BUY'`; `NULL` for sells. Persists what the engine
  already computes at `algo-decision-module.ts:1015`.

All six are nullable; persistence happens in
`SqliteDecisionSignalLogRepository.insert` inside the same
prepared statement that already writes the Step-7 sizing
telemetry. No second `UPDATE` round-trip; no race window.

The `is_add` denormalization is intentional even though
`buy_count > 0 && side = 'BUY'` is computable client-side: it
guarantees a single boolean dashboard surface, removes the
side-filter trap, and makes the column directly indexable for
time-bucketed adds-rate metrics.

The `add_price_change_pct` raw value is preserved alongside the
bucket (vs the cancel-telemetry pattern of bucket-only) because
§11.1's <60s exclusion filter requires the raw percent to
recompute the spec-comparison distribution at query time.

### D-C — Centralize §11.1 bucket vocabularies in two helpers

Two new helpers join the existing
`classifyCancelAgeBucket` (ADR-025) and `classifyNotionalBucket`
(ADR-024):

- `classifyAddAgeBucket(ms: number | null): AddAgeBucket | null`
  in `apps/runtime/src/executable-price.ts`.
  Boundaries (closed-open, in seconds):
  ```
  [0, 60)         → "<60s"
  [60, 300)       → "1-5min"
  [300, 1_800)    → "5-30min"
  [1_800, 3_600)  → "30min-1h"
  [3_600, 10_800) → "1-3h"
  [10_800, 43_200)→ "3-12h"
  [43_200, 86_400)→ "12-24h"
  [86_400, 604_800)→ "1-7d"
  [604_800, ∞)    → ">7d"
  ```
  `null` for negative, non-finite, or null inputs. Mirrors §11.1
  table headers exactly.
- `classifyAddPriceChangeBucket(pct: number | null):
AddPriceChangeBucket | null` in the same module.
  Boundaries (in fraction units, e.g. `-0.5` for `-50%`):
  ```
  (-∞, -0.50)         → "below -50%"
  [-0.50, -0.25)      → "-50% to -25%"
  [-0.25, -0.10)      → "-25% to -10%"
  [-0.10,  0.00)      → "-10% to 0%"
  [ 0.00,  0.10)      → "0% to +10%"
  [ 0.10,  0.25)      → "+10% to +25%"
  [ 0.25,  0.50)      → "+25% to +50%"
  [ 0.50, ∞)          → "above +50%"
  ```
  `null` for non-finite or null inputs. Bucket names mirror §11.1
  table headers exactly.

Both helpers are pure functions and have no runtime dependency
on `Date.now()`, so production-equivalent unit tests can verify
boundary behaviour deterministically. Branded types
`AddAgeBucket` and `AddPriceChangeBucket` are exported from
`@plankton/domain` so persistence (insert call sites) and
analytics (future dashboard) share the same vocabulary.

Computed once at row-write time; not re-derived at query time so
dashboards stay schema-stable across future bucket-taxonomy
revisions.

### D-D — Stage-9 dashboard surface deferred to Step 10 follow-up

Surfacing the §11.1.1 / §11.1.2 / §11.1.3 / §11.1.4 distributions
in the API DTO (`apps/api/src/routes/orders.ts`) and web UI is
**out of scope** for Step 9. Operators can query
`decision_signal_log` directly via the read-only DB tunnel until
the dashboard widgets land. Rationale:

- Step 8's final-review `Open Question` flagged the same DTO
  surface for cancel telemetry; we deferred there too. Adding
  Step-9 columns to the DTO at the same time as Step-10 (exits)
  telemetry lets us ship a single coherent operator view of
  position-management observations rather than two half-finished
  panels.
- The columns are immediately useful via SQL: a
  `SELECT add_age_bucket, COUNT(*) FROM decision_signal_log
WHERE is_add = 1 GROUP BY 1` query reproduces §11.1.2 from
  production data with no application-layer changes.

## Consequences

### Positive

- **§11.1 dashboard becomes one query.** Every signal-emit row
  now carries the four §11.1 distributions denormalized; no join
  against `leg_states` (which can drift after restarts), no
  client-side bucket logic, no per-row `firstTradePrice` lookup.
- **Production drift is visible at canonical granularity.**
  §11.1's exact bucket boundaries are preserved, so we can A/B
  the live distribution against the v5.13 reference numbers
  without re-binning.
- **Bucket vocabulary is centralized.** Two new helpers join the
  Step-7 / Step-8 helpers; future contributors find them by
  proximity, and any future bucket-taxonomy revision lands in
  one place.
- **No behavioural change.** Adds emission, sizing, and risk
  gating are unchanged. Production load is six extra nullable
  columns per `decision_signal_log` row; measured ~1KB/row at
  current emit volume, well below the retention window.

### Negative

- **`firstTradePrice` snapshotting depends on `leg_states`
  staying intact.** If a leg row is cleared (e.g. position
  closed, market resolved) and a new entry creates a fresh row,
  the `add_age_ms` and `add_price_change_pct` for any subsequent
  BUY will reference the _new_ `firstTradeAt`/`firstTradePrice`,
  not the historical chain. This matches the production
  semantics of `legState` already used by the reason ladder, so
  it is alignment, not regression — but operators querying
  long-horizon §11.1.4 `n_adds` distributions must restrict to
  legs that haven't been reset.
- **Six new nullable columns on a hot table.** Every emit pays
  six extra `?` placeholders; no measurable latency at current
  volume but worth retaining the option to drop columns if the
  decision_signal_log retention window is lifted.
- **`add_price_change_pct` for <60s adds is recorded raw.**
  Spec §11.1.3 excludes <60s adds from its distribution; we
  record them anyway and rely on a `WHERE add_age_ms >= 60_000`
  filter at query time. Analysts must remember the filter.

### Neutral

- **No new ADR-011 conflict.** Operational decisions about adds
  (whether to add, size of add, rate-limit) remain owned by the
  runtime. Step 9 adds telemetry, not policy.
- **Step 10 (position exits) inherits the same pattern.** §11.2
  / §11.3 will likely call for analogous columns
  (`is_exit`, `exit_age_bucket`, `pnl_pct_bucket`,
  `sold_bought_ratio_bucket`); this ADR's helper-centralization
  approach should generalize cleanly.

## Migration

Migration 048 — purely additive ALTER TABLE on
`decision_signal_log`:

```sql
ALTER TABLE decision_signal_log ADD COLUMN is_add INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN add_age_ms INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN add_age_bucket TEXT;
ALTER TABLE decision_signal_log ADD COLUMN add_price_change_pct REAL;
ALTER TABLE decision_signal_log ADD COLUMN add_price_change_bucket TEXT;
ALTER TABLE decision_signal_log ADD COLUMN nth_buy_at_emit INTEGER;
```

Existing rows leave the new columns `NULL`. Schema mirror in
`packages/db/src/schemas/ledger.sql`. No backfill (telemetry
starts at deploy). No new index (existing
`idx_decision_signal_log_token_ts` covers the dashboard query
patterns).

## References

- Audit:
  [`docs/audits/2026-05-06-step9-position-adds.md`](../audits/2026-05-06-step9-position-adds.md)
- Spec: `06_algorithm_spec.md` v5.13 §11.1
- Pipeline: `pipeline_analysis/12_position_management.md` v5.13
- Predecessors: ADR-024 (sizing telemetry), ADR-025 (cancel
  telemetry).
