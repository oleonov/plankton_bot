import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { InProcessEventBus } from "@plankton/event-bus";
import {
  bootstrapDatabase,
  SqliteOperatorCommandRepository,
  SqliteOperatorActionRepository,
  SqliteFamilyStateRepository,
  SqliteFamilyCatalogRepository,
  SqliteFamilyEvidenceRepository,
  SqliteFamilyRulesSnapshotRepository,
  SqliteFamilyCandidateRepository,
  SqliteStateTransitionRepository,
} from "@plankton/db";
import type { DbConnection } from "@plankton/db";
import { createFamilyId } from "@plankton/domain";
import type {
  FamilyIdentity,
  OperatorActionType,
  FamilyCandidate,
  RuntimeEventMap,
} from "@plankton/domain";
import { CommandPoller } from "../supervisor/command-poller.js";
import type { ReloadableRules, PatternRebuilder, FamilyRulesDbWriter } from "../supervisor/command-poller.js";

const log = pino({ level: "silent" });

let conn: DbConnection;
let tmpDir: string;
let cmdRepo: SqliteOperatorCommandRepository;
let actionRepo: SqliteOperatorActionRepository;
let familyStateRepo: SqliteFamilyStateRepository;
let catalogRepo: SqliteFamilyCatalogRepository;
let bus: InProcessEventBus;
let paused: boolean;

function makeIdentity(familyId: string): FamilyIdentity {
  return {
    familyId: createFamilyId(familyId),
    familyKey: "test-key",
    primaryCategory: "test",
    regime: "threshold",
    horizon: "daily",
    cadence: "daily",
    strategyProfile: "scalp",
    topicKey: null,
    slugPattern: null,
    notes: null,
  };
}

function seedFamily(familyId: string): void {
  catalogRepo.upsert(makeIdentity(familyId));
  familyStateRepo.save({
    familyId: createFamilyId(familyId),
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
  });
}

function seedFamilyEvidence(familyId: string): void {
  conn.db
    .prepare(
      `INSERT OR REPLACE INTO family_evidence
         (family_id, evidence_status, evidence_score, promotion_state,
          local_trade_count, local_market_count, local_realized_pnl_fifo,
          open_tail_cost_usdc, tail_adjusted_pnl, both_sided_eligible,
          heavy_campaign_eligible)
       VALUES (?, 'confirmed', 1, 'probe-only', 0, 0, 0, 0, 0, 0, 0)`,
    )
    .run(familyId);
}

