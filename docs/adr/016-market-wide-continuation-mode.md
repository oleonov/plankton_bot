# ADR-016 — Market-wide continuation mode (opt-in, hot-reloadable)

## Status

Accepted — 2026-04-26 — Amends ADR-010 (does not rescind it; `leg_local` remains the default).

## Context

ADR-010 (2026-04-23) chose branch **2b**: keep the post-entry continuation
filter on `legTradeCount = legState.buyCount + legState.sellCount` (per-leg
fill counter on our own book) instead of polling `data-api.polymarket.com`
for the canonical, market-wide `trade_count` defined in
`research_plankton/plankton-analysis/06_algorithm_spec.md` §0:

- `trade_count >= 6` → R1 continue, OR
- `firstTradePrice >= 0.05 AND trade_count >= 2` → R2 continue, OR
- otherwise → STOP.

Two of ADR-010's reversal conditions have since fired in production:

1. **"Operational data shows continuation misfiring in a way attributable to
   the local-vs-market gap."** Audit
   `docs/audits/2026-04-26-pnl-loss-investigation-and-plan.md` §2.3, §2.9
   established that legs are pinned at `buyCount=1` after the first own fill:
   per-leg count `1` fails both R1 (`>= 6`) and R2 (`>= 2`), STOP fires, and
   the gate's `return null` blocks every subsequent signal — including
   SELL — before `evaluateDecision` runs (`algo-decision-module.ts:528-543`).
   The empirical impact is concrete: 0 active legs in S3, 2 transitions to S3
   in 5 days, and the spec's D7 rule (which `08_pnl_validation.md` §5
   attributes 92% of expected PnL to) effectively never fires.

