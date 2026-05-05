# Soft-ranking operations runbook

**Owner:** automation
**Last updated:** 2026-05-05
**Companion ADR:** [`docs/adr/020-step3-soft-ranking-score.md`](../adr/020-step3-soft-ranking-score.md)
**Audit doc:** [`docs/audits/2026-05-05-step3-soft-ranking-remediation-plan.md`](../audits/2026-05-05-step3-soft-ranking-remediation-plan.md)

This runbook covers operational procedures for the soft-ranking score
module that produces the per-market score in `[0, 1]` consumed by the
watch-set tiebreak. It is **not** a gate in MVP — Step 4 owns gating.

---

## 1. Healthcheck and live status

The module surfaces under the runtime supervisor as
`soft-ranking-score`. The healthcheck `detail` is one line containing:

```
subscribed modelVersion=<version>
  events=<n> scoredRows=<n>
  skippedNonStep2Included=<n> missingFeatures=<n> scoringErrors=<n>
  scored=<n> stale=<n> mean=<x.xxxx>
```

The first six counters are event-batch counters (cumulative since
process start). The final three (`scored`, `stale`, `mean`) come from
the last DB-aggregated snapshot — they appear once the snapshot has
been computed at least once and at least one row carries a fresh
score.

API endpoint:

```
GET /api/v1/scanner/score-distribution
```

Returns the latest persisted `ScoreDistributionSnapshot`:

```jsonc
{
  "ok": true,
  "data": {
    "modelVersion": "v1.0.0-2026-05-05",
    "scoredMarkets": 482,
    "step2IncludedNoScore": 13,
    "skippedNonStep2Included": 7821,
    "staleMarkets": 4,
    "histogram": [{ "decile": 1, "count": 12 }, …],
    "mean": 0.4321,
    "median": 0.4150,
    "capturedAt": "2026-05-05T12:34:56.789Z"
  },
  "ts": "2026-05-05T12:35:00Z"
}
```

`503 NO_SNAPSHOT` means no snapshot has been written yet — either the
runtime started < 1 minute ago, or the soft-ranking module is in its
disabled-no-op state.

---

## 2. Bumping the model version

1. Train a new model with the patched
   `research_plankton/soft_ranking_score_analysis.py`.
2. Inspect the new validation AUC — it must clear the **0.80
   operational floor** (audit doc P0 blocker). If it does not, **stop**
   and re-evaluate.
3. The Python script writes both
   `soft_ranking_score_results.json` (research-only) and the runtime
   artifact `apps/runtime/src/data/soft-ranking-model.v1.json`. Rename
   the artifact to `soft-ranking-model.v2.json` and update the loader's
   default path constant:

   ```ts
   // apps/runtime/src/modules/soft-ranking/load-soft-ranking-model.ts
   export function defaultSoftRankingArtifactPath(): string { … "soft-ranking-model.v2.json" … }
   ```

4. Update ADR-020 §A3 with the new AUC + decile table. Commit both the
   artifact and the ADR change in the same PR.
5. Build, run the parity + repository + API tests, and deploy. The
   runtime restart picks up the new artifact; the `modelVersion` field
   in `markets.score_model_version` flips to the new version on the
   next poll cycle.
6. Watch the `/api/v1/scanner/score-distribution` mean for ~10 minutes
   — sudden drift > 10 percentage points warrants a quick rollback per
   §4 below.

The two artifacts can coexist on disk during the rollout PR window;
the loader resolves a single canonical filename via the constant.

---

## 3. Retraining cadence

**Manual for v1.** There is no live-data feedback loop — retraining is
operator-initiated when one of:

- the validation mean drifts > 10 percentage points from the
  trained-data mean (drift alert below);
- the `step2_included_no_score` ratio climbs above ~30 % of the
  Step2-included population for an extended period — indicates feature
  inputs are systematically missing;
