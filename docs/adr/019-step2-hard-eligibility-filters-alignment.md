# ADR-019 — Step 2: Hard eligibility filters alignment

## Status

Accepted — 2026-05-05

## Context

Step 2 of the pipeline ("Hard eligibility filters") was audited against
canonical algorithm spec
`research_plankton/plankton-analysis/06_algorithm_spec.md` v2.3 §0
("Live Pre-Entry Filter (Ordered)") and five gaps were identified — see
[`docs/audits/2026-05-05-step2-hard-eligibility-filters-remediation-plan.md`](../audits/2026-05-05-step2-hard-eligibility-filters-remediation-plan.md).

Spec §0 (`06:21-37`):

> **Live Pre-Entry Filter (Ordered)**
> STEP 1: event_slug prefix in (elon-musk-, bitcoin-, ethereum-) → INCLUDE (N=700)
> STEP 2: distinct_outcomes = 1 → INCLUDE (N=6,040)
> FINAL : EXCLUDE

Most of the implementation was already in place from ADR-003 + ADR-004
(Accepted 2026-04-20):

- ADR-003 maps `distinct_outcomes === 1` ⇔ `event.markets.length === 1`
  (every Polymarket market is binary; the spec's per-market reading is
  unrealisable on live data).
- ADR-004 codifies the four-rule selection engine
  (`include_prefix`, `exclude_prefix`, `include_slug`, `exclude_slug`),
  precedence (exact > longest-prefix; `exclude > include` at the same
  tier), STEP 2 fallback inside `evaluatePreEntry`, and the seeded
  `bitcoin-` / `ethereum-` / `elon-musk-` baseline (migration 037).

The Step 2 audit confirmed the engine and gate logic are correct. The
gaps were observability and defensive risk:

- **G1** — CLOB-fallback `mapMarket` hardcodes `eventMarketCount: 1`
  and returns no `eventSlug`, making it a self-INCLUDE for STEP 2
  fallback if it is ever reattached to discovery. Production code does
  not invoke it (Discovery goes exclusively through
  `GammaMarketDiscoveryGateway`); behavioural impact today = 0.
- **G2** — Silent `?? 1` fallback for `eventMarketCount` existed in
  nine places (DB DEFAULT × 3, repo bind/map × 2, read-side
  normalization, mapper default-arg, scenario seed, and the domain
  type itself was optional). Any new INSERT path without an explicit
  value would silently auto-INCLUDE multi-outcome markets via STEP 2
  fallback. Production scanner always passes the authoritative value;
  behavioural impact today = 0.
- **G3** — No funnel breakdown by `selectionStatus`. ADR-018 §D2 only
  surfaces a binary admit/reject split; the spec-wise question
  ("how many got admitted via STEP 1 vs STEP 2 fallback?") had no
  observable answer.
- **G4** — Possible drift of the ADR-003 39.17 % single-market
  baseline. A single-page spot probe on 2026-05-05 returned 28 %, but
  the query was `closed=false` (not `active=true&closed=false`) and
  one page is statistically biased by Gamma's pagination order.
- **G5** — Hot-reload composite latency bound (scan_interval +
  scan_duration + per-page non-atomic `saveBatch` + pricing-poll +
  eventual-consistency window) was understated as "≤ 1 tick" in the
  runbook, and the runbook also misnamed the env var.

## Empirical re-baseline (2026-05-05)

Stratified Gamma probe via the production server (Polymarket endpoints
are blocked from local dev; ran via
`ssh root@old.server.ip 'curl -s "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=N"'`
for `N ∈ {0, 1000, 2000, …, 10000}` — 11 pages spread evenly across the
pagination range):

| Metric                                        | Value                                    |
| --------------------------------------------- | ---------------------------------------- |
| Active non-closed events (universe estimate)  | **~10,027** (last non-empty offset)      |
| Sampled events (stratified, 11 pages)         | 1,027                                    |
| Sampled single-market events                  | 436                                      |
| Sampled share single-market                   | **42.4 %**                               |
| ADR-003 baseline (full 10,824 / 4,240 single) | 39.17 %                                  |
| Drift                                         | +3.2 percentage points (still ~baseline) |

