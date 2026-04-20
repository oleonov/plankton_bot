# ADR-009 — Live-lite steady-state caps (operational extension)

## Status

Accepted — 2026-04-20

## Context

Spec §6 (Portfolio Risk Limits) is explicitly observational, not enforcing:

> "Portfolio limits are observed-only; the reference implementation does not
> enforce them at execution time." — 06_algorithm_spec.md §6 and
> 08_pnl_validation.md §8

Runtime, however, handles real capital in `live-lite` mode. Without runtime
enforcement, `profile-preflight.ts` (which checks the envelope at startup) is
a one-shot guard: a run that starts under the cap can drift over it during
the session and the cap is never re-checked until the next launch.

The `LiveLiteGuard` class already exposes `wouldExceedOpenValueCap` and
`wouldExceedActiveMarketsCap`, but nothing calls them during steady-state
execution — only `isOrderWithinCap` (per-order notional) was wired up.

## Decision

### D1 — Runtime enforcement of envelope is an operational extension, not a spec change

The two envelope caps (`maxOpenValueUsdc`, `maxActiveMarkets`) become
enforced in `ExecutionModule.handlePlace` when `liveLiteGuard.isActive`.
BUY orders that would push total exposure or active-market count past the
operator-configured envelope are rejected with
`live-lite-open-value-cap-exceeded` / `live-lite-active-markets-cap-exceeded`.

Simulation and paper modes remain unchanged — they pass through
`LiveLiteGuard` as `isActive = false` and bypass the checks entirely. The
intent is _not_ to change spec behaviour; it is to close the gap between
preflight-at-launch and runtime-during-session for the one profile where
real money is at risk.

### D2 — Shared exposure formula with preflight

Drift between preflight and runtime would make the cap's meaning
mode-dependent. `apps/runtime/src/exposure-calculator.ts` holds the
canonical formula:

```
total_exposure = Σ open_position.cost_basis_usdc
               + Σ open_buy_orders.size_usdc
               + new_order.notional    (only when simulating a would-be order)
```

`ExecutionModule` consumes this helper directly. `profile-preflight.ts`
computes the same sums via raw SQL against the same columns
(`positions.cost_basis_usdc` where `status='open'`, `orders.size_usdc`
where `side='buy' AND status IN ('open','pending','partially-filled')`).
Any change to the formula must be landed in both places in the same PR.

### D3 — BUY-only enforcement

SELL reduces net exposure by design, so the cap is only evaluated on BUY
commands. A SELL that exceeds the envelope is either re-exit churn (which
already flows through min-order-size / reservation gates) or a spec-mandated
full-exit whose size is clamped by ADR-008 (SELL size clamp). Adding SELL
to this cap would double-penalise exits and cause stuck positions.

### D4 — Active-markets cap only bites on new-market BUYs

If the candidate `tokenId` already has an open position, the order is a
scale-in and doesn't add a new active market — the cap is skipped for
that path. Scale-in is bounded by the open-value cap from D2, which is
sufficient.

### D5 — No ADR backport to spec

Spec §6 stays observational in the canonical document. Any operator who
forks the runtime for spec-pure research can set `liveLiteGuard.isActive
= false` and get the original "observed-only" behaviour without removing
code. Runtime enforcement is a runtime-layer decision, not a spec
correction.

## Consequences

- `ExecutionModule` now hard-rejects BUYs that would push exposure past
  `maxOpenValueUsdc` or active markets past `maxActiveMarkets` in live-lite
  mode. Operator-facing rejection reasons distinguish the two caps.
- Preflight and runtime share the same formula via `exposure-calculator.ts`
  (runtime) and matching SQL (preflight). Regression suite asserts both
  paths agree on representative fixtures.
- Simulation/paper are unaffected; the spec-research workflow is preserved.
- `LiveLiteGuard.wouldExceedOpenValueCap(currentValue, additionalValue)` and
  `wouldExceedActiveMarketsCap(currentCount, additional)` are invoked with
  `additionalValue = 0` / `additional = 1` respectively — the helper
  pre-computes the total so the guard does a single comparison.
