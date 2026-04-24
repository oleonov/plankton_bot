# ADR-014 — Bounded-midpoint price improvement (supersedes ADR-006 D1 only)

**Date:** 2026-04-24
**Status:** Proposed
**Spec source of truth:** `research_plankton/plankton-analysis/06_algorithm_spec.md` §7 (Execution) — still read-only.
**Related audit:** `docs/audits/2026-04-24-execution-pricing-and-dead-side-review.md` §Rec 1, §Rec 4.
**Factcheck:** `docs/audits/2026-04-24-execution-pricing-review-factcheck.md`.
**Supersedes (narrow):** `docs/adr/006-execution-price-policy.md` D1 only. D2 (postOnly relayer only), D3 (suggestedPrice telemetry-only), D4 (size tracks price), and D5 (no per-reason branches) are preserved verbatim and continue to compose on top of this ADR.

## Context

`06_algorithm_spec.md v2.3 §7` is descriptive, not normative, on execution: "partial, maker-like" at "top of the canonical book." ADR-006 froze this as `BUY = bestBid`, `SELL = bestAsk` with a one-formula-for-all-modes invariant to guarantee paper/live parity.

Two empirical observations force a bounded revision:

1. **Prod book-edge posting.** Factcheck §Prod: **80.9 %** of last-3-days BUY orders posted at `|price − bestBid| < 0.0005`. On typical two-sided books, posting at the bid edge leaves price improvement on the table that the original Plankton bot's trade history suggests it captured (±0.8 ¢-from-midpoint proxy in `analysis_clob_price_history`, classified No-Evidence in `07_algorithm_gaps.md` but directionally consistent).

2. **Wide-book unsafety of the naive fix.** A naive `max(bestBid, midpoint − tickSize)` reconstruction over prod snapshots produced max candidate delta of **+0.489** on wide books (e.g. `bestBid = 0.01, bestAsk = 0.99` above-binaries). That moves a BUY from a cheap maker edge to the middle of a dead book. A spread cap is mandatory; a raw midpoint policy is unsafe.

The canonical spec does not constrain execution price beyond decision-rule price operators, so this is operational policy — the same category as ADR-011 and ADR-013.

## Decision

### D1. Pricing mode is explicit, deterministic, single-formula

Introduce an enum `EXECUTION_PRICING_MODE ∈ { "edge", "bounded-midpoint" }` with a default that preserves ADR-006 D1 (`"edge"`). When the flag flips to `"bounded-midpoint"`, **all runtime modes** — simulation, paper, live-lite — use the new formula. Paper/live parity is preserved by requiring one formula per mode value, never a per-mode branch.

### D2. Bounded-midpoint formula

Let `ts = tickSize`, `bb = bestBid`, `ba = bestAsk`, `spread = ba − bb`, `mid = (bb + ba) / 2`.

**BUY:**

```text
if bb == null or ba == null:
  apply one-sided-policy ∈ { edge, skip }
  // "edge" returns bb (or ba for SELL if only ba is null) per ADR-006 D1
if spread > maxSpreadTicks * ts:
  apply wide-spread-policy ∈ { edge, skip }
raw       = mid − ts
snapped   = floorToTick(raw, ts)
improved  = max(bb, snapped)
capped    = min(improved, bb + maxImprovementTicks * ts)
priceBuy  = min(capped, ba − ts)          # never cross the ask
```

**SELL (mirrored):**

```text
raw       = mid + ts
snapped   = ceilToTick(raw, ts)
improved  = min(ba, snapped)
capped    = max(improved, ba − maxImprovementTicks * ts)
priceSell = max(capped, bb + ts)          # never cross the bid
```

Required invariants (enforced, not "should"):

- **BUY never crosses:** `priceBuy < bestAsk`.
- **SELL never crosses:** `priceSell > bestBid`.
- **Tick-grid alignment:** `priceBuy`/`priceSell` pass `validateExecutablePrice`.
- **Side-safe snap:** BUY floors (never pays more than intended); SELL ceils (never accepts less than intended).
- **BUY entry ceiling still applies:** ADR-013 `ENTRY_PRICE_CEILING = 0.75` check runs on the final price.
- **Size tracks final price:** ADR-006 D4 is unchanged — `size = suggestedSizeUsdc / finalPrice`.

### D3. Spread cap and improvement cap

Two independent caps, both in ticks (tick-agnostic across 0.001 and 0.01 grids):

- `EXECUTION_MAX_ENTRY_SPREAD_TICKS` — above this, BUY falls back to the wide-spread policy (default `"edge"`: return `bestBid`). Default: **20 ticks** (2 ¢ on 0.001 grid; 20 ¢ on 0.01 grid).
- `EXECUTION_MAX_EXIT_SPREAD_TICKS` — same for SELL, with a wider default because exits are not optional. Default: **40 ticks**.
- `EXECUTION_MAX_IMPROVEMENT_TICKS` — caps how much `finalPrice` can move toward midpoint vs the edge price. Default: **10 ticks** (1 ¢ on 0.001 grid; 10 ¢ on 0.01 grid). Prevents long-tail improvement on moderately wide books that still pass the spread cap.

