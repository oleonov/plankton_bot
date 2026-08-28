-- 105_reconciliation_zero_return_pnl_backfill_20260828.sql
--
-- Repairs 21 exact positions that ReconciliationModule closed after their redeemed
-- wallet balances disappeared without routing the positions through PositionSettler.
-- The affected rows retained all inventory lots and booked neither settlement nor
-- realized P&L. A 2026-08-28 production-server audit matched every condition + held
-- token to a closed/resolved Gamma market with payout 0 and matched every condition
-- to a successful redeem_log row carrying a transaction hash.
--
-- Exact verified totals: 21 positions, 40 lots, 4,505.1765 shares, $44.763961 cost,
-- and therefore -$44.763961 settlement P&L.
--
-- The migration runner executes this file in one BEGIN IMMEDIATE transaction. The
-- eligibility snapshot is deliberately built before any write so marker insertion,
-- settlement, lot clearing, and position P&L all use the same forensic guards.

DROP TABLE IF EXISTS _reconciliation_backfill_105;
CREATE TEMP TABLE _reconciliation_backfill_105 (
  position_id  TEXT PRIMARY KEY,
  token_id     TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  invested_usd REAL NOT NULL,
  shares       REAL NOT NULL
);

INSERT INTO _reconciliation_backfill_105
  (position_id, token_id, condition_id, invested_usd, shares)
VALUES
  ('pos-38539668128569069835478639370767890108348737523231666617419226629008841766041-1782913490613', '38539668128569069835478639370767890108348737523231666617419226629008841766041', '0x9045ba87d887e476131d6ad4e35030af41af2b30d3a822804d5797fdb915bff0', 2.719740000000, 93.470000000000),
  ('pos-55755550502334994041937894354284511033377638067386779622124025061875258609751-1782919771532', '55755550502334994041937894354284511033377638067386779622124025061875258609751', '0xab0eacd8c3c38cf158b28e3d6bf997c96756084fd528106f9d2725473dedbbbf', 0.709020000000, 3.510000000000),
  ('pos-59656675465956401590729747476637504934965753695884881330296119128821790874333-1783184446442', '59656675465956401590729747476637504934965753695884881330296119128821790874333', '0x17590a28e61be9b10e36a2528579cbc2c79c31c4a45c757d471ba11ded6b84a1', 0.990000000000, 990.000000000000),
  ('pos-5777303815010562954448135034258943942277969729950227540840534526881769757367-1783275257505', '5777303815010562954448135034258943942277969729950227540840534526881769757367', '0x73d1c92f7b08ed44eda8fd55cca936bcc5610bc75e03f9658f651986a97c1b4a', 3.024345000000, 302.434500000000),
  ('pos-84468218186345543861890317786435833990826543429526710502350973396644451929524-1783279656003', '84468218186345543861890317786435833990826543429526710502350973396644451929524', '0x805313d9128d7cb404b5504034baf3c688eb77d22085c7fc82166c83eb2a402c', 3.108710000000, 536.500000000000),
  ('pos-79667397729638462803901061396639921758908063024169338722615181346418821181968-1783275829216', '79667397729638462803901061396639921758908063024169338722615181346418821181968', '0xddf69c60ebfc290098808cfb3075d328144c35a3ac9972f38d789aa2cd5ea6b5', 2.310000000000, 577.500000000000),
  ('pos-40061706255869747632303223293656104479201110845197642951934190521166081913604-1783959833681', '40061706255869747632303223293656104479201110845197642951934190521166081913604', '0xda77b0cbaae44916e756e4e9c216d082e5c1ca12d92294a2fa9ee963be3303c8', 0.989360000000, 11.920000000000),
  ('pos-3087359805894191000367365898266478564950039046406509509824167786931015278444-1784490569201', '3087359805894191000367365898266478564950039046406509509824167786931015278444', '0xd8f049adda6efd8becc699e49bfdf15529a78167f56770ecc55a617ba3f5bc21', 1.485786000000, 495.262000000000),
  ('pos-114105681736902803949342787091789710436412816922634293834551848268869151276996-1784579600385', '114105681736902803949342787091789710436412816922634293834551848268869151276996', '0x32dc39b905c5b0ec51d2e320aba6f7e77229a411eb4c806ea2864abfc7a3a194', 1.600000000000, 20.000000000000),
  ('pos-19635529290686822752587228753253697947536505769289222876770655100012682432790-1784395523026', '19635529290686822752587228753253697947536505769289222876770655100012682432790', '0x6a9afa1f367fbdbb37ba016d1bc0453c8c21ca018e4542f0bb7f69671872c897', 0.480000000000, 4.000000000000),
  ('pos-2429591512115745706423629467276762927321729527265432739104265797522843401579-1784787545109', '2429591512115745706423629467276762927321729527265432739104265797522843401579', '0x527610f2760d00ccc230e50414ac3dd3343fefab3b17165827fb66bc43398cba', 0.989760000000, 20.620000000000),
  ('pos-106517619947935790907301803460047700715947012137076325620595241601479476041130-1784731637494', '106517619947935790907301803460047700715947012137076325620595241601479476041130', '0xa306ca06eab29ff0550334a7e7e32ffd76118af994be163dd6bc6d2816158b36', 0.950000000000, 50.000000000000),
  ('pos-81649997900573640209948175691433747182877427992349309387846515510366896741524-1783609615472', '81649997900573640209948175691433747182877427992349309387846515510366896741524', '0x7264a7a700634b753fdd00567be2ad6388eccddd2219a7a1720d941f00f8160a', 0.989100000000, 7.850000000000),
  ('pos-56934461782297133588318448311538513943627963321141470878426494698040133789709-1784265892963', '56934461782297133588318448311538513943627963321141470878426494698040133789709', '0xac002358aaf45f805b69f28a640d0dd67f5207541131c1900b6681d9c0868ebb', 0.989550000000, 7.330000000000),
  ('pos-92884769434992938715559925656439132319252799140712672860278557982561603907701-1783020919106', '92884769434992938715559925656439132319252799140712672860278557982561603907701', '0xcfa5b3d9e618d3f7dbda457b95af3b45d23e53d5b90b7474638769d0003a30bf', 4.999500000000, 15.150000000000),
  ('pos-107977848904845034758099014627969436500380843133920684693288383318842608201934-1785677742146', '107977848904845034758099014627969436500380843133920684693288383318842608201934', '0x892320eea18580badec0e44274e5fb5838adf50a3ec79e4a9a6e16ff045949f2', 0.990000000000, 990.000000000000),
  ('pos-46385151226493697829854313078476800178385492249013599336965213315855502519412-1787294658057', '46385151226493697829854313078476800178385492249013599336965213315855502519412', '0xc8a0146f1868946501ba99ae74bbf6d2e974c47025d77896b39b4892025934a3', 3.400000000000, 20.000000000000),
  ('pos-4338951053310889984880548867580853884982915977392097980795562286098624663466-1787299704259', '4338951053310889984880548867580853884982915977392097980795562286098624663466', '0x3b0a99159a31a5a572499c9a26ff17a6e8838e8ea30c9d04fcd51fcf5974414d', 1.240000000000, 20.000000000000),
  ('pos-103417228643284605225980118222657775890797274380965374393593489029290863219839-1787299730995', '103417228643284605225980118222657775890797274380965374393593489029290863219839', '0x7e2122d54359f590e9ffdf59092f8e052f5f718181188fef5534e62402f0bab3', 2.160000000000, 20.000000000000),
  ('pos-69474265591375903712897939745283446550244222532596828417175212058943879934386-1778312847291', '69474265591375903712897939745283446550244222532596828417175212058943879934386', '0xfa928bde6b984b65611fd3a9fde594ae7daafc38572121f6dcc4ac4aaba03df8', 8.609230000000, 174.640000000000),
  ('pos-32000787824422574139554883823896949129925736605885876586681458552574037099932-1787224940195', '32000787824422574139554883823896949129925736605885876586681458552574037099932', '0x032bea9bdb1cc6b3456b5f6b4589d600eda00fea105e9f028acd169fbd1aaf74', 2.029860000000, 144.990000000000);