Per-page ratios (offsets 0 → 10000):
13/100, 50/100, 24/100, 4/100, 15/100, 24/100, 27/100, 74/100, 81/100,
97/100, 27/27.

The earlier single-page 28 % spot probe (offset=0, `closed=false` only)
was sampling bias — Gamma's `/events` pagination clusters multi-market
events at low offsets (sports parlays, election bundles) and
single-market events at high offsets (long-tail binaries). Anything less
than a stratified sample produces non-comparable ratios.

**Conclusion:** the ADR-003 39.17 % baseline holds within ±5 percentage
points. No re-baseline of ADR-003 is required; this ADR records the
2026-05-05 stratified sample as the ongoing observability anchor.

## Decision

### D1 — CLOB-fallback `mapMarket` is discovery-incompatible by design (G1)

`packages/exchange/src/mappers.ts` `mapMarket` reads from the
`/markets` CLOB endpoint, which returns individual markets (not
event-grouped) and does not expose `event.slug` or
`event.markets.length`. Hardcoding `eventMarketCount: 1` and
`eventSlug: null` is a self-INCLUDE through STEP 2 fallback — wrong
for any discovery-time use, but acceptable in the live-trade /
live-pricing channels (CLOB market metadata refreshes for already-known
markets, where the scanner has already established the correct
event-level context via Gamma).

Production code does not invoke `mapMarket` from any discovery path
today (verified at audit time: only used in tests and a CLOB-only
gateway path that is dead-code in `apps/runtime`). To prevent future
re-attachment, a warning comment is added in-line at `mapMarket`
identifying it as discovery-incompatible and pointing to ADR-019 §D1.
No code changes are required beyond the comment.

### D2 — Silent `?? 1` fallback for `eventMarketCount` is a defensive foot-gun (G2)

Domain-level enforcement closes by P1:

- `Market.eventMarketCount: number` made required
  (`packages/domain/src/types.ts:43-80`) — was `eventMarketCount?:
number`. The TS strict-`exactOptionalPropertyTypes` setting now forces
  every caller to pass an authoritative value.
- `?? 1` removed in:
  - `packages/db/src/repositories/market-repository.ts:77` (INSERT bind)
  - `packages/db/src/repositories/market-repository.ts:304` (row → Market mapping)
  - `apps/runtime/src/modules/market-data/market-data-module.ts:1118-1120`
    (read-side normalization)
- Default-arg `{ slug: null, marketCount: 1 }` removed from
  `mapGammaMarket` (`packages/exchange/src/mappers.ts:336-339`); the
  pinned "defaults to 1" test in
  `packages/exchange/src/__tests__/mappers.test.ts` is replaced by an
  explicit-marketCount test.
- `apps/runtime/src/scenario/runner.ts:285-303` (`seedTrackedMarket`)
  now sets `eventMarketCount: clobMarket.eventMarketCount` explicitly
  on the seeded `Market` literal.

DB-level (`migrations/034_markets_selection_columns.sql:1`,
`packages/db/src/schemas/ledger.sql:25`,
`packages/db/src/bootstrap.ts:339`) keeps `NOT NULL DEFAULT 1` for now
— removing the SQLite DEFAULT requires a table-rebuild migration, sync
across fresh-schema and bootstrap, and a code review of every INSERT
into `markets`. Deferred as P3 in the audit; the domain-level
tightening makes the DEFAULT defensive-only (every production INSERT
now passes the value explicitly).

### D3 — Hot-reload composite latency bound is multi-tier (G5)

The propagation path for a rule change (UI mutation → live runtime
behaviour) is:

```
total_latency_max = MARKET_SCAN_INTERVAL_MS    (default 5 min)
                  + scan_duration                (10–60 s for the full universe)
                  + MARKET_DATA_POLL_INTERVAL_MS (default 5 s)
                  + per-page non-atomic saveBatch eventual-consistency window
```

