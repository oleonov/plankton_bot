# ADR-003 — STEP 2 `distinct_outcomes` field mapping

## Status

Accepted — 2026-04-20

## Context

Spec (`research_plankton/plankton-analysis/06_algorithm_spec.md §0`) defines STEP 2 of the live pre-entry filter as:

> `distinct_outcomes = 1 → INCLUDE; Fallback EXCLUDE`

with a historical cardinality of **N=6,040** markets on the training-set universe.

Runtime filter (`apps/runtime/src/modules/algo-decision/market-selection-cache.ts` via `evaluatePreEntry` in `packages/domain/src/selection-rules.ts`) applies the equivalent gate as `eventMarketCount === 1` — where `eventMarketCount` is sourced from `event.markets.length` on the Gamma `/events` response.

Prior to this ADR the mapping from spec's `distinct_outcomes` to runtime's `eventMarketCount === 1` was undocumented, and the runtime made the implicit claim that the two are numerically identical on production traffic. The remediation plan §5 required empirical validation against the live active universe, not a 100-market sample.

## Empirical findings (2026-04-20)

Full pagination of the active, non-closed Gamma universe (`ssh root@old.server.ip 'curl -s "https://gamma-api.polymarket.com/events?limit=500&active=true&closed=false&offset=N"'` for N ∈ {0, 500, …, 10500}):

| Metric                                              | Value      |
| --------------------------------------------------- | ---------- |
| Active non-closed events                            | **10,824** |
| Total markets across all events                     | 71,426     |
| Events with `markets.length === 1` (STEP 2 INCLUDE) | **4,240**  |
| Events with `markets.length > 1` (STEP 2 EXCLUDE)   | 6,584      |
| Share single-market                                 | 39.17 %    |

Top of the `markets.length` distribution:

|     `markets.length` | Event count |
| -------------------: | ----------: |
|                    1 |       4,240 |
|                    2 |         202 |
|                    3 |       2,058 |
|                    4 |          91 |
|                    5 |         222 |
|                    6 |          83 |
|                    7 |         120 |
|                    8 |         506 |
|                    9 |       1,569 |
|                   10 |         136 |
| …tail (max observed) |         139 |

Per-market outcome cardinality:

- **All 71,426 markets have exactly 2 outcomes** (`outcomes.length === 2`, always `["Yes","No"]`). Polymarket markets are binary by platform contract.

Therefore `distinct_outcomes` at the **per-market** level is always 2, not 1; the spec's `distinct_outcomes === 1` cannot be read literally per-market. The only reading that matches the STEP 2 intent (i.e. filter-in the simple case, filter-out the multi-leg case) is at the **event** level: "event that has exactly one distinct binary market".

## Decision

### D1 — Map `distinct_outcomes === 1` ⇒ `event.markets.length === 1`

`MarketSelectionCache` continues to filter on `eventMarketCount === 1` (sourced from `event.markets.length` at the Gamma mapping boundary; see `packages/exchange/src/mappers.ts` — `mapGammaMarket` + `mapGammaEventToMarkets`). This is the structural equivalent of STEP 2 on the Polymarket platform.

### D2 — Waive the spec's N=6,040 numerical claim

The 6,040-row cardinality in the spec is a snapshot of the training-set universe. Today's active universe has 4,240 single-market events and 10,824 total active events. We explicitly **do not** claim to reproduce N=6,040 — it is a historical figure that cannot be recovered against the current live universe.

What we do claim:

- The **structural question** is the same: "is this an event with exactly one binary market?".
- The **runtime filter is correct** on today's universe — 4,240 events pass STEP 2, 6,584 fall through to the fallback EXCLUDE branch.
- The 4,240 / 10,824 baseline is now documented; future drift is measurable against it.

### D3 — `outcomes` cardinality not usable as a filter input

Because every Polymarket market is binary, `market.outcomes.length` is a constant on the active universe. It cannot distinguish between "simple" and "complex" events. Any implementation that reads `distinct_outcomes` literally as "number of outcome labels on a market" would admit 100% of active markets and is therefore incorrect.

## Consequences

Positive:

- STEP 2 filter is now explicitly documented as a structural, not numerical, equivalence.
- The 4,240 / 10,824 baseline gives operators a reference for detecting structural changes on the Polymarket platform (e.g. a protocol change to non-binary markets would break D3 and require the ADR to be revisited).
- The claim "our filter gives exactly N=6,040" is retired — it was never verifiable on live data.

Negative / neutral:

- Users who read the spec literally and expected N=6,040 should now find this ADR instead.
- Future platform changes (non-binary markets, alternative event shapes) would require reopening this decision.

## See also

- `research_plankton/plankton-analysis/06_algorithm_spec.md §0` — canonical spec.
- `docs/audits/2026-04-19-algo-spec-remediation-plan.md §5` — execution plan + methodological correction.
- `apps/runtime/src/modules/algo-decision/market-selection-cache.ts` — filter site.
- `packages/domain/src/selection-rules.ts` — `evaluatePreEntry` engine (STEP 2 fallback branch).
- `packages/exchange/src/mappers.ts` — `eventMarketCount` source mapping.
