import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as new (path: string) => {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): void;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

type RepairModule = {
  findConditionsRequiringOutcomeRepair(
    ledgerDb: unknown,
  ): Array<{ conditionId: string; slug: string | null; tokenCount: number }>;
  findConditionsBlockingSettlementRepair(
    ledgerDb: unknown,
    targetConditionIds?: Iterable<string>,
  ): Array<{ conditionId: string; slug: string | null; tokenCount: number }>;
  findBlockingSettledConditions(
    ledgerDb: unknown,
    settlementRows: Array<{ condition_id: string }>,
  ): Array<{ conditionId: string; slug: string | null; tokenCount: number }>;
  collectConditionResolutionRepairs(
    mismatches: Array<{
      settlement: { condition_id: string };
      actualWinnerOutcome: string;
    }>,
  ): Array<{ conditionId: string; actualWinnerOutcome: string }>;
  applyConditionResolutionRepairs(
    ledgerDb: unknown,
    repairs: Array<{ conditionId: string; actualWinnerOutcome: string }>,
  ): number;
  extractWinnerFromGammaPayload(
    raw: Record<string, unknown>,
  ): { tokenId: string; outcome: string } | null;
  isSuspectSettlementRow(row: { outcome: string; resolution: string }): boolean;
  resolveTargetProfile(
    ledgerPath: string,
    explicitProfile?: string | null,
  ): "simulation" | "paper" | "live-lite";
  resetLiveFamily(
    ledgerDb: unknown,
    controlDb: unknown,
    familyId: string,
    profile: "simulation" | "paper" | "live-lite",
  ): void;
  resetClosedFamily(
    ledgerDb: unknown,
    controlDb: unknown,
    familyId: string,
    profile: "simulation" | "paper" | "live-lite",
  ): void;
  annotateTaintedTransitions(
    controlDb: unknown,
    familyId: string,
    earliestSettledAt: string,
    profile: "simulation" | "paper" | "live-lite",
  ): number;
};

async function loadRepairModule(): Promise<RepairModule> {
  const modulePath = ["..", "..", "..", "..", "scripts", "repair-outcome-settlements.ts"].join("/");
  return (await import(modulePath)) as RepairModule;
}

