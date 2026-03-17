# Strategy–Domain Compliance Matrix

Generated: 2026-03-13
Author: Strategy / Rules Engineer — Phase 2

Source documents:
- `validated_strategy_rulebook.md` (14 Hard Rules, HR1–HR14)
- `team_output/05_strategy_compliance.md` (runtime module mapping)
- `family_rules_schema_v1.md` (schema design)
- `hypothesis_test_results.md` (empirical backing)
- `team_output/04_domain_persistence.md` (domain types, repositories, SQLite schema)

---

## Part 1 — Compliance Matrix

> "Sufficient in current model?" means: can the rule be fully enforced using only the types, fields, and repository methods already defined in `04_domain_persistence.md`, without adding any new domain object?

---

### HR1 — Selection unit is `family + regime + horizon`, not category

| Attribute | Detail |
|---|---|
| Rule summary | Every market must be mapped to a `family_id = family_key:regime:horizon`. Selection by raw category is forbidden. |
| Domain types needed | `FamilyIdentity`, `Market` |
| Fields required | `FamilyIdentity.family_id`, `FamilyIdentity.family_key`, `FamilyIdentity.regime`, `FamilyIdentity.horizon`; `Market.family_id`, `Market.regime` |
| Repository methods needed | `MarketRepository.getByFamilyId()` — present. `FamilyRulesRepository.getById()` — present. |
| Sufficient in current model? | **Yes** |
| Gap | None. All required fields exist in `FamilyIdentity` and `Market`. `family_id` is a branded type formatted as `key:regime:horizon`. `primary_category` is stored as metadata only, not as a selection key. |

---

### HR2 — New family starts in probe-only mode

| Attribute | Detail |
|---|---|
| Rule summary | Every new family initialises at `probe-only`. Promotion to `scaled` requires recycle evidence. |
| Domain types needed | `FamilyEvidence`, `FamilyState`, `FamilyRules` (ScaleInRules) |
| Fields required | `FamilyEvidence.promotion_state`; `FamilyState.runtime_mode`; `ScaleInRules.require_positive_recycle_history_for_scale`; `FamilyEvidence.local_trade_count`, `tail_adjusted_pnl` |
| Repository methods needed | `FamilyStateRepository.updateMode()` — present. `FamilyRulesRepository.upsert()` — present. |
| Sufficient in current model? | **Mostly yes, one gap** |
| Gap | The domain model has all necessary fields. However, there is no defined domain type or method that computes and exposes **minimum promotion criteria** (e.g., minimum trade count threshold, minimum number of successful repricing exits). These criteria are referenced in `05_strategy_compliance.md` section 4 but are not formalised as fields on any domain type. The Risk/Inventory engine can read `local_trade_count` and `tail_adjusted_pnl` directly, but there is no `FamilyEvidence.min_promotion_trade_count` or `FamilyEvidence.successful_reprice_exit_count` field. As a result, promotion eligibility cannot be evaluated from domain types alone — it requires external configuration or hardcoded thresholds in the engine. **Missing field: `FamilyEvidence.successful_reprice_exit_count` (integer).** |

---

### HR3 — Active trading window 14:00–21:00 UTC

| Attribute | Detail |
|---|---|
| Rule summary | Default aggressive entries only during 14:00–21:00 UTC. Reduced mode permitted outside. Hard off is not allowed (SH2). |
| Domain types needed | `SessionRules`, `FamilyState` |
| Fields required | `SessionRules.active_windows_utc`, `SessionRules.reduced_windows_utc`, `SessionRules.weekend_mode`, `UniverseRules.session_mode` |
| Repository methods needed | `FamilyRulesRepository.getById()` — present. No additional repository method needed; window checking is pure time logic against loaded rules. |
| Sufficient in current model? | **Yes** |
| Gap | None. `active_windows_utc` and `reduced_windows_utc` are typed as `TimeWindow[]` with `start`/`end` in `HH:MM` UTC format. `session_mode` on `UniverseRules` provides the per-family override. Both fields are persisted in `family_rules` table and validated via Zod. The distinction between "reduced" and "hard off" is expressible via `session_mode = "always-reduced"` vs `action = "blocked"`. |

---

### HR4 — Default entry model is probe-first

| Attribute | Detail |
|---|---|
| Rule summary | First entry in any family must be sized as probe. Broad cheap spraying is blocked. |
| Domain types needed | `EntryRules`, `FamilyState` |
| Fields required | `EntryRules.entry_mode`, `EntryRules.max_initial_notional_usdc`, `EntryRules.max_probe_count_per_market`, `EntryRules.max_new_markets_per_session` |
| Repository methods needed | `FamilyRulesRepository.getById()` — present. |
| Sufficient in current model? | **Yes** |
| Gap | None. `entry_mode = "probe-first"` is a defined enum value. `max_initial_notional_usdc` caps the first entry size. Sprawl is controlled by `max_probe_count_per_market` and `max_new_markets_per_session`. All fields present and Zod-validated. |

