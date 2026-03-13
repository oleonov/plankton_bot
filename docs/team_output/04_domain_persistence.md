# 04 Domain & Persistence Design

Generated: 2026-03-13

This document defines the complete domain type catalog, repository interfaces, SQLite schema, and family rules loading pipeline for poly_plankton v1.

---

## 1. Enum Definitions

```typescript
// packages/domain/src/enums.ts

export const Regime = {
  Threshold: "threshold",
  PriceRange: "price-range",
  DirectionalUpdown: "directional-updown",
  SocialActivity: "social-activity",
  Geopolitics: "geopolitics",
  Generic: "generic",
  Tournament: "tournament",
  WeatherRange: "weather-range",
} as const;
export type Regime = (typeof Regime)[keyof typeof Regime];

export const StrategyProfile = {
  Scalp: "scalp",
  EventDriven: "event-driven",
  InventoryRecycle: "inventory-recycle",
  OptionalProbe: "optional-probe",
  Restricted: "restricted",
} as const;
export type StrategyProfile = (typeof StrategyProfile)[keyof typeof StrategyProfile];

export const EvidenceStatus = {
  Confirmed: "confirmed",
  Partial: "partial",
  Weak: "weak",
  Unknown: "unknown",
} as const;
export type EvidenceStatus = (typeof EvidenceStatus)[keyof typeof EvidenceStatus];

export const PromotionState = {
  ProbeOnly: "probe-only",
  Scaled: "scaled",
  Restricted: "restricted",
  ReduceOnly: "reduce-only",
  Quarantine: "quarantine",
} as const;
export type PromotionState = (typeof PromotionState)[keyof typeof PromotionState];

export const Action = {
  Trade: "trade",
  Monitor: "monitor",
  ReduceOnly: "reduce-only",
  Blocked: "blocked",
} as const;
export type Action = (typeof Action)[keyof typeof Action];

export const RuntimeMode = {
  Active: "active",
  ProbeOnly: "probe-only",
  Restricted: "restricted",
  Quarantine: "quarantine",
  ReduceOnly: "reduce-only",
} as const;
export type RuntimeMode = (typeof RuntimeMode)[keyof typeof RuntimeMode];

export const EntryMode = {
  ProbeFirst: "probe-first",
  ConvictionOnly: "conviction-only",
  Disabled: "disabled",
} as const;
export type EntryMode = (typeof EntryMode)[keyof typeof EntryMode];

export const ExitMode = {
  RepricingSell: "repricing-sell",
  ReduceOnly: "reduce-only",
  Disabled: "disabled",
} as const;
export type ExitMode = (typeof ExitMode)[keyof typeof ExitMode];

export const ScaleMode = {
  ConfirmOnly: "confirm-only",
  Disabled: "disabled",
  AggressiveConfirm: "aggressive-confirm",
} as const;
export type ScaleMode = (typeof ScaleMode)[keyof typeof ScaleMode];

export const SessionMode = {
  ActiveWindow: "active-window",
  Reduced: "reduced",
  AlwaysReduced: "always-reduced",
} as const;
export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode];

export const TwoSidedMode = {
  Disabled: "disabled",
  Selective: "selective",
  Active: "active",
} as const;
export type TwoSidedMode = (typeof TwoSidedMode)[keyof typeof TwoSidedMode];

export const WeekendMode = {
  Normal: "normal",
  Reduced: "reduced",
  Disabled: "disabled",
} as const;
export type WeekendMode = (typeof WeekendMode)[keyof typeof WeekendMode];

export const WeekdayBias = {
  Normal: "normal",
  Preferred: "preferred",
  Required: "required",
} as const;
export type WeekdayBias = (typeof WeekdayBias)[keyof typeof WeekdayBias];

export const ProfitModel = {
  SellIntoStrength: "sell-into-strength",
} as const;
export type ProfitModel = (typeof ProfitModel)[keyof typeof ProfitModel];

export const OrderSide = {
  Buy: "buy",
  Sell: "sell",
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderStatus = {
  Pending: "pending",
  Open: "open",
  PartiallyFilled: "partially-filled",
  Filled: "filled",
  Cancelled: "cancelled",
  Rejected: "rejected",
  Expired: "expired",
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const PositionStatus = {
  Open: "open",
  Closed: "closed",
  Dust: "dust",
} as const;
export type PositionStatus = (typeof PositionStatus)[keyof typeof PositionStatus];
```

---

## 2. Domain Type Catalog

