# ADR-022 — Step 5: Entry trigger

## Status

Accepted — 2026-05-06

## Context

Step 5 of the trading pipeline ("Entry trigger") was audited against
the canonical algorithm spec
`research_plankton/plankton-analysis/06_algorithm_spec.md` v5.11 §9
(Entry context, R22-R24) and §5 (state-machine and decision flow,
D1-D7 row-level coverage). The audit lives at
[`docs/audits/2026-05-06-step5-entry-trigger.md`](../audits/2026-05-06-step5-entry-trigger.md).

Spec §9 is **purely empirical R22/R23/R24 observations** (drop-from-peak
distributions, multi-window z-scores and imbalances, threshold-crossing
reaction times). Spec §8 marks three [OPEN_QUESTION]s that fall under
Step 5:

- **Q5** — whether D1-D7 are causal bot logic or post-hoc row
  descriptors.
- **Q12** — exact drop threshold per entry-price bucket.
- **Q13** — reaction time between drop crossing threshold and first
  BUY placement.

No prior ADR codifies Step 5. Tangential ADRs:

- **ADR-013** — `entryPriceCeiling=0.75` and exit-TTL bump
  (execution-side constraint, not trigger logic).
- **ADR-014** — bounded-midpoint price improvement (execution-side).
- **ADR-016** — continuation gate semantics (`legTradeCount>=6` OR
  `firstTradePrice>=0.05 AND legTradeCount>=2`).
- **ADR-017** — Step 0 §P3 min-age gate (`entryMinMarketAgeSeconds=2_504`).
- **ADR-020** §Context — "MVP does not gate BUYs by score; Step 4
  will own gating" (Step 5 trigger left open).

This ADR closes the Step 5 spec gap by accepting the current de-facto
behaviour as the canonical answer to Q5/Q12/Q13 and explicitly
deferring drop-feature gating, reaction-time logic, and rolling
price-history infrastructure as future work-items. It introduces no
behavioural change. The only runtime delta is **observability**:
`signal_emitted` payload gains two cheap derived fields, and
`AlgoDecisionModule.healthCheck` gains a per-tick trigger-mix segment.

The audit identified six structural divergences (D1-D6) and seven
open questions (Q1-Q7). This ADR maps them to D-A through D-F:

- **D-A** answers audit D1 (no Step 5 ADR) for the first-BUY contract.
- **D-B** answers audit D1 for the continuation contract.
- **D-C** answers audit D1 D-C and D6 (FALLBACK semantics vs Q5).
- **D-D** answers audit D2 (drop-from-peak gap vs R23 evidence) and
  Q2 of audit §5.
- **D-E** answers audit D3 (reaction-time gap vs R24 evidence) and
  Q3 of audit §5.
- **D-F** answers audit D5 (`signal_emitted` telemetry gap) and Q4
  of audit §5.

Audit D4 (`EvalContext` lacks rolling features) and audit Q6 (rolling
price-history buffer location) follow directly from D-D/D-E being
deferred — no rolling buffer is built today.

## Decision

### D-A — First-BUY trigger contract (audit Q1, Q2, mirrors spec Q5/Q12)

The current de-facto first-BUY trigger is hereby canonical. A token
emits a first BUY signal when **all** of the following hold on the
same evaluation tick:

1. `MarketSelectionCache.isEligible(tokenId) === true` — Step 1+2
   admission (`tradable=1 AND volumeLifetime !== 0 AND INCLUDE`)
   per ADR-021 §D-A
   (`apps/runtime/src/modules/algo-decision/market-selection-cache.ts:89-91`).
2. `marketCache.get(tokenId)` returns a `NormalizedMarket` with
   `midPrice !== null`
   (`apps/runtime/src/modules/algo-decision/algo-decision-module.ts:651-698`).
3. `pendingEntries.has(tokenId) === false` — first-BUY in-flight
   dedupe; applies only when `legState === null`
   (`algo-decision-module.ts:683-698`).
4. `isAlive(market) === true` — `acceptingOrders &&
   enableOrderBook && bestBid != null`
   (`packages/domain/src/market-selection.ts:68-74`). Spread is **not**
   part of the liveness gate.
5. `legState === null` (no open scale-in leg).
6. `evaluateMinMarketAge(now − gammaCreatedAt) >= 2_504s` —
   ADR-017 Step 0 §P3 floor; `gammaCreatedAt === null` →
   suppression `market_age_unknown`
   (`algo-decision-module.ts:786-808`).