---

### HR5 — No one-shot high-price entries in unproven families

| Attribute | Detail |
|---|---|
| Rule summary | Entries at price ≥ 0.20 are blocked in probe-only families unless part of a confirmed campaign. `allow_high_price_one_shot` defaults to false. |
| Domain types needed | `EntryRules`, `FamilyEvidence` |
| Fields required | `EntryRules.allow_high_price_one_shot`, `EntryRules.high_price_threshold`, `EntryRules.require_proven_family_above_price`, `FamilyEvidence.promotion_state` |
| Repository methods needed | `FamilyRulesRepository.getById()` — present. |
| Sufficient in current model? | **Mostly yes, one conceptual gap** |
| Gap | The "unless part of a confirmed campaign" qualifier in the rulebook requires knowing whether an active campaign already exists on that market/side. The current model has no `Campaign` or `Leg` entity (see dedicated analysis in Part 2). The risk engine would need to determine campaign membership from open positions or fills — which is possible via `PositionRepository.getOpenByMarket()` and `FillRepository.getByMarket()`, but the logic is implicit rather than domain-first. This is an ergonomics/safety gap, not a blocking gap: the rule can be enforced via a `buy_count_for_market()` query over fills, but the intent is obscure without a Leg entity. **Recommended addition: Leg entity (see Part 2).** |

---

### HR6 — Standard scale-in: 2–3 buys per campaign

| Attribute | Detail |
|---|---|
| Rule summary | Normal scale-in cap is 2–3 buys. 1 buy = probe or single-shot. 4+ buys = conviction mode, not default. |
| Domain types needed | `ScaleInRules` — and implicitly a mechanism to count buys per campaign |
| Fields required | `ScaleInRules.default_max_buys_per_leg`, `ScaleInRules.scale_mode` |
| Repository methods needed | No explicit "count buys per leg" repository method currently defined. Closest approximation: `FillRepository.getByMarket()` filtered by side=buy, then counted. |
| Sufficient in current model? | **Partially — functional gap on buy-count tracking** |
| Gap | `default_max_buys_per_leg` is present and defaults to 3. The gap is the **enforcement mechanism**: the domain model has no `Leg` or `Campaign` entity, so "buys per leg" must be inferred by counting buy-side fills or open buy positions on a market within the family. This is computable but requires a specific query that is not surfaced as a named repository method. The field `buy_count_per_leg` appears in `05_strategy_compliance.md` section 2 as a metric the Risk engine "must compute" — but there is no domain type that stores or returns it. **Missing repository method: `FillRepository.getBuyCountForMarket(marketId, familyId, since?: string): number`.** See Part 2 for the Leg/Campaign design question. |

---

### HR7 — Heavy campaigns (4+ buys) only in proven families

| Attribute | Detail |
|---|---|
| Rule summary | `allow_heavy_campaigns` is false by default. Can only be enabled where `evidence_status = confirmed` and `heavy_campaign_eligible = true`. |
| Domain types needed | `ScaleInRules`, `FamilyEvidence` |
| Fields required | `ScaleInRules.allow_heavy_campaigns`, `ScaleInRules.heavy_max_buys_per_leg`, `FamilyEvidence.heavy_campaign_eligible`, `FamilyEvidence.evidence_status` |
| Repository methods needed | `FamilyRulesRepository.getById()` — present. |
| Sufficient in current model? | **Partially — same buy-count enforcement gap as HR6** |
| Gap | The gating fields are all present. The same gap as HR6 applies: counting buys within a campaign requires a query that is not named in the repository interfaces. Additionally, `heavy_max_buys_per_leg` has a schema default of 6 in the SQLite migration but this value is not formalised in the domain type documentation as a v1 recommendation. Minor: document should explicitly state the heavy default. **Same missing method as HR6: `FillRepository.getBuyCountForMarket()`.** |

---

### HR8 — Primary exit via repricing (SELL), not resolution

| Attribute | Detail |
|---|---|
| Rule summary | `primary_profit_model = sell-into-strength`. Resolution holding is permitted only when explicitly allowed per family. |
| Domain types needed | `ExitRules` |
| Fields required | `ExitRules.exit_mode`, `ExitRules.primary_profit_model`, `ExitRules.resolution_holding_allowed` |
| Repository methods needed | None beyond what exists; exit signal generation is Strategy logic over loaded rules. |
| Sufficient in current model? | **Yes** |
| Gap | None. `ExitMode` enum includes `"repricing-sell"`. `ProfitModel` enum only has `"sell-into-strength"` — making resolution-first impossible at the type level. `resolution_holding_allowed` is a boolean gate. All present. |