```typescript
// packages/domain/src/types.ts

// ─── Branded ID types ───

export type FamilyId = string & { readonly __brand: "FamilyId" };
// Format: "<family_key>:<regime>:<horizon>"

export type MarketId = string & { readonly __brand: "MarketId" };
export type OrderId = string & { readonly __brand: "OrderId" };
export type FillId = string & { readonly __brand: "FillId" };
export type PositionId = string & { readonly __brand: "PositionId" };
export type BotRunId = string & { readonly __brand: "BotRunId" };

// ─── Market ───

export interface Market {
  market_id: MarketId;
  condition_id: string;
  slug: string;
  question: string;
  family_id: FamilyId | null;
  family_key: string | null;
  regime: Regime | null;
  outcome: string; // "Yes" | "No"
  end_date: string | null; // ISO timestamp
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface MarketSnapshot {
  market_id: MarketId;
  best_bid: number | null;
  best_ask: number | null;
  last_price: number | null;
  volume_24h: number | null;
  liquidity: number | null;
  captured_at: string; // ISO timestamp
}

// ─── Time Window ───

export interface TimeWindow {
  start: string; // "HH:MM" UTC
  end: string; // "HH:MM" UTC
}

// ─── Family Identity ───

export interface FamilyIdentity {
  family_id: FamilyId;
  family_key: string;
  primary_category: string;
  regime: Regime;
  horizon: string;
  cadence: string;
  strategy_profile: StrategyProfile;
  topic_key: string | null;
  slug_pattern: string | null;
  notes: string | null;
}

// ─── Family Evidence ───

export interface FamilyEvidence {
  family_id: FamilyId;
  evidence_status: EvidenceStatus;
  evidence_score: number;
  promotion_state: PromotionState;
  local_trade_count: number;
  local_market_count: number;
  local_realized_pnl_fifo: number;
  open_tail_cost_usdc: number;
  tail_adjusted_pnl: number;
  remote_closed_realized_pnl: number | null;
  open_position_count: number | null;
  open_dust_count: number | null;
  both_sided_eligible: boolean;
  heavy_campaign_eligible: boolean;
  active_window_edge_score: number | null;
  last_validated_at: string | null;
}

// ─── Family Rules (composed of sub-blocks) ───

export interface UniverseRules {
  enabled: boolean;
  action: Action;
  priority_rank: number;
  allow_weekends: boolean;
  session_mode: SessionMode;
}

export interface EntryRules {
  entry_mode: EntryMode;
  min_entry_price: number;
  max_entry_price: number;
  max_initial_notional_usdc: number;
  allow_high_price_one_shot: boolean;
  high_price_threshold: number;
  require_proven_family_above_price: number;
  preferred_entry_band: string | null;
  max_probe_count_per_market: number | null;
  entry_cooldown_seconds: number | null;
  max_new_markets_per_session: number | null;
}

export interface ScaleInRules {
  scale_mode: ScaleMode;
  default_max_buys_per_leg: number;
  heavy_max_buys_per_leg: number;
  allow_heavy_campaigns: boolean;
  require_positive_recycle_history_for_scale: boolean;
}

export interface ExitRules {
  exit_mode: ExitMode;
  primary_profit_model: ProfitModel;
  allow_runner_extension: boolean;
  prefer_fast_recycle: boolean;
  resolution_holding_allowed: boolean;
  target_roi_band_low: number | null;
  target_roi_band_high: number | null;
  max_unmoved_hold_hours: number | null;
  max_tail_hold_hours: number | null;
}

export interface TwoSidedRules {
  allow_two_sided: boolean;
  two_sided_mode: TwoSidedMode;
  min_activity_for_two_sided: number | null;
}

export interface TailSuppressionRules {
  max_open_value_usdc: number;
  max_active_markets: number;
  max_dust_positions: number;
  tail_quarantine_threshold_usdc: number;
  tail_quarantine_threshold_ratio: number;
  stale_tail_prune_enabled: boolean;
  threshold_cleanup_required: boolean;
}

export interface SessionRules {
  active_windows_utc: TimeWindow[];
  reduced_windows_utc: TimeWindow[];
  weekday_bias: WeekdayBias;
  weekend_mode: WeekendMode;
}

export interface FamilyRules {
  family_id: FamilyId;
  universe: UniverseRules;
  entry: EntryRules;
  scale_in: ScaleInRules;
  exit: ExitRules;
  two_sided: TwoSidedRules;
  tail_suppression: TailSuppressionRules;
  session: SessionRules;
}

// ─── Family Rule (complete loaded config) ───

export interface FamilyRule {
  identity: FamilyIdentity;
  evidence: FamilyEvidence;
  rules: FamilyRules;
}

// ─── Family Runtime State ───

export interface FamilyState {
  family_id: FamilyId;
  runtime_mode: RuntimeMode;
  open_value_usdc: number;
  open_position_count: number;
  open_dust_count: number;
  active_market_count: number;
  current_tail_cost_usdc: number;
  tail_adjusted_pnl_live: number;
  last_entry_ts: string | null;
  last_exit_ts: string | null;
  quarantine_reason: string | null;
  updated_at: string;
}

// ─── Signal ───

export interface Signal {
  signal_id: string;
  family_id: FamilyId;
  market_id: MarketId;
  side: OrderSide;
  entry_price: number;
  size_usdc: number;
  reason: string;
  confidence: number;
  generated_at: string;
}

// ─── Risk Decision ───

export interface RiskDecision {
  signal_id: string;
  family_id: FamilyId;
  approved: boolean;
  rejection_reasons: string[];
  checks_passed: string[];
  decided_at: string;
}

// ─── Order ───

export interface Order {
  order_id: OrderId;
  client_order_id: string;
  market_id: MarketId;
  family_id: FamilyId;
  side: OrderSide;
  price: number;
  size: number;
  size_usdc: number;
  status: OrderStatus;
  exchange_order_id: string | null;
  signal_id: string | null;
  bot_run_id: BotRunId;
  created_at: string;
  updated_at: string;
}

// ─── Fill ───

export interface Fill {
  fill_id: FillId;
  order_id: OrderId;
  market_id: MarketId;
  family_id: FamilyId;
  side: OrderSide;
  price: number;
  size: number;
  fee: number;
  filled_at: string;
}

// ─── Position ───

export interface Position {
  position_id: PositionId;
  market_id: MarketId;
  family_id: FamilyId;
  side: OrderSide;
  size: number;
  avg_entry_price: number;
  cost_basis_usdc: number;
  current_value_usdc: number | null;
  realized_pnl: number;
  status: PositionStatus;
  opened_at: string;
  closed_at: string | null;
  updated_at: string;
}

// ─── Inventory Lot (FIFO tracking) ───

export interface InventoryLot {
  lot_id: string;
  position_id: PositionId;
  market_id: MarketId;
  family_id: FamilyId;
  side: OrderSide;
  size: number;
  remaining_size: number;
  entry_price: number;
  cost_usdc: number;
  fill_id: FillId;
  created_at: string;
}

// ─── Operator Action ───

export interface OperatorAction {
  action_id: string;
  action_type:
    | "pause"
    | "resume"
    | "set-reduce-only"
    | "set-quarantine"
    | "clear-quarantine"
    | "force-cancel";
  target_type: "bot" | "family" | "market" | "order";
  target_id: string;
  reason: string | null;
  performed_at: string;
}
```

