# ADR-002 — Inventory Auto-Merge as an Operational Extension

**Date:** 2026-04-20
**Status:** Accepted
**Spec source of truth:** `research_plankton/plankton-analysis/06_algorithm_spec.md`
**Related plan:** `docs/audits/2026-04-19-algo-spec-remediation-plan.md` §3.3 (C5)
**Related ADR:** `docs/superpowers/specs/2026-04-18-algo-spec-freeze-adr.md` (D-series decisions)

## Context

Spec §0–§8 describe the Plankton algorithm as entry/exit/continuation rules operating on individual outcome tokens. They do not describe or require any mechanism that merges complementary YES+NO holdings into USDC via the Polymarket neg-risk NegRiskAdapter. The `InventoryManagerModule` (`apps/runtime/src/modules/inventory/inventory-manager-module.ts`) implements exactly such a merge: when YES and NO balances overlap on a neg-risk condition, it redeems the minimum overlap as USDC (1 YES + 1 NO = 1 USDC under Polymarket's conditional-token math).

This behaviour is **Polymarket-specific** and **spec-neutral**:

- It does not create new exposure (entry/scale) nor close a directional leg (exit). It converts fully-offsetting token inventory into fungible USDC.
- It is an operational optimisation that releases stuck collateral; the algorithm's P&L is unchanged by it.
- Spec audits (see `docs/audits/2026-04-19-algo-spec-compliance.md`) flagged the module as "not in spec §0". The adjacent module (`stale-pruning`) was removed entirely; auto-merge is preserved because it encodes a real exchange mechanic, not an invented threshold.

A blanket removal was rejected for two reasons:

1. The mechanic is correct Polymarket semantics, not invented heuristic.
2. Operators running live-lite need a way to reclaim USDC trapped as paired YES+NO without manual on-chain calls.

## Decision

Retain `InventoryManagerModule`, but gate it behind an opt-in environment flag.

### D1. Gating

- New env var `ENABLE_INVENTORY_AUTO_MERGE` (zod enum `"true" | "false"`, **default `"false"`**).
- Exposed as `AppConfig.enableInventoryAutoMerge: boolean`.
- `apps/runtime/src/index.ts` instantiates and registers the module **only** when the flag is true. When false, the module is never constructed, never wired, never polled.
- No runtime-toggle path (no operator command, no `runtime_control_state` row). The flag is read at supervisor boot.

### D2. Scope

- The module remains pure Polymarket-mechanics: it inspects `position_repo` inventory, identifies neg-risk condition pairs, and issues exchange-level merge calls. It does **not** produce algorithm signals, does **not** publish `PlaceOrderRequested`, and does **not** interact with leg-state or continuation filters.
- It is **not** part of the spec-compliance surface. Any future spec audit continues to treat it as out-of-scope.

### D3. Documentation

- Listed in `CLAUDE.md` runtime module pipeline **only when relevant**; until enabled by default, the pipeline diagram does not need a line for it.
- The module file keeps a one-line header comment pointing at this ADR so a future reader can see why it exists and why it is gated.

## Consequences

- **Default runtime graph** is closer to the spec: `MarketScanner → MarketData → Normalization → Strategy → RiskInventory → Execution` + `Reconciliation` + `Resolution`. No extra nodes unless explicitly enabled.
- **Operators who want auto-merge** set `ENABLE_INVENTORY_AUTO_MERGE=true` in their `.env.live-lite` (or equivalent) and pay for the extra reconciliation cycle + on-chain calls.
- **No persisted state change.** The flag only decides whether the module is constructed; there is no migration, no DB column, no operator-command pathway.
- **Removal path is clear.** If a future ADR decides to drop the feature entirely, the gated module + its flag + this ADR are the only artefacts to remove.
- `stale-pruning` (removed in the same commit) and `inventory-auto-merge` (gated here) are treated asymmetrically on purpose: the former encoded an invented threshold (69h + `avgEntryPrice < 0.15`) with no spec grounding; the latter encodes a real exchange primitive with no algorithmic side-effect.

## Non-goals

- **Not** a re-introduction of family-level auto-management. No family taxonomy, no allowlist.
- **Not** a portfolio-rebalancing layer. The module only merges already-paired YES+NO; it does not rotate capital, hedge, or reshape positions.
- **Not** a kill-switch or risk control. Live-lite envelope caps (D4 in `2026-04-18-algo-spec-freeze-adr.md`) remain the sole exposure guard.
