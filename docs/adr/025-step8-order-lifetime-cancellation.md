# ADR-025 — Step 8: Order lifetime / cancellation

## Status

Accepted — 2026-05-06; resolution-stop-window timestamp behavior superseded by
ADR-028 (2026-05-15)

## Context

Step 8 of the trading pipeline ("Order lifetime / cancellation") was
audited against the canonical algorithm spec
`research_plankton/plankton-analysis/06_algorithm_spec.md` v5.13 §12
(R28 same-price clustering, R32 5-trade direct-orderbook
reconstruction) plus the split pipeline doc
`research_plankton/plankton-analysis/pipeline_analysis/13_order_lifetime_cancellation.md`
(v5.13, restored 2026-05-05). §8 #3 is the [OPEN_QUESTION] hook for
"Direct cancellation events and unfilled order lifetime". The audit
lives at
[`docs/audits/2026-05-06-step8-order-lifetime-cancellation.md`](../audits/2026-05-06-step8-order-lifetime-cancellation.md).

§12 is **purely empirical**: it reports same-price gap and span
distributions across 24,429 unique `(condition, outcome, price)` BUY
triples (median span 278s, p90 90,853s); price-change distribution
across 52,220 consecutive BUY pairs (71.34% same-price); same-second
block analysis across 52,281 events (99.99% single-price);
R8 resting-bid persistence at 6–24h / 1–7d / >7d horizons; and a
55-trade R32 sample that cannot directly observe cancellations from
the public activity feed. §12 does not prescribe TTLs, cancel rates,
or replace cadences — those decisions live entirely in
ADR-011 / ADR-013 / ADR-015 as operational policy.

Tangential ADRs already in place:

- **ADR-006** — Execution price policy (edge mode default; one
  formula across all modes).
- **ADR-011** — Operational extensions: declares TTL / cancel /
  repost / cooldown / `postOnly` as **operational policy** owned by
  the runtime, not by the canonical spec. v2.3 of `07_algorithm_gaps.md`
  lists "Open order lifecycle (TTL / cancel / repost / cooldown)" as
  No-Evidence — no spec-derived constants exist, so the runtime is
  the author of record.
- **ADR-013** — Bumped `EXIT_ORDER_TTL_MS` from 60s to 300s after
  observing 80/90 prod losing legs resolving without any SELL fill.
- **ADR-014** — Bounded-midpoint price improvement (per-tick reprice
  upgrade for SELL; no cancel cadence change).
- **ADR-015** — DB-backed execution policy: lifted `EXIT_ORDER_TTL_MS`
  and `entryPriceCeiling` into `execution_policy_json`. **Entry TTL
  ladder (`HORIZON_TTL_MS`, `PROBE_LIKE_*`) and the unfilled-cancel
  cooldown (`MAX_UNFILLED_CANCELS_BEFORE_COOLDOWN`,
  `UNFILLED_CANCEL_COOLDOWN_MS`) remain hardcoded.**

No prior ADR addresses §12 head-on. This ADR is the first
order-lifetime contract. It codifies the current de-facto GTC +
horizon-keyed entry TTL ladder + 300s exit TTL + 10m unfilled-cancel
cooldown as canonical for v1, propagates cancellation telemetry on
every cancelled order, tightens the `CancelOrderCommand.reason`
union, removes the dead `OrderStatus.Expired` enum value, and
explicitly defers two operational decisions (pause-time semantics,
`cancelAllOrders` wiring). **No behavioural change to TTLs,
cooldowns, cancel cadences, or replace policies.**

The audit identified seven structural divergences (D1-D7) and five
open questions (Q1-Q5). This ADR maps them to D-A through D-G:

- **D-A** locks ADR-011 / ADR-013 / ADR-015 as the canonical operational
  baseline — answers audit framing (§12 is not prescriptive) and
  records §12.1 / §12.3 / §12.4 empirical alignment.
