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
