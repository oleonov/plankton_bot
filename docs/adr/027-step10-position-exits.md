# ADR-027 — Step 10: Position exits

## Status

Accepted — 2026-05-06

## Context

Step 10 of the trading pipeline ("Position exits") was audited
against the canonical algorithm spec
`research_plankton/plankton-analysis/06_algorithm_spec.md` v5.13
§11.2 (Position exits — R27 observational data) and §11.3 (D-rules
conditional validation), plus the split pipeline doc
`research_plankton/plankton-analysis/pipeline_analysis/12_position_management.md`
(v5.13, restored 2026-05-05). The audit lives at
[`docs/audits/2026-05-06-step10-position-exits.md`](../audits/2026-05-06-step10-position-exits.md).

§11.2 is **purely empirical**: it reports per-SELL-event
distributions across pnl_pct vs rolling cost basis (9 buckets:
`<-50% | -50% to -10% | -10% to 0% | 0% to +5% | +5% to +10% | +10%
to +25% | +25% to +50% | +50% to +100% | >+100%`), per-leg holding
time first-BUY-to-first-SELL (6 buckets: `<1h | 1-6h | 6-24h | 1-7d
| 7-30d | >30d`), and per-leg sold/bought-shares ratio (6 buckets:
`0% | 1-25% | 25-50% | 50-75% | 75-99% | >=100%`). It does not
prescribe when or how much to sell; that decision lives in the
runtime per ADR-011 + ADR-024's size-ladder. §11.3 reports
conditional probabilities (D1 BUY ≈ 0.96, D2 SELL ≈ 0.88, D4 SELL ≈
0.76, D7 SELL ≈ 0.59) computed against public Polymarket data — the
< 1.0 reflects the external observer's incomplete view of the bot's
behaviour. **For our runtime, P(action | condition) is 1.0 by
construction**: `evaluateDecision` returns a deterministic single
match, and any subsequent suppression is logged in
`risk_events.signal_suppressed`. §11.3 alignment is therefore
automatic.

Tangential ADRs already in place:

- **ADR-011** — Operational extensions: TTL / cancel / repost /
  cooldown / `postOnly` are operational policy.
- **ADR-024 (Step 7)** — Sizing telemetry on `decision_signal_log`
  (`sizing_rule_id`, `notional_bucket`).
- **ADR-025 (Step 8)** — Cancel telemetry on `orders`
  (`cancel_age_ms`, `cancel_age_bucket`, `fill_progress_shares`,
  `market_horizon`).
- **ADR-026 (Step 9)** — Adds telemetry on `decision_signal_log`
  (`is_add`, `add_age_ms`, `add_age_bucket`, `add_price_change_pct`,
  `add_price_change_bucket`, `nth_buy_at_emit`). Step 10 mirrors the
  same denormalize-at-emit pattern.

The audit identified five structural divergences (D1–D5) and one
recommendation (no behavioural change). This ADR maps them to D-A
through D-E:

- **D-A** locks the existing exit-emission contract (D2/D4/D5/D7
  rule matching, repricing-exit reason, sellSizeRules per state,
  un-gated risk-flow for SELLs) as canonical for v1 — answers audit
  framing (§11.2 is not prescriptive; §11.3 is automatic).
- **D-B** introduces denormalized exit telemetry on
  `decision_signal_log` — answers audit D1 / D2 / D3 / D4 / D5.
- **D-C** extends `leg_states` with three cumulative-size columns —
  `cumulative_buy_size`, `cumulative_buy_notional`,
  `cumulative_sell_size` — feeding the §11.2 sold/bought-ratio
  numerator and the lifetime BUY-VWAP fallback. The canonical cost
  basis source for `exit_pnl_pct` is `positions.avg_entry_price`
  (FIFO-recomputed after each SELL); the cumulative columns are read
  directly from `legState` for the ratio and as a fallback when
  `positionRepo` is not wired (test stubs). Answers audit D4 / D5
  data-availability gap.
- **D-D** centralizes the §11.2 bucket vocabularies in three
  domain-level helpers — answers audit D3 / D4 / D5 staleness risk.
- **D-E** records the deliberately-unwired Stage-10 dashboard
  surfaces — out of scope for this ADR but flagged for the
  forthcoming position-management dashboard panel.