---

### HR9 — Exit targets meaningful repricing, not micro-scalp

| Attribute | Detail |
|---|---|
| Rule summary | Target 20–50% ROI as central case. Allow runners to extend. Do not exit on first minimal tick. |
| Domain types needed | `ExitRules` |
| Fields required | `ExitRules.target_roi_band_low`, `ExitRules.target_roi_band_high`, `ExitRules.allow_runner_extension`, `ExitRules.prefer_fast_recycle` |
| Repository methods needed | None beyond what exists. |
| Sufficient in current model? | **Yes** |
| Gap | None. All four fields are present and nullable (allowing v1 to omit numeric thresholds if evidence is insufficient). The tension between `prefer_fast_recycle` and `allow_runner_extension` is a strategy-layer decision, not a domain gap. |

---

### HR10 — Two-sided trading is selective, not global

| Attribute | Detail |
|---|---|
| Rule summary | `allow_two_sided` defaults to false. Only enabled for families with `both_sided_eligible = true` and explicit approval. |
| Domain types needed | `TwoSidedRules`, `FamilyEvidence` |
| Fields required | `TwoSidedRules.allow_two_sided`, `TwoSidedRules.two_sided_mode`, `FamilyEvidence.both_sided_eligible` |
| Repository methods needed | `FamilyRulesRepository.getById()` — present. |
| Sufficient in current model? | **Yes** |
| Gap | None. `allow_two_sided` defaults to false in SQLite schema. `both_sided_eligible` is a derived boolean on `FamilyEvidence`. `TwoSidedMode` enum enforces the three permitted states. |

---

### HR11 — Primary risk metric: `realized_pnl_fifo − open_tail_cost`

| Attribute | Detail |
|---|---|
| Rule summary | Family health score = `realized_pnl_fifo − open_tail_cost`. This must be computed live and drive quarantine decisions, not be analytics-only. |
| Domain types needed | `FamilyState`, `FamilyEvidence`, `InventoryLot` |
| Fields required | `FamilyState.tail_adjusted_pnl_live`, `FamilyState.current_tail_cost_usdc`; `FamilyEvidence.local_realized_pnl_fifo`, `FamilyEvidence.open_tail_cost_usdc`, `FamilyEvidence.tail_adjusted_pnl`; `InventoryLot.cost_usdc`, `InventoryLot.remaining_size` |
| Repository methods needed | `InventoryLotRepository.getOpenByFamily()` — present (used to sum `cost_usdc` where `remaining_size > 0`). `FamilyStateRepository.upsert()` — present. |
| Sufficient in current model? | **Yes** |
| Gap | None structurally. `InventoryLot` has `cost_usdc` and `remaining_size`, enabling FIFO-correct tail cost summation. `FamilyState.current_tail_cost_usdc` and `tail_adjusted_pnl_live` are live mutable fields. The SQLite partial index `WHERE remaining_size > 0` on `inventory_lots` makes the query efficient. The critical implementation requirement — that cost basis is FIFO, not average-cost — is enforced by the existence of `InventoryLotRepository.consumeFifo()` as the only sanctioned lot-consumption method. No domain gap; this is an implementation discipline requirement. |

---

### HR12 — Threshold families require dedicated tail-control

| Attribute | Detail |
|---|---|
| Rule summary | Any family with `regime = threshold` must have `threshold_cleanup_required = true`. Must enter quarantine when `tail_adjusted_pnl_live < 0`. |
| Domain types needed | `FamilyIdentity`, `TailSuppressionRules`, `FamilyState` |
| Fields required | `FamilyIdentity.regime` (must equal `"threshold"`); `TailSuppressionRules.threshold_cleanup_required`, `TailSuppressionRules.tail_quarantine_threshold_usdc`, `TailSuppressionRules.tail_quarantine_threshold_ratio`; `FamilyState.tail_adjusted_pnl_live`, `FamilyState.runtime_mode` |
| Repository methods needed | `FamilyStateRepository.updateMode()` — present. |
| Sufficient in current model? | **Yes** |
| Gap | None. The `Regime.Threshold` enum value is defined. `threshold_cleanup_required` is a boolean in `TailSuppressionRules`. The automatic quarantine path is: Risk engine checks `tail_adjusted_pnl_live < 0` after every fill → calls `FamilyStateRepository.updateMode(familyId, "quarantine", reason)` → emits `FamilyStateChanged` event. All primitives exist. One process note: there is no `FamilyRulesRepository` method to query `getByRegime(regime)`, which would be useful for bulk-setting `threshold_cleanup_required` on initial catalog load. **Missing convenience method: `FamilyRulesRepository.getByRegime(regime: Regime): FamilyRule[]`.** This is a convenience gap, not a blocking gap. |

