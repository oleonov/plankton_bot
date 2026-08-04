import { OrderStatus } from "@krabs/domain";
import type BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootstrapLedgerDb } from "../bootstrap.js";
import type { DbConnection } from "../connection.js";
import {
  OWNERSHIP_INVARIANT_GUARD_SQL,
  OWNERSHIP_INVARIANT_ROW_SQL,
  PROJECTED_OWNERS_CREATE_SQL,
  formatOwnershipInvariantRemedy,
  hasOwnershipInvariantViolation,
  isWorkingSellOrderStatus,
  readOwnershipInvariantViolations,
  type ExitOwner,
  type OwnershipInvariantId,
} from "../exit-ownership-invariants.js";

/**
 * Release A Phase 6 §9a.6 tests 1–4 — the shared I1–I5 evaluator.
 *
 * Fixtures are built from the REAL migrations (`bootstrapLedgerDb`), never from a hand-rolled
 * single-table schema: column drift is exactly what a hand-rolled schema hides, and two of the
 * fixtures below only behave correctly because the real `idx_positions_unique_open_per_token`
 * exists.
 */

const ALL_IDS: readonly OwnershipInvariantId[] = OWNERSHIP_INVARIANT_ROW_SQL.map((e) => e.id);

let tmpDir: string;
let conn: DbConnection;
let db: BetterSqlite3.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-ownership-inv-"));
  conn = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  db = conn.db;
});

