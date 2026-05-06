# ADR-021 — Step 4: Watch-set formation and maintenance

## Status

Accepted — 2026-05-06

## Context

Step 4 of the trading pipeline ("Watch-set formation and maintenance")
was audited against the canonical algorithm spec
`research_plankton/plankton-analysis/06_algorithm_spec.md` v5.11 §10
and the R25 empirical observations in
`research_plankton/plankton-analysis/pipeline_analysis/11_watch_set_formation_maintenance.md`.
The audit lives at
[`docs/audits/2026-05-06-step4-watch-set-formation-and-maintenance.md`](../audits/2026-05-06-step4-watch-set-formation-and-maintenance.md).

Spec §10 is **purely empirical R25 observations** (lifespan
distributions, gap distributions, `active_7d/14d/30d/60d` sizes). Spec
§8 marks three [OPEN_QUESTION]s that fall under Step 4:

- **Q14** — specific watch-set add condition.
- **Q15** — specific watch-set cessation condition.
- **Q17** — re-entry process for markets with >30 day internal gap.

ADR-020 §Context is the only formal forward-reference to Step 4: "Step
4 (watch-set formation) will own gating" + "watch-set ordering (Step
4): when the WS pricing-subscription budget is exceeded, retain
higher-score markets first". The Step 4 contract itself was nowhere
codified.

This ADR closes the gap by either accepting current de-facto
behaviour as the canonical answer to Q14/Q15/Q17 or explicitly
flagging the residual question as deferred. It introduces no new
ranking, gating, or storage semantics — runtime behaviour today
already matches the audit's de-facto description.

The audit identified two cessation edge cases that the de-facto
description glossed over and that this ADR must address:

- **Edge case 1 (preserved-but-disappeared).** A token (i) holds an
  open position/order, and (ii) fully disappears from a Gamma scan
  (not "Gamma returns inactive" — fully missing). `deactivateMissing`
  (`packages/db/src/repositories/market-repository.ts:178-202`) skips
  the row entirely without flipping `tradable`. So `tradable` stays at
  the value of the last successful UPSERT — potentially `tradable=1`.
  Pricing still flows via the execution-critical tier (open
  positions/orders force inclusion regardless of `tradable`), but the
  preserved-for-lifecycle invariant `tradable=0` is not enforced in
  this branch.

- **Edge case 2 (resolution-deactivation tombstone vs UPSERT-undo).**
  `ResolutionModule.processDetectedResolutions` calls
  `marketRepo.deactivate(tokenId)`
  (`apps/runtime/src/modules/resolution/resolution-module.ts:572`),
  setting `active=0`. If Gamma later returns the same token, the
  scanner's `UPSERT_MARKET_SQL` may set `active=1` again. Today there
  is no permanent tombstone preventing reactivation.

## Decision

### D-A — Watch-set add: scanner admission rule + NEW-BUY eligibility filter (Q14 — accepted answer)

The current de-facto admission contract is hereby canonical.

**Scanner admission** (writes `tradable=1` into `markets`):

```
clobMarket.active === true   (mapped from Gamma raw.active —
                              packages/exchange/src/mappers.ts:371)
AND Step 2 SelectionRule evaluation === INCLUDE
```

`active = clobMarket.active OR hasActiveLeg` (preserved-for-lifecycle
branch; see D-B). `tradable = clobMarket.active AND
INCLUDE` (`apps/runtime/src/modules/market-scanner/market-scanner-module.ts:379, 382`).

**NEW-BUY eligibility filter** (drives `MarketSelectionCache.eligible`,
the actual gate on `SignalProduced` for new buys):

```
tradable === 1
AND volumeLifetime !== 0   (i.e. positive OR null;
                            null is the ADR-007 / ADR-018 §D1 waiver)
AND Step 2 SelectionRule evaluation === INCLUDE
```

Implemented at
`apps/runtime/src/modules/algo-decision/market-selection-cache.ts:130-147`.

**Important:** scanner admission and NEW-BUY eligibility are **two
different filters**. `findTrackedForPricingTiered`
(`packages/db/src/repositories/market-repository.ts:243`) admits a
market into the pricing universe purely on `active=1 AND tradable=1`
— with **no** volume gate. The volume gate is enforced later, only
for the BUY-signal step, by `MarketSelectionCache`. The field
`enableOrderBook` is a pricing/liveness signal populated by the market
data path **after** admission and is **not** part of the Step 4
admission contract.

