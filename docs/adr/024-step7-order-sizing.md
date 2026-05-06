# ADR-024 — Step 7: Order sizing

## Status

Accepted — 2026-05-06

## Context

Step 7 of the trading pipeline ("Order sizing") was audited against
the canonical algorithm spec
`research_plankton/plankton-analysis/06_algorithm_spec.md` v5.13 §4
(Sizing — R6/R7/R26 row-level distributions) plus the split pipeline
doc `research_plankton/plankton-analysis/pipeline_analysis/05_sizing.md`
(v5.13, restored 2026-05-05). §8 #4, §8 #18, and §8 #19 are sizing-
related [OPEN_QUESTION] entries (deterministic formula for fractional
sizes; target USDC budget selection $9 vs $13 vs $5.56 vs $3.66 vs
dust; partial-fill validation with order-level attribution). The
audit lives at
[`docs/audits/2026-05-06-step7-order-sizing.md`](../audits/2026-05-06-step7-order-sizing.md).

§4 itself is **purely empirical**: it reports row-level share/USDC
distributions across 62,266 BUY + 38,886 SELL rows. It is not a
prescriptive sizing-rule specification. The deterministic B/S-rule
USDC values seeded today
(`packages/db/src/bootstrap.ts:262-280`) are inherited from the
**legacy v5.11 truncated size-flow specification** at
`research_plankton/plankton-analysis/06_algorithm_spec_v5.11_truncated.md:124-151`.
The restored canonical §4 does not contain a per-cell USDC table that
reproduces these constants — §4.5 / §4.7 cluster top USDC values at
~$9 and ~$13, not at the legacy 8.38 / 4.17 / 0.76 / 0.12 ladder.

Tangential ADRs already in place:

- **ADR-002** — Inventory auto-merge (position aggregation).
- **ADR-008** — SELL size clamp policy (clamp SELL to wallet
  position; decision returned at `execution-module.ts:689-700`,
  applied at `execution-module.ts:357`).
- **ADR-009** — Live-lite steady-state caps (`maxOrderUsdc`,
  `maxOpenValueUsdc`, `maxActiveMarkets`).
- **ADR-013** — `entryPriceCeiling = 0.75` (BUY-only, pricing-side).
- **ADR-016** — Continuation uses local leg trade count.

No prior ADR addresses §4 head-on. This ADR is the first sizing
contract. It codifies the current de-facto B1-B7 / S1-S7 + FALLBACK
seed as canonical for v1, hardens the FALLBACK invariant against DB
drift, propagates `sizingRuleId` on every emitted `Signal`, persists
`sizingRuleId` + `notionalBucket` on every `decision_signal_log` row
and every `execution_policy_observations` row (with `notionalBucket`
classified at row-write time, not carried on the in-memory `Signal`),
and explicitly defers four open reconciliation questions. **No
behavioural change to sizing values, gates, or clamps.**

The audit identified six structural divergences (D1-D6) and five
open questions (Q1-Q5). This ADR maps them to D-A through D-G:

- **D-A** answers audit D2 (provenance gap) and Q3 (legacy v5.11 vs
  restored §4 reconciliation).
- **D-B** answers audit D1 (FALLBACK invariant bypassed by
  `ensureAlgoRulesDefaults` early-exit).
- **D-C** introduces emitted-signal telemetry that grounds D2 / D-A
  revisits in observed signal-emission data — answers audit D4
  (sizing-rule attribution missing on emitted signals).
- **D-D** introduces placed-order telemetry — answers audit D4
  (attribution missing on `ExecutionPolicyObservation`).
- **D-E** answers audit D3 (5,555 / 3,660 special depth-bid sizes
  not modelled) and Q1 / Q4 — defers the rule additions pending
  probe-vs-taker classification and pre-discovery state-machine
  resolution.
- **D-F** answers audit D5 (share-vs-USDC structural discrepancy
  between legacy spec and exchange `minOrderSize` floor) and Q2 / Q5
  — operational note only; defers wiring of `LiveLiteGuard.isOrderAboveMin`.
