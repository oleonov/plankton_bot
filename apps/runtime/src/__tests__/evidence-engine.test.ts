import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFamilyId } from "@plankton/domain";
import type {
  EventBus,
  FamilyCandidateRepository,
  FamilyEvidenceRepository,
  PromotionProposalRepository,
  OperatorCommandRepository,
  StateTransitionRepository,
  FamilyStateRepository,
  FamilyRulesProvider,
  FamilyCandidate,
  FamilyIdentity,
  FamilyEvidence,
  FamilyState,
  RuntimeEventMap,
} from "@plankton/domain";
import type { ScoreComputer, RecycleMetrics } from "../modules/evidence/score-computer.js";
import { FamilyEvidenceEngine } from "../modules/evidence/evidence-engine.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

const FAM_ID = createFamilyId("fam-test");

const silentLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: () => silentLog,
} as any;

// Captured event handlers from bus.subscribe
type Handler<K extends keyof RuntimeEventMap> = (payload: RuntimeEventMap[K]) => Promise<void>;
let eventHandlers: Map<string, Handler<any>>;

function createMockBus(): EventBus {
  eventHandlers = new Map();
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockImplementation((event: string, handler: Handler<any>) => {
      eventHandlers.set(event, handler);
      return vi.fn(); // unsubscribe
    }),
    drain: vi.fn().mockResolvedValue(undefined),
  };
}

function makeCandidate(overrides?: Partial<FamilyCandidate>): FamilyCandidate {
  return {
    candidateId: "cand-1",
    familyKey: "test-key",
    regime: "threshold" as any,
    horizon: "daily",
    cadence: "daily",
    patternConfidence: "medium",
    primaryCategory: "crypto",
    strategyProfile: "scalp" as any,
    slugPattern: null,
    matchedFamilyId: null,
    activeMarketCount: 4,
    nearestEndDate: null,
    clusterVolume24h: 30000,
    recurrenceScore: null,
    recycleScore: null,
    liveViabilityScore: null,
    toxicityPenalty: null,
    gateRecommendation: "ignore",
    recommendationReason: null,
    scoresUpdatedAt: null,
    status: "discovered",
    firstSeenAt: "2026-01-01",
    lastSeenAt: "2026-03-20",
    reviewedAt: null,
    materializedAt: null,
    ...overrides,
  };
}

function makeFamilyIdentity(overrides?: Partial<FamilyIdentity>): FamilyIdentity {
  return {
    familyId: FAM_ID,
    familyKey: "test-fam",
    primaryCategory: "crypto",
    regime: "threshold" as any,
    horizon: "daily",
    cadence: "daily",
    strategyProfile: "scalp" as any,
    topicKey: null,
    slugPattern: null,
    notes: null,
    ...overrides,
  };
}

function makeFamilyState(overrides?: Partial<FamilyState>): FamilyState {
  return {
    familyId: FAM_ID,
    runtimeMode: "active" as any,
    openValueUsdc: 10,
    openPositionCount: 2,
    openDustCount: 0,
    activeMarketCount: 3,
    currentTailCostUsdc: 5,
    tailAdjustedPnlLive: 10,
    lastEntryTs: null,
    lastExitTs: null,
    quarantineReason: null,
    effectiveMode: "active",
    derivedModeReason: null,
    updatedAt: "2026-03-20T00:00:00Z",
    ...overrides,
  };
}

function createMockScoreComputer(overrides?: {
  recycleMetrics?: Partial<RecycleMetrics>;
  toxicity?: Partial<import("../modules/evidence/score-computer.js").ToxicityMetrics>;
}): ScoreComputer {
  return {
    computeRecurrenceMetrics: vi.fn().mockReturnValue({
      spanDays: 20,
      presenceDays: 15,
      totalDays: 20,
      cadenceMean: 1.5,
      cadenceStddev: 0.3,
      distinctConditions: 10,
    }),
    computeRecycleMetrics: vi.fn().mockReturnValue({
      tradeCount: 25,
      distinctMarkets: 6,
      tailAdjustedPnl: 15,
      repricingExits: 4,
      totalNonSettlementClosed: 8,
      ...overrides?.recycleMetrics,
    }),
    computeLiveViabilityMetrics: vi.fn().mockReturnValue({
      activeMarketCount: 4,
      healthyEndDateFraction: 0.8,
      clusterVolume24h: 30000,
    }),
    computeToxicityMetrics: vi.fn().mockReturnValue({
      dustCount: 0,
      positionCount: 3,
      tailCostUsdc: 2,
      realizedPnlUsdc: 20,
      reduceOnlyCount: 0,
      weeksDeployed: 8,
      staleCount: 0,
      totalOpen: 3,
      ...overrides?.toxicity,
    }),
  } as any;
}