No score-based gating on admission. ADR-020 explicitly postulates
"MVP does not gate BUYs by score"; ADR-021 carries that forward —
score affects only the WS pricing budget tiebreak (D-E).

### D-B — Watch-set cessation: four canonical branches (Q15 — accepted answer)

Cessation is the union of four disjoint branches, each derived from
existing runtime code:

1. **Gamma drop AND no active leg.** `deactivateMissing`
   (`market-repository.ts:178-202`) writes `active=0` for tokens not
   present in the latest Gamma scan and not in the active-leg set.
   Pricing tier and BUY eligibility both drop the row on the next
   tick.

2. **Gamma returns inactive AND no active leg.** Scanner UPSERT
   evaluates `active = clobMarket.active OR hasActiveLeg = false` and
   `tradable = clobMarket.active && INCLUDE = false`
   (`market-scanner-module.ts:379, 382`). Full deactivate-in-place via
   the same UPSERT pass that admitted the row originally.

3. **Gamma returns inactive AND `hasActiveLeg=true`** —
   preserved-for-lifecycle. UPSERT writes `active=1, tradable=0`. The
   row stays in pricing tier via the execution-critical inclusion
   path (open positions/orders are force-included regardless of
   `tradable`); BUY eligibility drops because `tradable=0`. Sells and
   redeems continue to flow.

4. **Resolution detected.** `ResolutionModule.processDetectedResolutions`
   calls `marketRepo.deactivate(tokenId)`
   (`resolution-module.ts:572`), setting `active=0` and cancelling
   open orders. Cessation is immediate at the moment of detected
   resolution.

#### D-B1 — Preserved-but-disappeared: accept current behaviour, no immediate fix

When a token meets the audit's "preserved-but-disappeared" pattern
(open position/order present, but token entirely missing from the
Gamma scan), `deactivateMissing` skips the row and leaves `tradable`
at its last UPSERT value — possibly `tradable=1`.

We accept this behaviour as canonical for v1, with the following
justification:

- **Pricing path is unaffected.** The execution-critical tier in
  `findTrackedForPricingTiered` force-includes any token with an open
  position or order regardless of `tradable`, so preserved-for-lifecycle
  pricing continues to flow.
- **NEW-BUY exposure is _not_ automatically cleared while the leg is
  open.** Because the open position/order keeps the token in
  `executionCritical`, tracked-set diffing does **not** evict the row
  via `TrackedMarketsChanged.removedTokenIds`, and
  `MarketSelectionCache.eligible` membership is driven by the last
  `NormalizedMarketUpdated` it received. If that last sample had
  `tradable=1`, eligibility stays sticky until one of: (i) the leg
  closes (position settles / order cancels), at which point the next
  scan's `deactivateMissing` writes `active=0` and tracked-set diffing
  evicts the cache entry; (ii) `ResolutionModule` detects resolution
  and calls `marketRepo.deactivate`; or (iii) Gamma starts returning
  the market again with `active=false` (branch 3 of D-B), causing the
  scanner UPSERT to flip `tradable=0`. So the BUY-eligibility window
  is bounded by leg duration + resolution-detector cadence, not by a
  single scan interval.
- **The disappear-while-holding pattern is rare.** Polymarket's
  resolution pipeline normally goes through Gamma `active=false`
  (branch 3) before the row is dropped from the catalogue entirely.
  A clean disappear is the unhappy-path edge of a delisting that
  bypasses the inactive-flag publication.

We accept the residual risk and add observability (D-F) so we can
measure how often the pattern occurs in production. If
`preservedDisappearedTokens > 0` is sustained over a rolling 24 h
window, a follow-up ADR will introduce a forced `tradable=0` write
for disappeared-preserved rows in `deactivateMissing`, which would
sever BUY eligibility immediately on the first scan that observes
the disappearance.

#### D-B2 — Resolution-deactivation is **not** a permanent tombstone

We **explicitly accept** today's behaviour: `ResolutionModule.deactivate`
sets `active=0`, but a subsequent scanner UPSERT can flip `active=1`
back if Gamma returns the same token in a later scan.

Justification:

- Polymarket / UMA resolution is intended to be terminal. If Gamma
  returns a resolved market in a later scan, that is a Polymarket-side
  anomaly (UMA late-resolution, replay, manual reopen), not a state
  the bot should silently silence.
- A reactivated row goes through Step 2 evaluation again on every
  scan; if the resolution event also drops `clobMarket.active`, the
  row is re-deactivated by branch 3 above on the same tick.
- Adding a permanent `resolved_tombstone` column requires schema
  migration + scanner conditional logic in
  `UPSERT_MARKET_SQL`; the trade-off is not justified by any observed
  production signal today. The audit explicitly listed this as an
  open question (Q8).

If production observation reveals reactivation of resolved markets at
non-zero frequency, a follow-up ADR will introduce a tombstone column
or a "resolution-tombstone" status in `selection_status`.

### D-C — `MARKET_DATA_MAX_TRACKED_TOKENS` semantics (capacity contract)

The pricing universe is bounded by the env knob
`MARKET_DATA_MAX_TRACKED_TOKENS` — default 1,000, hard cap 5,000
(`packages/config/src/env.ts:70`). Tier composition is:

1. **WS-tier (`executionCritical` + `entryCandidates`)** — bounded by
   `maxTokens`. Sorted by `selection_status` rank → fresh
   `effectiveScore` DESC NULLS LAST → `created_at` DESC → `token_id`
   ASC (`market-repository.ts:287-301`). `executionCritical` (open
   positions/orders) is force-included and never evicted by
   `entryCandidates`.

2. **`discoveryOnly` tier** — overflow beyond `maxTokens`, polled by
   a rolling cursor (`market-data-module.ts:390-393`). Cadence is
   lower than WS-tier 5 s; entry signal latency for an overflowed
   row degrades but the row is not dropped from observation.

No auto-grow. Operator may raise the env knob up to 5,000 if observed
`trackedTokenCount / maxTokens` ratio is sustained ≥0.8 (D-F surfaces
this metric). R25 reference-bot `active_7d` median = 1,942 condition
ids ≈ ~3,884 tokens (binary 2× heuristic), so the default of 1,000 is
deliberately under R25 steady-state coverage; we accept that some
entry candidates spend cycles in `discoveryOnly` rather than WS-tier.
This trades entry latency for reduced API quota in default
deployment. Auto-grow / dynamic resizing is **deferred** — listed as
audit Q3.

### D-D — No internal re-entry cooldown (Q17 — accepted answer)

Re-entry is **purely scanner-driven** by `UPSERT_MARKET_SQL`
(`market-repository.ts:38-62`). A token deactivated in scan N and
returned by Gamma in scan N+k has its `active`, `tradable`, and
`selection_status` recomputed from the current scan input alone — no
state from the prior deactivation persists or imposes cooldown.