Practical worst case: **~6 minutes**, not "≤ 1 tick". The bound is a
floor — markets on the first scanned page see the new rule sooner than
markets on the last page (per-page `saveBatch` is non-atomic by design;
atomic universe-wide rewrite would peak DB write load
unacceptably).

`docs/runbooks/selection_rules_operations.md:62` previously claimed
"≤ 1 scan tick (`MARKET_SCANNER_INTERVAL_MS`, default 60s)". Both
details were wrong — the env var name is `MARKET_SCAN_INTERVAL_MS` (see
`packages/config/src/env.ts:16`) and the default is `5 * 60 * 1000` ms
(5 min). Runbook patch lands alongside this ADR; same patch fixes the
match-debugger query example (the API contract requires `marketSlug`
plus optional `eventSlug`, not bare `?slug=`).

Alternative considered and rejected: invoke
`refreshIfStale()` from `MarketSelectionCache.processMarket` directly,
which would shrink the bound to one pricing tick. This would mean a
DB-poll on every `NormalizedMarketUpdated` event (thousands per second
under full load) — overhead is not justified for a routine operations
task with a 5-minute economy. The scanner-tick refresh remains the
canonical choke-point.

### D4 — Step 2 funnel breakdown counters at scanner-time (G3)

`MarketScannerModule` accumulates eight cumulative counters across
all scan cycles (mutated in place to keep memory flat):

```
Per-market (operational telemetry):
  scannedMarketsTotal                 (++ for every discovered market)
  ├─ marketsStep1MatchedInclude       (selectionStatus = matched_include)
  ├─ marketsStep1MatchedExclude       (selectionStatus = matched_exclude)
  ├─ marketsStep2FallbackInclude      (selectionStatus = step2_fallback_include)
  └─ marketsFinalExclude              (selectionStatus = fallback_exclude)

Per-event (ADR-003 baseline-validation):
  scannedEventsTotal                  (++ for every event with ≥1 nested market)
  ├─ eventsSingleMarketTotal          (events with markets.length === 1)
  └─ eventsMultiMarketTotal           (events with markets.length >  1)

  Zero-market events (malformed payloads or settled envelopes that arrive with
  `markets: []` / no `markets` field) are excluded from all three counters so
  the partition invariant `events == single + multi` holds and the ratio stays
  apples-to-apples with ADR-003.
```

Invariants (asserted in `market-scanner-module.test.ts`):

- Market partition (disjoint per market):

  ```
  scannedMarketsTotal == marketsStep1MatchedInclude
                       + marketsStep1MatchedExclude
                       + marketsStep2FallbackInclude
                       + marketsFinalExclude
  ```

- Event partition (disjoint per event):
  `scannedEventsTotal == eventsSingleMarketTotal + eventsMultiMarketTotal`.