---

### HR13 — Long-dated sports outrights / awards / leaderboards excluded from default universe

| Attribute | Detail |
|---|---|
| Rule summary | These families must have `enabled = false` and `action = blocked`. They must be tagged with `regime = tournament` and `horizon = season-long` to enable automated filtering. |
| Domain types needed | `FamilyIdentity`, `UniverseRules` |
| Fields required | `FamilyIdentity.regime` (value `"tournament"`), `FamilyIdentity.horizon`; `UniverseRules.enabled`, `UniverseRules.action`; `FamilyIdentity.strategy_profile` (value `"restricted"`) |
| Repository methods needed | `FamilyRulesRepository.getEnabled()` — present (returns only `enabled = true` families, so blocked families are already excluded). |
| Sufficient in current model? | **Yes, with a regime classification caveat** |
| Gap | The domain model has all necessary fields. The gap identified in `05_strategy_compliance.md` Gap 7 remains: **regime classification for new markets is not automated**. The domain type catalog provides the right enum values (`tournament`, `season-long` horizon), but there is no Market Catalog normalization process defined in `04_domain_persistence.md` that automatically assigns `regime = tournament` to sports outright markets. This is a pipeline gap, not a domain type gap. Operationally, v1 will curate these families by hand via YAML, which is sufficient. |

---

### HR14 — Remote closed snapshot is not source of truth

| Attribute | Detail |
|---|---|
| Rule summary | Primary P&L computation uses local FIFO + tail cost. Remote closed data is auxiliary. Divergences must be flagged. |
| Domain types needed | `FamilyEvidence`, `InventoryLot`, `FamilyState`, reconciliation events |
| Fields required | `FamilyEvidence.local_realized_pnl_fifo`, `FamilyEvidence.remote_closed_realized_pnl` (nullable helper); `FamilyState.tail_adjusted_pnl_live`; `ReconciliationDetected` event (type `"position_drift"`) |
| Repository methods needed | `RiskEventRepository.insert()` — present for logging reconciliation events. `InventoryLotRepository.getOpenByFamily()` — present for FIFO computation. |
| Sufficient in current model? | **Yes** |
| Gap | None. `remote_closed_realized_pnl` is nullable on `FamilyEvidence`, making it explicitly optional. `local_realized_pnl_fifo` is required. The `ReconciliationDetected` event type covers divergence signalling. The architecture principle that local FIFO is authoritative is enforced at the type level by making remote data nullable and by having all decision-making fields (`tail_adjusted_pnl_live`, `current_tail_cost_usdc`) computed from local lots only. |

---

## Part 2 — Specific Design Questions

---

### Q1 — Leg / Campaign: can we track buy count per campaign without a Leg entity?

**The question:**
HR6 says standard campaigns have 2–3 buys. HR7 says heavy campaigns have 5+ buys. Can we enforce these caps without a first-class `Leg` entity?

**Analysis:**

Without a Leg entity, the Risk engine must derive "buys in the current active campaign" from lower-level records. There are two possible approaches:

**Approach A — Infer from fills:**
Query `FillRepository.getByMarket(marketId)` filtered to `side = buy`, ordered by `filled_at DESC`, and count until a full position exit is found (where a SELL fill consuming all lots marks the end of the previous campaign). This is logically possible but requires the engine to reconstruct campaign boundaries from raw fills — a non-trivial state machine that must correctly handle partial exits, dust positions, and stale lots.

**Approach B — Infer from open positions / inventory lots:**
Query `InventoryLotRepository.getOpenByPosition(positionId)` and count distinct fill events. This only covers the current open position but misses the full campaign history if a position was partially closed.

**Can we track buy count WITHOUT a Leg entity?**

Yes, technically — but with three material risks:

1. **Correctness risk**: Campaign boundary detection (when does a new campaign start?) is ambiguous without an explicit marker. If a family has multiple open markets simultaneously, or if a position is partially reduced and then re-added to, the engine must embed policy decisions about campaign boundaries in query logic rather than domain logic. This is error-prone.

2. **Auditability risk**: Without a Leg record, there is no auditable history of how many buys a campaign accumulated before it was exited. Post-hoc analysis requires re-running the state machine over fills.

3. **Gate enforcement risk**: HR5's qualifier — "high-price entry is allowed if part of an existing confirmed campaign" — requires knowing whether a campaign exists and is confirmed. Without a Leg entity, "confirmed" has no domain representation.

