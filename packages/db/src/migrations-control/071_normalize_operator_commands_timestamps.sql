-- `operator_commands.created_at`/`applied_at` carry the same split-rendering defect migration
-- 095 (ledger `packages/db/src/migrations/`) fixes for five LEDGER columns: SQLite compares TEXT
-- lexically and `' '` (0x20) sorts BELOW `'T'` (0x54), so within one calendar day every
-- SQLite-space row sorts under every ISO row of the same day. An audit after 095 shipped found
-- this control-DB table was missed — measured on the live control DB, 2026-08-05, readonly:
--
--   created_at: 14 rows 19-char space  (`2026-03-30 16:46:31` … `2026-04-26 14:34:11`)
--                 2 rows 20-char ISO-no-ms (`2026-04-13T07:47:39Z` … `2026-04-13T07:48:24Z`)
--               482 rows 24-char canonical (`2026-03-30T16:38:38.141Z` … `2026-08-05T05:47:52.782Z`)
--   applied_at:   5 rows 19-char space (all 2026-04-26), status = 'applied'
--               493 rows 24-char canonical
--   (498 rows total.)
--
-- Both columns are read comparatively, so this is a live defect, not hygiene:
--   * `SqliteOperatorCommandRepository.getPending` —
--     `SELECT * FROM operator_commands WHERE status = 'pending' ORDER BY created_at ASC` is the
--     command poller's execution order for operator pause/resume commands. A space-form row
--     sorts BEFORE every same-day ISO row regardless of clock time, so commands can apply OUT OF
--     ORDER — a LATER space-form `pause` runs before an EARLIER ISO `resume`, so the resume lands
--     last and leaves a live trading bot running when the operator's most recent intent was pause.
--     (The mirror case — a later space-form `resume` before an earlier ISO `pause` — ends paused,
--     i.e. fail-safe. Only the direction spelled out above loses money.)
--   * `apps/api/src/routes/events.ts` —
--     `SELECT MAX(applied_at) as ts FROM operator_commands WHERE status = 'applied'` is the SSE
--     `statusHash` change-detection key — the SAME mechanism whose failure on `orders.updated_at`
--     motivated migration 095. A space-form `applied_at` is invisible to `MAX()` whenever a
--     same-day ISO row also exists, so the `status` SSE event can silently never fire.
--
-- The writers that produced the non-canonical rows are fixed in the SAME change set, so this
-- migration cannot re-split within hours the way 095's ledger columns would have without their
-- writer fix: `apps/api/src/routes/runtime-policy.ts` and
-- `apps/runtime-manager/src/switch-driver.ts` now bind `nowIso()` instead of literal
-- `datetime('now')` for these two columns.
--
-- `applied_at` is nullable (a 'pending' command has no applied_at yet) — `NULL NOT GLOB '…'` is
-- NULL, never true, so the guard leaves those rows untouched exactly as migration 095's
-- `closed_at` paragraph explains for the ledger's nullable column.
--
-- Same rewrite shape as 095, verbatim: `strftime` returns NULL for anything it cannot parse (the
-- second WHERE term drops those rows rather than nulling a real value), the output always
-- matches the canonical GLOB (so a second run selects nothing — idempotent), and the `+00`
-- Gamma-offset strip is a no-op here since no operator_commands row carries that rendering.

UPDATE operator_commands
   SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(created_at, '+00', ''))
 WHERE created_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(created_at, '+00', '')) IS NOT NULL;

UPDATE operator_commands
   SET applied_at = strftime('%Y-%m-%dT%H:%M:%fZ', replace(applied_at, '+00', ''))
 WHERE applied_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
   AND strftime('%Y-%m-%dT%H:%M:%fZ', replace(applied_at, '+00', '')) IS NOT NULL;
