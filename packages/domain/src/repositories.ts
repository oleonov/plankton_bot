import type {
  OrderStatus,
  PromotionState,
  Regime,
  RuntimeMode,
  StrategyProfile,
} from "./enums.js";
import type { FamilyId, FillId, OrderId, PositionId, TokenId } from "./ids.js";
import type {
  FamilyEvidence,
  FamilyIdentity,
  FamilyRules,
  FamilyState,
  Fill,
  InventoryLot,
  Market,
  MarketResolution,
  MarketSnapshot,
  OperatorAction,
  OperatorCommand,
  Order,
  Position,
} from "./types.js";

// ─── MarketRepository ────────────────────────────────────────────────────

export interface MarketRepository {
  /** Insert or update a market record. tokenId is the primary key. */
  save(market: Market): void;

  /** Find a market by its CLOB token ID (primary key). */
  findByTokenId(tokenId: TokenId): Market | null;

  /** Find markets by multiple token IDs (bulk lookup). */
  findByTokenIds(tokenIds: TokenId[]): Market[];

  /** Find all markets belonging to a condition (YES + NO outcome rows). */
  findByConditionId(conditionId: string): Market[];

  /** Find all markets currently marked active. */
  findActive(): Market[];

  /** Find all markets assigned to a specific family. */
  findByFamily(familyId: FamilyId): Market[];

  /** Return every market row, active or inactive. */
  findAll(): Market[];

  /** Mark a market as inactive (active = 0). Used when a market resolves. */
  deactivate(tokenId: TokenId): void;
}

// ─── OrderRepository ─────────────────────────────────────────────────────

export interface OrderRepository {
  /** Persist a new order row. */
  save(order: Order): void;

  /** Find an order by its local order ID. */
  findById(id: OrderId): Order | null;

  /** Find an order by the deterministic client order ID. */
  findByClientOrderId(clientOrderId: string): Order | null;

  /** Return all orders whose status is pending or open. */
  findOpen(): Order[];

  /** Return all orders for a specific outcome token. */
  findByTokenId(tokenId: TokenId): Order[];

  /** Update the status (and optionally exchange_order_id) of an existing order. */
  updateStatus(id: OrderId, status: OrderStatus, exchangeOrderId?: string): void;
}

// ─── FillRepository ──────────────────────────────────────────────────────

export interface FillRepository {
  /** Persist a fill received from the exchange. */
  save(fill: Fill): void;

  /** Return true if a fill with the given ID already exists. */
  exists(fillId: FillId): boolean;

  /** Return all fills associated with a given order. */
  findByOrderId(orderId: OrderId): Fill[];

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

  /** Return all positions belonging to a family. */
  findByFamily(familyId: FamilyId): Position[];

  /** Return all positions whose status is open or partially filled. */
  findOpen(): Position[];

  /** Return all positions whose status is dust. */
  findDust(): Position[];

  /** Return every position row, regardless of status. */
  findAll(): Position[];
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

// ─── FamilyStateRepository ───────────────────────────────────────────────

export interface FamilyStateRepository {
  /** Return the runtime state for a single family, or null if never persisted. */
  get(familyId: FamilyId): FamilyState | null;

  /** Insert or update the runtime state for a family. */
  save(state: FamilyState): void;

  /** Return runtime state for every known family. */
  findAll(): FamilyState[];

  /** Return runtime states filtered to a specific mode. */
  findByMode(mode: RuntimeMode): FamilyState[];

  /** Return all families currently in quarantine mode. */
  findQuarantined(): FamilyState[];
}

// ─── FamilyRulesProvider ─────────────────────────────────────────────────

/**
 * Read-only provider for family configuration.
 * Backed by the YAML rule files loaded at startup; not a writable DB table.
 */
export interface FamilyRulesProvider {
  /** Return the composed rule set (identity + evidence + rules) for a family. */
  getRule(familyId: FamilyId): FamilyRuleBundle | null;

  /** Return whether a family is enabled and not blocked. */
  isEnabled(familyId: FamilyId): boolean;

  /** Return the identity record for every loaded family. */
  getAllFamilies(): FamilyIdentity[];

  /** Return rule bundles whose identity.regime matches the given regime. */
  getRulesForRegime(regime: Regime): FamilyRuleBundle[];
}

/**
 * Full resolved configuration bundle for a single family.
 * Combines identity, evidence, and operational rules.
 */
export interface FamilyRuleBundle {
  identity: FamilyIdentity;
  evidence: FamilyEvidence;
  rules: FamilyRules;
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
    resolution: "YES" | "NO",
    resolvedAt: string,
    source: string,
  ): void;

  /** Mark a resolution as fully settled (all positions processed). */
  markSettled(conditionId: string): void;
}

// ─── OperatorCommandRepository ───────────────────────────────────────────

export interface OperatorCommandRepository {
  /** Insert a new pending command. Returns the auto-incremented row id. */
  insert(cmd: Omit<OperatorCommand, "id" | "status" | "appliedAt">): number;

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