- **D-G** answers audit D6 (SELL clamp post-mutation) — operational
  note documenting realized-size source.

Audit Q1 (probe-vs-taker), Q4 (pre-discovery state machine) follow
directly from D-E being deferred and are not closed here.

## Decision

### D-A — Legacy v5.11 truncated size-flow seed is canonical for v1 (audit D2 / spec §8 #18, Q3)

The current B1-B7 + BUY FALLBACK and S1-S7 + SELL FALLBACK rows
seeded by `bootstrap.ts:262-280` are hereby canonical:

- BUY: B1 (OTHER × ≥0.20 → 8.38), B2 (S1 × ≥0.20 → 4.17), B3 (S3 ×
  <0.05 → 0.76), B4 (S2 × <0.05 → 0.12), B5 (ANY × nthBuy=1 → 2.10),
  B6 (ANY × nthBuy=2 → 1.17), B7 (ANY × nthBuy=3 → 0.92), FALLBACK
  (ANY → 0.44).
- SELL: S1 (S2 × ≥0.20 → 6.48), S2 (S1 × ≥0.20 → 6.31), S3 (OTHER ×
  ≥0.20 → 3.40), S4 (S2 × <0.05 → 1.01), S5 (S3 × <0.05 → 0.59), S6
  (ANY × buyCount ∈ [1,1] → 2.85), S7 (ANY × buyCount ∈ [2,3] →
  2.14), FALLBACK (ANY → 1.62).
- Engine: `evaluateSize` rule walker at
  `packages/domain/src/algo-engine.ts:99-116` — priority ASC, first
  match wins, throws if no rule matches.

Justification:

- **Restored §4 is empirical, not prescriptive.** §4.5 / §4.7 show
  USDC notionals cluster at $9.00 / $8.99 / $13.00 / $12.99 across
  multiple state×price cells. The legacy spec's 8.38 / 4.17 / 0.76 /
  0.12 ladder is not reproduced anywhere in §4. But §4 also does not
  publish a deterministic per-state/price/nthBuy USDC table that
  would let us replace the legacy ladder cleanly. §8 #18 explicitly
  flags target USDC budget selection ($9 vs $13 vs $5.56 vs $3.66 vs
  dust) as [OPEN_QUESTION].
- **Sim/paper reproduction is preserved.** Existing simulation
  fixtures and paper rollouts produce sizing outputs that match the
  legacy spec; flipping rule values mid-flight would invalidate that
  parity baseline.
- **Architectural cost.** A re-fit to §4.5 cluster centroids would
  require either (i) per-state/price-bucket USDC tables seeded from
  R26 raw data or (ii) a probabilistic sampler. Both are larger
  changes than v1 sizing warrants.
- **Telemetry first.** D-C / D-D propagate `sizingRuleId` on every
  emitted `Signal`, persist `sizingRuleId` + `notionalBucket` on
  every `decision_signal_log` row reached by the emit path, and
  persist both on every `execution_policy_observations` row.
  `notionalBucket` is classified at row-write time (not carried on
  the in-memory `Signal`). This means a future revision can ground
  any rule-value change in our own production sizing distribution
  rather than legacy spec values.

A follow-up audit may revisit the constants once a 7-day
`decision_signal_log` rollup of `notional_bucket` distributions can
be compared against §4.6 reference percentages. The legacy ladder
stays canonical until that read forces a decision.

### D-B — FALLBACK invariant enforced at startup outside the early-exit path (audit D1)

Current behaviour — `evaluateSize` throws when no rule matches; the
FALLBACK row is the implicit safety net but `ensureAlgoRulesDefaults`
early-exits when `algo_decision_rules` already has rows
(`bootstrap.ts:222-224`), so it does NOT verify the size-rule set on
a partially-seeded or drifted DB — is hereby corrected.

A new helper `assertSizeRuleInvariants(db)` runs at every startup,
unconditionally, **outside** `ensureAlgoRulesDefaults`'s early-exit
guard. It enforces three invariants on `algo_size_rules` rows where
`rule_id = 'FALLBACK'`:

