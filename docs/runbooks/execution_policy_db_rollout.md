# DB-backed Execution Policy Rollout

Date: 2026-04-24
Status: Implementation plan and operator runbook
Owner: next runtime/API/web implementer

## Goal

Move execution-policy controls out of env and into `control.db` so operators can switch
dead-side protection and pricing policy without redeploying or restarting the runtime.

This plan covers the execution knobs added during the 2026-04-24 pricing/dead-side work:

| Current knob | Target source |
| --- | --- |
| `DEAD_SIDE_GUARD_MODE` | `profile_settings.execution_policy_json` |
| `DEAD_SIDE_GUARD_ASK_CEILING` | `profile_settings.execution_policy_json` |
| `DEAD_SIDE_GUARD_MAX_TIME_TO_END_MS` | `profile_settings.execution_policy_json` |
| `EXECUTION_PRICING_MODE` | `profile_settings.execution_policy_json` |
| `EXECUTION_MAX_ENTRY_SPREAD_TICKS` | `profile_settings.execution_policy_json` |
| `EXECUTION_MAX_EXIT_SPREAD_TICKS` | `profile_settings.execution_policy_json` |
| `EXECUTION_MAX_IMPROVEMENT_TICKS` | `profile_settings.execution_policy_json` |
| `EXECUTION_WIDE_SPREAD_POLICY` | `profile_settings.execution_policy_json` |
| `EXECUTION_ONE_SIDED_POLICY` | `profile_settings.execution_policy_json` |

Also move these existing operational constants into the same policy object so they do not
require future code changes to retune:

| Current constant | Target source |
| --- | --- |
| `ENTRY_PRICE_CEILING = 0.75` | `profile_settings.execution_policy_json.entryPriceCeiling` |
| `EXIT_ORDER_TTL_MS = 300_000` | `profile_settings.execution_policy_json.exitOrderTtlMs` |

Env should remain only for process wiring and secrets until a later secrets-management pass:
database paths, ports, credentials, private keys, API keys. Do not add new strategy,
risk, or execution behavior flags to env.

## Document Placement

Use tracked documentation locations only.

| Document type | Location | Rule |
| --- | --- | --- |
| Architectural decision | `docs/adr/015-db-backed-execution-policy.md` | Create this ADR before implementation or in the same PR. It supersedes the env-based config substrate in ADR-014, not the pricing formula itself. |
| Operator rollout | `docs/runbooks/execution_policy_db_rollout.md` | This file is the operational source of truth for rollout dates, SQL switches, and monitoring. |
| Evidence and fact-checks | `docs/audits/` | Keep raw investigation outputs here. Link them from ADRs and runbooks. |
| Canonical algorithm spec | `research_plankton/plankton-analysis/06_algorithm_spec.md` | Read-only unless the user explicitly asks to modify it. Runtime code adapts to the spec, not the reverse. |
| Ignored scratch plans | `docs/superpowers/plans/` | Do not use for source-of-truth plans. This directory is gitignored. |

Related existing docs:

| Path | Purpose |
| --- | --- |
| `docs/adr/013-entry-price-ceiling-and-exit-ttl-bump.md` | Entry ceiling and 5 minute exit TTL rationale. |
| `docs/adr/014-bounded-midpoint-price-improvement.md` | Bounded-midpoint formula and observe-first pricing rollout. |
| `docs/audits/2026-04-24-execution-pricing-and-dead-side-review.md` | Initial audit and recommendations. |
| `docs/audits/2026-04-24-execution-pricing-review-factcheck.md` | Verified production and research-database claims. |

## Target Control Model

Store execution policy per profile in `profile_settings`, because existing profile-scoped
operator settings already live there (`envelope_json`, `risk_caps_json`, `relayer_json`).
Runtime invalidation should follow the existing selection-rule pattern:

| Table | Change |
| --- | --- |
| `profile_settings` | Add nullable `execution_policy_json TEXT`. |
| `runtime_control_state` | Add `execution_policy_version INTEGER NOT NULL DEFAULT 0`. |

The policy JSON is intentionally one profile-scoped object rather than nine top-level env
fields. This keeps all execution behavior in one versioned payload while still allowing
direct SQL edits.

