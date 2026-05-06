# ADR-020 — Step 3: Soft-ranking score

## Status

Accepted — 2026-05-05

## Context

Step 3 of the trading pipeline ("Soft ranking / scoring") was audited
against the canonical algorithm spec
`research_plankton/plankton-analysis/06_algorithm_spec.md` v2.3 — which
is **silent** on Step 3 — and against the model-development report
`research_plankton/soft_ranking_score_report.md` v1, the authoritative
source for soft ranking. The audit and remediation plan live at
[`docs/audits/2026-05-05-step3-soft-ranking-remediation-plan.md`](../audits/2026-05-05-step3-soft-ranking-remediation-plan.md).

Step 3 produces a **continuous score in `[0, 1]`** for every market that
passes Step 2's hard eligibility filter (ADR-019). The score is the
predicted probability that the market becomes a profitable plankton
trade. It is **not a gate** — it is a ranking signal that feeds:

- watch-set ordering (Step 4): when the WS pricing-subscription budget
  is exceeded, retain higher-score markets first;
- per-tier prioritization in `findTrackedForPricingTiered`: replace the
  3-tier static `SELECTION_STATUS_RANK` tiebreak with a continuous
  score-driven ranking on top of the existing tier ordering;
- operator dashboards: histogram, mean/median, model-version drift,
  active-universe scored / unscored / stale counts.

The MVP **does not gate BUYs by score** — Step 4 (watch-set formation)
will own gating. Step 3 is purely the score producer.

## Decision

We adopt the audit doc's seven decisions (D1–D7) verbatim. Summary:

### D1 — Ship a numeric+category logistic regression model retrained on heuristic categories

The published joint LR (0.9017 AUC) trained against the offline
`analysis_market_taxonomy` table was not reproducible at runtime
(taxonomy is research-only; no Gamma-event-tag pipeline exists). The
shipped model retrains the joint LR on heuristic-only categories
derived from `category_from_text(slug, event_slug, "")` —
`{other, sports, politics, weather, stocks, crypto, esports}`.

Random Forest is **out of scope** for v1 — porting 80 trees × ~1 K
nodes to TS/JSON is non-trivial and the report
(`soft_ranking_score_report.md` line 1292-1293) explicitly recommends
LR for cross-sample inference.

**Retrained validation evidence** (held-out 20 % stratified split,
5 650 training rows, balanced):

- **AUC** = **0.8551** (above the 0.80 P0 blocker threshold).
- **Top decile** carries 91 % positives vs. **bottom decile** 12 % —
  strong tier-discrimination signal.

### D2 — Single standardized feature vector artifact format

The serialized JSON mirrors how `LogisticModel.predict_proba` actually
scores: one ordered vector covering every column (12 numeric followed
by 7 category one-hots — total 19), one mean/std value per column, one
coefficient per column, plus a single intercept.

```
score = sigmoid( intercept + Σᵢ coefficients[i] * (xᵢ − mean[i]) / std[i] )
```

The loader asserts (a) `modelKind` is in the supported whitelist
(`logistic-numeric-plus-category`), (b) `featureNames` /
`coefficients` / `mean` / `std` are the same length, and (c)
`featureNames` matches the canonical order exactly: 12 numeric
features followed by N category one-hots in `categories` order, each
prefixed `category=`. Mismatches throw `ModelArtifactSchemaError` at
load time, so the module never starts with a silently incompatible
artifact. The artifact file
`apps/runtime/src/data/soft-ranking-model.v1.json` is committed to the
repo and copied into `apps/runtime/dist/data/` by a post-`tsc -b` step
(`apps/runtime/scripts/copy-data.mjs`). The post-tsc script clears
`dist/data/` before copying so removing the artifact and rebuilding
takes effect cleanly. The Dockerfile intentionally does **not** add a
separate `COPY src/data` belt-and-braces line: when the artifact is
rolled back the directory may vanish entirely, which would either
break the Docker build or resurrect a stale copy and defeat the
disabled-no-op contract.

### D3 — DB schema (split-bootstrap aware)