7. `evaluateRedeem` does not fire (no leg → no redeem path).
8. `evaluateDecision(ctx, rules)` returns a BUY action — for
   `legState === null` and `state === OTHER` this is **always**
   FALLBACK, since D1-D7 do not match `OTHER` (D-C below).
9. RiskInventoryModule BUY admission guard passes —
   `resolution_tracker_unavailable`, `market_resolved`,
   `canPlaceBuyOrderForMarket` reasons all clear
   (`apps/runtime/src/modules/risk-inventory/risk-inventory-module.ts:204-238`
   + `packages/domain/src/market-selection.ts:110-141`).
10. `AlgoRiskGate.evaluate` passes — no open BUY of `pending` /
    `open` / `partially-filled` status, no open `Position` (status
    ≠ `closed`) for `ProbeEntry`, `signal.suggestedSize >=
    minOrderSize`, `hasWalletBuyBudget(walletBudget,
    suggestedSizeUsdc) === true` where `walletBudget` is sourced
    from `orderRepo.sumOpenBuyNotional()`
    (`apps/runtime/src/modules/risk-inventory/algo-risk-gate.ts:40-99`).
11. signal-to-order bridge passes — `executionTerms.price <=
    entryPriceCeiling` (default `0.75`, ADR-013), dead-side guard
    `bestAsk > 0.02 OR timeToEnd > 120s`
    (`apps/runtime/src/modules/strategy/signal-to-order.ts:389-460`).
    Pricing mode = `edge` (`bestBid` for BUY) or `bounded-midpoint`
    (ADR-006/014).
12. ExecutionModule live-lite caps pass — `notional <=
    liveLiteOrderCap`, total post-BUY exposure `<=
    liveLiteOpenValueCap`, active markets `<=
    liveLiteActiveMarketsCap` (ADR-009; only enforced in
    `live-lite` mode).

Step (8) is the substantive trigger decision. All other gates are
either Step 1-4 admission, lifecycle guards, or order-side
constraints. **No drop-from-peak, volume-spike, imbalance, or
reaction-time discriminator is applied**. The trigger is "trivial"
in the sense that any token surviving steps (1)-(7) and
(9)-(12) emits BUY on the next sweep tick or
`NormalizedMarketUpdated`, whichever comes first.

Sweep cadence is `STRATEGY_SCAN_INTERVAL_MS` (default 12_000 ms,
`packages/config/src/env.ts:22`). Immediate evaluation also fires on
`NormalizedMarketUpdated` (`algo-decision-module.ts:354-366`).
Effective entry latency from eligibility → BUY is bounded by
`min(12_000ms, time-to-next-update)` on the decision side, plus
order-bridge and execution gate latency.

This is one valid answer to Q12/Q13: the empty answer (no
discrimination, no waiting). It is consistent with Step 1+2+3 funnel
already enforcing scope (selection rules, `tradable`, volume,
min-age) and with ADR-013 capping execution price; the Step 5 layer
contributes no further filtering.

### D-B — Continuation trigger contract (audit Q1, mirrors spec Q5)

When `legState !== null`, the entry trigger contract is the union of
three branches (`algo-decision-module.ts:810-883`):

1. **Continuation gate fails** —
   `evaluateContinuation(legTradeCount, firstTradePrice) === false`
   (i.e. `legTradeCount < 6 AND (firstTradePrice < 0.05 OR
   legTradeCount < 2)`,
   `packages/domain/src/market-selection.ts:51-55`). The token is
   matched against `SELL_ONLY` rules (continuation gate constrains
   only BUY-side scale-in; SELL leg-exits are not blocked).
2. **Preserved-only branch** — `legState !== null AND
   market.tradable === false`. The market is delisted for new
   entries; only `SELL_ONLY` rules fire. **FALLBACK BUY does not
   fire** in this branch even if the continuation gate would
   otherwise pass.
3. **Continuation gate passes AND `market.tradable === true`** —
   `evaluateDecision(ctx, rules)` iterates D1-D7 in priority order
   and falls through to **FALLBACK** when no D-rule matches. D1
   (S2+`<0.05`+`<=60s`→BUY), D3 (S1+`<0.05`→BUY), and D6
   (S2+`buyCount>=4`→BUY) are the BUY-emitting continuation rules.
   D4 (S2+`>=0.2`+strict `>60s`→SELL, priority 50) preempts D6
   (priority 70) when its strict `time_since_last_operator=">"`
   condition holds (`packages/db/src/bootstrap.ts:243`); at exactly
   60s D4 does not match.

Continuation cadence is throttled by:

- The continuation gate itself (`legTradeCount >= 6` or 2
  successive trades on `firstTradePrice >= 0.05`).