afterEach(() => {
  conn.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedPosition(s: {
  positionId: string;
  tokenId: string;
  status?: string;
  size?: number;
  exitOwner?: ExitOwner | null;
}): void {
  db.prepare(
    `INSERT INTO positions (position_id, token_id, side, size, status, exit_owner)
     VALUES (?, ?, 'buy', ?, ?, ?)`,
  ).run(s.positionId, s.tokenId, s.size ?? 100, s.status ?? "open", s.exitOwner ?? null);
}

function seedSell(s: {
  orderId: string;
  tokenId: string;
  positionId?: string | null;
  status?: string;
  size?: number;
  ruleId?: string | null;
  side?: string;
}): void {
  const size = s.size ?? 10;
  db.prepare(
    `INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size,
                         size_usdc, status, decision_rule_id, position_id, bot_run_id)
     VALUES (?, ?, ?, ?, 'GTC', 0.5, ?, ?, ?, ?, ?, 'test-run')`,
  ).run(
    s.orderId,
    `coid-${s.orderId}`,
    s.tokenId,
    s.side ?? "sell",
    size,
    size * 0.5,
    s.status ?? "open",
    s.ruleId === undefined ? "PROFILE_LADDER" : s.ruleId,
    s.positionId ?? null,
  );
}

function seedFill(s: { fillId: string; orderId: string; tokenId: string; size: number }): void {
  db.prepare(
    `INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc)
     VALUES (?, ?, ?, 'sell', 0.5, ?, ?)`,
  ).run(s.fillId, s.orderId, s.tokenId, s.size, s.size * 0.5);
}

/** An owned position with one well-sized, rule-consistent resting SELL: clean on all six. */
function seedCleanBaseline(): void {
  seedPosition({ positionId: "p-clean", tokenId: "tok-clean", exitOwner: "profile", size: 100 });
  seedSell({ orderId: "o-clean", tokenId: "tok-clean", positionId: "p-clean", size: 10 });
}

function counts(projection?: ReadonlyMap<string, ExitOwner>) {
  return readOwnershipInvariantViolations(db, projection).counts;
}

function expectOnly(
  actual: Readonly<Record<OwnershipInvariantId, number>>,
  id: OwnershipInvariantId,
  n = 1,
): void {
  expect(actual).toEqual(Object.fromEntries(ALL_IDS.map((k) => [k, k === id ? n : 0])));
}

function expectClean(actual: Readonly<Record<OwnershipInvariantId, number>>): void {
  expect(actual).toEqual(Object.fromEntries(ALL_IDS.map((k) => [k, 0])));
}

/**
 * The REMOTE half: build the projection table the way the generator emits it — a bare
 * `CREATE TEMP TABLE` in a fresh process — and evaluate the derived boolean guards.
 */
function runGuards(
  projection?: ReadonlyMap<string, ExitOwner>,
): Record<OwnershipInvariantId, 0 | 1> {
  db.exec("DROP TABLE IF EXISTS temp.projected_owners");
  db.exec(PROJECTED_OWNERS_CREATE_SQL);
  if (projection) {
    const insert = db.prepare("INSERT INTO projected_owners(position_id, owner) VALUES (?, ?)");
    for (const [positionId, owner] of projection) insert.run(positionId, owner);
  }
  const out = {} as Record<OwnershipInvariantId, 0 | 1>;
  for (const { id, sql } of OWNERSHIP_INVARIANT_GUARD_SQL) {
    out[id] = (db.prepare(sql).get() as { ok: 0 | 1 }).ok;
  }
  return out;
}

function expectGuardsOnly(
  actual: Record<OwnershipInvariantId, 0 | 1>,
  violating: OwnershipInvariantId | null,
): void {
  expect(actual).toEqual(Object.fromEntries(ALL_IDS.map((k) => [k, k === violating ? 0 : 1])));
}

// ─── §9a.6 test 1 — one seeded violation and one clean control per invariant ──────────────────

describe("readOwnershipInvariantViolations — per-invariant specificity", () => {
  it("clean control: an owned position with a consistent resting SELL violates nothing", () => {
    seedCleanBaseline();
    const v = readOwnershipInvariantViolations(db);
    expectClean(v.counts);
    expect(hasOwnershipInvariantViolation(v)).toBe(false);
  });

  it("nullOwners: an open position with no exit_owner", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-null", tokenId: "tok-null", exitOwner: null });
    const v = readOwnershipInvariantViolations(db);
    expectOnly(v.counts, "nullOwners");
    expect(v.rows.nullOwners[0]!.position_id).toBe("p-null");
    expect(hasOwnershipInvariantViolation(v)).toBe(true);
  });

  it("nullOwners: a CLOSED position with no exit_owner is not a violation", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-closed", tokenId: "tok-x", status: "closed", exitOwner: null });
    expectClean(counts());
  });

  it("nullOwners: a NULL-owner position OUTSIDE ('open','dust') still counts", () => {
    // The v22 widening. Under the enumerated status half this singleton reads clean at every
    // gate, while `findActiveByTokenId` already treats it as active — see §3.
    seedCleanBaseline();
    seedPosition({ positionId: "p-odd", tokenId: "tok-odd", status: "repairing", exitOwner: null });
    expectOnly(counts(), "nullOwners");
  });

  it("unboundSells (I1): an active SELL with no position_id", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i1", tokenId: "tok-i1", exitOwner: "profile", size: 100 });
    seedSell({ orderId: "o-i1", tokenId: "tok-i1", positionId: null, size: 10 });
    const v = readOwnershipInvariantViolations(db);
    expectOnly(v.counts, "unboundSells");
    expect(v.rows.unboundSells[0]!.order_id).toBe("o-i1");
  });

  it("unboundSells (I1): an INACTIVE unbound SELL is not a violation", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i1", tokenId: "tok-i1", exitOwner: "profile" });
    seedSell({ orderId: "o-i1", tokenId: "tok-i1", positionId: null, status: "cancelled" });
    expectClean(counts());
  });

  it("stalePointerSells (I2): the pointed-at position has since closed", () => {
    seedCleanBaseline();
    // A live sibling on the same token keeps I3 satisfied, and its distinct position_id is why
    // the NOT EXISTS still holds.
    seedPosition({ positionId: "p-i2-live", tokenId: "tok-i2", exitOwner: "profile", size: 100 });
    seedPosition({ positionId: "p-i2-gone", tokenId: "tok-i2", status: "closed", exitOwner: null });
    seedSell({ orderId: "o-i2", tokenId: "tok-i2", positionId: "p-i2-gone", size: 10 });
    const v = readOwnershipInvariantViolations(db);
    expectOnly(v.counts, "stalePointerSells");
    expect(v.rows.stalePointerSells[0]!.order_id).toBe("o-i2");
  });

  it("stalePointerSells (I2): a CROSS-TOKEN pointer — the only case that separates the two readings", () => {
    // Token-blind ("does the id resolve?") reports this clean; the executor already rejects it as
    // exit-owner-stale-position, because it selects candidates by the ORDER's token.
    seedPosition({ positionId: "P_A", tokenId: "tok-A", exitOwner: "profile", size: 100 });
    seedPosition({ positionId: "P_B", tokenId: "tok-B", exitOwner: "profile", size: 50 });
    seedSell({ orderId: "o-cross", tokenId: "tok-A", positionId: "P_B", size: 10 });
    const v = readOwnershipInvariantViolations(db);
    expectOnly(v.counts, "stalePointerSells");
    expect(v.rows.stalePointerSells[0]!.position_id).toBe("P_B");
  });

  it("stalePointerSells (I2): an UNBOUND SELL belongs to I1 only — the two stay disjoint", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i1", tokenId: "tok-i1", exitOwner: "profile" });
    seedSell({ orderId: "o-i1", tokenId: "tok-i1", positionId: null });
    expectOnly(counts(), "unboundSells");
  });

  it("overcommittedTokens (I3): Σ remaining active SELL shares exceeds the position size", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i3", tokenId: "tok-i3", exitOwner: "profile", size: 100 });
    seedSell({ orderId: "o-i3a", tokenId: "tok-i3", positionId: "p-i3", size: 60 });
    seedSell({ orderId: "o-i3b", tokenId: "tok-i3", positionId: "p-i3", size: 60 });
    const v = readOwnershipInvariantViolations(db);
    expectOnly(v.counts, "overcommittedTokens");
    expect(v.rows.overcommittedTokens[0]).toMatchObject({
      token_id: "tok-i3",
      remaining_sell_shares: 120,
      position_shares: 100,
    });
  });

  it("overcommittedTokens (I3): fills are subtracted — remaining, not ordered, size", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i3", tokenId: "tok-i3", exitOwner: "profile", size: 100 });
    seedSell({ orderId: "o-i3", tokenId: "tok-i3", positionId: "p-i3", size: 150 });
    seedFill({ fillId: "f-i3", orderId: "o-i3", tokenId: "tok-i3", size: 60 });
    expectClean(counts());
  });

  it("duplicateNonclosedTokens (I4): open + dust on one token", () => {
    // `idx_positions_unique_open_per_token` is UNIQUE(token_id) WHERE status='open', so the
    // duplicate must not be two `open` rows — and I4 ranges over nonclosed, not over open.
    seedCleanBaseline();
    seedPosition({ positionId: "p-i4a", tokenId: "tok-i4", exitOwner: "profile", size: 100 });
    seedPosition({
      positionId: "p-i4b",
      tokenId: "tok-i4",
      status: "dust",
      exitOwner: "profile",
      size: 0,
    });
    const v = readOwnershipInvariantViolations(db);
    expectOnly(v.counts, "duplicateNonclosedTokens");
    expect(v.rows.duplicateNonclosedTokens[0]).toMatchObject({
      token_id: "tok-i4",
      nonclosed_rows: 2,
    });
  });

  it("duplicateNonclosedTokens (I4): open + an OUT-OF-DOMAIN status still duplicates", () => {
    // The exclusion-vs-enumerated separator: a `dust` seed is counted by either implementation.
    seedCleanBaseline();
    seedPosition({ positionId: "p-i4a", tokenId: "tok-i4", exitOwner: "profile", size: 100 });
    seedPosition({
      positionId: "p-i4b",
      tokenId: "tok-i4",
      status: "repairing",
      exitOwner: "profile",
      size: 0,
    });
    expectOnly(counts(), "duplicateNonclosedTokens");
  });

  it("duplicateNonclosedTokens (I4): open + closed on one token is not a duplicate", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i4a", tokenId: "tok-i4", exitOwner: "profile", size: 100 });
    seedPosition({
      positionId: "p-i4b",
      tokenId: "tok-i4",
      status: "closed",
      exitOwner: "profile",
    });
    expectClean(counts());
  });

  it("wrongOwnerSells (I5): a bounce-ruled SELL resting on a profile-owned position", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i5", tokenId: "tok-i5", exitOwner: "profile", size: 100 });
    seedSell({
      orderId: "o-i5",
      tokenId: "tok-i5",
      positionId: "p-i5",
      ruleId: "BOUNCE_EXIT_TARGET",
    });
    const v = readOwnershipInvariantViolations(db);
    expectOnly(v.counts, "wrongOwnerSells");
    expect(v.rows.wrongOwnerSells[0]).toMatchObject({
      order_id: "o-i5",
      effective_owner: "profile",
      implied_owner: "bounce",
    });
  });

  it("wrongOwnerSells (I5): BOUNCE_EXIT_BACKSTOP implies bounce too", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i5", tokenId: "tok-i5", exitOwner: "profile", size: 100 });
    seedSell({
      orderId: "o-i5",
      tokenId: "tok-i5",
      positionId: "p-i5",
      ruleId: "BOUNCE_EXIT_BACKSTOP",
    });
    expectOnly(counts(), "wrongOwnerSells");
  });

  it("wrongOwnerSells (I5): an UNKNOWN rule id is profile-ruled, never a third case", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-bounce", tokenId: "tok-b", exitOwner: "bounce", size: 100 });
    seedPosition({ positionId: "p-profile", tokenId: "tok-p", exitOwner: "profile", size: 100 });
    seedSell({
      orderId: "o-legacy-b",
      tokenId: "tok-b",
      positionId: "p-bounce",
      ruleId: "LEGACY_X",
    });
    seedSell({ orderId: "o-legacy-p", tokenId: "tok-p", positionId: "p-profile", ruleId: null });
    const v = readOwnershipInvariantViolations(db);
    // Only the bounce-owned one is a violation: both legacy ids map to `profile`.
    expectOnly(v.counts, "wrongOwnerSells");
    expect(v.rows.wrongOwnerSells[0]).toMatchObject({
      order_id: "o-legacy-b",
      implied_owner: "profile",
    });
  });

  it("wrongOwnerSells (I5): a bounce SELL on a bounce-owned position is clean", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i5", tokenId: "tok-i5", exitOwner: "bounce", size: 100 });
    seedSell({
      orderId: "o-i5",
      tokenId: "tok-i5",
      positionId: "p-i5",
      ruleId: "BOUNCE_EXIT_TARGET",
    });
    expectClean(counts());
  });
});

