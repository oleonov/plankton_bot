# Strategy Compliance: Rulebook to Runtime Mapping

Generated: 2026-03-13
Status: **Legacy — superseded for the trading critical path** (see below).

This document verifies that the runtime architecture (arch_tmp.md) correctly serves the validated strategy rulebook (validated_strategy_rulebook.md) and the family rules schema (family_rules_schema_v1.md). It identifies what each runtime module must enforce, where gaps exist, and provides a compliance checklist for implementation.

> **Canonical source-of-truth (current):** `research_plankton/plankton-analysis/06_algorithm_spec.md` for algorithm behavior, and `docs/superpowers/specs/2026-04-16-remove-familyid-critical-path-design.md` for how the runtime wires it.
>
> The algo critical path (MarketSelection → state → decision → size → risk gate → execution) operates on `tokenId`/`conditionId`. `familyId` is an **optional annotation** carried through for Discovery and family-exposure monitoring only — it is never a gate.
>
> Concretely, this means:
>
> - A Signal with `familyId = null` is valid and flows through the risk gate unchanged. AlgoRiskGate checks only token-level constraints (no open buy order for token, token in-flight cap, min order size). It does not call `rulesProvider.getRule(familyId)`, does not consult `familyStateRepo`, and does not enforce family-level caps on the algo path.
> - Family-scoped rules in `config/family_rules.yaml` (universe/entry/scale_in/exit/session/tail_suppression/two_sided) still load at startup. They remain available to legacy family-scoped features (Discovery, `FamilyExposureCalculator`, stale-pruning polling loop, operator commands) but are **not** applied to algo-path signals regardless of whether `familyId` is present.
>
> The HR1-HRn mappings below predate the algo engine and remain relevant only for legacy family-scoped features (Discovery, evidence promotion, family exposure accounting, manual operator actions). Do not read them as requirements for the algo trading path.
>
> **Historical Universe Filter (spec §0):** The spec defines `trade_count > 0 → INCLUDE; Fallback → EXCLUDE` as the first selection gate. This is **intentionally omitted** from the live runtime — Gamma does not expose `trade_count` on `ClobMarket`, and dropping the gate was a conscious rollout decision (see `2026-04-14-market-selection-layer-design.md` §2, `2026-04-16-market-selection-layer-design.md` §1.1, and `2026-04-16-ungate-scanner-from-family-design.md` §3.3). The live universe is therefore wider than the spec's historical universe by design. Zero-activity markets (`volume24h = 0`, `lastTradePrice = null`) still reach the pre-entry filter. `MarketSelectionCache` carries a regression test locking in this behavior.

---

## 1. Rulebook to Runtime Module Mapping

For each hard rule, the responsible runtime module and the enforcement mechanism.

### HR1. Selection unit is family + regime + horizon, not category

| Attribute      | Value                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Market Catalog / Normalization + Family Rules Engine                                                                                                                                                                                                 |
| Enforcement    | Market Catalog must produce a `family_id = family_key:regime:horizon` for every market. Family Rules Engine must reject any signal referencing a market that has not been mapped to a family_id. Strategy/Scanner must never select by raw category. |
| Schema fields  | `family_id`, `family_key`, `regime`, `horizon` (Identity layer)                                                                                                                                                                                      |

### HR2. New family starts in probe-only mode

| Attribute      | Value                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Family Rules Engine + Risk/Inventory                                                                                                                                                                                                                                                                                                                 |
| Enforcement    | Family Rules Engine must initialize every new family with `promotion_state = probe-only` and `entry_mode = probe-first`. Risk/Inventory must reject scale-in attempts for any family still in probe-only state. Promotion to `scaled` requires recycle evidence (computed in Evidence layer, gated by `require_positive_recycle_history_for_scale`). |
| Schema fields  | `promotion_state`, `entry_mode`, `max_initial_notional_usdc`, `require_positive_recycle_history_for_scale`                                                                                                                                                                                                                                           |

### HR3. Active trading window 14:00-21:00 UTC