**Minimum domain model to support this without a Leg:**

At minimum, add one repository method:

```
FillRepository.getBuyCountForMarket(
  marketId: MarketId,
  familyId: FamilyId,
  since: string   // ISO timestamp of campaign start — requires knowing when the last full exit was
): number
```

This in turn requires `PositionRepository` to expose the last full-close timestamp for a market:

```
PositionRepository.getLastClosedAt(marketId: MarketId, familyId: FamilyId): string | null
```

The `since` parameter is the `closed_at` of the most recently closed position on that market/family. Buys after that timestamp belong to the current campaign.

**Recommendation: introduce a Leg entity in v1, not a workaround.**

The workaround above is fragile for three reasons: it reconstructs domain logic from raw events, it requires two non-obvious queries to answer a simple question, and it cannot represent "confirmed campaign" as a state. A minimal `Leg` entity is:

```typescript
export interface Leg {
  leg_id: string;             // primary key
  market_id: MarketId;
  family_id: FamilyId;
  side: OrderSide;            // always "buy" for the initiating side
  buy_count: number;          // incremented on each buy fill in this leg
  status: "open" | "closed";  // closed when a full exit is confirmed
  opened_at: string;
  closed_at: string | null;
}
```

With this entity, `ScaleInRules.default_max_buys_per_leg` becomes directly checkable via `leg.buy_count < rules.scale_in.default_max_buys_per_leg`. Campaign boundary is explicit. The "confirmed campaign" qualifier in HR5 maps to `leg.status = "open" AND leg.buy_count >= 1`.

**Required repository method if Leg is introduced:**

```typescript
export interface LegRepository {
  getActiveLeg(marketId: MarketId, familyId: FamilyId): Leg | null;
  openLeg(leg: Leg): void;
  incrementBuyCount(legId: string): void;
  closeLeg(legId: string, closedAt: string): void;
  getByFamily(familyId: FamilyId, since?: string): Leg[];
}
```

**Verdict:** Introduce `Leg` now. The workaround is implementable but creates fragile enforcement. Leg is cheap to add (one table, one interface), and it makes HR6, HR7, and the HR5 confirmed-campaign qualifier all unambiguous.

---

### Q2 — FIFO Cost Basis: is InventoryLot sufficient?

**The question:**
HR11 uses `realized_pnl_fifo`. Is `InventoryLot` sufficient? What fields does it need?

**Analysis:**

`InventoryLot` as defined in `04_domain_persistence.md` is sufficient. Its current fields are:

- `lot_id`, `position_id`, `market_id`, `family_id`, `side`
- `size` — original lot size
- `remaining_size` — how much is left unconsumed
- `entry_price` — price at which this lot was acquired
- `cost_usdc` — `size × entry_price` (the cost basis of this lot)
- `fill_id` — the originating fill (provides FIFO ordering via `created_at`)
- `created_at` — the timestamp used for FIFO ordering

**FIFO mechanics:**

When a SELL fill arrives:
1. Call `InventoryLotRepository.consumeFifo(positionId, size)`.
2. `consumeFifo` returns the lots consumed in creation order (oldest first).
3. For each consumed lot, `realized_pnl += (sell_price − entry_price) × consumed_size`.
4. Family-level `local_realized_pnl_fifo` on `FamilyEvidence` is updated by summing across all closed positions.

**Current tail cost computation:**

`current_tail_cost_usdc` = `SUM(cost_usdc × (remaining_size / size))` across all open lots in the family where `remaining_size > 0`.

This is equivalent to the cost basis of all unconsumed inventory — exactly what "open tail cost" means in the rulebook.

**Required fields already present:** `cost_usdc`, `remaining_size`, `entry_price`, `fill_id` (for FIFO ordering), `created_at`.

**One missing field:**

`InventoryLot` has no `consumed_cost_usdc` field. This is not strictly required because consumed cost can be derived as `cost_usdc × (1 − remaining_size/size)`, but storing it explicitly would make the `realized_pnl_fifo` accumulation query simpler and avoids floating-point reconstruction. This is a performance/safety convenience, not a blocking gap.

**Verdict:** `InventoryLot` is sufficient as-is. No structural changes required. `consumeFifo()` is the correct interface method. The only recommendation is to consider adding `consumed_cost_usdc` as a persisted field to simplify realized PnL queries, but this can be deferred.

---

### Q3 — Tail Cost: how is "open_tail_cost" computed from domain types?

**The question:**
HR12 and HR13 reference "tail cost" and `open_tail_cost`. How is this computed? What fields on `Position` / `FamilyState` support it?

**Computation chain:**

