# ADR-017 — Step 0: Discovery channel + min-age gate

## Status

Accepted — 2026-05-05

## Context

Step 0 of the pipeline ("Bot starts → discovery channel") was audited against
the canonical algorithm spec (`research_plankton/plankton-analysis/06_algorithm_spec.md`)
and three gaps were identified — see
[`docs/audits/2026-05-05-step0-discovery-channel-remediation-plan.md`](../audits/2026-05-05-step0-discovery-channel-remediation-plan.md).
This ADR records the design decisions for the resulting remediation.

The audit found:

1. The runtime captured `Market.createdAt` (the row's first-write timestamp in
   our DB) but never persisted Gamma's `createdAt` (the Polymarket creation
   instant). Spec §1.7 R14 (`age_at_entry`) requires the latter.
2. The discovery channel was a 5-minute REST poll. The spec leaves the channel
   open (`06:807` flags it as an OPEN_QUESTION) but warns that anything slower
   than ~minute-scale erodes the entry-trigger edge.
3. There was no enforcement of spec §1.7 R1 (`06:423`) — the
   2 504 s floor between `market_creation` and the first BUY.

Three discovery-channel options were considered:

- **Option A — keep REST 5-min poll, accept the edge cost.** Zero implementation
  cost. Rejected pending evidence: the actual scanner overhead is unknown
  without telemetry.
- **Option B — drive discovery from the Polymarket CLOB market stream
  `new_market` lifecycle event.** Lower latency in theory but the spec marks
  it OPEN_QUESTION (`06:807`); empirical validation requires a 24–72 h prod
  listener (P5 in the plan), which is not feasible from local dev (CLAUDE.md:
  Polymarket endpoints blocked).
- **Option C — keep REST poll, instrument it, defer WSS until evidence
  justifies it.** Chosen.

## Decision

### D1 — Persist `gamma createdAt` end-to-end (P1)

Plumb Gamma's `createdAt` from the discovery gateway through to
`Market.gammaCreatedAt` and `NormalizedMarket.gammaCreatedAt`. Both fields are
typed as `string | null` (required at the type level — every fixture must
explicitly choose `null` or an ISO string). Persistence uses
`COALESCE(markets.gamma_created_at, excluded.gamma_created_at)` so a subsequent
upsert that lacks the field never overwrites a captured value.

The Gamma-side parser (`parseGammaCreatedAt` in `packages/exchange/src/mappers.ts`)
is strict: only ISO-8601 timestamps round-trip; numbers, empty/whitespace
strings, unparseable text, and `null` all map to `null`.

### D2 — Discovery-latency telemetry (P2)

Every scan cycle records `Date.now() - Date.parse(gammaCreatedAt)` for each
**first-sighted** token (i.e. token IDs absent from
`MarketRepository.iterateAllTokenIds()` at the start of the cycle). Aggregates
are reported as p50 / p90 / max in the `scan cycle complete` log line, exposed
via `MarketScannerModule.getDiscoveryLatencySnapshot()`, and surfaced through
`healthCheck()` so operators see the live overhead without grepping logs.

`iterateAllTokenIds` (a cursor-based addition to `MarketRepository`) lets the
scanner snapshot the entire known-token set without materializing a Market
slice. We use _all_ token IDs (active + inactive) so re-discovery of a
previously deactivated token doesn't false-positive as a new sighting.

This validates whether the empirical 5-minute REST cadence is acceptable
without yet committing to the WSS migration.

### D3 — Min-age gate before first BUY (P3)

`evaluateMinMarketAge` (in `@krabs/domain`) is a pure helper that gates the
**legState == null** branch only. SELL / REDEEM / continuation are explicitly
unaffected — the spec floor applies to _first_ BUYs.

The threshold is `ExecutionPolicy.entryMinMarketAgeSeconds`, sourced from
`profile_settings.execution_policy_json` per ADR-015 (DB-backed,
hot-reloadable). Per-profile defaults seeded by `control-profiles.ts`:

| Profile    | Default | Rationale                                                                                       |
| ---------- | ------- | ----------------------------------------------------------------------------------------------- |
| simulation | `0`     | Sim fixtures are freshly created — the spec floor doesn't apply. Also an emergency kill-switch. |
| paper      | `2 504` | Canonical spec floor — paper mirrors live-lite for behavioral parity.                           |
| live-lite  | `2 504` | Canonical spec floor.                                                                           |

`threshold = 0` is an explicit full-bypass: `evaluateMinMarketAge` checks the
threshold _before_ parsing `gammaCreatedAt`, so disabling the gate does not
fail-closed on null/legacy rows.

When the gate triggers, `recordDecisionSuppressed` writes a `signal_suppressed`
risk event with one of two `reasonCode`s:

- `market_too_young` — `age < threshold`.
- `market_age_unknown` — `gammaCreatedAt` is null or unparseable while the gate
  is enabled.

Both reasons are added to `DEDUPED_SUPPRESSION_REASONS` because they are sticky
on the legState==null path — `market_too_young` repeats every sweep tick for
up to 2 504 s after first sighting, and `market_age_unknown` repeats indefinitely
for legacy rows. Without dedupe a handful of new-but-young tokens would flood
`risk_events` ~1/sec.

The `entryMinMarketAgeSeconds` field is exposed to the operator via the
existing `ExecutionPolicy` REST surface and the `/execution-settings` UI page.

### D4 — REST poll stays as the discovery channel (plan §P5 deferred)

Plan §P5 ("WS `new_market` semantic clarification") is gated on §P0.3 — a
24–72 h prod-side listener that observes whether the CLOB `new_market`
lifecycle event ever fires for an unsubscribed token. CLAUDE.md mandates
that Polymarket endpoints are unreachable from local dev, and the listener
needs uninterrupted runtime — so this is deferred to a follow-up audit run on
the production server. Until then, REST is the canonical channel and the
spec's WSS OPEN_QUESTION (`06:807`) remains open.

The `NewMarketDiscoveredHint` event name is kept deliberately unchanged: the
existing scheduling code (`scheduleHintScan`) already accommodates a future
WSS-driven hint without requiring a rename. Plan §P5 will rename it to a
lifecycle-only semantic if §P0.3 returns negative.

### D5 — Warm-up gate (plan §P4) stays optional and deferred

Plan §P4 ("Warm-up signal: first third-party trade") is gated on a §P4.0
inventory check: do our pricing streams already surface `match` /
`trade_event` payloads we could persist as `Market.firstThirdPartyTradeAt`?
The check itself requires the prod pricing-stream connection. Until that
inventory is run on the production server, P4.1 (the actual gate) is not
implemented. ADR-017 only commits to P1+P2+P3+P6; the warm-up gate is a
separate decision once §P4.0 returns.

## Consequences

- The min-age gate is now the canonical enforcement point for spec §1.7 R1.
  Removing it (e.g. by accidentally setting `threshold = 0` in paper or
  live-lite) is observable via the existing `summarizePolicy` log on every
  hot-reload.
- The `gammaCreatedAt` field's transition from optional to required at the
  type level forced every test fixture and event-bus payload to acknowledge
  the field. This is intentional — silent omission was the root cause of
  the original gap.
- Discovery cadence remains a 5-minute REST poll. The empirical question
  ("is REST fast enough for the entry-trigger edge?") is now answerable from
  the new healthcheck metric without code changes.

## See also

- Spec sections: §1.7 R1 (`06:423`), §1.7 R14 (`age_at_entry`), §1.7 (`06:807` —
  WSS OPEN_QUESTION).
- ADR-015 (DB-backed execution policy — hot-reload mechanism reused for §P3).
- [`docs/audits/2026-05-05-step0-discovery-channel-remediation-plan.md`](../audits/2026-05-05-step0-discovery-channel-remediation-plan.md).