---

## 3. Event / Command Type Map

```typescript
// packages/domain/src/events.ts

interface BaseEvent {
  event_id: string;
  timestamp: string;
  bot_run_id: BotRunId;
}

// ─── Market Events ───

export interface MarketUpdated extends BaseEvent {
  type: "MarketUpdated";
  market_id: MarketId;
  snapshot: MarketSnapshot;
}

// ─── Signal Events ───

export interface SignalGenerated extends BaseEvent {
  type: "SignalGenerated";
  signal: Signal;
}

// ─── Risk Events ───

export interface RiskApproved extends BaseEvent {
  type: "RiskApproved";
  decision: RiskDecision;
}

export interface RiskRejected extends BaseEvent {
  type: "RiskRejected";
  decision: RiskDecision;
}

// ─── Order Events ───

export interface OrderPlaced extends BaseEvent {
  type: "OrderPlaced";
  order: Order;
}

export interface OrderFilled extends BaseEvent {
  type: "OrderFilled";
  order_id: OrderId;
  fill: Fill;
}

export interface OrderCancelled extends BaseEvent {
  type: "OrderCancelled";
  order_id: OrderId;
  reason: string;
}

// ─── Reconciliation Events ───

export interface ReconciliationDetected extends BaseEvent {
  type: "ReconciliationDetected";
  mismatch_type: "missing_fill" | "phantom_order" | "position_drift" | "balance_drift";
  details: Record<string, unknown>;
}

// ─── Family State Events ───

export interface FamilyStateChanged extends BaseEvent {
  type: "FamilyStateChanged";
  family_id: FamilyId;
  prev_mode: RuntimeMode;
  new_mode: RuntimeMode;
  reason: string;
}

// ─── Operator Events ───

export interface OperatorActionApplied extends BaseEvent {
  type: "OperatorActionApplied";
  action: OperatorAction;
}

// ─── Union type ───

export type DomainEvent =
  | MarketUpdated
  | SignalGenerated
  | RiskApproved
  | RiskRejected
  | OrderPlaced
  | OrderFilled
  | OrderCancelled
  | ReconciliationDetected
  | FamilyStateChanged
  | OperatorActionApplied;

// ─── Commands ───

export interface PlaceOrderCommand {
  type: "PlaceOrderCommand";
  client_order_id: string;
  market_id: MarketId;
  family_id: FamilyId;
  side: OrderSide;
  price: number;
  size: number;
  signal_id: string;
}

export interface CancelOrderCommand {
  type: "CancelOrderCommand";
  order_id: OrderId;
  reason: string;
}

export type DomainCommand = PlaceOrderCommand | CancelOrderCommand;
```

---

## 4. Repository Interface Catalog

```typescript
// packages/domain/src/repositories.ts

export interface MarketRepository {
  upsert(market: Market): void;
  getById(id: MarketId): Market | null;
  getActive(): Market[];
  getByFamilyId(familyId: FamilyId): Market[];
  saveSnapshot(snapshot: MarketSnapshot): void;
  getLatestSnapshot(marketId: MarketId): MarketSnapshot | null;
}

export interface FamilyRulesRepository {
  /** Load all family rules (identity + evidence + rules) */
  getAll(): FamilyRule[];
  getById(familyId: FamilyId): FamilyRule | null;
  getEnabled(): FamilyRule[];

  /** Persist a validated family rule (from YAML reload or operator edit) */
  upsert(rule: FamilyRule): void;

  /** Save a point-in-time snapshot for audit */
  saveSnapshot(rule: FamilyRule, reason: string): void;
}

export interface FamilyStateRepository {
  get(familyId: FamilyId): FamilyState | null;
  getAll(): FamilyState[];
  upsert(state: FamilyState): void;
  updateMode(familyId: FamilyId, mode: RuntimeMode, reason: string | null): void;
}

export interface OrderRepository {
  insert(order: Order): void;
  update(order: Order): void;
  getById(id: OrderId): Order | null;
  getByClientOrderId(clientOrderId: string): Order | null;
  getOpen(): Order[];
  getOpenByFamily(familyId: FamilyId): Order[];
  getOpenByMarket(marketId: MarketId): Order[];
  getByBotRun(botRunId: BotRunId): Order[];
}

export interface FillRepository {
  insert(fill: Fill): void;
  getByOrderId(orderId: OrderId): Fill[];
  getByFamily(familyId: FamilyId, since?: string): Fill[];
  getByMarket(marketId: MarketId): Fill[];
}

export interface PositionRepository {
  upsert(position: Position): void;
  getById(id: PositionId): Position | null;
  getOpen(): Position[];
  getOpenByFamily(familyId: FamilyId): Position[];
  getOpenByMarket(marketId: MarketId): Position[];
  getDustByFamily(familyId: FamilyId): Position[];
  close(positionId: PositionId, realizedPnl: number, closedAt: string): void;
}

export interface InventoryLotRepository {
  insert(lot: InventoryLot): void;
  getOpenByPosition(positionId: PositionId): InventoryLot[];
  getOpenByFamily(familyId: FamilyId): InventoryLot[];
  consumeFifo(positionId: PositionId, size: number): InventoryLot[];
}

export interface RiskEventRepository {
  insert(event: DomainEvent): void;
  getByFamily(familyId: FamilyId, limit?: number): DomainEvent[];
  getRecent(limit: number): DomainEvent[];
}

export interface BotRunRepository {
  start(runId: BotRunId, mode: string, startedAt: string): void;
  finish(runId: BotRunId, finishedAt: string, summary: Record<string, unknown>): void;
  getCurrent(): { run_id: BotRunId; mode: string; started_at: string } | null;
}
```