| Attribute      | Value                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime module | Strategy/Scanner + Risk/Inventory                                                                                                                                                                                                                                                          |
| Enforcement    | Strategy module must check current UTC time before generating entry signals. During the active window, normal entry logic applies. Outside the window, only reduced-mode entries are allowed (SH2 -- reduced, not hard off). Risk/Inventory must enforce `session_mode` from family rules. |
| Schema fields  | `active_windows_utc`, `reduced_windows_utc`, `session_mode`, `weekend_mode`                                                                                                                                                                                                                |

### HR4. Default entry model is probe-first

| Attribute      | Value                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Strategy/Scanner + Risk/Inventory                                                                                                                                                                                                                                          |
| Enforcement    | Strategy must generate initial entry signals sized according to `max_initial_notional_usdc`. Risk/Inventory must reject any first-entry that exceeds probe sizing. Broad cheap spraying is blocked by `max_probe_count_per_market` and `max_new_markets_per_session` caps. |
| Schema fields  | `entry_mode`, `max_initial_notional_usdc`, `max_probe_count_per_market`                                                                                                                                                                                                    |

### HR5. No one-shot high-price entries in unproven families

| Attribute      | Value                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Risk/Inventory                                                                                                                                                                                                                                           |
| Enforcement    | Risk module must check: if `promotion_state` is not `scaled` and entry price >= `high_price_threshold` (default 0.20), reject unless the entry is part of an existing confirmed campaign. The field `allow_high_price_one_shot` must default to `false`. |
| Schema fields  | `allow_high_price_one_shot`, `high_price_threshold`, `require_proven_family_above_price`, `promotion_state`                                                                                                                                              |

### HR6. Standard scale-in: 2-3 buys

| Attribute      | Value                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Risk/Inventory                                                                                                                                                                                             |
| Enforcement    | Risk module must track buy count per leg. When buy count reaches `default_max_buys_per_leg` (default 3), further buys for that leg must be rejected unless `allow_heavy_campaigns` is true for the family. |
| Schema fields  | `default_max_buys_per_leg`, `scale_mode`                                                                                                                                                                   |

### HR7. Heavy campaigns (4+ buys) only in proven families

| Attribute      | Value                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Risk/Inventory + Family Rules Engine                                                                                                                                                                                                                                  |
| Enforcement    | Risk module must check `allow_heavy_campaigns` flag before permitting buy count > `default_max_buys_per_leg`. Family Rules Engine must only set `allow_heavy_campaigns = true` for families where `evidence_status = confirmed` and `heavy_campaign_eligible = true`. |
| Schema fields  | `allow_heavy_campaigns`, `heavy_max_buys_per_leg`, `heavy_campaign_eligible`                                                                                                                                                                                          |

### HR8. Primary exit via repricing (SELL), not resolution

| Attribute      | Value                                                                                                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Strategy/Scanner (exit logic)                                                                                                                                                                                                                                           |
| Enforcement    | Strategy must generate SELL signals as the primary exit path. The `primary_profit_model` must be `sell-into-strength`. Resolution holding is permitted only when `resolution_holding_allowed = true` for the family. Exit logic must not default to hold-to-resolution. |
| Schema fields  | `exit_mode`, `primary_profit_model`, `resolution_holding_allowed`                                                                                                                                                                                                       |

### HR9. Exit targets meaningful repricing, not micro-scalp

| Attribute      | Value                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime module | Strategy/Scanner (exit logic)                                                                                                                                                                                                                                                                    |
| Enforcement    | Exit logic should target the 20-50% ROI band as the central case. The `target_roi_band_low` and `target_roi_band_high` fields guide this. `allow_runner_extension` permits rare large winners to run beyond the normal band. The system must not be hardcoded to exit on the first minimal tick. |
| Schema fields  | `target_roi_band_low`, `target_roi_band_high`, `allow_runner_extension`, `prefer_fast_recycle`                                                                                                                                                                                                   |

### HR10. Two-sided trading is selective, not global

