-- Target DB:
--   /var/lib/docker/volumes/plankton-data/_data/control.db
--
-- Intent:
--   Align curated bot families to the 3-tier max_entry_price policy:
--     G1 Aggressive -> 0.50
--     G2 Standard   -> 0.35
--     G3 Micro      -> 0.20
--
-- Important:
--   1. This script only touches the curated families from config/family_rules.yaml.
--      It does NOT retune the many discovered/imported families currently sitting at 1.0.
--   2. We update the coupled entry gates too:
--        max_entry_price
--        high_price_threshold
--        require_proven_family_above_price
--        preferred_entry_band
--      Raising max_entry_price alone would leave part of the new band unusable.
--   3. If runtime is restarted as part of deploy, the rules_reload command is optional.

-- Pre-check: current values for the curated families.
SELECT
  family_id,
  action,
  max_entry_price,
  high_price_threshold,
  require_proven_family_above_price,
  preferred_entry_band
FROM family_rules
WHERE family_id IN (
  'who-will-be-next-supreme-leader-of-iran:succession:ad-hoc',
  'bitcoin-price:generic:daily',
  'us-next-strikes-iran-on:geopolitics:ad-hoc',
  'btc-updown-4h:directional-updown:intraday-4h',
  'will-israel-strike-lebanon-on:geopolitics:ad-hoc',
  'will-crude-oil-cl-hit-by-end-of-march:generic:deadline',
  'bitcoin-above:threshold:daily',
  'ethereum-price:generic:daily',
  'will-bitcoin-reach:threshold:intraday-4h',
  'will-ethereum-reach:threshold:intraday-4h',
  'will-israel-strike-gaza-on:geopolitics:ad-hoc',
  'march-inflation-us-annual:generic:deadline',
  'will-iran-name-a-successor-to-khamenei-by:succession:daily',
  'donald-trump-of-truth-social-posts:social-activity:ad-hoc',
  'highest-temperature-in-london:price-range:daily',
  'highest-temperature-in-seoul:price-range:daily',
  'highest-temperature-in-nyc:price-range:daily',
  'elon-musk-of-tweets:social-activity:weekly-window'
)
ORDER BY family_id;

BEGIN IMMEDIATE;

-- G1 Aggressive: geopolitics + social/event-driven ad-hoc families.
UPDATE family_rules
SET
  max_entry_price = 0.50,
  high_price_threshold = 0.50,
  require_proven_family_above_price = 0.50,
  preferred_entry_band = '0.02-0.50',
  updated_at = datetime('now')
WHERE family_id IN (
  'who-will-be-next-supreme-leader-of-iran:succession:ad-hoc',
  'us-next-strikes-iran-on:geopolitics:ad-hoc',
  'will-israel-strike-lebanon-on:geopolitics:ad-hoc',
  'will-israel-strike-gaza-on:geopolitics:ad-hoc',
  'will-iran-name-a-successor-to-khamenei-by:succession:daily',
  'donald-trump-of-truth-social-posts:social-activity:ad-hoc',
  'elon-musk-of-tweets:social-activity:weekly-window'
);

-- G2 Standard: BTC/ETH + macro/commodity families.
UPDATE family_rules
SET
  max_entry_price = 0.35,
  high_price_threshold = 0.35,
  require_proven_family_above_price = 0.35,
  preferred_entry_band = '0.05-0.35',
  updated_at = datetime('now')
WHERE family_id IN (
  'bitcoin-price:generic:daily',
  'bitcoin-above:threshold:daily',
  'btc-updown-4h:directional-updown:intraday-4h',
  'ethereum-price:generic:daily',
  'will-bitcoin-reach:threshold:intraday-4h',
  'will-ethereum-reach:threshold:intraday-4h',
  'march-inflation-us-annual:generic:deadline',
  'will-crude-oil-cl-hit-by-end-of-march:generic:deadline'
);

-- G3 Micro: weather canaries.
UPDATE family_rules
SET
  max_entry_price = 0.20,
  high_price_threshold = 0.20,
  require_proven_family_above_price = 0.20,
  preferred_entry_band = CASE family_id
    WHEN 'highest-temperature-in-london:price-range:daily' THEN '0.05-0.20'
    ELSE '0.03-0.20'
  END,
  updated_at = datetime('now')
WHERE family_id IN (
  'highest-temperature-in-london:price-range:daily',
  'highest-temperature-in-seoul:price-range:daily',
  'highest-temperature-in-nyc:price-range:daily'
);

-- If runtime is staying up, enqueue a hot rules reload.
INSERT INTO operator_commands (
  action,
  reason,
  scope,
  initiator_type,
  initiator,
  status,
  created_at,
  applied_at
) VALUES (
  'rules_reload',
  'max_entry_price tier retune',
  'global',
  'operator',
  'manual-sql',
  'pending',
  datetime('now'),
  NULL
);

COMMIT;

-- Post-check: verify the new values.
SELECT
  family_id,
  action,
  max_entry_price,
  high_price_threshold,
  require_proven_family_above_price,
  preferred_entry_band
FROM family_rules
WHERE family_id IN (
  'who-will-be-next-supreme-leader-of-iran:succession:ad-hoc',
  'bitcoin-price:generic:daily',
  'us-next-strikes-iran-on:geopolitics:ad-hoc',
  'btc-updown-4h:directional-updown:intraday-4h',
  'will-israel-strike-lebanon-on:geopolitics:ad-hoc',
  'will-crude-oil-cl-hit-by-end-of-march:generic:deadline',
  'bitcoin-above:threshold:daily',
  'ethereum-price:generic:daily',
  'will-bitcoin-reach:threshold:intraday-4h',
  'will-ethereum-reach:threshold:intraday-4h',
  'will-israel-strike-gaza-on:geopolitics:ad-hoc',
  'march-inflation-us-annual:generic:deadline',
  'will-iran-name-a-successor-to-khamenei-by:succession:daily',
  'donald-trump-of-truth-social-posts:social-activity:ad-hoc',
  'highest-temperature-in-london:price-range:daily',
  'highest-temperature-in-seoul:price-range:daily',
  'highest-temperature-in-nyc:price-range:daily',
  'elon-musk-of-tweets:social-activity:weekly-window'
)
ORDER BY family_id;

-- Optional blast-radius check:
-- SELECT max_entry_price, COUNT(*) AS family_count
-- FROM family_rules
-- WHERE enabled = 1 AND action = 'trade'
-- GROUP BY max_entry_price
-- ORDER BY max_entry_price;
