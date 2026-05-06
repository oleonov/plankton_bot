# ADR-023 — Step 6: Order pricing (where in the book)

## Status

Accepted — 2026-05-06

## Context

Step 6 of the trading pipeline ("Order pricing — where in the book")
was audited against the canonical algorithm spec
`research_plankton/plankton-analysis/06_algorithm_spec.md` v5.11+ — §3
(decision-time BUY price), §6 (R8, R15 — order execution properties),
§12.5 (R32 — direct historical orderbook reconstruction), §13 (R29 —
order pricing refined). §8 Q2 [OPEN_QUESTION]. The audit lives at
[`docs/audits/2026-05-06-step6-order-pricing.md`](../audits/2026-05-06-step6-order-pricing.md).

R29's headline evidence is that reference **fills** sit at a median
delta of −9 ticks below a reconstructed pseudo-market price (sourced
from `entry_trigger_threshold_refinement_results.json` trajectory
checkpoint `0`). The pseudo-market price is **not** best_bid; it is a
proxy. R32's two direct BUY samples both filled at
`best_bid_before = 0.001` on bottom-of-book markets. Whether reference
**posts** orders below the bid or merely fills there as a passive
maker on bid-stacked levels is undecidable from R29/R32 alone — Q2
stays [OPEN_QUESTION].

Tangential ADRs already in place:

- **ADR-006** (D1) — `BUY = bestBid`, `SELL = bestAsk`, single edge
  formula across all runtime modes.
- **ADR-013** (D1) — `entryPriceCeiling = 0.75` BUY-only ceiling.
- **ADR-014** (D1-D6) — bounded-midpoint pricing mode, spread +
  improvement caps, one-sided / wide-spread policies, `pricingShadow`
  canary, observe-first rollout.
- **ADR-015** — DB-backed execution policy +
  `ExecutionPolicyObservation` append-only log.

No prior ADR closes the Step 6 spec gap as a single decision point.
This ADR codifies the current de-facto pricing direction (`mode =
"edge"` default), makes the boundary between admission-layer
no-bid handling and pricing-layer residual semantics explicit,
defers the `entryPriceCeiling` tightening pending all-BUY R15
histogram, defers the bounded-midpoint mode lifecycle decision
pending canary read, and adds two cheap derived telemetry fields
(`pricingDeltaTicks`, `roundLevelHit`) on every
`ExecutionPolicyObservation` row. **No behavioural change.**

The audit identified nine structural divergences (D1-D9) and nine
open questions (Q1-Q9). This ADR maps them to D-A through D-F:

- **D-A** answers audit D1, D8 (pricing direction vs R29) and Q1.
- **D-B** answers audit D5 (no min_tick fallback when bestBid null)
  and Q3.
- **D-C** answers audit D6 (`entryPriceCeiling = 0.75` vs §3) and Q4.
- **D-D** answers audit D8 (bounded-midpoint mode lifecycle) and Q5.
- **D-E** answers audit D7 (DeadSideGuard X selection) and Q9.
- **D-F** introduces telemetry that grounds D2/D3/D-A revisits in
  observed production data — answers audit's Section 5 §D-F sketch.

Audit D2 (per-bucket pricing offset), D3 (round-number snapping),
D4 (multi-leg progression policy), D9 (spread + improvement caps
calibration), Q6, Q7, Q8 follow directly from D-A / D-D being
deferred or cross-cut Step 8 / 9 audits. They are not closed here.

## Decision

### D-A — Edge mode is canonical for v1 (audit D1, D8 / spec Q2)

The current de-facto execution-pricing direction is hereby canonical:

- Default `policy.pricing.mode = "edge"` across all profiles
  (`packages/domain/src/execution-policy.ts:24`,
  `packages/db/src/control-profiles.ts`).
- Edge formula (ADR-006 D1): `BUY → price = bestBid`,
  `SELL → price = bestAsk`. One formula for simulation, paper,
  live-lite.

Justification:

- **R29 caveat.** R29's −9-tick median delta is fill evidence to a
  pseudo-market proxy, not posted-order evidence to best_bid. The
  reference may post at-bid as a passive maker and fill on
  bid-stacked levels that happen to sit below pseudo-market; without
  maker/taker attribution (spec §6, §12.6 [OPEN_QUESTION]), the
  inversion is **inferred** rather than proven. Edge mode (which posts
  at-bid) is consistent with the inferred-passive-maker reading.
- **R32 anchor.** R32's two direct BUY samples both fill at
  `best_bid_before = 0.001` (i.e. taking the touch on bottom-of-book
  markets). Edge mode reproduces this on those markets exactly.
