-- Six ledger columns carry more than one timestamp rendering on the live ledger, so their lexical
-- order stopped being their chronological order: `' '` (0x20) sorts BELOW `'T'` (0x54), so within
-- one calendar day every SQLite-space row sorts under every ISO row. `MAX(updated_at)`,
-- `updated_at > ?` and `ORDER BY updated_at` then all read the wrong row — that is what stalled
-- the SSE order:filled / order:cancelled stream.
--
-- Nine UPDATEs follow, not six: the last three cover `orders.created_at`, `fills.filled_at` and
-- `positions.opened_at`, which are single-rendering on the LIVE ledger and match zero rows there.
-- They exist for the legacy `bootstrapDatabase` upgrade path — see the paragraph below the census.
--
-- Census on the live ledger, 2026-08-05, readonly:
--   orders.updated_at              38,448 ISO + 29,650 SQLite-space (19 ch), 2026-04-03 → 2026-08-05
--   positions.updated_at              173 SQLite-space (19 ch)
--   positions.closed_at               300 Gamma `+00` (22 ch) + 2 Gamma microsecond (29 ch)
--   market_resolutions.resolved_at    302 Gamma `+00` (22 ch) + 11 ISO-without-ms (20 ch)
--                                       + 2 Gamma microsecond (29 ch), 60 already canonical
--   settlement_ledger.settled_at      300 Gamma `+00` (22 ch) + 2 Gamma microsecond (29 ch),
--                                        64 already canonical
--   markets.updated_at (80,000-row sample, bounded — see below)
--                                      47 rows 19-char space, newest 2026-08-05 05:58:10 (writer
--                                        still active that day) + 79,953 already canonical
--
-- Every timestamp column identified above as reader-compared was measured and is normalized here.
-- A later audit (2026-08-05) found THREE MORE split columns this migration's first version had
-- missed — including `markets.updated_at` above — so "not listed here came back single-rendering"
-- was never a completed survey, only what had been checked so far; `operator_commands.created_at`/
-- `applied_at` (control DB) turned out split too and are normalized in
-- `migrations-control/071_normalize_operator_commands_timestamps.sql`. `markets.updated_at` itself
-- has NO comparative reader today — `market-repository.ts` carries a comment at its one candidate
-- read site explaining it is deliberately not used for tiering — but it is normalized anyway so its
-- correctness does not depend on that staying true; the same audit is what caught the other three
-- reader-compared columns being wrong, so "no reader today" is not a safe reason to leave a column
-- split.
--
-- Columns absent from the list above fall into two classes, and the distinction matters because
-- only one of them is a migration's business:
--   * SINGLE-RENDERING but SQLite-space, and compared. `risk_events.created_at` (50,000/50,000 at
--     19 ch) and `execution_policy_observations.created_at` (72,511/72,511) are space because no
--     INSERT binds them — `DEFAULT (datetime('now'))` is their sole writer. A column with ONE
--     rendering cannot mis-order itself: lexical order is chronological order. The defect was on
--     the BIND side — readers passing an ISO cutoff against a space column — and it is fixed in
--     code, not here: each reader now renders its bound value in the column's own format
--     (`toSqliteDateTime` from `@krabs/db`, or SQL `datetime(?)`). Rewriting 122k rows to ISO
--     would have been the wrong fix; nothing was wrong with the stored data.
--   * Canonical ISO already, measured: `runtime_metrics.captured_at`, `market_snapshots.captured_at`
--     (both bound explicitly as ISO by their writers — `market-snapshot-repository.ts` and
--     `runtime-metric-writer.ts` — NOT default-written, so they belong here and not in the
--     space-form class above), `decision_signal_log.signal_timestamp`,
--     `trading_state_snapshots.captured_at` (2,009), `portfolio_snapshots.captured_at` (24,063),
--     `maker_shadow_orders.updated_at`. Nothing to do.
--
-- `orders.created_at` (68,124/68,124), `fills.filled_at` (2,651/2,651) and `positions.opened_at`
-- (680/680) are canonical on the LIVE ledger too, and an earlier version of this migration left
-- them out on exactly that measurement. They are normalized anyway, because the census only
-- describes the split-ledger production DB: migration 029 recreates `orders`, `fills` and
-- `positions` and copies these columns VERBATIM (`INSERT INTO positions_new SELECT … opened_at,
-- closed_at, updated_at FROM positions`), so a DB upgraded through the legacy single-DB
-- `bootstrapDatabase` path carries whatever rendering `001_initial.sql`'s `DEFAULT (datetime('now'))`
-- wrote — and their readers compare raw: `positions.ts` paginates on
-- `ORDER BY opened_at DESC, position_id DESC` with a compound `sortValue::positionId` CURSOR (a
-- split column does not merely mis-sort there, it skips and repeats rows across pages),
-- `position-concentration-service.ts` takes `MIN(opened_at)` (which within one day returns the
-- space row no matter the clock), and `status.ts` counts `created_at >= ?` / `opened_at >= ?`
-- against an ISO bound (a same-day space row can never satisfy it). On production all three
-- UPDATEs match zero rows; the cost is one scan each at migration time.
--
-- `market_resolutions.resolved_at` is the SOURCE of the other three splits, not an independent one
-- — the 302/2 populations are the same rows. `RedeemSweepModule.closeLocalPositions` reads it and
-- hands it to `PositionSettler.settleOne`, which writes that one value into BOTH
-- `positions.closed_at` and `settlement_ledger.settled_at`. Normalizing only the sinks would
-- therefore re-split them on the first market that resolved BEFORE this deploy and settles AFTER
-- it: `MarketResolutionRepository.save` is `ON CONFLICT(condition_id) DO NOTHING`, so the fixed
-- Gamma ingress never rewrites a row that is already there. The 20-char ISO-without-ms shape
-- appears only in this column, and only as stored data — it is `resolvedAt = info.closedTime` from
-- a Gamma payload that carried no sub-second component.
--
-- `settlement_ledger.settled_at` is normalized even though no reader is wrong today, and the
-- distinction is worth recording so a future reader is not talked out of it: the one raw
-- comparison over it (`SqliteSettlementLedgerRepository.findAlgoRedeemSettlementsSince` —
-- `WHERE resolution = ? AND settled_at > ? ORDER BY settled_at DESC`) is confined to the
-- `algo-redeem` partition by its own predicate, and every row in that partition is canonical BY
-- CONSTRUCTION: `PositionSettler.settleAlgoRedeem` stamps `new Date().toISOString()`, never a Gamma
-- value. The 302 legacy rows all carry a market-outcome `resolution` and are filtered out before
-- the timestamp is ever compared. Leaving them split would make that safety an accident of one
-- WHERE clause — the next raw `settled_at > ?` reader without the partition filter would silently
-- under-select, exactly the defect this migration exists to remove.
--
-- The writers that produced the non-ISO rows are fixed in the SAME change set — without that this
-- migration would re-split within hours, since the newest space row (2026-08-05 08:53:21) was
-- NEWER than the newest ISO row: `SqliteOrderRepository.updateStatus`/`updateMetadata` and
-- `SqliteRedeemQuarantineRepository` now bind `nowIso()` instead of `datetime('now')`, and Gamma's
-- `closedTime` is normalized at the ingress by `toCanonicalIso` (`packages/domain/src/timestamp.ts`,
-- exported from `@krabs/domain`). Both INSERT paths bind
-- `updated_at` explicitly, so the legacy column DEFAULT that survives on the production table --
-- `schemas/ledger.sql` only builds a FRESH db, and SQLite has no `ALTER COLUMN … SET DEFAULT` --
-- is never reached. `markets.updated_at`'s two writers (`MarketRepository.deactivate` and the
-- one-off `scripts/fix-market-outcomes.ts`) are fixed the same way, for the same reason — no
-- comparative reader depends on it today, but an un-fixed writer would split the column again the
-- next time one did.
--
-- Three properties make the rewrite safe, each verified on the pinned better-sqlite3 (SQLite 3.51.3):
--   * `strftime` returns NULL for anything it cannot parse and the second WHERE term drops those
--     rows, so an unparseable value is left untouched rather than overwritten with NULL. Note the
--     guard is evaluated AFTER the blind `replace(col,'+00','')`, so it certifies "parses once the
--     Gamma suffix is stripped", not "was already a known rendering": a contrived
--     `…05:53:26+00+01:00` is unparseable raw yet migrates as `+01:00`. A readonly census of all
--     six columns on the live ledger (2026-08-05) found zero values outside the five measured
--     renderings, so no such row exists to migrate; the looseness is recorded rather than
--     tightened because a positive whitelist of four legacy GLOBs per UPDATE would cost six times
--     the SQL to guard a population that is empty.
--   * the output always matches the canonical GLOB and the first WHERE term excludes rows that
--     already do, so a second run selects nothing (idempotent) and canonical rows never move.
--   * a NULL `closed_at` is preserved: `NULL NOT GLOB '…'` is NULL, never true. (`resolved_at` is
--     declared NOT NULL, so it has no such rows — the same guard covers it at zero cost.)
-- The instant is preserved exactly for the 19-, 20- and 22-char shapes — SQLite accepts a trailing
-- `Z` as a timezone indicator, so the ISO-without-ms rows parse and only gain their `.000`. The two
-- 29-char microsecond rows round to milliseconds (`…28.075833+00` → `…28.076Z`), sub-millisecond.
--
-- `positions` carries three exit_owner triggers, but all are `BEFORE … OF exit_owner`, and SQLite
-- fires an `UPDATE OF` trigger only when the column is named in the SET clause — it is not here.

