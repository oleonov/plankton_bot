import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFamilyId } from "@plankton/domain";
import type {
  EventBus,
  FamilyEvidenceRepository,
  FamilyRulesProvider,
  FamilyIdentity,
  FamilyEvidence,
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
  evidenceRepo: FamilyEvidenceRepository;
  rulesProvider: FamilyRulesProvider;
  scoreComputer: ScoreComputer;
}

function createMockDeps(overrides?: Partial<MockDeps>): MockDeps {
  return {
    bus: createMockBus(),
    evidenceRepo: {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      updateProbeSubstate: vi.fn(),
      getEvidence: vi.fn().mockReturnValue(null),
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

  it("recompute() updates deployed family evidence scores", async () => {
    const identity = makeFamilyIdentity();

    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const evidenceRepo = {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      updateProbeSubstate: vi.fn(),
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

  it("ReconciliationComplete triggers out-of-cycle recompute", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const evidenceRepo = {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      updateProbeSubstate: vi.fn(),
      getEvidence: vi.fn().mockReturnValue(null),
    } as any;

    const deps = createMockDeps({ rulesProvider, evidenceRepo });
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();
    evidenceRepo.updateScores.mockClear();

    // Trigger ReconciliationComplete
    const handler = eventHandlers.get("ReconciliationComplete");
    expect(handler).toBeDefined();
    await handler!({ result: { ranAt: Date.now(), clean: true, details: [] } } as any);

    // Verify recompute ran again
    expect(evidenceRepo.updateScores).toHaveBeenCalled();

    await engine.stop();
  });

  it("warming-up persists while evidence insufficient", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    // Low trade count = insufficient evidence
    const sc = createMockScoreComputer({
      recycleMetrics: {
        tradeCount: 5,
        distinctMarkets: 2,
        tailAdjustedPnl: 1,
        repricingExits: 0,
        totalNonSettlementClosed: 1,
      },
    });

    const evidenceRepo = {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      updateProbeSubstate: vi.fn(),
      getEvidence: vi.fn().mockReturnValue({
        promotionState: "probe-only",
        probeSubstate: "warming-up",
      } as Partial<FamilyEvidence>),
    } as any;

    const deps = createMockDeps({ rulesProvider, scoreComputer: sc, evidenceRepo });
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    // tradeCount < 20 -> no substate update to "retained"
    expect(evidenceRepo.updateProbeSubstate).not.toHaveBeenCalled();

    await engine.stop();
  });

  it("retained set when trade_count >= 20 but thresholds not met", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    // Enough trades but failing other thresholds (only 1 repricing exit, 2 markets)
    const sc = createMockScoreComputer({
      recycleMetrics: {
        tradeCount: 25,
        distinctMarkets: 2,
        tailAdjustedPnl: -5,
        repricingExits: 1,
        totalNonSettlementClosed: 4,
      },
    });

    const evidenceRepo = {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      updateProbeSubstate: vi.fn(),
      getEvidence: vi.fn().mockReturnValue({
        promotionState: "probe-only",
        probeSubstate: "warming-up",
      } as Partial<FamilyEvidence>),
    } as any;

    const deps = createMockDeps({ rulesProvider, scoreComputer: sc, evidenceRepo });
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 999_999,
    });

    await engine.start();

    expect(evidenceRepo.updateProbeSubstate).toHaveBeenCalledWith(FAM_ID, "retained");

    await engine.stop();
  });

  it("periodic timer triggers recompute", async () => {
    const identity = makeFamilyIdentity();
    const rulesProvider = {
      getRule: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([identity]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as any;

    const evidenceRepo = {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      updateProbeSubstate: vi.fn(),
      getEvidence: vi.fn().mockReturnValue(null),
    } as any;

    const deps = createMockDeps({ rulesProvider, evidenceRepo });
    const engine = new FamilyEvidenceEngine({
      ...deps,
      log: silentLog,
      recomputeIntervalMs: 5_000,
    });

    await engine.start();
    const callsAfterStart = evidenceRepo.updateScores.mock.calls.length;

    // Advance timer by one interval
    await vi.advanceTimersByTimeAsync(5_000);

    expect(evidenceRepo.updateScores.mock.calls.length).toBeGreaterThan(callsAfterStart);

    await engine.stop();
  });
});
