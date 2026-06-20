CREATE TABLE IF NOT EXISTS trading_calendar_exceptions (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('closed', 'early_close')),
  timezone TEXT NOT NULL,
  open_time_local TEXT,
  close_time_local TEXT,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  verification_status TEXT NOT NULL CHECK (
    verification_status IN ('verified_official', 'provisional')
  ),
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  notes TEXT,
  UNIQUE(calendar_id, date)
);

CREATE INDEX IF NOT EXISTS idx_trading_calendar_exceptions_calendar_date
  ON trading_calendar_exceptions(calendar_id, date);

CREATE TABLE IF NOT EXISTS trading_calendar_metadata (
  calendar_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  regular_open_time_local TEXT NOT NULL,
  regular_close_time_local TEXT NOT NULL,
  verified_through_date TEXT NOT NULL,
  provisional_through_date TEXT,
  source TEXT NOT NULL,
  source_url TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO trading_calendar_metadata (
  calendar_id,
  timezone,
  regular_open_time_local,
  regular_close_time_local,
  verified_through_date,
  provisional_through_date,
  source,
  source_url,
  updated_at
) VALUES (
  'US_EQUITY',
  'America/New_York',
  '09:30',
  '16:00',
  '2028-12-31',
  '2036-12-31',
  'NYSE official holidays/trading hours for 2026-2028; provisional rule-generated rows for 2025 and 2029-2036',
  'https://www.nyse.com/trade/hours-calendars',
  '2026-06-20T00:00:00.000Z'
);

INSERT OR IGNORE INTO trading_calendar_exceptions (
  id,
  calendar_id,
  date,
  status,
  timezone,
  open_time_local,
  close_time_local,
  reason,
  source,
  source_url,
  verification_status,
  verified_at,
  created_at,
  updated_at,
  updated_by,
  notes
) VALUES
  ('US_EQUITY-2026-01-01','US_EQUITY','2026-01-01','closed','America/New_York',NULL,NULL,'New Year''s Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-01-19','US_EQUITY','2026-01-19','closed','America/New_York',NULL,NULL,'Martin Luther King, Jr. Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-02-16','US_EQUITY','2026-02-16','closed','America/New_York',NULL,NULL,'Washington''s Birthday','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-04-03','US_EQUITY','2026-04-03','closed','America/New_York',NULL,NULL,'Good Friday','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-05-25','US_EQUITY','2026-05-25','closed','America/New_York',NULL,NULL,'Memorial Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-06-19','US_EQUITY','2026-06-19','closed','America/New_York',NULL,NULL,'Juneteenth National Independence Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-07-03','US_EQUITY','2026-07-03','closed','America/New_York',NULL,NULL,'Independence Day observed','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-09-07','US_EQUITY','2026-09-07','closed','America/New_York',NULL,NULL,'Labor Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-11-26','US_EQUITY','2026-11-26','closed','America/New_York',NULL,NULL,'Thanksgiving Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-11-27','US_EQUITY','2026-11-27','early_close','America/New_York','09:30','13:00','Thanksgiving early close','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-12-24','US_EQUITY','2026-12-24','early_close','America/New_York','09:30','13:00','Christmas Eve early close','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2026-12-25','US_EQUITY','2026-12-25','closed','America/New_York',NULL,NULL,'Christmas Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-01-01','US_EQUITY','2027-01-01','closed','America/New_York',NULL,NULL,'New Year''s Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-01-18','US_EQUITY','2027-01-18','closed','America/New_York',NULL,NULL,'Martin Luther King, Jr. Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-02-15','US_EQUITY','2027-02-15','closed','America/New_York',NULL,NULL,'Washington''s Birthday','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-03-26','US_EQUITY','2027-03-26','closed','America/New_York',NULL,NULL,'Good Friday','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-05-31','US_EQUITY','2027-05-31','closed','America/New_York',NULL,NULL,'Memorial Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-06-18','US_EQUITY','2027-06-18','closed','America/New_York',NULL,NULL,'Juneteenth National Independence Day observed','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-07-05','US_EQUITY','2027-07-05','closed','America/New_York',NULL,NULL,'Independence Day observed','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-09-06','US_EQUITY','2027-09-06','closed','America/New_York',NULL,NULL,'Labor Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-11-25','US_EQUITY','2027-11-25','closed','America/New_York',NULL,NULL,'Thanksgiving Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-11-26','US_EQUITY','2027-11-26','early_close','America/New_York','09:30','13:00','Thanksgiving early close','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2027-12-24','US_EQUITY','2027-12-24','closed','America/New_York',NULL,NULL,'Christmas Day observed','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-01-17','US_EQUITY','2028-01-17','closed','America/New_York',NULL,NULL,'Martin Luther King, Jr. Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075','NYSE notes no New Year''s Day holiday is observed in 2028 because Jan 1 falls on Saturday.'),
  ('US_EQUITY-2028-02-21','US_EQUITY','2028-02-21','closed','America/New_York',NULL,NULL,'Washington''s Birthday','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-04-14','US_EQUITY','2028-04-14','closed','America/New_York',NULL,NULL,'Good Friday','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-05-29','US_EQUITY','2028-05-29','closed','America/New_York',NULL,NULL,'Memorial Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-06-19','US_EQUITY','2028-06-19','closed','America/New_York',NULL,NULL,'Juneteenth National Independence Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-07-03','US_EQUITY','2028-07-03','early_close','America/New_York','09:30','13:00','Independence Day early close','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-07-04','US_EQUITY','2028-07-04','closed','America/New_York',NULL,NULL,'Independence Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-09-04','US_EQUITY','2028-09-04','closed','America/New_York',NULL,NULL,'Labor Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-11-23','US_EQUITY','2028-11-23','closed','America/New_York',NULL,NULL,'Thanksgiving Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-11-24','US_EQUITY','2028-11-24','early_close','America/New_York','09:30','13:00','Thanksgiving early close','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL),
  ('US_EQUITY-2028-12-25','US_EQUITY','2028-12-25','closed','America/New_York',NULL,NULL,'Christmas Day','NYSE official holidays and trading hours','https://www.nyse.com/trade/hours-calendars','verified_official','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','2026-06-20T00:00:00.000Z','migration_075',NULL);

WITH RECURSIVE years(y) AS (
  VALUES(2025)
  UNION ALL
  SELECT y + 1 FROM years WHERE y < 2036
),
provisional_years(y) AS (
  SELECT y FROM years WHERE y NOT BETWEEN 2026 AND 2028
),
closed_dates(date, reason) AS (
  SELECT CASE strftime('%w', printf('%04d-01-01', y))
      WHEN '0' THEN printf('%04d-01-02', y)
      WHEN '6' THEN NULL
      ELSE printf('%04d-01-01', y)
    END,
    'New Year''s Day'
    FROM provisional_years
  UNION ALL SELECT date(printf('%04d-01-01', y), 'weekday 1', '+14 days'), 'Martin Luther King, Jr. Day' FROM provisional_years
  UNION ALL SELECT date(printf('%04d-02-01', y), 'weekday 1', '+14 days'), 'Washington''s Birthday' FROM provisional_years
  UNION ALL SELECT date(printf('%04d-06-01', y), 'weekday 1', '-7 days'), 'Memorial Day' FROM provisional_years
  UNION ALL SELECT CASE strftime('%w', printf('%04d-06-19', y))
      WHEN '0' THEN printf('%04d-06-20', y)
      WHEN '6' THEN printf('%04d-06-18', y)
      ELSE printf('%04d-06-19', y)
    END,
    'Juneteenth National Independence Day'
    FROM provisional_years
  UNION ALL SELECT CASE strftime('%w', printf('%04d-07-04', y))
      WHEN '0' THEN printf('%04d-07-05', y)
      WHEN '6' THEN printf('%04d-07-03', y)
      ELSE printf('%04d-07-04', y)
    END,
    'Independence Day'
    FROM provisional_years
  UNION ALL SELECT date(printf('%04d-09-01', y), 'weekday 1'), 'Labor Day' FROM provisional_years
  UNION ALL SELECT date(printf('%04d-11-01', y), 'weekday 4', '+21 days'), 'Thanksgiving Day' FROM provisional_years
  UNION ALL SELECT CASE strftime('%w', printf('%04d-12-25', y))
      WHEN '0' THEN printf('%04d-12-26', y)
      WHEN '6' THEN printf('%04d-12-24', y)
      ELSE printf('%04d-12-25', y)
    END,
    'Christmas Day'
    FROM provisional_years
  UNION ALL SELECT '2025-04-18', 'Good Friday'
  UNION ALL SELECT '2029-03-30', 'Good Friday'
  UNION ALL SELECT '2030-04-19', 'Good Friday'
  UNION ALL SELECT '2031-04-11', 'Good Friday'
  UNION ALL SELECT '2032-03-26', 'Good Friday'
  UNION ALL SELECT '2033-04-15', 'Good Friday'
  UNION ALL SELECT '2034-04-07', 'Good Friday'
  UNION ALL SELECT '2035-03-23', 'Good Friday'
  UNION ALL SELECT '2036-04-11', 'Good Friday'
)
INSERT OR IGNORE INTO trading_calendar_exceptions (
  id, calendar_id, date, status, timezone, open_time_local, close_time_local, reason,
  source, source_url, verification_status, verified_at, created_at, updated_at, updated_by, notes
)
SELECT
  'US_EQUITY-' || date,
  'US_EQUITY',
  date,
  'closed',
  'America/New_York',
  NULL,
  NULL,
  reason,
  'Generated from US equity holiday rules; verify against official NYSE/Nasdaq calendar',
  'https://www.nyse.com/trade/hours-calendars',
  'provisional',
  NULL,
  '2026-06-20T00:00:00.000Z',
  '2026-06-20T00:00:00.000Z',
  'migration_075',
  'Provisional row: operator may patch this DB table when official calendars publish.'
FROM closed_dates
WHERE date IS NOT NULL;

WITH RECURSIVE years(y) AS (
  VALUES(2025)
  UNION ALL
  SELECT y + 1 FROM years WHERE y < 2036
),
provisional_years(y) AS (
  SELECT y FROM years WHERE y NOT BETWEEN 2026 AND 2028
),
early_dates(date, reason) AS (
  SELECT date(date(printf('%04d-11-01', y), 'weekday 4', '+21 days'), '+1 day'),
    'Thanksgiving early close'
    FROM provisional_years
  UNION ALL SELECT
    CASE strftime('%w', printf('%04d-07-04', y))
      WHEN '2' THEN printf('%04d-07-03', y)
      WHEN '3' THEN printf('%04d-07-03', y)
      WHEN '4' THEN printf('%04d-07-03', y)
      WHEN '5' THEN printf('%04d-07-03', y)
      ELSE NULL
    END,
    'Independence Day early close'
    FROM provisional_years
  UNION ALL SELECT
    CASE
      WHEN strftime('%w', printf('%04d-12-24', y)) IN ('1','2','3','4','5')
        THEN printf('%04d-12-24', y)
      ELSE NULL
    END,
    'Christmas Eve early close'
    FROM provisional_years
),
closed AS (
  SELECT date FROM trading_calendar_exceptions WHERE calendar_id = 'US_EQUITY' AND status = 'closed'
)
INSERT OR IGNORE INTO trading_calendar_exceptions (
  id, calendar_id, date, status, timezone, open_time_local, close_time_local, reason,
  source, source_url, verification_status, verified_at, created_at, updated_at, updated_by, notes
)
SELECT
  'US_EQUITY-' || date,
  'US_EQUITY',
  date,
  'early_close',
  'America/New_York',
  '09:30',
  '13:00',
  reason,
  'Generated from US equity early-close rules; verify against official NYSE/Nasdaq calendar',
  'https://www.nyse.com/trade/hours-calendars',
  'provisional',
  NULL,
  '2026-06-20T00:00:00.000Z',
  '2026-06-20T00:00:00.000Z',
  'migration_075',
  'Provisional row: operator may patch this DB table when official calendars publish.'
FROM early_dates
WHERE date IS NOT NULL AND date NOT IN (SELECT date FROM closed);