Four nullable columns added to `markets`: `score`, `score_model_version`,
`scored_at`, `features_captured_at`. `NULL` means "not yet scored" —
zero is a valid model output and would corrupt ranking. A partial index
`idx_markets_score WHERE score IS NOT NULL` supports the histogram
query.

The runtime ledger DB does **not** go through the migration runner —
`bootstrapLedgerDb` (`packages/db/src/bootstrap.ts`) handles upgrades by
combining `safeAddColumn` calls with a re-exec of `ledger.sql`. The
production change-set is therefore (a) `ledger.sql` SoT updated with the
four columns inside the `markets` CREATE TABLE, **and** (b) four
`safeAddColumn` calls in `bootstrapLedgerDb`. Migration
`043_markets_score_columns.sql` is also added for non-runtime DB
consumers (research scripts) that iterate the migrations directory; the
runner records applied filenames in `schema_migrations` and skips on
replay.

### D4 — `SoftRankingScoreModule` subscribed to `NormalizedMarketUpdated`

A dedicated runtime module owns scoring. It subscribes to
`NormalizedMarketUpdated`, filters to Step2-included entry candidates
(`selectionStatus ∈ { matched_include, step2_fallback_include }`),
builds the standardized feature row, runs `predictScore`, and writes
`(tokenId, score, modelVersion, scoredAt, featuresCapturedAt)` back via
`MarketRepository.updateScoresBatch` in a single transaction per event.

Cadence is implicit — driven by the `MarketDataModule` poll cadence
(~5 s) and stream updates. Untracked markets stay `score IS NULL` until
they enter the data path; this is the correct semantic — we don't have
features for them.

**Score-column ownership invariant.** `score`, `score_model_version`,
`scored_at`, `features_captured_at` are written **exclusively** by
`updateScoresBatch`. The market-upsert path
(`UPSERT_MARKET_SQL`) does not mention them, relying on SQLite's UPSERT
semantic that columns omitted from `SET` are preserved. This is
encoded as a comment + repository test so a future contributor cannot
break it.

**Disabled-no-op contract** (audit doc §F1 / §F14). If the artifact is
missing or fails validation, `loadSoftRankingModel` returns `null` and
the module enters a no-op state with a single startup `warn`. Runtime
startup itself does **not** fail. This makes the rollback story safe:
remove the JSON file and runtime degrades gracefully.

### D5 — JS comparator integrates the score, with stale-score demotion

`findTrackedForPricingTiered` already sorts in JS (the SQL `ORDER BY`
is a stable feed for the comparator, not the final ranking). The
comparator now adds a tier-2 sort on **fresh** score — a score is
treated as `null` for ranking when `features_captured_at < now − 4h` —
so a stale non-null score does **not** outrank a fresh lower score.
Tied scores fall back to `created_at DESC` then `tokenId ASC`.

The MVP **does not** wire the score into `MarketSelectionCache` or
`evaluatePreEntry` — those stay binary. Step 4 (watch-set formation)
will consume the score for actual gating.

### D6 — Heuristic categories only at training and inference

Training categories use `category_from_text(slug, event_slug, "")` only
(no `analysis_market_taxonomy`, no `raw_text`). The TS port lives at
`packages/domain/src/category.ts` as a single canonical
`deriveCategory(slug, eventSlug)` returning one of the 7 heuristic
labels. A property-based test asserts TS / Python parity for sampled
slug corpora.

### D7 — DB-aggregated telemetry surfaced via `runtime_metrics`

`SoftRankingScoreModule` does **not** maintain in-memory counts. Two
reasons: (a) `staleMarkets` changes purely with the passage of time,
even when no event arrives — an in-memory map seeded from event
batches would silently understate stale counts during an event lull;
(b) restarts lose in-memory state but persisted scores survive —
operators would briefly see an empty snapshot.

