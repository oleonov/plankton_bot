-- Step 3 (audit doc §D3): soft-ranking score columns + partial index.
SELECT safe_add_column('markets', 'score', 'REAL');
SELECT safe_add_column('markets', 'score_model_version', 'TEXT');
SELECT safe_add_column('markets', 'scored_at', 'TEXT');
SELECT safe_add_column('markets', 'features_captured_at', 'TEXT');

CREATE INDEX IF NOT EXISTS idx_markets_score ON markets(score) WHERE score IS NOT NULL;