1. **Per-action presence.** Grouping by `action_type`:
   - exactly 1 row with `action_type = 'BUY' AND rule_id = 'FALLBACK'`
   - exactly 1 row with `action_type = 'SELL' AND rule_id = 'FALLBACK'`

   A simple `COUNT(*) = 2` check is rejected explicitly because two
   BUY fallbacks plus zero SELL fallbacks would pass. Per-action
   grouping is required.

2. **Catch-all shape.** Each FALLBACK row must be unconditional —
   `state_condition = 'ANY'` and every filter column
   (`price_operator`, `price_value`, `nth_buy`, `buy_count_min`,
   `buy_count_max`) must be `NULL`. A row tagged FALLBACK but with a
   filter set is not a fallback at all: `evaluateSize` would skip it
   for the very inputs the fallback is supposed to catch, and the
   runtime would still throw `No size rule matched`. The shape check
   closes that silent-degrade hole.

3. **Priority ordering.** Each FALLBACK row's `priority` must be
   strictly greater than every non-FALLBACK rule of the same
   `action_type`. `evaluateSize` reads rules `ORDER BY priority ASC`
   and returns the first match, so a FALLBACK that drifted to a
   priority value ≤ another rule would silently hijack BUY/SELL
   evaluation before the operator-defined ladder ever ran. The
   _exact_ priority value (and `size_usdc`) is deliberately **not**
   asserted: operators may tune fallback notional via the control-DB
   rules API and bump fallback priority arbitrarily without
   triggering this invariant. Order, not value, is the structural
   guarantee.

On violation, `assertSizeRuleInvariants` throws with an actionable
error that lists either the per-action counts, the offending row's
filter columns, or the conflicting priorities. The exception
fail-fasts the runtime supervisor before the strategy module can
crash on a missing or malformed FALLBACK row mid-evaluation.

Justification:

- **CI vs prod drift.** Bootstrap test coverage exercises the
  happy-path seed; a prod DB drifted into a state where the BUY
  FALLBACK row was deleted (or the SELL FALLBACK lost) would not be
  repaired by bootstrap and would crash the next BUY/SELL evaluation.
- **Fail-fast over silent corruption.** A missing FALLBACK throws
  `No size rule matched for ${action} — FALLBACK rule missing` from
  `algo-engine.ts:115`. Catching it at startup turns a runtime
  signal-time crash into a deterministic startup-time crash with
  clear remediation (re-seed the row).
- **Idempotent.** The assertion only reads; it does not insert. Running
  it on every startup is cheap and side-effect-free.

### D-C — Sizing telemetry on emitted signals (audit D4)

A new field `sizingRuleId: string | null` is added to the in-process
`Signal` type
(`packages/domain/src/types.ts`). It carries the rule id (e.g. `B1`,
`B7`, `S6`, `FALLBACK`) returned by `evaluateSize` at
`apps/runtime/src/modules/algo-decision/algo-decision-module.ts:1011-1041`.
Nullable for symmetry with `decisionRuleId` (which is null when the
signal originates from a non-`evaluateDecision` path).

Two columns are added to `decision_signal_log`:

- **`sizing_rule_id TEXT`** — populated from `Signal.sizingRuleId` on
  the row insert in `recordDecisionSignal`. Nullable.
- **`notional_bucket TEXT`** — categorical string in the §4.6
  taxonomy: `<$0.10`, `$0.10-$0.50`, `$0.50-$1`, `$1-$2`, `$2-$5`,
  `$5-$10`, `$10-$25`, `$25-$50`, `$50-$100`, `>$100`. Computed from
  `Signal.suggestedSizeUsdc` at row-write time via a pure helper
  `classifyNotionalBucket(usdc)`. Nullable when `suggestedSizeUsdc`
  is null or non-finite.