```
open_tail_cost_usdc (FamilyState.current_tail_cost_usdc)
  = SUM of cost_usdc × (remaining_size / size)
    over all InventoryLot records where:
      family_id = this family
      AND remaining_size > 0
```

In other words: for every unconsumed lot in the family, its contribution to tail cost is the proportional cost of the remaining unexited inventory.

**Domain fields involved:**

| Field | Type | Role |
|---|---|---|
| `InventoryLot.cost_usdc` | float | Full cost basis of the lot at entry |
| `InventoryLot.remaining_size` | float | How much is still held |
| `InventoryLot.size` | float | Original lot size (denominator for proportion) |
| `FamilyState.current_tail_cost_usdc` | float | Aggregated tail cost, updated after every fill |
| `FamilyState.tail_adjusted_pnl_live` | float | `local_realized_pnl_fifo − current_tail_cost_usdc` |
| `FamilyEvidence.open_tail_cost_usdc` | float | Snapshot value from last evidence validation cycle |
| `FamilyEvidence.tail_adjusted_pnl` | float | Snapshot value from last evidence validation cycle |

**Two representations of tail cost:**

1. **Evidence-layer snapshot** (`FamilyEvidence.open_tail_cost_usdc`): computed during the analysis/validation cycle. Represents the state of knowledge when the family was last assessed. This is what was used in the hypothesis tests.

2. **Runtime live value** (`FamilyState.current_tail_cost_usdc`): recomputed after every fill by summing open lots. This is the decision-making value for pre-trade gates and quarantine triggers.

**Position's role:**

`Position.cost_basis_usdc` on the `Position` type is a coarser aggregate (total cost for the position). It supports dust detection (`PositionStatus.Dust`) and high-level inventory sizing. However, it is **not** the right source for FIFO tail cost computation — that must use `InventoryLot` records to respect lot ordering. `Position.cost_basis_usdc` could drift from the sum of its lots' remaining costs if lots are partially consumed.

**Missing field on Position:**

`Position` has no `is_tail` boolean flag. A position becomes a "tail" position when it fails to attract a repricing exit within `max_tail_hold_hours`. Without this flag, the distinction between a normal open position and a stale tail position can only be inferred from timestamps. **Recommended addition: `Position.is_tail: boolean` set by the risk engine when `now − opened_at > max_tail_hold_hours`.** This enables `PositionRepository.getDustByFamily()` to be extended or supplemented with a `getTailByFamily()` method that surfaces stale inventory for pruning.

---

### Q4 — Session Windows: where does this live in the domain model?

**The question:**
HR14 (in the rulebook) is about data source authority. The document asks about "HR14 session enforcement." Based on context, this refers to the session window enforcement from HR3. Where does session enforcement live?

**Domain model location:**

Session enforcement lives in **two places**, with distinct roles:

**Layer 1 — FamilyRules (static configuration):**

`SessionRules` on `FamilyRules` defines the per-family session policy:
- `active_windows_utc: TimeWindow[]` — when aggressive entries are permitted
- `reduced_windows_utc: TimeWindow[]` — when reduced entries are permitted
- `weekend_mode: WeekendMode` — weekend behaviour
- `weekday_bias: WeekdayBias` — weekday preference

`UniverseRules.session_mode` provides a per-family override:
- `"active-window"` — enforce the window policy
- `"reduced"` — always reduced regardless of time
- `"always-reduced"` — same as reduced but more explicit

This is a **configuration concern** — loaded from YAML, persisted in `family_rules`, read at startup and on reload. It does not change during a trading session unless the operator reloads rules.

**Layer 2 — Risk/Inventory engine (runtime enforcement):**

The Risk engine reads `SessionRules` and `UniverseRules.session_mode` from the loaded `FamilyRule` at pre-trade gate check #3 (as listed in `05_strategy_compliance.md` section 2). It compares current UTC time against `active_windows_utc` and `reduced_windows_utc` to determine whether to approve or reduce/reject the signal.

`FamilyState` does **not** currently carry a live `session_window_active: boolean` field. This means the Risk engine must recompute the window check on every signal evaluation rather than reading cached state. This is correct behaviour (avoids stale window state) and requires no domain change.

**Is it a FamilyRules field, a runtime concern, or both?**

Both — but with clear ownership:
- `FamilyRules.session` owns the **policy** (what the windows are).
- The Risk engine owns the **enforcement** (whether the current moment falls within a window).
- `FamilyState` does not need to mirror this — the window check is stateless against wall-clock time.

**Gap:** The Strategy module is also supposed to reduce signal generation rate outside the active window (not just have Risk reject signals). This architectural boundary is not enforced by any domain type — it is a behavioural contract between Strategy and Risk modules. No domain type change needed, but the implementation guide should document that Strategy reads `SessionRules` independently of Risk (both layers check, for different purposes: Strategy to avoid generating wasted signals; Risk as a hard gate).

