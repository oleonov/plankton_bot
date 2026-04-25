CREATE INDEX IF NOT EXISTS idx_market_snapshots_captured_at
  ON market_snapshots(captured_at);

CREATE INDEX IF NOT EXISTS idx_runtime_metrics_captured_at
  ON runtime_metrics(captured_at);

CREATE INDEX IF NOT EXISTS idx_execution_policy_observations_created_at
  ON execution_policy_observations(created_at);

CREATE INDEX IF NOT EXISTS idx_risk_events_created_at
  ON risk_events(created_at);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_captured_at
  ON portfolio_snapshots(captured_at);
