import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeSafetyEvaluator } from "../runtime-safety-evaluator.js";
import type { SafetyEvaluatorDeps } from "../runtime-safety-evaluator.js";
import type {
  FamilyIdentity,
  FamilyState,
  FamilyDeployment,
  FamilyEvidence,
  StateTransition,
} from "@plankton/domain";
import {
  OperatorMode,
  ProfileId,
  StrategyStage,
  DeploymentStage,
  type FamilyId,
} from "@plankton/domain";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PROFILE = "paper" as ProfileId;
const FAMILY_A = "fam-alpha" as FamilyId;

function makeFamilyIdentity(overrides: Partial<FamilyIdentity> = {}): FamilyIdentity {
  return {
    familyId: FAMILY_A,
    familyKey: "alpha",
    primaryCategory: "crypto",
    regime: "binary",
    horizon: "daily",
    cadence: "recurring",
    strategyProfile: "scalp",
    topicKey: null,
    slugPattern: null,
    notes: null,
    ...overrides,
  } as FamilyIdentity;
}

function makeDeployment(overrides: Partial<FamilyDeployment> = {}): FamilyDeployment {
  return {
    familyId: FAMILY_A,
    profile: PROFILE,
    enabled: true,
    operatorMode: OperatorMode.Active,
    strategyStage: StrategyStage.ProbeOnly,
    probeSubstate: null,
    deploymentStage: DeploymentStage.PaperOnly,
    approvedSnapshotId: null,
    approvedScorecardId: null,
    operatorReason: null,
    priority: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFamilyState(overrides: Partial<FamilyState> = {}): FamilyState {
  return {
    familyId: FAMILY_A,
    runtimeMode: "active",
    openValueUsdc: 0,
    openPositionCount: 0,
    openDustCount: 0,
    activeMarketCount: 0,
    currentTailCostUsdc: 0,
    tailAdjustedPnlLive: 0,
    lastEntryTs: null,
    lastExitTs: null,
    quarantineReason: null,
    effectiveMode: null,
    derivedModeReason: null,
    firstNegativeTailAt: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFamilyEvidence(overrides: Partial<FamilyEvidence> = {}): FamilyEvidence {
  return {
    familyId: FAMILY_A,
    evidenceStatus: "partial",
    evidenceScore: 0,
    promotionState: "scaled",
    localTradeCount: 0,
    localMarketCount: 0,
    localRealizedPnlFifo: 0,
    openTailCostUsdc: 0,
    tailAdjustedPnl: 0,
    remoteClosedRealizedPnl: null,
    openPositionCount: 0,
    openDustCount: 0,
    bothSidedEligible: false,
    heavyCampaignEligible: false,
    activeWindowEdgeScore: null,
    recurrenceScore: null,
    recycleScore: null,
    liveViabilityScore: null,
    toxicityPenalty: null,
    lastValidatedAt: null,
    probeSubstate: null,
    repricingExitCount: 0,
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<SafetyEvaluatorDeps> = {}): SafetyEvaluatorDeps {
  return {
    bus: {
      subscribe: vi.fn(() => vi.fn()),
      publish: vi.fn(),
      drain: vi.fn(),
    },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as SafetyEvaluatorDeps["log"],
    scoreComputer: {
      computeToxicityMetrics: vi.fn(() => ({
        dustCount: 0,
        positionCount: 5,
        tailCostUsdc: 0,
        realizedPnlUsdc: 0,
        reduceOnlyCount: 0,
        weeksDeployed: 4,
        staleCount: 0,
        totalOpen: 5,
      })),
      computeRecycleMetrics: vi.fn(() => ({
        tradeCount: 10,
        distinctMarkets: 3,
        tailAdjustedPnl: 5,
        repricingExits: 2,
        totalNonSettlementClosed: 1,
      })),
    } as unknown as SafetyEvaluatorDeps["scoreComputer"],
    executionTelemetryReader: {
      readExecutionTelemetry: vi.fn(() => ({
        totalFills: 12,
        volumeUsdc: 24,
        makerFills: 12,
        takerFills: 0,
        unknownFills: 0,
        makerRatio: 1,
        takerRatio: 0,
        explicitFeesUsdc: 0,
        feeLeakageRatio: 0,
        lastFillAt: new Date().toISOString(),
      })),
    },
    deploymentRepo: {
      find: vi.fn(() => makeDeployment()),
      updateOperatorMode: vi.fn(),
      findByProfile: vi.fn(() => []),
      findEnabled: vi.fn(() => []),
      save: vi.fn(),
      updateDeploymentStage: vi.fn(),
    },
    stateTransitionRepo: {
      insert: vi.fn(),
      findByEntity: vi.fn(() => []),
      findLastTransitionTo: vi.fn(() => null),
      findRecent: vi.fn(() => []),
    },
    familyStateRepo: {
      get: vi.fn(() => makeFamilyState()),
      save: vi.fn(),
      findAll: vi.fn(() => []),
      findByMode: vi.fn(() => []),
      findQuarantined: vi.fn(() => []),
    },
    familyEvidenceRepo: {
      updateScores: vi.fn(),
      updatePromotionState: vi.fn(),
      updateProbeSubstate: vi.fn(),
      getEvidence: vi.fn(() => makeFamilyEvidence()),
    },
    rulesProvider: {
      getAllFamilies: vi.fn(() => [makeFamilyIdentity()]),
      getRule: vi.fn(),
      isEnabled: vi.fn(() => true),
      getRulesForRegime: vi.fn(() => []),
    },
    activeProfile: PROFILE,
    evalIntervalMs: 999_999, // prevent timer interference during tests
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("RuntimeSafetyEvaluator", () => {
  let deps: SafetyEvaluatorDeps;
  let evaluator: RuntimeSafetyEvaluator;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = createMockDeps();
    evaluator = new RuntimeSafetyEvaluator(deps);
  });

  it("does nothing when toxicity is low", async () => {
    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalled();
    expect(deps.stateTransitionRepo.insert).not.toHaveBeenCalled();
  });

  it("sets reduce-only when toxicity exceeds 0.6", async () => {
    // Return high dust ratio to push toxicity above 0.6
    vi.mocked(deps.scoreComputer.computeToxicityMetrics).mockReturnValue({
      dustCount: 8,
      positionCount: 2,
      tailCostUsdc: 10,
      realizedPnlUsdc: -5,
      reduceOnlyCount: 1,
      weeksDeployed: 8,
      staleCount: 3,
      totalOpen: 5,
    });

    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.ReduceOnly,
      expect.stringContaining("Auto-demotion: toxicity"),
    );
    expect(deps.familyStateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: "reduce-only" }),
    );
    expect(deps.familyEvidenceRepo.updatePromotionState).toHaveBeenCalledWith(
      FAMILY_A,
      "reduce-only",
    );
    expect(deps.stateTransitionRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "family",
        entityId: String(FAMILY_A),
        toState: OperatorMode.ReduceOnly,
        triggerType: "system",
        initiator: "safety-evaluator",
      }),
    );
  });

  it("sets quarantine when toxicity exceeds 0.8", async () => {
    // Extreme toxicity: all dust, negative PnL, stale
    vi.mocked(deps.scoreComputer.computeToxicityMetrics).mockReturnValue({
      dustCount: 10,
      positionCount: 0,
      tailCostUsdc: 50,
      realizedPnlUsdc: -20,
      reduceOnlyCount: 3,
      weeksDeployed: 12,
      staleCount: 8,
      totalOpen: 10,
    });

    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Quarantine,
      expect.stringContaining("severe toxicity"),
    );
  });

  it("threshold regime with negative tail triggers immediate quarantine", async () => {
    deps = createMockDeps({
      rulesProvider: {
        getAllFamilies: vi.fn(() => [makeFamilyIdentity({ regime: "threshold" as any })]),
        getRule: vi.fn(),
        isEnabled: vi.fn(() => true),
        getRulesForRegime: vi.fn(() => []),
      },
    });
    vi.mocked(deps.scoreComputer.computeRecycleMetrics).mockReturnValue({
      tradeCount: 10,
      distinctMarkets: 3,
      tailAdjustedPnl: -2,
      repricingExits: 1,
      totalNonSettlementClosed: 1,
    });

    evaluator = new RuntimeSafetyEvaluator(deps);
    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Quarantine,
      expect.stringContaining("threshold regime"),
    );
  });

  it("does nothing when already quarantined", async () => {
    vi.mocked(deps.deploymentRepo.find).mockReturnValue(
      makeDeployment({ operatorMode: OperatorMode.Quarantine }),
    );

    // Even with extreme toxicity, quarantine should not re-trigger
    vi.mocked(deps.scoreComputer.computeToxicityMetrics).mockReturnValue({
      dustCount: 10,
      positionCount: 0,
      tailCostUsdc: 50,
      realizedPnlUsdc: -20,
      reduceOnlyCount: 3,
      weeksDeployed: 12,
      staleCount: 8,
      totalOpen: 10,
    });

    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalled();
  });

  it("escalates from reduce-only to quarantine on severe toxicity", async () => {
    vi.mocked(deps.deploymentRepo.find).mockReturnValue(
      makeDeployment({ operatorMode: OperatorMode.ReduceOnly }),
    );
    vi.mocked(deps.familyEvidenceRepo.getEvidence).mockReturnValue(
      makeFamilyEvidence({ promotionState: "reduce-only" }),
    );

    vi.mocked(deps.scoreComputer.computeToxicityMetrics).mockReturnValue({
      dustCount: 10,
      positionCount: 0,
      tailCostUsdc: 50,
      realizedPnlUsdc: -20,
      reduceOnlyCount: 3,
      weeksDeployed: 12,
      staleCount: 8,
      totalOpen: 10,
    });

    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Quarantine,
      expect.stringContaining("escalation from reduce-only"),
    );
    expect(deps.stateTransitionRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        fromState: OperatorMode.ReduceOnly,
        toState: OperatorMode.Quarantine,
      }),
    );
  });

  it("reduce-only stays reduce-only when toxicity is moderate (not > 0.8)", async () => {
    vi.mocked(deps.deploymentRepo.find).mockReturnValue(
      makeDeployment({ operatorMode: OperatorMode.ReduceOnly }),
    );

    // Moderate toxicity -- should not escalate
    vi.mocked(deps.scoreComputer.computeToxicityMetrics).mockReturnValue({
      dustCount: 5,
      positionCount: 5,
      tailCostUsdc: 5,
      realizedPnlUsdc: -2,
      reduceOnlyCount: 1,
      weeksDeployed: 4,
      staleCount: 2,
      totalOpen: 5,
    });

    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalled();
  });

  it("auto-freezes live fee-enabled family on execution canary leakage", async () => {
    deps = createMockDeps({
      activeProfile: ProfileId.LiveLite,
      executionTelemetryReader: {
        readExecutionTelemetry: vi.fn(() => ({
          totalFills: 12,
          volumeUsdc: 20,
          makerFills: 10,
          takerFills: 2,
          unknownFills: 0,
          makerRatio: 10 / 12,
          takerRatio: 2 / 12,
          explicitFeesUsdc: 0.11,
          feeLeakageRatio: 0.0055,
          lastFillAt: new Date().toISOString(),
        })),
      },
    });
    evaluator = new RuntimeSafetyEvaluator(deps);

    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).toHaveBeenCalledWith(
      FAMILY_A,
      ProfileId.LiveLite,
      OperatorMode.ReduceOnly,
      expect.stringContaining("execution canary breach"),
    );
    expect(deps.familyStateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: "reduce-only" }),
    );
    expect(deps.familyEvidenceRepo.updatePromotionState).toHaveBeenCalledWith(
      FAMILY_A,
      "reduce-only",
    );
    expect(deps.stateTransitionRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "family",
        fromState: "scaled",
        toState: "reduce-only",
        triggerType: "system",
      }),
    );
    expect(deps.bus.publish).toHaveBeenCalledWith(
      "FamilyDemotionApplied",
      expect.objectContaining({
        familyId: FAMILY_A,
        previousState: "scaled",
        newState: "reduce-only",
      }),
    );
  });

  it("does not auto-freeze live family for insufficient canary sample alone", async () => {
    deps = createMockDeps({
      activeProfile: ProfileId.LiveLite,
      executionTelemetryReader: {
        readExecutionTelemetry: vi.fn(() => ({
          totalFills: 5,
          volumeUsdc: 10,
          makerFills: 5,
          takerFills: 0,
          unknownFills: 0,
          makerRatio: 1,
          takerRatio: 0,
          explicitFeesUsdc: 0,
          feeLeakageRatio: 0,
          lastFillAt: new Date().toISOString(),
        })),
      },
    });
    evaluator = new RuntimeSafetyEvaluator(deps);

    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalled();
  });

  // ─── Auto-recovery tests ─────────────────────────────────────────────────

  function makeSystemDemotion(overrides: Partial<StateTransition> = {}): StateTransition {
    return {
      id: 1,
      entityType: "family",
      entityId: String(FAMILY_A),
      fromState: "scaled",
      toState: "reduce-only",
      triggerType: "system",
      initiator: "safety-evaluator",
      reason: "Auto-demotion: toxicity 0.65",
      scoresSnapshot: null,
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 48h ago
      ...overrides,
    };
  }

  function setupRecoveryScenario(deps: SafetyEvaluatorDeps): void {
    vi.mocked(deps.deploymentRepo.find).mockReturnValue(
      makeDeployment({ operatorMode: OperatorMode.ReduceOnly }),
    );
    vi.mocked(deps.familyStateRepo.get).mockReturnValue(
      makeFamilyState({ runtimeMode: "reduce-only" }),
    );
    // Clean metrics: low toxicity, positive tail
    vi.mocked(deps.scoreComputer.computeToxicityMetrics).mockReturnValue({
      dustCount: 0,
      positionCount: 5,
      tailCostUsdc: 0,
      realizedPnlUsdc: 0,
      reduceOnlyCount: 0,
      weeksDeployed: 4,
      staleCount: 0,
      totalOpen: 5,
    });
    vi.mocked(deps.scoreComputer.computeRecycleMetrics).mockReturnValue({
      tradeCount: 10,
      distinctMarkets: 3,
      tailAdjustedPnl: 5,
      repricingExits: 2,
      totalNonSettlementClosed: 1,
    });
  }

  it("manual reduce-only does NOT auto-recover", async () => {
    setupRecoveryScenario(deps);
    vi.mocked(deps.stateTransitionRepo.findLastTransitionTo).mockReturnValue(
      makeSystemDemotion({ triggerType: "operator" }),
    );

    evaluator = new RuntimeSafetyEvaluator(deps);
    await evaluator.evaluate();
    await evaluator.evaluate();

    expect(deps.familyEvidenceRepo.updatePromotionState).not.toHaveBeenCalledWith(
      FAMILY_A,
      "scaled",
    );
    expect(deps.log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ previousState: "scaled" }),
      "auto-recovered family from reduce-only",
    );
  });

  it("system reduce-only auto-recovers after 2 consecutive clean passes", async () => {
    setupRecoveryScenario(deps);
    vi.mocked(deps.stateTransitionRepo.findLastTransitionTo).mockReturnValue(
      makeSystemDemotion(),
    );

    evaluator = new RuntimeSafetyEvaluator(deps);

    // Pass 1: clean but not enough consecutive passes
    await evaluator.evaluate();
    expect(deps.log.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ previousState: "scaled" }),
      "auto-recovered family from reduce-only",
    );

    // Pass 2: triggers recovery
    await evaluator.evaluate();
    expect(deps.familyStateRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeMode: "active", quarantineReason: null }),
    );
    expect(deps.deploymentRepo.updateOperatorMode).toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Active,
      "auto-recovery",
    );
    expect(deps.familyEvidenceRepo.updatePromotionState).toHaveBeenCalledWith(
      FAMILY_A,
      "scaled",
    );
    expect(deps.stateTransitionRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        fromState: "reduce-only",
        toState: "scaled",
        triggerType: "system",
        initiator: "safety-evaluator",
        reason: "auto-recovery: metrics clean for 2+ consecutive passes",
      }),
    );
    expect(deps.log.info).toHaveBeenCalledWith(
      { familyId: String(FAMILY_A), previousState: "scaled" },
      "auto-recovered family from reduce-only",
    );
  });

  it("flapping prevented: clean pass 1 does NOT trigger recovery", async () => {
    setupRecoveryScenario(deps);
    vi.mocked(deps.stateTransitionRepo.findLastTransitionTo).mockReturnValue(
      makeSystemDemotion(),
    );

    evaluator = new RuntimeSafetyEvaluator(deps);
    await evaluator.evaluate();

    // Only 1 pass -- no recovery
    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Active,
      "auto-recovery",
    );
  });

  it("recovery restores promotionState from from_state of demotion", async () => {
    setupRecoveryScenario(deps);
    vi.mocked(deps.stateTransitionRepo.findLastTransitionTo).mockReturnValue(
      makeSystemDemotion({ fromState: "probe-only" }),
    );

    evaluator = new RuntimeSafetyEvaluator(deps);
    await evaluator.evaluate();
    await evaluator.evaluate();

    expect(deps.familyEvidenceRepo.updatePromotionState).toHaveBeenCalledWith(
      FAMILY_A,
      "probe-only",
    );
    expect(deps.stateTransitionRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ toState: "probe-only" }),
    );
  });

  it("quarantine does NOT auto-recover", async () => {
    vi.mocked(deps.deploymentRepo.find).mockReturnValue(
      makeDeployment({ operatorMode: OperatorMode.Quarantine }),
    );
    vi.mocked(deps.familyStateRepo.get).mockReturnValue(
      makeFamilyState({ runtimeMode: "quarantine" }),
    );
    vi.mocked(deps.stateTransitionRepo.findLastTransitionTo).mockReturnValue(
      makeSystemDemotion({ toState: "quarantine" }),
    );

    evaluator = new RuntimeSafetyEvaluator(deps);
    await evaluator.evaluate();
    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Active,
      "auto-recovery",
    );
  });

  it("cooldown enforced: system demotion < 24h ago does not recover", async () => {
    setupRecoveryScenario(deps);
    vi.mocked(deps.stateTransitionRepo.findLastTransitionTo).mockReturnValue(
      makeSystemDemotion({
        createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(), // 12h ago
      }),
    );

    evaluator = new RuntimeSafetyEvaluator(deps);
    await evaluator.evaluate();
    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Active,
      "auto-recovery",
    );
  });

  it("metrics gate: toxicity >= 0.3 blocks recovery", async () => {
    setupRecoveryScenario(deps);
    vi.mocked(deps.stateTransitionRepo.findLastTransitionTo).mockReturnValue(
      makeSystemDemotion(),
    );
    // toxicity just at 0.3 threshold (dustCount=3, positionCount=7 gives ~0.3 ratio)
    vi.mocked(deps.scoreComputer.computeToxicityMetrics).mockReturnValue({
      dustCount: 4,
      positionCount: 1,
      tailCostUsdc: 5,
      realizedPnlUsdc: -3,
      reduceOnlyCount: 1,
      weeksDeployed: 4,
      staleCount: 2,
      totalOpen: 5,
    });

    evaluator = new RuntimeSafetyEvaluator(deps);
    await evaluator.evaluate();
    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Active,
      "auto-recovery",
    );
  });

  it("consecutive clean counter resets when metrics fail mid-streak", async () => {
    setupRecoveryScenario(deps);
    vi.mocked(deps.stateTransitionRepo.findLastTransitionTo).mockReturnValue(
      makeSystemDemotion(),
    );

    evaluator = new RuntimeSafetyEvaluator(deps);

    // Pass 1: clean
    await evaluator.evaluate();

    // Pass 2: dirty -- negative tailAdjustedPnl resets counter
    vi.mocked(deps.scoreComputer.computeRecycleMetrics).mockReturnValue({
      tradeCount: 10,
      distinctMarkets: 3,
      tailAdjustedPnl: -1,
      repricingExits: 2,
      totalNonSettlementClosed: 1,
    });
    await evaluator.evaluate();

    // Pass 3: clean again -- but counter was reset, so this is only pass 1
    vi.mocked(deps.scoreComputer.computeRecycleMetrics).mockReturnValue({
      tradeCount: 10,
      distinctMarkets: 3,
      tailAdjustedPnl: 5,
      repricingExits: 2,
      totalNonSettlementClosed: 1,
    });
    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Active,
      "auto-recovery",
    );

    // Pass 4: second consecutive clean -- now recovery triggers
    await evaluator.evaluate();
    expect(deps.deploymentRepo.updateOperatorMode).toHaveBeenCalledWith(
      FAMILY_A,
      PROFILE,
      OperatorMode.Active,
      "auto-recovery",
    );
  });

  it("ignores execution canary outside live-lite", async () => {
    deps = createMockDeps({
      activeProfile: ProfileId.Paper,
      executionTelemetryReader: {
        readExecutionTelemetry: vi.fn(() => ({
          totalFills: 12,
          volumeUsdc: 18,
          makerFills: 8,
          takerFills: 4,
          unknownFills: 0,
          makerRatio: 8 / 12,
          takerRatio: 4 / 12,
          explicitFeesUsdc: 0.2,
          feeLeakageRatio: 0.0111,
          lastFillAt: new Date().toISOString(),
        })),
      },
    });
    evaluator = new RuntimeSafetyEvaluator(deps);

    await evaluator.evaluate();

    expect(deps.deploymentRepo.updateOperatorMode).not.toHaveBeenCalled();
  });
});