Default live-lite payload for first deploy:

```json
{
  "version": 1,
  "entryPriceCeiling": 0.75,
  "exitOrderTtlMs": 300000,
  "deadSideGuard": {
    "mode": "enforce",
    "askCeiling": 0.02,
    "maxTimeToEndMs": 120000
  },
  "pricing": {
    "mode": "edge",
    "maxEntrySpreadTicks": 20,
    "maxExitSpreadTicks": 40,
    "maxImprovementTicks": 10,
    "wideSpreadPolicy": "edge",
    "oneSidedPolicy": "edge"
  },
  "telemetry": {
    "deadSideCanary": true,
    "pricingShadow": true
  }
}
```

Rationale for first deploy:

| Field | Initial value | Why |
| --- | --- | --- |
| `deadSideGuard.mode` | `enforce` | Last 3 production days showed 12 bad fills inside 120s or after endDate and 0 long-dated probes rejected by this threshold. |
| `deadSideGuard.maxTimeToEndMs` | `120000` | Covers the last-minute and post-end dead-side class without blanket-flooring cheap lottery entries more than 15 minutes out. |
| `pricing.mode` | `edge` | Keep actual order placement on the old formula while shadow-computing bounded-midpoint for 2-3 days. |
| `telemetry.pricingShadow` | `true` | Required for the decision to flip pricing without guessing. |

## Schema and Repository Tasks

Implement in this order.

1. Add control migration `packages/db/src/migrations-control/038_execution_policy.sql`.
2. Update `packages/db/src/schemas/control.sql` with both new columns.
3. Update bootstrap compatibility code if older control DBs are patched through safe column adds.
4. Add domain types in `packages/domain/src/types.ts`: `ExecutionPolicy`, `DeadSideGuardPolicy`, `ExecutionPricingPolicy`, `ExecutionPolicyTelemetry`.
5. Extend `ProfileSettings` with `executionPolicyJson: string | null`.
6. Update `packages/db/src/repositories/profile-settings-repository.ts` to read/write `execution_policy_json`.
7. Add a small policy parser module outside `packages/config`, for example `apps/runtime/src/execution-policy.ts`.
8. Keep env parsing in `packages/config/src/env.ts` free of the nine execution-policy knobs.
9. Remove those nine knobs from `.env.example` and `.env.production.example`.

Migration sketch:

```sql
ALTER TABLE profile_settings ADD COLUMN execution_policy_json TEXT;
ALTER TABLE runtime_control_state ADD COLUMN execution_policy_version INTEGER NOT NULL DEFAULT 0;
INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1);
```

If `ALTER TABLE` must be idempotent for SQLite versions without `IF NOT EXISTS`, follow the
existing safe-add-column pattern used by bootstrap code.

## Runtime Integration Tasks

The bridge currently captures dead-side and pricing options at construction time. DB storage
alone is not enough; the runtime must read a mutable effective policy.

Required runtime shape:

| Component | Change |
| --- | --- |
| `apps/runtime/src/execution-policy.ts` | Own defaults, validation, JSON parsing, and merge behavior. Invalid DB JSON should fail closed to safe defaults and log one structured error. |
| `apps/runtime/src/execution-policy-provider.ts` | New version-polled provider. Reads current profile's `execution_policy_json` and `runtime_control_state.execution_policy_version`. |
| `SignalToOrderBridge` | Replace readonly `deadSideGuard` and `pricing` fields with a policy snapshot getter, or add `updatePolicy()` called by the provider. |
| `StaleOrderCleaner` | Inject `exitOrderTtlMs` from the policy provider instead of using only the module constant. |
| `apps/runtime/src/index.ts` | Wire the provider from `controlDb`, current profile, bridge, and stale-order cleaner. |
| `CommandPoller` | Optional: add `execution_policy_reload`; not required if version polling is implemented. |

Hot-reload rule:

| Trigger | Runtime behavior |
| --- | --- |
| `execution_policy_version` unchanged | Use current in-memory policy snapshot. |
| `execution_policy_version` changed | Reload `profile_settings.execution_policy_json`, validate, atomically swap the snapshot, log old/new mode summary. |
| DB JSON invalid | Keep previous valid snapshot, log error, publish a risk/metric event. Do not crash live-lite. |