At each debounced flush (default once per minute) the module runs a
single SQL aggregation against `markets` scoped to the active universe
(`active = 1`), returning a `ScoreDistributionSnapshot` with model
version, scored / step2-included-no-score / skipped-non-Step2-included
/ stale counts, mean, median, and a 10-bucket histogram. The snapshot
is written to `runtime_metrics` under the metric name
`score_distribution`. The API process reads the latest persisted row
via `GET /api/v1/scanner/score-distribution` (returns 503 if no
snapshot exists yet — pre-first-flush state, or rollback state when the
soft-ranking module is disabled).

The healthcheck on `SoftRankingScoreModule` echoes the most-recent
snapshot's `scoreModelVersion` / `scored` / `stale` / `mean` so
operators can confirm freshness without touching the API.

## Consequences

### Positive

- **Continuous ranking signal** replaces the 3-tier static priority
  inside the same selection-status tier. The top decile in held-out
  validation carried 91 % positives — strong tier-discrimination.
- **Operationally interpretable.** Operators can read the coefficient
  table and predict score direction. The model artifact is ~60 floats
  total — trivial to diff between versions.
- **Disabled-no-op contract** keeps the rollback story clean: drop the
  JSON file, NULL the four score columns, and the JS comparator
  degenerates back to the prior tier+createdAt ordering. No code
  rollback needed.
- **DB-aggregated telemetry** is honest under restarts and event lulls.
  Snapshot writes survive bot restarts; stale counts update with time
  even when no events arrive.

### Negative / accepted trade-offs

- **AUC dropped from 0.9017 → 0.8551** because we lost the fine-grained
  research-only categories. Runtime parity is exact and the value still
  clears the operational threshold.
- **No BUY gate by score in MVP.** Step 4 owns gating — until then,
  the score affects only the WS pricing budget tiebreak.
- **`step2_included_no_score` mixes three causes** — (i) row hasn't
  entered the data path, (ii) module is disabled, (iii) `buildFeatureRow`
  returned `null` for missing inputs. v1 does not persist a per-row skip
  reason; operators correlate via `markets.created_at` and
  `runtime_metrics.scoreModelVersion`. A `score_skip_reason TEXT` column
  is a possible follow-up if production telemetry shows ambiguity.

## Rollback plan

1. Stop the runtime process.
2. Remove the artifact: `rm apps/runtime/src/data/soft-ranking-model.v1.json`
   (or equivalently, rename it).
3. Restart the runtime. `loadSoftRankingModel` returns `null` and
   `SoftRankingScoreModule` enters disabled-no-op with one warn at
   startup. The startup hook in `apps/runtime/src/index.ts` then
   automatically performs both cleanups required by the disabled-no-op
   contract: it deletes `runtime_metrics.score_distribution` and NULLs
   all four score-ownership columns
   (`markets.score` / `markets.score_model_version` /
   `markets.scored_at` / `markets.features_captured_at`)
   for every row that still carries a value (logged as
   `soft_ranking_disabled_score_columns_cleared`). After the cleanup the
   JS comparator in `findTrackedForPricingTiered` silently degenerates
   back to the prior tier + `created_at` ordering since all scores are
   NULL, and `/api/v1/scanner/score-distribution` returns
   `503 NO_SNAPSHOT`.

   _(Optional, manual safety net — only if you must clear scores
   **before** the next runtime restart.)_

   ```sql
   UPDATE markets
   SET score = NULL,
       score_model_version = NULL,
       scored_at = NULL,
       features_captured_at = NULL;
   ```

The rollback is fully reversible: re-add the JSON, restart, and the
scoring resumes within one `MarketDataModule` poll cycle (~5 s).

## References

- Audit + remediation plan:
  [`docs/audits/2026-05-05-step3-soft-ranking-remediation-plan.md`](../audits/2026-05-05-step3-soft-ranking-remediation-plan.md)
- Model report: `research_plankton/soft_ranking_score_report.md`
- ADR-017: Step 0 — bot starts (discovery channel)
- ADR-018: Step 1 — universe ingestion alignment
- ADR-019: Step 2 — hard eligibility filters alignment
- Operations runbook:
  [`docs/runbooks/soft_ranking_operations.md`](../runbooks/soft_ranking_operations.md)
