# ADR-013 — Entry-price ceiling guard + exit-TTL bump (operational)

## Status

Accepted — 2026-04-24

## Context

Live-lite analysis across 119 closed positions (2026-04-11 through 2026-04-24) showed a structural divergence between runtime behavior and the original bot's observed behavior on the same market families:

1. **Extreme-price BUY entries.** Our runtime posted BUY orders at `bestBid ≥ 0.80` on near-resolved binaries (e.g. `bitcoin-above-on-april-22` at 0.999). Cross-check against `research/data/plankton_trades.db activity` (48,273 BUY fills across 8,437 markets) shows the original bot filled **0** BUYs at `price ≥ 0.80`. Whether that is because the original bot's selection layer diverted those markets or because its execution layer never matched at those prices is not determinable from the trade-level data, but the outcome is the same: the behavior is outside the observed envelope and has produced stuck / negative-EV entries in prod.

2. **Exit-SELL orders cancelled before the book catches them.** `stale-order-cleaner.ts EXIT_ORDER_TTL_MS = 60 s` was cancelling `repricing-exit` SELLs while the order was still the best outstanding ask. Reconciled against the prod ledger (`ledger-live-lite.db`): 80 / 90 loser legs resolved without any SELL fill (89 %). The original dataset has no order-lifecycle data — `07_algorithm_gaps.md §No-Evidence Components` classifies open-order TTL as unreconstructable — so "match the original's TTL" is not an available lever. What is available is the fill-interval distribution: the original's time-from-first-BUY-to-first-SELL histogram has its modal bucket at 5–60 min (28 % of legs). A 60 s cancel cadence is strictly tighter than any bucket in that distribution.

`06_algorithm_spec.md v2.3` defines decision rules D1–D7 + Fallback and size rules B1–B7 + S1–S7, but does not constrain entry price (beyond the rule-level price operators) and does not define an order-lifecycle policy. Both areas are therefore governed by operational policy — the same category as ADR-011.

Two directions were considered:

- **Option 2a — leave as-is.** Ship only what `06/07` prescribes, accept the observed production leak. Directly contradicted by `ledger-live-lite.db`: the current ceiling-less + 60 s-TTL configuration is losing money against the observed envelope.
- **Option 2b — add both guards as operational extensions.** Neither changes the decision rules or size rules; both attach at the signal→order bridge or reconciliation layer. ADR-011 already established the pattern for this class of extension.

Option 2b matches the evidence, preserves the read-only status of `06/07`, and keeps each parameter single-sourced in one module.

## Decision

### D1 — Introduce an entry-price ceiling guard in the signal-to-order bridge

`apps/runtime/src/modules/strategy/signal-to-order.ts`:

```ts
export const ENTRY_PRICE_CEILING = 0.75;
```

When an approved BUY signal's resolved execution price exceeds the ceiling, the bridge publishes `SignalConversionSkipped` with `stage="execution-terms"` and `reasons=["price-above-entry-ceiling"]` and does not emit `PlaceOrderRequested`. SELL signals are unaffected: exit legs can legitimately cross above 0.75 (e.g. `state=S1 AND price >= 0.20` in D5 fires at any price in the upper half of the book).

The ceiling is deliberately set **below** the observed envelope's upper tail (original's max `avg_buy_price` across 8,893 legs was ≈ 0.698 — one `f: 0.50-0.80` leg with `avg_buy_price ≈ 0.65` and realized PnL −$544). 0.75 leaves a margin above that single observed entry while still rejecting the `0.80 → 1.0` region where original never filled.

This is **not** a dead-side / floor guard. Original's `price < 0.01` bucket contains 15,738 BUY fills and +$5,743 realized PnL; cheap lottery entries are core behavior, not noise. A narrower near-resolved / dead-side guard is deferred (see §Future Work) pending a canary measurement.

### D2 — Bump `EXIT_ORDER_TTL_MS` from 60 s to 300 s

`apps/runtime/src/modules/reconciliation/stale-order-cleaner.ts`:

```ts
export const EXIT_ORDER_TTL_MS = 300_000; // 5 m (was 60 s)
```

Rationale:

- 60 s is below every non-empty bucket of the original's first-BUY-to-first-SELL histogram. Under `07 §No-Evidence`, the original's TTL is unknown — but its _fill cadence_ is observable and incompatible with 60 s cancels.
- 300 s places the TTL at the lower edge of the "5–60 min" modal bucket. Orders that were going to fill in that bucket now survive the TTL; orders that stay stale beyond 5 min are still cancelled and reposted against fresher pricing.
- The existing `endDate` safety window (`ENDDATE_SAFETY_WINDOW_MS = 60 min`) continues to override TTL for near-expiry markets.