- **D-B** introduces cancellation telemetry on every cancelled order
  — answers audit D1 (no cross-cancel rollup) and Q1 (§8 #3 closure).
- **D-C** tightens the `CancelOrderCommand.reason` union — answers
  audit D2 (9 declared-unused literals) and D3 (phantom-cancel
  bypasses the typed union).
- **D-D** removes `OrderStatus.Expired` from the enum — answers
  audit D5 (dead enum) and Q4 (remove or wire).
- **D-E** documents the no-cancel-on-pause / no-cancel-on-shutdown
  policy and the deliberately-unwired `cancelAllOrders` — answers
  audit D7 (zero callers) and Q2 / Q5 deferral.
- **D-F** defers DB-tunable entry TTL ladder migration — answers
  audit D6 (asymmetric DB-tunability) and Q3.
- **D-G** documents the reconciler's stale-exchange branch
  not writing a separate `cancel_reason` — answers audit D4
  (no double-row) without code change.

Audit Q1 (§8 #3 closure) follows directly from D-B telemetry once
sufficient production data accumulates and is not closed here.
Q2 (pause-time policy) and Q5 (`cancelAllOrders` wiring) remain
deferred per D-E.

## Decision

### D-A — GTC + horizon-keyed entry TTL ladder + 300s exit TTL + 10m unfilled-cancel cooldown is canonical for v1 (audit framing / spec §8 #3)

The current operational policy seeded across
`signal-to-order.ts:480-489`, `stale-order-cleaner.ts:18-35`,
`signal-to-order.ts:58-59`, and `execution-module.ts:756-826` is
hereby canonical:

- **Order type.** Every order is `orderType: "GTC"`. No GTD / FOK
  path is wired. `postOnly: true` is set only on the live-lite
  relayer wallet path (`signal-to-order.ts:481`); sim/paper/EOA-live
  send `postOnly: undefined`.
- **Entry TTL ladder** (`stale-order-cleaner.ts:18-25`):
  `intraday-4h` → 45m, `daily` → 6h, `deadline` → 24h, `ad-hoc` →
  8h, default → 6h. Probe-like horizons (`probe-like-intraday-4h` /
  `probe-like-daily` / `probe-like-ad-hoc`) → 60s / 5m / 10m
  respectively.
- **endDate safety window.** `ENDDATE_SAFETY_WINDOW_MS = 60m` —
  every entry BUY whose host market is within 60m of `endDate` is
  cancelled with reason `stale_entry_enddate` regardless of TTL
  remaining.
- **Exit TTL.** `EXIT_ORDER_TTL_MS = 300s` (ADR-013), DB-tunable via
  `execution_policy_json.exitOrderTtlMs` (ADR-015). Exit SELLs
  older than the configured value are cancelled with reason
  `stale_exit_ttl`.
- **Per-order cancel backoff.** `CANCEL_BACKOFF_MS = 60s` —
  same-orderId re-cancellation is suppressed for 60s after issue.
- **Per-token unfilled-cancel cooldown.**
  `MAX_UNFILLED_CANCELS_BEFORE_COOLDOWN = 3`,
  `UNFILLED_CANCEL_COOLDOWN_MS = 10m`. After 3 unfilled entry
  cancels on the same token, new entry signals for that token are
  suppressed until cooldown lapses. State cleared on successful
  fill or cooldown expiry.
- **SELL reprice cadence.** Cancel-and-replace via
  `deferSellReplacementIfNeeded` (`execution-module.ts:756-826`)
  with reasons `sell_replace_reprice` / `sell_replace_retry`. **BUYs
  have no equivalent reprice path** — they ride the TTL or fill.
- **In-flight gate.** `pendingEntries: Map<TokenId, PendingEntry>`
  in `algo-decision-module.ts:297` caps in-flight BUY signals at
  one per token. Architecturally enforces single-price-per-token-side.

Justification:

- **§12 is empirical, not prescriptive.** §12.1 / §12.2 / §12.3 /
  §12.4 / §12.5 / §12.6 report observed distributions; they do not
  publish a deterministic TTL ladder, cancel rate, or replace
  cadence that would let the bot replace ADR-011 / ADR-013 / ADR-015.
  The runtime is the author of record per ADR-011.
- **§12.3 architectural alignment.** R28 falsifies the
  multi-price-same-block hypothesis: 99.99% of same-second BUY
  blocks have a single distinct price; the six 2-price blocks are
  not 0.001 / 0.002 / 0.003 ladders. `pendingEntries` enforces
  single-price-per-token-side **by construction** — the bot is
  structurally incapable of emitting a multi-price ladder, and §12.3
  confirms reference does not either. This is alignment, not
  divergence.
- **§12.1 distribution alignment.** Median consecutive same-price
  gap = 10s, median span = 278s; 26.37% of same-price gaps are
  block-mate (gap = 0s), 41.44% are 1–60s, 13.06% are 1–10min.
  Our intraday-4h entry TTL (45m = 2,700s) sits between median span
  (278s) and p90 span (90,853s) — well inside the empirical
  distribution. Our 300s exit TTL aligns with the 1–60s + 1–10min
  buckets that capture 54.5% of same-price gap mass.
- **§12.4 deadline-horizon alignment.** R8 resting-bid persistence
  at 6–24h horizon: 4 markets with size > 0 at last_buy_price, 4
  with size = 0. Our deadline-horizon TTL (24h) sits at the lower
  edge; `ENDDATE_SAFETY_WINDOW_MS = 60m` terminates the long tail
  explicitly before the market resolves.
- **ADR-013 forensic warrant.** The 300s exit TTL is grounded in the
  pre-ADR-013 89% loser-leg-leak observation. Reverting to a tighter
  cadence has no spec-derived support; reverting to a looser cadence
  would re-open the leak.
- **No behavioural change.** Telemetry first. D-B propagates
  cancellation lifecycle data on every cancelled order so a future
  revision can ground any TTL / cooldown / replace-cadence change in
  observed production signal rather than re-derive it from §12
  reference distributions.

A follow-up audit may revisit the constants once a 7-day
`order_lifecycle_observations` rollup of `cancel_age_bucket` and
`fill_progress_shares` distributions can be compared against §12.1's
same-price gap distribution. The current ladder + cooldown + replace
cadence stay canonical until that read forces a decision.

### D-B — Cancellation telemetry on every cancelled order (audit D1 / spec §8 #3, Q1)

Four columns are added to the `orders` table, populated on every
transition into the `cancelled` terminal state:

- **`cancel_age_ms INTEGER`** — `Date.now() − new
Date(order.createdAt).getTime()`, computed at the cancel-write
  call site. Nullable when the row pre-dates the migration; populated
  for every cancel issued after migration 047.
- **`cancel_age_bucket TEXT`** — categorical string in the §12.1
  taxonomy: `<1min`, `1-10min`, `10min-1h`, `1-6h`, `6-24h`,
  `1-7d`, `>7d`. Computed from `cancel_age_ms` at row-write time
  via a pure helper `classifyCancelAgeBucket(ageMs)`. Nullable when
  `cancel_age_ms` is null or non-finite.
- **`fill_progress_shares NUMERIC`** — sum of `fills.shares` across
  all fills referencing this `order_id` at cancel time. Captures
  cancelled `partially-filled` orders alongside cancelled `open`
  orders. Nullable when the fills lookup fails (e.g. fills repo
  unavailable in a degraded mode); populated as 0 when the order
  was never partially filled.
- **`market_horizon TEXT`** — denormalized horizon classification
  for the host market (`intraday-4h`, `daily`, `deadline`, `ad-hoc`,
  `probe-like-*`). Reads from the in-memory market metadata cache
  (`marketRepo.findByTokenId(tokenId)?.horizon`). Nullable when the
  market lookup fails; populated for every successful resolution.

Both telemetry and the cancellation status update happen in the
same `orderRepo.updateStatus(...)` call — no second write, no
race window between status flip and telemetry rowing.

The seven §12.1 buckets are preserved exactly so production drift
across the gap distribution is visible at the same granularity §12
reports.

Telemetry persists across all four `cancelled`-writing call sites:

- `executeCancel` happy path (`execution-module.ts:559-597`) — covers
  every reason in `CancelOrderCommand.reason` (`market_resolved`,
  `stale_entry_ttl`, `stale_entry_enddate`, `stale_exit_ttl`,
  `sell_replace_reprice`, `sell_replace_retry`, `operator`).
- Phantom path (`order-reconciler.ts:63`) — `phantom_missing_on_exchange`.
- Resolution-module local-pending path (`resolution-module.ts:710`)
  — covers `pending` orders without `exchangeOrderId` cancelled
  locally without a gateway round-trip.
- User-order-stream WS cancel path
  (`user-order-stream-module.ts:304`) — first-time WS-driven
  cancel writes `cancel_reason = "exchange-user-ws-cancelled"`
  with full telemetry. Subsequent dedup'd echoes call the
  3-arg `updateStatus` form so prior reason and telemetry
  are preserved.

The persisted `orders.cancel_reason` vocabulary is therefore
broader than `CancelOrderCommand.reason`:
`CancelOrderCommand.reason` is the bus-command union (8 literals,
§D-C); `orders.cancel_reason` additionally accepts the WS-only
literal `"exchange-user-ws-cancelled"`, which has no command
counterpart because the cancel originated on the exchange (no
local intent).

Computed once at row-write time; not re-derived at query time so
dashboards stay schema-stable across future bucket-taxonomy revisions.

### D-C — Tighten `CancelOrderCommand.reason` union (audit D2 / D3)

The union at `packages/domain/src/commands.ts:63-79` is rewritten
to enumerate exactly the production-reachable reasons plus the
phantom-bypass reason explicitly:

```ts
type CancelReason =
  | "market_resolved"
  | "stale_entry_ttl"
  | "stale_entry_enddate"
  | "stale_exit_ttl"
  | "sell_replace_reprice"
  | "sell_replace_retry"
  | "operator"
  | "phantom_missing_on_exchange";
```

Removed (declared-unused, no production caller):

- `strategy_exit`, `risk_breach`, `shutdown`, `reconciliation`,
  `entry-reprice-cancel`, `entry-suppress-cancel`,
  `exit-reprice-cancel`.
- `entry-ttl-cancel` (kebab-case typo-duplicate of `stale_entry_ttl`).
- `exit-ttl-cancel` (kebab-case typo-duplicate of `stale_exit_ttl`).

Added (currently bypasses the union):

- `phantom_missing_on_exchange` — written by the reconciler at
  `order-reconciler.ts:63` directly into `orders.cancel_reason`
  without publishing a `CancelOrderCommand`. The literal is added
  to the union with a code comment noting that this reason is
  written from the reconciler's direct-DB path (no
  `CancelOrderCommand` exists for it because the order is already
  gone on the exchange — there is nothing to cancel via the bus).

Justification:

- **Type-as-documentation.** The current union enumerates 16 reasons,
  9 of which have no production caller. A reader cannot distinguish
  "intended reason that happens to be unreached today" from "dead
  literal". Pruning to 8 leaves the union as accurate documentation
  of the runtime cancel-reason vocabulary.
- **Phantom is the only bus-bypass case.** Modelling it explicitly in
  the union (rather than as an "any string" escape hatch) preserves
  the type-safety property without sacrificing the architectural
  reality that the reconciler's phantom path mutates the local row
  directly.
- **Migration is type-only.** No DB constraint references the old
  literal strings; existing rows with values like `entry-ttl-cancel`
  (if any) survive as opaque strings. Any analytics dashboard
  filtering on `cancel_reason` must coordinate the rename — flagged
  in Consequences.

### D-D — Remove `OrderStatus.Expired` from the enum (audit D5 / Q4)

`packages/domain/src/enums.ts:127` declares `Expired: "expired"`.
No production code path writes this value to the local `orders.status`
column. Polymarket GTC has no built-in expiry; FOK `expired`
exchange-side surfaces via the reconciler's stale-exchange branch
mapped onto the local terminal status the bot already recorded.
The web-UI `"expired"` concept (`apps/web/src/pages/positions/lib.ts`)
refers to market endDate elapsed, not order status, and is unrelated.

`Expired` is removed from the enum. Consumer code is reviewed to
confirm no exhaustiveness check (`switch` over `OrderStatus`) breaks;
no test references the value.

Justification:

- **Dead by construction.** Polymarket GTC orders cannot expire on
  the exchange. The runtime never places FOK. There is no incoming
  exchange→local mapping that would write `expired`. Removing the
  value eliminates a misleading documentation surface without
  removing capability.
- **Reversibility.** If a future feature adds FOK orders, the enum
  value can be re-introduced in the same migration that wires the
  exchange→local FOK-expired translation. Removing it now does not
  foreclose that path.

### D-E — No cancel-on-pause / no cancel-on-shutdown / `cancelAllOrders` deliberately unwired (audit D7 / Q2, Q5)

Current behaviour is hereby documented and retained for v1:

- **Pause** (`execution-module.ts:201-204`) rejects new placements
  but leaves resting orders alive. There is no cancel-on-pause path.
- **Shutdown** (SIGTERM/SIGINT) does not cancel resting orders.
  The supervisor's `stop()` chain reverses module startup but does
  not reach into the gateway.
- **`cancelAllOrders`** (`live/exchange-gateway.ts:219-227`) exists
  on the `ExchangeGateway` interface and calls `client.cancelAll()`.
  Zero production callers. Mocked in 11 test files but never invoked
  from runtime modules.

Justification for retention:

- **Pause-time policy is operator-defined, not spec-defined.**
  Two reasonable defaults exist:
  - **`retain`** (current): a brief operator-pause for inspection
    should not abandon profitable resting bids.
  - **`cancel`**: an extended pause leaves stale prices in the book
    that may execute against stale state when the bot resumes.
    §12 provides no empirical support for either default. The
    operator has not requested the alternative.
- **Shutdown-time cancel is contingent on Q2.** If pause-time
  semantics flip to `cancel`, shutdown should follow suit. Wiring
  shutdown in isolation pre-commits the `cancel` choice.
- **`cancelAllOrders` deliberately unwired.** Removing it would
  foreclose the three candidate callers (shutdown, pause, operator
  emergency). Wiring it now pre-commits Q2.

Q2 (pause-time policy) and Q5 (`cancelAllOrders` wiring) remain
deferred to a future ADR. If/when the operator requests
cancel-on-pause, the implementation lifts
`pauseCancelMode: "retain" | "cancel"` into `execution_policy_json`
(default `"retain"` matching today) and wires `cancelAllOrders`
behind the `"cancel"` branch.

### D-F — Defer DB-tunable entry TTL ladder migration (audit D6 / Q3)

Current behaviour — `HORIZON_TTL_MS`, `PROBE_LIKE_*`,
`ENDDATE_SAFETY_WINDOW_MS`, `CANCEL_BACKOFF_MS` are `export const`
in `stale-order-cleaner.ts:18-35`; only `EXIT_ORDER_TTL_MS` was
lifted into `execution_policy_json` by ADR-015 — is hereby retained.

Justification for deferral:

- **No forensic warrant yet.** ADR-015's exit-TTL lift was triggered
  by ADR-013's quantitative observation (89% loser-leg leak from the
  prior 60s exit cadence). The entry ladder has produced no such
  data point.