| Attribute      | Value                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime module | Risk/Inventory + Family Rules Engine                                                                                                                                                                                                                                                 |
| Enforcement    | Risk module must check `allow_two_sided` before permitting any opposite-side entry. Family Rules Engine must default `allow_two_sided = false`. Only families with `both_sided_eligible = true` in Evidence layer and explicit operator or automated approval can have this enabled. |
| Schema fields  | `allow_two_sided`, `two_sided_mode`, `both_sided_eligible`                                                                                                                                                                                                                           |

### HR11. Primary risk metric is tail-adjusted: realized_pnl_fifo - open_tail_cost

| Attribute      | Value                                                                                                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Risk/Inventory                                                                                                                                                                                                                                                                   |
| Enforcement    | Risk module must continuously compute `tail_adjusted_pnl_live = realized_pnl_fifo - current_tail_cost_usdc` per family. This metric must be the primary family health score. It must feed into quarantine decisions and promotion/demotion logic. It must not be analytics-only. |
| Schema fields  | `tail_adjusted_pnl_live`, `current_tail_cost_usdc`, `local_realized_pnl_fifo`                                                                                                                                                                                                    |

### HR12. Threshold families require tail-control

| Attribute      | Value                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Risk/Inventory + Family Rules Engine                                                                                                                                                                                                     |
| Enforcement    | For any family with `regime = threshold`, the field `threshold_cleanup_required` must be `true`. Risk module must quarantine threshold families when `tail_adjusted_pnl_live < 0`. New entries must be blocked once quarantine triggers. |
| Schema fields  | `threshold_cleanup_required`, `tail_quarantine_threshold_usdc`, `tail_quarantine_threshold_ratio`                                                                                                                                        |

### HR13. Long-dated sports outrights / awards / leaderboards excluded from default universe

| Attribute      | Value                                                                                                                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime module | Family Rules Engine (universe management)                                                                                                                                                                                                                                                                                       |
| Enforcement    | Family Rules Engine must set `enabled = false` and `action = blocked` for families matching long-dated sports outright, award, and leaderboard patterns. Market Catalog normalization must tag these families with appropriate `regime` (e.g., `tournament`) and `horizon` (e.g., `season-long`) to enable automated filtering. |
| Schema fields  | `enabled`, `action`, `strategy_profile = restricted`                                                                                                                                                                                                                                                                            |

### HR14. Remote closed snapshot is not source of truth

| Attribute      | Value                                                                                                                                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime module | Persistence + Reconciliation                                                                                                                                                                                                                                                                                             |
| Enforcement    | Primary P&L computation must use local FIFO analysis. Remote closed data may be ingested as auxiliary/helper data but must not override local tail-adjusted calculations. Reconciliation module must flag divergences between local and remote state but local FIFO + tail cost is authoritative for strategy decisions. |
| Schema fields  | `remote_closed_realized_pnl` (recommended, not required)                                                                                                                                                                                                                                                                 |

---

## 2. Risk Engine Requirements

The Risk/Inventory module is the central enforcement point. It must compute and check the following at runtime.

### Must Compute (per family, continuously)

| Metric                   | Formula / Source                                   | Update trigger                    |
| ------------------------ | -------------------------------------------------- | --------------------------------- |
| `tail_adjusted_pnl_live` | `local_realized_pnl_fifo - current_tail_cost_usdc` | Every fill, every position change |
| `current_tail_cost_usdc` | Sum of cost basis of all open positions in family  | Every fill, reconciliation        |
| `open_value_usdc`        | Current market value of open family inventory      | Market data update                |
| `open_position_count`    | Count of open positions                            | Every fill                        |
| `open_dust_count`        | Count of positions below dust threshold            | Every fill                        |
| `active_market_count`    | Count of distinct markets with open positions      | Every fill                        |
| `buy_count_per_leg`      | Number of buys in current active leg               | Every buy fill                    |

### Must Check (pre-trade gates)

Every entry signal from Strategy must pass through these gates in order:

1. **Family enabled**: `enabled = true` and `action = trade`
2. **Family not quarantined**: `runtime_mode` is not `quarantine` or `reduce-only`
3. **Session window**: current time within allowed window for family's `session_mode`
4. **Promotion state gate**: if `promotion_state = probe-only`, reject scale-in and high-price entries
5. **Price band**: entry price within `[min_entry_price, max_entry_price]`
6. **One-shot high-price block**: if price >= `high_price_threshold` and family not proven, reject
7. **Scale-in cap**: buy count for leg must be < `default_max_buys_per_leg` (or `heavy_max_buys_per_leg` if heavy allowed)
8. **Two-sided gate**: if opposite-side entry, `allow_two_sided` must be `true`
9. **Inventory caps**: `open_value_usdc < max_open_value_usdc`, `active_market_count < max_active_markets`, `open_dust_count < max_dust_positions`
10. **Tail quarantine check**: if `tail_adjusted_pnl_live < -tail_quarantine_threshold_usdc` or ratio exceeds `tail_quarantine_threshold_ratio`, block and quarantine

### Must Trigger (post-trade actions)

- After every fill: recompute all live metrics for affected family
- After metric recomputation: check quarantine triggers
- If quarantine triggers: set `runtime_mode = quarantine`, record `quarantine_reason`, block new entries
- If threshold family and `tail_adjusted_pnl_live < 0`: force quarantine (HR12)

---

## 3. Strategy Module Requirements

### MUST do

1. Select markets using `family_id` (family_key + regime + horizon), never by raw category (HR1, Z1)
2. Generate probe-sized initial entries for new/unproven families (HR2, HR4)
3. Generate SELL-based exit signals as the primary monetization path (HR8)
4. Target meaningful repricing bands for exits, not minimum tick (HR9)
5. Respect session window: bias signal generation toward 14:00-21:00 UTC (HR3)
6. Check `promotion_state` before generating scale-in signals (HR2, HR6)
7. Pass all candidate signals through Risk/Inventory before forwarding to Execution (arch principle 3)
8. Respect family-level `entry_mode`, `exit_mode`, and `scale_mode` parameters

### MUST NOT do

1. Select markets by category alone (Z1)
2. Generate one-shot high-price entries for unproven families (Z2, HR5)
3. Generate unlimited cheap-tail accumulation signals (Z3)
4. Enable two-sided logic globally across all families (Z4, HR10)
5. Use realized PnL alone to evaluate family quality (Z5)
6. Continue generating new entries for a family where tail has consumed edge (Z6)
7. Transfer parameters between different horizons of the same topic (Z7)
8. Include long-dated sports outrights in default universe (Z8, HR13)
9. Place or cancel orders directly -- must go through Risk then Execution (arch principle 2)

---

## 4. Family State Machine

### v1 States

```text
  [unknown] --> [probe-only] --> [scaled] --> [quarantine]
                    ^               |              |
                    |               v              |
                    |          [reduce-only] <------+
                    |               |
                    +---------------+
                  (re-promotion after evidence recovery)
```

### State Definitions

| State         | Meaning                                            | Allowed actions                                                                                                                                      |
| ------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe-only`  | New or unproven family. Limited trust.             | Small probe entries only. No scale-in. No high-price. No heavy campaigns. No two-sided.                                                              |
| `scaled`      | Proven family with recycle evidence.               | Normal entries. Scale-in up to `default_max_buys_per_leg`. Heavy campaigns if `allow_heavy_campaigns = true`. Two-sided if `allow_two_sided = true`. |
| `reduce-only` | Family losing edge or operator-restricted.         | Exit existing positions only. No new entries.                                                                                                        |
| `quarantine`  | Family tail has consumed edge or operator-blocked. | No trading activity. Positions may be force-pruned.                                                                                                  |

### Transition Conditions

| From          | To            | Condition                                                                                                                                                                                                     |
| ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe-only`  | `scaled`      | `require_positive_recycle_history_for_scale = true` AND family shows positive recycle evidence: `tail_adjusted_pnl > 0` AND `local_trade_count >= threshold` AND repeated successful repricing exits observed |
| `scaled`      | `reduce-only` | `tail_adjusted_pnl_live` declining toward zero OR operator override                                                                                                                                           |
| `scaled`      | `quarantine`  | `tail_adjusted_pnl_live < 0` (automatic for threshold families per HR12) OR `tail_quarantine_threshold_usdc` breached OR `tail_quarantine_threshold_ratio` breached                                           |
| `reduce-only` | `quarantine`  | `tail_adjusted_pnl_live` continues to deteriorate past quarantine threshold                                                                                                                                   |
| `quarantine`  | `probe-only`  | Operator manual re-promotion after evidence review AND tail positions pruned/resolved                                                                                                                         |
| `reduce-only` | `probe-only`  | Operator manual re-promotion after positions closed and evidence revalidated                                                                                                                                  |

