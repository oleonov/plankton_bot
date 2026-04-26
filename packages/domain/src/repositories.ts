import type { OrderStatus, ProfileId, SwitchState } from "./enums.js";
import type { FillId, OrderId, PositionId, TokenId, SwitchId, ReportId, ImportId } from "./ids.js";
import type {
  Fill,
  InventoryLot,
  Market,
  MarketResolution,
  MarketSnapshot,
  OperatorAction,
  OperatorCommand,
  Order,
  Position,
  PositionDrift,
  ExecutionPolicyObservation,
  Profile,
  ProfileSettings,
  ProfileSummary,
  RuntimeControlState,
  SwitchRequest,
  PreflightReport,
  ServiceHeartbeat,
  ConfigImport,
  AlgoDecisionRule,
  AlgoSizeRule,
  DecisionSignalLog,
  LegState,
  LegStateTransition,
  SettlementRecord,
} from "./types.js";

// ─── MarketRepository ────────────────────────────────────────────────────

/**
 * Tiered result from `findTrackedForPricingTiered`.
 * `executionCritical + entryCandidates` feed the WS stream (bounded by maxTokens).
 * `discoveryOnly` is polled via Gamma in rolling batches.
 */
export interface TrackedForPricing {
  /** Markets with open/dust positions or pending/open orders — never dropped from WS. */
  executionCritical: Market[];
  /** Active+tradable markets up to the remaining cap after executionCritical. */
  entryCandidates: Market[];
  /** Active+tradable markets beyond the cap — polled via discovery loop, not WS. */
  discoveryOnly: Market[];
}

export interface MarketRepository {
  /** Insert or update a market record. tokenId is the primary key. */
  save(market: Market): void;

  /**
   * Batch upsert in a single SQL transaction with a cached prepared statement.
   * Scanner write path: replaces per-token `save()` calls with one commit per
   * page to reduce commit count and allocation churn during the scan cycle.
   */
  saveBatch(markets: readonly Market[]): void;

  /** Find a market by its CLOB token ID (primary key). */
  findByTokenId(tokenId: TokenId): Market | null;

  /** Find markets by multiple token IDs (bulk lookup). */
  findByTokenIds(tokenIds: TokenId[]): Market[];

  /** Find all markets belonging to a condition (YES + NO outcome rows). */
  findByConditionId(conditionId: string): Market[];

  /** Find all markets currently marked active. */
  findActive(): Market[];

  /**
   * Iterate token IDs of every active market one at a time (cursor-based).
   * Preferred over `findActive()` during large scans to avoid materialising the
   * full tracked slice (~115k Market objects) simultaneously with other scan
   * state — reduces scanner transient peak anon-rss by ~70 MB per cycle.
   */
  iterateActiveTokenIds(): IterableIterator<TokenId>;

  /** Return every market row, active or inactive. */
  findAll(): Market[];

  /** Mark a market as inactive (active = 0). Used when a market resolves. */
  deactivate(tokenId: TokenId): void;

  /**
   * Deactivate every currently-active market whose token_id is NOT in
   * `discoveredTokenIds` AND NOT in `preservedTokenIds`, in a single SQL batch.
   * Returns the count of rows deactivated. Preferred over scanner-side loops
   * because it avoids loading Market rows into JS only to write them back.
   */
  deactivateMissing(
    discoveredTokenIds: ReadonlySet<string>,
    preservedTokenIds: ReadonlySet<string>,
    updatedAt: string,
  ): number;

  /**
   * Return all markets that need live pricing: tradable markets plus any with
   * an open position or open/pending order. Used by the pricing loop so it
   * never drops a market mid-trade even when `tradable` flips to false.
   *
   * @deprecated Use `findTrackedForPricingTiered` instead — this flat version
   *   returns the unbounded tradable universe and is kept only for existing tests
   *   and simulation/paper mode compatibility.
   */
  findTrackedForPricing(): Market[];