Both columns persist on every `decision_signal_log` row reached by
the emit path (success emit and price-skipped emit) so analytics see
the full distribution at the point the bot decided a notional,
before any downstream price-resolution / clamp / risk gate. Decisions
the algo drops _before_ allocating a `signal_id` — chiefly the
wallet-budget guard at the top of `runEvaluation` — are intentionally
not logged today: there is no Signal yet to attach telemetry to. If a
future change wants distribution coverage for those drops, a separate
log row (with `sizing_rule_id = NULL` and a synthetic `signal_id`)
would be needed.

The §4.6 bucket taxonomy is preserved exactly — including the
essentially-empty `$25-$50`, `$50-$100`, and `>$100` tail buckets —
so production drift into those buckets is visible rather than
collapsed into a single `≥$25` catch-all.

### D-D — Sizing telemetry on placed orders (audit D4)

The `ExecutionPolicyObservation` interface
(`packages/domain/src/types.ts:583-611`) is extended with two new
fields, mirroring D-C:

- **`sizingRuleId: string | null`** — read from the embedded
  `signal.sizingRuleId` at `signal-to-order.ts:writeObservation`
  call sites.
- **`notionalBucket: NotionalBucket | null`** — computed from
  `signal.suggestedSizeUsdc` via `classifyNotionalBucket`, same
  taxonomy as D-C.

The corresponding columns `sizing_rule_id TEXT` and
`notional_bucket TEXT` are added to `execution_policy_observations`.
Both fields persist on every observation row — successful placements
**and** every skip path (dead-side enforce/observe, invalid-price,
execution-price-unavailable, one-sided-book, wide-spread,
entry-ceiling) — so canary analytics can join emitted-vs-placed
sizing distributions.

`ExecutionPolicyObservation` does NOT carry exact realized order
size or notional today, and this ADR does not change that. Realized
size is read from the `orders` table. The new fields are pure
attribution telemetry.

Computed once at observation-write time; not re-derived from
`signal.suggestedSizeUsdc` at query time so dashboards stay
schema-stable across future bucket-taxonomy revisions.

### D-E — Special depth-bid sizes (5,555 / 3,660 shares) not modelled, deferred (audit D3 / spec §8 #18)

Current behaviour — B1-B7 + FALLBACK never produce 5,555 or 3,660
shares for a first BUY at the bottom of the book — is hereby
retained for v1.

R26 §4.4 evidence: 666 of 62,266 BUY rows (1.07%) are 5,555 or 3,660
shares at $0.001 / $0.002. 217/370 of the 5,555-share fills and
155/296 of the 3,660-share fills are first BUY on the market. At
`price = 0.001` only B5/B6/B7/FALLBACK + B3/B4 (state-gated) can
match in the legacy ladder; B1/B2 cannot (require `price ≥ 0.20`).
None of the reachable B-rules cluster at 5,555 or 3,660 shares.

Justification for deferral:

- **Q1 unresolved.** Whether reference posts these as marketable
  taker bids or as resting maker bids is undecidable from §4.4 alone
  — `transaction_hash` was rejected as an order-level grouping key
  per §4.3 (R6 saw 0 BUY/SELL groups with `n_fills > 1`).
- **Q4 unresolved.** Whether the §4.4 first-BUY pattern is true
  first-buy-after-discovery or pre-discovery state-machine S0 is
  undefined; the R26 sample treats first-BUY as the first BUY row in
  the activity feed, not gated on discovery.
- **Architectural cost.** Adding a "probe size" rule path requires
  either a new state (S0 = pre-discovery) or a marketable-taker
  detection mechanism. Both are larger than 1.07%-of-rows tail
  warrants.

A follow-up audit will revisit once Q1 (probe-vs-taker
classification from direct-orderbook reconstruction) and Q4
(pre-discovery state machine resolution) close. Today's behaviour is
canonical.

### D-F — Operational note on `min_order_usdc` and `LiveLiteGuard.isOrderAboveMin` (audit D5 / spec Q2, Q5)

Current behaviour — runtime sizing floors are exchange `minOrderSize`
in shares; `min_order_usdc` is preflight-only;
`LiveLiteGuard.isOrderAboveMin` is defined but unused — is hereby
documented and retained for v1.

Runtime floor sites (all share-denominated):