- **D-B telemetry is the warrant.** Once 7 days of
  `order_lifecycle_observations` accumulate, an entry-TTL distribution
  read can show whether the current ladder fits the production
  fill-cancel pattern or whether per-horizon adjustment is warranted.
- **Architectural cost.** A DB-tunable ladder requires a new keyed
  field on `execution_policy_json` (e.g. `entryTtlMsByHorizon: Record<Horizon, number>`),
  a migration, fallback handling for missing keys, and an
  `ExecutionPolicy` type extension. None warranted without the data.

A follow-up audit will revisit once D-B telemetry establishes the
production distribution. The hardcoded ladder stays canonical until
that read forces a decision.

### D-G — Reconciler stale-exchange branch writes no separate `cancel_reason` (audit D4)

Current behaviour — `order-reconciler.ts:92` calls
`gateway.cancelOrder({ orderId: ex.orderId })` for orders that are
locally `cancelled`/`filled` but still resting on the exchange,
without a paired `orderRepo.updateStatus` call — is hereby
documented and retained.

Justification:

- **Local row already terminal.** By definition the local `orders`
  row already has `cancelled` or `filled` status with a `cancel_reason`
  populated by the original cancel/fill path. The stale-exchange
  cancel is the **second** half of the original cancel — the local
  ledger already witnessed the intent; the gateway call cleans up
  the dangling exchange-side resting order.