§11.4 Q1 (action source for exit events without `order_id` /
`order_hash`) is not applicable to our own runtime; §11.4 Q2
(sell-size splits as partial fills vs distinct exits) is resolved by
construction: `fills.order_id` is FK-non-null, so multiple `fills`
per `order_id` are partial fills of one order, and multiple `orders`
per `(token_id, side)` are distinct SELL signals.

## Decision

### D-A — D2/D4/D5/D7 rule matching + repricing-exit reason + state-aware sellSizeRules + un-gated SELL flow is canonical for v1

The current exit-emission contract is hereby canonical:

- **Rule matching**
  (`apps/runtime/src/modules/algo-decision/algo-decision-module.ts:938-993`):
  every SELL signal originates from a single `decisionRules` match
  filtered through `SELL_ONLY = new Set(["SELL"])`. The four
  spec-recognized SELL rules — D2, D4, D5, D7 — are evaluated
  against the leg's S1/S2/S3 state plus price/timing context.
  Both the regular path (live leg with active selection) and the
  preserved-only exit-only path (delisted-but-held leg) use the
  same `matchRule(ctx, this.decisionRules, SELL_ONLY)` helper. A
  no-match on the preserved path emits the
  `preserved-only-no-sell-rule` suppression code.
- **Reason** (`packages/domain/src/algo-engine.ts:121`):
  every SELL signal carries `repricing-exit`. Sells do not branch
  through the BUY 4-tier scale ladder — `resolveSignalReason`
  returns `repricing-exit` unconditionally for `side === "sell"`.
- **Sizing** (`apps/runtime/src/modules/algo-decision/algo-decision-module.ts:1028-1043`):
  `evaluateSize` consults `this.sellSizeRules` (loaded via
  `algoRulesRepo.getSizeRules("SELL")`) for SELL signals. Notional
  is state-specific and may differ across S1/S2/S3 per the §4
  per-state sizing tables.
- **Risk-gate flow**
  (`apps/runtime/src/modules/risk-inventory/algo-risk-gate.ts:31-77`):
  SELL signals traverse the same gate as BUYs but are not blocked
  by either layer — Layer 1's open-buy-order dedupe matches `side
=== "buy"` only, and Layer 2's open-position-exists check applies
  only to `signal.reason ∈ NEW_ENTRY_REASONS = { ProbeEntry }`.
  SELL signals therefore reach the order pipeline directly,
  modulo wallet-budget and execution-policy checks downstream.
- **No `n_sells` cap; no first-sell-vs-add-sell branching.** Every
  SELL fill increments `legState.sellCount`; the leg is cleared
  only on full exit (size = 0) via the position-settler path.

Justification:

- **§11.2 is empirical, not prescriptive.** The spec reports
  observed exit-event distributions across 37,274 SELL events but
  does not publish a deterministic exit-trigger rule. Operational
  decisions remain with the runtime per ADR-011.
- **§11.3 is satisfied by construction.** The < 1.0 conditional
  probabilities reflect the external observer's view; our
  deterministic `matchRule` plus separate suppression telemetry
  yield exact P(action | condition) = 1.0 in `decision_signal_log`
  modulo risk-gate suppressions which are tracked in
  `risk_events.signal_suppressed`.
- **§11.2 holding-time distribution is broad-tailed (43.82% <1h,
  0.91% >30d).** No fixed-cap exit policy would match this
  distribution; instead, the existing rule-and-state matrix
  emerges the broad tail naturally as different state transitions
  become eligible at different horizons.

### D-B — Denormalize exit telemetry onto `decision_signal_log` (audit D1 / D2 / D3 / D4 / D5)

Migration 049 adds eight nullable columns to `decision_signal_log`:

- `is_exit INTEGER` (0/1) — `1` when `side = 'SELL'` and the leg
  state exists at signal-emit time; `0` for non-SELL signals; `NULL`
  for SELL on missing leg (defensive — should not occur in practice
  since SELL-without-leg is rejected upstream).
- `is_first_sell INTEGER` (0/1) — `1` when `is_exit = 1` AND
  `legState.sellCount === 0`; `0` for subsequent SELLs on the same
  leg; `NULL` for non-SELL signals. Imperfect-but-pragmatic: a SELL
  signal whose first fill arrives between two SELL emits will record
  `is_first_sell = 1` on both. The §11.2 first-SELL distribution is
  fill-based; analysts can deduplicate by `MIN(signal_timestamp)