  /**
   * Return markets split into three tiers for bounded pricing subscription.
   *
   * **Tier semantics (v1 — available columns only):**
   *
   * 1. `executionCritical` — markets with an open/dust position OR pending/open
   *    order. Always included regardless of the cap. Expected cardinality 0–50.
   *
   * 2. `entryCandidates` — `active=1 AND tradable=1` markets NOT in
   *    executionCritical, ordered by:
   *    - `selection_status` priority: `matched_include` (0) >
   *      `step2_fallback_include` (1) > `unknown` (2)
   *    - `created_at DESC` within the same tier
   *    - `token_id ASC` as a deterministic tie-break
   *    Filled greedily up to `maxTokens - executionCritical.length`.
   *    When `executionCritical.length >= maxTokens`, `entryCandidates` is empty.
   *
   * 3. `discoveryOnly` — every remaining `active=1 AND tradable=1` market not
   *    in the first two tiers. No LIMIT — caller polls in rolling batches.
   *
   * Ranking uses only columns present in `markets` (`ledger.sql:10-32`).
   * No join to `market_snapshots`. Liquidity-aware ranking is a follow-up.
   *
   * @param opts.maxTokens - Total WS-tier cap: `executionCritical + entryCandidates ≤ maxTokens`
   *   (executionCritical is never dropped even if it exceeds maxTokens alone).
   */
  findTrackedForPricingTiered(opts: { maxTokens: number }): TrackedForPricing;

  /**
   * Look up the event_market_count stored for a given market slug.
   * Used by the /selection-rules/match API endpoint so the debugger can
   * evaluate STEP 2 fallback with the real event context instead of a
   * biased constant.
   * Returns null if no row exists for that slug.
   */
  findEventMarketCountBySlug(slug: string): number | null;
}

// ─── OrderRepository ─────────────────────────────────────────────────────

export interface OrderRepository {
  /** Persist a new order row. */
  save(order: Order): void;

  /** Find an order by its local order ID. */
  findById(id: OrderId): Order | null;

  /** Find an order by the deterministic client order ID. */
  findByClientOrderId(clientOrderId: string): Order | null;

  /** Find an order by the exchange-assigned order ID (fallback for fill matching). */
  findByExchangeOrderId(exchangeOrderId: string): Order | null;

  /** Return all orders whose status is pending or open. */
  findOpen(): Order[];

  /** Return all orders for a specific outcome token. */
  findByTokenId(tokenId: TokenId): Order[];

  /** Update the status (and optionally exchange_order_id) of an existing order. */
  updateStatus(id: OrderId, status: OrderStatus, exchangeOrderId?: string): void;

  /** Sum the notional (size_usdc) of all open buy orders. */
  sumOpenBuyNotional(): number;
}

export interface DecisionSignalLogRepository {
  insert(signal: DecisionSignalLog): void;
}

// ─── FillRepository ──────────────────────────────────────────────────────

export interface FillRepository {
  /** Persist a fill received from the exchange. */
  save(fill: Fill): void;

  /** Return true if a fill with the given ID already exists. */
  exists(fillId: FillId): boolean;

  /** Return all fills associated with a given order. */
  findByOrderId(orderId: OrderId): Fill[];

  /** Return all fills associated with any of the given orders. */
  findByOrderIds?(orderIds: OrderId[]): Fill[];

  /** Return all fills for a specific outcome token. */
  findByTokenId(tokenId: TokenId): Fill[];

  /** Return the most recent fills across all tokens. */
  findRecent(limit: number): Fill[];

  /** Return fills that have not yet been applied to a position or inventory lot. */
  findUnreconciled(): Fill[];

  /** Mark one or more fills as reconciled (applied to position/lot). */
  markReconciled(fillIds: FillId[]): void;

  /** Return the epoch ms of the most recent fill, or null if no fills exist. */
  getLatestTimestamp(): number | null;
}

// ─── PositionRepository ──────────────────────────────────────────────────

export interface PositionRepository {
  /** Insert or update a position. */
  save(position: Position): void;

  /** Find the position for a specific outcome token (at most one open per token). */
  findByTokenId(tokenId: TokenId): Position | null;

  /** Return all positions whose status is open or partially filled. */
  findOpen(): Position[];

  /** Return all positions whose status is dust. */
  findDust(): Position[];

  /** Return every position row, regardless of status. */
  findAll(): Position[];

  /** Return all open positions with the given entry style (e.g. "spray"). */
  findOpenByEntryStyle(entryStyle: string): Position[];
}

