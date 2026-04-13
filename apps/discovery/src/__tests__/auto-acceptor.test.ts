import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { bootstrapControlDb, type DbConnection } from "@plankton/db";
import { autoAcceptAndPromote, type AutoAcceptorConfig } from "../auto-acceptor.js";

const silentLogger = pino({ level: "silent" });
const NOW = "2026-03-30T12:00:00.000Z";
const PROFILE = "simulation";

let conn: DbConnection;
let tmpDir: string;

function baseConfig(overrides?: Partial<AutoAcceptorConfig>): AutoAcceptorConfig {
  return {
    apiBaseUrl: "http://localhost:3100",
    apiKey: "test-key",
    enabled: true,
    ...overrides,
  };
}

function seedCandidate(
  candidateId: string,
  opts: {
    gateRecommendation?: string;
    status?: string;
    patternConfidence?: string;
    matchedFamilyId?: string | null;
    recurrenceScore?: number | null;
    liveViabilityScore?: number | null;
  } = {},
): void {
  conn.db
    .prepare(
      `INSERT INTO family_candidates
       (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
        primary_category, strategy_profile, active_market_count, cluster_volume_24h,
        gate_recommendation, status, first_seen_at, last_seen_at, matched_family_id,
        recurrence_score, live_viability_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      candidateId,
      "test-family",
      "threshold",
      "daily",
      "ad-hoc",
      opts.patternConfidence ?? "medium",
      "crypto",
      "scalp",
      5,
      30000,
      opts.gateRecommendation ?? "probe-candidate",
      opts.status ?? "discovered",
      NOW,
      NOW,
      opts.matchedFamilyId ?? null,
      opts.recurrenceScore ?? null,
      opts.liveViabilityScore ?? null,
    );
}

function seedRuntimeControlState(currentProfile: string | null): void {
  conn.db
    .prepare(
      `INSERT OR REPLACE INTO runtime_control_state (id, current_profile, runtime_status, paused, updated_at)
       VALUES (1, ?, 'running', 0, ?)`,
    )
    .run(currentProfile, NOW);
}

function seedProfile(profileId: string = PROFILE): void {
  conn.db
    .prepare(
      "INSERT OR IGNORE INTO profiles (profile_id, display_name, description, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(profileId, profileId, `${profileId} profile`, NOW);
}

function seedProfileSettings(profileId: string, envelopeJson: string): void {
  conn.db
    .prepare(
      `INSERT OR REPLACE INTO profile_settings (profile_id, envelope_json, updated_at)
       VALUES (?, ?, ?)`,
    )
    .run(profileId, envelopeJson, NOW);
}

function seedFamilyCatalogEntry(familyId: string): void {
  conn.db
    .prepare(
      `INSERT OR IGNORE INTO family_catalog
       (family_id, family_key, primary_category, regime, horizon, cadence, strategy_profile,
        created_at, updated_at)
       VALUES (?, ?, 'crypto', 'threshold', 'daily', 'ad-hoc', 'scalp', ?, ?)`,
    )
    .run(familyId, familyId, NOW, NOW);
}

function seedFamilyRollup(familyId: string, profile: string, openPositions: number): void {
  conn.db
    .prepare(
      `INSERT OR REPLACE INTO family_profile_rollups
       (family_id, profile, open_positions, open_value_usdc, active_markets,
        realized_pnl, tail_cost_usdc, tail_adjusted_pnl, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)`,
    )
    .run(familyId, profile, openPositions, openPositions * 5, NOW);
}

function seedFamilyDeployment(familyId: string, profile: string, enabled: boolean): void {
  seedFamilyCatalogEntry(familyId);
  conn.db
    .prepare(
      `INSERT OR IGNORE INTO family_deployments (family_id, profile, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(familyId, profile, enabled ? 1 : 0, NOW, NOW);
}

function seedPromotionProposal(
  familyId: string,
  profile: string,
  status: string = "pending",
): void {
  conn.db
    .prepare(
      `INSERT INTO promotion_proposals
       (family_id, profile, current_state, proposed_state, reason, scores_snapshot, status, created_at)
       VALUES (?, ?, 'probe-only', 'scaled', 'auto', '{}', ?, ?)`,
    )
    .run(familyId, profile, status, NOW);
}

function seedOperatorCommand(action: string, targetId: string, status: string = "pending"): void {
  conn.db
    .prepare(
      `INSERT INTO operator_commands (action, target_id, reason, status, created_at)
       VALUES (?, ?, 'test', ?, ?)`,
    )
    .run(action, targetId, status, NOW);
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-auto-accept-"));
  conn = bootstrapControlDb(path.join(tmpDir, "test.db"));
  seedProfile();
});

afterEach(() => {
  vi.restoreAllMocks();
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("autoAcceptAndPromote", () => {
  describe("auto-accept candidates", () => {
    it("accepts probe-candidate with status=discovered", async () => {
      seedCandidate("cand-1", { gateRecommendation: "probe-candidate" });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(1);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0]![0]).toContain("/api/v1/discovery/candidates/cand-1/accept");
      expect(mockFetch.mock.calls[0]![1]).toEqual(
        expect.objectContaining({
          method: "POST",
          body: undefined,
        }),
      );
    });

    it("skips candidates with status=materialized", async () => {
      seedCandidate("cand-1", { status: "materialized" });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips candidates with pattern_confidence=low", async () => {
      seedCandidate("cand-1", { patternConfidence: "low" });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips candidates with matched_family_id set", async () => {
      seedCandidate("cand-1", { matchedFamilyId: "fam-existing" });

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("per-pass limit", () => {
    it("accepts at most 10 candidates per pass", async () => {
      for (let i = 1; i <= 15; i++) {
        seedCandidate(`cand-${String(i).padStart(2, "0")}`);
      }

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(10);
      // Only 10 accept calls (no promote calls since no proposals seeded)
      expect(mockFetch).toHaveBeenCalledTimes(10);
    });

    it("ranks scaled-candidate before probe-candidate", async () => {
      seedCandidate("cand-probe", {
        gateRecommendation: "probe-candidate",
        patternConfidence: "high",
        recurrenceScore: 1.0,
        liveViabilityScore: 1.0,
      });
      seedCandidate("cand-scaled", {
        gateRecommendation: "scaled-candidate",
        patternConfidence: "medium",
        recurrenceScore: 0.1,
        liveViabilityScore: 0.1,
      });

      const acceptedIds: string[] = [];
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        const match = url.match(/candidates\/([^/]+)\/accept/);
        if (match) acceptedIds.push(match[1]!);
        return Promise.resolve({ ok: true, status: 200 });
      });
      vi.stubGlobal("fetch", mockFetch);

      await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      // scaled-candidate should be accepted first regardless of lower scores
      expect(acceptedIds[0]).toBe("cand-scaled");
      expect(acceptedIds[1]).toBe("cand-probe");
    });
  });

  describe("enabled-family cap", () => {
    it("skips auto-accept when at maxFamilies cap and all families have open positions", async () => {
      seedRuntimeControlState(PROFILE);
      seedProfileSettings(PROFILE, JSON.stringify({ maxFamilies: 2 }));

      // Seed 2 enabled deployments with open positions (can't be rotated)
      seedFamilyDeployment("fam-a", PROFILE, true);
      seedFamilyDeployment("fam-b", PROFILE, true);
      seedFamilyRollup("fam-a", PROFILE, 3);
      seedFamilyRollup("fam-b", PROFILE, 2);

      // Seed qualifying candidates
      seedCandidate("cand-1");
      seedCandidate("cand-2");
      seedCandidate("cand-3");

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/actions/rotate-weak-families")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, data: { rotated: 0 } }),
          });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(0);
      expect(result.skippedAtCap).toBe(3);
      expect(
        mockFetch.mock.calls.some(
          (call) =>
            typeof call[0] === "string" && call[0].includes("/actions/rotate-weak-families"),
        ),
      ).toBe(true);
      expect(
        mockFetch.mock.calls.some(
          (call) =>
            typeof call[0] === "string" && call[0].includes("/api/v1/discovery/candidates/"),
        ),
      ).toBe(false);
    });

    it("accepts normally when under maxFamilies cap", async () => {
      seedRuntimeControlState(PROFILE);
      seedProfileSettings(PROFILE, JSON.stringify({ maxFamilies: 10 }));

      // Only 2 enabled deployments, well under cap of 10
      seedFamilyDeployment("fam-a", PROFILE, true);
      seedFamilyDeployment("fam-b", PROFILE, true);

      seedCandidate("cand-1");
      seedCandidate("cand-2");

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/actions/rotate-weak-families")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, data: { rotated: 0 } }),
          });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(2);
      expect(result.skippedAtCap).toBe(0);
    });

    it("uses default maxFamilies (100) when no envelope_json", async () => {
      seedRuntimeControlState(PROFILE);
      // No profile_settings row → fallback to 100

      seedCandidate("cand-1");

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      // Under the default cap of 100, should accept normally
      expect(result.accepted).toBe(1);
      expect(result.skippedAtCap).toBe(0);
    });

    it("still runs auto-promote when at cap with open positions", async () => {
      seedRuntimeControlState(PROFILE);
      seedProfileSettings(PROFILE, JSON.stringify({ maxFamilies: 1 }));
      seedFamilyDeployment("fam-a", PROFILE, true);
      seedFamilyRollup("fam-a", PROFILE, 2); // has open positions, can't rotate

      // Seed a qualifying candidate (will be skipped — can't rotate)
      seedCandidate("cand-1");

      // Seed a promotion proposal (should still be processed)
      seedFamilyCatalogEntry("fam-a");
      seedPromotionProposal("fam-a", PROFILE, "pending");

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(0);
      expect(result.skippedAtCap).toBe(1);
      expect(result.promoted).toBe(1);
    });
  });

  describe("rotation at cap", () => {
    it("rotates weak families with zero exposure to free slots for new candidates", async () => {
      seedRuntimeControlState(PROFILE);
      seedProfileSettings(PROFILE, JSON.stringify({ maxFamilies: 2 }));

      // 2 enabled families: one with positions (keep), one without (rotatable)
      seedFamilyDeployment("fam-keep", PROFILE, true);
      seedFamilyRollup("fam-keep", PROFILE, 3);
      seedFamilyDeployment("fam-weak", PROFILE, true);
      seedFamilyRollup("fam-weak", PROFILE, 0); // zero positions → rotatable

      seedCandidate("cand-new");

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/actions/rotate-weak-families")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, data: { rotated: 1 } }),
          });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(1);
      expect(result.skippedAtCap).toBe(0);
      expect(
        mockFetch.mock.calls.some(
          (call) =>
            typeof call[0] === "string" && call[0].includes("/actions/rotate-weak-families"),
        ),
      ).toBe(true);
      expect(
        mockFetch.mock.calls.some(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("/api/v1/discovery/candidates/cand-new/accept"),
        ),
      ).toBe(true);
    });

    it("does not rotate families with open positions", async () => {
      seedRuntimeControlState(PROFILE);
      seedProfileSettings(PROFILE, JSON.stringify({ maxFamilies: 1 }));

      seedFamilyDeployment("fam-active", PROFILE, true);
      seedFamilyRollup("fam-active", PROFILE, 5); // has positions

      seedCandidate("cand-1");

      const mockFetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes("/actions/rotate-weak-families")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ ok: true, data: { rotated: 0 } }),
          });
        }
        return Promise.resolve({ ok: true, status: 200 });
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(0);
      expect(result.skippedAtCap).toBe(1);
    });
  });

  describe("auto-promote families", () => {
    it("promotes family with exclusive current-profile proposal", async () => {
      seedRuntimeControlState(PROFILE);
      seedPromotionProposal("fam-1", PROFILE, "pending");

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.promoted).toBe(1);
      const promoteCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && c[0].includes("/promote"),
      );
      expect(promoteCall).toBeTruthy();
      expect(promoteCall![0]).toContain("/api/v1/actions/family/fam-1/promote");
    });

    it("skips family with proposals in other profiles", async () => {
      seedProfile("paper");
      seedRuntimeControlState(PROFILE);
      seedPromotionProposal("fam-1", PROFILE, "pending");
      seedPromotionProposal("fam-1", "paper", "pending");

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.promoted).toBe(0);
    });

    it("skips family with legacy NULL-profile pending proposal", async () => {
      seedRuntimeControlState(PROFILE);
      seedPromotionProposal("fam-1", PROFILE, "pending");
      // Seed a legacy proposal with NULL profile (pre-migration 012)
      conn.db
        .prepare(
          `INSERT INTO promotion_proposals
           (family_id, profile, current_state, proposed_state, reason, scores_snapshot, status, created_at)
           VALUES ('fam-1', NULL, 'probe-only', 'scaled', 'legacy', '{}', 'pending', datetime('now'))`,
        )
        .run();

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      // Should skip: NULL-profile proposal makes this family unsafe for auto-promote
      expect(result.promoted).toBe(0);
    });

    it("skips family with pending promote command", async () => {
      seedRuntimeControlState(PROFILE);
      seedPromotionProposal("fam-1", PROFILE, "pending");
      seedOperatorCommand("family_promote_scaled", "fam-1", "pending");

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.promoted).toBe(0);
    });
  });

  describe("config and error handling", () => {
    it("returns zeros without any fetch calls when disabled", async () => {
      seedCandidate("cand-1");
      seedRuntimeControlState(PROFILE);
      seedPromotionProposal("fam-1", PROFILE, "pending");

      const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(
        conn.db,
        baseConfig({ enabled: false }),
        silentLogger,
      );

      expect(result).toEqual({ accepted: 0, promoted: 0, skippedAtCap: 0 });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("warns and continues on API error", async () => {
      seedCandidate("cand-1");
      seedCandidate("cand-2");

      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce({ ok: true, status: 200 });
      vi.stubGlobal("fetch", mockFetch);

      const result = await autoAcceptAndPromote(conn.db, baseConfig(), silentLogger);

      expect(result.accepted).toBe(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
