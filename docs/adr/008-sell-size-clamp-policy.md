# ADR-008 — SELL size clamp policy

## Status

Accepted — 2026-04-20

## Context

Spec §2 (Size Flow) derives SELL size deterministically from the state
condition (S1 → D5, S2 → D4, etc.) without any knowledge of how much of the
position is actually available at execution time. Intent size is therefore
frequently larger than `position.size − reservedSell`.

Evidence — `research_plankton/plankton-analysis/08_pnl_validation.md §7`:

- `full_exit_overshoot_count: 2,031` on **2,031** closed positions.
- Every single closed position in the reference replay had a full-exit
  SELL intent that exceeded the available position size at the moment the
  SELL was placed.

Prior to this ADR the runtime rejected such oversized SELLs with
`reserved-token-limit`, then waited for the next algo sweep to re-derive a
smaller intent (or for the position to shrink via some other path). That is
operationally fragile: an exit that spec §2 considers "complete" gets
indefinitely deferred whenever intent > available, which on the reference
dataset is 100% of the time.

Rejecting the order is also a spec-unfaithful interpretation: spec §2 says
"sell `size` shares", not "sell `size` shares only if `size ≤ available`".
The spec is silent on the availability constraint because it treats the
deterministic sizing layer as pure. The availability constraint only
appears at execution. Clamping at execution therefore does not violate the
spec — it clarifies the last-mile interpretation.

## Decision

### D1 — Clamp, don't reject, when intent > available (SELL only)

`ExecutionModule.getReservationDecision` returns one of three outcomes for
SELL orders where `availableSize < cmd.size`:

- **clamp** (default): emit the order with `size = availableSize`, log
  structurally at `info` level, increment the `sellSizeClamps` diagnostic
  counter.
- **reject**: only when `availableSize ≤ 0` (no position at all, or already
  fully reserved by another pending SELL).
- **reject-post-clamp**: when the clamp would produce a size below the
  exchange minimum (`getMinOrderSizeRejection` re-check after clamping).
  Returns reason `clamped-below-min-order-size`.

### D2 — BUY path is unchanged

BUY clamp is not meaningful — the `reserved-usdc-limit` rejection is an
arithmetic constraint that upstream sizing (`evaluateSize`) already
respects. Clamping a BUY mid-flight would silently under-fill an entry
that spec §2 considers complete.

### D3 — Env kill-switch: `ALLOW_SELL_SIZE_CLAMP`

Default `true`. Set to `false` to revert to reject-on-oversize behaviour.
The switch exists so that operators can disable the clamp temporarily if
the post-clamp replay (§4) shows regression in a future dataset.

### D4 — Metric: `sellSizeClamps` in `ExecutionModule.getDiagnostics()`

Monotonically-increasing counter. Not reset — used by the dashboard to
observe whether clamps are dominating SELL traffic, which would suggest an
upstream sizing bug.

### D5 — Spec-size remains authoritative for sizing calculations

The `evaluateSize` function in `packages/domain/src/size-flow.ts` continues
to return spec-derived size untouched. Clamp happens only at the execution
boundary; leg-state, inventory, and downstream metrics still see the
intended size for decision-making.

### D6 — Clamp UP when intent below min and residual above min (SELL only)

When SELL `cmd.size < minOrderSize` but `availableSize >= minOrderSize`,
execution clamps **up** to `availableSize` rather than rejecting. This
is symmetric to D1's clamp-down policy and is grounded in observed
Plankton placement behaviour:

- `research_plankton/plankton_sell_min_vs_residual_R71_report.md`:
  78.49% of SELL fills are above the exchange minimum; 4.41% are
  exactly at the minimum; 17.09% below are partial fills (not
  partial placements).
- In price bucket 0.30-0.50 median Plankton SELL size is 10.16
  shares, p25 is 4.76. Plankton placement is full-residual, not
  rule-budget-fractional.

Trade-off: this overrides the rule's `suggestedSize` for one specific
edge (intent below min). Spec §2 size remains authoritative until
the execution boundary; clamp-up is a last-mile interpretation of
«sell `size` shares» when `size` is unreachable but a valid SELL
is reachable.

## Acceptance gate

Per remediation plan §7.3 (lines 565–579), the merge gate for 7.3 is a
PnL replay against the `08_pnl_validation.md §7` reference fixtures:

```bash
pnpm --filter @krabs/runtime test -- replay-08-pnl-validation.test
```

Deliverable: `docs/audits/2026-04-19-pnl-replay-post-clamp.md`. The
replay is enforced by the test; the gate is satisfied iff the test
passes. The test-asserted invariants are:

- `full_exit_overshoot_count` drops to 0 under the clamp (by construction).
- Every attempted overshoot under clamp becomes a clamped SELL
  (`clamped_sell_count === attempt_overshoot_count`).
- Clamp-variant `sell_volume_usdc ≤` no-clamp `sell_volume_usdc` (the
  clamp can only reduce, never inflate).
- The dataset exercises the code path: no-clamp variant exhibits a
  non-zero `full_exit_overshoot_count`.

What the gate **does not** assert: exact equality of `closed_positions`
across the two variants. On the broader replay scope
(`research_plankton/data/plankton_trades.db`, superset of §7's
wallet-scoped subset) the two variants disagree by ~−548 closures. The
2026-04-19 replay report (§4.2) investigates and attributes this delta
to a trajectory artefact of the no-clamp replay — a SELL that overshoots
under no-clamp drives position negative and the subsequent BUY/SELL
interactions mis-count as additional "closures". `buy_volume_usdc` is
identical between the two variants (the clamp never touches BUY), so no
BUY-opened interval is lost; the difference is bookkeeping under
position-goes-negative semantics, not economic under-exit.

If a future run surfaces a closures delta that the same investigation
cannot explain as a trajectory artefact, the reviewer should disable the
clamp (`ALLOW_SELL_SIZE_CLAMP=false`) and revisit upstream sizing.

## Consequences

Positive:

- Eliminates the indefinite-deferral path for full-exit SELLs under
  oversize intent (100% of closed positions in the reference dataset).
- Observable: `sellSizeClamps` lets operators see whether clamps are
  dominant (suggests upstream sizing issue) or incidental.
- Reversible: the env flag lets operators fall back to reject semantics
  without a code change.

Negative / neutral:

- Slightly reduces SELL volume per exit when clamp is active. In the
  reference dataset this is exactly the overshoot that would otherwise
  bounce between algo sweeps — i.e. no economic value is lost.
- `evaluateSize` and the execution layer now disagree about the actual
  order size by design. The disagreement is visible in structured logs and
  in `sellSizeClamps`; consumers of leg-state see intent size, not clamped
  size, which is correct for continuation evaluation.

## See also

- `research_plankton/plankton-analysis/08_pnl_validation.md §7` — reference metrics.
- `docs/audits/2026-04-19-algo-spec-remediation-plan.md §7.3` — execution plan.
- `docs/audits/2026-04-19-pnl-replay-post-clamp.md` — replay acceptance report.