- Apples-to-apples vs ADR-003:
  `eventsSingleMarketTotal / scannedEventsTotal` ≈ 39.17 % when the
  baseline holds (this ADR's stratified sample reads 42.4 %).
- Spec mapping: STEP 1 INCLUDE = `marketsStep1MatchedInclude`,
  STEP 1 EXCLUDE = `marketsStep1MatchedExclude`,
  STEP 2 INCLUDE = `marketsStep2FallbackInclude`,
  FINAL = `marketsFinalExclude`.

**Why scanner-time, not cache-time:** Step 2 is enforced at
scanner-time. Markets with
`selection_status ∈ {matched_exclude, fallback_exclude}` are persisted
with `tradable=false` and are then filtered out by
`findTrackedForPricingTiered` SQL
(`m.tradable = 1 AND selection_status NOT IN
('matched_exclude','fallback_exclude')`,
`market-repository.ts:225-230`). They never reach
`MarketSelectionCache.processMarket`, so cache-side counters cannot
observe rejected partitions. The scanner is the only place that sees
every discovered market regardless of `tradable`.

**Why split per-market and per-event:** ADR-003's 39.17 % baseline is
event-level (4,240 / 10,824). The scanner sees flattened markets
(`GammaMarketDiscoveryGateway.forEachMarketPage` emits `mapGammaMarket`
per market in each event); a market-level ratio uses a different
denominator and cannot be compared apples-to-apples. The gateway is
extended to pass per-page `eventStats: { events, singleMarket,
multiMarket }` to the scanner callback, computed at the page boundary
where event identity is still intact, so the scanner can accumulate
per-event totals without re-grouping flattened markets downstream.

Surfacing:

- `MarketScannerModule.getStep2BreakdownSnapshot()` returns the eight
  fields as a defensive copy.
- `MarketScannerModule.healthCheck()` appends
  `step2Breakdown markets=… step1Include=… step1Exclude=… step2Fallback=… finalExclude=… events=… singleMarket=… multiMarket=…`
  to its existing health string when `scannedMarketsTotal > 0`.
- The `runScan` info-level "scan cycle complete" log line is
  **not** extended with the breakdown — counters are cumulative across
  cycles, so a per-cycle delta would require a second snapshot of the
  previous cycle's value. Operators query `getStep2BreakdownSnapshot()`
  via the API surface for cumulative reads, and the healthcheck for
  always-on visibility.

**Apples-to-apples scanner query:** the gateway's `buildUrl`
(`packages/exchange/src/gamma/market-discovery-gateway.ts:148-162`) now
sets both `active=true` and `closed=false`, matching the ADR-003
baseline. Previously only `closed=false` was set, which made
`eventsSingleMarketTotal / scannedEventsTotal` non-comparable to
ADR-003's published ratio (`closed=false` includes paused/scheduled
events that are never tradable in the current cycle).

## Consequences

- The Step 2 funnel is now observable in real time without code
  changes. Step 3 audit (Soft ranking / scoring) can anchor its own
  metrics on top of `getStep2BreakdownSnapshot()` rather than
  instrument the gate from scratch.
- The 2026-05-05 stratified sample (42.4 %) confirms the ADR-003
  39.17 % baseline holds. Future drift is detectable via the live
  per-event ratio without manual probing — operators can compare the
  healthcheck `singleMarket=… events=…` numbers directly.
- `Market.eventMarketCount` is now a typed-required field across the
  domain, repository, and read-side. New INSERT paths cannot silently
  auto-INCLUDE via the silent-1 fallback — they fail the type-check or
  the repository bind. The DB-level `NOT NULL DEFAULT 1` remains as a
  defensive safety net (P3 deferred).
- The hot-reload composite latency bound is now ~6 minutes documented
  rather than "≤ 1 tick" promised. Operators planning rule rollouts
  can budget realistically. If 5+ minute latency becomes a recurring
  pain point, the cache-side `refreshIfStale` alternative (D3,
  rejected) can be revisited.
- Multi-market binary events (e.g. an event with two `Yes/No` markets
  on related questions) are deliberately excluded by spec STEP 2.
  Plankton intentionally skips them. This is by design and re-affirmed
  by this ADR — operators considering whether to add seeded prefixes
  for popular multi-market events should understand the spec
  trade-off.

## See also

- Spec §0 (`research_plankton/plankton-analysis/06_algorithm_spec.md:21-37`).
- ADR-003 — `distinct_outcomes === 1` ⇔ `event.markets.length === 1`
  mapping; this ADR validates its baseline against a fresh stratified
  sample.
- ADR-004 — four-rule selection engine; this ADR codifies the
  scanner-time enforcement choice that goes with it.
- ADR-018 — Step 1 universe ingestion alignment; D2's
  post-normalization funnel is binary admit/reject; this ADR's D4
  adds the per-status breakdown one tier upstream.
- [`docs/audits/2026-05-05-step2-hard-eligibility-filters-remediation-plan.md`](../audits/2026-05-05-step2-hard-eligibility-filters-remediation-plan.md).
- `docs/runbooks/selection_rules_operations.md` (patched alongside
  this ADR — match-debugger query and hot-reload latency bound).
