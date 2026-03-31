/** API response envelope */
export interface ApiEnvelope<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  ts: string;
}

/** GET /status */
export interface StatusData {
  runtimeMode: string;
  uptimeSeconds: number;
  paused: boolean;
  lastReconciliationAt: string | null;
  marketDataStale: boolean;
  marketDataLastUpdateAt: string | null;
  activeFamilyCount: number;
  openOrderCount: number;
  openPositionCount: number;
  totalOpenValueUsdc: number;
  totalTailCostUsdc: number;
  initialBalanceUsdc: number | null;
  balanceUsdc: number | null;
  walletBalanceUsdc: number | null;
  totalCurrentValueUsdc: number;
  totalRealizedPnl: number;
  marketDataSource: "live" | "simulation";
  executionMode: "simulation" | "live";
  liveLite?: {
    familyAllowlist: string[];
    maxFamilies: number;
    maxOpenValueUsdc: number;
    maxOrderUsdc: number;
    maxActiveMarkets: number;
  };
  reconciliationDriftDetected: boolean;
  marketDataPoll?: { active: boolean; page: number };
  tradingState?: string;
  signalActivity?: {
    signalsProducedLast10m: number;
    signalsApprovedLast10m: number;
    signalsRejectedLast10m: number;
    entrySignalsApprovedLast10m: number;
    exitSignalsApprovedLast10m: number;
    lastEntryApprovedAt: string | null;
    lastSignalRejectedAt: string | null;
    approvalRate: number | null;
    candidatesConsideredLast10m?: number;
    blockedByResolutionBufferLast10m?: number;
    blockedByWeekendLast10m?: number;
    blockedByWindowLast10m?: number;
    topBlockingLayer?: string | null;
  };
}

/** GET /metrics */
export interface MetricsData {
  positions: Record<string, number>;
  orders: Record<string, number>;
  fills: { count: number; volumeUsdc: number };
  totalRealizedPnl: number;
}

/** GET /metrics/pnl-series */
export interface PnlDataPoint {
  date: string;
  realizedPnl: number;
}

/** GET /metrics/families item */
export interface FamilyMetric {
  familyId: string;
  runtimeMode: string;
  openValueUsdc: number;
  openPositionCount: number;
  tailAdjustedPnlLive: number;
  quarantineReason: string | null;
  effectiveMode: string | null;
  derivedModeReason: string | null;
  updatedAt: string;
}

/** GET /positions item */
export interface PositionDTO {
  positionId: string;
  tokenId: string;
  familyId: string;
  side: string;
  size: number;
  avgEntryPrice: number;
  costBasisUsdc: number;
  currentValueUsdc: number | null;
  realizedPnl: number;
  status: string;
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
  slug: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
  conditionId: string | null;
  endDate: string | null;
  resolution: string | null;
  resolutionStatus: string | null;
}

/** GET /orders item */
export interface OrderDTO {
  orderId: string;
  clientOrderId: string;
  tokenId: string;
  familyId: string;
  side: string;
  orderType: string;
  price: number;
  size: number;
  sizeUsdc: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  slug: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
  conditionId: string | null;
  endDate: string | null;
}

/** GET /fills item */
export interface FillDTO {
  fillId: string;
  orderId: string;
  tokenId: string;
  familyId: string;
  side: string;
  price: number;
  size: number;
  sizeUsdc: number;
  fee: number;
  filledAt: string;
  slug: string | null;
  eventSlug: string | null;
  question: string | null;
  outcome: string | null;
  conditionId: string | null;
  endDate: string | null;
}

/** GET /families item */
export interface FamilyDTO {
  familyId: string;
  familyKey: string;
  primaryCategory: string;
  regime: string;
  horizon: string;
  cadence: string;
  strategyProfile: string;
  promotionState: string | null;
  probeSubstate: string | null;
  state: {
    runtimeMode: string;
    openValueUsdc: number;
    openPositionCount: number;
    openDustCount: number;
    activeMarketCount: number;
    currentTailCostUsdc: number;
    tailAdjustedPnlLive: number;
    quarantineReason: string | null;
    effectiveMode: string | null;
    derivedModeReason: string | null;
  } | null;
  caps: {
    maxOpenValueUsdc: number;
    maxActiveMarkets: number;
    maxDustPositions: number;
  } | null;
}

/** GET /risk-events item */
export interface RiskEventDTO {
  id: number;
  eventType: string;
  familyId: string | null;
  summary: string;
  severity: "critical" | "warning" | "info";
  createdAt: string;
}

