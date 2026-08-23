CREATE TABLE IF NOT EXISTS bounce_ask_capture_reprice_intents (
  intent_id             TEXT PRIMARY KEY,
  predecessor_order_id  TEXT NOT NULL UNIQUE,
  lifecycle_signal_id   TEXT NOT NULL UNIQUE,
  root_order_id         TEXT NOT NULL,
  position_id           TEXT NOT NULL,
  token_id              TEXT NOT NULL,
  condition_id          TEXT NOT NULL,
  replacement_index     INTEGER NOT NULL CHECK (replacement_index BETWEEN 1 AND 5),
  status                TEXT NOT NULL CHECK (
    status IN ('cancel_pending', 'ready', 'submitted', 'completed', 'failed', 'dust')
  ),
  candidate_price       REAL,
  replacement_size      REAL,
  child_order_id        TEXT UNIQUE,
  failure               TEXT,
  proof_json            TEXT NOT NULL CHECK (json_valid(proof_json)),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bounce_ask_capture_reprice_intents_status
  ON bounce_ask_capture_reprice_intents(status);
CREATE INDEX IF NOT EXISTS idx_bounce_ask_capture_reprice_intents_root
  ON bounce_ask_capture_reprice_intents(root_order_id, replacement_index);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bounce_ask_capture_one_nonterminal_per_position
  ON bounce_ask_capture_reprice_intents(position_id)
  WHERE status IN ('cancel_pending', 'ready', 'submitted');