  /** Return all audit records for a specific family, newest first. */
  findByFamily(familyId: FamilyId): OperatorAction[];
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
  insert(event: {
    eventType: string;
    familyId: FamilyId | null;
    payload: Record<string, unknown>;
  }): void;
}

// ─── FamilyCandidate ────────────────────────────────────────────────────

export interface FamilyCandidate {
  candidateId: string;
  familyKey: string;
  regime: Regime;
  horizon: string;
  cadence: string;
  patternConfidence: string;
  primaryCategory: string;
  strategyProfile: StrategyProfile;
  slugPattern: string | null;
  matchedFamilyId: FamilyId | null;
  activeMarketCount: number;
  nearestEndDate: string | null;
  clusterVolume24h: number;
  recurrenceScore: number | null;
  recycleScore: number | null;
  liveViabilityScore: number | null;
  toxicityPenalty: number | null;
  gateRecommendation: string;
  recommendationReason: string | null;
  scoresUpdatedAt: string | null;
  status: string;
  firstSeenAt: string;
  lastSeenAt: string;
  reviewedAt: string | null;
  materializedAt: string | null;
}

// ─── CandidateObservation ───────────────────────────────────────────────

export interface CandidateObservation {
  id: number;
  candidateId: string;
  activeMarketCount: number;
  clusterVolume24h: number;
  nearestEndDate: string | null;
  observedAt: string;
}

// ─── CandidateObservationMarket ─────────────────────────────────────────

export interface CandidateObservationMarket {
  candidateId: string;
  observedAt: string;
  conditionId: string;
  slug: string;
  endDate: string | null;
  volume24h: number | null;
}

// ─── FamilyCandidateRepository ──────────────────────────────────────────

export interface FamilyCandidateRepository {
  upsert(candidate: FamilyCandidate): void;
  findById(candidateId: string): FamilyCandidate | null;
  findAll(): FamilyCandidate[];
  findByStatus(status: string): FamilyCandidate[];
  updateStatus(candidateId: string, status: string): void;
  updateScores(
    candidateId: string,
    scores: {
      recurrenceScore: number | null;
      recycleScore: number | null;
      liveViabilityScore: number | null;
      toxicityPenalty: number | null;
      gateRecommendation: string;
      recommendationReason: string | null;
      scoresUpdatedAt: string;
    },
  ): void;
}

// ─── CandidateObservationRepository ─────────────────────────────────────

export interface CandidateObservationRepository {
  insertObservation(obs: Omit<CandidateObservation, "id">): void;
  insertMarkets(markets: CandidateObservationMarket[]): void;
  findObservations(candidateId: string, limit: number): CandidateObservation[];
  findMarkets(candidateId: string, observedAt: string): CandidateObservationMarket[];
  countDistinctConditions(candidateId: string): number;
  prune(olderThanIso: string): number;
}

// ─── PromotionProposal ──────────────────────────────────────────────────

export interface PromotionProposal {
  id: number;
  familyId: FamilyId;
  currentState: PromotionState;
  proposedState: PromotionState;
  reason: string;
  scoresSnapshot: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

// ─── PromotionProposalRepository ────────────────────────────────────────

export interface PromotionProposalRepository {
  insert(proposal: Omit<PromotionProposal, "id" | "status" | "createdAt" | "resolvedAt" | "resolvedBy">): number;
  findPending(): PromotionProposal[];
  findByFamily(familyId: FamilyId): PromotionProposal[];
  hasPending(familyId: FamilyId): boolean;
  resolve(id: number, status: string, resolvedBy: string): void;
}

// ─── StateTransition ────────────────────────────────────────────────────

export interface StateTransition {
  id: number;
  entityType: string;
  entityId: string;
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
  findRecent(limit: number): StateTransition[];
}

// ─── FamilyEvidenceRepository ───────────────────────────────────────────

export interface FamilyEvidenceRepository {
  updateScores(
    familyId: FamilyId,
    scores: {
      recurrenceScore: number | null;
      recycleScore: number | null;
      liveViabilityScore: number | null;
      toxicityPenalty: number | null;
      scoresUpdatedAt: string;
    },
  ): void;
  updatePromotionState(familyId: FamilyId, promotionState: PromotionState): void;
  getEvidence(familyId: FamilyId): FamilyEvidence | null;
}

// ─── FamilyRulesSnapshot ────────────────────────────────────────────────

export interface FamilyRulesSnapshot {
  id: number;
  familyId: FamilyId;
  snapshot: string;
  reason: string;
  capturedAt: string;
}

// ─── FamilyRulesSnapshotRepository ──────────────────────────────────────

export interface FamilyRulesSnapshotRepository {
  save(snapshot: Omit<FamilyRulesSnapshot, "id">): void;
  findLatest(familyId: FamilyId): FamilyRulesSnapshot | null;
}