// ─── §9a.6 test 2 — the projection is what separates census semantics from gate semantics ─────

describe("readOwnershipInvariantViolations — projectedOwners semantics", () => {
  function seedNullOwnerWithBounceSell(): void {
    seedPosition({ positionId: "p-t", tokenId: "tok-t", exitOwner: null, size: 100 });
    seedSell({
      orderId: "o-t",
      tokenId: "tok-t",
      positionId: "p-t",
      ruleId: "BOUNCE_EXIT_TARGET",
    });
  }

  it("(a) no projection ⇒ the SELL contributes nothing to wrongOwnerSells", () => {
    seedNullOwnerWithBounceSell();
    // The activation gates' behaviour: only `nullOwners` fires, on the raw column.
    expectOnly(counts(), "nullOwners");
  });

  it("(b) projecting 'profile' ⇒ wrongOwnerSells = 1", () => {
    seedNullOwnerWithBounceSell();
    expectOnly(counts(new Map([["p-t", "profile"]])), "wrongOwnerSells");
  });

  it("(c) projecting 'bounce' ⇒ 0", () => {
    seedNullOwnerWithBounceSell();
    expectClean(counts(new Map([["p-t", "bounce"]])));
  });

  it("(d) nullOwners obeys the SAME effective-owner rule", () => {
    seedPosition({ positionId: "p-t", tokenId: "tok-t", exitOwner: null });
    expectOnly(counts(), "nullOwners");
    expectClean(counts(new Map([["p-t", "profile"]])));
  });

  /**
   * The operand order inside the effective-owner COALESCE, asserted where it is observable. Every case
   * above projects for a NULL-owner position, and there the two orders agree — so this is the one fixture
   * that separates them, and without it the ledger-first form is untested.
   */
  it("(f) a non-NULL ledger owner OUTRANKS a contradicting projection", () => {
    seedPosition({ positionId: "p-t", tokenId: "tok-t", exitOwner: "bounce", size: 100 });
    seedSell({ orderId: "o-t", tokenId: "tok-t", positionId: "p-t", ruleId: "BOUNCE_EXIT_TARGET" });

    // §3: once set, `exit_owner` is immutable. A projection claiming otherwise is the caller's error, and
    // it must not relabel an owned position — under the reverse order this same fixture reports a
    // wrong-owner SELL that does not exist, on both halves.
    const projection = new Map<string, ExitOwner>([["p-t", "profile"]]);
    expectClean(counts(projection));
    expectGuardsOnly(runGuards(projection), null);
  });

  it("(e) the temp table is idempotent and self-clearing on a REUSED connection", () => {
    seedPosition({ positionId: "p-t", tokenId: "tok-t", exitOwner: null });

    // projection → none: without IF NOT EXISTS the second call throws; without DELETE it
    // silently under-counts, which is the gate-PASSING direction.
    expectClean(counts(new Map([["p-t", "bounce"]])));
    expectOnly(counts(), "nullOwners");

    // and the reverse order, so neither state leaks into the other
    expectOnly(counts(), "nullOwners");
    expectClean(counts(new Map([["p-t", "bounce"]])));
  });
});