### v1 Automation vs. Operator Control

| Transition                    | v1 automation level                                                                                       |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `probe-only` -> `scaled`      | Semi-automatic: system flags eligible families, operator approves                                         |
| `scaled` -> `quarantine`      | Automatic for threshold families (HR12). Rule-driven for others when `tail_adjusted_pnl_live < threshold` |
| `scaled` -> `reduce-only`     | Operator-driven or simple rule-driven                                                                     |
| `quarantine` -> `probe-only`  | Operator-only                                                                                             |
| `reduce-only` -> `probe-only` | Operator-only                                                                                             |

---

## 5. Compliance Checklist

This checklist is for use during implementation. Every item must be verified before the module is considered complete.

### Market Catalog / Normalization

- [ ] Every market is mapped to a `family_id` (family_key:regime:horizon) before it reaches Strategy
- [ ] Raw category is stored as metadata only, never used as selection unit
- [ ] Long-dated sports outrights, awards, and leaderboards are tagged and excluded from default universe
- [ ] Horizon and regime are explicitly classified, not inferred from category

### Family Rules Engine

- [ ] All four schema layers are implemented: Identity, Evidence, Rules, Runtime State
- [ ] New families initialize with `promotion_state = probe-only`
- [ ] `allow_high_price_one_shot` defaults to `false`
- [ ] `allow_two_sided` defaults to `false`
- [ ] `allow_heavy_campaigns` defaults to `false`
- [ ] `threshold_cleanup_required = true` for all threshold-regime families
- [ ] `default_max_buys_per_leg = 3` as v1 default
- [ ] `active_windows_utc` includes `14:00-21:00 UTC` as default active block
- [ ] State machine supports all four states: `probe-only`, `scaled`, `reduce-only`, `quarantine`
- [ ] Derived fields (`tail_adjusted_pnl`, `open_tail_cost_usdc`, etc.) are computed, not manually set

### Risk / Inventory Module

- [ ] `tail_adjusted_pnl_live` computed per family after every fill
- [ ] `current_tail_cost_usdc` computed per family after every fill
- [ ] Pre-trade gate checks all 10 gates listed in Section 2
- [ ] Quarantine triggers automatically for threshold families when `tail_adjusted_pnl_live < 0`
- [ ] Dust count tracked and capped per family at `max_dust_positions`
- [ ] Open value capped per family at `max_open_value_usdc`
- [ ] Active market count capped per family at `max_active_markets`
- [ ] Buy count per leg tracked and enforced against `default_max_buys_per_leg`
- [ ] Session window enforced before accepting entry signals
- [ ] Two-sided entries rejected unless `allow_two_sided = true` for family
- [ ] High-price one-shot entries rejected for unproven families

### Strategy / Scanner

- [ ] Market selection uses `family_id`, never raw category
- [ ] Entry signals for new families are probe-sized
- [ ] Exit signals use SELL as primary path, not hold-to-resolution
- [ ] Exit targets meaningful repricing bands (not micro-scalp)
- [ ] Session bias applied: aggressive during 14:00-21:00 UTC, reduced outside
- [ ] All signals pass through Risk/Inventory before reaching Execution
- [ ] No broad cheap-ticket spraying logic
- [ ] No parameter sharing across different horizons of same topic