// ─── InventoryLotRepository ──────────────────────────────────────────────

export interface InventoryLotRepository {
  /** Record a new lot created from a fill. */
  save(lot: InventoryLot): void;

  /** Return all lots (open or exhausted) for a given outcome token. */
  findByTokenId(tokenId: TokenId): InventoryLot[];

  /** Return lots that still have remaining_size > 0 for a given position. */
  findOpen(positionId: PositionId): InventoryLot[];

  /**
   * Consume lots in FIFO order to account for a sell of `size` shares.
   * Updates remaining_size on each touched lot and returns the lots consumed.
   */
  consumeFifo(positionId: PositionId, size: number): { lot: InventoryLot; consumed: number }[];

  /** Zero out all remaining lots for a position (market resolution settlement). */
  settleAll(positionId: PositionId): void;
}

// ─── MarketResolutionRepository ──────────────────────────────────────────

export interface MarketResolutionRepository {
  /** Persist a market resolution record. */
  save(resolution: MarketResolution): void;

  /** Find a resolution by condition ID, or null if not yet resolved. */
  findByConditionId(conditionId: string): MarketResolution | null;

  /** Return all recorded resolutions. */
  findAll(): MarketResolution[];

  /** Update resolution, resolved_at, and status for an existing record (e.g., unknown → YES). */
  updateResolution(
    conditionId: string,
    resolution: string,
    resolvedAt: string,
    source: string,
  ): void;

  /** Mark a resolution as fully settled (all positions processed). */
  markSettled(conditionId: string): void;
}

// ─── OperatorCommandRepository ───────────────────────────────────────────

export interface OperatorCommandRepository {
  /** Insert a new pending command. Returns the auto-incremented row id. */
  insert(
    cmd: Omit<OperatorCommand, "id" | "status" | "appliedAt" | "initiatorType" | "initiator"> &
      Partial<Pick<OperatorCommand, "initiatorType" | "initiator">>,
  ): number;

  /** Return all commands with status = "pending". */
  getPending(): OperatorCommand[];

  /** Mark a command as applied or rejected. */
  updateStatus(id: number, status: "applied" | "rejected", appliedAt: string): void;
}

// ─── OperatorActionRepository ────────────────────────────────────────────

export interface OperatorActionRepository {
  /** Append an action record to the audit log. */
  insert(action: Omit<OperatorAction, "actionId">): void;

  /** Return the most recently applied actions, newest first. */
  findRecent(limit: number): OperatorAction[];
}

// ─── MarketSnapshotRepository ───────────────────────────────────────────

export interface MarketSnapshotRepository {
  /** Persist a batch of market snapshots. */
  saveBatch(snapshots: MarketSnapshot[]): void;

  /** Delete snapshots older than the given ISO timestamp. Returns rows deleted. */
  prune(olderThanIso: string): number;
}

// ─── RiskEventRepository ────────────────────────────────────────────────

export interface RiskEventRepository {
  /** Insert a risk event into the audit log. */
  insert(event: { eventType: string; payload: Record<string, unknown> }): void;

  /** Count risk events since the given ISO timestamp. */
  countSince(createdAtIso: string): number;
}

// ─── StateTransition ────────────────────────────────────────────────────

export interface StateTransition {
  id: number;
  entityType: string;
  entityId: string;
  profile: ProfileId | null;
  fromState: string;
  toState: string;
  triggerType: string;
  initiator: string | null;
  reason: string;
  scoresSnapshot: string | null;
  createdAt: string;
}

// ─── StateTransitionRepository ──────────────────────────────────────────

export interface StateTransitionRepository {
  insert(transition: Omit<StateTransition, "id" | "createdAt">): void;
  findByEntity(entityType: string, entityId: string): StateTransition[];
  findLastTransitionTo(
    familyId: string,
    toState: string,
    profile?: ProfileId | null,
  ): StateTransition | null;
  findRecent(limit: number): StateTransition[];
}

// ─── ProfileRepository ──────────────────────────────────────────────────

export interface ProfileRepository {
  findAll(): Profile[];
  findById(profileId: ProfileId): Profile | null;
  save(profile: Profile): void;
}

// ─── ProfileSettingsRepository ──────────────────────────────────────────

