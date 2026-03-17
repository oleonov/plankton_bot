import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createTokenId,
  createFamilyId,
  createPositionId,
} from "@plankton/domain";
import type {
  MarketRepository,
  MarketResolutionRepository,
  MarketResolution,
  FamilyRulesProvider,
  FamilyRuleBundle,
  FamilyId,
  TokenId,
  PositionId,
} from "@plankton/domain";
import { InProcessEventBus } from "@plankton/event-bus";
import { ResolutionModule } from "../modules/resolution/resolution-module.js";
import type { ResolutionDetector, DetectedResolution } from "../modules/resolution/resolution-detector.js";
import type { PositionSettler, SettledPosition } from "../modules/resolution/position-settler.js";
import type { FamilyExposureCalculator } from "../modules/risk-inventory/family-exposure.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const TOK_YES = createTokenId("tok-yes");
const TOK_NO = createTokenId("tok-no");
const FAM = createFamilyId("fam-1");
const FAM2 = createFamilyId("fam-2");
const POS = createPositionId("pos-1");
const POS2 = createPositionId("pos-2");
const CONDITION = "condition-abc";

// ─── Mock factories ────────────────────────────────────────────────────────

function makeDetectedResolution(overrides?: Partial<DetectedResolution>): DetectedResolution {
  return {
    conditionId: CONDITION,
    resolution: "YES",
    resolvedAt: "2026-01-15T00:00:00Z",
    source: "gamma-api",
    rawResponse: "{}",
    candidates: [
      {
        tokenId: TOK_YES,
        conditionId: CONDITION,
        slug: "will-x-happen",
        outcome: "YES",
        endDate: "2026-01-14T00:00:00Z",
        positionId: POS,
        familyId: FAM,
      },
    ],
    ...overrides,
  };
}