| Site                                                              | Floor / clamp                                  |
| ----------------------------------------------------------------- | ---------------------------------------------- |
| `algo-risk-gate.ts:80-86` (`AlgoRiskGate.evaluate`)               | exchange `minOrderSize` per token              |
| `risk-inventory-module.ts:320-326`                                | `tokenMinOrderSize` cache from market metadata |
| `execution-module.ts:297-309` (`getMinOrderSizeRejection`)        | pre-placement rejection                        |
| `execution-module.ts:357` (clamp applied; decision at `:689-700`) | SELL reservation clamp (ADR-008)               |
| `execution-module.ts:358` (post-clamp min-check)                  | re-check after SELL clamp                      |

USDC-denominated sites:

| Site                                                   | Status                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `profile-preflight.ts:88-99`                           | preflight only (`min_order_usdc ≥ $0.50` EOA / `≥ $0.05` relayer)                                   |
| `live-lite-guard.ts:43-50` (`isOrderAboveMin`)         | defined but no production caller; `live-lite-guard.test.ts` is the only invocation                  |
| `live-lite-guard.ts:55-59` (`getMinEntryNotionalUsdc`) | private constant `CLOB_MARKETABLE_BUY_MIN_USDC = 1` consumed here only; no production caller either |

There is a known structural discrepancy between the legacy
USDC-denominated size flow and the exchange's share-denominated
floor. Worked example inside the B4 envelope (`state = S2 AND price
< 0.05`):

- B4 at $0.12 USDC / `price = 0.001` → 120 shares, clears any
  reasonable `minOrderSize`.
- B4 at $0.12 USDC / `price = 0.049` → ~2.45 shares, fails a 5-share
  floor.

The same pattern applies more sharply to B5-B7 (no price gate at all).
This is current behaviour and probably correct (you cannot post
fractional shares below the exchange floor). It is documented here
so future audits do not re-litigate.

Q2 (does the CLOB enforce a hard $1 marketable-BUY floor today, or
is the $1 in `live-lite-guard.ts:3` a paper-precaution?) and Q5
(should `LiveLiteGuard.isOrderAboveMin` be wired or removed?) remain
deferred. Wiring a USDC floor would introduce a behavioural change
that biases live-lite to drop the long tail. This ADR does not
take that step.

### D-G — SELL clamp + post-clamp min-check linkage documented (audit D6)

Current behaviour — `execution-module.ts:357` applies the SELL-clamp
decision (ADR-008; computed at `getReservationDecision` /
`execution-module.ts:689-700`), and the post-clamp re-check at
`execution-module.ts:358` rejects when the clamped shares fall below
`minOrderSize` — is hereby documented.

`ExecutionPolicyObservation` carries `sizingRuleId` + `notionalBucket`
only (D-D); exact realized SELL shares can differ from
`signal.suggestedSize` and are read from the `orders` row, not from
this telemetry stream. ADR-008 already wires the rejection path; the
ADR only flags that any sizing-distribution dashboard needs to read
realized size from `orders`.

No code change.

## Consequences

### Positive

- **Audit Q3, §8 #18 are answered in writing.** The legacy v5.11 seed
  is locked as canonical with explicit acknowledgement that the
  restored §4 does not contain a per-cell USDC table. Future
  pipeline-step audits can reference D-A rather than re-deriving the
  contract from runtime code.
- **D-B FALLBACK invariant** closes a real DB-drift footgun. A drifted
  prod DB now fail-fasts at startup with an actionable error instead
  of crashing the strategy module on the next BUY/SELL evaluation.
- **D-C / D-D telemetry** lets operators measure our sizing-rule hit
  rate and notional-bucket distribution in production and compare
  against §4.6 / §4.7 reference distributions — grounding any future
  D-A revision in observed signal rather than legacy spec values or
  raw R26 numbers. Mirrors ADR-022 §D-D / ADR-023 §D-F pattern.