- a new categorical input is being introduced (e.g. a new prefix
  family that doesn't fit the existing 7 heuristic labels).

For each retrain, follow §2 above.

---

## 4. Rollback procedure

The rollback is fully reversible because the module is built around the
disabled-no-op contract.

1. **Stop the runtime process.**
2. **Remove the artifact** from disk:

   ```bash
   ssh root@old.server.ip \
     'mv /app/apps/runtime/dist/data/soft-ranking-model.v1.json /tmp/soft-ranking-model.v1.json.bak'
   ```

3. **Restart the runtime.** `loadSoftRankingModel` returns `null`,
   `SoftRankingScoreModule` logs one `warn` at startup
   (`soft-ranking model artifact unavailable — module disabled`) and
   then no-ops.

   The runtime startup automatically nulls out the score columns when
   the model is disabled (see `apps/runtime/src/index.ts` —
   `soft_ranking_disabled_score_columns_cleared` log line). After this
   pass `markets.score`, `markets.score_model_version`, and
   `markets.scored_at` are all `NULL`, and the JS comparator in
   `findTrackedForPricingTiered` degenerates back to the prior tier +
   `created_at` ordering. `runtime_metrics.score_distribution` is
   deleted in the same startup hook so the API immediately returns
   `503 NO_SNAPSHOT`.

   *(Optional, manual safety net)* If you must clear scores **before**
   the next runtime restart (e.g. while the bot is still up), run:

   ```sql
   UPDATE markets
   SET score = NULL,
       score_model_version = NULL,
       scored_at = NULL,
       features_captured_at = NULL;
   ```

4. **Verify** rollback completion:

   ```bash
   curl -s -H "Authorization: Bearer $PLANKTON_API_KEY" \
     https://bot.example.com/api/v1/scanner/score-distribution
   ```

   Expected: `503 NO_SNAPSHOT` (the module no longer writes the metric
   row, and the disabled-startup hook deletes any prior snapshot).

To re-enable: restore the artifact (`mv /tmp/soft-ranking-model.v1.json.bak …`)
and restart. Scoring resumes within one `MarketDataModule` poll cycle
(~5 s). Live scores re-populate per token as `NormalizedMarketUpdated`
events fire.

---

## 5. Score-distribution drift alerts

Compare the current `mean` from
`GET /api/v1/scanner/score-distribution` against the trained-data
positive-class mean recorded in the artifact's `deciles` field
(0-10 % decile midpoint ≈ 0.95).

**Alert thresholds** (rule of thumb — refine once steady-state data is
observable):

| Symptom                                        | Likely cause                                                              | Action                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------- |
| `mean` swings > 10 pp inside an hour           | Feature pipeline regression (volume, liquidity, midPrice all-null spike)  | Inspect `MarketDataModule` healthcheck.      |
| `mean` drifts > 10 pp over multiple days       | Market regime change OR training distribution stale                       | Plan a retrain (§3).                         |
| `staleMarkets > 50 %` of `scoredMarkets`       | `MarketDataModule` polling stalled / event lull                           | Inspect upstream module healthchecks.        |
| `step2IncludedNoScore` climbs > 30 % of Step2  | Required feature input missing (liquidity / midPrice / volume24hr)        | Inspect `LiveMarketDataGateway.extractPricing()` for nulls. |
| `scoredMarkets == 0` across multiple snapshots | Module disabled (artifact missing) OR Step2 universe empty                | Healthcheck `detail` will say `disabled (artifact missing or invalid)`; otherwise verify selection rules. |

---

## 6. Debugging "why is this market unscored?"

For a specific `tokenId`, walk this checklist:

1. **Is it in the active universe?**
   ```sql
   SELECT active, tradable, selection_status FROM markets WHERE token_id = '…';
   ```
   If `active = 0`, scoring is intentional — inactive rows are excluded
   from the snapshot scope.

2. **Is it Step2-included?**
   `selection_status` must be `matched_include` or
   `step2_fallback_include`. Anything else (`unknown`, `matched_exclude`,
   `fallback_exclude`) is filtered out by the module and counted under
   `skippedNonStep2Included`.

3. **Has it ever entered the data path?**
   ```sql
   SELECT scored_at, features_captured_at, score FROM markets WHERE token_id = '…';
   ```
   If all three are NULL, the row has not yet been emitted in a
   `NormalizedMarketUpdated` event. Verify via the
   `MarketDataModule` poller — un-tracked rows appear in the
   `discoveryOnly` bucket of `findTrackedForPricingTiered`.

4. **Is the feature row buildable?**
   Required inputs: `liquidity`, `midPrice`, `volume24hr`,
   `endDate`, `tickSize`. If any one is `NULL`,
   `buildFeatureRow` returns `null` and the row is not scored.
   The runtime warn-logs include `tokenId` for missing-feature skips —
   grep the runtime log for the token.

5. **Did `predictScore` throw?**
   Check `scoringErrors` in the healthcheck `detail`. A non-zero count
   means `predictScore` raised — usually because the artifact's
   `featureNames` includes a column that `buildFeatureRow` does not
   emit (mis-trained artifact). The runtime log carries the error per
   skipped market.

6. **Is the score stale rather than missing?**
   ```sql
   SELECT score, features_captured_at,
          datetime(features_captured_at) > datetime('now','-4 hours') AS fresh
   FROM markets WHERE token_id = '…';
   ```
   A non-NULL `score` with `fresh = 0` means the row carries a stale
   score — visible in the snapshot's `staleMarkets` count. Stale scores
   do not outrank fresh lower scores in the JS comparator. They
   refresh automatically on the next `NormalizedMarketUpdated` event.

---

## 7. Where things live

| Concern                          | Path                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| Artifact (committed)             | `apps/runtime/src/data/soft-ranking-model.v1.json`                                |
| Artifact (built)                 | `apps/runtime/dist/data/soft-ranking-model.v1.json`                               |
| Loader                           | `apps/runtime/src/modules/soft-ranking/load-soft-ranking-model.ts`                |
| Module                           | `apps/runtime/src/modules/soft-ranking/soft-ranking-score-module.ts`              |
| Snapshot SQL                     | `apps/runtime/src/modules/soft-ranking/score-distribution-snapshot.ts`            |
| Domain scorer                    | `packages/domain/src/scoring/logistic-scorer.ts`                                  |
| Domain feature builder           | `packages/domain/src/scoring/feature-builder.ts`                                  |
| Domain category derivation       | `packages/domain/src/category.ts`                                                 |
| DB schema (SoT)                  | `packages/db/src/schemas/ledger.sql` (markets.score* columns)                     |
| DB bootstrap upgrade             | `packages/db/src/bootstrap.ts:bootstrapLedgerDb` (`safeAddColumn` calls)          |
| DB migration (history record)    | `packages/db/src/migrations/043_markets_score_columns.sql`                        |
| Repository writer                | `packages/db/src/repositories/market-repository.ts:updateScoresBatch`             |
| API endpoint                     | `apps/api/src/routes/scanner.ts` (`GET /api/v1/scanner/score-distribution`)       |
| Python training                  | `research_plankton/soft_ranking_score_analysis.py`                                |

---

## 8. Glossary

- **Active universe** — `markets` rows with `active = 1`. Snapshot scope.
- **Step2-included** — `selection_status IN ('matched_include','step2_fallback_include')`.
- **Fresh score** — `features_captured_at >= now − 4h`. Stale-but-non-null
  scores remain on the row but do not outrank fresh lower scores in the
  JS comparator.
- **`step2IncludedNoScore`** — Step2-included rows currently lacking a
  score. Mixes three causes: row not yet in the data path, module
  disabled, or `buildFeatureRow` returned `null`. v1 does not persist a
  per-row skip reason; correlate via `markets.created_at` and
  `runtime_metrics.scoreModelVersion` to disambiguate.
- **`skippedNonStep2Included`** — active rows that fail the Step2
  filter. Excluded rows (`matched_exclude`, `fallback_exclude`) and
  `unknown` rows fall here.