- **No double-row.** Writing a second row (or extending the first)
  with `cancel_reason = "reconciliation_stale_exchange"` would
  duplicate ledger state without adding information. The original
  reason already explains why the order was cancelled.
- **Forensic completeness via per-pass counter.** A "how many
  exchange-side dangling cancels per reconciliation pass" count
  may be useful operationally but does not warrant per-row
  duplication. If/when needed, a per-pass aggregate row on a future
  `reconciliation_observations` table covers the use case.

No code change.

## Consequences

### Positive

- **§12 / §8 #3 are answered in writing.** The de-facto operational
  policy is locked as canonical with explicit acknowledgement that
  §12 is empirical-only and that ADR-011 / ADR-013 / ADR-015 are
  the authoring sources. Future pipeline-step audits can reference
  D-A rather than re-deriving the contract from runtime code.
- **D-B telemetry** lets operators measure
  cancellation-age-bucket × reason × horizon × fill-progress
  distributions in production and compare against §12.1's same-price
  gap distribution. Mirrors ADR-022 §D-D / ADR-023 §D-F / ADR-024
  §D-C / §D-D telemetry-first pattern. Closes audit Q1 / spec §8 #3
  the moment ≥ 7 days of data accumulate.
- **D-C cleanup** removes 9 declared-unused literals from the
  cancel-reason union and adds the one bypass case explicitly.
  Type-as-documentation is restored.