This is a one-line parameter change, not an architectural one. The stale-order cleaner's overall shape — cancel → publish `CancelOrderRequested` → allow the strategy to re-emit — is unchanged.

### D3 — Classify both as operational policy, not canonical reconstruction

Per ADR-011's framing: these belong in the same bucket as `UNFILLED_CANCEL_COOLDOWN_MS`, the horizon-aware entry TTL table, and `postOnly` in relayer mode. Their author of record is the runtime; any tuning requires either an audit log entry or an ADR supersession. No edit to `06_algorithm_spec.md` or `07_algorithm_gaps.md`.

### D4 — Paper ↔ live parity preserved

Neither parameter is mode-gated. Simulation, paper, and live-lite all observe the same ceiling and the same TTL. ADR-006's D1 invariant ("one price formula for all runtime modes") is not touched by this ADR — pricing still uses `bestBid` for BUY and `bestAsk` for SELL; only the admission gate is new.

## Consequences

Positive:

- The tail of BUY entries at `0.80 → 1.0` is eliminated at the bridge stage with zero cost when the ceiling does not bind (a single numeric comparison). Observed envelope is widely preserved — the 0 % fill rate at `≥ 0.80` means no historical business behavior is displaced.
- SELL orders on quiet books get the 5 min they need to actually match. The 89 % no-SELL-fill rate on loser legs is expected to collapse toward the original's envelope, where the loser-with-sell fraction is 100 % (79/79 losing legs had SELL activity).
- Both parameters live in a single `const` each; they can be retuned via an audit-log entry without schema or contract changes.

Negative / neutral:

- The ceiling rejects a small number of signals that would have filled and profited (e.g. binary markets resolving slightly above our 0.75 that still paid 1.0). These exist in principle; we have no evidence they exist in the original's envelope.
- 300 s exit TTL keeps stale SELL orders on the book ~5× longer. On fast-moving markets this means occasional fills at slightly worse prices than a tighter cadence would capture. The trade-off is explicitly chosen against the empirically larger cost of missed SELLs.
- Neither parameter is reconstructed from `06/07` — both are policy. Future audits that re-raise "why 0.75? why 300 s?" must read this ADR first.

## Reversal conditions

Supersede this ADR if any of the following change:

- Canary / replay data shows the ceiling is rejecting a meaningful volume of profitable entries (quantified against realized PnL, not signal counts).
- 300 s exit TTL produces its own tail: e.g. stale SELL orders consuming wallet budget or causing hard-liveness regressions. In that case the remedy is a horizon-aware exit TTL table (mirror of the entry-TTL shape), not a return to 60 s blanket.
- `06_algorithm_spec.md` is explicitly amended by the user to define an entry-price or exit-lifecycle rule. Canonical rules then displace this ADR's operational framing.

## Future Work (explicitly deferred)

- **Dead-side / near-resolved floor guard.** A `bestAsk ≤ 0.02 AND market.endDate - now < X` rejection would complement D1 by denying dead-lottery fills on markets close to resolution, without displacing cheap-lottery entries on long-dated markets. Deferred until a canary measurement identifies a defensible `X`.
- **Pricing policy change.** Moving BUY from `bestBid` to `max(bestBid, midpoint - tickSize)` (tick-grid snapped) would reduce the gap between our posted price and the original's observed ±0.8 ¢-from-midpoint fills. This requires a dedicated ADR superseding ADR-006's D1, because it changes the one-formula-for-all-modes invariant's formula. Not shipped here.

## See also

- `research_plankton/plankton-analysis/06_algorithm_spec.md v2.3` — canonical spec (read-only).
- `research_plankton/plankton-analysis/07_algorithm_gaps.md v2.3` — `Open order lifecycle (TTL / cancel / repost / cooldown)` and `maker vs taker execution enforcement` listed as No-Evidence.
- `research_plankton/plankton-analysis/08_pnl_validation.md v1.6` — PnL validation on the reference dataset.
- `apps/runtime/src/modules/strategy/signal-to-order.ts` — `ENTRY_PRICE_CEILING` + guard.
- `apps/runtime/src/modules/reconciliation/stale-order-cleaner.ts` — `EXIT_ORDER_TTL_MS = 300_000`.
- `docs/adr/006-execution-price-policy.md` — BUY=bestBid / SELL=bestAsk frozen; not superseded here.
- `docs/adr/011-operational-extensions.md` — sibling ADR that classified TTL / cooldown / `postOnly` / hard-liveness as operational policy; this ADR extends the same pattern.
- `apps/runtime/src/__tests__/signal-to-order-bridge.test.ts` — ceiling guard tests.
- `apps/runtime/src/__tests__/stale-order-cleaner.test.ts` — 300 s TTL tests.