---

## 5. SQLite Schema (Initial Migration)

```sql
-- packages/db/src/migrations/001_initial.sql

-- ────────────────────────────
-- Pragmas (applied at connection open, not in migration)
-- PRAGMA journal_mode = WAL;
-- PRAGMA foreign_keys = ON;
-- PRAGMA busy_timeout = 5000;
-- ────────────────────────────

-- ═══════════ MARKETS ═══════════

CREATE TABLE IF NOT EXISTS markets (
  market_id     TEXT PRIMARY KEY,
  condition_id  TEXT NOT NULL,
  slug          TEXT NOT NULL,
  question      TEXT NOT NULL,
  family_id     TEXT,
  family_key    TEXT,
  regime        TEXT,
  outcome       TEXT NOT NULL,
  end_date      TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_markets_family_id ON markets(family_id);
CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active);
CREATE INDEX IF NOT EXISTS idx_markets_slug ON markets(slug);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id    TEXT NOT NULL REFERENCES markets(market_id),
  best_bid     REAL,
  best_ask     REAL,
  last_price   REAL,
  volume_24h   REAL,
  liquidity    REAL,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_market_ts
  ON market_snapshots(market_id, captured_at DESC);

-- ═══════════ FAMILY CATALOG (Identity) ═══════════

CREATE TABLE IF NOT EXISTS family_catalog (
  family_id         TEXT PRIMARY KEY,
  family_key        TEXT NOT NULL,
  primary_category  TEXT NOT NULL,
  regime            TEXT NOT NULL,
  horizon           TEXT NOT NULL,
  cadence           TEXT NOT NULL,
  strategy_profile  TEXT NOT NULL,
  topic_key         TEXT,
  slug_pattern      TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_family_catalog_key ON family_catalog(family_key);
CREATE INDEX IF NOT EXISTS idx_family_catalog_regime ON family_catalog(regime);

-- ═══════════ FAMILY EVIDENCE ═══════════

CREATE TABLE IF NOT EXISTS family_evidence (
  family_id                     TEXT PRIMARY KEY REFERENCES family_catalog(family_id),
  evidence_status               TEXT NOT NULL DEFAULT 'unknown',
  evidence_score                REAL NOT NULL DEFAULT 0,
  promotion_state               TEXT NOT NULL DEFAULT 'probe-only',
  local_trade_count             INTEGER NOT NULL DEFAULT 0,
  local_market_count            INTEGER NOT NULL DEFAULT 0,
  local_realized_pnl_fifo       REAL NOT NULL DEFAULT 0,
  open_tail_cost_usdc           REAL NOT NULL DEFAULT 0,
  tail_adjusted_pnl             REAL NOT NULL DEFAULT 0,
  remote_closed_realized_pnl    REAL,
  open_position_count           INTEGER,
  open_dust_count               INTEGER,
  both_sided_eligible           INTEGER NOT NULL DEFAULT 0,
  heavy_campaign_eligible       INTEGER NOT NULL DEFAULT 0,
  active_window_edge_score      REAL,
  last_validated_at             TEXT,
  updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ FAMILY RULES ═══════════
-- Stored as structured columns for queryability.
-- JSON sub-blocks (session windows) stored as TEXT.

CREATE TABLE IF NOT EXISTS family_rules (
  family_id                                TEXT PRIMARY KEY REFERENCES family_catalog(family_id),

  -- universe
  enabled                                  INTEGER NOT NULL DEFAULT 0,
  action                                   TEXT NOT NULL DEFAULT 'blocked',
  priority_rank                            INTEGER NOT NULL DEFAULT 999,
  allow_weekends                           INTEGER NOT NULL DEFAULT 0,
  session_mode                             TEXT NOT NULL DEFAULT 'active-window',

  -- entry
  entry_mode                               TEXT NOT NULL DEFAULT 'disabled',
  min_entry_price                          REAL NOT NULL DEFAULT 0,
  max_entry_price                          REAL NOT NULL DEFAULT 1,
  max_initial_notional_usdc                REAL NOT NULL DEFAULT 5,
  allow_high_price_one_shot                INTEGER NOT NULL DEFAULT 0,
  high_price_threshold                     REAL NOT NULL DEFAULT 0.20,
  require_proven_family_above_price        REAL NOT NULL DEFAULT 0.20,
  preferred_entry_band                     TEXT,
  max_probe_count_per_market               INTEGER,
  entry_cooldown_seconds                   INTEGER,
  max_new_markets_per_session              INTEGER,

  -- scale_in
  scale_mode                               TEXT NOT NULL DEFAULT 'disabled',
  default_max_buys_per_leg                 INTEGER NOT NULL DEFAULT 3,
  heavy_max_buys_per_leg                   INTEGER NOT NULL DEFAULT 6,
  allow_heavy_campaigns                    INTEGER NOT NULL DEFAULT 0,
  require_positive_recycle_history_for_scale INTEGER NOT NULL DEFAULT 1,

  -- exit
  exit_mode                                TEXT NOT NULL DEFAULT 'disabled',
  primary_profit_model                     TEXT NOT NULL DEFAULT 'sell-into-strength',
  allow_runner_extension                   INTEGER NOT NULL DEFAULT 0,
  prefer_fast_recycle                      INTEGER NOT NULL DEFAULT 1,
  resolution_holding_allowed               INTEGER NOT NULL DEFAULT 0,
  target_roi_band_low                      REAL,
  target_roi_band_high                     REAL,
  max_unmoved_hold_hours                   REAL,
  max_tail_hold_hours                      REAL,

  -- two_sided
  allow_two_sided                          INTEGER NOT NULL DEFAULT 0,
  two_sided_mode                           TEXT NOT NULL DEFAULT 'disabled',
  min_activity_for_two_sided               INTEGER,

  -- tail_suppression
  max_open_value_usdc                      REAL NOT NULL DEFAULT 50,
  max_active_markets                       INTEGER NOT NULL DEFAULT 5,
  max_dust_positions                       INTEGER NOT NULL DEFAULT 3,
  tail_quarantine_threshold_usdc           REAL NOT NULL DEFAULT 50,
  tail_quarantine_threshold_ratio          REAL NOT NULL DEFAULT 1.0,
  stale_tail_prune_enabled                 INTEGER NOT NULL DEFAULT 0,
  threshold_cleanup_required               INTEGER NOT NULL DEFAULT 0,

  -- session (JSON blobs for window arrays)
  active_windows_utc                       TEXT NOT NULL DEFAULT '[]',
  reduced_windows_utc                      TEXT NOT NULL DEFAULT '[]',
  weekday_bias                             TEXT NOT NULL DEFAULT 'normal',
  weekend_mode                             TEXT NOT NULL DEFAULT 'reduced',

  updated_at                               TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ FAMILY RULES SNAPSHOT (audit) ═══════════

CREATE TABLE IF NOT EXISTS family_rules_snapshot (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id    TEXT NOT NULL REFERENCES family_catalog(family_id),
  snapshot     TEXT NOT NULL,  -- full JSON serialization
  reason       TEXT NOT NULL,
  captured_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_family_rules_snapshot_family
  ON family_rules_snapshot(family_id, captured_at DESC);

-- ═══════════ FAMILY RUNTIME STATE ═══════════

CREATE TABLE IF NOT EXISTS family_runtime_state (
  family_id               TEXT PRIMARY KEY REFERENCES family_catalog(family_id),
  runtime_mode            TEXT NOT NULL DEFAULT 'active',
  open_value_usdc         REAL NOT NULL DEFAULT 0,
  open_position_count     INTEGER NOT NULL DEFAULT 0,
  open_dust_count         INTEGER NOT NULL DEFAULT 0,
  active_market_count     INTEGER NOT NULL DEFAULT 0,
  current_tail_cost_usdc  REAL NOT NULL DEFAULT 0,
  tail_adjusted_pnl_live  REAL NOT NULL DEFAULT 0,
  last_entry_ts           TEXT,
  last_exit_ts            TEXT,
  quarantine_reason       TEXT,
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════ ORDERS ═══════════

CREATE TABLE IF NOT EXISTS orders (
  order_id           TEXT PRIMARY KEY,
  client_order_id    TEXT NOT NULL UNIQUE,
  market_id          TEXT NOT NULL,
  family_id          TEXT NOT NULL,
  side               TEXT NOT NULL,
  price              REAL NOT NULL,
  size               REAL NOT NULL,
  size_usdc          REAL NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  exchange_order_id  TEXT,
  signal_id          TEXT,
  bot_run_id         TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_family ON orders(family_id);
CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id);
CREATE INDEX IF NOT EXISTS idx_orders_client_oid ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_bot_run ON orders(bot_run_id);

-- ═══════════ FILLS ═══════════

CREATE TABLE IF NOT EXISTS fills (
  fill_id    TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(order_id),
  market_id  TEXT NOT NULL,
  family_id  TEXT NOT NULL,
  side       TEXT NOT NULL,
  price      REAL NOT NULL,
  size       REAL NOT NULL,
  fee        REAL NOT NULL DEFAULT 0,
  filled_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fills_order ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_fills_family ON fills(family_id);
CREATE INDEX IF NOT EXISTS idx_fills_market ON fills(market_id);

-- ═══════════ POSITIONS ═══════════

CREATE TABLE IF NOT EXISTS positions (
  position_id        TEXT PRIMARY KEY,
  market_id          TEXT NOT NULL,
  family_id          TEXT NOT NULL,
  side               TEXT NOT NULL,
  size               REAL NOT NULL DEFAULT 0,
  avg_entry_price    REAL NOT NULL DEFAULT 0,
  cost_basis_usdc    REAL NOT NULL DEFAULT 0,
  current_value_usdc REAL,
  realized_pnl       REAL NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'open',
  opened_at          TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at          TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_positions_family ON positions(family_id);
CREATE INDEX IF NOT EXISTS idx_positions_market ON positions(market_id);

-- ═══════════ INVENTORY LOTS (FIFO) ═══════════

CREATE TABLE IF NOT EXISTS inventory_lots (
  lot_id          TEXT PRIMARY KEY,
  position_id     TEXT NOT NULL REFERENCES positions(position_id),
  market_id       TEXT NOT NULL,
  family_id       TEXT NOT NULL,
  side            TEXT NOT NULL,
  size            REAL NOT NULL,
  remaining_size  REAL NOT NULL,
  entry_price     REAL NOT NULL,
  cost_usdc       REAL NOT NULL,
  fill_id         TEXT NOT NULL REFERENCES fills(fill_id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_inventory_lots_position ON inventory_lots(position_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_family ON inventory_lots(family_id);
CREATE INDEX IF NOT EXISTS idx_inventory_lots_remaining
  ON inventory_lots(position_id, remaining_size) WHERE remaining_size > 0;

-- ═══════════ RISK EVENTS ═══════════

CREATE TABLE IF NOT EXISTS risk_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,
  family_id   TEXT,
  payload     TEXT NOT NULL,  -- JSON
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_risk_events_family ON risk_events(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_type ON risk_events(event_type, created_at DESC);

-- ═══════════ RUNTIME METRICS ═══════════

CREATE TABLE IF NOT EXISTS runtime_metrics (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_name TEXT NOT NULL,
  value       REAL NOT NULL,
  labels      TEXT,  -- JSON key-value
  captured_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_runtime_metrics_name_ts
  ON runtime_metrics(metric_name, captured_at DESC);

-- ═══════════ BOT RUNS ═══════════

CREATE TABLE IF NOT EXISTS bot_runs (
  run_id      TEXT PRIMARY KEY,
  mode        TEXT NOT NULL,  -- 'simulation' | 'paper' | 'live-lite'
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  summary     TEXT  -- JSON
);

-- ═══════════ OPERATOR ACTIONS (audit) ═══════════

CREATE TABLE IF NOT EXISTS operator_actions (
  action_id     TEXT PRIMARY KEY,
  action_type   TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  reason        TEXT,
  performed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_operator_actions_ts
  ON operator_actions(performed_at DESC);
```

