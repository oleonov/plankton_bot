-- Append-only audit trail for profile_settings mutations.
--
-- One row per (profile_id, field) change. before_value/after_value carry the
-- raw text payload as persisted in profile_settings — JSON strings for
-- envelope_json/risk_caps_json/relayer_json/execution_policy_json, stringified
-- numerics for initial_balance_usdc/min_order_usdc, raw string for wallet_mode.
-- NULL means the column was unset.
--
-- `source` discriminates entry-points so a future ops dashboard can highlight
-- direct SQL writes (source = 'manual') versus API-driven changes.
CREATE TABLE IF NOT EXISTS profile_settings_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id   TEXT NOT NULL REFERENCES profiles(profile_id),
  field        TEXT NOT NULL,
  before_value TEXT,
  after_value  TEXT,
  actor        TEXT NOT NULL,
  source       TEXT NOT NULL,
  reason       TEXT,
  changed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Defensive: never store non-positive ids. AUTOINCREMENT always assigns
  -- monotonically positive integers, so this rejects only explicit attempts
  -- to write a synthetic id like 0/-1 that could otherwise interact poorly
  -- with the no-replace BEFORE INSERT trigger below.
  CHECK (id > 0)
);

-- Compound indexes include `id DESC` so SQLite can satisfy the route's
-- `ORDER BY changed_at DESC, id DESC` tie-break without a temp b-tree sort.
CREATE INDEX IF NOT EXISTS idx_profile_settings_history_profile_ts
  ON profile_settings_history(profile_id, changed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_profile_settings_history_field_ts
  ON profile_settings_history(profile_id, field, changed_at DESC, id DESC);

-- Enforce append-only invariant at the schema layer. Recovery work that needs
-- to amend or remove a row must drop these triggers first and recreate them.
CREATE TRIGGER IF NOT EXISTS profile_settings_history_no_update
BEFORE UPDATE ON profile_settings_history
BEGIN
  SELECT RAISE(ABORT, 'profile_settings_history is append-only');
END;

CREATE TRIGGER IF NOT EXISTS profile_settings_history_no_delete
BEFORE DELETE ON profile_settings_history
BEGIN
  SELECT RAISE(ABORT, 'profile_settings_history is append-only');
END;

-- Schema-level guard against `INSERT OR REPLACE`: when the conflict-resolution
-- path silently deletes an existing row, the BEFORE DELETE trigger above is
-- skipped on connections that haven't set `PRAGMA recursive_triggers = ON`.
-- Reject any INSERT whose explicit `id` collides with an existing row so the
-- invariant holds regardless of per-connection pragmas. Normal INSERTs with
-- auto-incremented ids never collide, so this is a no-op on the hot path.
CREATE TRIGGER IF NOT EXISTS profile_settings_history_no_replace
BEFORE INSERT ON profile_settings_history
WHEN EXISTS (SELECT 1 FROM profile_settings_history WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'profile_settings_history is append-only');
END;