- `AlgoRiskGate` open-BUY check (`orderRepo.findByTokenId.some(side =
  buy AND status ∈ {pending, open, partially-filled})`) — this is the
  predominant continuation duplicate-protection;
  `pendingEntries[tokenId]` only applies on first-BUY (`!legState`).

The upper bound of our cadence is `STRATEGY_SCAN_INTERVAL_MS`
(default 12 s) — substantially tighter than the R22 reference
median 240 s (≈4 min) — but real-world cadence is dominated by the
gate + RiskGate throttles above.

D1-D7 are accepted as **causal hand-coded Plankton rules**, not
post-hoc descriptors. This is one valid answer to Q5; the
alternative (treating D1-D7 as pure observers and rewriting trigger
logic from scratch) is explicitly out of scope for this ADR.

### D-C — FALLBACK as post-continuation-gate non-preserved BUY fallthrough (audit D6, mirrors spec Q5)

`evaluateDecision` (`packages/domain/src/algo-engine.ts:74-81`)
throws when no rule matches. The seeded `FALLBACK` rule
(`bootstrap.ts:247-260`, `state=ANY → BUY`, priority 999)
guarantees a match always exists, fail-closed with respect to
"missing decision". `algo-decision-module.ts:294-296` enforces
FALLBACK presence at startup.

FALLBACK fires in two situations:

1. **First-BUY** — `legState === null AND state === OTHER`. D1-D7
   do not match `OTHER` (D1/D2 require S2/S3, D3/D5 require S1, D4
   requires S2, D6 requires S2 with `buyCount>=4`, D7 requires
   S3). FALLBACK is the only path to BUY.
2. **Legged scale-in** — `legState !== null AND market.tradable
   === true AND continuation gate passed AND no D1-D7 match`. Same
   FALLBACK rule applies.

FALLBACK does **not** fire in the preserved-only branch
(D-B branch 2) — the SELL-only short-circuit returns before
`evaluateDecision`.

Spec §5 row-level coverage table lists `Fallback (28.60%)` and
`Unmatched (13.02%)` as **separate** entries (sum 41.62%). Our
runtime collapses both into a single FALLBACK match because
`evaluateDecision` cannot return "no rule"; the row that would
have been `Unmatched` in the reference instead becomes FALLBACK
in ours. This is a deliberate fail-closed collapse, not a defect.
The `decisionRuleId="FALLBACK"` label therefore means
**"post-continuation-gate non-preserved BUY fallthrough"** —
either because state was `OTHER` on a first-BUY, or because no
D-rule matched on a legged scale-in.

### D-D — No drop-feature gate on first-BUY (audit Q2, mirrors spec Q12)

Current behaviour — **no drop-from-peak / drop-from-window /
drop-from-last-seen gate** on the first-BUY decision — is hereby
accepted as canonical for v1. R23 §9.2 evidence shows the
reference bot enters in a markedly different drop-from-peak
distribution (62.80% on drop>50%, only 2.3% on drop<10%, n=1000)
than ours; our distribution will be driven entirely by the Step 1+2
funnel and timing of `NormalizedMarketUpdated` events, with no
trigger-side discrimination.

Justification:

- **Spec authority.** Q12 is [OPEN_QUESTION] in v5.11; the trivial
  answer is permitted.
- **Architecture cost.** A drop-feature gate requires (i) rolling
  price-history infrastructure (in-memory ring buffer in
  `MarketDataModule` / `CandidateBookCache`, or on-demand query
  against `market_snapshots` 5-min downsample), (ii) `EvalContext`
  schema extension, (iii) `algo_decision_rules` schema extension
  for drop-conditions (e.g. `drop_from_peak_operator/value`).
  Audit §3 D4 details the scope.
- **Empirical priority.** R23 negative control (§9.4) shows
  `z_volume_5min` and `imbalance_5min` are noise (median deltas
  -0.0141 and 0.0000 respectively, BUY n=1000/348 vs Random
  n=1000/101); only `drop_from_30min` carries real signal
  (+0.2477 median separation). Whatever future work happens here
  should be drop-only, not volume / imbalance.
- **Telemetry first.** D-F captures `dropFromLastSeen` and
  `entryPriceBucket` per signal so a future revision can ground
  threshold choice in our own production distribution rather than
  R23 raw report numbers (which themselves vary 30-50% across
  buckets between canonical v5.11 and the underlying
  `entry_trigger_threshold_refinement_report.md`).

If sustained production observation shows that our entry-price /
drop distribution drifts unacceptably from R23/R24, a follow-up ADR
will add a per-bucket drop threshold informed by D-F data. Today's
behaviour is canonical.