PER token` if perfect alignment is needed.
- `holding_time_ms INTEGER` — `signalTs - legState.firstTradeAt` in
  milliseconds. Populated for **every** SELL signal (not just first
  SELL) so subsequent-SELL latency distributions can be studied; for
  §11.2 specifically, filter `WHERE is_first_sell = 1`. `NULL` for
  non-SELL signals or when `firstTradeAt` is missing/unparseable.
  Negative deltas (clock skew / future `firstTradeAt`) stay `NULL`
  rather than collapsing into "<1h" — bucket lower bound is 0ms
  inclusive (mirrors ADR-026 `add_age_ms` handling).
- `holding_time_bucket TEXT` — one of the 6 §11.2 strings (`<1h`,
  `1-6h`, `6-24h`, `1-7d`, `7-30d`, `>30d`) or `NULL`.
- `exit_pnl_pct REAL` — `(price - costBasis) / costBasis` where
  `costBasis` is sourced from `positions.avg_entry_price` (the
  rolling per-share basis recomputed via FIFO from remaining lots in
  `inventory-handler.ts` after each SELL fill). When the position
  row is unavailable (test stubs, control-only deployments) the
  emitter falls back to the lifetime VWAP
  `legState.cumulative_buy_notional / legState.cumulative_buy_size`,
  which only matches `avg_entry_price` on the first SELL — afterwards
  FIFO deductions diverge it. Populated only when `is_exit = 1` AND
  `costBasis > 0`. `NULL` otherwise (non-SELL, missing leg, zero
  basis, or zero-cost-basis edge case).
- `exit_pnl_bucket TEXT` — one of the 9 §11.2 strings (`<-50%`,
  `-50% to -10%`, `-10% to 0%`, `0% to +5%`, `+5% to +10%`, `+10% to