### Execution Engine

- [ ] Only module that places or cancels orders on exchange
- [ ] Receives commands only from Risk/Inventory (post-gate)
- [ ] Every command carries unique `command_id`
- [ ] Deduplication of commands before placing
- [ ] Publishes fill events that feed back into Risk/Inventory metric computation

### Reconciliation

- [ ] Local FIFO P&L is the authoritative source, not remote closed snapshot
- [ ] Divergences between local and exchange state are flagged
- [ ] Startup reconciliation runs before strategy is enabled
- [ ] Position and fill reconciliation feeds into `current_tail_cost_usdc` computation

### Persistence

- [ ] `family_catalog`, `family_evidence`, `family_rules`, `family_runtime_state` are separate storage concerns
- [ ] `tail_adjusted_pnl_live` is persisted and queryable
- [ ] `quarantine_reason` is recorded when quarantine triggers

---

## 6. Gaps and Risks

Issues where the current architecture draft may not fully cover rulebook requirements.

### Gap 1: No explicit dust-pruning mechanism in architecture

**Rulebook requirement**: Z3 prohibits unlimited cheap-tail accumulation. Schema includes `stale_tail_prune_enabled` and `max_dust_positions`. The strategy should force-prune stale low-value positions.

**Architecture gap**: The arch draft mentions Risk/Inventory enforcing dust caps, but there is no explicit module or process described for actively pruning (selling) stale dust positions. Dust cap enforcement prevents new accumulation but does not clean up existing dust.

**Recommendation**: Risk/Inventory or a dedicated cleanup process must be able to generate force-sell signals for stale dust positions. This should be a periodic background task within the runtime, feeding SELL commands through Execution.

### Gap 2: Leg tracking not explicitly modeled

**Rulebook requirement**: HR6 and HR7 require tracking buy count per leg (2-3 default, 4+ heavy). The leg is the unit of scale-in tracking.

**Architecture gap**: The arch draft mentions positions and fills but does not explicitly define a "leg" as a runtime concept. Without a clear leg model, enforcing scale-in caps becomes ambiguous.

**Recommendation**: Define a `leg` or `campaign` as a first-class runtime object: a sequence of related buys on one side of one market within a family, terminated by a full exit or timeout. Persistence must track legs.

### Gap 3: Promotion logic not specified in architecture

**Rulebook requirement**: HR2 requires that promotion from probe-only to scaled happens only after recycle evidence. HR15 (evidence from hypothesis tests) shows high-history families are materially stronger.

**Architecture gap**: The arch draft acknowledges the state machine but says "automatic transition logic can stay smaller in v1." The criteria for what constitutes sufficient recycle evidence are not specified in the architecture.

**Recommendation**: Define minimum promotion criteria in the Family Rules Engine: minimum trade count, minimum positive tail-adjusted PnL, minimum number of successful repricing exits. Even if v1 promotion is operator-approved, the system must compute and display whether criteria are met.

### Gap 4: Session-mode enforcement location ambiguous

**Rulebook requirement**: HR3 requires active window bias. SH2 says reduced mode outside, not hard off.

**Architecture gap**: The arch draft does not clarify whether session enforcement lives in Strategy (signal generation) or Risk/Inventory (pre-trade gate). Both should participate, but the boundary must be explicit.

**Recommendation**: Strategy should reduce signal generation rate outside the active window. Risk/Inventory should enforce `session_mode` as a hard gate. Both layers must be aware of the family-level session rules.

### Gap 5: No explicit tail-cost computation method in architecture

**Rulebook requirement**: HR11 defines `realized_pnl_fifo - open_tail_cost` as the primary health metric. The word "FIFO" is load-bearing -- cost basis must be computed via first-in-first-out.

**Architecture gap**: The arch draft mentions tail-adjusted health but does not specify that FIFO is the required cost-basis method. An incorrect cost-basis method would silently produce wrong health scores.