DROP TABLE IF EXISTS _reconciliation_backfill_105_eligible;
CREATE TEMP TABLE _reconciliation_backfill_105_eligible (
  position_id  TEXT PRIMARY KEY,
  token_id     TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  invested_usd REAL NOT NULL,
  shares       REAL NOT NULL,
  closed_at    TEXT NOT NULL
);

INSERT INTO _reconciliation_backfill_105_eligible
  (position_id, token_id, condition_id, invested_usd, shares, closed_at)
SELECT
  a.position_id,
  a.token_id,
  a.condition_id,
  a.invested_usd,
  a.shares,
  p.closed_at
FROM _reconciliation_backfill_105 a
JOIN positions p ON p.position_id = a.position_id
WHERE p.token_id = a.token_id
  AND p.condition_id = a.condition_id
  AND p.status = 'closed'
  AND abs(p.size) < 0.000001
  AND abs(p.realized_pnl) < 0.000001
  AND p.current_value_usdc IS NOT NULL
  AND p.current_value_usdc = 0.0
  AND p.cost_basis_usdc > 0.01
  AND abs(p.cost_basis_usdc - a.invested_usd) < 0.00001
  AND p.closed_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM pnl_ledger pl WHERE pl.position_id = a.position_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM settlement_ledger sl WHERE sl.position_id = a.position_id
  )
  AND EXISTS (
    SELECT 1
    FROM redeem_log rl,
         json_each(CASE WHEN json_valid(rl.token_ids) THEN rl.token_ids ELSE '[]' END) token
    WHERE rl.condition_id = a.condition_id
      AND rl.status = 'success'
      AND rl.tx_hash IS NOT NULL
      AND length(trim(rl.tx_hash)) > 0
      AND CAST(token.value AS TEXT) = a.token_id
  )
  AND EXISTS (
    SELECT 1
    FROM inventory_lots il
    WHERE il.position_id = a.position_id
      AND il.token_id = a.token_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM inventory_lots il
    WHERE il.position_id = a.position_id
      AND il.token_id <> a.token_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM inventory_lots il
    WHERE il.position_id = a.position_id
      AND abs(il.remaining_size - il.size) >= 0.000001
  )
  AND abs(
    COALESCE(
      (SELECT SUM(il.size) FROM inventory_lots il WHERE il.position_id = a.position_id),
      0
    ) - a.shares
  ) < 0.000001
  AND abs(
    COALESCE(
      (SELECT SUM(il.remaining_size) FROM inventory_lots il
        WHERE il.position_id = a.position_id),
      0
    ) - a.shares
  ) < 0.000001
  AND abs(
    COALESCE(
      (SELECT SUM(il.cost_usdc) FROM inventory_lots il WHERE il.position_id = a.position_id),
      0
    ) - a.invested_usd
  ) < 0.00001;