/** Paginated response */
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/** GET /discovery/candidates item */
export interface CandidateDTO {
  candidateId: string;
  familyKey: string;
  regime: string;
  horizon: string;
  cadence: string;
  patternConfidence: string;
  primaryCategory: string;
  strategyProfile: string;
  slugPattern: string | null;
  matchedFamilyId: string | null;
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

/** GET /discovery/candidates/:id (detail) */
export interface CandidateDetailDTO extends CandidateDTO {
  recentObservations: ObservationDTO[];
}

/** Candidate observation */
export interface ObservationDTO {
  id: number;
  candidateId: string;
  activeMarketCount: number;
  clusterVolume24h: number;
  nearestEndDate: string | null;
  observedAt: string;
}

/** GET /discovery/status */
export interface DiscoveryScanStatsDTO {
  marketsFound: number;
  clustersCreated: number;
  candidatesUpserted: number;
  matched: number;
  pruned: number;
}

export interface DiscoveryRunDTO {
  id: number;
  triggerType: "startup" | "schedule" | "manual";
  status: "queued" | "running" | "succeeded" | "failed";
  requestedBy: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
  stats: DiscoveryScanStatsDTO | null;
  error: string | null;
}

export interface DiscoveryStatusDTO {
  lastRun: DiscoveryRunDTO | null;
  lastSuccessfulRun: DiscoveryRunDTO | null;
  activeRun: DiscoveryRunDTO | null;
  workerState: "healthy" | "offline";
}

/** GET /families/proposals item */
export interface ProposalDTO {
  id: number;
  familyId: string;
  currentState: string;
  proposedState: string;
  reason: string;
  scoresSnapshot: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

/** Promotion blocker threshold check */
export interface PromotionBlockerDTO {
  metric: string;
  current: number;
  required: number;
  passed: boolean;
}

/** GET /families/:id/evidence */
export interface FamilyEvidenceDTO {
  familyId: string;
  evidenceStatus: string | null;
  evidenceScore: number | null;
  promotionState: string | null;
  localTradeCount: number | null;
  localMarketCount: number | null;
  localRealizedPnlFifo: number | null;
  openTailCostUsdc: number | null;
  tailAdjustedPnl: number | null;
  remoteClosedRealizedPnl: number | null;
  openPositionCount: number | null;
  openDustCount: number | null;
  bothSidedEligible: boolean;
  heavyCampaignEligible: boolean;
  activeWindowEdgeScore: number | null;
  recurrenceScore: number | null;
  recycleScore: number | null;
  liveViabilityScore: number | null;
  toxicityPenalty: number | null;
  lastValidatedAt: string | null;
  probeSubstate: string | null;
  repricingExitCount: number;
  promotionBlockers?: PromotionBlockerDTO[];
}

/** GET /families/:id/transitions item */
export interface TransitionDTO {
  id: number;
  entityType: string;
  entityId: string;
  fromState: string;
  toState: string;
  triggerType: string;
  initiator: string;
  reason: string;
  scoresSnapshot: string | null;
  createdAt: string;
}

/** GET /profiles item */
export interface ProfileDTO {
  profile_id: string;
  display_name: string;
  description: string | null;
  paused: number | null;
  last_run_at: string | null;
  open_orders: number | null;
  open_positions: number | null;
  total_exposure_usdc: number | null;
  balance_usdc: number | null;
  last_preflight_status: string | null;
  updated_at: string | null;
}

/** GET /profiles response */
export interface ProfilesResponse {
  profiles: ProfileDTO[];
  runtimeState: {
    current_profile: string | null;
    desired_profile: string | null;
    runtime_status: string;
  } | null;
}

/** GET /profiles/:id response */
export interface ProfileDetailDTO {
  profile: ProfileDTO;
  settings: ProfileSettingsDTO | null;
  deployedFamilies: DeployedFamilyDTO[];
}

export interface ProfileSettingsDTO {
  profile_id: string;
  initial_balance_usdc: number | null;
  envelope_json: string | null;
  risk_caps_json: string | null;
  updated_at: string;
}

export interface DeployedFamilyDTO {
  family_id: string;
  enabled: number;
  operator_mode: string;
  strategy_stage: string;
  deployment_stage: string;
  priority: number;
  family_key: string;
  primary_category: string;
  regime: string;
}

/** GET /audit item */
export interface AuditEntryDTO {
  id: number;
  entity_type: string;
  entity_id: string;
  from_state: string;
  to_state: string;
  trigger_type: string;
  initiator: string;
  reason: string;
  profile: string | null;
  created_at: string;
}

/** POST /actions/switch-profile response */
export interface SwitchResponse {
  switchId: string;
  status: string;
}

/** GET /control/overview response */
export interface ControlOverviewDTO {
  profiles: ProfileDTO[];
  runtimeState: {
    current_profile: string | null;
    desired_profile: string | null;
    runtime_status: string;
    paused: number | null;
    current_run_id: string | null;
  } | null;
  activeSwitch: Record<string, unknown> | null;
  recentTransitions: AuditEntryDTO[];
  pendingProposals: number;
  heartbeats: Record<string, unknown>[];
}