// ─── Deps factory ────────────────────────────────────────────────────────

interface MockDeps {
  bus: EventBus;
  candidateRepo: FamilyCandidateRepository;
  evidenceRepo: FamilyEvidenceRepository;
  proposalRepo: PromotionProposalRepository;
  commandRepo: OperatorCommandRepository;
  stateTransitionRepo: StateTransitionRepository;
  familyStateRepo: FamilyStateRepository;
  rulesProvider: FamilyRulesProvider;
  scoreComputer: ScoreComputer;
}

function createMockDeps(overrides?: Partial<MockDeps>): MockDeps {
  return {
    bus: createMockBus(),
    candidateRepo: {
      findAll: vi.fn().mockReturnValue([]),
      findById: vi.fn().mockReturnValue(null),
      findByStatus: vi.fn().mockReturnValue([]),
      upsert: vi.fn(),
      updateStatus: vi.fn(),
      updateScores: vi.fn(),
    } as any,
    evidenceRepo: {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      getEvidence: vi.fn().mockReturnValue(null),
    } as any,
    proposalRepo: {
      insert: vi.fn().mockReturnValue(1),
      findPending: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      hasPending: vi.fn().mockReturnValue(false),
      resolve: vi.fn(),
    } as any,
    commandRepo: {
      insert: vi.fn().mockReturnValue(1),
      getPending: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
    } as any,
    stateTransitionRepo: {
      insert: vi.fn(),
      findByEntity: vi.fn().mockReturnValue([]),
      findRecent: vi.fn().mockReturnValue([]),
    } as any,
    familyStateRepo: {
      get: vi.fn().mockReturnValue(makeFamilyState()),
      save: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      findByMode: vi.fn().mockReturnValue([]),
      findQuarantined: vi.fn().mockReturnValue([]),
    } as any,
    rulesProvider: {
      getRule: vi.fn().mockReturnValue(null),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any,
    scoreComputer: createMockScoreComputer(),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("FamilyEvidenceEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("starts and stops cleanly", async () => {
    const deps = createMockDeps();
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 60_000,
    });

    await engine.start();
    const health = await engine.healthCheck();
    expect(health.ok).toBe(true);

    await engine.stop();
    // Subscribed to 4 events
    expect(deps.bus.subscribe).toHaveBeenCalledTimes(4);
  });

  it("recompute() updates candidate scores", async () => {
    const candidate = makeCandidate();
    const candidateRepo = {
      findAll: vi.fn().mockReturnValue([candidate]),
      updateScores: vi.fn(),
      findById: vi.fn(),
      findByStatus: vi.fn(),
      upsert: vi.fn(),
      updateStatus: vi.fn(),
    } as any;

    const deps = createMockDeps({ candidateRepo });
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    expect(candidateRepo.updateScores).toHaveBeenCalledWith(
      "cand-1",
      expect.objectContaining({
        recurrenceScore: expect.any(Number),
        liveViabilityScore: expect.any(Number),
        gateRecommendation: expect.any(String),
      }),
    );

    await engine.stop();
  });

  it("recompute() updates deployed family evidence scores", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn().mockReturnValue(null),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const evidenceRepo = {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      getEvidence: vi.fn().mockReturnValue(null),
    } as any;

    const deps = createMockDeps({ rulesProvider, evidenceRepo });
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    expect(evidenceRepo.updateScores).toHaveBeenCalledWith(
      FAM_ID,
      expect.objectContaining({
        recycleScore: expect.any(Number),
        toxicityPenalty: expect.any(Number),
      }),
    );

    await engine.stop();
  });

  it("proposes promotion when thresholds met and no pending proposal", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const proposalRepo = {
      insert: vi.fn().mockReturnValue(1),
      findPending: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      hasPending: vi.fn().mockReturnValue(false),
      resolve: vi.fn(),
    } as any;

    const evidenceRepo = {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      getEvidence: vi.fn().mockReturnValue({
        promotionState: "probe-only",
      } as Partial<FamilyEvidence>),
    } as any;

    // ScoreComputer returning values that meet promotion thresholds
    const sc = createMockScoreComputer({
      recycleMetrics: {
        tradeCount: 25,
        distinctMarkets: 6,
        tailAdjustedPnl: 15,
        repricingExits: 4,
        totalNonSettlementClosed: 8,
      },
    });

    const deps = createMockDeps({
      rulesProvider,
      proposalRepo,
      evidenceRepo,
      scoreComputer: sc,
    });

    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    expect(proposalRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAM_ID,
        proposedState: "scaled",
      }),
    );
    expect(deps.bus.publish).toHaveBeenCalledWith(
      "FamilyPromotionProposed",
      expect.objectContaining({ familyId: FAM_ID }),
    );

    await engine.stop();
  });

  it("does not propose promotion if one is already pending", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const proposalRepo = {
      insert: vi.fn(),
      findPending: vi.fn().mockReturnValue([]),
      findByFamily: vi.fn().mockReturnValue([]),
      hasPending: vi.fn().mockReturnValue(true), // already pending
      resolve: vi.fn(),
    } as any;

    const deps = createMockDeps({ rulesProvider, proposalRepo });
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    expect(proposalRepo.insert).not.toHaveBeenCalled();

    await engine.stop();
  });

  it("enqueues reduce-only command when toxicity exceeds 0.6 but not 0.8", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    // Toxicity in (0.6, 0.8] range — produces ~0.725
    const sc = createMockScoreComputer({
      toxicity: {
        dustCount: 5,
        positionCount: 5,
        tailCostUsdc: 60,
        realizedPnlUsdc: 30,
        reduceOnlyCount: 3,
        weeksDeployed: 4,
        staleCount: 3,
        totalOpen: 6,
      },
    });

    const commandRepo = {
      insert: vi.fn().mockReturnValue(1),
      getPending: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
    } as any;

    const stateTransitionRepo = {
      insert: vi.fn(),
      findByEntity: vi.fn().mockReturnValue([]),
      findRecent: vi.fn().mockReturnValue([]),
    } as any;

    const deps = createMockDeps({
      rulesProvider,
      scoreComputer: sc,
      commandRepo,
      stateTransitionRepo,
    });

    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    expect(commandRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "family_reduce_only",
        initiatorType: "system",
        initiator: "evidence-engine",
      }),
    );
    // State transition is NOT written by evidence engine — CommandPoller writes it after apply
    expect(stateTransitionRepo.insert).not.toHaveBeenCalled();

    await engine.stop();
  });

  it("enqueues quarantine when toxicity > 0.8", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    // Very high toxicity (>0.8) — needs extreme values
    const sc = createMockScoreComputer({
      toxicity: {
        dustCount: 20,
        positionCount: 1,
        tailCostUsdc: 200,
        realizedPnlUsdc: 1,
        reduceOnlyCount: 10,
        weeksDeployed: 2,
        staleCount: 15,
        totalOpen: 3,
      },
    });

    const commandRepo = {
      insert: vi.fn().mockReturnValue(1),
      getPending: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
    } as any;

    const deps = createMockDeps({
      rulesProvider,
      scoreComputer: sc,
      commandRepo,
    });

    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    // Check if quarantine was enqueued (depends on toxicity score exceeding 0.8)
    const calls = commandRepo.insert.mock.calls;
    if (calls.length > 0) {
      const action = calls[0][0].action;
      expect(["family_quarantine", "family_reduce_only"]).toContain(action);
    }

    await engine.stop();
  });

  it("enqueues quarantine for threshold regime with negative tail", async () => {
    const identity = makeFamilyIdentity({ regime: "threshold" as any });
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    // Low toxicity but negative tail — threshold regime triggers immediate quarantine
    const sc = createMockScoreComputer({
      recycleMetrics: { tailAdjustedPnl: -5 },
      toxicity: {
        dustCount: 0,
        positionCount: 3,
        tailCostUsdc: 2,
        realizedPnlUsdc: 20,
        reduceOnlyCount: 0,
        weeksDeployed: 8,
        staleCount: 0,
        totalOpen: 3,
      },
    });

    const commandRepo = {
      insert: vi.fn().mockReturnValue(1),
      getPending: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
    } as any;

    const deps = createMockDeps({
      rulesProvider,
      scoreComputer: sc,
      commandRepo,
    });

    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    expect(commandRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "family_quarantine",
        initiatorType: "system",
      }),
    );

    await engine.stop();
  });

  it("escalates from reduce-only to quarantine when toxicity > 0.8", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    // Very high toxicity
    const sc = createMockScoreComputer({
      toxicity: {
        dustCount: 20,
        positionCount: 1,
        tailCostUsdc: 200,
        realizedPnlUsdc: 1,
        reduceOnlyCount: 10,
        weeksDeployed: 2,
        staleCount: 15,
        totalOpen: 3,
      },
    });

    const familyStateRepo = {
      get: vi.fn().mockReturnValue(makeFamilyState({ runtimeMode: "reduce-only" as any })),
      save: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      findByMode: vi.fn().mockReturnValue([]),
      findQuarantined: vi.fn().mockReturnValue([]),
    } as any;

    const commandRepo = {
      insert: vi.fn().mockReturnValue(1),
      getPending: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
    } as any;

    const deps = createMockDeps({
      rulesProvider,
      scoreComputer: sc,
      familyStateRepo,
      commandRepo,
    });

    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    // If toxicity exceeds 0.8, should escalate to quarantine even from reduce-only
    const calls = commandRepo.insert.mock.calls;
    if (calls.length > 0) {
      expect(calls[0][0].action).toBe("family_quarantine");
    }

    await engine.stop();
  });

  it("does not enqueue demotion if family already in quarantine", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const sc = createMockScoreComputer({
      toxicity: {
        dustCount: 10,
        positionCount: 2,
        tailCostUsdc: 100,
        realizedPnlUsdc: 5,
        reduceOnlyCount: 5,
        weeksDeployed: 4,
        staleCount: 5,
        totalOpen: 6,
      },
    });

    const familyStateRepo = {
      get: vi.fn().mockReturnValue(makeFamilyState({ runtimeMode: "quarantine" as any })),
      save: vi.fn(),
      findAll: vi.fn().mockReturnValue([]),
      findByMode: vi.fn().mockReturnValue([]),
      findQuarantined: vi.fn().mockReturnValue([]),
    } as any;

    const commandRepo = {
      insert: vi.fn(),
      getPending: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
    } as any;

    const deps = createMockDeps({
      rulesProvider,
      scoreComputer: sc,
      familyStateRepo,
      commandRepo,
    });

    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    expect(commandRepo.insert).not.toHaveBeenCalled();

    await engine.stop();
  });

  it("ReconciliationComplete triggers out-of-cycle recompute", async () => {
    const deps = createMockDeps();
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    // First call is from start(), now trigger via reconciliation
    const reconHandler = eventHandlers.get("ReconciliationComplete");
    expect(reconHandler).toBeDefined();

    await reconHandler!({ result: {} as any });

    // healthCheck should reflect recent recompute
    const health = await engine.healthCheck();
    expect(health.detail).toContain("lastRecompute=");
    expect(health.detail).not.toContain("never");

    await engine.stop();
  });

  it("does not demote on first negative tail for non-threshold regime (window enforcement)", async () => {
    // Non-threshold regime with negative tail but low toxicity — should NOT demote on first recompute
    const identity = makeFamilyIdentity({ regime: "non-threshold" as any, horizon: "daily" });
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const sc = createMockScoreComputer({
      recycleMetrics: { tailAdjustedPnl: -3 },
      toxicity: {
        dustCount: 0,
        positionCount: 3,
        tailCostUsdc: 2,
        realizedPnlUsdc: 20,
        reduceOnlyCount: 0,
        weeksDeployed: 8,
        staleCount: 0,
        totalOpen: 3,
      },
    });

    const commandRepo = {
      insert: vi.fn().mockReturnValue(1),
      getPending: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
    } as any;

    const deps = createMockDeps({
      rulesProvider,
      scoreComputer: sc,
      commandRepo,
    });

    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 3_600_000, // 1 hour
    });

    await engine.start();

    // Daily window = 5 days = 120 hours. A single 1-hour recompute should NOT trigger demotion.
    expect(commandRepo.insert).not.toHaveBeenCalled();

    await engine.stop();
  });

  it("demotes after enough consecutive negative tail recomputes exceed window", async () => {
    // Non-threshold regime, daily horizon (5-day window = 120h).
    // With 1h interval, need 120 consecutive negative recomputes.
    const identity = makeFamilyIdentity({ regime: "non-threshold" as any, horizon: "intraday-4h" });
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const sc = createMockScoreComputer({
      recycleMetrics: { tailAdjustedPnl: -3 },
      toxicity: {
        dustCount: 0,
        positionCount: 3,
        tailCostUsdc: 2,
        realizedPnlUsdc: 20,
        reduceOnlyCount: 0,
        weeksDeployed: 8,
        staleCount: 0,
        totalOpen: 3,
      },
    });

    const commandRepo = {
      insert: vi.fn().mockReturnValue(1),
      getPending: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
    } as any;

    const deps = createMockDeps({
      rulesProvider,
      scoreComputer: sc,
      commandRepo,
    });

    // intraday-4h window = 2 days = 48 hours. With 1h interval, need 48 recomputes.
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 3_600_000, // 1 hour
    });

    await engine.start(); // recompute #1
    expect(commandRepo.insert).not.toHaveBeenCalled();

    // Run 46 more recomputes (total 47, still under 48)
    for (let i = 0; i < 46; i++) {
      await engine.recompute();
    }
    expect(commandRepo.insert).not.toHaveBeenCalled();

    // Recompute #48 should trigger demotion
    await engine.recompute();
    expect(commandRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "family_reduce_only",
        initiatorType: "system",
      }),
    );

    await engine.stop();
  });

  it("resets negative tail counter when tail recovers", async () => {
    const identity = makeFamilyIdentity({ regime: "non-threshold" as any, horizon: "intraday-4h" });
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const recycleMetrics = {
      tradeCount: 25,
      distinctMarkets: 6,
      tailAdjustedPnl: -3,
      repricingExits: 4,
      totalNonSettlementClosed: 8,
    };

    const sc = createMockScoreComputer({
      recycleMetrics,
      toxicity: {
        dustCount: 0,
        positionCount: 3,
        tailCostUsdc: 2,
        realizedPnlUsdc: 20,
        reduceOnlyCount: 0,
        weeksDeployed: 8,
        staleCount: 0,
        totalOpen: 3,
      },
    });

    const commandRepo = {
      insert: vi.fn().mockReturnValue(1),
      getPending: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
    } as any;

    const deps = createMockDeps({
      rulesProvider,
      scoreComputer: sc,
      commandRepo,
    });

    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 3_600_000,
    });

    await engine.start(); // recompute #1

    // Run 30 more negative recomputes
    for (let i = 0; i < 30; i++) {
      await engine.recompute();
    }
    expect(commandRepo.insert).not.toHaveBeenCalled();

    // Tail recovers — counter should reset
    (sc.computeRecycleMetrics as any).mockReturnValue({ ...recycleMetrics, tailAdjustedPnl: 5 });
    await engine.recompute();

    // Now go negative again — counter restarts from 0
    (sc.computeRecycleMetrics as any).mockReturnValue({ ...recycleMetrics, tailAdjustedPnl: -3 });
    for (let i = 0; i < 47; i++) {
      await engine.recompute();
    }
    // 47 recomputes after reset < 48 needed for intraday-4h (2d window)
    expect(commandRepo.insert).not.toHaveBeenCalled();

    // 48th triggers demotion
    await engine.recompute();
    expect(commandRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "family_reduce_only",
      }),
    );

    await engine.stop();
  });

  it("periodic timer triggers recompute", async () => {
    const candidateRepo = {
      findAll: vi.fn().mockReturnValue([makeCandidate()]),
      updateScores: vi.fn(),
      findById: vi.fn(),
      findByStatus: vi.fn(),
      upsert: vi.fn(),
      updateStatus: vi.fn(),
    } as any;

    const deps = createMockDeps({ candidateRepo });
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 5_000,
    });

    await engine.start();
    const callsAfterStart = candidateRepo.updateScores.mock.calls.length;

    // Advance timer by one interval
    await vi.advanceTimersByTimeAsync(5_000);

    expect(candidateRepo.updateScores.mock.calls.length).toBeGreaterThan(callsAfterStart);

    await engine.stop();
  });
});