-- Step 1: seed the FK parent only for rows that passed every forensic guard.
INSERT INTO market_resolutions
  (condition_id, resolution, resolved_at, detected_at, source, status)
SELECT
  e.condition_id,
  'redeem-zero-return',
  e.closed_at,
  e.closed_at,
  'reconciliation-backfill',
  'settled'
FROM _reconciliation_backfill_105_eligible e
WHERE NOT EXISTS (
  SELECT 1 FROM market_resolutions mr WHERE mr.condition_id = e.condition_id
);

-- Step 2: book the verified zero-payout settlement before clearing inventory.
INSERT INTO settlement_ledger
  (settlement_id, condition_id, position_id, token_id,
   resolution, settlement_price, size, delta, settled_at)
SELECT
  'reconciliation-backfill-105-' || e.token_id,
  e.condition_id,
  e.position_id,
  e.token_id,
  'redeem-zero-return',
  0.0,
  e.shares,
  -e.invested_usd,
  e.closed_at
FROM _reconciliation_backfill_105_eligible e
WHERE EXISTS (
    SELECT 1 FROM market_resolutions mr WHERE mr.condition_id = e.condition_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM settlement_ledger sl WHERE sl.position_id = e.position_id
  );

-- Step 3: settle the still-open lots only after the exact settlement row exists.
UPDATE inventory_lots
SET remaining_size = 0
WHERE EXISTS (
  SELECT 1
  FROM _reconciliation_backfill_105_eligible e
  JOIN settlement_ledger sl
    ON sl.settlement_id = 'reconciliation-backfill-105-' || e.token_id
   AND sl.position_id = e.position_id
   AND sl.condition_id = e.condition_id
   AND sl.token_id = e.token_id
  WHERE e.position_id = inventory_lots.position_id
    AND e.token_id = inventory_lots.token_id
    AND abs(sl.settlement_price) < 0.000001
    AND abs(sl.size - e.shares) < 0.000001
    AND abs(sl.delta + e.invested_usd) < 0.00001
);

-- Step 4: mirror the booked loss only after every expected lot is settled.
UPDATE positions
SET realized_pnl = -(
      SELECT e.invested_usd
      FROM _reconciliation_backfill_105_eligible e
      WHERE e.position_id = positions.position_id
    )
WHERE position_id IN (
    SELECT position_id FROM _reconciliation_backfill_105_eligible
  )
  AND status = 'closed'
  AND abs(size) < 0.000001
  AND abs(realized_pnl) < 0.000001
  AND NOT EXISTS (
    SELECT 1
    FROM inventory_lots il
    WHERE il.position_id = positions.position_id
      AND abs(il.remaining_size) >= 0.000001
  )
  AND EXISTS (
    SELECT 1
    FROM _reconciliation_backfill_105_eligible e
    JOIN settlement_ledger sl
      ON sl.settlement_id = 'reconciliation-backfill-105-' || e.token_id
     AND sl.position_id = e.position_id
     AND sl.condition_id = e.condition_id
     AND sl.token_id = e.token_id
    WHERE e.position_id = positions.position_id
      AND abs(sl.settlement_price) < 0.000001
      AND abs(sl.size - e.shares) < 0.000001
      AND abs(sl.delta + e.invested_usd) < 0.00001
  );

DROP TABLE IF EXISTS _reconciliation_backfill_105_eligible;
DROP TABLE IF EXISTS _reconciliation_backfill_105;