Polling interval can be 5 seconds to match `CommandPoller`, or once per signal conversion.
The effect must be visible without restart and without deploy.

## API Tasks

Add a typed API surface instead of asking operators to edit raw JSON in the UI.

| File | Change |
| --- | --- |
| `apps/api/src/routes/profiles.ts` | Include `execution_policy_json` in GET settings responses and PUT settings payloads. Bump `runtime_control_state.execution_policy_version` when it changes. |
| `apps/web/src/api/types.ts` | Add `execution_policy_json` and typed execution-policy DTOs. |
| `apps/web/src/api/hooks.ts` | Extend `useUpdateProfileSettings`, or add `useExecutionPolicy` / `useUpdateExecutionPolicy`. |

Preferred API behavior:

| Operation | Behavior |
| --- | --- |
| `GET /api/v1/profiles/:profileId/settings` | Returns raw `execution_policy_json` and an `effectiveExecutionPolicy` object if validation succeeds. |
| `PUT /api/v1/profiles/:profileId/settings` | Accepts `executionPolicyJson` for compatibility, validates before saving, bumps version on change. |
| Optional `PUT /api/v1/profiles/:profileId/execution-policy` | Accepts typed JSON object, validates, saves compact JSON, bumps version. |

SQL-only operation must also be supported. When direct SQL edits are used, the operator must
update the policy JSON and bump the version in the same transaction.

## Web Settings Tasks

Add a dedicated page. Do not hide execution policy inside the raw profile settings JSON page.

| File | Change |
| --- | --- |
| `apps/web/src/pages/ExecutionSettings.tsx` | New profile-tabbed settings page, modeled after `RiskSettings.tsx`. |
| `apps/web/src/App.tsx` | Add route `/settings/execution`. |
| `apps/web/src/components/Layout.tsx` | Add `Execution Settings` to the settings dropdown. |
| `apps/web/src/pages/ProfileSettings.tsx` | Keep raw JSON/profile settings page, but add a link to Execution Settings. |

Fields to show:

| Section | Fields |
| --- | --- |
| Entry guard | `entryPriceCeiling` |
| Exit lifecycle | `exitOrderTtlMs` displayed as seconds/minutes |
| Dead-side guard | `mode`, `askCeiling`, `maxTimeToEndMs` |
| Pricing | `mode`, `maxEntrySpreadTicks`, `maxExitSpreadTicks`, `maxImprovementTicks`, `wideSpreadPolicy`, `oneSidedPolicy` |
| Effective state | `execution_policy_version`, last updated timestamp, active runtime profile |

UX safety:

| Control | Constraint |
| --- | --- |
| `deadSideGuard.mode` | `off`, `observe`, `enforce` select. Show warning if `off`. |
| `pricing.mode` | `edge`, `bounded-midpoint` select. Show canary status before allowing bounded-midpoint in live-lite. |
| Tick caps | Positive integers with max guardrails matching runtime parser. |
| `exitOrderTtlMs` | Display as seconds but persist ms. |

## Observability Tasks

Structured logs are not enough for this rollout. Persist policy observations so SQL and the
dashboard can compare edge vs bounded-midpoint and dead-side buckets over 24-72 hour windows.

Add a ledger-side observation surface. Either a dedicated table or `risk_events` can work, but
a dedicated table is easier to query.

Recommended table:

```sql
CREATE TABLE execution_policy_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL,
  signal_id TEXT,
  client_order_id TEXT,
  token_id TEXT NOT NULL,
  market_slug TEXT,
  side TEXT NOT NULL,
  signal_reason TEXT,
  selected_pricing_mode TEXT NOT NULL,
  selected_price REAL,
  edge_price REAL,
  bounded_price REAL,
  bounded_outcome TEXT NOT NULL,
  spread_ticks REAL,
  improvement_ticks REAL,
  dead_side_observed INTEGER NOT NULL DEFAULT 0,
  dead_side_bucket TEXT,
  dead_side_enforce_hit INTEGER NOT NULL DEFAULT 0,
  dead_side_x60 INTEGER NOT NULL DEFAULT 0,
  dead_side_x120 INTEGER NOT NULL DEFAULT 0,
  dead_side_x300 INTEGER NOT NULL DEFAULT 0,
  dead_side_x900 INTEGER NOT NULL DEFAULT 0,
  time_to_end_ms INTEGER,
  skipped_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_execution_policy_observations_profile_ts
  ON execution_policy_observations(profile_id, created_at DESC);

CREATE INDEX idx_execution_policy_observations_token_ts
  ON execution_policy_observations(token_id, created_at DESC);
```

