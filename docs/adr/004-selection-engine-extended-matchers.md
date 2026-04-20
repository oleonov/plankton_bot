# ADR-004 — Selection Engine Extended Matchers as an Operator Tool

**Date:** 2026-04-20
**Status:** Accepted
**Spec source of truth:** `research_plankton/plankton-analysis/06_algorithm_spec.md` §0 (Market Selection Layer)
**Related plan:** `docs/audits/2026-04-19-algo-spec-remediation-plan.md` §6.3 (H5)
**Related ADR:** `docs/superpowers/specs/2026-04-18-algo-spec-freeze-adr.md` (D-series decisions)

## Context

Spec §0 describes the Live Pre-Entry Filter as two ordered steps over `event_slug`:

- **STEP 1:** `event_slug prefix in (elon-musk-, bitcoin-, ethereum-)` → INCLUDE (N = 700).
- **STEP 2:** `distinct_outcomes = 1` → INCLUDE (N = 6,040).
- **FINAL:** EXCLUDE.

The spec mentions only a **prefix match** against `event_slug` and hard-codes three seed prefixes. It does not discuss exact slug matches, exclusion rules, precedence between overlapping rules, or any operator mechanism for tuning the universe at runtime.

Our `SelectionRuleEngine` (`packages/domain/src/selection-rule-engine.ts`) is strictly wider:

1. **Four rule types** — `include_prefix`, `exclude_prefix`, `include_slug`, `exclude_slug` — instead of the spec's single `include_prefix`.
2. **Two-tier evaluation** — exact `*_slug` hits on the market slug win over any `*_prefix` hit on the event slug.
3. **Specificity-wins within prefix tier** — longest matching prefix wins; within a tie, `exclude_prefix` beats `include_prefix`.
4. **Runtime-mutable store** — rules live in `control.db` (`selection_rules` table, migration 037) and are CRUD'd via `POST/PATCH/DELETE /selection-rules`; the runtime hot-reloads via `runtime_control_state.selection_rules_version` polling.
5. **STEP 2 fallback** — single-market events (`eventMarketCount === 1`) are still admitted when no rule hits, preserving the spec's §0 STEP 2 condition.

The three spec prefixes (`bitcoin-`, `ethereum-`, `elon-musk-`) are seeded by migration 037 so a fresh DB matches spec §0 out of the box; everything beyond that is operator-authored.

The compliance audit (`docs/audits/2026-04-19-algo-spec-compliance.md`, H5) flagged the extension as wider-than-spec and asked for a decision: shrink the engine to spec, or freeze the extension with a rationale. This ADR takes the second path.

## Decision

Retain the current engine shape. Treat the four-way matcher + precedence rules as an **operator tool**, not a spec change.

### D1. Surface is frozen at four rule types

No new rule types (regex, negated pattern, tag, volume filter, etc.). If a future need emerges, it lands through a new ADR, not by extending the enum in place.

### D2. Precedence is the contract

Resolution order — exact slug > longest prefix > `exclude` > `include` within a tier — is part of the public contract of the engine. Tests in `packages/domain/src/selection-rule-engine.test.ts` pin each branch. Changing precedence requires a new ADR.

### D3. STEP 2 fallback stays

When no rule matches and the event has exactly one market (`eventMarketCount === 1`), admission proceeds via the spec §0 STEP 2 condition. This fallback is the reason the engine is safe to run with an empty rule set: the spec still applies.

### D4. Operator documentation must flag the extension

API responses and the web UI at `/selection-rules` carry a short warning that operator-authored rules go beyond spec §0 STEP 1 and must be reviewed before live-lite deploys. The docs/runbook for selection rules (`docs/runbooks/selection_rules_operations.md`) points at this ADR as the rationale.

### D5. Seeded prefixes are the spec baseline

Migration 037 seeds exactly the three spec prefixes (`bitcoin-`, `ethereum-`, `elon-musk-`). They are the default and removing them from the seed requires a new ADR. Operators may disable or delete them at runtime; that is an operator choice, not a spec change.

## Consequences

- **Spec audits** treat `include_slug`, `exclude_slug`, `exclude_prefix`, and precedence as out-of-scope for §0 compliance and reference this ADR instead of flagging them.
- **No migration work** required — the four-type enum, the `selection_rules` table, and the hot-reload path are already in production.
- **Operator error surface is larger** than the spec implies: a bad `exclude_prefix` can shrink the universe to zero. The runbook + UI warning is the mitigation; there is no automatic "spec-safe mode."
- **Removing the extension** (should a future ADR reverse this decision) means: drop the three non-spec rule types from `SelectionRule` / the DB schema, retire the precedence code, and re-audit existing operator rules for migration. That work is scoped by this ADR, not left implicit.
- **Tests already pin the behaviour** (`selection-rule-engine.test.ts`, `market-selection.test.ts`) — they are the regression guard for the contract described in D2.

## Non-goals

- **Not** a rewrite of the pre-entry filter semantics. Spec §0 STEP 1 + STEP 2 remain the algorithmic rule; extended matchers only change _which_ set of prefixes/slugs is considered "STEP 1".
- **Not** a new rule type. D1 explicitly forbids growing the enum in place.
- **Not** a market-data filter. The engine runs after the scanner normalises an event; pre-scanner filtering (e.g. `tagId`, `volume24h`) is separate and covered by other ADRs.
- **Not** a risk control. Rules cannot encode size, price, or wallet constraints — those live in the risk gate, not the selection engine.