UPDATE orders
   SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(updated_at, '+00', ''))
 WHERE updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(updated_at, '+00', '')) IS NOT NULL;

UPDATE positions
   SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(updated_at, '+00', ''))
 WHERE updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(updated_at, '+00', '')) IS NOT NULL;

UPDATE positions
   SET closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(closed_at, '+00', ''))
 WHERE closed_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(closed_at, '+00', '')) IS NOT NULL;

UPDATE market_resolutions
   SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(resolved_at, '+00', ''))
 WHERE resolved_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(resolved_at, '+00', '')) IS NOT NULL;

UPDATE settlement_ledger
   SET settled_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(settled_at, '+00', ''))
 WHERE settled_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(settled_at, '+00', '')) IS NOT NULL;

UPDATE markets
   SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(updated_at, '+00', ''))
 WHERE updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(updated_at, '+00', '')) IS NOT NULL;

-- The three below match zero rows on the live ledger. They exist for the legacy `bootstrapDatabase`
-- upgrade path, where migration 029 copies these columns verbatim out of the pre-029 tables — see
-- the header.

UPDATE orders
   SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(created_at, '+00', ''))
 WHERE created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(created_at, '+00', '')) IS NOT NULL;

UPDATE fills
   SET filled_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(filled_at, '+00', ''))
 WHERE filled_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(filled_at, '+00', '')) IS NOT NULL;

UPDATE positions
   SET opened_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(opened_at, '+00', ''))
 WHERE opened_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(opened_at, '+00', '')) IS NOT NULL;