---

## 6. Family Rules Loading Pipeline

### Overview

```
YAML files on disk
       |
       v
  fs.readFileSync + yaml.parse
       |
       v
  Zod schema validation
       |
       v
  Typed FamilyRule objects
       |
       v
  Persisted to SQLite (3 tables: family_catalog, family_evidence, family_rules)
       |
       v
  FamilyRulesRepository.getById(familyId) at runtime
```

### Zod Schemas

```typescript
// packages/family-rules/src/schema.ts

import { z } from "zod";

const timeWindowSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

const identitySchema = z.object({
  family_key: z.string().min(1),
  primary_category: z.string().min(1),
  regime: z.enum([
    "threshold",
    "price-range",
    "directional-updown",
    "social-activity",
    "geopolitics",
    "generic",
    "tournament",
    "weather-range",
  ]),
  horizon: z.string().min(1),
  cadence: z.string().min(1),
  strategy_profile: z.enum([
    "scalp",
    "event-driven",
    "inventory-recycle",
    "optional-probe",
    "restricted",
  ]),
  topic_key: z.string().nullish(),
  slug_pattern: z.string().nullish(),
  notes: z.string().nullish(),
});

const evidenceSchema = z.object({
  evidence_status: z.enum(["confirmed", "partial", "weak", "unknown"]),
  evidence_score: z.number(),
  promotion_state: z.enum(["probe-only", "scaled", "restricted", "reduce-only", "quarantine"]),
  local_trade_count: z.number().int().min(0),
  local_market_count: z.number().int().min(0),
  local_realized_pnl_fifo: z.number(),
  open_tail_cost_usdc: z.number().min(0),
  tail_adjusted_pnl: z.number(),
  remote_closed_realized_pnl: z.number().nullish(),
  open_position_count: z.number().int().min(0).nullish(),
  open_dust_count: z.number().int().min(0).nullish(),
  both_sided_eligible: z.boolean(),
  heavy_campaign_eligible: z.boolean(),
  active_window_edge_score: z.number().nullish(),
  last_validated_at: z.string().nullish(),
});

const universeSchema = z.object({
  enabled: z.boolean(),
  action: z.enum(["trade", "monitor", "reduce-only", "blocked"]),
  priority_rank: z.number().int().min(1),
  allow_weekends: z.boolean(),
  session_mode: z.enum(["active-window", "reduced", "always-reduced"]),
});

const entrySchema = z.object({
  entry_mode: z.enum(["probe-first", "conviction-only", "disabled"]),
  min_entry_price: z.number().min(0).max(1),
  max_entry_price: z.number().min(0).max(1),
  max_initial_notional_usdc: z.number().positive(),
  allow_high_price_one_shot: z.boolean(),
  high_price_threshold: z.number().min(0).max(1),
  require_proven_family_above_price: z.number().min(0).max(1),
  preferred_entry_band: z.string().nullish(),
  max_probe_count_per_market: z.number().int().positive().nullish(),
  entry_cooldown_seconds: z.number().int().min(0).nullish(),
  max_new_markets_per_session: z.number().int().positive().nullish(),
});

const scaleInSchema = z.object({
  scale_mode: z.enum(["confirm-only", "disabled", "aggressive-confirm"]),
  default_max_buys_per_leg: z.number().int().min(1),
  heavy_max_buys_per_leg: z.number().int().min(1),
  allow_heavy_campaigns: z.boolean(),
  require_positive_recycle_history_for_scale: z.boolean(),
});

const exitSchema = z.object({
  exit_mode: z.enum(["repricing-sell", "reduce-only", "disabled"]),
  primary_profit_model: z.enum(["sell-into-strength"]),
  allow_runner_extension: z.boolean(),
  prefer_fast_recycle: z.boolean(),
  resolution_holding_allowed: z.boolean(),
  target_roi_band_low: z.number().nullish(),
  target_roi_band_high: z.number().nullish(),
  max_unmoved_hold_hours: z.number().nullish(),
  max_tail_hold_hours: z.number().nullish(),
});

const twoSidedSchema = z.object({
  allow_two_sided: z.boolean(),
  two_sided_mode: z.enum(["disabled", "selective", "active"]),
  min_activity_for_two_sided: z.number().int().positive().nullish(),
});

const tailSuppressionSchema = z.object({
  max_open_value_usdc: z.number().positive(),
  max_active_markets: z.number().int().positive(),
  max_dust_positions: z.number().int().min(0),
  tail_quarantine_threshold_usdc: z.number().positive(),
  tail_quarantine_threshold_ratio: z.number().positive(),
  stale_tail_prune_enabled: z.boolean(),
  threshold_cleanup_required: z.boolean(),
});

const sessionSchema = z.object({
  active_windows_utc: z.array(timeWindowSchema).min(1),
  reduced_windows_utc: z.array(timeWindowSchema),
  weekday_bias: z.enum(["normal", "preferred", "required"]),
  weekend_mode: z.enum(["normal", "reduced", "disabled"]),
});

const rulesSchema = z.object({
  universe: universeSchema,
  entry: entrySchema,
  scale_in: scaleInSchema,
  exit: exitSchema,
  two_sided: twoSidedSchema,
  tail_suppression: tailSuppressionSchema,
  session: sessionSchema,
});

export const familyRuleFileSchema = z.object({
  version: z.literal(1),
  family_id: z.string().min(1),
  identity: identitySchema,
  evidence: evidenceSchema,
  rules: rulesSchema,
  runtime_state: z.object({
    runtime_mode: z.enum(["active", "probe-only", "restricted", "quarantine", "reduce-only"]),
    open_value_usdc: z.number().min(0),
    open_position_count: z.number().int().min(0),
    open_dust_count: z.number().int().min(0),
    active_market_count: z.number().int().min(0),
    current_tail_cost_usdc: z.number().min(0),
    tail_adjusted_pnl_live: z.number(),
    last_entry_ts: z.string().nullish(),
    last_exit_ts: z.string().nullish(),
    quarantine_reason: z.string().nullish(),
  }),
});

export type FamilyRuleFile = z.infer<typeof familyRuleFileSchema>;
```

