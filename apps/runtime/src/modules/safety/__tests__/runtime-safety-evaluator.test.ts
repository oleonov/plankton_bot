import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeSafetyEvaluator } from "../runtime-safety-evaluator.js";
import type { SafetyEvaluatorDeps } from "../runtime-safety-evaluator.js";
import type { FamilyIdentity, FamilyState, FamilyDeployment } from "@plankton/domain";
import {
  OperatorMode,
  StrategyStage,
  DeploymentStage,
  type ProfileId,
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
      findRecent: vi.fn(() => []),
    },
    familyStateRepo: {
      get: vi.fn(() => makeFamilyState()),
      save: vi.fn(),
      findAll: vi.fn(() => []),
      findByMode: vi.fn(() => []),
      findQuarantined: vi.fn(() => []),
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
    expect(deps.stateTransitionRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "family_deployment",
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
});