// ─── §9a.6 test 3 — SQL/TS parity, per-invariant isolation ────────────────────────────────────

describe("OWNERSHIP_INVARIANT_GUARD_SQL — parity with the row form", () => {
  it("(d) covers all six ids and CONTAINS the row SQL verbatim (mechanical derivation)", () => {
    expect(OWNERSHIP_INVARIANT_GUARD_SQL.map((e) => e.id)).toEqual(ALL_IDS);
    expect(new Set(ALL_IDS).size).toBe(6);
    for (const [i, guard] of OWNERSHIP_INVARIANT_GUARD_SQL.entries()) {
      expect(guard.sql).toContain(OWNERSHIP_INVARIANT_ROW_SQL[i]!.sql);
    }
  });

  it("(a) clean fixture ⇒ every guard returns ok = 1 and every count is 0", () => {
    seedCleanBaseline();
    expectClean(counts());
    expectGuardsOnly(runGuards(), null);
  });

  const isolated: ReadonlyArray<{ id: OwnershipInvariantId; seed: () => void }> = [
    {
      id: "nullOwners",
      seed: () => seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: null }),
    },
    {
      id: "unboundSells",
      seed: () => {
        seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: "profile", size: 100 });
        seedSell({ orderId: "o-x", tokenId: "tok-x", positionId: null, size: 10 });
      },
    },
    {
      id: "stalePointerSells",
      seed: () => {
        seedPosition({ positionId: "p-live", tokenId: "tok-x", exitOwner: "profile", size: 100 });
        seedPosition({ positionId: "p-gone", tokenId: "tok-x", status: "closed" });
        seedSell({ orderId: "o-x", tokenId: "tok-x", positionId: "p-gone", size: 10 });
      },
    },
    {
      id: "overcommittedTokens",
      seed: () => {
        seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: "profile", size: 10 });
        seedSell({ orderId: "o-x", tokenId: "tok-x", positionId: "p-x", size: 50 });
      },
    },
    {
      id: "duplicateNonclosedTokens",
      seed: () => {
        seedPosition({ positionId: "p-x1", tokenId: "tok-x", exitOwner: "profile", size: 100 });
        seedPosition({
          positionId: "p-x2",
          tokenId: "tok-x",
          status: "dust",
          exitOwner: "profile",
          size: 0,
        });
      },
    },
    {
      id: "wrongOwnerSells",
      seed: () => {
        seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: "profile", size: 100 });
        seedSell({
          orderId: "o-x",
          tokenId: "tok-x",
          positionId: "p-x",
          ruleId: "BOUNCE_EXIT_TARGET",
        });
      },
    },
  ];

  it.each(isolated.map((c) => [c.id, c] as const))(
    "(b) %s in isolation — exactly that guard flips, on both sides",
    (id, c) => {
      seedCleanBaseline();
      c.seed();
      expectOnly(counts(), id);
      expectGuardsOnly(runGuards(), id);
    },
  );

  it("(c) I5 via the PRE-OWNED column — both sides agree", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-owned", tokenId: "tok-o", exitOwner: "bounce", size: 100 });
    seedSell({
      orderId: "o-owned",
      tokenId: "tok-o",
      positionId: "p-owned",
      ruleId: "PROFILE_LADDER",
    });
    expectOnly(counts(), "wrongOwnerSells");
    expectGuardsOnly(runGuards(), "wrongOwnerSells");
  });

  it("(c) I5 via the PROJECTION only — both sides agree, and the remote half honours it", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-proj", tokenId: "tok-p", exitOwner: null, size: 100 });
    seedSell({
      orderId: "o-proj",
      tokenId: "tok-p",
      positionId: "p-proj",
      ruleId: "BOUNCE_EXIT_TARGET",
    });
    const projection = new Map<string, ExitOwner>([["p-proj", "profile"]]);
    expectOnly(counts(projection), "wrongOwnerSells");
    expectGuardsOnly(runGuards(projection), "wrongOwnerSells");
    // Without the projection the remote half sees a NULL owner, not a wrong one.
    expectGuardsOnly(runGuards(), "nullOwners");
  });
});