+25%`, `+25% to +50%`, `+50% to +100%`, `>+100%`) or `NULL`.
- `sold_bought_ratio REAL` — `cumulative_sell_size /
cumulative_buy_size`. Populated only when `is_exit = 1` AND
  `cumulative_buy_size > 0`. `NULL` otherwise. The ratio is the
  pre-this-SELL state — observational across SELL events.
- `sold_bought_ratio_bucket TEXT` — one of the 6 §11.2 strings
  (`0%`, `1-25%`, `25-50%`, `50-75%`, `75-99%`, `>=100%`) or `NULL`.

All eight are nullable; persistence happens in
`SqliteDecisionSignalLogRepository.insert` inside the same prepared
statement that already writes the Step-7 sizing telemetry and Step-9
adds telemetry. No second `UPDATE` round-trip; no race window.

The `is_exit` denormalization is intentional even though `side =
'SELL' AND legState IS NOT NULL` is computable: it guarantees a
single boolean dashboard surface, removes the join-with-leg_states
trap (which mutates on close+reopen), and makes the column directly
indexable for time-bucketed exits-rate metrics.

The `exit_pnl_pct` raw value is preserved alongside the bucket
(matching the ADR-026 `add_price_change_pct` pattern) so the §11.2
distribution can be re-binned at query time without information loss.

### D-C — Extend `leg_states` with cumulative-size columns (audit D4 / D5 data availability)

Migration 050 adds three NOT NULL columns (DEFAULT 0) to `leg_states`:

- `cumulative_buy_size REAL NOT NULL DEFAULT 0` — running sum of
  every BUY fill's `size` (shares).
- `cumulative_buy_notional REAL NOT NULL DEFAULT 0` — running sum
  of every BUY fill's `size_usdc` (cash delivered, USDC), with
  fallback to `price * size` for legacy fills missing `size_usdc`.
  This is the lifetime BUY-VWAP numerator and mirrors
  `inventory-handler.ts`'s `unitCost = sizeUsdc / size`, so
  `cumulative_buy_notional / cumulative_buy_size` matches
  `positions.avg_entry_price` only on the first SELL — afterwards
  the inventory engine recomputes `avg_entry_price` from remaining
  FIFO lots, so `exit_pnl_pct` sources the rolling basis from
  `positions.avg_entry_price` directly (this column stays as audit
  telemetry / fallback).
- `cumulative_sell_size REAL NOT NULL DEFAULT 0` — running sum of
  every SELL fill's `size` (shares). The denominator stays
  `cumulative_buy_size` per §11.2's "sold/bought" framing — a leg
  that sold more than it bought (>=100% bucket) is the spec's
  expected long-tail behaviour.

`updateLegStateForFill`
(`apps/runtime/src/modules/leg-state/update-leg-state-for-fill.ts:48-136`)
is the single chokepoint for both live tracking and startup-replay.
For new legs and tokens without an existing `leg_states` row, the
helper accumulates size + notional automatically via
`rebuildLegStatesFromLedger` on every bot restart.

For legs that already have a `leg_states` row (the common
production case at deploy time), the cumulative columns are
backfilled in-place via SQL:

- Migration 050 runs an `UPDATE leg_states SET cumulative_*` SUM
  query against `fills`, scoped by
  `filled_at >= leg_states.first_trade_at` so prior closed-out
  legs on the same token don't leak into the active leg's
  aggregates.
- The split-ledger path (which uses `safeAddColumn` rather than
  `runMigrations`) executes the same backfill via
  `backfillLegStateCumulativeFromFills(conn.db)` in
  `bootstrapLedgerDb`. The backfill is idempotent: a
  `WHERE cumulative_buy_size = 0` guard prevents subsequent boots
  from clobbering values that have since been accumulated by live
  fills.

`fill.size`, `fill.price`, and `fill.sizeUsdc` are all part of
`LegStateFillInput` (both live event handlers and the
ledger-replay path populate them) — no upstream API changes
needed.

### D-D — Centralize §11.2 bucket vocabularies in three helpers

Three new helpers join the existing five (`classifyAddAgeBucket`,
`classifyAddPriceChangeBucket`, `classifyCancelAgeBucket`,
`classifyNotionalBucket`, `classifyEntryPriceBucket`):

- `classifyExitPnlBucket(pct: number | null): ExitPnlBucket | null`
  in `apps/runtime/src/executable-price.ts`.
  Boundaries (in fraction units, e.g. `-0.5` for `-50%`):
  ```
  (-∞, -0.50)         → "<-50%"
  [-0.50, -0.10)      → "-50% to -10%"
  [-0.10,  0.00)      → "-10% to 0%"
  [ 0.00,  0.05)      → "0% to +5%"
  [ 0.05,  0.10)      → "+5% to +10%"
  [ 0.10,  0.25)      → "+10% to +25%"
  [ 0.25,  0.50)      → "+25% to +50%"
  [ 0.50,  1.00)      → "+50% to +100%"
  [ 1.00, ∞)          → ">+100%"
  ```
  `null` for non-finite or null inputs. Bucket names mirror §11.2
  table headers exactly.
- `classifyHoldingTimeBucket(ms: number | null): HoldingTimeBucket
| null` in the same module. Boundaries (closed-open, in ms):
  ```
  [0, 3_600_000)            → "<1h"
  [3_600_000, 21_600_000)   → "1-6h"
  [21_600_000, 86_400_000)  → "6-24h"
  [86_400_000, 604_800_000) → "1-7d"
  [604_800_000, 2_592_000_000) → "7-30d"
  [2_592_000_000, ∞)        → ">30d"
  ```
  `null` for negative, non-finite, or null inputs. Note these
  boundaries differ from `classifyAddAgeBucket` (§11.1.2 uses
  `<60s | 1-5min | 5-30min | 30min-1h | 1-3h | 3-12h | 12-24h |