function insertCommand(
  action: OperatorActionType,
  targetId?: string,
  reason?: string,
  opts?: { initiatorType: "operator" | "system"; initiator?: string },
): number {
  const base = {
    action,
    targetId: targetId ?? null,
    reason: reason ?? null,
    createdAt: new Date().toISOString(),
  };
  if (opts) {
    return cmdRepo.insert({
      ...base,
      initiatorType: opts.initiatorType,
      initiator: opts.initiator ?? null,
    });
  }
  return cmdRepo.insert(base);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-test-"));
  conn = bootstrapDatabase(path.join(tmpDir, "test.db"));
  cmdRepo = new SqliteOperatorCommandRepository(conn.db);
  actionRepo = new SqliteOperatorActionRepository(conn.db);
  familyStateRepo = new SqliteFamilyStateRepository(conn.db);
  catalogRepo = new SqliteFamilyCatalogRepository(conn.db);
  bus = new InProcessEventBus();
  paused = false;
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CommandPoller", () => {
  function createPoller(extra?: Partial<ConstructorParameters<typeof CommandPoller>[0]>): CommandPoller {
    return new CommandPoller({
      commandRepo: cmdRepo,
      actionRepo,
      familyStateRepo,
      bus,
      log,
      getPaused: () => paused,
      setPaused: (p) => {
        paused = p;
      },
      pollIntervalMs: 60_000,
      ...extra,
    });
  }

  // ── Existing command tests ──────────────────────────────────────────────

  it("applies pause command and writes audit", async () => {
    insertCommand("pause", undefined, "maintenance");
    const poller = createPoller();

    await poller.poll();

    expect(paused).toBe(true);
    const actions = actionRepo.findRecent(10);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("pause");
    expect(actions[0]!.targetType).toBe("bot");

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(0);
  });

  it("applies resume command", async () => {
    paused = true;
    insertCommand("resume");
    const poller = createPoller();

    await poller.poll();

    expect(paused).toBe(false);
  });

  it("applies family_quarantine and updates runtime state", async () => {
    seedFamily("fam-1");
    insertCommand("family_quarantine", "fam-1", "tail exceeded");
    const poller = createPoller();

    await poller.poll();

    const state = familyStateRepo.get(createFamilyId("fam-1"));
    expect(state!.runtimeMode).toBe("quarantine");
    expect(state!.quarantineReason).toBe("tail exceeded");
  });

  it("applies family_reduce_only", async () => {
    seedFamily("fam-1");
    insertCommand("family_reduce_only", "fam-1");
    const poller = createPoller();

    await poller.poll();

    const state = familyStateRepo.get(createFamilyId("fam-1"));
    expect(state!.runtimeMode).toBe("reduce-only");
  });

  it("applies family_activate and clears quarantine reason", async () => {
    seedFamily("fam-1");
    // First quarantine
    insertCommand("family_quarantine", "fam-1", "some reason");
    const poller = createPoller();
    await poller.poll();

    // Then activate
    insertCommand("family_activate", "fam-1");
    await poller.poll();

    const state = familyStateRepo.get(createFamilyId("fam-1"));
    expect(state!.runtimeMode).toBe("active");
    expect(state!.quarantineReason).toBeNull();
  });

  it("rejects command when family not found", async () => {
    insertCommand("family_quarantine", "nonexistent", "reason");
    const poller = createPoller();

    await poller.poll();

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(0);

    // Should have been marked rejected (no audit action for rejected)
    const actions = actionRepo.findRecent(10);
    expect(actions).toHaveLength(0);
  });

  it("rejects family command without targetId", async () => {
    insertCommand("family_quarantine", undefined, "reason");
    const poller = createPoller();

    await poller.poll();

    const pending = cmdRepo.getPending();
    expect(pending).toHaveLength(0);
  });

  it("publishes OperatorCommandApplied event on success", async () => {
    const events: unknown[] = [];
    bus.subscribe("OperatorCommandApplied", async (payload) => {
      events.push(payload);
    });

    insertCommand("pause", undefined, "test");
    const poller = createPoller();

    await poller.poll();

    expect(events).toHaveLength(1);
  });

  it("processes multiple commands in one poll", async () => {
    seedFamily("fam-1");
    insertCommand("pause");
    insertCommand("family_quarantine", "fam-1", "reason");

    const poller = createPoller();
    await poller.poll();

    expect(paused).toBe(true);
    const state = familyStateRepo.get(createFamilyId("fam-1"));
    expect(state!.runtimeMode).toBe("quarantine");
    expect(cmdRepo.getPending()).toHaveLength(0);
  });

  it("concurrent poll calls are serialized by guard", async () => {
    insertCommand("pause");
    const poller = createPoller();

    // Fire two polls concurrently — second should be skipped
    const [_r1, _r2] = await Promise.all([poller.poll(), poller.poll()]);

    // Only one audit action should exist (not two)
    const actions = actionRepo.findRecent(10);
    expect(actions).toHaveLength(1);
  });

  it("start/stop lifecycle works", async () => {
    const poller = createPoller();

    await poller.start();
    const health = await poller.healthCheck();
    expect(health.ok).toBe(true);

    await poller.stop();
  });

  // ── rules_reload ────────────────────────────────────────────────────────

  describe("rules_reload", () => {
    it("calls reload + rebuildPatterns and promotes materialized candidates", async () => {
      const rulesManager: ReloadableRules = { reload: vi.fn() };
      const normalizationModule: PatternRebuilder = { rebuildPatterns: vi.fn() };
      const candidateRepo = new SqliteFamilyCandidateRepository(conn.db);

      // Seed a materialized candidate
      candidateRepo.upsert({
        candidateId: "cand-1",
        familyKey: "test",
        regime: "threshold",
        horizon: "daily",
        cadence: "daily",
        patternConfidence: "high",
        primaryCategory: "test",
        strategyProfile: "scalp",
        slugPattern: null,
        matchedFamilyId: null,
        activeMarketCount: 3,
        nearestEndDate: null,
        clusterVolume24h: 1000,
        recurrenceScore: null,
        recycleScore: null,
        liveViabilityScore: null,
        toxicityPenalty: null,
        gateRecommendation: "promote",
        recommendationReason: null,
        scoresUpdatedAt: null,
        status: "materialized",
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        reviewedAt: null,
        materializedAt: new Date().toISOString(),
      });

      insertCommand("rules_reload");
      const poller = createPoller({
        rulesManager,
        normalizationModule,
        familyCandidateRepo: candidateRepo,
      });

      await poller.poll();

      expect(rulesManager.reload).toHaveBeenCalledOnce();
      expect(normalizationModule.rebuildPatterns).toHaveBeenCalledOnce();

      const updated = candidateRepo.findById("cand-1");
      expect(updated!.status).toBe("deployed");
    });

    it("rejects rules_reload without rulesManager dep", async () => {
      insertCommand("rules_reload");
      const poller = createPoller();

      await poller.poll();

      // Command should be rejected
      expect(cmdRepo.getPending()).toHaveLength(0);
      const actions = actionRepo.findRecent(10);
      expect(actions).toHaveLength(0); // rejected commands don't write audit
    });
  });

  // ── family_promote_scaled ───────────────────────────────────────────────

  describe("family_promote_scaled", () => {
    it("updates family_rules to scaled defaults, sets runtime_mode to active, and promotion_state to scaled", async () => {
      seedFamily("fam-1");
      seedFamilyEvidence("fam-1");

      // Seed a family_rules row so updateToScaledDefaults has a target
      conn.db
        .prepare(
          `INSERT OR REPLACE INTO family_rules (family_id, max_open_value_usdc, max_active_markets,
             max_dust_positions, enabled, action, priority_rank, entry_mode,
             max_initial_notional_usdc, tail_quarantine_threshold_usdc,
             tail_quarantine_threshold_ratio, scale_mode, default_max_buys_per_leg,
             allow_heavy_campaigns, require_positive_recycle_history_for_scale, updated_at)
           VALUES ('fam-1', 10.0, 2, 1, 1, 'trade', 1, 'probe-first', 5.0, 100, 0.5,
                   'disabled', 1, 0, 0, datetime('now'))`,
        )
        .run();

      const rulesManager: ReloadableRules = { reload: vi.fn() };
      const normalizationModule: PatternRebuilder = { rebuildPatterns: vi.fn() };
      const evidenceRepo = new SqliteFamilyEvidenceRepository(conn.db);
      const transitionRepo = new SqliteStateTransitionRepository(conn.db);
      const { SqliteFamilyRulesDbRepository } = await import("@plankton/db");
      const dbWriter = new SqliteFamilyRulesDbRepository(conn.db);

      insertCommand("family_promote_scaled", "fam-1", "promotion approved");
      const poller = createPoller({
        rulesManager,
        normalizationModule,
        familyEvidenceRepo: evidenceRepo,
        stateTransitionRepo: transitionRepo,
        familyRulesDbWriter: dbWriter,
      });

      await poller.poll();

      const state = familyStateRepo.get(createFamilyId("fam-1"));
      expect(state!.runtimeMode).toBe("active");

      const evidence = evidenceRepo.getEvidence(createFamilyId("fam-1"));
      expect(evidence!.promotionState).toBe("scaled");

      // Verify family_rules were updated to scaled defaults
      const rulesRow = conn.db
        .prepare("SELECT scale_mode, max_open_value_usdc, max_active_markets, max_dust_positions, default_max_buys_per_leg FROM family_rules WHERE family_id = ?")
        .get("fam-1") as Record<string, unknown>;
      expect(rulesRow.scale_mode).toBe("confirm-only");
      expect(rulesRow.max_open_value_usdc).toBe(50.0);
      expect(rulesRow.max_active_markets).toBe(5);
      expect(rulesRow.max_dust_positions).toBe(3);
      expect(rulesRow.default_max_buys_per_leg).toBe(3);

      const transitions = transitionRepo.findByEntity("family", "fam-1");
      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.fromState).toBe("probe-only");
      expect(transitions[0]!.toState).toBe("scaled");

      expect(rulesManager.reload).toHaveBeenCalledOnce();
      expect(normalizationModule.rebuildPatterns).toHaveBeenCalledOnce();
    });
  });

  // ── family_reset_to_probe ──────────────────────────────────────────────

  describe("family_reset_to_probe", () => {
    it("reads snapshot, overwrites rules, and resets to probe-only", async () => {
      seedFamily("fam-1");
      seedFamilyEvidence("fam-1");

      const snapshotRepo = new SqliteFamilyRulesSnapshotRepository(conn.db);
      const rulesJson = JSON.stringify({ enabled: true, action: "trade" });
      snapshotRepo.save({
        familyId: createFamilyId("fam-1"),
        snapshot: rulesJson,
        reason: "probe-baseline",
        capturedAt: new Date().toISOString(),
      });

      const rulesManager: ReloadableRules = { reload: vi.fn() };
      const normalizationModule: PatternRebuilder = { rebuildPatterns: vi.fn() };
      const evidenceRepo = new SqliteFamilyEvidenceRepository(conn.db);
      const transitionRepo = new SqliteStateTransitionRepository(conn.db);
      const dbWriter: FamilyRulesDbWriter = { overwriteRules: vi.fn(), updateToScaledDefaults: vi.fn() };

      insertCommand("family_reset_to_probe", "fam-1", "resetting");
      const poller = createPoller({
        rulesManager,
        normalizationModule,
        familyEvidenceRepo: evidenceRepo,
        stateTransitionRepo: transitionRepo,
        familyRulesSnapshotRepo: snapshotRepo,
        familyRulesDbWriter: dbWriter,
      });

      await poller.poll();

      expect(dbWriter.overwriteRules).toHaveBeenCalledWith(createFamilyId("fam-1"), rulesJson);
      expect(rulesManager.reload).toHaveBeenCalledOnce();

      const state = familyStateRepo.get(createFamilyId("fam-1"));
      expect(state!.runtimeMode).toBe("active");

      const evidence = evidenceRepo.getEvidence(createFamilyId("fam-1"));
      expect(evidence!.promotionState).toBe("probe-only");

      const transitions = transitionRepo.findByEntity("family", "fam-1");
      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.fromState).toBe("probe-only");
      expect(transitions[0]!.toState).toBe("probe-only");
      expect(transitions[0]!.scoresSnapshot).toBe(rulesJson);
    });

    it("rejects when no snapshot exists", async () => {
      seedFamily("fam-1");
      const snapshotRepo = new SqliteFamilyRulesSnapshotRepository(conn.db);
      const dbWriter: FamilyRulesDbWriter = { overwriteRules: vi.fn(), updateToScaledDefaults: vi.fn() };

      insertCommand("family_reset_to_probe", "fam-1", "resetting");
      const poller = createPoller({
        rulesManager: { reload: vi.fn() },
        familyRulesSnapshotRepo: snapshotRepo,
        familyRulesDbWriter: dbWriter,
      });

      await poller.poll();

      // Should be rejected
      expect(cmdRepo.getPending()).toHaveLength(0);
      expect(dbWriter.overwriteRules).not.toHaveBeenCalled();
    });
  });

  // ── promote → reset round-trip verifying actual DB rules ──────────────

  describe("promote then reset round-trip", () => {
    it("promote changes scale_mode and caps, reset reverts them, runtime_mode stays active", async () => {
      seedFamily("fam-1");
      seedFamilyEvidence("fam-1");

      // Seed probe-only family_rules row
      conn.db
        .prepare(
          `INSERT OR REPLACE INTO family_rules (family_id, max_open_value_usdc, max_active_markets,
             max_dust_positions, enabled, action, priority_rank, entry_mode,
             max_initial_notional_usdc, tail_quarantine_threshold_usdc,
             tail_quarantine_threshold_ratio, scale_mode, default_max_buys_per_leg,
             allow_heavy_campaigns, require_positive_recycle_history_for_scale, updated_at)
           VALUES ('fam-1', 10.0, 2, 1, 1, 'trade', 1, 'probe-first', 5.0, 100, 0.5,
                   'disabled', 1, 0, 0, datetime('now'))`,
        )
        .run();

      // Save a baseline snapshot for reset (camelCase keys matching overwriteRules expectation)
      const snapshotRepo = new SqliteFamilyRulesSnapshotRepository(conn.db);
      const baselineJson = JSON.stringify({
        enabled: true,
        action: "trade",
        priorityRank: 1,
        allowWeekends: false,
        sessionMode: "active-window",
        entryMode: "probe-first",
        minEntryPrice: 0,
        maxEntryPrice: 1,
        maxInitialNotionalUsdc: 5.0,
        allowHighPriceOneShot: false,
        highPriceThreshold: 0.2,
        requireProvenFamilyAbovePrice: 0.2,
        preferredEntryBand: null,
        maxProbeCountPerMarket: null,
        entryCooldownSeconds: null,
        maxNewMarketsPerSession: null,
        scaleMode: "disabled",
        defaultMaxBuysPerLeg: 1,
        heavyMaxBuysPerLeg: 6,
        allowHeavyCampaigns: false,
        requirePositiveRecycleHistoryForScale: false,
        exitMode: "disabled",
        primaryProfitModel: "sell-into-strength",
        allowRunnerExtension: false,
        preferFastRecycle: true,
        resolutionHoldingAllowed: false,
        targetRoiBandLow: null,
        targetRoiBandHigh: null,
        maxUnmovedHoldHours: null,
        maxTailHoldHours: null,
        allowTwoSided: false,
        twoSidedMode: "disabled",
        minActivityForTwoSided: null,
        maxOpenValueUsdc: 10.0,
        maxActiveMarkets: 2,
        maxDustPositions: 1,
        tailQuarantineThresholdUsdc: 100,
        tailQuarantineThresholdRatio: 0.5,
        staleTailPruneEnabled: false,
        thresholdCleanupRequired: false,
        activeWindowsUtc: [],
        reducedWindowsUtc: [],
        weekdayBias: "normal",
        weekendMode: "reduced",
      });
      snapshotRepo.save({
        familyId: createFamilyId("fam-1"),
        snapshot: baselineJson,
        reason: "probe-baseline",
        capturedAt: new Date().toISOString(),
      });

      const rulesManager: ReloadableRules = { reload: vi.fn() };
      const normalizationModule: PatternRebuilder = { rebuildPatterns: vi.fn() };
      const evidenceRepo = new SqliteFamilyEvidenceRepository(conn.db);
      const transitionRepo = new SqliteStateTransitionRepository(conn.db);
      const { SqliteFamilyRulesDbRepository } = await import("@plankton/db");
      const dbWriter = new SqliteFamilyRulesDbRepository(conn.db);

      const poller = createPoller({
        rulesManager,
        normalizationModule,
        familyEvidenceRepo: evidenceRepo,
        stateTransitionRepo: transitionRepo,
        familyRulesDbWriter: dbWriter,
        familyRulesSnapshotRepo: snapshotRepo,
      });

      // ── Step 1: Promote ─────────────────────────────────────────────
      insertCommand("family_promote_scaled", "fam-1", "promotion approved");
      await poller.poll();

      const afterPromote = conn.db
        .prepare(
          "SELECT scale_mode, max_open_value_usdc, max_active_markets, max_dust_positions FROM family_rules WHERE family_id = ?",
        )
        .get("fam-1") as Record<string, unknown>;
      expect(afterPromote.scale_mode).toBe("confirm-only");
      expect(afterPromote.max_open_value_usdc).toBe(50.0);
      expect(afterPromote.max_active_markets).toBe(5);
      expect(afterPromote.max_dust_positions).toBe(3);

      const stateAfterPromote = familyStateRepo.get(createFamilyId("fam-1"));
      expect(stateAfterPromote!.runtimeMode).toBe("active");

      // ── Step 2: Reset to probe ──────────────────────────────────────
      insertCommand("family_reset_to_probe", "fam-1", "resetting to probe");
      await poller.poll();

      const afterReset = conn.db
        .prepare(
          "SELECT scale_mode, max_open_value_usdc, max_active_markets, max_dust_positions FROM family_rules WHERE family_id = ?",
        )
        .get("fam-1") as Record<string, unknown>;
      expect(afterReset.scale_mode).toBe("disabled");
      expect(afterReset.max_open_value_usdc).toBe(10.0);
      expect(afterReset.max_active_markets).toBe(2);
      expect(afterReset.max_dust_positions).toBe(1);

      const stateAfterReset = familyStateRepo.get(createFamilyId("fam-1"));
      expect(stateAfterReset!.runtimeMode).toBe("active");

      const evidence = evidenceRepo.getEvidence(createFamilyId("fam-1"));
      expect(evidence!.promotionState).toBe("probe-only");
    });
  });

  // ── family_reduce_only with system initiator ───────────────────────────

  describe("system-initiated demotion", () => {
    it("publishes FamilyDemotionApplied on system-initiated family_reduce_only", async () => {
      seedFamily("fam-1");
      seedFamilyEvidence("fam-1");

      const evidenceRepo = new SqliteFamilyEvidenceRepository(conn.db);
      const transitionRepo = new SqliteStateTransitionRepository(conn.db);
      const demotionEvents: RuntimeEventMap["FamilyDemotionApplied"][] = [];
      bus.subscribe("FamilyDemotionApplied", async (p) => {
        demotionEvents.push(p);
      });

      insertCommand("family_reduce_only", "fam-1", "auto-demotion", {
        initiatorType: "system",
        initiator: "evidence-engine",
      });
      const poller = createPoller({
        familyEvidenceRepo: evidenceRepo,
        stateTransitionRepo: transitionRepo,
      });

      await poller.poll();

      expect(demotionEvents).toHaveLength(1);
      expect(demotionEvents[0]!.previousState).toBe("probe-only");
      expect(demotionEvents[0]!.newState).toBe("reduce-only");
      expect(demotionEvents[0]!.familyId).toEqual(createFamilyId("fam-1"));

      // Verify state transition uses lifecycle states
      const transitions = transitionRepo.findByEntity("family", "fam-1");
      expect(transitions).toHaveLength(1);
      expect(transitions[0]!.fromState).toBe("probe-only");
      expect(transitions[0]!.toState).toBe("reduce-only");

      // Also check promotion_state was synced
      const evidence = evidenceRepo.getEvidence(createFamilyId("fam-1"));
      expect(evidence!.promotionState).toBe("reduce-only");
    });

    it("does NOT publish FamilyDemotionApplied on operator-initiated demotion", async () => {
      seedFamily("fam-1");

      const demotionEvents: unknown[] = [];
      bus.subscribe("FamilyDemotionApplied", async (p) => {
        demotionEvents.push(p);
      });

      insertCommand("family_reduce_only", "fam-1", "manual", {
        initiatorType: "operator",
      });
      const poller = createPoller();

      await poller.poll();

      expect(demotionEvents).toHaveLength(0);
    });
  });
});
