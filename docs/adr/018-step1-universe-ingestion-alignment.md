# ADR-018 — Step 1: Universe ingestion alignment

## Status

Accepted — 2026-05-05

## Context

Step 1 of the pipeline ("Universe ingestion") was audited against canonical
algorithm spec `research_plankton/plankton-analysis/06_algorithm_spec.md` v2.3
§0 ("Historical Universe Filter") and six gaps were identified — see
[`docs/audits/2026-05-05-step1-universe-ingestion-remediation-plan.md`](../audits/2026-05-05-step1-universe-ingestion-remediation-plan.md).

Spec §0 R1 (`06:7-19`):

> **Historical Universe Filter**
> — Condition: `trade_count > 0` → **INCLUDE** (N=8,437)
> — Fallback → **EXCLUDE**

`trade_count` is forensic — it is only known post-hoc. A forward-running
runtime must use a live proxy. ADR-007 (Accepted 2026-04-20) selected
Gamma's `volumeNum` (lifetime cumulative USDC) as that proxy and codified
the three-way `null` / `0` / `>0` semantics:

- `volumeLifetime === 0` → DROP (proxy for §0 R1 fallback).
- `volumeLifetime === null` → pass-through (unknown, do not block).
- `volumeLifetime > 0` → forwarded to Live Pre-Entry Filter (Step 2).

Empirical 2026-05-05 dual probe (executed via `ssh root@old.server.ip 'curl …'`
because Polymarket endpoints are blocked from local dev):

- `gamma-api.polymarket.com/events?closed=false&limit=1` →
  `volumeNum = 17,976,157.53` USDC, populated.
- `gamma-api.polymarket.com/markets?clob_token_ids=…` →
  `volumeNum = 1,652,404.31` USDC, populated.

The pricing endpoint is the runtime source for the gate
(`LiveMarketDataGateway.getMarketPricing` → `extractPricing` reads
`raw.volumeNum` at `market-data-gateway.ts:368`), so dual confirmation is
required to prove the v2 cutover preserved the field on **both** discovery
and pricing channels. Both probes pass.

Three remediation options were considered for the §0 R1 ingestion-time gap
(audit G6: scanner already has access to `clobMarket.volume24h`, but does not
use it to gate `Market.tradable`):

- **Option A — enforce §0 R1 at ingestion** by adding `volume24h` to the
  `markets` row, persisting it in the DB schema, and filtering
  `findTrackedForPricingTiered` by `volume_24h > 0`. Strict spec
  compliance, minimal API quota waste, but requires migration + 27+ call-site
  rename concurrently with G3.
- **Option B — keep §0 R1 enforcement at pricing time** (current behaviour).
  `MarketSelectionCache` is the sole enforcer. Pricing loop wastes a small
  amount of API quota on markets that will be dropped at the gate, but no
  schema migration is required and the BUY-signal output is spec-equivalent.
- **Option C — defer entirely.** Rejected: G4 (funnel telemetry) must close
  before Step 2 audit can proceed.

## Decision

### D1 — Codify ADR-007 `null → pass` as an operational approximation (G2)

Spec §0 R1 strictly requires `Fallback: EXCLUDE` for everything that does not
satisfy `trade_count > 0`. ADR-007 D2's "`null → pass`" branch is
**not** literal spec compliance — it is a deliberate operational
approximation, and ADR-018 records it as such.

Rationale for the waiver:

- `null` legitimately occurs on the CLOB-only path (`mapMarket` reads
  `raw.volume_num` from CLOB `/markets`, which Polymarket does not populate
  on this endpoint by design).
- `null` also occurs on book-only stream updates: `applyPricingSnapshot`
  preserves prior `volume24h` via `pricing.volume24h ?? market.volume24h ?? null`
  (`market-pricing-utils.ts:30`), but on cold start
  (`getCurrentPricing` default `volume24h: null` at
  `market-pricing-stream.ts:1281`) a fresh market falls into `null` until
  the first Gamma volume tick lands.
- A strict `null → EXCLUDE` interpretation would pause BUY eligibility for
  every freshly tracked token until the first Gamma populated tick. This is
  unacceptable for a live runtime; we accept the soft branch and make it
  observable via D2.

Markets with `volumeLifetime === 0` continue to be dropped — that is the
strict §0 R1 enforcement path, and the empirical sample size of "explicit
zero" is what the spec actually anchors on.

### D2 — Post-normalization universe-filter funnel telemetry (G4 → P1)

`MarketSelectionCache` accumulates six process-cumulative counters,
incremented **per processed `NormalizedMarketUpdated` event** for tradable
tokens (NOT per unique token — the same `tokenId` may legitimately migrate
across buckets as volume arrives or selection rules reload):

```
seen
 ├─ volumeZeroDropped        (volumeLifetime === 0 → DROP, §0 R1 strict)
 ├─ volumeNullEvaluated      (volumeLifetime === null, ADR-007 waiver →
 │                            forwarded to evaluatePreEntry)
 └─ volumePositiveEvaluated  (volumeLifetime > 0 →
                              forwarded to evaluatePreEntry)

evaluated = volumeNullEvaluated + volumePositiveEvaluated
 ├─ selectionRuleAdmitted    (evaluatePreEntry → INCLUDE)
 └─ selectionRuleRejected    (evaluatePreEntry → EXCLUDE)
```