Both caps are **ticks-of-the-market's-own-tickSize**, so the same numeric policy works on 0.01 and 0.001 grids without per-market overrides.

### D4. One-sided book policy

Separate knob from the spread cap, because a one-sided book is not a wide two-sided book — it's a structural absence of one side:

- `EXECUTION_ONE_SIDED_POLICY ∈ { "edge", "skip" }`. Default: **`"edge"`** — preserves ADR-006 behavior (BUY uses bestBid if bestAsk is null; SELL uses bestAsk if bestBid is null; skip if the needed side itself is null).

### D5. Observe-first rollout

Default configuration on ship:

```
EXECUTION_PRICING_MODE = "edge"   # ADR-006 D1 preserved
```

Flip to `"bounded-midpoint"` in prod only after a paper/live-lite canary window validates that the new formula's realized-fill delta vs the edge formula is non-negative across the book-width distribution. The canary pattern mirrors the dead-side guard (ADR-014's sibling recommendation in the audit): compute both prices on every signal, emit both in diagnostics, log `pricing-mode-delta`, but only place at the mode-selected price.

This ADR does **not** propose a default flip date. The flip is a separate operational decision backed by canary evidence.

### D6. Diagnostics shape

Every pricing resolution emits a fixed diagnostics record:

```
edgePrice          # bestBid for BUY, bestAsk for SELL (ADR-006 D1 reference)
midpoint
rawCandidate       # mid ∓ ts before snap
snappedCandidate   # after floorToTick / ceilToTick
finalPrice
spread
spreadTicks
improvementTicks   # |finalPrice − edgePrice| / ts (signed favourable)
tickSize
side
mode               # "edge" | "bounded-midpoint"
skipReason         # when mode returns skip: "wide-spread" | "one-sided"
```

Diagnostics land in the `SignalConversionSkipped` event on skip and in the info log on successful placement. They are the empirical basis for the eventual canary decision in §D5.

### D7. Non-divergence from ADR-006 D2-D5

This ADR does **not** touch:

- D2 — `postOnly` is still relayer-mode-only.
- D3 — `signal.suggestedPrice` stays telemetry-only.
- D4 — `size = suggestedSizeUsdc / finalPrice`; `finalPrice` just has a new source.
- D5 — no per-reason price branches. `scale-in`, `probe-entry`, `repricing-exit`, etc. all resolve through the same helper.

## Consequences

Positive:

- Captures observable price improvement on tight two-sided books (the 80.9 % edge-post rate collapses toward mid-book posting on ≤ 20-tick-spread markets).
- Preserves paper/live parity — one formula per mode value, zero per-mode branches.
- Failsafe on wide books: `maxSpreadTicks` keeps the 0.489-delta tail from reaching production; `maxImprovementTicks` bounds the moderate-width tail.
- Tick-agnostic caps work on both 0.01 and 0.001 grids without per-market config.
- Opt-in via `EXECUTION_PRICING_MODE`; rollback is a single env flip.
- Composable with ADR-013 (entry ceiling) and the dead-side near-end guard — both run after pricing on the final price.

Negative / neutral:

- Shifts some fills from bestBid-maker to inside-spread-maker. On thin-book markets this slightly lowers fill probability vs. posting at the bid. Acceptable on entries (optional); on exits the wider spread cap (40 vs 20 ticks) keeps the helper from skipping in more cases than the entry path.
- Diagnostics payload grows (~10 fields per signal). Rate-per-minute is signal-throughput-limited, not spam — logs already carry the signal envelope. Acceptable.
- Adds three env fields + one mode enum. Each has a conservative default that matches ADR-006 behaviour when `mode = "edge"`.

## Reversal conditions

Supersede this ADR if any of the following change:

- Canary replay shows the bounded-midpoint formula's realized-fill PnL is worse than the edge formula on representative book-width distributions.
- `06_algorithm_spec.md` is explicitly amended by the user to define a normative execution-price rule.
- A production incident shows the spread cap or improvement cap is miscalibrated in a way that cannot be fixed by retuning the ticks (i.e. the shape of the formula is wrong, not the constants).

## See also

- `docs/adr/006-execution-price-policy.md` — D1 superseded by this ADR; D2-D5 preserved.
- `docs/adr/013-entry-price-ceiling-and-exit-ttl-bump.md` — entry ceiling still applies post-pricing.
- `docs/audits/2026-04-24-execution-pricing-and-dead-side-review.md` — operational context for the formula + caps.
- `docs/audits/2026-04-24-execution-pricing-review-factcheck.md` — prod-verified claims backing the decision.
- `apps/runtime/src/executable-price.ts` — `resolveBoundedMidpointPrice` + tick snap helpers.
- `apps/runtime/src/modules/strategy/signal-to-order.ts` — `resolveExecutionTerms` branches on `EXECUTION_PRICING_MODE`.
