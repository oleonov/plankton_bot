import { describe, it, expect, vi } from "vitest";
import { AlgoDecisionModule } from "../modules/algo-decision/algo-decision-module.js";
import type {
  AlgoDecisionRule,
  AlgoRulesRepository,
  EventBus,
  LegStateRepository,
} from "@plankton/domain";
import type { SelectedMarketCache } from "../modules/algo-decision/algo-decision-module.js";
import type { Logger } from "../logger.js";

const FALLBACK_RULE: AlgoDecisionRule = {
  id: 99,
  priority: 99,
  ruleId: "FALLBACK",
  stateCondition: "ANY",
  priceOperator: null,
  priceValue: null,
  timeSinceLastOperator: null,
  timeSinceLastSeconds: null,
  buyCountMin: null,
  buyCountMax: null,
  holdDurationOperator: null,
  holdDurationSeconds: null,
  action: "BUY",
};

const REDEEM_RULE: AlgoDecisionRule = {
  id: 1,
  priority: 10,
  ruleId: "REDEEM-S1",
  stateCondition: "S1",
  priceOperator: "<",
  priceValue: 0.05,
  timeSinceLastOperator: null,
  timeSinceLastSeconds: null,
  buyCountMin: null,
  buyCountMax: null,
  holdDurationOperator: "<=",
  holdDurationSeconds: 3600,
  action: "REDEEM",
};

function mockBus(): EventBus {
  return {
    publish: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    drain: vi.fn(async () => {}),
  };
}

function mockLegRepo(): LegStateRepository {
  return {
    get: vi.fn(() => null),
    upsert: vi.fn(),
    delete: vi.fn(),
    getAll: vi.fn(() => []),
  };
}

function mockRulesRepo(rules: AlgoDecisionRule[]): AlgoRulesRepository {
  return {
    getDecisionRules: vi.fn(() => rules),
    getSizeRules: vi.fn(() => []),
  };
}

function mockCache(): SelectedMarketCache {
  return {
    isEligible: vi.fn(() => false),
    getEligibleTokenIds: vi.fn(() => []),
  };
}

function mockLog(): Logger {
  const child = vi.fn(() => mockLog());
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child,
  } as unknown as Logger;
}

function buildModule(rules: AlgoDecisionRule[]): AlgoDecisionModule {
  return new AlgoDecisionModule({
    bus: mockBus(),
    legStateRepo: mockLegRepo(),
    algoRulesRepo: mockRulesRepo(rules),
    selectedMarketCache: mockCache(),
    log: mockLog(),
    sweepIntervalMs: 12_000,
  });
}

describe("AlgoDecisionModule startup FALLBACK validation", () => {
  it("starts normally when a FALLBACK decision rule is present", async () => {
    const mod = buildModule([FALLBACK_RULE, REDEEM_RULE]);
    await expect(mod.start()).resolves.toBeUndefined();
    await mod.stop();
  });

  it("refuses to start when no FALLBACK rule exists (but other rules present)", async () => {
    const mod = buildModule([REDEEM_RULE]);
    await expect(mod.start()).rejects.toThrow(/FALLBACK rule missing/);
  });

  it("refuses to start when the decision-rules table is empty", async () => {
    const mod = buildModule([]);
    await expect(mod.start()).rejects.toThrow(/FALLBACK rule missing/);
  });
});