Invariants (asserted in unit tests):

- Volume partition (disjoint within layer):
  `seen == volumeZeroDropped + volumeNullEvaluated + volumePositiveEvaluated`.
- Selection partition (disjoint within layer; counts only evaluated events):
  `volumeNullEvaluated + volumePositiveEvaluated == selectionRuleAdmitted + selectionRuleRejected`.

Counters are monotonic since process start (counter-style, not per-cycle
gauge) — natural for a post-normalization stream that has no fixed cycle
boundary; `TrackedMarketsChanged` only fires on tracked-set diffs, not on
every pricing tick.

Surfacing:

- `MarketSelectionCache.getUniverseFilterSnapshot()` returns the six fields.
- `AlgoDecisionModule.healthCheck()` appends
  `universeFunnel seen=… volumeZeroDropped=… volumeNullEvaluated=… volumePositiveEvaluated=… selectionRuleAdmitted=… selectionRuleRejected=…`
  to its existing health string. Field names match the
  `UniverseFilterSnapshot` interface (and the periodic log line) so log /
  healthcheck queries can use a single canonical key set.
- A single info-level log line `"universeFunnel"` is emitted every
  `UNIVERSE_FUNNEL_LOG_INTERVAL_MS` (default 60 000 ms, range 5 000 –
  3 600 000) by a `setInterval` registered in `apps/runtime/src/index.ts`,
  cleared on shutdown. The first emission is suppressed while `seen === 0`
  to avoid no-op log spam during cold start.

The post-normalization scope is intentional: this is the funnel that the
spec-enforcer (the gate) actually sees. A scanner-level "discovery → R1
reject" view requires distinguishing markets dropped by slug filtering in
`findTrackedForPricingTiered` _before_ pricing — that telemetry is tracked
separately as P1.B and is deferred.

### D3 — G6 closed by Option B (at-pricing-time enforcement)

`MarketSelectionCache.processMarket` remains the sole §0 R1 enforcer. The
scanner's `Market.tradable` setting (`market-scanner-module.ts:295`) is
left untouched: it gates on `clobMarket.active && evaluatePreEntry`, with no
volume input.

Trade-off accepted:

- Pricing loop spends a small API quota on markets that will be dropped at
  the gate. Production volume of "never-traded but active" markets is low
  (audit G6, "Влияние: низкое"), so the steady-state cost is negligible.
- BUY-signal output is spec-equivalent: no `volumeLifetime === 0` market
  reaches `SignalProduced`.
- No schema migration required; the rename in G3 (deferred per D4) can land
  independently without coupling.

Trigger-criterion for revisiting Option A (deferred to first 24 h of
production observation of the D2 funnel):

- If `volumeZeroDropped` exceeds 5 % of `seen` over a rolling 24 h window
  (i.e. the pricing loop is wasting >5 % of its post-normalization
  bandwidth on markets that will be dropped), revisit Option A in a follow-up
  ADR. Below that threshold, Option B remains canonical.

### D4 — Defer rename `volume24h → volumeLifetime` (G3 → P3)

The field name `volume24h` is a misnomer (it stores lifetime cumulative
USDC, not 24-hour volume) inherited from the original schema. Rename
requires:

- migration 043 — `market_snapshots.volume_24h → volume_lifetime`.
- domain rename across `ClobMarket`, `MarketPricingSnapshot`,
  `MarketSnapshot`, `NormalizedMarket` and 27+ downstream read-sites.
- DTO/API rename for frontend (`web` / `api` consumers of `volume24h`).

Out of scope for Step 1. Behavioural impact is zero (only readability is
affected). Tracked in the audit's G3 / P3 entry.

## Consequences

- The §0 R1 funnel is now observable without code changes. Step 2 audit
  (Live Pre-Entry Filter) can anchor its own metrics on top of D2's counters
  rather than instrument the gate from scratch.
- `null → pass` is now an explicit, documented waiver. Future audit runs
  must not silently re-tighten it without revisiting D1 — and the
  `volumeNullEvaluated` counter makes any drift in null-rate immediately
  visible.
- §0 R1 enforcement remains at pricing time. The trigger-criterion in D3
  (5 % over 24 h) gives a quantitative gate for promoting to ingestion-time
  enforcement without the decision becoming taste-driven.
- Counters are process-cumulative and never reset, so deltas (per minute,
  per hour) must be computed downstream by the operator. That is acceptable
  for a long-running supervisor process; per-cycle gauges would force a
  cycle boundary that the post-normalization stream does not have.

## See also

- Spec §0 R1 (`06:7-19`).
- ADR-007 (volume proxy decision; this ADR codifies its operational
  approximation).
- ADR-017 D2 (Step 0 discovery-latency telemetry; D2 here mirrors the
  health-check / log-line surfacing pattern).
- [`docs/audits/2026-05-05-step1-universe-ingestion-remediation-plan.md`](../audits/2026-05-05-step1-universe-ingestion-remediation-plan.md).
