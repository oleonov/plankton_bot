# ADR-005 — REDEEM Per-Runtime-Mode Semantics

**Date:** 2026-04-20
**Status:** Accepted
**Spec source of truth:** `research_plankton/plankton-analysis/06_algorithm_spec.md` §8 (REDEEM action)
**Related plan:** `docs/audits/2026-04-19-algo-spec-remediation-plan.md` §6.4 (H8)
**Related ADR:** `docs/superpowers/specs/2026-04-18-algo-spec-freeze-adr.md` (D-series decisions)

## Context

Spec §8 defines `REDEEM` as an algorithm action on the position lifecycle. It describes *when* to redeem (resolved-or-algo-triggered conditions) but not *how* — the spec is silent on whether redemption is an on-chain call, an internal ledger close, or both. That gap is an infrastructure concern.

The runtime supports three modes (`simulation`, `paper`, `live-lite`) and already resolves the REDEEM call site per mode:

- **simulation** — `SimulationExchangeGateway.redeemPositions()` is a no-op (`packages/exchange/src/simulation/exchange-gateway.ts:191–193`). There is no on-chain state to touch.
- **paper** — the resolution module receives **no gateway** at all (`apps/runtime/src/index.ts:587` gates `gateway:` on `runtimeMode === "live-lite"`), so the on-chain branch is skipped entirely.
- **live-lite** — `LiveExchangeGateway.redeemPositions()` submits a real on-chain call via CTF (`CTF_REDEEM_ABI`) or the NegRiskAdapter (`NEG_RISK_REDEEM_ABI`) depending on the condition type (`packages/exchange/src/live/exchange-gateway.ts:62–70`).

In **all three modes** the internal `PositionSettler.settleAlgoRedeem()` runs afterwards (`apps/runtime/src/modules/resolution/resolution-module.ts:127`): it records a `settlement_ledger` row with `resolution = "algo-redeem"` and `settlementPrice = 0`, zeroes inventory lots, and closes the local position. This is how the bot's books stay accurate regardless of whether any on-chain transaction happened.

The compliance audit (`docs/audits/2026-04-19-algo-spec-compliance.md`, H8) flagged the asymmetric behaviour as spec-divergence. It is not — it is the only correct operational mapping — but the asymmetry was undocumented. This ADR records the decision so future readers don't re-litigate it.

## Decision

The runtime implements REDEEM with **per-mode semantics**:

### D1. Simulation / Paper — internal close only

- `settleAlgoRedeem(conditionIds)` is the whole REDEEM path.
- No gateway call is attempted: simulation returns no-op; paper never receives a gateway reference.
- `settlement_ledger.resolution` is set to the canonical string `"algo-redeem"` so replay/PnL tooling can distinguish algo-triggered redeems from market-resolution settlements (which use the outcome label).
- `settlement_price = 0` (algo REDEEM fires on the spec §8 loss-triangle: S1/S2 + price < 0.05 + hold_duration ≤ 3600), so realized PnL = `(0 − avgEntryPrice) × size`.

### D2. Live-lite — on-chain first, then internal close

- `gateway.redeemPositions([...conditionIds])` is invoked before the internal close (`resolution-module.ts:110`, market-resolution path at `:243`).
- **On-chain failure is logged but does not abort the internal close** (`resolution-module.ts:112–114`). Rationale: if the on-chain call reverts (already redeemed, insufficient balance, etc.), the local ledger must still reflect that the position is terminal — otherwise continuation logic keeps firing on a dead position.
- Any open orders on the tokens involved are cancelled before the ledger close (`resolution-module.ts:120–125`) so a fill cannot land on a token whose leg just terminated.
- Settlement ledger semantics (D1 above) are identical — `"algo-redeem"`, price 0, zeroed lots.

### D3. Paper mode does not attempt a gateway call

The decision to gate `gateway:` on `runtimeMode === "live-lite"` in `apps/runtime/src/index.ts:587` is deliberate: in paper we have a real Polymarket data gateway for price feeds, but *exercising* on-chain redeem would either require a private key we shouldn't ship or produce meaningless no-op behaviour. Neither adds signal. The cleanest mapping is "no gateway → no attempt."

### D4. Idempotency

Both paths are idempotent:

- `settleAlgoRedeem` skips positions already in `status = "closed"` (`position-settler.ts:78`).
- The settlement-ledger insert uses `INSERT OR IGNORE` on the deterministic settlement id `algo-redeem-<conditionId>-<tokenId>` (`position-settler.ts:48–52, 86`).
- On live-lite the on-chain submission is tracked via `hasPendingRedeemSubmission` (`packages/exchange/src/live/exchange-gateway.ts` + usage at `resolution-module.ts:245`) so duplicate broadcasts are suppressed within a TTL.

## Consequences

- **Spec audits** treat the per-mode behaviour as intentional and stop re-flagging the asymmetry. H8 is resolved by documentation, not code change.
- **Operators** get a single contract: after REDEEM fires, the local position is closed and a `settlement_ledger` row with `resolution = "algo-redeem"` exists — regardless of mode. Dashboards, replay, and PnL reports depend only on the ledger, not on chain state.
- **Live-lite failure modes are bounded.** An RPC outage or adapter revert still produces a correct local close and a logged error. The next human-driven reconciliation (or the next successful scheduled retry) can re-submit the on-chain redeem; the ledger is already in the right state.
- **Sim/paper never touch a key or an RPC.** This keeps the mode contract clean: "paper uses live market data; live-lite is the only mode that writes to chains."
- **Strong coupling to `algo-redeem` string.** PnL replay and dashboards filter on `settlement_ledger.resolution = "algo-redeem"`. Any rename is a migration, not a refactor.

## Non-goals

- **Not** a design for partial redeems. Current behaviour settles the entire position leg. Partial redemption (e.g. redeem half, hold half) is not spec'd and not supported.
- **Not** a retry queue for failed on-chain redeems. The current policy is "log and move on"; a future ADR can introduce a retry repo if empirical failure rates justify it.
- **Not** a change to settlement-price semantics. `0` is kept even if spec §8 later adds a post-resolution redeem at non-zero prices — that would be a separate ADR.
- **Not** a simulation extension. Simulation gateway stays a no-op; faking an on-chain redeem in sim would add false signal without simulating real failure modes.