- **D-D dead-enum removal** eliminates a misleading
  `OrderStatus.Expired` value that no production path can reach.
- **D-E / D-F / D-G operational notes** prevent future audits from
  re-flagging cancel-on-pause / `cancelAllOrders` / asymmetric
  TTL-tunability / stale-exchange-no-row as defects. Each is
  documented with explicit Q-mapping for the deferred-decision
  contract.

### Negative / accepted trade-offs

- **§12.1 reference distribution divergence.** Our cancel-age
  distribution may not match the §12.1 reference's same-price gap
  distribution exactly — the bot's TTL ladder enforces upper bounds
  the reference apparently does not. D-B telemetry surfaces this;
  D-A defers the fix. Practical impact depends on whether reference
  is willing to leave bids resting through the > 6h tail or whether
  they cancel on the same horizons we do.
- **Cancel-reason union rename is a coordinated change.** Any
  analytics dashboard or external consumer filtering on the old
  kebab-case literals (`entry-ttl-cancel`, `exit-ttl-cancel`,
  `entry-reprice-cancel`, etc.) must be updated. Existing rows in
  `orders.cancel_reason` with those values survive as opaque
  strings.
- **`cancelAllOrders` and the 9 removed literals stay in test
  fixtures.** Removing the literals from the production union will
  force test mocks that previously typed against them to update.
  No production code is removed; the gateway interface method
  `cancelAllOrders` remains in place per D-E.