---

### Q5 — Family State Machine: transitions and domain events

**The question:**
`probe-only → scaled → reduce-only → quarantine`. What triggers each transition? What domain events correspond to each?

#### State: `probe-only`

**Entry condition:** Default for all new families. Also re-entered from `quarantine` or `reduce-only` via operator manual re-promotion after tail positions are resolved.

**Allowed actions:** Small probe entries only. No scale-in. No high-price. No heavy campaigns. No two-sided.

**Domain representation:** `FamilyState.runtime_mode = "probe-only"` AND `FamilyEvidence.promotion_state = "probe-only"`.

**Transition trigger to `scaled`:**
- `ScaleInRules.require_positive_recycle_history_for_scale = true` is satisfied
- `FamilyEvidence.tail_adjusted_pnl > 0`
- `FamilyEvidence.local_trade_count >= threshold` (threshold not yet formalised in domain — see HR2 gap)
- `FamilyEvidence.successful_reprice_exit_count >= threshold` (field missing — see HR2 gap)
- Operator approves (v1 is semi-automatic for this transition)

**Domain event emitted:** `FamilyStateChanged { prev_mode: "probe-only", new_mode: "active" }` — though note that `"active"` in `RuntimeMode` corresponds to `scaled` in `promotion_state`. The naming is slightly inconsistent: `RuntimeMode.Active` maps to what the strategy layer calls `scaled`. This is a minor naming gap.

---

#### State: `scaled`

**Entry condition:** Positive recycle evidence confirmed. Operator has approved.

**Allowed actions:** Normal entries. Scale-in up to `default_max_buys_per_leg`. Heavy campaigns if `allow_heavy_campaigns = true`. Two-sided if `allow_two_sided = true`.

**Domain representation:** `FamilyState.runtime_mode = "active"` AND `FamilyEvidence.promotion_state = "scaled"`.

**Transition triggers:**

To `reduce-only`:
- `FamilyState.tail_adjusted_pnl_live` is declining toward zero (trend-based, not threshold breach)
- Operator override (`OperatorAction.action_type = "set-reduce-only"`)
- **Domain event:** `FamilyStateChanged { prev_mode: "active", new_mode: "reduce-only" }` + `OperatorActionApplied`

To `quarantine` (skipping `reduce-only`):
- `FamilyState.tail_adjusted_pnl_live < 0` AND `FamilyIdentity.regime = "threshold"` (automatic per HR12)
- `FamilyState.current_tail_cost_usdc > TailSuppressionRules.tail_quarantine_threshold_usdc`
- `current_tail_cost_usdc / local_realized_pnl_fifo > TailSuppressionRules.tail_quarantine_threshold_ratio`
- Operator override (`OperatorAction.action_type = "set-quarantine"`)
- **Domain event:** `FamilyStateChanged { prev_mode: "active", new_mode: "quarantine" }` + optionally `OperatorActionApplied`

---

#### State: `reduce-only`

**Entry condition:** Declining edge or operator restriction.

**Allowed actions:** Exit existing positions only. No new entries.

**Domain representation:** `FamilyState.runtime_mode = "reduce-only"` AND `UniverseRules.action = "reduce-only"`.

**Transition triggers:**

To `quarantine`:
- `FamilyState.tail_adjusted_pnl_live` continues to deteriorate past quarantine thresholds
- **Domain event:** `FamilyStateChanged { prev_mode: "reduce-only", new_mode: "quarantine" }`

To `probe-only` (re-promotion):
- Operator manual re-promotion after positions closed and evidence revalidated
- `OperatorAction.action_type = "clear-quarantine"` (note: this action type name is misleading for a `reduce-only → probe-only` transition — no existing `action_type` precisely represents "demote to probe and revalidate")
- **Missing action type:** `OperatorAction.action_type` enum does not include `"promote-to-probe"` or `"reset-to-probe"`. The closest is `"resume"` which is ambiguous. **Recommended addition: `"reset-to-probe"` as an action type.**

---

#### State: `quarantine`

**Entry condition:** Tail has consumed edge, or operator-blocked.

**Allowed actions:** No new entries. No exits except force-pruning via dust cleanup process.

**Domain representation:** `FamilyState.runtime_mode = "quarantine"` + `FamilyState.quarantine_reason` populated.

**Transition trigger to `probe-only`:**
- Operator manual re-promotion only
- Tail positions must have been pruned or resolved
- Evidence must be revalidated
- `OperatorAction.action_type = "clear-quarantine"` — this one is correctly named
- **Domain event:** `FamilyStateChanged { prev_mode: "quarantine", new_mode: "probe-only" }` + `OperatorActionApplied`