// ─── §9a.6 test 4 — the active-SELL status set, in both forms ─────────────────────────────────

describe("isWorkingSellOrderStatus — status-set parity with the SQL form", () => {
  const EXPECTED: ReadonlyArray<readonly [string, boolean]> = [
    [OrderStatus.Pending, true],
    [OrderStatus.Open, true],
    [OrderStatus.PartiallyFilled, true],
    [OrderStatus.Filled, false],
    [OrderStatus.Cancelled, false],
    [OrderStatus.Rejected, false],
    // (b) unknown status — the schema admits any text, and the EXCLUSION semantics must treat it
    // as active in BOTH forms. This is the case an `IN (…)` phrasing would get wrong.
    ["expired", true],
  ];

  it("(d) the domain enum still has exactly six members", () => {
    expect(Object.keys(OrderStatus)).toHaveLength(6);
  });

  it("(c) the SQL form is written as an exclusion, never as an inclusion", () => {
    for (const { sql } of OWNERSHIP_INVARIANT_ROW_SQL) {
      expect(sql).not.toMatch(/o\.status IN \(/);
    }
    const withStatus = OWNERSHIP_INVARIANT_ROW_SQL.filter((e) => e.sql.includes("o.status"));
    expect(withStatus).toHaveLength(4);
    for (const { sql } of withStatus) {
      expect(sql).toContain("o.status NOT IN ('filled', 'rejected', 'cancelled')");
    }
  });

  it.each(EXPECTED.map(([status, active]) => [status, active] as const))(
    "%s ⇒ active=%s in both forms",
    (status, active) => {
      expect(isWorkingSellOrderStatus(status)).toBe(active);
      // The SQL oracle: an unbound SELL surfaces in I1 iff the SQL considers it active.
      seedSell({ orderId: `o-${status}`, tokenId: "tok-s", positionId: null, status });
      expect(counts().unboundSells).toBe(active ? 1 : 0);
    },
  );

  it("(e) null/undefined are classified ACTIVE — pinning existing TS behaviour, not parity", () => {
    // Out of the SQL form's reach by construction: `orders.status` is NOT NULL, and no invariant
    // reaches it through an outer join. If that ever changes, this case and the `NOT IN` phrasing
    // must be revisited together.
    expect(isWorkingSellOrderStatus(null)).toBe(true);
    expect(isWorkingSellOrderStatus(undefined)).toBe(true);
  });
});

// ─── §9a.3 — the per-class remedy formatter ───────────────────────────────────────────────────

/**
 * Each entry carries its OWN `remedy` because a single "run the census" sentence is true for
 * `nullOwners` alone and false for I1–I5 in the direction that keeps the bot down: §5.3's `--apply`
 * gate refuses to write while any of the five is non-zero, so an operator who follows a generic
 * instruction re-enters the identical fatal.
 *
 * The per-class TEXT is asserted at the two CONSUMERS — `assert-bounce-for-all-invariant.test.ts`
 * and `profiles-census-gate.test.ts` — which hard-code it as an anti-oracle. Restating it here would
 * only compare the table against itself and pass on any string whatsoever, so this file pins the two
 * properties those files cannot see: the table is TOTAL (six declarations, none blank, none shared),
 * and the formatter SELECTS from that table — exactly the violated classes, in declaration order —
 * rather than from a hand-written list beside it that a seventh invariant would silently miss.
 */
describe("formatOwnershipInvariantRemedy — totality and selection", () => {
  const TRAILER = " — the census DRY RUN lists the offending rows and is blocked by no invariant";

  const ZERO = Object.fromEntries(ALL_IDS.map((id) => [id, 0])) as Record<
    OwnershipInvariantId,
    number
  >;

  const countsFor = (...violated: readonly OwnershipInvariantId[]) => ({
    ...ZERO,
    ...Object.fromEntries(violated.map((id) => [id, 1])),
  });

  /** The `id: remedy` segments with the trailer stripped — i.e. the part the formatter SELECTS. */
  function segments(counts: Readonly<Record<OwnershipInvariantId, number>>): string[] {
    const text = formatOwnershipInvariantRemedy(counts);
    expect(text.endsWith(TRAILER)).toBe(true);
    const head = text.slice(0, -TRAILER.length);
    return head === "" ? [] : head.split("; ");
  }

  it("every invariant declares a non-blank remedy, and no two share one", () => {
    const remedies = OWNERSHIP_INVARIANT_ROW_SQL.map((e) => e.remedy);
    expect(remedies).toHaveLength(6);
    for (const remedy of remedies) expect(remedy.trim()).not.toBe("");
    // Distinct because the operator reads ONE line per violated class: a shared string reports two
    // different repairs as the same action, which is the generic-sentence failure in miniature.
    expect(new Set(remedies).size).toBe(remedies.length);
  });

  it.each(OWNERSHIP_INVARIANT_ROW_SQL)("$id alone ⇒ exactly its own line", (entry) => {
    expect(segments(countsFor(entry.id))).toEqual([`${entry.id}: ${entry.remedy}`]);
  });

  it("all six violated ⇒ six lines, in DECLARATION order", () => {
    expect(segments(countsFor(...ALL_IDS))).toEqual(
      OWNERSHIP_INVARIANT_ROW_SQL.map((e) => `${e.id}: ${e.remedy}`),
    );
  });

  it("a zero-count class contributes nothing — the list is the violated set, not the table", () => {
    const violated: readonly OwnershipInvariantId[] = ["unboundSells", "wrongOwnerSells"];
    const lines = segments(countsFor(...violated));
    expect(lines.map((line) => line.split(":")[0])).toEqual([...violated]);
    // The other four are absent by NAME, not merely absent from the count: a formatter that printed
    // every class with a "0" prefix would still satisfy a length assertion.
    for (const id of ALL_IDS.filter((k) => !violated.includes(k))) {
      expect(formatOwnershipInvariantRemedy(countsFor(...violated))).not.toContain(id);
    }
  });

  it("the pointer to the dry run survives even the empty case", () => {
    // Documented precondition: callers format this only under `hasOwnershipInvariantViolation`,
    // which is what keeps the leading list non-empty in production. Pinned rather than defended
    // against, so a future caller that drops that guard fails here instead of shipping a bare dash.
    expect(formatOwnershipInvariantRemedy(ZERO)).toBe(TRAILER);
  });
});

// ─── §5.1.11 — the `columns` metadata each entry declares ─────────────────────────────────────

/**
 * SQLite 3.37.2 cannot name a subquery's result columns for the census export — measured:
 * `json_object(r.*)` is `near "*": syntax error` and `json(r)` is `no such column: r` — so each entry
 * declares them, and the export interpolates the list twice: as JSON keys (`'<c>'`) and as column
 * references (`r.<c>`).
 *
 * §9a.6 test 8(f) (in the census suite, where a prepared statement is available) pins the
 * declaration against `stmt.columns()`. What is checkable HERE is the shape the export's string
 * interpolation depends on, which `stmt.columns()` equality alone does not establish: a non-empty
 * duplicate-free list of bare identifiers, whose FIRST entry is the `sql`'s own `ORDER BY` key.
 */
describe("OWNERSHIP_INVARIANT_ROW_SQL — the declared `columns`", () => {
  it.each(OWNERSHIP_INVARIANT_ROW_SQL)("$id declares a usable column list", ({ columns }) => {
    expect(columns.length).toBeGreaterThan(0);
    // Bare identifiers: the export emits `'<c>', r.<c>` unquoted, so anything needing quoting —
    // a space, a dot, an apostrophe — produces a syntax error or a mis-keyed JSON object.
    for (const column of columns) expect(column).toMatch(/^[a-z][a-z0-9_]*$/);
    // Duplicate-free: `json_object` keeps the LAST of two identical keys, so a repeat would drop a
    // diagnostic column from the manifest without any error.
    expect(new Set(columns).size).toBe(columns.length);
  });

  it.each(OWNERSHIP_INVARIANT_ROW_SQL)(
    "$id — the FIRST declared column is the query's ORDER BY key",
    ({ sql, columns }) => {
      // The export re-applies `r.${columns[0]}` at the OUTER level rather than trusting the
      // subquery's own ORDER BY to survive flattening, so the manifest's array order is that key's.
      // If the two ever diverge the payload stays valid and merely reorders — and §5.1's digest
      // turns a reorder into a spurious guard-#5 mismatch under the lock.
      expect(sql.trimEnd()).toMatch(new RegExp(`ORDER BY (?:[a-z_]+\\.)?${columns[0]}$`));
    },
  );
});