export interface ProfileSettingsRepository {
  get(profileId: ProfileId): ProfileSettings | null;
  save(settings: ProfileSettings): void;
}

// ─── ProfileSummaryRepository ───────────────────────────────────────────

export interface ProfileSummaryRepository {
  get(profileId: ProfileId): ProfileSummary | null;
  getAll(): ProfileSummary[];
  save(summary: ProfileSummary): void;
}

// ─── RuntimeControlStateRepository ──────────────────────────────────────

export interface RuntimeControlStateRepository {
  get(): RuntimeControlState | null;
  save(state: RuntimeControlState): void;
}

// ─── SwitchRequestRepository ────────────────────────────────────────────

export interface SwitchRequestRepository {
  save(request: SwitchRequest): void;
  findById(switchId: SwitchId): SwitchRequest | null;
  findActive(): SwitchRequest | null;
  updateState(switchId: SwitchId, state: SwitchState, error?: string | null): void;
}

// ─── SettlementLedgerRepository ─────────────────────────────────────────

export interface SettlementLedgerRepository {
  save(settlement: SettlementRecord): void;

  /**
   * Return algo-redeem settlement rows with `settled_at > cutoffIso`.
   * Filters entirely inside `settlement_ledger` on the stable `resolution`
   * column so mutable `market_resolutions.source` updates cannot hide
   * historical algo-redeem rows from the drift detector.
   */
  findAlgoRedeemSettlementsSince(cutoffIso: string): SettlementRecord[];
}

// ─── MergeLedgerRepository ──────────────────────────────────────────────

export interface MergeLedgerRepository {
  /** Record a completed inventory merge action. */
  save(merge: import("./types.js").MergeRecord): void;
}

// ─── PositionDriftRepository ────────────────────────────────────────────

export interface PositionDriftRepository {
  /** Upsert a drift row keyed on settlementId (idempotent across reconciliation ticks). */
  upsert(drift: PositionDrift): void;

  /** Return drifts whose status is "open", newest first. */
  findOpen(): PositionDrift[];

  /** Mark a drift as resolved (balance cleared on-chain). */
  markResolved(settlementId: string, resolvedAtIso: string): void;
}

/**
 * ADR-015 — append-only observation writer. One row per execution-term
 * resolution (or enforce-skip). No update/delete paths by design.
 */
export interface ExecutionPolicyObservationRepository {
  insert(obs: ExecutionPolicyObservation): void;
}

// ─── PreflightReportRepository ──────────────────────────────────────────

export interface PreflightReportRepository {
  save(report: PreflightReport): void;
  findById(reportId: ReportId): PreflightReport | null;
  findBySwitchRequest(switchId: SwitchId): PreflightReport[];
  findLatestByProfile(profile: ProfileId): PreflightReport | null;
}

// ─── ServiceHeartbeatRepository ─────────────────────────────────────────

export interface ServiceHeartbeatRepository {
  upsert(heartbeat: ServiceHeartbeat): void;
  findByService(serviceName: string): ServiceHeartbeat[];
  findAll(): ServiceHeartbeat[];
}

// ─── ConfigImportRepository ─────────────────────────────────────────────

export interface ConfigImportRepository {
  save(importRecord: ConfigImport): void;
  findById(importId: ImportId): ConfigImport | null;
  findLatest(): ConfigImport | null;
}

// ─── AlgoRulesRepository ────────────────────────────────────────────────

export interface AlgoRulesRepository {
  getDecisionRules(): AlgoDecisionRule[];
  getSizeRules(actionType: "BUY" | "SELL"): AlgoSizeRule[];
}

// ─── LegStateRepository ────────────────────────────────────────────────

export interface LegStateRepository {
  get(tokenId: TokenId): LegState | null;
  upsert(state: LegState): void;
  delete(tokenId: TokenId): void;
  getAll(): LegState[];
}

// ─── LegStateTransitionRepository ───────────────────────────────────────

export interface LegStateTransitionRepository {
  insert(transition: Omit<LegStateTransition, "id" | "createdAt">): boolean;
  findByTokenId(tokenId: TokenId, limit?: number): LegStateTransition[];
  findByPositionId(positionId: PositionId, limit?: number): LegStateTransition[];
}
