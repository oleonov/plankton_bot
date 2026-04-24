# ADR-015 — DB-backed execution policy (hot-reloadable)

## Status

Accepted — 2026-04-24

## Context

Execution-time knobs accumulated across ADRs live in three different places:

- **ADR-013** — `ENTRY_PRICE_CEILING = 0.75` and `EXIT_ORDER_TTL_MS = 300_000` lived as `export const` in `apps/runtime/src/modules/strategy/signal-to-order.ts` and `apps/runtime/src/modules/reconciliation/stale-order-cleaner.ts`. Changing either required a code push.
- **Audit 2026-04-24** — dead-side-near-end guard shipped as three env vars: `DEAD_SIDE_GUARD_MODE`, `DEAD_SIDE_GUARD_ASK_CEILING`, `DEAD_SIDE_GUARD_MAX_TIME_TO_END_MS`. Flipping `observe → enforce` in live-lite required a deploy (env baked into the Docker image at build time).
- **ADR-014** — bounded-midpoint pricing shipped as six env vars: `EXECUTION_PRICING_MODE`, `EXECUTION_MAX_ENTRY_SPREAD_TICKS`, `EXECUTION_MAX_EXIT_SPREAD_TICKS`, `EXECUTION_MAX_IMPROVEMENT_TICKS`, `EXECUTION_WIDE_SPREAD_POLICY`, `EXECUTION_ONE_SIDED_POLICY`. Same restart-to-change cost.

Operationally this meant every canary threshold flip (ADR-014 pricing mode, ADR-audit guard mode) required a full redeploy. On a bot that the operator wants to steer in response to fresh evidence from the live canary, that friction is the wrong default. Selection rules (ADR-011 lineage) already solved the same pattern via `control.db` with version-polled hot reload (`runtime_control_state.selection_rules_version`) — the playbook is proven.

Three options were considered:

- **Option A — keep env vars, just document the deploy cadence.** Zero implementation cost, but leaves the operator locked out of tuning what are explicitly evidence-driven canary knobs. Rejected.
- **Option B — reuse the `runtime_control` operator-command table.** Each knob change would be a command. Fits the existing pattern for pause/resume but is heavy for what are structurally configuration edits, not events. Rejected for noise.
- **Option C — profile-scoped JSON config with version-polled reload.** Mirrors selection rules. Single row, single JSON column, one integer version bump per edit. Chosen.

## Decision

### D1 — Store the execution policy in `profile_settings`

`packages/db/src/migrations-control/038_execution_policy.sql` adds:

- `profile_settings.execution_policy_json TEXT` — full policy payload (see §Schema).
- `runtime_control_state.execution_policy_version INTEGER NOT NULL DEFAULT 0` — monotonic version, bumped on every write that changes the JSON.

The migration seeds:

- `live-lite` → `deadSideGuard.mode = "enforce"` (per the audit canary conclusion after the shadow window) and `pricing.mode = "edge"` (flip deferred to post-rollout canary).
- `paper` + `simulation` → `deadSideGuard.mode = "observe"` and `pricing.mode = "edge"` (no live money at risk, canary telemetry only).

All seeded payloads bump `execution_policy_version` to `1` so the first runtime read resolves to the seeded value, not the default.

### D2 — Parser with explicit defaults and bounds

`apps/runtime/src/execution-policy.ts` defines:

- `DEFAULT_EXECUTION_POLICY` — the ADR-013/ADR-014 baseline (`entryPriceCeiling: 0.75`, `exitOrderTtlMs: 300_000`, `pricing.mode: "edge"`, `deadSideGuard.mode: "observe"`).
- `parseExecutionPolicyJson(jsonString): { policy, issues[] }` — hand-rolled validator. Bounds match the old Zod env schema (`askCeiling ≤ 0.2`, `spreadTicks ∈ [1, 2000]`, etc.) so an operator SQL edit cannot wedge the runtime.
- `parseExecutionPolicyOrDefault(jsonString, log, context)` — convenience wrapper used by one-shot scripts.

**Invalid input is never fatal.** The parser merges defaults in on any per-field failure and returns an `issues[]` array for structured logging. The provider (see D3) logs the issues once and keeps the last-good snapshot — live-lite must not crash on a bad write.

### D3 — Version-polled provider with atomic swap

`apps/runtime/src/execution-policy-provider.ts` exposes:

- `snapshot()` — returns the current `ExecutionPolicy`. O(1) pointer read.
- `refreshIfStale()` — reads `runtime_control_state.execution_policy_version`; if it advanced, reparses the JSON and swaps the in-memory snapshot. Pattern matches `RefreshableSelectionRuleEngine`.
- `version()` — last observed version, for health checks and telemetry.

Call sites:

- `SignalToOrderBridge` snapshots the policy once at the top of `handleApproved` so the full decision (dead-side guard → execution terms → entry-price ceiling → pricing shadow → log) uses a consistent view even if the provider hot-swaps mid-signal.
- `ReconciliationModule.runReconciliation` calls `refreshIfStale()` then reads `snapshot().exitOrderTtlMs` per reconciliation tick, threading it into `cleanStaleEntryOrders`.