Runtime should write one row for every BUY/SELL signal that reaches execution-term resolution.
Rows that skip before execution terms do not need pricing comparison, but hard skips should
still be counted in existing `SignalConversionSkipped` metrics.

Dashboard metrics to add on `/settings/execution`:

| Metric | Window |
| --- | --- |
| Dead-side observations by bucket | 24h and 72h |
| Dead-side enforced skips | 24h and 72h |
| `x60`, `x120`, `x300`, `x900` shadow-hit counts | 72h |
| Pricing shadow outcome counts: ok, edge-fallback, skip, invalid | 24h and 72h |
| BUY bounded-vs-edge price delta distribution | 24h and 72h |
| SELL bounded-vs-edge price delta distribution | 24h and 72h |
| Invalid or overcross candidate count | 24h and 72h |
| Fill rate and median time-to-fill by selected pricing mode | 24h after pricing flip |

## SQL Operations

Direct SQL is valid for emergency or scripted operation. Always update JSON and bump version
in the same transaction.

Initial live-lite policy after DB migration:

```sql
BEGIN;

UPDATE profile_settings
SET
  execution_policy_json = '{"version":1,"entryPriceCeiling":0.75,"exitOrderTtlMs":300000,"deadSideGuard":{"mode":"enforce","askCeiling":0.02,"maxTimeToEndMs":120000},"pricing":{"mode":"edge","maxEntrySpreadTicks":20,"maxExitSpreadTicks":40,"maxImprovementTicks":10,"wideSpreadPolicy":"edge","oneSidedPolicy":"edge"},"telemetry":{"deadSideCanary":true,"pricingShadow":true}}',
  updated_at = datetime('now')
WHERE profile_id = 'live-lite';

UPDATE runtime_control_state
SET
  execution_policy_version = execution_policy_version + 1,
  updated_at = datetime('now')
WHERE id = 1;

COMMIT;
```

Flip pricing to bounded-midpoint after canary passes:

```sql
BEGIN;

UPDATE profile_settings
SET
  execution_policy_json = '{"version":1,"entryPriceCeiling":0.75,"exitOrderTtlMs":300000,"deadSideGuard":{"mode":"enforce","askCeiling":0.02,"maxTimeToEndMs":120000},"pricing":{"mode":"bounded-midpoint","maxEntrySpreadTicks":20,"maxExitSpreadTicks":40,"maxImprovementTicks":10,"wideSpreadPolicy":"edge","oneSidedPolicy":"edge"},"telemetry":{"deadSideCanary":true,"pricingShadow":true}}',
  updated_at = datetime('now')
WHERE profile_id = 'live-lite';

UPDATE runtime_control_state
SET
  execution_policy_version = execution_policy_version + 1,
  updated_at = datetime('now')
WHERE id = 1;

COMMIT;
```

Rollback pricing to edge:

```sql
BEGIN;

UPDATE profile_settings
SET
  execution_policy_json = '{"version":1,"entryPriceCeiling":0.75,"exitOrderTtlMs":300000,"deadSideGuard":{"mode":"enforce","askCeiling":0.02,"maxTimeToEndMs":120000},"pricing":{"mode":"edge","maxEntrySpreadTicks":20,"maxExitSpreadTicks":40,"maxImprovementTicks":10,"wideSpreadPolicy":"edge","oneSidedPolicy":"edge"},"telemetry":{"deadSideCanary":true,"pricingShadow":true}}',
  updated_at = datetime('now')
WHERE profile_id = 'live-lite';

UPDATE runtime_control_state
SET
  execution_policy_version = execution_policy_version + 1,
  updated_at = datetime('now')
WHERE id = 1;

COMMIT;
```

