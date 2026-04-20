# ADR-006 — Deterministic Execution Price Policy (bestBid/bestAsk + relayer-only postOnly)

**Date:** 2026-04-20
**Status:** Accepted
**Spec source of truth:** `research_plankton/plankton-analysis/06_algorithm_spec.md` §7 (Execution)
**Related plan:** `docs/audits/2026-04-19-algo-spec-remediation-plan.md` §6.5
**Related ADR:** `docs/superpowers/specs/2026-04-18-algo-spec-freeze-adr.md` (D-series decisions)

## Context

Spec §7 describes execution at a high level:

- Orders are "partial, maker-like."
- They target the top of the canonical book.

It is **descriptive, not normative**: it does not dictate tick-improvement, price tiers, speed lanes, or any randomisation. The original Plankton lab notebook implied a slightly richer family of maker heuristics (tick-better-than-best, adaptive midpoint), but those were reverse-engineered rather than specified, and the audit (`docs/audits/2026-04-19-algo-spec-compliance.md`) flagged them as invented stops.

After Phase 2 of the remediation plan (`marketability.ts`, `book-quality-policy.ts`, the marketability cooldown, and the `signal.suggestedPrice`-driven path were all removed), the live execution price is produced in exactly one place:

`apps/runtime/src/modules/strategy/signal-to-order.ts:286–294` (`resolveExecutionTerms`):

```ts
const price = signal.side === "buy" ? market.bestBid : market.bestAsk;
if (price == null || !Number.isFinite(price) || price <= 0) return null;
const isRelayer = this.deps.liveLiteGuard?.getWalletMode() === "relayer";
return isRelayer ? { price, postOnly: true } : { price };
```

There is no tick-improvement, no tiering, no alternative path per signal reason, no mode-specific formula, and `signal.suggestedPrice` is not consulted. The bridge publishes `PlaceOrderRequested` with `orderType: "GTC"`, `price = bestBid|bestAsk`, and `postOnly` only when the live-lite wallet is in relayer mode.

This ADR freezes that shape so future contributors don't accidentally re-introduce the deleted abstractions or drift paper and live apart.

## Decision

### D1. One price formula for all runtime modes

- **BUY** → `price = market.bestBid`.
- **SELL** → `price = market.bestAsk`.
- If either is `null`, non-finite, or `≤ 0`, the bridge publishes `SignalConversionSkipped` with `stage = "execution-terms"` and does **not** place an order. There is no fallback to midpoint, last trade, or `signal.suggestedPrice`.

The same formula runs in simulation, paper, and live-lite — by design, because drift between "paper says fill at X" and "live fills at Y" is the failure mode this policy exists to prevent.

### D2. `postOnly` is strictly relayer-mode-only

- `postOnly: true` is emitted only when `liveLiteGuard.getWalletMode() === "relayer"`.
- Simulation, paper, and live-lite-EOA all produce orders without `postOnly`. Rationale: the simulation order book doesn't model taker-vs-maker, paper has no settlement pressure, and live-lite-EOA is already rate-limited by our envelope caps (ADR-009 forthcoming) — the extra maker-only constraint adds reject churn without reducing risk.

### D3. `signal.suggestedPrice` is telemetry-only

`SignalProduced.suggestedPrice` (emitted by algo-decision as the midpoint of the book at signal time) is kept on the signal envelope **solely** as a diagnostic / metric field. The execution bridge does not read it. Downstream dashboards and PnL tooling may use it to reason about intent-vs-fill slippage, but it is not authoritative for any order parameter.

### D4. Size formula tracks the price formula

`resolveOrderSize` (`signal-to-order.ts:451–458`) converts the signal's `suggestedSizeUsdc` into tokens using **the same executionPrice** we're about to submit:

```ts
return signal.suggestedSizeUsdc / executionPrice;
```

This keeps the USDC-denominated envelope caps honest: an entry targeting `$X` of exposure always posts `X / bestBid` tokens at `bestBid`, regardless of signal reason. SELL orders pass `signal.suggestedSize` through verbatim because sells are token-denominated (leg-size-driven).

### D5. No per-reason price branches

`scale-in`, `heavy-scale`, `probe-entry`, `confirm-scale`, `repricing-exit`, etc. all route through the same `resolveExecutionTerms` helper. If a future change needs a reason-conditional price (e.g. "probe entries at bestBid − 1 tick"), it lands as a **new ADR** with empirical justification; it does not silently branch inside the helper.

## Consequences

- **Paper ↔ live parity is a property of the code, not a hope.** The only observable gap is fill probability (simulation always fills; live depends on the book). Price is identical.
- **Simulation of execution quality requires richer tooling** — since we removed tick-improvement heuristics, comparing our fills against a theoretical "best" fill is now a separate analysis task (see future PnL replay ADR).
- **Relayer deployments pay reject-churn for post-only**, but that's the point: relayer orders that would cross are rejected rather than taking liquidity and sidestepping the CTF maker-only policy.
- **`signal.suggestedPrice` can be removed without behaviour change** if we later decide the telemetry value isn't worth the payload weight. That is left as a future micro-refactor; not in scope here.
- **Tests that mock execution** (bridge tests, signal-to-order tests) depend only on `bestBid`/`bestAsk` on the cached market. No special-casing per mode.

## Non-goals

- **Not** a design for tick-better-than-best. If we later want to join-or-improve, it requires a dedicated ADR with empirical justification.
- **Not** a maker-side timing policy. Relayer `postOnly` is a correctness guard, not a fill-rate optimiser. Adaptive order lifetime / reprice intervals are out of scope.
- **Not** a defence of spec §7 as the optimal policy. It is a _deliberate_ operational choice to keep paper and live identical; if replay shows it's leaving PnL on the table, the remedy is a new ADR, not a silent drift.
- **Not** a change to `signal.suggestedSize` semantics — SELL path already ignores it-as-USDC because sells are token-sized by leg state.