---

#### State machine domain event summary

| Transition | Trigger type | Domain event(s) |
|---|---|---|
| `probe-only → scaled` | Evidence threshold + operator approval | `FamilyStateChanged` + `OperatorActionApplied` |
| `scaled → reduce-only` | Declining edge trend or operator override | `FamilyStateChanged` + optionally `OperatorActionApplied` |
| `scaled → quarantine` | Threshold breach (auto) or operator | `FamilyStateChanged` + optionally `OperatorActionApplied` |
| `reduce-only → quarantine` | Further deterioration past threshold | `FamilyStateChanged` |
| `quarantine → probe-only` | Operator only, after tail cleanup | `FamilyStateChanged` + `OperatorActionApplied` |
| `reduce-only → probe-only` | Operator only, after revalidation | `FamilyStateChanged` + `OperatorActionApplied` |

---

## Part 3 — Consolidated Gap Register

The following gaps are ranked by severity: **Blocking** (cannot enforce the rule without this), **Functional** (rule enforcement is ambiguous or fragile without this), **Convenience** (rule is enforceable but harder or less auditable).

| # | Gap | Severity | Affected HR | Recommended Fix |
|---|---|---|---|---|
| G1 | No `Leg` / `Campaign` entity. Buy count per campaign must be reconstructed from fills. | Functional | HR6, HR7, HR5 | Introduce `Leg` domain type and `LegRepository` with `getActiveLeg()`, `incrementBuyCount()`, `closeLeg()` |
| G2 | No `FillRepository.getBuyCountForMarket()` method (needed even without Leg, as minimum workaround) | Functional | HR6, HR7 | Add method `getBuyCountForMarket(marketId, familyId, since): number` |
| G3 | `FamilyEvidence` has no `successful_reprice_exit_count` field. Promotion criteria from HR2 are partially unquantifiable in the domain. | Functional | HR2 | Add `successful_reprice_exit_count: number` to `FamilyEvidence` and to `family_evidence` table |
| G4 | No `Position.is_tail` boolean flag. Stale tail positions cannot be distinguished from normal open positions without time arithmetic on every query. | Convenience | HR12, HR13 | Add `is_tail: boolean` to `Position`; set by Risk engine when `now − opened_at > rules.exit.max_tail_hold_hours` |
| G5 | `OperatorAction.action_type` has no `"reset-to-probe"` value. The `reduce-only → probe-only` state transition has no precise operator action representation. | Convenience | HR2, state machine | Add `"reset-to-probe"` to the `action_type` union |
| G6 | `RuntimeMode.Active` does not align with `PromotionState.Scaled`. The same state has two different names across `FamilyState` and `FamilyEvidence`. | Convenience | HR2, HR6, HR7 | Either rename `RuntimeMode.Active` to `RuntimeMode.Scaled`, or document the mapping explicitly in the domain type file |
| G7 | No `FamilyRulesRepository.getByRegime()` method. Bulk operations on threshold families (e.g., setting `threshold_cleanup_required = true` during catalog load) require a full scan of all rules. | Convenience | HR12 | Add `getByRegime(regime: Regime): FamilyRule[]` to `FamilyRulesRepository` |
| G8 | Promotion criteria thresholds (minimum trade count, minimum reprice exit count) for `probe-only → scaled` are not formalised as fields anywhere in the domain. They must live as hardcoded constants in the Risk engine. | Functional | HR2, HR15 | Add `promotion_min_trade_count: number` and `promotion_min_reprice_exits: number` to `ScaleInRules`, with v1 defaults |

---

## Part 4 — Overall Sufficiency Verdict

Of the 14 Hard Rules:

- **10 rules are fully supported** by the current domain model without any additions: HR1, HR3, HR4, HR8, HR9, HR10, HR11, HR12 (blocking fields present), HR13, HR14.
- **4 rules have functional gaps** that make enforcement ambiguous, fragile, or incomplete without domain additions: HR2 (promotion criteria not quantifiable), HR5 (confirmed campaign qualifier requires Leg), HR6 (buy-count enforcement), HR7 (buy-count enforcement).

None of the 14 rules are **blocked** — all can be enforced in some form using the current model. But the four rules with functional gaps carry correctness risk in the enforcement logic, and the absence of a `Leg` entity is the single most significant structural gap.

The recommended priority order for addressing gaps: **G1 (Leg entity) → G3 (reprice exit count) → G8 (promotion thresholds) → G2 (workaround method if G1 is deferred) → G5/G6 (naming cleanup) → G4/G7 (convenience).**