Verify runtime picked up the change:

```sql
SELECT execution_policy_version, updated_at
FROM runtime_control_state
WHERE id = 1;

SELECT execution_policy_json
FROM profile_settings
WHERE profile_id = 'live-lite';
```

The runtime log should contain a structured reload message with old and new policy summaries.

## Rollout Calendar

Dates below assume implementation starts on Friday, 2026-04-24. If the implementation ships
later, shift the calendar by the same number of days but keep the same day offsets.

| Date | Day | Action | Required evidence |
| --- | --- | --- | --- |
| 2026-04-24 | Day 0 | Implement DB-backed policy, remove the nine new env knobs, add settings UI and observation persistence. Deploy with `deadSideGuard.mode=enforce`, `deadSideGuard.maxTimeToEndMs=120000`, `pricing.mode=edge`, `telemetry.pricingShadow=true`. | Runtime starts, policy reload log appears, settings UI shows effective policy, no env references remain for the nine knobs. |
| 2026-04-25 | Day 1 | Verify hot reload with a harmless SQL change and revert it. Keep pricing on `edge`. | `execution_policy_version` increments, runtime reloads without restart, observations continue writing. |
| 2026-04-26 | Day 2 | First 24h canary review. Keep dead-side enforce on. Keep pricing on `edge`. | Dead-side bad fills near end should be zero; pricing shadow invalid/skip rate should be near zero. |
| 2026-04-27 | Day 3 | Second canary review. Decide whether pricing can flip on 2026-04-28 or needs more data. | 48-72h observation query shows bounded midpoint has no invalid/overcross tail and no unexpected skip cluster. |
| 2026-04-28 | Day 4 | If gates pass, flip `pricing.mode` to `bounded-midpoint` via SQL or UI. If gates fail, keep `edge` and tune caps in DB only. | Runtime reload log confirms bounded-midpoint; first orders carry `selected_pricing_mode=bounded-midpoint`. |
| 2026-04-29 | Day 5 | 24h post-flip review. Compare fill rate, median time-to-fill, dead-side skips, and PnL drift against 2026-04-25 to 2026-04-27 edge baseline. | No degradation beyond thresholds below. |
| 2026-05-01 | Day 7 | Final keep/rollback decision for bounded-midpoint. | If gates pass, keep bounded-midpoint and update ADR-014 status from Proposed to Accepted. If not, rollback to edge and document reason in `docs/audits/`. |

## Canary Queries

Dead-side bucket split:

```sql
SELECT
  dead_side_bucket,
  COUNT(*) AS observations,
  SUM(dead_side_enforce_hit) AS enforced_skips,
  SUM(dead_side_x60) AS x60,
  SUM(dead_side_x120) AS x120,
  SUM(dead_side_x300) AS x300,
  SUM(dead_side_x900) AS x900
FROM execution_policy_observations
WHERE profile_id = 'live-lite'
  AND created_at >= datetime('now', '-72 hours')
  AND dead_side_observed = 1
GROUP BY dead_side_bucket
ORDER BY dead_side_bucket;
```

Pricing shadow outcomes while live pricing is still `edge`:

```sql
SELECT
  side,
  bounded_outcome,
  COUNT(*) AS n,
  ROUND(AVG(ABS(COALESCE(bounded_price, edge_price) - edge_price)), 6) AS avg_abs_delta,
  ROUND(MAX(ABS(COALESCE(bounded_price, edge_price) - edge_price)), 6) AS max_abs_delta
FROM execution_policy_observations
WHERE profile_id = 'live-lite'
  AND created_at >= datetime('now', '-72 hours')
  AND selected_pricing_mode = 'edge'
GROUP BY side, bounded_outcome
ORDER BY side, bounded_outcome;
```

Post-flip fill comparison:

```sql
SELECT
  o.side,
  epo.selected_pricing_mode,
  COUNT(DISTINCT o.order_id) AS orders,
  COUNT(f.fill_id) AS fills,
  ROUND(CAST(COUNT(f.fill_id) AS REAL) / NULLIF(COUNT(DISTINCT o.order_id), 0), 4) AS fill_rate
FROM execution_policy_observations epo
JOIN orders o ON o.client_order_id = epo.client_order_id
LEFT JOIN fills f ON f.order_id = o.order_id
WHERE epo.profile_id = 'live-lite'
  AND epo.created_at >= datetime('now', '-24 hours')
GROUP BY o.side, epo.selected_pricing_mode;
```

If the actual order schema uses different ID names, adapt the join but keep the same metric:
orders placed, fills observed, fill rate by selected pricing mode.

## Flip Gates

Do not flip `pricing.mode` to `bounded-midpoint` unless all gates pass over at least 48 hours
of live-lite observations.

| Gate | Pass condition |
| --- | --- |
| Invalid/overcross candidates | 0 observations. |
| Pricing shadow skip rate | Less than 1 percent, or every skip explained by known wide-spread fallback policy. |
| Max bounded delta | Bounded by `maxImprovementTicks * tickSize`; no naive midpoint tail like the prior +0.489 examples. |
| Dead-side enforcement | No fills after endDate and no BUY fills with `bestAsk <= 0.02` inside the enforced 120s window. |
| Long-dated cheap probes | No enforce skips in `15-60m`, `1-4h`, or `>4h` buckets. Observations are fine; enforced skips are not. |
| Runtime stability | No restart loop, no policy-parse fallback, no policy reload errors. |

Rollback bounded-midpoint immediately if any of these happen after the flip:

| Symptom | Action |
| --- | --- |
| Exchange rejects increase due to invalid price or tick-grid errors | SQL rollback pricing to `edge`. |
| Fill rate collapses for entries or exits vs edge baseline | SQL rollback pricing to `edge`; keep observations on. |
| Dead-side guard rejects long-dated cheap probes | Lower only the dead-side enforcement scope via DB; do not disable entry ceiling. |
| Policy JSON parse errors | SQL rollback to the last known-good JSON and bump version. |

## Verification Commands

Local checks after implementation:

```bash
pnpm --filter @plankton/config test
pnpm --filter @plankton/db test
pnpm --filter @plankton/runtime test
pnpm --filter @plankton/api test
pnpm --filter @plankton/web test
pnpm run typecheck
pnpm run lint
```

Focused runtime checks:

```bash
pnpm --filter @plankton/runtime exec vitest run \
  src/__tests__/signal-to-order-bridge.test.ts \
  src/__tests__/executable-price.test.ts \
  src/__tests__/stale-order-cleaner.test.ts
```

Add new tests for:

| Area | Required tests |
| --- | --- |
| Policy parser | Defaults, invalid JSON, invalid enum, bounds. |
| Repository | `execution_policy_json` read/write and version bump. |
| Runtime hot reload | Version bump updates bridge behavior without restart. |
| Dead-side SQL config | `observe` places but logs, `enforce` skips, `off` does neither. |
| Pricing SQL config | `edge` places edge price with shadow, `bounded-midpoint` places bounded price. |
| UI | Execution settings renders current policy and saves a valid update. |

## Cleanup Checklist

Before merge:

| Check | Expected |
| --- | --- |
| `rg "DEAD_SIDE_GUARD_|EXECUTION_PRICING_MODE|EXECUTION_MAX_ENTRY_SPREAD_TICKS|EXECUTION_MAX_EXIT_SPREAD_TICKS|EXECUTION_MAX_IMPROVEMENT_TICKS|EXECUTION_WIDE_SPREAD_POLICY|EXECUTION_ONE_SIDED_POLICY"` | No production env parsing or env examples. Mentions are allowed only in migration notes or this runbook. |
| `.env.example` | No new execution-policy knobs. |
| `.env.production.example` | No new execution-policy knobs. |
| Runtime startup | Works when `execution_policy_json` is null by using code defaults. |
| Runtime hot reload | Works after direct SQL version bump. |
| Settings UI | Exposes policy without requiring raw JSON edits. |
| ADRs | ADR-015 created; ADR-014 updated or cross-linked so it no longer says env flip is the final operator path. |