- **Architectural cost.** A "post below bid" formulation requires
  per-bucket offset logic (audit D2), which in turn requires rolling
  fill-price-bucket calibration data not currently captured. Step 5
  ADR-022 §D-D deferred drop-feature gating on the same rolling-data
  grounds; this ADR mirrors that deferral for pricing offsets.
- **Telemetry first.** D-F captures `pricingDeltaTicks` per
  observation so a future revision can ground any direction change
  in our own production fill-price distribution rather than R29 raw
  numbers.

Bounded-midpoint mode remains a code path under `policy.pricing.mode
= "bounded-midpoint"` but is **not** the default and is gated
DB-side; D-D defines its lifecycle.

### D-B — `bestBid = null` is rejected at admission, not at pricing (audit D5 / spec Q3)

Current behaviour — markets without a `bestBid` are rejected at
hard-liveness, **not** at `resolveExecutionTerms` — is hereby
canonical for v1:

1. `isAlive` flags `no_bid` when `market.bestBid == null`
   (`packages/domain/src/market-selection.ts:68`).
2. `algo-decision-module.ts` runs `isAlive` before emitting any
   non-REDEEM signal and suppresses on failure
   (`apps/runtime/src/modules/algo-decision/algo-decision-module.ts:846`).
3. The signal-to-order bridge re-runs `isAlive` on the embedded
   snapshot
   (`apps/runtime/src/modules/strategy/signal-to-order.ts:237`)
   and short-circuits before pricing.

The `execution-price-unavailable` skip in `resolveExecutionTerms`
only triggers in residual cases — typically a non-finite,
non-positive, or otherwise anomalous `bestBid` / `bestAsk` slipping
past liveness; not the typical no-bid market path.

Justification:

- **R29's 14.61% min-tick share is not no-bid evidence.** R29 doesn't
  tag fills by bid availability, and R32's two direct BUY samples
  filled at `best_bid_before = 0.001` (not into a no-bid book). The
  share of reference's fills that come from posting at min_tick into
  an empty book is unknown.
- **Closing any hypothetical "post at min_tick into a no-bid book"
  gap is a two-layer change.** It requires (i) `isAlive` to admit
  `no_bid` markets when an explicit `bestBid = null` policy is in
  effect, and (ii) `resolveExecutionTerms` to emit `min_tick` rather
  than the unavailable skip. Pricing-layer-only changes don't help
  because liveness rejects first.
- **Telemetry first.** D-F's `roundLevelHit` field captures whether
  our existing edge-mode posts hit `min_tick` — which lets us
  measure the bot's own min-tick posting rate before deciding
  whether the reference's 14.61% share warrants a new admission
  policy.

If post-hoc evidence shows the bot's own min-tick rate is materially
below 14.61% AND the reference fill distribution is causally
explained by no-bid posting, a follow-up ADR will introduce the
two-layer change. Today's behaviour is canonical.

### D-C — `entryPriceCeiling = 0.75` retained pending all-BUY histogram (audit D6 / spec Q4)

Current behaviour — `entryPriceCeiling = 0.75` BUY-only (ADR-013 D1)
applied at
`apps/runtime/src/modules/strategy/signal-to-order.ts:389` to
**every** BUY (first BUY plus scale-ins) — is hereby retained for
v1.

Justification:

- **§3 alone under-states the cap's coverage.** Spec §3 only covers
  first BUYs (10,046 first-buy legs). `entryPriceCeiling` applies to
  scale-in BUYs as well; the prior 2026-04-24 factcheck observed a
  max all-BUY fill price `MAX(price) = 0.698086404066074` and zero
  fills above 0.80, with a small scale-in tail in the 0.50-0.80
  range. ADR-013 §D1's `avg_buy_price = 0.698` (single loser leg)
  is the basis for the chosen 0.75 cap.
- **Tightening cost is not quantifiable from §3.** Tightening to
  0.50 would clip both first-BUY (~0.01% of distribution) and the
  scale-in tail; the scale-in cost is not in §3 and would require an
  R15-derived all-BUY histogram before being safe.
- **Defer for evidence.** D-F adds no new histogram coverage at the
  bridge layer (the `selected_price` column already powers a
  bridge-side query), but a follow-up "Step 6.4: ceiling tightening"
  task is the right place to read that data.

If a 7-day `ExecutionPolicyObservation` rollup confirms that
`selected_price >= 0.50` is statistically rare for both first-BUY
and scale-in cohorts, a follow-up ADR will tighten the ceiling.
Today's 0.75 is canonical.

### D-D — Bounded-midpoint mode stays gated, lifecycle decision deferred (audit D8 / spec Q5)

Current behaviour — bounded-midpoint mode (`policy.pricing.mode =
"bounded-midpoint"`, ADR-014 §D2) is implemented and validated by
`pricingShadow` canary observation in edge mode but is **not**
defaulted in any profile — is hereby retained for v1.

Justification:

- **R29 evidence is inferred-direction, not proven-direction.** Per
  D-A, R29's −9-tick fill delta to pseudo-market is consistent with
  passive at-bid posting that fills on bid-stacked levels. Without
  maker/taker attribution (spec §12.6 [OPEN_QUESTION]), R29 does
  **not** definitively rule out bounded-midpoint's "improve toward
  midpoint" direction.
- **Canary first.** ADR-014 §D5 introduced `pricingShadow` so edge
  mode can compute the bounded-midpoint candidate alongside and log
  diagnostics to `ExecutionPolicyObservation`. The canary read is
  captured but has not yet driven a flip decision.
- **Reversal conditions are codified.** ADR-014 §Reversal Conditions
  already specifies that bounded-midpoint will be reversed if
  "canary replay shows realized-fill PnL is worse than edge formula
  on representative book-width distributions." That contract stays.

Lifecycle decision (deprecate the path, default to bounded-midpoint,
or keep dual-mode) is deferred to a follow-up ADR-024 once a 7-day
`ExecutionPolicyObservation` window provides enough enforce-vs-shadow
fill data to read the canary.

### D-E — DeadSideGuard X canary read deferred to ADR-024 (audit D7 / spec Q9)

Current behaviour — `policy.deadSideGuard` defaults to `observe`
mode in code (`packages/domain/src/execution-policy.ts:18`), with
profile seeds setting `live-lite = enforce`, `paper = observe`,
`simulation = observe`
(`packages/db/src/control-profiles.ts:34-48`). Thresholds:
`askCeiling = 0.02`, `maxTimeToEndMs = 120_000`. Shadow telemetry
captures hits at the 60s / 120s / 300s / 900s buckets — is hereby
retained for v1.

Justification:

- **Spec backing absent.** No R confirms or denies a dead-side
  guard. ADR-013 §D1 flagged it as future work; ADR-014 promoted the
  canary form into runtime.
- **Shadow data not yet read.** The canary buckets exist but have
  not been rolled up to compare enforce-vs-shadow ratios across the
  four X candidates. Picking the X without that read is policy
  guesswork.
- **Live-lite enforce-default is conservative-correct.** With X =
  120_000 ms (the seed), enforce is on for live-lite, off for paper.
  This is fail-closed and acceptable for the canary window even if
  120s is not the optimal X.

Pulling the 7-day rollup and selecting the X with the cleanest
enforce-vs-observe ratio is deferred to ADR-024 (joint with
bounded-midpoint canary read — both pull from the same
`ExecutionPolicyObservation` table).

### D-F — Pricing telemetry (audit Section 5 §D-F)

Two read-only telemetry additions to every
`ExecutionPolicyObservation` row. **No behavioural change.**

1. **`pricingDeltaTicks`** — `(selectedPrice - bestBid) / tickSize`
   for BUY, `(bestAsk - selectedPrice) / tickSize` for SELL.
   Captures how far above the touch the order is being placed
   (positive = improvement toward midpoint; 0 = exactly at touch;
   negative = below the touch). `null` when `selectedPrice` is
   `null` (skip path) or when the relevant side of the book is
   `null` (no bid / no ask). Rounded to 4 decimal places to match
   the `ticks` precision convention used by the pseudo-market table
   in spec §13.

2. **`roundLevelHit`** — categorical string in
   `{"min_tick", "0.05x", "0.01x", "0.005x", "off-round"}`. R29's
   round-number feature taxonomy (§13.2). Mutually exclusive in
   that precedence order — a price equal to `min_tick` is
   classified as `"min_tick"` even if it is also a multiple of
   0.05; a multiple of 0.05 takes precedence over a multiple of
   0.01; a multiple of 0.01 takes precedence over a multiple of
   0.005. `null` when `selectedPrice` is `null`.

Both fields persist on every observation row — successful
placements **and** every skip path — so canary analytics see the
full distribution. Computed once at observation-write time; not
re-derived from `selected_price` at query time so dashboards stay
schema-stable across future tickSize policy changes.

The optional `pseudoMarketDeltaTicks` (R29 cross-check, requires
pseudo-market reconstruction) is **not** included in this revision —
the bot has no pseudo-market price source and adding one would
expand ADR scope.

## Consequences

### Positive

- **Q1 / Q3 / Q4 / Q5 / Q9 are now answered** in writing. Future
  Step 6 audits can reference this ADR rather than re-deriving the
  contract from runtime code.
- **D-A pricing direction** codifies edge as canonical with explicit
  acknowledgement that R29's downward bias is inferred (fill
  evidence, not placement evidence) and that maker/taker attribution
  is not available — preventing future audits from re-flagging the
  same inversion as a defect.
- **D-B admission-vs-pricing boundary** disambiguates which layer
  rejects no-bid markets, so any future "post at min_tick" decision
  knows it must touch both layers, not just `resolveExecutionTerms`.