- **Pause-time and shutdown cancel are operator-policy gaps.** Until
  Q2 closes, an extended-pause operator who expects resting bids to
  be cleaned up will be surprised. Documented in D-E; no behavioural
  change.
- **D-B fills lookup adds one read per cancel.** `fill_progress_shares`
  requires a SELECT against the fills table at cancel time. Cancel
  rate is bounded by the reconciliation cadence (one pass per
  interval per token); the read is cheap. No measurable performance
  impact expected.

## Rollback plan

ADR-025 introduces no behavioural change to TTLs, cooldowns, cancel
cadences, or replace policies — it codifies the de-facto operational
contract, adds telemetry, and prunes dead enum / dead literals. To
roll back:

1. Revert the D-D enum change (`OrderStatus.Expired` re-introduced).
2. Revert the D-C union change (9 literals re-added,
   `phantom_missing_on_exchange` removed). The phantom path will
   continue to write the literal string into `orders.cancel_reason`
   with no type-level coverage, matching pre-rollback behaviour.
3. Revert the D-B telemetry commit (the four columns on `orders`,
   the `classifyCancelAgeBucket` helper in
   `apps/runtime/src/executable-price.ts`, the call sites in
   `apps/runtime/src/modules/execution/execution-module.ts`,
   `apps/runtime/src/modules/reconciliation/order-reconciler.ts`,
   `apps/runtime/src/modules/resolution/resolution-module.ts`, the
   schema migration in `packages/db/src/migrations/`, the schema
   columns in `packages/db/src/schemas/ledger.sql`, and the
   `safeAddColumn` calls in `packages/db/src/bootstrap.ts`).
4. Optional: leave the ADR document in place for historical record.

The DB migration adds nullable columns; rollback drops the columns
or leaves them populated-then-unread. No backfill required for
pre-rollback rows.

## References

- Spec §12, §8 #3 — `06_algorithm_spec.md` v5.13.
- Pipeline doc — `pipeline_analysis/13_order_lifetime_cancellation.md`
  v5.13.
- Audit:
  [`docs/audits/2026-05-06-step8-order-lifetime-cancellation.md`](../audits/2026-05-06-step8-order-lifetime-cancellation.md).
- ADR-006 — Execution price policy.
- ADR-011 — Operational extensions (TTL / cancel / repost / cooldown
  authoring authority).
- ADR-013 — `EXIT_ORDER_TTL_MS = 300s` (89% loser-leg-leak
  observation).
- ADR-014 — Bounded-midpoint price improvement.
- ADR-015 — DB-backed execution policy + ExecutionPolicyObservation
  append-only log.
- ADR-022 — Step 5 entry trigger; this ADR mirrors §D-D telemetry-only
  pattern.
- ADR-023 — Step 6 order pricing; this ADR mirrors §D-F telemetry-only
  pattern.
- ADR-024 — Step 7 order sizing; this ADR mirrors §D-C / §D-D
  telemetry-only pattern.