function makeSettledPosition(overrides?: Partial<SettledPosition>): SettledPosition {
  return {
    positionId: POS,
    tokenId: TOK_YES,
    familyId: FAM,
    resolution: "YES",
    settlementPrice: 1.0,
    realizedPnl: 0.8,
    size: 100,
    avgEntryPrice: 0.2,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createMockDetector(): ResolutionDetector {
  return {
    detect: vi.fn<(graceMinutes: number) => Promise<DetectedResolution[]>>().mockResolvedValue([]),
  } as unknown as ResolutionDetector;
}

function createMockSettler(): PositionSettler {
  return {
    settle: vi.fn<(resolution: DetectedResolution) => SettledPosition[]>().mockReturnValue([]),
  } as unknown as PositionSettler;
}

function createMockMarketRepo(): MarketRepository {
  return {
    findByTokenIds: vi.fn().mockReturnValue([]),
    findByTokenId: vi.fn().mockReturnValue(null),
    upsertAll: vi.fn(),
    findAll: vi.fn().mockReturnValue([]),
    findActive: vi.fn().mockReturnValue([]),
    deactivate: vi.fn(),
  } as unknown as MarketRepository;
}

function createMockResolutionRepo(): MarketResolutionRepository {
  return {
    save: vi.fn(),
    findByConditionId: vi.fn().mockReturnValue(null),
    findAll: vi.fn().mockReturnValue([]),
  } as unknown as MarketResolutionRepository;
}

function createMockRulesProvider(overrides?: {
  autoSettle?: boolean;
}): FamilyRulesProvider {
  const autoSettle = overrides?.autoSettle ?? true;
  return {
    getRule: vi.fn<(familyId: FamilyId) => FamilyRuleBundle | null>().mockReturnValue({
      rules: {
        tailSuppression: { autoSettleResolvedMarkets: autoSettle },
      },
    } as unknown as FamilyRuleBundle),
    isEnabled: vi.fn().mockReturnValue(true),
    getAllFamilies: vi.fn().mockReturnValue([]),
    getRulesForRegime: vi.fn().mockReturnValue([]),
  } as unknown as FamilyRulesProvider;
}

function createMockExposureCalculator(): FamilyExposureCalculator {
  return {
    recompute: vi.fn().mockReturnValue({
      openValueUsdc: 0,
      openPositionCount: 0,
      openDustCount: 0,
    }),
  } as unknown as FamilyExposureCalculator;
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ResolutionModule", () => {
  let bus: InProcessEventBus;
  let detector: ReturnType<typeof createMockDetector>;
  let settler: ReturnType<typeof createMockSettler>;
  let marketRepo: ReturnType<typeof createMockMarketRepo>;
  let resolutionRepo: ReturnType<typeof createMockResolutionRepo>;
  let rulesProvider: ReturnType<typeof createMockRulesProvider>;
  let exposureCalculator: ReturnType<typeof createMockExposureCalculator>;
  let mod: ResolutionModule;

  function createModule(overrides?: { rulesProvider?: FamilyRulesProvider }) {
    return new ResolutionModule({
      detector: detector as unknown as ResolutionDetector,
      settler: settler as unknown as PositionSettler,
      marketRepo: marketRepo as unknown as MarketRepository,
      resolutionRepo: resolutionRepo as unknown as MarketResolutionRepository,
      rulesProvider: (overrides?.rulesProvider ?? rulesProvider) as unknown as FamilyRulesProvider,
      exposureCalculator: exposureCalculator as unknown as FamilyExposureCalculator,
      bus,
      log: log as any,
      checkIntervalMs: 60_000,
      graceMinutes: 30,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    bus = new InProcessEventBus();
    detector = createMockDetector();
    settler = createMockSettler();
    marketRepo = createMockMarketRepo();
    resolutionRepo = createMockResolutionRepo();
    rulesProvider = createMockRulesProvider();
    exposureCalculator = createMockExposureCalculator();
    mod = createModule();
  });

  // ─── Detection ──────────────────────────────────────────────────────────

  it("returns 0 when detector finds no resolutions", async () => {
    const count = await mod.runCheck();
    expect(count).toBe(0);
    expect((detector.detect as any)).toHaveBeenCalledWith(30);
  });

  it("passes graceMinutes to detector", async () => {
    const custom = new ResolutionModule({
      detector: detector as unknown as ResolutionDetector,
      settler: settler as unknown as PositionSettler,
      marketRepo: marketRepo as unknown as MarketRepository,
      resolutionRepo: resolutionRepo as unknown as MarketResolutionRepository,
      rulesProvider: rulesProvider as unknown as FamilyRulesProvider,
      exposureCalculator: exposureCalculator as unknown as FamilyExposureCalculator,
      bus,
      log: log as any,
      checkIntervalMs: 60_000,
      graceMinutes: 45,
    });
    await custom.runCheck();
    expect((detector.detect as any)).toHaveBeenCalledWith(45);
  });

  // ─── Resolution persistence ─────────────────────────────────────────────

  it("saves resolution record to repository", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect((resolutionRepo.save as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        conditionId: CONDITION,
        resolution: "YES",
        source: "gamma-api",
      }),
    );
  });

  // ─── Market deactivation ────────────────────────────────────────────────

  it("deactivates markets for resolved conditions", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect((marketRepo.deactivate as any)).toHaveBeenCalledWith(TOK_YES);
  });

  it("deactivates all tokens in a multi-token resolution", async () => {
    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES, conditionId: CONDITION, slug: "will-x",
          outcome: "YES", endDate: "2026-01-14T00:00:00Z",
          positionId: POS, familyId: FAM,
        },
        {
          tokenId: TOK_NO, conditionId: CONDITION, slug: "will-x",
          outcome: "NO", endDate: "2026-01-14T00:00:00Z",
          positionId: POS2, familyId: FAM,
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect((marketRepo.deactivate as any)).toHaveBeenCalledWith(TOK_YES);
    expect((marketRepo.deactivate as any)).toHaveBeenCalledWith(TOK_NO);
  });

  // ─── Settlement ─────────────────────────────────────────────────────────

  it("calls settler.settle and returns settled count", async () => {
    const resolution = makeDetectedResolution();
    const settled = [makeSettledPosition()];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    const count = await mod.runCheck();

    expect(count).toBe(1);
    expect((settler.settle as any)).toHaveBeenCalledWith(
      expect.objectContaining({ conditionId: CONDITION }),
    );
  });

  it("accumulates settled count across multiple resolutions", async () => {
    const r1 = makeDetectedResolution({ conditionId: "cond-1" });
    const r2 = makeDetectedResolution({ conditionId: "cond-2" });
    (detector.detect as any).mockResolvedValue([r1, r2]);
    (settler.settle as any)
      .mockReturnValueOnce([makeSettledPosition()])
      .mockReturnValueOnce([makeSettledPosition(), makeSettledPosition()]);

    const count = await mod.runCheck();
    expect(count).toBe(3);
  });

  // ─── autoSettleResolvedMarkets flag ─────────────────────────────────────

  it("skips settlement when autoSettleResolvedMarkets is false", async () => {
    const provider = createMockRulesProvider({ autoSettle: false });
    mod = createModule({ rulesProvider: provider });

    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const count = await mod.runCheck();

    expect(count).toBe(0);
    expect((settler.settle as any)).not.toHaveBeenCalled();
  });

  it("settles only families with autoSettle enabled in mixed batch", async () => {
    // fam-1 has autoSettle=true, fam-2 has autoSettle=false
    const provider: FamilyRulesProvider = {
      getRule: vi.fn((familyId: FamilyId) => {
        const autoSettle = String(familyId) !== "fam-2";
        return {
          rules: { tailSuppression: { autoSettleResolvedMarkets: autoSettle } },
        } as unknown as FamilyRuleBundle;
      }),
      isEnabled: vi.fn().mockReturnValue(true),
      getAllFamilies: vi.fn().mockReturnValue([]),
      getRulesForRegime: vi.fn().mockReturnValue([]),
    } as unknown as FamilyRulesProvider;

    mod = createModule({ rulesProvider: provider });

    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES, conditionId: CONDITION, slug: "will-x",
          outcome: "YES", endDate: "2026-01-14T00:00:00Z",
          positionId: POS, familyId: FAM,
        },
        {
          tokenId: TOK_NO, conditionId: CONDITION, slug: "will-x",
          outcome: "NO", endDate: "2026-01-14T00:00:00Z",
          positionId: POS2, familyId: FAM2,
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue([makeSettledPosition()]);

    await mod.runCheck();

    // settler.settle should receive only fam-1's candidate
    const settleArg = (settler.settle as any).mock.calls[0][0];
    expect(settleArg.candidates).toHaveLength(1);
    expect(settleArg.candidates[0].familyId).toBe(FAM);
  });

  // ─── Event publishing ──────────────────────────────────────────────────

  it("publishes MarketResolved event", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const events: unknown[] = [];
    bus.subscribe("MarketResolved", async (e) => { events.push(e); });

    await mod.runCheck();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        conditionId: CONDITION,
        resolution: "YES",
        source: "gamma-api",
      }),
    );
  });

  it("publishes PositionSettled events for each settled position", async () => {
    const resolution = makeDetectedResolution();
    const settled = [
      makeSettledPosition({ positionId: POS }),
      makeSettledPosition({ positionId: POS2, tokenId: TOK_NO }),
    ];
    (detector.detect as any).mockResolvedValue([resolution]);
    (settler.settle as any).mockReturnValue(settled);

    const events: unknown[] = [];
    bus.subscribe("PositionSettled", async (e) => { events.push(e); });

    await mod.runCheck();

    expect(events).toHaveLength(2);
  });

  // ─── Family exposure recomputation ──────────────────────────────────────

  it("recomputes family exposure for affected families", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect((exposureCalculator.recompute as any)).toHaveBeenCalledWith(FAM, false);
  });

  it("publishes FamilyExposureChanged after recompute", async () => {
    const resolution = makeDetectedResolution();
    (detector.detect as any).mockResolvedValue([resolution]);

    const events: unknown[] = [];
    bus.subscribe("FamilyExposureChanged", async (e) => { events.push(e); });

    await mod.runCheck();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({ familyId: FAM }),
    );
  });

  it("deduplicates family recompute when multiple positions share a family", async () => {
    const resolution = makeDetectedResolution({
      candidates: [
        {
          tokenId: TOK_YES, conditionId: CONDITION, slug: "will-x",
          outcome: "YES", endDate: "2026-01-14T00:00:00Z",
          positionId: POS, familyId: FAM,
        },
        {
          tokenId: TOK_NO, conditionId: CONDITION, slug: "will-x",
          outcome: "NO", endDate: "2026-01-14T00:00:00Z",
          positionId: POS2, familyId: FAM, // same family
        },
      ],
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    // recompute should only be called once for FAM
    expect((exposureCalculator.recompute as any)).toHaveBeenCalledTimes(1);
  });

  // ─── Unknown resolution guard ────────────────────────────────────────

  it("does not settle when resolution is unknown (delisted market)", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    const count = await mod.runCheck();

    expect(count).toBe(0);
    expect((settler.settle as any)).not.toHaveBeenCalled();
  });

  it("still publishes MarketResolved for unknown resolution", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    const events: unknown[] = [];
    bus.subscribe("MarketResolved", async (e) => { events.push(e); });

    await mod.runCheck();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({ resolution: "unknown" }),
    );
  });

  it("still deactivates markets for unknown resolution", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect((marketRepo.deactivate as any)).toHaveBeenCalledWith(TOK_YES);
  });

  it("still persists resolution record for unknown resolution", async () => {
    const resolution = makeDetectedResolution({
      resolution: "unknown",
      source: "gamma-delisted",
    });
    (detector.detect as any).mockResolvedValue([resolution]);

    await mod.runCheck();

    expect((resolutionRepo.save as any)).toHaveBeenCalledWith(
      expect.objectContaining({
        conditionId: CONDITION,
        resolution: "unknown",
      }),
    );
  });

  // ─── Re-entrancy guard ─────────────────────────────────────────────────

  it("prevents concurrent runCheck invocations", async () => {
    let resolveDetect: () => void;
    (detector.detect as any).mockReturnValue(
      new Promise<DetectedResolution[]>((r) => { resolveDetect = () => r([]); }),
    );

    const p1 = mod.runCheck();
    const p2 = mod.runCheck(); // should return 0 immediately

    const count2 = await p2;
    expect(count2).toBe(0);

    resolveDetect!();
    const count1 = await p1;
    expect(count1).toBe(0);
  });

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  it("stop clears interval", async () => {
    await mod.start();
    await mod.stop();
    // No assertions needed — just verifying no errors
  });

  it("healthCheck returns ok", async () => {
    const health = await mod.healthCheck();
    expect(health.ok).toBe(true);
  });
});
