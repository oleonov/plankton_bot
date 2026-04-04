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
  } = {},
): void {
  conn.db
    .prepare(
      `INSERT INTO family_candidates
       (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
        primary_category, strategy_profile, active_market_count, cluster_volume_24h,
        gate_recommendation, status, first_seen_at, last_seen_at, matched_family_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    it("returns {0, 0} without any fetch calls when disabled", async () => {
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

      expect(result).toEqual({ accepted: 0, promoted: 0 });
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