describe("repair-outcome-settlements helpers", () => {
  it("treats YES/NO labels case-insensitively when selecting suspect settlements", async () => {
    const { isSuspectSettlementRow } = await loadRepairModule();

    expect(isSuspectSettlementRow({ outcome: "YES", resolution: "NO" })).toBe(false);
    expect(isSuspectSettlementRow({ outcome: "Yes", resolution: "No" })).toBe(false);
    expect(isSuspectSettlementRow({ outcome: "Up", resolution: "Down" })).toBe(true);
  });

  it("extracts winner outcome from outcomes[] when the winner token row lacks a label", async () => {
    const { extractWinnerFromGammaPayload } = await loadRepairModule();

    expect(
      extractWinnerFromGammaPayload({
        tokens: [
          { token_id: "tok-up-direct", winner: true },
          { token_id: "tok-down-direct", outcome: "Down", winner: false },
        ],
        outcomes: '["Up", "Down"]',
      }),
    ).toEqual({
      tokenId: "tok-up-direct",
      outcome: "Up",
    });
  });

  it("resolves target profile from ledger path unless PROFILE_ID overrides it", async () => {
    const { resolveTargetProfile } = await loadRepairModule();

    expect(resolveTargetProfile("apps/runtime/data/ledger-live-lite.db")).toBe("live-lite");
    expect(resolveTargetProfile("apps/runtime/data/ledger-paper.db")).toBe("paper");
    expect(resolveTargetProfile("apps/runtime/data/ledger-simulation.db")).toBe("simulation");
    expect(resolveTargetProfile("apps/runtime/data/unknown.db", "paper")).toBe("paper");
  });

  it("fails closed when the ledger path is ambiguous and PROFILE_ID is missing", async () => {
    const { resolveTargetProfile } = await loadRepairModule();

    expect(() => resolveTargetProfile("/tmp/custom-ledger.db")).toThrow(
      "unable to infer target profile",
    );
  });

  it("detects conditions that still require market outcome repair before settlement repair", async () => {
    const { findConditionsRequiringOutcomeRepair } = await loadRepairModule();
    const ledgerDb = new Database(":memory:");

    ledgerDb.exec(`
      CREATE TABLE markets (
        token_id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        slug TEXT,
        outcome TEXT NOT NULL
      );
      CREATE TABLE positions (
        position_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE orders (
        order_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    ledgerDb
      .prepare(
        `INSERT INTO markets (token_id, condition_id, slug, outcome) VALUES
         ('tok-a1', 'cond-needs-fix', 'broken-updown', 'NO'),
         ('tok-a2', 'cond-needs-fix', 'broken-updown', 'NO'),
         ('tok-b1', 'cond-binary', 'clean-binary', 'YES'),
         ('tok-b2', 'cond-binary', 'clean-binary', 'NO')`,
      )
      .run();

    expect(findConditionsRequiringOutcomeRepair(ledgerDb)).toEqual([
      {
        conditionId: "cond-needs-fix",
        slug: "broken-updown",
        tokenCount: 2,
      },
    ]);
  });

  it("detects conditions requiring outcome repair case-insensitively", async () => {
    const { findConditionsRequiringOutcomeRepair } = await loadRepairModule();
    const ledgerDb = new Database(":memory:");

    ledgerDb.exec(`
      CREATE TABLE markets (
        token_id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        slug TEXT,
        outcome TEXT NOT NULL
      );
      CREATE TABLE positions (
        position_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE orders (
        order_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    ledgerDb
      .prepare(
        `INSERT INTO markets (token_id, condition_id, slug, outcome) VALUES
         ('tok-a1', 'cond-mixed-case', 'mixed-case-broken', 'No'),
         ('tok-a2', 'cond-mixed-case', 'mixed-case-broken', ' no ')`,
      )
      .run();

    expect(findConditionsRequiringOutcomeRepair(ledgerDb)).toEqual([
      {
        conditionId: "cond-mixed-case",
        slug: "mixed-case-broken",
        tokenCount: 2,
      },
    ]);
  });

  it("only blocks settlement repair for closed-only conditions awaiting outcome repair", async () => {
    const { findConditionsBlockingSettlementRepair } = await loadRepairModule();
    const ledgerDb = new Database(":memory:");

    ledgerDb.exec(`
      CREATE TABLE markets (
        token_id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        slug TEXT,
        outcome TEXT NOT NULL
      );
      CREATE TABLE positions (
        position_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE orders (
        order_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    ledgerDb
      .prepare(
        `INSERT INTO markets (token_id, condition_id, slug, outcome) VALUES
         ('tok-closed-1', 'cond-closed', 'closed-broken', 'NO'),
         ('tok-closed-2', 'cond-closed', 'closed-broken', 'NO'),
         ('tok-live-1', 'cond-live', 'live-broken', 'NO'),
         ('tok-live-2', 'cond-live', 'live-broken', 'NO')`,
      )
      .run();
    ledgerDb
      .prepare(
        `INSERT INTO positions (position_id, token_id, status) VALUES
         ('pos-live', 'tok-live-1', 'open')`,
      )
      .run();

    expect(findConditionsBlockingSettlementRepair(ledgerDb)).toEqual([
      {
        conditionId: "cond-closed",
        slug: "closed-broken",
        tokenCount: 2,
      },
    ]);
  });

  it("only blocks conditions that overlap the current suspect-settlement target set", async () => {
    const { findConditionsBlockingSettlementRepair } = await loadRepairModule();
    const ledgerDb = new Database(":memory:");

    ledgerDb.exec(`
      CREATE TABLE markets (
        token_id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        slug TEXT,
        outcome TEXT NOT NULL
      );
      CREATE TABLE positions (
        position_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE orders (
        order_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    ledgerDb
      .prepare(
        `INSERT INTO markets (token_id, condition_id, slug, outcome) VALUES
         ('tok-target-1', 'cond-target', 'target-broken', 'NO'),
         ('tok-target-2', 'cond-target', 'target-broken', 'NO'),
         ('tok-unrelated-1', 'cond-unrelated', 'unrelated-broken', 'NO'),
         ('tok-unrelated-2', 'cond-unrelated', 'unrelated-broken', 'NO')`,
      )
      .run();

    expect(findConditionsBlockingSettlementRepair(ledgerDb, new Set(["cond-target"]))).toEqual([
      {
        conditionId: "cond-target",
        slug: "target-broken",
        tokenCount: 2,
      },
    ]);
  });

  it("collects one market-resolution repair per condition", async () => {
    const { collectConditionResolutionRepairs } = await loadRepairModule();

    expect(
      collectConditionResolutionRepairs([
        {
          settlement: { condition_id: "cond-1" },
          actualWinnerOutcome: "Down",
        },
        {
          settlement: { condition_id: "cond-1" },
          actualWinnerOutcome: "Down",
        },
        {
          settlement: { condition_id: "cond-2" },
          actualWinnerOutcome: "Yes",
        },
      ]),
    ).toEqual([
      { conditionId: "cond-1", actualWinnerOutcome: "Down" },
      { conditionId: "cond-2", actualWinnerOutcome: "Yes" },
    ]);
  });

  it("updates settlement resolution labels for all rows in a repaired condition", async () => {
    const { applyConditionResolutionRepairs } = await loadRepairModule();
    const ledgerDb = new Database(":memory:");

    ledgerDb.exec(`
      CREATE TABLE market_resolutions (
        condition_id TEXT PRIMARY KEY,
        resolution TEXT NOT NULL
      );
      CREATE TABLE settlement_ledger (
        settlement_id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        resolution TEXT NOT NULL,
        settlement_price REAL NOT NULL DEFAULT 0
      );
    `);

    ledgerDb
      .prepare(`INSERT INTO market_resolutions (condition_id, resolution) VALUES ('cond-1', 'NO')`)
      .run();
    ledgerDb
      .prepare(
        `INSERT INTO settlement_ledger (settlement_id, condition_id, resolution, settlement_price) VALUES
           ('set-winner', 'cond-1', 'NO', 1),
           ('set-loser', 'cond-1', 'NO', 1)`,
      )
      .run();

    expect(
      applyConditionResolutionRepairs(ledgerDb, [
        { conditionId: "cond-1", actualWinnerOutcome: "Down" },
      ]),
    ).toBe(1);

    const marketResolution = ledgerDb
      .prepare(`SELECT resolution FROM market_resolutions WHERE condition_id = 'cond-1'`)
      .get() as { resolution: string };
    expect(marketResolution.resolution).toBe("Down");

    const settlementRows = ledgerDb
      .prepare(
        `SELECT settlement_id, resolution
         FROM settlement_ledger
         WHERE condition_id = 'cond-1'
         ORDER BY settlement_id`,
      )
      .all() as Array<{ settlement_id: string; resolution: string }>;
    expect(settlementRows).toEqual([
      { settlement_id: "set-loser", resolution: "Down" },
      { settlement_id: "set-winner", resolution: "Down" },
    ]);
  });

  it("blocks closed-only broken conditions among settled rows even when labels are still all NO", async () => {
    const { findBlockingSettledConditions } = await loadRepairModule();
    const ledgerDb = new Database(":memory:");

    ledgerDb.exec(`
      CREATE TABLE markets (
        token_id TEXT PRIMARY KEY,
        condition_id TEXT NOT NULL,
        slug TEXT,
        outcome TEXT NOT NULL
      );
      CREATE TABLE positions (
        position_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE orders (
        order_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);

    ledgerDb
      .prepare(
        `INSERT INTO markets (token_id, condition_id, slug, outcome) VALUES
         ('tok-hidden-1', 'cond-hidden', 'hidden-broken', 'NO'),
         ('tok-hidden-2', 'cond-hidden', 'hidden-broken', 'NO'),
         ('tok-open-1', 'cond-open', 'open-broken', 'NO'),
         ('tok-open-2', 'cond-open', 'open-broken', 'NO')`,
      )
      .run();
    ledgerDb
      .prepare(
        `INSERT INTO positions (position_id, token_id, status) VALUES
         ('pos-open', 'tok-open-1', 'open')`,
      )
      .run();

    expect(
      findBlockingSettledConditions(ledgerDb, [
        { condition_id: "cond-hidden" },
        { condition_id: "cond-open" },
      ]),
    ).toEqual([
      {
        conditionId: "cond-hidden",
        slug: "hidden-broken",
        tokenCount: 2,
      },
    ]);
  });

  it("resetLiveFamily clears stale PnL-derived evidence while preserving promotion state", async () => {
    const { resetLiveFamily } = await loadRepairModule();
    const ledgerDb = new Database(":memory:");
    const controlDb = new Database(":memory:");

    ledgerDb.exec(`
      CREATE TABLE positions (
        position_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        status TEXT NOT NULL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        cost_basis_usdc REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE inventory_lots (
        lot_id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        remaining_size REAL NOT NULL DEFAULT 0,
        entry_price REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE family_runtime_state (
        family_id TEXT PRIMARY KEY,
        current_tail_cost_usdc REAL NOT NULL DEFAULT 0,
        tail_adjusted_pnl_live REAL NOT NULL DEFAULT 0,
        open_value_usdc REAL NOT NULL DEFAULT 0,
        open_position_count INTEGER NOT NULL DEFAULT 0,
        open_dust_count INTEGER NOT NULL DEFAULT 0,
        active_market_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );
    `);

    controlDb.exec(`
      CREATE TABLE family_evidence (
        family_id TEXT PRIMARY KEY,
        local_realized_pnl_fifo REAL NOT NULL DEFAULT 0,
        tail_adjusted_pnl REAL NOT NULL DEFAULT 0,
        evidence_score REAL NOT NULL DEFAULT 0,
        promotion_state TEXT NOT NULL DEFAULT 'probe-only',
        scores_updated_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE family_profile_rollups (
        family_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        tail_adjusted_pnl REAL NOT NULL DEFAULT 0,
        updated_at TEXT,
        PRIMARY KEY (family_id, profile)
      );
    `);

    ledgerDb
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, status, realized_pnl, cost_basis_usdc) VALUES
       ('pos-open', 'tok-open', 'fam-live', 'open', 1.5, 3),
       ('pos-closed', 'tok-closed', 'fam-live', 'closed', 8.5, 0)`,
      )
      .run();
    ledgerDb
      .prepare(
        `INSERT INTO inventory_lots (lot_id, position_id, remaining_size, entry_price) VALUES
       ('lot-1', 'pos-open', 4, 0.5)`,
      )
      .run();
    ledgerDb
      .prepare(
        `INSERT INTO family_runtime_state
           (family_id, current_tail_cost_usdc, tail_adjusted_pnl_live, open_value_usdc,
            open_position_count, open_dust_count, active_market_count, updated_at)
         VALUES ('fam-live', 99, 99, 99, 9, 9, 9, datetime('now'))`,
      )
      .run();

    controlDb
      .prepare(
        `INSERT INTO family_evidence
         (family_id, local_realized_pnl_fifo, tail_adjusted_pnl, evidence_score, promotion_state, scores_updated_at, updated_at)
       VALUES ('fam-live', 123, 77, 55, 'scaled', '2026-04-06T00:00:00Z', datetime('now'))`,
      )
      .run();
    controlDb
      .prepare(
        `INSERT INTO family_profile_rollups (family_id, profile, realized_pnl, tail_adjusted_pnl, updated_at)
       VALUES
         ('fam-live', 'live-lite', 44, 33, datetime('now')),
         ('fam-live', 'paper', 88, 77, datetime('now'))`,
      )
      .run();

    resetLiveFamily(ledgerDb, controlDb, "fam-live", "live-lite");

    const familyState = ledgerDb
      .prepare(
        `SELECT current_tail_cost_usdc, tail_adjusted_pnl_live, open_value_usdc,
                open_position_count, open_dust_count, active_market_count
         FROM family_runtime_state WHERE family_id = 'fam-live'`,
      )
      .get() as {
      current_tail_cost_usdc: number;
      tail_adjusted_pnl_live: number;
      open_value_usdc: number;
      open_position_count: number;
      open_dust_count: number;
      active_market_count: number;
    };
    expect(familyState.current_tail_cost_usdc).toBe(2);
    expect(familyState.tail_adjusted_pnl_live).toBe(8);
    expect(familyState.open_value_usdc).toBe(3);
    expect(familyState.open_position_count).toBe(1);
    expect(familyState.open_dust_count).toBe(0);
    expect(familyState.active_market_count).toBe(1);

    const evidence = controlDb
      .prepare(
        `SELECT local_realized_pnl_fifo, tail_adjusted_pnl, evidence_score, promotion_state, scores_updated_at
         FROM family_evidence WHERE family_id = 'fam-live'`,
      )
      .get() as {
      local_realized_pnl_fifo: number;
      tail_adjusted_pnl: number;
      evidence_score: number;
      promotion_state: string;
      scores_updated_at: string | null;
    };
    expect(evidence.local_realized_pnl_fifo).toBe(0);
    expect(evidence.tail_adjusted_pnl).toBe(0);
    expect(evidence.evidence_score).toBe(0);
    expect(evidence.promotion_state).toBe("scaled");
    expect(evidence.scores_updated_at).toBeNull();

    const rollup = controlDb
      .prepare(
        `SELECT realized_pnl, tail_adjusted_pnl
         FROM family_profile_rollups
         WHERE family_id = 'fam-live' AND profile = 'live-lite'`,
      )
      .get() as { realized_pnl: number; tail_adjusted_pnl: number };
    expect(rollup.realized_pnl).toBe(0);
    expect(rollup.tail_adjusted_pnl).toBe(0);

    const paperRollup = controlDb
      .prepare(
        `SELECT realized_pnl, tail_adjusted_pnl
         FROM family_profile_rollups
         WHERE family_id = 'fam-live' AND profile = 'paper'`,
      )
      .get() as { realized_pnl: number; tail_adjusted_pnl: number };
    expect(paperRollup.realized_pnl).toBe(88);
    expect(paperRollup.tail_adjusted_pnl).toBe(77);
  });

  it("resetClosedFamily fully resets closed-only family state for the target profile", async () => {
    const { resetClosedFamily } = await loadRepairModule();
    const ledgerDb = new Database(":memory:");
    const controlDb = new Database(":memory:");

    ledgerDb.exec(`
      CREATE TABLE positions (
        position_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        status TEXT NOT NULL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        cost_basis_usdc REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE inventory_lots (
        lot_id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        remaining_size REAL NOT NULL DEFAULT 0,
        entry_price REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE family_runtime_state (
        family_id TEXT PRIMARY KEY,
        current_tail_cost_usdc REAL NOT NULL DEFAULT 0,
        tail_adjusted_pnl_live REAL NOT NULL DEFAULT 0,
        open_value_usdc REAL NOT NULL DEFAULT 0,
        open_position_count INTEGER NOT NULL DEFAULT 0,
        open_dust_count INTEGER NOT NULL DEFAULT 0,
        active_market_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );
    `);

    controlDb.exec(`
      CREATE TABLE family_evidence (
        family_id TEXT PRIMARY KEY,
        local_realized_pnl_fifo REAL NOT NULL DEFAULT 0,
        tail_adjusted_pnl REAL NOT NULL DEFAULT 0,
        evidence_score REAL NOT NULL DEFAULT 0,
        promotion_state TEXT NOT NULL DEFAULT 'probe-only',
        scores_updated_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE family_deployments (
        family_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        operator_mode TEXT NOT NULL DEFAULT 'active',
        updated_at TEXT,
        PRIMARY KEY (family_id, profile)
      );
      CREATE TABLE family_profile_rollups (
        family_id TEXT NOT NULL,
        profile TEXT NOT NULL,
        realized_pnl REAL NOT NULL DEFAULT 0,
        tail_adjusted_pnl REAL NOT NULL DEFAULT 0,
        updated_at TEXT,
        PRIMARY KEY (family_id, profile)
      );
    `);

    ledgerDb
      .prepare(
        `INSERT INTO positions (position_id, token_id, family_id, status, realized_pnl, cost_basis_usdc) VALUES
           ('pos-closed', 'tok-closed', 'fam-closed', 'closed', -2.5, 0)`,
      )
      .run();
    ledgerDb
      .prepare(
        `INSERT INTO family_runtime_state
           (family_id, current_tail_cost_usdc, tail_adjusted_pnl_live, open_value_usdc,
            open_position_count, open_dust_count, active_market_count, updated_at)
         VALUES ('fam-closed', 99, 99, 99, 9, 9, 9, datetime('now'))`,
      )
      .run();

    controlDb
      .prepare(
        `INSERT INTO family_evidence
           (family_id, local_realized_pnl_fifo, tail_adjusted_pnl, evidence_score, promotion_state, scores_updated_at, updated_at)
         VALUES ('fam-closed', 123, 77, 55, 'scaled', '2026-04-06T00:00:00Z', datetime('now'))`,
      )
      .run();
    controlDb
      .prepare(
        `INSERT INTO family_deployments (family_id, profile, operator_mode, updated_at) VALUES
           ('fam-closed', 'live-lite', 'quarantine', datetime('now')),
           ('fam-closed', 'paper', 'reduce-only', datetime('now'))`,
      )
      .run();
    controlDb
      .prepare(
        `INSERT INTO family_profile_rollups (family_id, profile, realized_pnl, tail_adjusted_pnl, updated_at) VALUES
           ('fam-closed', 'live-lite', 44, 33, datetime('now')),
           ('fam-closed', 'paper', 88, 77, datetime('now'))`,
      )
      .run();

    resetClosedFamily(ledgerDb, controlDb, "fam-closed", "live-lite");

    const familyState = ledgerDb
      .prepare(
        `SELECT current_tail_cost_usdc, tail_adjusted_pnl_live, open_value_usdc,
                open_position_count, open_dust_count, active_market_count
         FROM family_runtime_state WHERE family_id = 'fam-closed'`,
      )
      .get() as {
      current_tail_cost_usdc: number;
      tail_adjusted_pnl_live: number;
      open_value_usdc: number;
      open_position_count: number;
      open_dust_count: number;
      active_market_count: number;
    };
    expect(familyState.current_tail_cost_usdc).toBe(0);
    expect(familyState.tail_adjusted_pnl_live).toBe(-2.5);
    expect(familyState.open_value_usdc).toBe(0);
    expect(familyState.open_position_count).toBe(0);
    expect(familyState.open_dust_count).toBe(0);
    expect(familyState.active_market_count).toBe(0);

    const evidence = controlDb
      .prepare(
        `SELECT local_realized_pnl_fifo, tail_adjusted_pnl, evidence_score, promotion_state, scores_updated_at
         FROM family_evidence WHERE family_id = 'fam-closed'`,
      )
      .get() as {
      local_realized_pnl_fifo: number;
      tail_adjusted_pnl: number;
      evidence_score: number;
      promotion_state: string;
      scores_updated_at: string | null;
    };
    expect(evidence.local_realized_pnl_fifo).toBe(0);
    expect(evidence.tail_adjusted_pnl).toBe(0);
    expect(evidence.evidence_score).toBe(0);
    expect(evidence.promotion_state).toBe("probe-only");
    expect(evidence.scores_updated_at).toBeNull();

    const liveDeployment = controlDb
      .prepare(
        `SELECT operator_mode FROM family_deployments
         WHERE family_id = 'fam-closed' AND profile = 'live-lite'`,
      )
      .get() as { operator_mode: string };
    const paperDeployment = controlDb
      .prepare(
        `SELECT operator_mode FROM family_deployments
         WHERE family_id = 'fam-closed' AND profile = 'paper'`,
      )
      .get() as { operator_mode: string };
    expect(liveDeployment.operator_mode).toBe("active");
    expect(paperDeployment.operator_mode).toBe("reduce-only");

    const liveRollup = controlDb
      .prepare(
        `SELECT realized_pnl, tail_adjusted_pnl FROM family_profile_rollups
         WHERE family_id = 'fam-closed' AND profile = 'live-lite'`,
      )
      .get() as { realized_pnl: number; tail_adjusted_pnl: number };
    const paperRollup = controlDb
      .prepare(
        `SELECT realized_pnl, tail_adjusted_pnl FROM family_profile_rollups
         WHERE family_id = 'fam-closed' AND profile = 'paper'`,
      )
      .get() as { realized_pnl: number; tail_adjusted_pnl: number };
    expect(liveRollup.realized_pnl).toBe(0);
    expect(liveRollup.tail_adjusted_pnl).toBe(0);
    expect(paperRollup.realized_pnl).toBe(88);
    expect(paperRollup.tail_adjusted_pnl).toBe(77);
  });

  it("annotates tainted transitions only for the target profile", async () => {
    const { annotateTaintedTransitions } = await loadRepairModule();
    const controlDb = new Database(":memory:");

    controlDb.exec(`
      CREATE TABLE state_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        initiator TEXT,
        profile TEXT,
        deployment_id TEXT,
        reason TEXT NOT NULL,
        scores_snapshot TEXT,
        created_at TEXT NOT NULL
      );
    `);

    controlDb
      .prepare(
        `INSERT INTO state_transitions
           (entity_type, entity_id, from_state, to_state, trigger_type, initiator, profile, reason, created_at)
         VALUES
           ('family', 'fam-live', 'probe-only', 'reduce-only', 'system', 'worker', 'live-lite', 'live transition', '2026-04-06T00:00:00Z'),
           ('family', 'fam-live', 'probe-only', 'reduce-only', 'system', 'worker', 'paper', 'paper transition', '2026-04-06T00:00:00Z')`,
      )
      .run();

    const updated = annotateTaintedTransitions(
      controlDb,
      "fam-live",
      "2026-04-05T00:00:00Z",
      "live-lite",
    );

    expect(updated).toBe(1);

    const liveReason = controlDb
      .prepare(
        `SELECT reason FROM state_transitions WHERE entity_id = 'fam-live' AND profile = 'live-lite'`,
      )
      .get() as { reason: string };
    const paperReason = controlDb
      .prepare(
        `SELECT reason FROM state_transitions WHERE entity_id = 'fam-live' AND profile = 'paper'`,
      )
      .get() as { reason: string };

    expect(liveReason.reason).toContain("[pre-outcome-fix: PnL was incorrect]");
    expect(paperReason.reason).toBe("paper transition");
  });

  it("annotates legacy NULL-profile transitions for the target family", async () => {
    const { annotateTaintedTransitions } = await loadRepairModule();
    const controlDb = new Database(":memory:");

    controlDb.exec(`
      CREATE TABLE state_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        initiator TEXT,
        profile TEXT,
        deployment_id TEXT,
        reason TEXT NOT NULL,
        scores_snapshot TEXT,
        created_at TEXT NOT NULL
      );
    `);

    controlDb
      .prepare(
        `INSERT INTO state_transitions
           (entity_type, entity_id, from_state, to_state, trigger_type, initiator, profile, reason, created_at)
         VALUES
           ('family', 'fam-legacy', 'probe-only', 'reduce-only', 'system', 'worker', NULL, 'legacy transition', '2026-04-06T00:00:00Z'),
           ('family', 'fam-legacy', 'probe-only', 'reduce-only', 'system', 'worker', 'paper', 'paper transition', '2026-04-06T00:00:00Z')`,
      )
      .run();

    const updated = annotateTaintedTransitions(
      controlDb,
      "fam-legacy",
      "2026-04-05T00:00:00Z",
      "live-lite",
    );

    expect(updated).toBe(1);

    const legacyReason = controlDb
      .prepare(
        `SELECT reason FROM state_transitions WHERE entity_id = 'fam-legacy' AND profile IS NULL`,
      )
      .get() as { reason: string };
    const paperReason = controlDb
      .prepare(
        `SELECT reason FROM state_transitions WHERE entity_id = 'fam-legacy' AND profile = 'paper'`,
      )
      .get() as { reason: string };

    expect(legacyReason.reason).toContain("[pre-outcome-fix: PnL was incorrect]");
    expect(paperReason.reason).toBe("paper transition");
  });

  it("does not suppress legacy annotation when same-timestamp profile row is a different transition", async () => {
    const { annotateTaintedTransitions } = await loadRepairModule();
    const controlDb = new Database(":memory:");

    controlDb.exec(`
      CREATE TABLE state_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        initiator TEXT,
        profile TEXT,
        deployment_id TEXT,
        reason TEXT NOT NULL,
        scores_snapshot TEXT,
        created_at TEXT NOT NULL
      );
    `);

    controlDb
      .prepare(
        `INSERT INTO state_transitions
           (entity_type, entity_id, from_state, to_state, trigger_type, initiator, profile, reason, created_at)
         VALUES
           ('family', 'fam-legacy', 'probe-only', 'reduce-only', 'system', 'worker', NULL, 'legacy demotion', '2026-04-06T00:00:00Z'),
           ('family', 'fam-legacy', 'reduce-only', 'active', 'operator', 'worker', 'live-lite', 'live recovery', '2026-04-06T00:00:00Z')`,
      )
      .run();

    const updated = annotateTaintedTransitions(
      controlDb,
      "fam-legacy",
      "2026-04-05T00:00:00Z",
      "live-lite",
    );

    expect(updated).toBe(2);

    const rows = controlDb
      .prepare(
        `SELECT profile, reason
         FROM state_transitions
         WHERE entity_id = 'fam-legacy'
         ORDER BY id ASC`,
      )
      .all() as Array<{ profile: string | null; reason: string }>;

    expect(rows[0]!.profile).toBeNull();
    expect(rows[0]!.reason).toContain("[pre-outcome-fix: PnL was incorrect]");
    expect(rows[1]!.profile).toBe("live-lite");
    expect(rows[1]!.reason).toContain("[pre-outcome-fix: PnL was incorrect]");
  });
});
