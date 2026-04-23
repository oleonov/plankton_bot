# ADR-011 — Operational extensions: TTL / cancel / repost / cooldown, maker `postOnly`, hard-liveness

## Status

Accepted — 2026-04-23

## Context

`06_algorithm_spec.md v2.3` and `07_algorithm_gaps.md v2.3` are the canonical sources for the trading algorithm. Both documents are treated as read-only (per `CLAUDE.md`) and mirror the research-side source in `research_plankton/`.

The following runtime behaviors are **not described** by `06/07`:

1. **Open-order lifecycle management**
   - Entry-order TTL and stale-order cleanup (`apps/runtime/src/modules/reconciliation/stale-order-cleaner.ts`): horizon-aware TTL buckets, `DEFAULT_TTL_MS = 6 h`, probe-like TTLs for `intraday-4h` / `daily` / `ad-hoc`, `EXIT_ORDER_TTL_MS = 60 s`, and an endDate safety window.
   - Cancel + repost on TTL expiry (same module) — the strategy may re-enter and place again after the previous order is cancelled.
   - Per-token **cancel-without-fill cooldown** (`apps/runtime/src/modules/strategy/signal-to-order.ts:38` — `UNFILLED_CANCEL_COOLDOWN_MS = 10 min`): after N unfilled entry cancels on the same token we refuse to place another order for that token until the cooldown lapses.

2. **Deterministic maker-like execution**
   - BUY at `bestBid`, SELL at `bestAsk` (`apps/runtime/src/modules/strategy/signal-to-order.ts:325-335`).
   - In relayer mode, the order is flagged `postOnly=true` to avoid accidental taker fills.

3. **Hard-liveness handling at the signal→order bridge**
   - `apps/runtime/src/modules/strategy/signal-to-order.ts:141-144` — skip with reason `hard-liveness` when the embedded normalized-market snapshot classifies the book as not healthy.
   - The underlying predicate is `isAlive` in `packages/domain/src/market-selection.ts:62` — unhealthy when any of `acceptingOrders !== true` / `enableOrderBook !== true` / `bestBid == null` (`no_bid`).

`07_algorithm_gaps.md v2.3` (quoted in [`2026-04-23-algo-followups-and-prod-observations.md §Scope`](../audits/2026-04-23-algo-followups-and-prod-observations.md)) explicitly classifies these three areas as **no evidence** in the underlying source material — i.e. the research inputs did not yield reconstructable primitives for any of them.

Two directions were considered:

- **2a — drop the extensions.** Ship only what `06/07` prescribes. Immediate consequence: no protection against stuck entry orders, no cooldown-driven damping on a degenerate fill rate, no bound on accidental taker fills in relayer mode, no admission control on books that are transitioning between healthy and `no_bid`.
- **2b — keep the extensions and freeze them as explicit _operational policy_.** The code does not represent them as reconstructed canonical behavior; compliance artifacts and audits label them as policy.

Option 2b matches the current runtime. Option 2a is a behavioral regression against operational data (`2026-04-23-algo-followups-and-prod-observations.md §B1, B2, B3, B6`): removing hard-liveness alone would re-admit 348 bridge-stage events / 24 h that the current runtime short-circuits.

## Decision

### D1 — Keep the three extensions in runtime

Runtime retains:

- stale-order cleaner TTLs + cancel/repost path (`stale-order-cleaner.ts`);
- per-token unfilled-cancel cooldown (`signal-to-order.ts:38`);
- maker `postOnly` in relayer mode (`signal-to-order.ts:325-335`);
- bridge-stage `isAlive` hard-liveness guard (`signal-to-order.ts:141-144` via `market-selection.ts:62`).

No code change ships with this ADR. This is a classification decision, not an implementation change.

### D2 — Classify these as **operational policy, not reconstructed canonical**

Every doc artifact that previously implied any of these behaviors were derived from `06/07` must be corrected. Concretely:

- Any "reconstructed canonical" claim for TTL / cancel / repost / cooldown / maker `postOnly` / hard-liveness in the compliance matrix and in `07_structural_gap_resolutions.md` is withdrawn. These items are **operational policy** with the author of record being the runtime implementation itself.
- `06_algorithm_spec.md` is **not** edited. The spec remains the canonical algorithm description; these extensions are acknowledged as additive runtime policy that sits _on top of_ the spec.
- Future audits must cross-reference this ADR when touching any of the three areas above, rather than implying the behavior flows from the spec.

### D3 — Parameter ownership stays with the code

The TTL table, cooldown duration, and hard-liveness reason set are owned by the implementation files listed above. Changes to any of these parameters require either an audit log entry (for tuning) or an ADR supersession (for structural shifts — e.g. dropping the cooldown entirely).

## Consequences

Positive:

- Stops the silent claim that `07_structural_gap_resolutions` or the compliance matrix reconstruct these behaviors from `06/07`. The classification matches what is actually true: research-side evidence is absent; runtime needs these to be operable in production; the decision is explicit.
- Keeps the spec decoupled from operational concerns. `06/07` remains a statement of strategy; this ADR is the authoritative statement of the policy overlay.
- Makes future reversibility clean: if `06/07` ever acquires first-class descriptions of any of these items, the affected extension stops being operational policy and rejoins the canonical surface; the ADR is then superseded in the relevant scope only.

Negative / neutral:

- Readers of the audits must know to follow this ADR rather than inferring canonicity from `07_structural_gap_resolutions.md`. This is the price of making the divergence explicit.
- Tuning decisions (e.g. the 10 min cooldown, the 6 h default TTL) no longer point to a spec reference for their magnitudes. Justification lives in production observations (e.g. `2026-04-23-algo-followups-and-prod-observations.md §B2, B6`) and in the cleaner's inline comments.

## Reversal conditions

Supersede this ADR (in part or in whole) if any of the following change:

- `06_algorithm_spec.md` or `07_algorithm_gaps.md` acquires a first-class description of any of the three areas. The affected item then ceases to be operational policy.
- Production data demonstrates that any of the three items is a net negative (e.g. cooldown suppresses profitable re-entries more than it saves on noise) and the item should be removed rather than tuned.
- Product explicitly classifies an item as canonical strategy (e.g. postOnly execution becomes a spec requirement rather than a runtime convenience).

## See also

- `research_plankton/plankton-analysis/06_algorithm_spec.md` — canonical spec (read-only).
- `research_plankton/plankton-analysis/07_algorithm_gaps.md v2.3` — classifies TTL / cancel / repost / cooldown / deterministic maker-taker / low-liquidity handling as **no evidence**.
- `apps/runtime/src/modules/reconciliation/stale-order-cleaner.ts` — TTL constants, cancel/repost path.
- `apps/runtime/src/modules/strategy/signal-to-order.ts` — cooldown state machine (`UNFILLED_CANCEL_COOLDOWN_MS = 10 min`), `postOnly` in relayer mode, bridge-stage hard-liveness guard.
- `packages/domain/src/market-selection.ts:62` — `isAlive` predicate driving hard-liveness.
- `docs/audits/2026-04-23-algo-followups-and-prod-observations.md §A4, §A5, §P2` — operational observations that motivate keeping the extensions.
- `docs/audits/2026-04-23-algo-followups-remediation-plan.md §Phase 4.A` — remediation plan step this ADR closes.
- `docs/adr/010-continuation-uses-local-leg-trade-count.md` — sibling waiver for a decision-layer divergence; uses the same "divergent-documented" pattern.
