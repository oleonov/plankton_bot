# ADR-010 — Post-entry continuation uses local `legTradeCount`, not market-level `trade_count`

## Status

Accepted — 2026-04-23

## Context

Clarified spec `06_algorithm_spec.md v2.3` defines `trade_count` as **total trades per market (`condition_id`)** and reuses that term in the post-entry continuation filter:

- `legTradeCount >= 6` → continue, OR
- `firstTradePrice >= 0.05 AND legTradeCount >= 2` → continue.

Runtime today computes continuation from a **different** quantity:

- `apps/runtime/src/modules/algo-decision/algo-decision-module.ts:402` — `legTradeCount = legState.buyCount + legState.sellCount` (per-leg fill counters on our own book).
- `packages/domain/src/market-selection.ts:45` — `evaluateContinuation(legTradeCount, firstTradePrice)` applies the spec thresholds to that local quantity.

Empirical probe of every public Polymarket surface (`docs/audits/2026-04-23-gamma-trade-count-probe.md`, 2026-04-23) established:

1. Gamma `/markets`, `/events`, CLOB `/markets`, CLOB `/trades`, data-api `/trades`, and the official docs (`docs.polymarket.com/llms.txt`) expose **no** `trade_count` / `tradeCount` / `numTrades` field, and no aggregate-stats endpoint, and no `X-Total-Count` / pagination-total mechanism. Only USDC-notional `volume*` and `liquidity*` aggregates are available.
2. `data-api /trades?market=<conditionId>` returns recent trade rows with a hard cap of `offset ≤ 3000`. It could be polled and counted per `conditionId` at continuation-decision time, but it is not a first-class field anywhere.
3. Observability cost of the polled variant was measured directly against prod (`ssh root@old.server.ip`): cached `TTFB ≈ 75 ms` (Cloudflare `cf-cache-status: HIT`, `cache-control: max-age=300`), cold `TTFB ≈ 275–380 ms`. The 5-min CDN TTL aligns with the existing 5-min `scanIntervalMs`.

Two branches were considered:

- **2a** — poll `data-api /trades` per `conditionId` at every continuation decision and count rows as a market-level `trade_count` approximation. Closest to the canonical semantic.
- **2b** — keep `legTradeCount` as the continuation driver and formally document the divergence. Status quo in runtime.

## Decision

### D1 — Continuation stays on `legTradeCount = buyCount + sellCount`

Runtime does not introduce a new runtime dependency on `data-api` for continuation. `evaluateContinuation` continues to receive `legState.buyCount + legState.sellCount` as its `legTradeCount` argument (`algo-decision-module.ts:402`, `market-selection.ts:45`).

Rationale for preferring 2b over 2a:

- **No first-class field exists.** 2a is a polled approximation of an absent primitive, not a retrieval of a documented one. The approximation would have to be maintained against Polymarket's undocumented pagination semantics.
- **New runtime failure mode.** 2a couples continuation — a decision on the hot path — to data-api availability, rate limits, and the 3 000-row offset cap. Every added dependency requires its own fallback (which is `legTradeCount` anyway), cache, timeout, and retry budget.
- **Cost/benefit.** The 2/6 threshold set makes the offset cap irrelevant in practice. 2a would change the answer in the "market active, our leg idle" regime — and this **is** a pending decision surface, because `evaluateContinuation` is called exactly when `legState !== null` (`algo-decision-module.ts:398` + `market-selection.ts:45`). In that regime 2b (local count) says "stop" while 2a (market count) would say "continue". We accept the resulting asymmetry consciously — as the price for not adding a hot-path runtime dependency — rather than because the case does not arise. The reverse asymmetry ("our leg busy, market quiet") already clears continuation under 2b, which is the conservative direction for an active position.
- **Local semantic is bounded and well-defined.** `legTradeCount` is strictly less information than canonical `trade_count`. It is not a substitute; it is a different signal (our own fill activity on the leg we hold) that we choose to gate continuation on, because the infrastructure to measure it is already in place and cannot fail independently of the runtime itself.

### D2 — Divergence is explicit, not silent

- The compliance matrix and `2026-04-23-algo-followups-and-prod-observations.md` section A1 classify this as **divergent-documented** rather than **implemented**.
- This ADR is the single canonical statement of that divergence; other docs link here.
- `06_algorithm_spec.md` is **not** edited (per `CLAUDE.md` rule — the spec is read-only and mirrors the research source).

## Consequences

Positive:

- Continuation remains a deterministic, zero-network-cost function of state the runtime already owns (`legState`), on the same scan tick.
- No coupling of post-entry gating to an undocumented third-party aggregate-count approximation.
- The decision is reversible: if Polymarket ever ships a first-class per-market trade-count field, the domain function `evaluateContinuation` can be re-pointed at it without changing its arithmetic (see the "Reversal conditions" section).

Negative / neutral:

- **Strictly less information than canonical.** A highly active market where our book has no activity still stops our continuation. A quiet market where our own leg has the requisite fill count still continues. We accept both asymmetries.
- The spec term `trade_count` and the runtime name `legTradeCount` collide by pun, not by meaning. This is tolerated here because the divergence is now explicitly documented; readers should not assume the names are semantically identical.

## Reversal conditions

This ADR should be revisited if any of the following change:

- Polymarket publishes a first-class per-market `trade_count` field on Gamma `/markets`, CLOB `/markets`, or a dedicated aggregate-stats endpoint.
- Operational data shows continuation misfiring in a way attributable to the local-vs-market gap (rather than to orthogonal execution-quality issues).
- Product explicitly prioritises market-level continuation semantics over runtime independence from data-api.

## See also

- `research_plankton/plankton-analysis/06_algorithm_spec.md` — canonical spec (read-only).
- `packages/domain/src/market-selection.ts:45` — `evaluateContinuation(legTradeCount, firstTradePrice)`.
- `apps/runtime/src/modules/algo-decision/algo-decision-module.ts:402` — runtime call site passing `legState.buyCount + legState.sellCount`.
- `docs/audits/2026-04-23-gamma-trade-count-probe.md` — empirical probe establishing that no first-class field exists.
- `docs/audits/2026-04-23-algo-followups-and-prod-observations.md §A1` — audit finding this ADR resolves.
- `docs/audits/2026-04-23-algo-followups-remediation-plan.md §Phase 3.C` — remediation plan step.
- `docs/adr/007-historical-filter-volume-proxy.md` — sibling waiver for the historical-universe `trade_count` usage (A2).