No other module reads the policy directly; if a new consumer needs it, thread the provider in — do not re-implement the lookup.

### D4 — Profile-settings repository bumps version atomically

`packages/db/src/repositories/profile-settings-repository.ts` wraps `save()` in a transaction that:

1. Reads the prior `execution_policy_json` value for the profile.
2. Writes the full settings row (including the new JSON).
3. Increments `runtime_control_state.execution_policy_version` **only when the JSON bytes changed** (no-op writes do not trigger reloads).

The repo tolerates the pre-migration schema (no `execution_policy_json` column, no `execution_policy_version` column) via `try / catch` on the column-specific statements — this keeps test databases and historical migrations working without a hard dependency on migration 038.

### D5 — API + web CRUD

- `GET /api/v1/profiles/:id/execution-policy` → current policy + version.
- `PATCH /api/v1/profiles/:id/execution-policy` → validate via `parseExecutionPolicyJson` (surface issues on 400), persist via the repo, return the new snapshot + version.
- Web page `/execution-settings` edits the policy as a structured form (not raw JSON). Version is shown in the header so an operator can see the last write took effect. Layout dropdown links to the page.

Bearer-auth is required for PATCH; GET is readable by any authenticated session.

### D6 — Remove the 9 env knobs

`.env.example`, `.env.production.example`, `packages/config/src/env.ts`, and `apps/api/src/__tests__/test-helpers.ts` no longer carry the policy fields. A stub comment in each `.env*` file points to the new DB location. The Zod schema shrinks by 9 fields; `AppConfig` shrinks by 9 fields. Nothing re-reads the env for these values at runtime — a typo on an old `DEAD_SIDE_GUARD_MODE=` line will no longer have any effect.

## Schema

```jsonc
// profile_settings.execution_policy_json
{
  "version": 1,
  "entryPriceCeiling": 0.75,          // ADR-013 D1, BUY skip above this price
  "exitOrderTtlMs": 300000,           // ADR-013 D2, stale exit SELL cancel threshold
  "deadSideGuard": {                  // audit 2026-04-24
    "mode": "observe",                // off | observe | enforce
    "askCeiling": 0.02,               // BUY skipped if bestAsk ≤ this AND mode=enforce AND near-end
    "maxTimeToEndMs": 120000          // near-end window used for enforce-mode rejections
  },
  "pricing": {                        // ADR-014
    "mode": "edge",                   // edge | bounded-midpoint
    "maxEntrySpreadTicks": 20,
    "maxExitSpreadTicks": 40,
    "maxImprovementTicks": 10,
    "wideSpreadPolicy": "edge",       // edge | skip
    "oneSidedPolicy": "edge"          // edge | skip
  },
  "telemetry": {
    "deadSideCanary": true,           // emit shadow markers on every BUY with bestAsk ≤ askCeiling
    "pricingShadow": true             // compute bounded-midpoint price in edge mode for canary logs
  }
}
```

## Consequences

### Benefits

- **No-restart tuning.** Flipping `deadSideGuard.mode` from `observe` → `enforce` in live-lite is a single PATCH + automatic hot-swap on the next bridge tick. Same for pricing mode.
- **Profile isolation.** Paper and live-lite carry independent policies. A paper-only bounded-midpoint canary does not risk live money.
- **Single source of truth.** The runtime never reads execution policy from env at steady state. The DB is canonical.
- **Hot-reload proven.** Mirrors `RefreshableSelectionRuleEngine`; the same integer-read cache pattern is load-tested by selection rules already.

### Costs

- **Operator surface widens.** `/execution-settings` exposes bounds checking, but an operator can still produce a valid-but-wrong policy (e.g., `deadSideGuard.mode=off` on live-lite). The web form defaults to the current value; audit fields in the runtime log each swap with old vs new payload for forensics.
- **One more DB migration.** Migration 038 adds the column + seeds the three profiles; pre-migration installs still run (parser returns defaults on null JSON, repo tolerates missing columns).
- **Scope expands past what env-only callers covered.** `ENTRY_PRICE_CEILING` and `EXIT_ORDER_TTL_MS` were previously code constants, not env; this ADR pulls them into the same JSON payload for a single cohesive policy surface. The ADR-013 constants remain exported as fallbacks for tests and one-shot scripts that don't wire the provider.

## Future Work

- **Observations table.** A dedicated `execution_policy_observations` table (task #99) for structured canary reads would allow per-bucket PnL attribution without tailing logs. Scoped out of the initial rollout — shadow logs are sufficient for the first canary window.
- **Deprecation of ADR-013 constants.** Once all call sites are certain to have a wired provider (currently two are), the `ENTRY_PRICE_CEILING` / `EXIT_ORDER_TTL_MS` exports can be dropped.

## References

- ADR-006 — Execution-price policy (edge mode baseline)
- ADR-011 — Operational extensions (lineage for runtime-overridable operational knobs)
- ADR-013 — Entry-price ceiling + exit-TTL bump
- ADR-014 — Bounded-midpoint price improvement
- Audit 2026-04-24 — Dead-side near-endDate guard
- `docs/runbooks/execution_policy_db_rollout.md` — operational rollout playbook