### D-E — Immediate reaction on first eligibility cycle (audit Q3, mirrors spec Q13)

Current behaviour — **react immediately** on the first eligibility
cycle (bounded by `min(STRATEGY_SCAN_INTERVAL_MS, time-to-next-update)`)
— is hereby accepted as canonical. R24 §9.6 evidence shows the
reference bot's first BUY happens 3-24 hours after the first
crossing of `drop_from_peak_24h>50%` in 53.60% of cases, and
within 5 min in only 0.90%; our trigger has no drop crossing
concept and would fire in the upper tail of that distribution if
a drop crossing were defined.

Justification:

- **D-D dependency.** Reaction-time logic is moot without a
  trigger to react against. Since D-D defers drop-feature gating,
  reaction-time also defers.
- **Audit caveat.** R24 measures wall-clock time from drop crossing
  to first-BUY, conflating reference-bot intentional delay with
  reference-bot discovery latency. We cannot disentangle them
  without the reference bot's source — Q13 stays open.
- **Q13 status.** Q13 is [OPEN_QUESTION] in v5.11; the immediate
  answer is permitted.

If D-D is reopened by a follow-up ADR, reaction-time logic must be
introduced in the same ADR or as a paired ADR — the two cannot ship
independently without producing systematically "early" entries.

### D-F — Entry-trigger telemetry (audit D5, audit Q4)

Three read-only telemetry additions, surfaced in the
`signal_emitted` risk event payload and `AlgoDecisionModule`
healthcheck. **No behavioural change.**

1. **`signal_emitted.payload.dropFromLastSeen`** — `(price -
   prevMidPrice) / prevMidPrice` where `prevMidPrice` is the
   `midPrice` of the immediately previous `NormalizedMarketUpdated`
   for this token. `null` on the first observation of a token
   (no prior sample) **and** after any null-mid gap (a
   `NormalizedMarketUpdated` whose `midPrice` is null clears the
   slot, so the next non-null observation reports `null` rather
   than a delta against a stale pre-gap price). This is a cheap
   delta; it is not a drop-from-peak proxy but it is the leading
   indicator most easily computable without rolling-window
   infrastructure. Sign convention: negative = price went down,
   positive = price went up.

2. **`signal_emitted.payload.entryPriceBucket`** — categorical
   string in `{"<=0.005", "0.005-0.05", "0.05-0.20", ">0.20"}`
   matching R24 §9.6 buckets. Computed from the signal's `price`
   field. Operator can post-hoc compare our distribution against
   R24 reference-bot modes per bucket.

3. **`AlgoDecisionModule.healthCheck()`** appends a `triggerMix`
   segment built from a per-tick rolling histogram of
   `decisionRuleId` values across the last completed sweep:
   `triggerMix FALLBACK=N D1-BUY=A D3-BUY=B D6-BUY=C …` (the
   rule IDs are emitted verbatim from the matched
   `algo_decision_rules.rule_id`; zero-count keys are omitted, and
   `(null)` is used when a rule has no `rule_id`). Numbers are
   last-tick gauges, matching the pattern of the existing
   `discoveryLatencyMs p50/p90/max` segment from ADR-021 §D-F.
   The histogram is built into a fresh map at the start of each
   sweep tick and promoted into `lastTickRuleMix` at the END of
   the sweep, so a healthcheck immediately after a completed
   sweep reflects that sweep (not the prior one). The map resets
   at module restart.

The optional `gammaVolume24hBucket` (R23 cross-check) is **not**
included in this revision — it is a Step 1 attribute already
available via `markets` table, not an entry-trigger discriminator,
and would expand the ADR scope.

These fields are emitted regardless of whether the signal is
ultimately approved or rejected by RiskInventory / signal-to-order
/ ExecutionModule, since the telemetry's purpose is to characterise
**decision-side** trigger behaviour. The downstream gates have
their own audit trails.

## Consequences

### Positive

- **Q5 / Q12 / Q13 are now answered** in writing. Future Step 5
  audits can reference this ADR rather than re-deriving the
  contract from runtime code.
- **D-A first-BUY contract** makes the 12-step gate sequence
  explicit, so any of the post-decision gates (RiskInventory,
  signal-to-order, ExecutionModule) can be modified without
  ambiguity about which layer owns which rejection reason.
- **D-B continuation contract** disambiguates the three branches
  (gate-stop, preserved-only, gate-pass) and codifies that
  FALLBACK fires for legged scale-ins as well as first-BUYs.
