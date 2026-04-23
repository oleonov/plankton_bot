# ADR-012 — No horizon filter on pre-entry admission

## Status

Accepted — 2026-04-23

## Context

`06_algorithm_spec.md v2.3` and `07_algorithm_gaps.md v2.3` do not define a horizon filter: there is no canonical rule that gates admission on the distance between "now" and the market's `endDate`. The pre-entry engine in `packages/domain/src/market-selection.ts` and the scanner in `apps/runtime/src/modules/algo-decision/` likewise do not reference `endDate` when deciding whether a market is admissible; `endDate` is consulted only downstream, by the stale-order cleaner's safety-window check and by resolution detection.

The practical consequence (`2026-04-23-algo-followups-and-prod-observations.md §A5`): a market with an end-date months in the future is admissible on the same terms as one resolving tomorrow. If the product wants to forbid long-dated commitments, that constraint is currently unenforced.

Three options were considered:

- **2a — no filter (docs-only).** Record the decision explicitly; do not change runtime or spec.
- **2b — add a filter as a documented runtime extension.** `packages/domain/src/market-selection.ts` gains a pre-entry gate on `endDate`; `market-selection.test.ts` adds coverage; ADR captures the threshold and justification.
- **2c — amend `06_algorithm_spec.md`.** Requires explicit user authorization per `CLAUDE.md` (spec is read-only otherwise).

Scope at time of decision:

- The audit flags A5 as **medium**, not high. No production incident ties to the missing filter.
- 06/07 have been treated as read-only throughout the 2026-04-19 and 2026-04-23 remediation cycles; extending operational policy (ADR-011) has been the preferred vehicle for runtime overlays.
- A filter would overlap with the TTL/safety-window behavior (`stale-order-cleaner.ts`, `DEFAULT_TTL_MS = 6 h`, horizon-aware probe TTLs). A naive `endDate > X` gate applied without coordination with those TTLs would produce double-coverage rather than cleaner semantics.

## Decision

### D1 — Do not add a horizon filter

Runtime pre-entry admission continues to ignore `endDate`. `packages/domain/src/market-selection.ts` gains no new gate. `apps/runtime/src/modules/algo-decision/` retains its current scan logic.

Rationale for preferring 2a over 2b and 2c:

- **No product requirement pinned yet.** The audit note phrases A5 as a conditional ("_if_ the product requirement is 'do not hold long-dated markets'…"). A gate committed ahead of that decision would either be permissive (no effect) or restrictive (rejecting markets the product has not classified as out of scope). Neither serves users.
- **TTL policy already bounds exposure per order.** `DEFAULT_TTL_MS = 6 h` and the horizon-aware probe TTLs (`PROBE_LIKE_INTRADAY_TTL_MS`, `PROBE_LIKE_DAILY_TTL_MS`, `PROBE_LIKE_AD_HOC_TTL_MS`) already limit how long a single entry sits on a long-dated market without filling. The unfilled-cancel cooldown damps repeated re-entry on the same token. These were decided and frozen in ADR-011; adding an `endDate` gate on top would stack an untuned second mechanism for a problem that is already partially contained.
- **Reversibility is cheap.** If the product later declares a horizon limit, the gate lives in one function (`evaluatePreEntry` or a sibling) and is one test file away from being covered. Delaying the decision costs nothing in runtime surface area; committing early costs either (a) a gate whose threshold is arbitrary or (b) a gate whose threshold is never used.
- **Spec amendment is off-limits without explicit user authorization.** `CLAUDE.md` freezes `06_algorithm_spec.md`, so option 2c is not available on this change.

### D2 — Capture this explicitly; do not revisit through audits

- This ADR is the authoritative statement that the absence of a horizon filter is **intentional**, not an oversight.
- Future audits must cite this ADR when raising the horizon question, rather than re-opening A5 as an implementation gap.
- No edits to `06_algorithm_spec.md` or `07_algorithm_gaps.md`.
- No edits to `packages/domain/src/market-selection.ts` or tests.

## Consequences

Positive:

- Audits no longer flag A5 as open; `2026-04-23-algo-followups-and-prod-observations.md §A5` resolves against this ADR.
- No new parameter to tune, no test-coverage overhead, no runtime gate whose threshold would have to be justified in isolation.
- Keeps the split declared in ADR-011 clean: operational policy sits in the stale-order cleaner and in the signal-to-order bridge; decision policy sits in `market-selection.ts`. Adding a horizon gate to `market-selection.ts` without a product rule would have blurred that split.

Negative / neutral:

- Long-dated markets (weeks to months to `endDate`) remain admissible. Exposure on those markets is bounded by TTL + cooldown, not by an admission-time check.
- Capital utilization on long-dated markets is governed by the same risk-gate budget as any other market. If that becomes a concern in practice, the remedy is a scoped fix (e.g. a risk-gate carve-out) informed by data — not a blanket admission filter.

## Reversal conditions

Supersede this ADR if any of the following change:

- Product explicitly requires "no positions on markets with `endDate > X`" (or equivalent). The filter then ships as a documented runtime extension (option 2b), and this ADR is partially superseded by the new one.
- Operational data shows a concentration of losing or capital-locked positions that correlates with long-dated `endDate`, independent of TTL / cooldown effects.
- User explicitly authorizes editing `06_algorithm_spec.md` to add a horizon field; the filter then becomes canonical rather than an extension, and both this ADR and ADR-011's operational-policy framing are reconsidered.

## See also

- `research_plankton/plankton-analysis/06_algorithm_spec.md` — canonical spec (read-only).
- `research_plankton/plankton-analysis/07_algorithm_gaps.md v2.3` — classifies horizon handling as absent.
- `packages/domain/src/market-selection.ts` — pre-entry engine (no `endDate` reference).
- `apps/runtime/src/modules/reconciliation/stale-order-cleaner.ts` — TTL constants and endDate safety window (bounds exposure per order, not admission).
- `docs/audits/2026-04-23-algo-followups-and-prod-observations.md §A5, §P3` — audit note this ADR resolves.
- `docs/audits/2026-04-23-algo-followups-remediation-plan.md §Phase 4.B` — remediation plan step this ADR closes.
- `docs/adr/011-operational-extensions.md` — sibling ADR that keeps TTL / cooldown / `postOnly` / hard-liveness as operational policy; this ADR deliberately declines to add a sibling entry for horizon.
- `docs/adr/010-continuation-uses-local-leg-trade-count.md` — pattern for docs-only resolution of a decision-layer divergence.