1-7d | >7d` — finer-grained at the short tail) and from
  `classifyCancelAgeBucket` (§12.1).
- `classifySoldBoughtRatioBucket(ratio: number | null):
SoldBoughtRatioBucket | null` in the same module. Boundaries
  (closed-open, in fraction units):
  ```
  [0, 0.01)         → "0%"   (treats <1% as zero per spec)
  [0.01, 0.25)      → "1-25%"
  [0.25, 0.50)      → "25-50%"
  [0.50, 0.75)      → "50-75%"
  [0.75, 0.99)      → "75-99%"
  [0.99, ∞)         → ">=100%" (≥99% rounds up per spec; covers ≥100% naturally)
  ```
  `null` for negative, non-finite, or null inputs. Bucket names
  mirror §11.2 table headers exactly. The `<1%` collapsing into
  the `"0%"` bucket and the `≥99%` collapsing into `">=100%"`
  reflect the spec's coarse rounding (§11.2 reports "0%" /
  ">=100%" rather than fine-grained sub-1% / 99-100% buckets).

All three helpers are pure functions with no `Date.now()`
dependency, so production-equivalent unit tests verify boundary
behaviour deterministically. Branded types `ExitPnlBucket`,
`HoldingTimeBucket`, `SoldBoughtRatioBucket` are exported from
`@plankton/domain` so persistence and analytics share the same
vocabulary.

Computed once at row-write time; not re-derived at query time, so
dashboards stay schema-stable across future bucket-taxonomy
revisions.

### D-E — Stage-10 dashboard surface deferred to position-management panel

Surfacing the §11.2 distributions in the API DTO and web UI is
**out of scope** for Step 10. Operators query
`decision_signal_log` directly via the read-only DB tunnel until
the position-management dashboard panel lands. Rationale matches
ADR-026 §D-D: shipping a single coherent operator view of position-
management observations (Steps 8 / 9 / 10 telemetry combined)
beats three half-finished panels.

The columns are immediately useful via SQL:

```sql
-- §11.2 holding-time distribution for first-SELL events
SELECT holding_time_bucket, COUNT(*)
FROM decision_signal_log
WHERE is_first_sell = 1
GROUP BY 1;

-- §11.2 pnl distribution across all SELL events
SELECT exit_pnl_bucket, COUNT(*)
FROM decision_signal_log
WHERE is_exit = 1
GROUP BY 1;

-- §11.3 P(SELL | D2)
SELECT decision_rule_id, AVG(is_exit) AS p_sell
FROM decision_signal_log
WHERE side = 'SELL' AND decision_rule_id IN ('D2', 'D4', 'D7')
GROUP BY 1;
```

## Consequences

### Positive

- **§11.2 dashboard becomes one query.** Every signal-emit row now
  carries the three §11.2 distributions denormalized; no join
  against `leg_states` (which can drift after restarts), no
  client-side bucket logic, no per-row `avgEntryPrice` lookup
  against `positions`.
- **§11.3 alignment is automatic and queryable.** P(action |
  condition) = 1.0 by construction; the new `is_exit` flag plus
  existing `decision_rule_id` lets analysts compute the full §11.3
  table from a single SQL aggregation.
- **Production drift is visible at canonical granularity.** §11.2's
  exact bucket boundaries are preserved, so the live distribution
  can be A/B'd against the v5.13 reference numbers without
  re-binning.
- **Cost basis and sold/bought-ratio computation lives where the
  data is mutated.** Cumulative sizes update inside
  `updateLegStateForFill` — the same single chokepoint that already
  manages `buy_count` / `sell_count`. The sold/bought ratio reads
  the leg's cumulative sizes directly. `exit_pnl_pct` reads the
  rolling cost basis from `positions.avg_entry_price` (FIFO-rebased
  by the inventory engine on each SELL) so partial-sell legs stay
  accurate; the lifetime cumulative VWAP is preserved as audit
  telemetry and fallback for tests / control-only deployments.
- **Bucket vocabulary is centralized.** Three new helpers join the
  Step-7 / Step-8 / Step-9 helpers; future contributors find them by
  proximity, and any future bucket-taxonomy revision lands in one
  place.
- **No behavioural change.** Exit emission, sizing, rule matching,
  and risk gating are unchanged. Production load is eight extra
  nullable columns per `decision_signal_log` row plus three on
  `leg_states`; measured ~1.5KB/row at current emit volume, well
  below the retention window.

### Negative

- **Cumulative-size columns depend on `leg_states` staying intact
  across restarts.** A leg row cleared by close-and-reopen resets
  the cumulative counters; subsequent telemetry references the new
  cumulative_*. This matches the production semantics of `legState`
  already used by the reason ladder, so it is alignment with §11.1
  Step-9 caveats, not regression — but operators querying long-
  horizon §11.2 distributions must restrict to legs that haven't
  been reset.
- **Eight new nullable columns on a hot table.** Every emit pays
  eight extra `?` placeholders; no measurable latency at current
  volume but worth retaining the option to drop columns if the
  decision_signal_log retention window is lifted.
- **`is_first_sell` is fill-not-signal precise.** A SELL signal
  emitted while a prior SELL is in-flight (open + unfilled) will
  record `is_first_sell = 1` on both. Analysts who need
  signal-precise first-SELL must deduplicate downstream. The
  alternative (signal-counter on `leg_states`) doubles the schema
  surface for marginal value; we accept the documented imperfection.
- **Cumulative-size backfill happens only on next restart.**
  Existing leg rows at deploy time have `cumulative_* = 0` until
  the next `runStartupPositionAdoption` cycle replays the ledger.
  Operators must trigger a restart post-deploy to materialize
  historical cumulative values; the deploy doc captures this
  caveat.

### Neutral

- **No new ADR-011 conflict.** Operational decisions about exits
  (whether to sell, size of sell, rate-limit) remain owned by the
  runtime. Step 10 adds telemetry, not policy.
- **Future Step (post Step 10) inherits the same pattern.** The
  next pipeline steps (§12-§15 covering order lifetime, refined
  pricing, soft ranking, discovery channel) will likely call for
  analogous columns; this ADR's helper-centralization +
  leg_states-data-cache approach generalizes cleanly.

## Migration

Migration 049 — purely additive ALTER TABLE on `decision_signal_log`
+ `leg_states`:

```sql
-- decision_signal_log: §11.2 / §11.3 exit telemetry.
ALTER TABLE decision_signal_log ADD COLUMN is_exit INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN is_first_sell INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN holding_time_ms INTEGER;
ALTER TABLE decision_signal_log ADD COLUMN holding_time_bucket TEXT;
ALTER TABLE decision_signal_log ADD COLUMN exit_pnl_pct REAL;
ALTER TABLE decision_signal_log ADD COLUMN exit_pnl_bucket TEXT;
ALTER TABLE decision_signal_log ADD COLUMN sold_bought_ratio REAL;
ALTER TABLE decision_signal_log ADD COLUMN sold_bought_ratio_bucket TEXT;