- **D-C ceiling deferral** ties the tightening decision to an
  all-BUY R15 histogram rather than first-BUY §3 quantiles, so a
  future ADR-024 has a clear data requirement.
- **D-D / D-E** explicitly defer bounded-midpoint lifecycle and
  DeadSideGuard X selection to a joint canary read, providing a
  single follow-up ADR-024 scope.
- **D-F telemetry** lets operators measure our pricing direction
  (vs touch) and round-level distribution in production and
  compare against R29 reference distributions, grounding any future
  D-A / D-B / D-D revision in observed signal rather than raw R29
  numbers.

### Negative / accepted trade-offs

- **Edge default ⇄ R29 fill-direction divergence.** Our fills will
  not concentrate on −9-ticks-below-pseudo-market the way the
  reference's do. Practical impact depends on how reference's fills
  arrive — if reference posts at-bid passively on bid-stacked
  markets, our edge mode is identical; if reference posts below
  bid, we leave money on the table on the high-fill-price end.
  D-F telemetry surfaces this; D-A defers the fix.
- **`entryPriceCeiling = 0.75` admits the 0.50-0.75 region.** The
  small scale-in tail in this region (per 2026-04-24 factcheck)
  remains tradeable — operationally policy, not a spec-violation.
  D-C defers tightening pending histogram read.
- **Bounded-midpoint mode stays as a code path.** No code is removed
  even though R29 inferred-direction-evidence weighs against the
  improve-toward-midpoint formula. Removing it now would foreclose
  future canary analysis. D-D defers the decision.
- **DeadSideGuard X = 120_000 ms is not evidence-backed.** Picked
  by ADR-014 as a defensive seed; X selection deferred to ADR-024.
  Acceptable while live-lite is the only profile that enforces.
- **`pricingDeltaTicks` is signed-by-side** — BUY is `(price -
  bestBid) / tickSize` so a positive value means "above bid toward
  ask" (improvement); SELL is `(bestAsk - price) / tickSize` so a
  positive value means "below ask toward bid" (improvement). The
  semantic is "ticks of improvement from the touch toward
  midpoint." Operators querying the column must respect the side
  semantics — which is documented but a query-time foot-gun.
- **`roundLevelHit` is policy-defined precedence**, not a flat
  feature flag. R29's table publishes mutually-exclusive cells
  (`min_tick`, `multiple of 0.05`, `multiple of 0.01 excluding above`,
  etc.) in that precedence order. Our column matches that exactly to
  enable apples-to-apples comparison; a flat-feature alternative
  (e.g. `is_min_tick`, `is_05x`, `is_01x`, `is_005x` four columns)
  was rejected as schema bloat.

## Rollback plan

ADR-023 introduces no behavioural change — it codifies de-facto
pricing direction and adds telemetry. To roll back:

1. Revert the D-F telemetry commit (the `pricingDeltaTicks` and
   `roundLevelHit` columns on `execution_policy_observations`, the
   helper functions in `apps/runtime/src/executable-price.ts`, the
   call site in
   `apps/runtime/src/modules/strategy/signal-to-order.ts`, the
   schema migration entry in `packages/db/src/migrations/`, the
   schema column in `packages/db/src/schemas/ledger.sql`, and the
   `safeAddColumn` calls in `packages/db/src/bootstrap.ts`).
2. Optional: leave the ADR document in place for historical record.

The DB migration adds nullable columns; rollback drops the columns
or leaves them populated-then-unread. No backfill required for
pre-rollback rows.

## References

- Spec §3, §6 (R8 + R15), §12.5 (R32), §13 (R29), §8 Q2 — `06_algorithm_spec.md`
  v5.11+.
- Audit:
  [`docs/audits/2026-05-06-step6-order-pricing.md`](../audits/2026-05-06-step6-order-pricing.md).
- R29 source — `research_plankton/order_pricing_refinement_report.md`.
- R32 source — `research_plankton/step8_orderbook_reconstruction_report.md`.
- ADR-006 — execution price policy (edge / bounded-midpoint).
- ADR-013 — `entryPriceCeiling = 0.75` and exit-TTL bump.
- ADR-014 — bounded-midpoint price improvement (pricingShadow canary,
  reversal conditions).
- ADR-015 — DB-backed execution policy + ExecutionPolicyObservation
  append-only log.
- ADR-022 — Step 5 entry trigger; this ADR mirrors §D-F telemetry-only
  pattern.
- 2026-04-24 prior factcheck —
  `docs/audits/2026-04-24-execution-pricing-review-factcheck.md`.
- 2026-04-24 prior dead-side review —
  `docs/audits/2026-04-24-execution-pricing-and-dead-side-review.md`.