2. **Operator-driven canary fitness.** ADR-015 shipped the
   `runtime_control_state` + `runtime_control_state.execution_policy_version`
   hot-reload pattern. Adding a second knob behind the same mechanism is
   cheap; the friction that made ADR-010 prefer 2b ("new runtime failure
   mode on the hot path") is now cushioned by the existing fallback wiring.

A 2026-04-26 SSH probe against prod confirmed the data-api endpoint is
operationally suitable:

- `GET /trades?market=<conditionId>&limit=6` returns trades for **both**
  outcome tokens (Yes + No) under one `condition_id`, matching the spec's
  per-market definition.
- Cloudflare returns `cache-control: public, max-age=300`; `cf-cache-status`
  flips MISS → HIT, `age` increments. The 5-min CDN TTL aligns with the
  existing 5-min `sweepIntervalMs`.
- Latency distribution across 9 samples / 3 markets: p50 ≈ 75 ms,
  p95 ≈ 87 ms, p99 ≈ 87 ms — well under the 200 ms hot-path budget.
- Edge cases handled correctly: empty markets return `[]`, resolved/closed
  markets return historic trades, unknown `conditionId` returns `[]`.

## Decision

### D1 — Introduce a new operator-controlled `continuation_mode`

A new column on the singleton `runtime_control_state` row records the active
mode:

- `leg_local` (default) — preserves ADR-010 behavior. `evaluateContinuation`
  receives `legState.buyCount + legState.sellCount`. No new runtime
  dependency on data-api. This is the safe-by-default mode for fresh installs
  and any environment without `MarketTradeCountProvider` wired.
- `market_wide` — opt-in. The post-entry continuation gate consults a
  `MarketTradeCountProvider` (see D3) for the market-wide count under
  `condition_id`, capped at 6 (the R1 threshold). When the provider returns
  `null` (timeout, network, parse error, HTTP non-2xx), the gate degrades
  transparently to `leg_local` for that single decision and tags the
  suppression telemetry with `tradeCountSource = "leg_local_fallback"`.

The two-mode design is deliberately conservative: `leg_local` remains a
documented, supported, regression-free path. The mode flip is
operator-driven, reversible per-tick, and auditable through
`operator_commands`.

### D2 — Hot-reload via version-polled snapshot

Mirroring ADR-015 D3 (`execution_policy_version`):

- `runtime_control_state.continuation_mode_version INTEGER NOT NULL DEFAULT 0`
  is bumped atomically inside `setContinuationMode` only when the requested
  mode differs from the current one (idempotent on no-op writes).
- `AlgoDecisionModule.refreshContinuationMode()` is called at the top of
  `evaluateTokens` (every sweep tick + every `NormalizedMarketUpdated`).
  It reads the version first; only on a bump does it re-read the mode and
  log a `continuation_mode_changed` info event.
- `readContinuationMode` / `readContinuationModeVersion` short-circuit to
  `leg_local` / `0` when the column is missing (legacy DB) so the runtime
  preserves ADR-010 behavior on un-migrated installs.

### D3 — `MarketTradeCountProvider` interface + `DataApiTradeCountProvider`

Domain interface (`packages/domain/src/repositories.ts`):

```ts
export interface MarketTradeCountProvider {
  countTrades(conditionId: ConditionId, cap: number): Promise<number | null>;
  prefetch?(conditionIds: readonly ConditionId[], cap: number): Promise<void>;
}
```

- `countTrades` returns the actual count when `< cap`, returns `cap` once
  the source confirms there are at least `cap` trades, and `null` on
  transient failure.
- `prefetch` is optional batch warming. The default implementation in
  `DataApiTradeCountProvider` is `Promise.all` over `countTrades`.

Concrete implementation in `@plankton/exchange`
(`packages/exchange/src/data-api-trade-count-provider.ts`):

- HTTP client over `https://data-api.polymarket.com/trades?market=<conditionId>&limit=<cap>`.
- LRU cache, default TTL `300_000 ms` (matches CDN `max-age=300` and
  `sweepIntervalMs`); `MAX_CACHE_ENTRIES = 10_000` with re-set-on-access for
  ordering.
- Per-request timeout `2_000 ms` via `AbortSignal.timeout` (~25× the cached
  p95 of 75 ms and ~5× the cold-start budget observed in the probe).
- Returns `min(rows.length, cap)`. Errors collapse to `null` (no exceptions
  on the hot path).
- Observer hook for telemetry: `cache_hit | cache_miss | fetch_ok | fetch_error`.

The provider is constructed unconditionally in
`apps/runtime/src/index.ts` and passed to `AlgoDecisionModule`. It performs
no I/O until `countTrades` is actually called (`market_wide` mode only),
so the construction cost on `leg_local` installs is zero beyond a
constructor call.

### D4 — Continuation gate selects the source per-decision

In `evaluateToken` at the post-entry continuation gate
(`apps/runtime/src/modules/algo-decision/algo-decision-module.ts`):

```ts
const { count: tradeCount, source: tradeCountSource } =
  await this.resolveContinuationTradeCount(
    market.conditionId as ConditionId,
    emissionFacts.legTradeCount,
  );
const stop = !evaluateContinuation(tradeCount, legState.firstTradePrice);
```

`resolveContinuationTradeCount`:

- `mode = leg_local` OR no provider wired → use `legTradeCount`,
  `source = "leg_local"`.
- `mode = market_wide`, provider returns a number → use that,
  `source = "market_wide"`.
- `mode = market_wide`, provider returns `null` → fall back to
  `legTradeCount`, `source = "leg_local_fallback"`.

The `evaluateContinuation` arithmetic is unchanged. ADR-010 D1's choice of
"strictly less information" is no longer fixed at compile time; it is now a
per-tick policy decision.

### D5 — Pre-tick batch prefetch

In `market_wide` mode, the per-token `await countTrades(...)` would stack
~75 ms × N latency on a sweep with cold cache. To avoid this,
`evaluateTokens` runs a pre-pass:

```ts
await this.prefetchContinuationTradeCounts(tokenIds);
```

The pre-pass collects unique `conditionId`s for tokens that already have a
`legState` (only those reach the continuation gate), deduplicates, and calls
`provider.prefetch(...)` once. With cache + Promise.all batch, the
worst-case sweep latency is bounded by a single cold `~300 ms` round-trip
plus the deserialization cost — not `N × ~75 ms`.

### D6 — Operator surface: `GET/PATCH /api/v1/runtime/policy`

`apps/api/src/routes/runtime-policy.ts` exposes the toggle:

- `GET /runtime/policy` → `{ continuationMode, continuationModeVersion }`.
- `PATCH /runtime/policy` body `{ continuationMode: "leg_local" | "market_wide", reason?: string }`
  → validates against the allowed set (400 on `INVALID_CONTINUATION_MODE`),
  calls `setContinuationMode` (atomic, version-bump-on-change), and audits
  to `operator_commands` only when `changed = true`. Idempotent on same
  value.

Bearer auth is required, same posture as `/actions/pause`.

### D7 — Telemetry on suppression includes the chosen source

The `signal_suppressed` payload now carries:

- `tradeCount: number | null` — the value that was passed to
  `evaluateContinuation` (when applicable).
- `tradeCountSource: "market_wide" | "leg_local_fallback" | "leg_local" | null`.
- `continuationMode: ContinuationMode` — the active policy at decision time.

This makes "the gate stopped because the count was X under mode Y" directly
queryable from `risk_events` for canary attribution. A spike in
`leg_local_fallback` is the leading indicator that data-api is degraded;
auto-rollback hooks into this metric in P8.

## Schema

```sql
ALTER TABLE runtime_control_state
  ADD COLUMN continuation_mode TEXT NOT NULL DEFAULT 'leg_local'
  CHECK (continuation_mode IN ('leg_local', 'market_wide'));
ALTER TABLE runtime_control_state
  ADD COLUMN continuation_mode_version INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1);
```

Migration `040_continuation_mode.sql`. The canonical schema in
`packages/db/src/schemas/control.sql` is updated to declare these columns
on fresh installs; `bootstrap.ts` includes a baseline entry for migration
040 so fresh DBs do not redundantly `ALTER ADD` an already-present column.

## Consequences

### Benefits

- **Spec alignment is reachable without permanent commitment.** The default
  is still `leg_local`; an operator can flip to `market_wide` per profile
  to validate spec alignment empirically before any production rollout.
- **Hot-path failures degrade silently.** `null` provider returns degrade
  per-decision to `leg_local`, never crash the sweep. The
  `leg_local_fallback` tag distinguishes degraded operation from explicit
  policy.
- **Audit trail.** Every flip is logged to `operator_commands` with
  initiator + reason. Suppression events carry the active mode and the
  source. The version column proves the runtime saw the change.
- **No env-var sprawl.** Mode lives in DB, with the same hot-reload
  ergonomics as ADR-015 execution policy.

### Costs

- **New runtime dependency on data-api when `market_wide` is active.**
  ADR-010's original concern is acknowledged and mitigated rather than
  eliminated: the dependency is now opt-in, the cap (6) makes the
  3000-row offset limit irrelevant, and `null` returns are first-class.
- **Two cache populations on a cold start.** First sweep tick after
  process restart pays the cold round-trip for every leg; subsequent ticks
  hit cache for 5 minutes.
- **Operator must understand the toggle.** Adds a second knob to the
  operator's mental model. Mitigated by suppression telemetry exposing the
  active mode on every gate-driven `null`.

## Reversal conditions

This ADR should be revisited if:

- Production canary shows the `market_wide` path materially destabilizing
  signal output (e.g., signals on stale state) and the cap-and-fallback
  design proves insufficient to bound the blast radius.
- `data-api.polymarket.com` shifts auth or rate-limit posture in a way that
  invalidates the no-auth, 5-min CDN-cached read pattern.
- Polymarket ships a first-class `trade_count` field on Gamma `/markets`
  or CLOB `/markets`, in which case the provider should be re-pointed at
  the cheaper source and this ADR amended (not rescinded — the pattern
  stays).

## See also

- `research_plankton/plankton-analysis/06_algorithm_spec.md` §0 (canonical
  spec, read-only).
- `docs/adr/010-continuation-uses-local-leg-trade-count.md` — original
  divergence ADR. Amended by this ADR; `leg_local` remains the default.
- `docs/adr/015-db-backed-execution-policy.md` — pattern reference for
  version-polled hot-reload.
- `docs/audits/2026-04-23-gamma-trade-count-probe.md` — empirical
  P3 (data-api `/trades` polled count) probe.
- `docs/audits/2026-04-26-pnl-loss-investigation-and-plan.md` §2.3, §2.9 —
  empirical evidence the local-vs-market gap is misfiring continuation.
- `docs/audits/2026-04-26-continuation-spec-alignment-plan.md` — the
  P0–P8 implementation plan this ADR ratifies.
- `packages/domain/src/repositories.ts` — `MarketTradeCountProvider`
  interface.
- `packages/exchange/src/data-api-trade-count-provider.ts` — concrete
  implementation.
- `packages/db/src/repositories/runtime-control-state-repository.ts` —
  `readContinuationMode`, `readContinuationModeVersion`,
  `setContinuationMode`.
- `apps/runtime/src/modules/algo-decision/algo-decision-module.ts` —
  `refreshContinuationMode`, `prefetchContinuationTradeCounts`,
  `resolveContinuationTradeCount`.
- `apps/api/src/routes/runtime-policy.ts` — `GET/PATCH /runtime/policy`.