- **D-C FALLBACK semantics** answers the spec §5
  Fallback-vs-Unmatched ambiguity by codifying the fail-closed
  collapse and giving the `decisionRuleId="FALLBACK"` label a
  precise meaning.
- **D-D / D-E** explicitly defer drop-feature gating and
  reaction-time logic so future revisions have a clear scope, with
  empirical priority (drop only, not volume / imbalance) anchored
  in R23 negative-control data.
- **D-F telemetry** lets operators measure our entry-price /
  drop distribution in production and compare against R23/R24
  reference distributions, grounding any future Q12/Q13 revision
  in observed signal rather than raw-report estimates.

### Negative / accepted trade-offs

- **Trivial first-BUY trigger ⇄ R23 distribution drift.** Our
  first-BUYs will not concentrate on drop>50% the way the
  reference does. Practical impact depends on how narrow Step 1+2+3
  filtering is in production — if eligible-set is large-drop
  dominated, trivial trigger approximates R23; if it is balanced,
  we will over-enter on low-drop markets relative to reference.
  D-F telemetry surfaces this; D-D defers any fix.
- **Immediate reaction ⇄ R24 reaction-time distribution.** Bounded
  by `min(STRATEGY_SCAN_INTERVAL_MS, time-to-next-update)` on the
  decision side; reference median is 3-24 h post-crossing. Without
  a drop-crossing concept the comparison is moot — but if D-D is
  reopened, D-E must be reopened jointly (D-E §Justification).
- **No rolling price-history infrastructure.** `EvalContext`
  cannot answer drop-from-peak / drop-from-window questions.
  Audit D4 is accepted; building the buffer is deferred.
  `dropFromLastSeen` (D-F) is the cheap proxy until then —
  observable but coarse (no peak, no window, just delta-from-prev).
- **`prevMidPrice` requires per-token state in
  `AlgoDecisionModule`.** D-F adds a `Map<TokenId, number>` for
  the prior `midPrice`, sized at most by the eligible-set + active
  legs (bounded by Step 4 watch-set capacity). Memory cost is
  ~24 bytes per entry; bounded by `MARKET_DATA_MAX_TRACKED_TOKENS`
  (default 1,000, hard cap 5,000) so worst-case 120 KB. Acceptable.
- **`triggerMix` histogram resets per sweep.** Operators see only
  the last tick, not cumulative counts. This is intentional (matches
  ADR-021 §D-F gauge style) but means short-lived burstiness can be
  missed unless healthcheck is sampled at sweep cadence. If a
  cumulative counter is needed later, a follow-up ADR will add it.
- **D1-D7 accepted as causal.** If post-hoc evidence reveals
  D1-D7 are descriptors only, the Step 5 contract will need full
  rework and this ADR will be superseded. Q5 stays acknowledged as
  open.

## Rollback plan

ADR-022 introduces no schema changes and no behavioural changes — it
codifies de-facto behaviour and adds telemetry. To roll back:

1. Revert the D-F telemetry commits (the `dropFromLastSeen` and
   `entryPriceBucket` fields on the `signal_emitted` payload, the
   `prevMidPrice` map in `AlgoDecisionModule`, and the `triggerMix`
   healthcheck segment).
2. Optional: leave the ADR document in place for historical record.

There is no DB migration to revert; `signal_emitted` payload is a
JSON column and added fields are forward-compatible.

## References

- Spec §9 + §8 Q5/Q12/Q13 — `06_algorithm_spec.md` v5.11.
- Audit:
  [`docs/audits/2026-05-06-step5-entry-trigger.md`](../audits/2026-05-06-step5-entry-trigger.md).
- R22-R24 evidence reports —
  `research_plankton/entry_trigger_investigation_report.md`,
  `research_plankton/entry_trigger_microstructure_report.md`,
  `research_plankton/entry_trigger_threshold_refinement_report.md`.
- ADR-006 — execution price policy (edge / bounded-midpoint).
- ADR-009 — live-lite envelope caps (separate post-decision layer).
- ADR-013 — `entryPriceCeiling=0.75` (order-bridge-side gate).
- ADR-014 — bounded-midpoint price improvement.
- ADR-016 — continuation gate (`legTradeCount` / `firstTradePrice`
  rule).
- ADR-017 — Step 0 §P3 min-age gate (`entryMinMarketAgeSeconds=2_504`).
- ADR-020 — Step 3 soft-ranking score (`MVP does not gate BUYs by
  score`); D-D re-affirms.
- ADR-021 — Step 4 watch-set formation; D-F here mirrors ADR-021
  §D-F telemetry style.