**Recommendation**: Persistence and Risk/Inventory must implement FIFO cost-basis tracking for all positions. This must be specified as a non-negotiable implementation detail.

### Gap 6: Family-to-market mapping for new markets not covered

**Rulebook requirement**: HR1 requires every market be mapped to a family. SH1 notes that topic-family matching is still heuristic.

**Architecture gap**: The Market Catalog / Normalization module is described but no fallback behavior is defined for markets that cannot be confidently mapped to a family.

**Recommendation**: Markets that cannot be mapped must default to `action = monitor` (no trading) until manually or semi-automatically classified. The system must never trade a market with an unmapped or ambiguous family.

### Gap 7: Threshold-family identification not automated

**Rulebook requirement**: HR12 says threshold families need special tail-control. The schema defines `threshold_cleanup_required`.

**Architecture gap**: Market Catalog must be able to identify threshold-regime markets. The arch draft does not specify how regime classification works for new markets.

**Recommendation**: Regime classification rules (threshold, price-range, directional-updown, etc.) must be part of the Market Catalog normalization logic, either rule-based or from curated config. Threshold-regime families must automatically get `threshold_cleanup_required = true`.

---

## 7. v1 Strategy Profile

The minimum first strategy profile to implement, derived from Rulebook section 7.

### Profile name: `default-v1`

### Selection

- Unit of selection: `family_id` (family_key + regime + horizon)
- Universe: curated allowlist of families with `evidence_status = confirmed` or `partial`
- Excluded: long-dated sports outrights, awards, leaderboards, unclassified markets
- Two-sided: disabled by default, enabled per-family only for proven candidates

### Entry

- Mode: `probe-first`
- New families: probe-only, small initial notional
- Proven families: normal entry permitted
- Price band: `min_entry_price` to `max_entry_price` per family (curated in v1)
- High-price one-shot: blocked (`allow_high_price_one_shot = false`)
- Session bias: aggressive entries during 14:00-21:00 UTC, reduced outside

### Scale-in

- Default: `default_max_buys_per_leg = 3`
- Heavy campaigns: disabled unless explicitly enabled per family
- Scale mode: `confirm-only` (require confirmation signal before adding)

### Exit

- Primary model: `sell-into-strength` (repricing SELL)
- Target ROI band: 20-50% as central case
- Runner extension: allowed (`allow_runner_extension = true`)
- Resolution holding: not primary, allowed as fallback
- Fast recycle: preferred (`prefer_fast_recycle = true`)

### Risk and tail control

- Primary metric: `tail_adjusted_pnl_live = realized_pnl_fifo - current_tail_cost_usdc`
- Quarantine trigger: automatic for threshold families when `tail_adjusted_pnl_live < 0`
- Dust caps: enforced per family (`max_dust_positions`)
- Inventory caps: enforced per family (`max_open_value_usdc`, `max_active_markets`)
- Stale pruning: enabled (`stale_tail_prune_enabled = true`)

### State machine

- Initial state for all families: `probe-only`
- Promotion to `scaled`: after operator review of positive recycle evidence
- Quarantine: automatic for threshold families, rule-driven for others
- Re-promotion: operator-only

### Operational sequence (from Rulebook section 7)

```
1. Select market by family_id (family + regime + horizon)
2. Check: is family proven by tail-adjusted history?
3. If new/weak: allow probe only
4. If confirmed: allow normal scale-in (2-3 buys)
5. If strong proven: allow heavy campaigns (4+ buys)
6. Primary exit: SELL on repricing
7. Two-sided recycling: only in explicitly approved family universe
8. After each cycle: recompute realized_pnl AND open_tail_cost
9. If tail consumes edge: quarantine the family
```

### What is not in v1

- Full sports universe (NF1)
- Broad cheap-ticket farming module (NF2)
- Cross-horizon parameter sharing (NF3)
- Resolution-first strategy core (NF4)
- Automated topic-level family clustering (SH1)
- Full automated state machine transitions (semi-automatic in v1)
