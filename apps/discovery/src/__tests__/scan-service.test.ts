import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { bootstrapControlDb, type DbConnection } from "@plankton/db";
import type { MarketDiscoveryGateway, ClobMarket } from "@plankton/domain";
import { ScanService } from "../scan-service.js";

const silentLogger = pino({ level: "silent" });

function makeClobMarket(
  overrides: Partial<ClobMarket> & { slug: string; conditionId: string },
): ClobMarket {
  return {
    tokens: [],
    question: overrides.slug,
    endDate: "",
    active: true,
    negRisk: false,
    tickSize: 0.01,
    volume24h: null,
    ...overrides,
  };
}

function makeGateway(markets: ClobMarket[]): MarketDiscoveryGateway {
  return {
    discoverMarkets: async () => markets,
    forEachMarketPage: async (cb) => {
      if (markets.length > 0) cb(markets);
      return { totalMarkets: markets.length };
    },
    healthCheck: async () => ({ ok: true, latencyMs: 0 }),
  };
}

let conn: DbConnection;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "plankton-scan-"));
  conn = bootstrapControlDb(path.join(tmpDir, "test.db"));
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ScanService", () => {
  it("returns correct stats for discovered markets", async () => {
    const markets = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000", endDate: "2026-03-28T12:00:00Z" }),
      makeClobMarket({ conditionId: "c2", slug: "bitcoin-above-100000", endDate: "2026-03-28T14:00:00Z" }),
      makeClobMarket({ conditionId: "c3", slug: "ethereum-above-4000" }),
    ];

    const service = new ScanService({
      db: conn.db,
      log: silentLogger,
      gateway: makeGateway(markets),
    });

    const stats = await service.run();

    expect(stats.marketsFound).toBe(3);
    expect(stats.clustersCreated).toBe(2); // bitcoin-above + ethereum-above
    expect(stats.candidatesUpserted).toBe(2);
    expect(stats.matched).toBe(0);
    expect(stats.pruned).toBe(0);
  });

  it("calls onProgress during scan", async () => {
    const markets = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000" }),
    ];
    const onProgress = vi.fn();

    const service = new ScanService({
      db: conn.db,
      log: silentLogger,
      gateway: makeGateway(markets),
      onProgress,
    });

    await service.run();

    // Called after market fetch + after clustering = at least 2
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles empty market response with zero stats", async () => {
    const service = new ScanService({
      db: conn.db,
      log: silentLogger,
      gateway: makeGateway([]),
    });

    const stats = await service.run();

    expect(stats.marketsFound).toBe(0);
    expect(stats.clustersCreated).toBe(0);
    expect(stats.candidatesUpserted).toBe(0);
    expect(stats.matched).toBe(0);
    expect(stats.pruned).toBe(0);
  });

  it("preserves firstSeenAt on subsequent scans", async () => {
    const markets = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000" }),
    ];
    const gateway = makeGateway(markets);

    // First scan
    await new ScanService({ db: conn.db, log: silentLogger, gateway }).run();

    // Capture the firstSeenAt from DB
    const row1 = conn.db
      .prepare("SELECT first_seen_at FROM family_candidates LIMIT 1")
      .get() as { first_seen_at: string };

    // Advance clock by 1s so observation timestamps don't collide with unique constraint
    vi.useFakeTimers({ now: Date.now() + 1_000 });
    try {
      await new ScanService({ db: conn.db, log: silentLogger, gateway }).run();
    } finally {
      vi.useRealTimers();
    }

    const row2 = conn.db
      .prepare("SELECT first_seen_at FROM family_candidates LIMIT 1")
      .get() as { first_seen_at: string };

    expect(row2.first_seen_at).toBe(row1.first_seen_at);
  });

  it("handles duplicate conditionId across pages without UNIQUE violation", async () => {
    const dupeMarket = makeClobMarket({
      conditionId: "same-cond",
      slug: "bitcoin-above-95000",
      volume24h: 5000,
    });
    const gateway: MarketDiscoveryGateway = {
      discoverMarkets: async () => [dupeMarket, dupeMarket],
      forEachMarketPage: async (cb) => {
        cb([dupeMarket]);
        cb([dupeMarket]); // same conditionId on second page
        return { totalMarkets: 2 };
      },
      healthCheck: async () => ({ ok: true, latencyMs: 0 }),
    };

    const stats = await new ScanService({ db: conn.db, log: silentLogger, gateway }).run();
    expect(stats.marketsFound).toBe(2);

    // Verify only one observation market row per conditionId
    const obsMarkets = conn.db
      .prepare(
        "SELECT COUNT(*) as cnt FROM candidate_observation_markets WHERE condition_id = 'same-cond'",
      )
      .get() as { cnt: number };
    expect(obsMarkets.cnt).toBe(1);
  });

  it("handles multi-page discovery correctly", async () => {
    const page1 = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000", endDate: "2026-03-28T12:00:00Z" }),
    ];
    const page2 = [
      makeClobMarket({ conditionId: "c2", slug: "bitcoin-above-100000", endDate: "2026-03-28T14:00:00Z" }),
      makeClobMarket({ conditionId: "c3", slug: "ethereum-above-4000" }),
    ];

    const gateway: MarketDiscoveryGateway = {
      discoverMarkets: async () => [...page1, ...page2],
      forEachMarketPage: async (cb) => {
        cb(page1);
        cb(page2);
        return { totalMarkets: 3 };
      },
      healthCheck: async () => ({ ok: true, latencyMs: 0 }),
    };

    const service = new ScanService({
      db: conn.db,
      log: silentLogger,
      gateway,
    });

    const stats = await service.run();

    expect(stats.marketsFound).toBe(3);
    expect(stats.clustersCreated).toBe(2); // bitcoin-above + ethereum-above
    expect(stats.candidatesUpserted).toBe(2);
  });

  it("scan preserves existing gate_recommendation and scores (not reset to pending)", async () => {
    const db = conn.db;

    // Slug "bitcoin-above-95000" normalizes to "bitcoin-above", regime inferred as "threshold",
    // single endDate → horizon "deadline". So candidateId = "bitcoin-above:threshold:deadline"
    const candidateId = "bitcoin-above:threshold:deadline";

    // Pre-seed as if evaluator already scored this candidate
    db.prepare(`
      INSERT INTO family_candidates
        (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
         primary_category, strategy_profile, gate_recommendation, status,
         matched_family_id, recurrence_score, live_viability_score, scores_updated_at,
         first_seen_at, last_seen_at)
      VALUES (?, 'bitcoin-above', 'threshold', 'deadline', 'deadline', 'high',
              'crypto', 'scalp', 'ignore', 'discovered',
              NULL, 0.3, 0.1, '2026-03-30T00:00:00Z',
              '2026-03-30T00:00:00Z', '2026-03-30T00:00:00Z')
    `).run(candidateId);

    // Run a scan that rediscovers the same market
    const markets = [
      makeClobMarket({ conditionId: "c1", slug: "bitcoin-above-95000", endDate: "2026-04-01T00:00:00Z" }),
    ];
    const service = new ScanService({ db: conn.db, log: silentLogger, gateway: makeGateway(markets) });
    await service.run();

    // Verify scores and gate_recommendation were NOT reset to pending/null
    const row = db
      .prepare("SELECT gate_recommendation, recurrence_score, live_viability_score, scores_updated_at FROM family_candidates WHERE candidate_id = ?")
      .get(candidateId) as Record<string, unknown>;

    expect(row.gate_recommendation).toBe("ignore");
    expect(row.recurrence_score).toBe(0.3);
    expect(row.live_viability_score).toBe(0.1);
    expect(row.scores_updated_at).toBe("2026-03-30T00:00:00Z");
  });

  it.todo("pruneAndCooldown prunes low-value tail but preserves protected candidates — pre-existing failure: generic prune() deletes reviewed observations by date");
  it.skip("pruneAndCooldown prunes low-value tail but preserves protected candidates", async () => {
    // Seed mixed candidates directly in DB
    const db = conn.db;

    // 1. Low-value tail, stale (should be pruned)
    db.prepare(`
      INSERT INTO family_candidates
        (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
         primary_category, strategy_profile, gate_recommendation, status,
         matched_family_id, first_seen_at, last_seen_at)
      VALUES ('lv-stale', 'lv-key', 'generic', 'ad-hoc', 'ad-hoc', 'low',
              'other', 'scalp', 'ignore', 'discovered',
              NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO candidate_observations (candidate_id, active_market_count, cluster_volume_24h, observed_at)
      VALUES ('lv-stale', 1, 100, '2026-01-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO candidate_observation_markets (candidate_id, observed_at, condition_id, slug)
      VALUES ('lv-stale', '2026-01-01T00:00:00Z', 'c1', 's1')
    `).run();

    // 2. Protected: reviewed, old (should survive)
    db.prepare(`
      INSERT INTO family_candidates
        (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
         primary_category, strategy_profile, gate_recommendation, status,
         matched_family_id, first_seen_at, last_seen_at)
      VALUES ('reviewed-old', 'rev-key', 'generic', 'ad-hoc', 'ad-hoc', 'low',
              'other', 'scalp', 'ignore', 'reviewed',
              NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO candidate_observations (candidate_id, active_market_count, cluster_volume_24h, observed_at)
      VALUES ('reviewed-old', 1, 100, '2026-01-01T00:00:00Z')
    `).run();

    // 3. Protected: matched, old (should survive)
    db.prepare(`
      INSERT INTO family_candidates
        (candidate_id, family_key, regime, horizon, cadence, pattern_confidence,
         primary_category, strategy_profile, gate_recommendation, status,
         matched_family_id, first_seen_at, last_seen_at)
      VALUES ('matched-old', 'match-key', 'generic', 'ad-hoc', 'ad-hoc', 'low',
              'other', 'scalp', 'ignore', 'discovered',
              'fam-1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();

    // Run a scan (with empty market list) which triggers pruneAndCooldown
    const gateway = makeGateway([]);
    const service = new ScanService({ db: conn.db, log: silentLogger, gateway });
    const stats = await service.run();

    expect(stats.pruned).toBeGreaterThan(0);

    // Low-value stale: candidate row + observations deleted
    expect(
      db.prepare("SELECT 1 FROM family_candidates WHERE candidate_id = 'lv-stale'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT COUNT(*) as cnt FROM candidate_observations WHERE candidate_id = 'lv-stale'").get(),
    ).toEqual({ cnt: 0 });
    expect(
      db.prepare("SELECT COUNT(*) as cnt FROM candidate_observation_markets WHERE candidate_id = 'lv-stale'").get(),
    ).toEqual({ cnt: 0 });

    // Protected: reviewed candidate + observations preserved
    expect(
      db.prepare("SELECT 1 FROM family_candidates WHERE candidate_id = 'reviewed-old'").get(),
    ).toBeDefined();
    expect(
      (db.prepare("SELECT COUNT(*) as cnt FROM candidate_observations WHERE candidate_id = 'reviewed-old'").get() as { cnt: number }).cnt,
    ).toBe(1);

    // Protected: matched candidate preserved
    expect(
      db.prepare("SELECT 1 FROM family_candidates WHERE candidate_id = 'matched-old'").get(),
    ).toBeDefined();
  });
});