### Loader

```typescript
// packages/family-rules/src/loader.ts

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { familyRuleFileSchema, type FamilyRuleFile } from "./schema.js";
import type { FamilyRule, FamilyState, FamilyId } from "@plankton/domain";

export interface LoadResult {
  rules: FamilyRule[];
  states: FamilyState[];
  errors: Array<{ file: string; error: string }>;
}

/**
 * Load all YAML family rule files from a directory.
 * Each file is validated with zod. Invalid files are reported but do not
 * prevent valid files from loading (fail-open per file, fail-closed if zero valid).
 */
export function loadFamilyRulesFromDir(dirPath: string): LoadResult {
  const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  const rules: FamilyRule[] = [];
  const states: FamilyState[] = [];
  const errors: LoadResult["errors"] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dirPath, file), "utf-8");
      const parsed = YAML.parse(raw);
      const validated = familyRuleFileSchema.parse(parsed);
      const { rule, state } = toTyped(validated);
      rules.push(rule);
      states.push(state);
    } catch (err) {
      errors.push({ file, error: String(err) });
    }
  }

  if (rules.length === 0 && files.length > 0) {
    throw new Error(`All ${files.length} family rule files failed validation`);
  }

  return { rules, states, errors };
}

function toTyped(raw: FamilyRuleFile): { rule: FamilyRule; state: FamilyState } {
  const familyId = raw.family_id as FamilyId;

  const rule: FamilyRule = {
    identity: { family_id: familyId, ...raw.identity },
    evidence: { family_id: familyId, ...raw.evidence },
    rules: {
      family_id: familyId,
      universe: raw.rules.universe,
      entry: raw.rules.entry,
      scale_in: raw.rules.scale_in,
      exit: raw.rules.exit,
      two_sided: raw.rules.two_sided,
      tail_suppression: raw.rules.tail_suppression,
      session: raw.rules.session,
    },
  };

  const state: FamilyState = {
    family_id: familyId,
    ...raw.runtime_state,
    updated_at: new Date().toISOString(),
  };

  return { rule, state };
}
```