- **D-E / D-F / D-G operational notes** prevent future audits from
  re-flagging the share-vs-USDC discrepancy, the `isOrderAboveMin`
  orphan, or the SELL clamp post-mutation as defects. Each is
  documented with explicit Q-mapping for the deferred-decision
  contract.

### Negative / accepted trade-offs

- **Legacy ladder ⇄ §4.5 / §4.7 cluster divergence.** Our sizing
  outputs will not concentrate at $9.00 / $8.99 / $13.00 the way the
  reference's do. Practical impact depends on whether the legacy
  ladder is the bot reference's true canonical or whether data drift
  after v5.11 authoring shifted the empirical distribution. D-C / D-D
  telemetry surfaces this; D-A defers the fix.
- **`NotionalBucket` taxonomy is policy-defined.** The ten §4.6
  buckets are mutually exclusive and ordered; an alternative
  flat-feature schema (e.g. one boolean per bucket) was rejected as
  schema bloat. Operators querying the column must respect the
  bucket-precedence convention — documented but a query-time foot-gun.
- **`LiveLiteGuard.isOrderAboveMin` and
  `getMinEntryNotionalUsdc` remain orphaned.** No code is removed even
  though neither has a production caller. Removing them now would
  foreclose Q2 / Q5 follow-up work. D-F defers the wire-or-remove
  decision.
- **5,555 / 3,660 special depth-bid sizes remain unmodelled.** 1.07%
  of reference BUY rows are sized this way at bottom-of-book; the bot
  cannot replicate the pattern. D-E defers the rule additions to a
  follow-up audit gated on Q1 / Q4.
- **`assertSizeRuleInvariants` runs on every startup.** A failing
  assertion crashes the runtime supervisor at boot. This is the
  intended fail-fast; operationally the cost is one extra grouped
  SELECT per startup (cheap).

## Rollback plan

ADR-024 introduces no behavioural change to sizing values, runtime
gates, or clamps — it codifies the de-facto rule set, hardens the
FALLBACK invariant, and adds telemetry. To roll back:

1. Revert the D-B invariant commit (the `assertSizeRuleInvariants`
   helper and its call site in `bootstrap.ts`). The pre-rollback
   behaviour silently relies on the seeded FALLBACK rows.
2. Revert the D-C / D-D telemetry commit (the `sizingRuleId` field
   on `Signal`, the `sizingRuleId` + `notionalBucket` fields on
   `ExecutionPolicyObservation`, the helper functions in
   `apps/runtime/src/executable-price.ts`, the call sites in
   `apps/runtime/src/modules/algo-decision/algo-decision-module.ts`
   and `apps/runtime/src/modules/strategy/signal-to-order.ts`, the
   schema migrations in `packages/db/src/migrations/`, the schema
   columns in `packages/db/src/schemas/ledger.sql`, and the
   `safeAddColumn` calls in `packages/db/src/bootstrap.ts`).
3. Optional: leave the ADR document in place for historical record.

The DB migrations add nullable columns; rollback drops the columns
or leaves them populated-then-unread. No backfill required for
pre-rollback rows.

## References

- Spec §4, §8 #4 / #18 / #19 — `06_algorithm_spec.md` v5.13.
- Pipeline doc — `pipeline_analysis/05_sizing.md` v5.13.
- Audit:
  [`docs/audits/2026-05-06-step7-order-sizing.md`](../audits/2026-05-06-step7-order-sizing.md).
- Legacy size-flow spec —
  `research_plankton/plankton-analysis/06_algorithm_spec_v5.11_truncated.md:124-151`.
- ADR-002 — Inventory auto-merge.
- ADR-008 — SELL size clamp policy.
- ADR-009 — Live-lite steady-state caps.
- ADR-013 — `entryPriceCeiling = 0.75`.
- ADR-015 — DB-backed execution policy + ExecutionPolicyObservation
  append-only log.
- ADR-016 — Continuation uses local leg trade count.
- ADR-022 — Step 5 entry trigger; this ADR mirrors §D-D telemetry-only
  pattern.
- ADR-023 — Step 6 order pricing; this ADR mirrors §D-F telemetry-only
  pattern.