-- leg_states: cumulative buy/sell sizes for cost basis + ratio.
ALTER TABLE leg_states ADD COLUMN cumulative_buy_size REAL NOT NULL DEFAULT 0;
ALTER TABLE leg_states ADD COLUMN cumulative_buy_notional REAL NOT NULL DEFAULT 0;
ALTER TABLE leg_states ADD COLUMN cumulative_sell_size REAL NOT NULL DEFAULT 0;
-- one-time backfill (idempotent via cumulative_buy_size = 0 guard).
UPDATE leg_states SET
  cumulative_buy_size     = SUM(fills.size where side='buy'),
  cumulative_buy_notional = SUM(fills.size_usdc OR price*size where side='buy'),
  cumulative_sell_size    = SUM(fills.size where side='sell')
  scoped by filled_at >= first_trade_at,
  guarded by cumulative_buy_size = 0;
```

Existing rows leave the new `decision_signal_log` columns `NULL`.
`leg_states` cumulative columns default to `0` then are populated
in-place: migration 050 runs the SQL UPDATE on the
`runMigrations` path, and `bootstrapLedgerDb` runs the equivalent
`backfillLegStateCumulativeFromFills(...)` on the split-ledger
`safeAddColumn` path so deployed bots get backfill on first
restart without losing live-accumulated values on subsequent
restarts. Schema mirror in `packages/db/src/schemas/ledger.sql`.
No new index (existing `idx_decision_signal_log_token_ts` and the
leg primary key cover the dashboard query patterns).

## References

- Audit:
  [`docs/audits/2026-05-06-step10-position-exits.md`](../audits/2026-05-06-step10-position-exits.md)
- Spec: `06_algorithm_spec.md` v5.13 §11.2 / §11.3 / §11.4
- Pipeline: `pipeline_analysis/12_position_management.md` v5.13
- Predecessors: ADR-024 (sizing telemetry), ADR-025 (cancel
  telemetry), ADR-026 (adds telemetry).