### Startup Sequence

```typescript
// Pseudocode for apps/runtime startup

import { loadFamilyRulesFromDir } from "@plankton/family-rules";
import { SqliteFamilyRulesRepository, SqliteFamilyStateRepository } from "@plankton/db";

// 1. Load YAML files
const { rules, states, errors } = loadFamilyRulesFromDir(config.familyRulesDir);
if (errors.length > 0) {
  logger.warn("Some family rule files failed validation", { errors });
}

// 2. Persist to SQLite
for (const rule of rules) {
  familyRulesRepo.upsert(rule);
  familyRulesRepo.saveSnapshot(rule, "startup-load");
}

// 3. Seed runtime state (only if no existing state in DB)
for (const state of states) {
  const existing = familyStateRepo.get(state.family_id);
  if (!existing) {
    familyStateRepo.upsert(state);
  }
}
```

---

## 7. Storage Model Summary

| Table                   | Layer       | What it stores                                              | Mutability                         |
| ----------------------- | ----------- | ----------------------------------------------------------- | ---------------------------------- |
| `family_catalog`        | Identity    | family_key, regime, horizon, strategy_profile               | Rarely changes                     |
| `family_evidence`       | Evidence    | scores, trade counts, tail-adjusted PnL, eligibility flags  | Recomputed from analysis           |
| `family_rules`          | Rules       | All deployed parameters (entry, exit, scale, tail, session) | Updated by operator or YAML reload |
| `family_rules_snapshot` | Audit       | Point-in-time JSON snapshot of rules                        | Append-only                        |
| `family_runtime_state`  | Runtime     | Live mode, open counts, tail cost, timestamps               | Updated every tick/cycle           |
| `markets`               | Reference   | Polymarket market catalog with family mapping               | Updated from exchange              |
| `market_snapshots`      | Time-series | Price, volume, liquidity snapshots                          | Append-only                        |
| `orders`                | Execution   | Full order lifecycle                                        | Updated on state transitions       |
| `fills`                 | Execution   | Individual fill records                                     | Append-only                        |
| `positions`             | Inventory   | Aggregated position per market+side                         | Updated on fills                   |
| `inventory_lots`        | Inventory   | FIFO lot tracking for PnL                                   | Updated on consumption             |
| `risk_events`           | Audit       | Serialized domain events for debugging                      | Append-only                        |
| `runtime_metrics`       | Ops         | Numeric metric time-series                                  | Append-only                        |
| `bot_runs`              | Ops         | Run lifecycle tracking                                      | One active at a time               |
| `operator_actions`      | Audit       | Manual interventions                                        | Append-only                        |