This satisfies R25 §10.5 empirical observation (421 markets with
max-gap >30 days had subsequent interactions) without requiring a
prescriptive rule. Any future cooldown decision (e.g. "do not re-add
within N hours of a deactivate") will be a separate ADR; today's
behaviour is canonical.

### D-E — Score-tiebreak in `findTrackedForPricingTiered` (re-anchor of ADR-020 §D5)

The continuous score from ADR-020 is the Step 4 ranking signal inside
each `selection_status` tier. The comparator at
`market-repository.ts:287-301` applies, in order:

1. `selection_status` rank (`SELECTION_STATUS_RANK`).
2. Fresh `effectiveScore` DESC NULLS LAST. A score is treated as
   `null` when `features_captured_at < now − 4h`
   (`market-repository.ts:382` — `effectiveScore` helper). Stale
   scores cannot outrank fresh lower scores.
3. `created_at` DESC.
4. `token_id` ASC (deterministic tiebreak).

ADR-020 §D5 introduced this ranking; ADR-021 re-anchors it as the
Step 4 mechanism so future Step 4 changes have a single ADR to
reference. No code change.

### D-F — Watch-set telemetry (audit §3 D4)

Three read-only metric additions, surfaced in healthchecks and the
metrics snapshot:

1. **`MarketDataModule.getMetricsSnapshot()`** gains
   `wsCapUtilizationPct = round(trackedTokenCount * 100 /
maxTrackedTokens)`. Operators can warn at ≥80 % sustained (D-C
   resize trigger).

2. **`MarketScannerModule.healthCheck()`** appends a `watchSet`
   segment built from `MarketScanResult` of the most recent
   successful scan:
   `watchSet preserved=P deactivated=D firstSeen=F preservedDisappeared=X`.
   Numbers are last-cycle gauges (not cumulative counters), matching
   the pattern of the existing `discoveryLatencyMs p50/p90/max`
   segment.

3. **`preservedDisappearedTokens` (D-B1 observability).** The scanner
   computes `|activeTokenIds \ discoveredTokenIds|` (preserved tokens
   that were fully absent from this Gamma scan) at the same point it
   calls `deactivateMissing`. The count is exposed via
   `MarketScanResult.preservedDisappearedTokens` and surfaced in the
   same `watchSet` healthcheck segment so operators can detect the
   D-B1 edge in the wild without log mining.

No new env knobs. No behavioural change. Telemetry only.

## Consequences

### Positive

- **Q14 / Q15 / Q17 are now answered** in writing. Future Step 4
  audits can compare against this ADR rather than re-deriving the
  contract from runtime code.
- **Two-filter framing is explicit**: scanner admission writes
  `tradable=1`; NEW-BUY eligibility additionally requires
  `volumeLifetime !== 0` and INCLUDE. The ADR-018 §D1 `null → pass`
  waiver carries forward unchanged.
- **D-B four-branch cessation contract** removes ambiguity around
  preserved-for-lifecycle vs full-deactivate-in-place vs Gamma-drop
  vs resolution.
- **D-F telemetry** lets operators detect D-B1 occurrences in
  production without log mining and warns when WS-tier capacity is
  approaching the hard cap, anchoring D-C resize decisions in
  observed signal rather than guesses.

### Negative / accepted trade-offs

- **D-B1 is not enforced.** Preserved-but-disappeared tokens may
  retain stale `tradable=1` for as long as the active leg keeps the
  row in `executionCritical` — tracked-set diffing does not evict
  rows that are force-included via open positions/orders. Real
  cessation in this branch comes from leg closure, the resolution
  detector, or Gamma re-publishing with `active=false` (branch 3),
  not from `MarketDataModule.poll`. We accept the risk; D-F
  telemetry will tell us if it materialises and a follow-up ADR can
  add the `tradable=0` write inside `deactivateMissing` if needed.
- **D-B2 is not a tombstone.** A reactivated resolved market goes
  through Step 2 again. Acceptable because Step 2 + the resolution
  detector together prevent fresh BUYs on a resolved market via the
  `clobMarket.active` and resolution-deactivate paths; the residual
  risk is a transient `active=1` between the spurious Gamma return
  and the next resolution detection cycle.
- **Default capacity (1,000 tokens) is below R25 reference-bot
  steady-state coverage** (≈3,884 tokens at the median). Operators
  must size based on `wsCapUtilizationPct` rather than R25 reference.
- **No re-entry cooldown.** A flapping Gamma row will re-enter on
  every cycle it appears. Behaviour today; D-D codifies it. If
  flapping causes operational noise, a follow-up ADR will introduce
  a per-token cooldown.

## Rollback plan

ADR-021 introduces no schema changes and no behavioural changes — it
codifies de-facto behaviour and adds telemetry. To roll back:

1. Revert the D-F telemetry commits (the `wsCapUtilizationPct` field
   on `MarketDataStreamActivitySnapshot`, the `watchSet` healthcheck
   segment, and the `preservedDisappearedTokens` field on
   `MarketScanResult`).
2. Optional: leave the ADR document in place for historical record.

There is no DB or runtime state to migrate.

## References

- Spec §10 + §8 Q14/Q15/Q17 — `06_algorithm_spec.md` v5.11.
- Audit:
  [`docs/audits/2026-05-06-step4-watch-set-formation-and-maintenance.md`](../audits/2026-05-06-step4-watch-set-formation-and-maintenance.md).
- ADR-007 — volume proxy decision; D-A NEW-BUY filter inherits its
  `null → pass` semantics.
- ADR-018 — Step 1 universe ingestion; D1 codifies the
  `volumeLifetime === null` waiver that D-A relies on.
- ADR-019 — Step 2 hard eligibility filters; the SelectionRule
  evaluation referenced in D-A.
- ADR-020 — Step 3 soft-ranking score; D-E re-anchors §D5 score
  tiebreak as Step 4 mechanism.