### Relationship Diagram (text)

```
family_catalog ──1:1──> family_evidence
               ──1:1──> family_rules
               ──1:1──> family_runtime_state
               ──1:N──> family_rules_snapshot
               ──1:N──> markets
               ──1:N──> orders ──1:N──> fills
               ──1:N──> positions ──1:N──> inventory_lots
```

---

## 8. Migration Strategy

### Approach: Sequential numbered SQL files

```
packages/db/src/migrations/
  001_initial.sql        -- everything above
  002_add_xxx.sql        -- future additions
  003_add_yyy.sql        -- future additions
```

### Migration runner (synchronous, simple)

```typescript
// packages/db/src/migrate.ts

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export function runMigrations(db: Database.Database): void {
  // Create tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id        INTEGER PRIMARY KEY,
      filename  TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT filename FROM _migrations")
      .all()
      .map((r: any) => r.filename),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (filename) VALUES (?)").run(file);
    })();
  }
}
```

### Connection factory

```typescript
// packages/db/src/connection.ts

import Database from "better-sqlite3";
import { runMigrations } from "./migrate.js";

export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // WAL mode for concurrent reads during writes
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL"); // safe with WAL

  runMigrations(db);

  return db;
}
```

### Migration rules for v1

1. All migrations are forward-only. No down migrations in v1.
2. Every migration is wrapped in a transaction by the runner.
3. Column additions use `ALTER TABLE ... ADD COLUMN` with a default value so existing rows are unaffected.
4. Destructive changes (drop column, rename table) are forbidden in v1. Use new columns and deprecate old ones.
5. The `_migrations` table tracks which files have been applied.
6. Migration files are named with zero-padded sequence numbers: `001_`, `002_`, etc.
7. Each migration file must be idempotent where possible (use `IF NOT EXISTS`).

### Example future migration

```sql
-- packages/db/src/migrations/002_add_position_tags.sql

ALTER TABLE positions ADD COLUMN tags TEXT DEFAULT '[]';
ALTER TABLE positions ADD COLUMN campaign_id TEXT;

CREATE INDEX IF NOT EXISTS idx_positions_campaign ON positions(campaign_id)
  WHERE campaign_id IS NOT NULL;
```

---

## Appendix: SQLite Implementation Pattern

Repository implementations in `packages/db/src/sqlite/` follow a consistent pattern. Here is a condensed example for `OrderRepository`:

```typescript
// packages/db/src/sqlite/SqliteOrderRepository.ts

import type Database from "better-sqlite3";
import type {
  Order,
  OrderId,
  OrderRepository,
  MarketId,
  FamilyId,
  BotRunId,
} from "@plankton/domain";

export class SqliteOrderRepository implements OrderRepository {
  private stmts: ReturnType<typeof this.prepare>;

  constructor(private db: Database.Database) {
    this.stmts = this.prepare();
  }

  private prepare() {
    return {
      insert: this.db.prepare(`
        INSERT INTO orders (order_id, client_order_id, market_id, family_id, side,
          price, size, size_usdc, status, exchange_order_id, signal_id, bot_run_id,
          created_at, updated_at)
        VALUES (@order_id, @client_order_id, @market_id, @family_id, @side,
          @price, @size, @size_usdc, @status, @exchange_order_id, @signal_id,
          @bot_run_id, @created_at, @updated_at)
      `),
      update: this.db.prepare(`
        UPDATE orders SET status = @status, exchange_order_id = @exchange_order_id,
          updated_at = @updated_at
        WHERE order_id = @order_id
      `),
      getById: this.db.prepare("SELECT * FROM orders WHERE order_id = ?"),
      getByClientOrderId: this.db.prepare("SELECT * FROM orders WHERE client_order_id = ?"),
      getOpen: this.db.prepare(
        `SELECT * FROM orders WHERE status IN ('pending', 'open', 'partially-filled')`,
      ),
      getOpenByFamily: this.db.prepare(
        `SELECT * FROM orders WHERE family_id = ? AND status IN ('pending', 'open', 'partially-filled')`,
      ),
      getOpenByMarket: this.db.prepare(
        `SELECT * FROM orders WHERE market_id = ? AND status IN ('pending', 'open', 'partially-filled')`,
      ),
      getByBotRun: this.db.prepare("SELECT * FROM orders WHERE bot_run_id = ?"),
    };
  }

  insert(order: Order): void {
    this.stmts.insert.run(order);
  }
  update(order: Order): void {
    this.stmts.update.run(order);
  }
  getById(id: OrderId): Order | null {
    return this.stmts.getById.get(id) as Order | null;
  }
  getByClientOrderId(cid: string): Order | null {
    return this.stmts.getByClientOrderId.get(cid) as Order | null;
  }
  getOpen(): Order[] {
    return this.stmts.getOpen.all() as Order[];
  }
  getOpenByFamily(fid: FamilyId): Order[] {
    return this.stmts.getOpenByFamily.all(fid) as Order[];
  }
  getOpenByMarket(mid: MarketId): Order[] {
    return this.stmts.getOpenByMarket.all(mid) as Order[];
  }
  getByBotRun(rid: BotRunId): Order[] {
    return this.stmts.getByBotRun.all(rid) as Order[];
  }
}
```

Key patterns:

- **Prepared statements** are created once in the constructor and reused. This is the primary performance advantage of better-sqlite3's synchronous API.
- **Each repository class** implements the corresponding interface from `@plankton/domain`.
- **Boolean columns** are stored as `INTEGER` (0/1) in SQLite and converted at the repository boundary.
- **JSON array columns** (like `active_windows_utc`) are stored as `TEXT` and parsed/serialized at the repository boundary.
- **Timestamp columns** use ISO 8601 strings (`TEXT`). SQLite has no native datetime type, and string comparison works correctly for ISO format.
