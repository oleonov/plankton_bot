/**
 * Release A Phase 6 §9a.6 test 5 — the API activation gate, widened from NULL owners to I1–I5.
 *
 * Boots the real server against REAL split schemas, so every fixture goes through the same
 * migrations production runs. Two properties are under test that the Phase-5 suite cannot express:
 * the per-class boundary (a gate that consults only two of the six classes admits the other four),
 * and the write-barrier (the evaluation must happen INSIDE the BEGIN IMMEDIATE that activates).
 *
 * KNOWN DEVIATION from §9a.6 5(e): the plan asks for ONE shared fixture helper behind this matrix
 * and the runtime startup matrix. `apps/api` and `apps/runtime` cannot import each other, cannot
 * import a `packages/db` test module (its `exports` map exposes only `"."`, and `rootDir: "src"`
 * makes a relative cross-package import a TS6059 build error), and there is no `packages/test-utils`.
 * The seven seeds are duplicated in the two app test files. The duplication is self-checking rather
 * than silent: every row asserts a NON-ZERO count for its OWN class, so a drifted seed fails loudly
 * instead of quietly weakening the gate.
 */
import type { AppConfig } from "@krabs/config";
import { bootstrapControlDb, bootstrapLedgerDb, type DbConnection } from "@krabs/db";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { LedgerPool } from "../ledger-pool.js";
import { buildServer } from "../server.js";
import { MARKET_DATA_TEST_DEFAULTS } from "./test-helpers.js";

/**
 * §9a.6 5(d): the barrier proof must be driven from INSIDE the evaluation, not from the test's
 * own timing — otherwise an implementation that reads before `BEGIN IMMEDIATE` passes unchanged.
 */
const mocked = vi.hoisted(() => ({
  hook: null as null | ((gateDb: BetterSqlite3.Database) => void),
}));

vi.mock("@krabs/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@krabs/db")>();
  return {
    ...actual,
    readOwnershipInvariantViolations: (
      db: BetterSqlite3.Database,
      projected?: ReadonlyMap<string, "bounce" | "profile">,
    ) => {
      mocked.hook?.(db);
      return actual.readOwnershipInvariantViolations(db, projected);
    },
  };
});

const TEST_API_KEY = "test-census-gate-key";

function testConfig(): AppConfig {
  return {
    runtimeMode: undefined,
    logLevel: "error",
    dbPath: "",
    marketDataPollIntervalMs: 30_000,
    marketDataStaleThresholdMs: 120_000,
    marketScanIntervalMs: 300_000,
    strategyScanIntervalMs: 5_000,
    fillPollIntervalMs: 5_000,
    enableInventoryAutoMerge: false,
    executionMaxConcurrency: 4,
    executionWalletBufferPct: 0.03,
    executionWalletBufferMinUsdc: 0.25,
    polyApiKey: undefined,
    polyApiSecret: undefined,
    polyPassphrase: undefined,
    polyPrivateKey: undefined,
    krabsApiKey: TEST_API_KEY,
    krabsApiPort: 0,
    krabsAuthUsername: undefined,
    krabsAuthPassword: undefined,
    krabsSessionSecret: undefined,
    allowSellSizeClamp: true,
    executionSellBalanceRejectBlockEnabled: true,
    executionSellBalanceRejectBlockMs: 60000,
    executionSellExchangeReservedEnabled: true,
    trustProxy: false,
    ...MARKET_DATA_TEST_DEFAULTS,
  };
}

let tmp: string;
let ledgerPath: string;
let control: DbConnection;
let ledger: DbConnection;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "krabs-census-gate-"));
  ledgerPath = path.join(tmp, "ledger-sim.db");
  control = bootstrapControlDb(path.join(tmp, "control.db"));
  ledger = bootstrapLedgerDb(ledgerPath);
  control.db.exec(`
    INSERT OR IGNORE INTO profiles (profile_id, display_name) VALUES ('simulation', 'Simulation');
    INSERT INTO runtime_control_state (id, current_profile, desired_profile, runtime_status, paused)
    VALUES (1, 'simulation', 'simulation', 'running', 0)
    ON CONFLICT(id) DO UPDATE SET current_profile = excluded.current_profile;
  `);
  app = await buildServer({
    config: testConfig(),
    controlDb: control.db,
    ledgerDb: ledger.db,
    ledgerPool: { get: () => ledger.db } as unknown as LedgerPool,
  });
});

afterAll(async () => {
  await app.close();
  control.close();
  ledger.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  mocked.hook = null;
  ledger.db.exec("DELETE FROM fills; DELETE FROM orders; DELETE FROM positions;");
  // Every case must be a genuine false→true transition, or the gate is not even consulted.
  await patch({ bounceExit: { applyToAllMarkets: false } });
});

function headers() {
  return { authorization: `Bearer ${TEST_API_KEY}` };
}

async function patch(payload: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: "/api/v1/profiles/simulation/execution-policy",
    headers: headers(),
    payload,
  });
}

const enable = () => patch({ bounceExit: { applyToAllMarkets: true } });

function seedPosition(s: {
  positionId: string;
  tokenId: string;
  status?: string;
  size?: number;
  exitOwner?: "bounce" | "profile" | null;
}): void {
  ledger.db
    .prepare(
      `INSERT INTO positions (position_id, token_id, side, size, status, exit_owner)
       VALUES (?, ?, 'buy', ?, ?, ?)`,
    )
    .run(s.positionId, s.tokenId, s.size ?? 100, s.status ?? "open", s.exitOwner ?? null);
}

function seedSell(s: {
  orderId: string;
  tokenId: string;
  positionId?: string | null;
  status?: string;
  size?: number;
  ruleId?: string | null;
}): void {
  const size = s.size ?? 10;
  ledger.db
    .prepare(
      `INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size,
                           size_usdc, status, decision_rule_id, position_id, bot_run_id)
       VALUES (?, ?, ?, 'sell', 'GTC', 0.5, ?, ?, ?, ?, ?, 'test-run')`,
    )
    .run(
      s.orderId,
      `coid-${s.orderId}`,
      s.tokenId,
      size,
      size * 0.5,
      s.status ?? "open",
      s.ruleId === undefined ? "PROFILE_LADDER" : s.ruleId,
      s.positionId ?? null,
    );
}

function seedFill(s: { fillId: string; orderId: string; tokenId: string; size: number }): void {
  ledger.db
    .prepare(
      `INSERT INTO fills (fill_id, order_id, token_id, side, price, size, size_usdc)
       VALUES (?, ?, ?, 'sell', 0.5, ?, ?)`,
    )
    .run(s.fillId, s.orderId, s.tokenId, s.size, s.size * 0.5);
}

/** An owned position with one well-sized, rule-consistent resting SELL: clean on all six. */
function seedCleanBaseline(): void {
  seedPosition({ positionId: "p-clean", tokenId: "tok-clean", exitOwner: "profile", size: 100 });
  seedSell({ orderId: "o-clean", tokenId: "tok-clean", positionId: "p-clean", size: 10 });
}

type MatrixRow = { id: string; label: string; nullOwnerClass: boolean; seed: () => void };

/**
 * One seeded violation per class on an otherwise-clean fixture. Rows 7 and 8 are the
 * exclusion-vs-enumerated separators: a `dust` duplicate is counted by either implementation, and
 * the singleton `repairing` NULL owner reads clean under the enumerated form — so those two rows,
 * and only those, tell the two implementations apart at this boundary.
 */
const VIOLATION_SEEDS: readonly MatrixRow[] = [
  {
    id: "nullOwners",
    label: "nullOwners — an open position with no owner",
    nullOwnerClass: true,
    seed: () => seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: null }),
  },
  {
    id: "unboundSells",
    label: "I1 — an active SELL bound to no position",
    nullOwnerClass: false,
    seed: () => {
      seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: "profile", size: 100 });
      seedSell({ orderId: "o-x", tokenId: "tok-x", positionId: null, size: 10 });
    },
  },
  {
    id: "stalePointerSells",
    label: "I2 — an active SELL pointing at a closed position",
    nullOwnerClass: false,
    seed: () => {
      seedPosition({ positionId: "p-live", tokenId: "tok-x", exitOwner: "profile", size: 100 });
      seedPosition({ positionId: "p-gone", tokenId: "tok-x", status: "closed" });
      seedSell({ orderId: "o-x", tokenId: "tok-x", positionId: "p-gone", size: 10 });
    },
  },
  {
    id: "overcommittedTokens",
    label: "I3 — more remaining SELL shares than the position holds",
    nullOwnerClass: false,
    seed: () => {
      seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: "profile", size: 10 });
      seedSell({ orderId: "o-x", tokenId: "tok-x", positionId: "p-x", size: 50 });
    },
  },
  {
    id: "duplicateNonclosedTokens",
    label: "I4 — two nonclosed positions on one token (open + dust)",
    nullOwnerClass: false,
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
    label: "I5 — a bounce-ruled SELL on a profile-owned position",
    nullOwnerClass: false,
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
  {
    id: "duplicateNonclosedTokens",
    label: "I4 — open + an OUT-OF-DOMAIN nonclosed status (exclusion vs enumerated)",
    nullOwnerClass: false,
    seed: () => {
      seedPosition({ positionId: "p-x1", tokenId: "tok-x", exitOwner: "profile", size: 100 });
      seedPosition({
        positionId: "p-x2",
        tokenId: "tok-x",
        status: "repairing",
        exitOwner: "profile",
        size: 0,
      });
    },
  },
  {
    id: "nullOwners",
    label: "nullOwners — a SINGLETON out-of-domain NULL-owner position",
    nullOwnerClass: true,
    seed: () => seedPosition({ positionId: "p-odd", tokenId: "tok-odd", status: "repairing" }),
  },
];

/**
 * §9a.3 — the action each class actually needs, hard-coded rather than imported from
 * `OWNERSHIP_INVARIANT_ROW_SQL` so the 409 body is asserted against an independent oracle instead of
 * against the formatter's own source. Duplicated from the runtime suite for the reason that file's
 * header records: `apps/api` and `apps/runtime` cannot import each other's test modules.
 */
const REMEDIES: Readonly<Record<string, string>> = {
  nullOwners:
    "reconcile any nonclosed position whose status is outside open/dust, then run the census --apply",
  unboundSells: "cancel the listed unbound SELL order(s)",
  stalePointerSells: "cancel the listed stale-pointer SELL order(s)",
  overcommittedTokens: "cancel or reduce the excess SELL commitment on the listed token(s)",
  duplicateNonclosedTokens: "reconcile the listed token(s) down to one nonclosed position",
  wrongOwnerSells: "cancel the listed wrong-owner SELL order(s)",
};

/** The pre-v25 text — an anti-oracle, so a regression to one generic sentence goes red here too. */
const GENERIC_REMEDY = "run the census to repair ownership first";

describe("PATCH /execution-policy — applyToAllMarkets gate over I1–I5 (Phase 6 §9a)", () => {
  it("(a) a NULL-owner position keeps the UNCHANGED census error code", async () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-null", tokenId: "tok-null", exitOwner: null });
    const res = await enable();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("APPLY_TO_ALL_MARKETS_REQUIRES_CENSUS");
  });

  it("(b) an I3 violation with ZERO NULL owners gets the new code and a breakdown", async () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i3", tokenId: "tok-i3", exitOwner: "profile", size: 10 });
    seedSell({ orderId: "o-i3", tokenId: "tok-i3", positionId: "p-i3", size: 50 });
    const res = await enable();
    expect(res.statusCode).toBe(409);
    const error = res.json().error as { code: string; message: string };
    expect(error.code).toBe("APPLY_TO_ALL_MARKETS_INVARIANT_VIOLATION");
    expect(error.message).toContain("overcommittedTokens=1");
    expect(error.message).toContain("nullOwners=0");
  });

  it("(c) a clean ledger enables — the negative control for the whole matrix", async () => {
    seedCleanBaseline();
    // and a partially-filled oversized SELL, so the fills subtraction is exercised on the clean side
    seedPosition({ positionId: "p-partial", tokenId: "tok-p", exitOwner: "profile", size: 100 });
    seedSell({ orderId: "o-partial", tokenId: "tok-p", positionId: "p-partial", size: 150 });
    seedFill({ fillId: "f-partial", orderId: "o-partial", tokenId: "tok-p", size: 60 });

    const res = await enable();
    expect(res.statusCode).toBe(200);
    expect(res.json().data.policy.bounceExit.applyToAllMarkets).toBe(true);
  });

  it("(d) the evaluation runs INSIDE the write barrier that activates the flag", async () => {
    seedCleanBaseline();
    let observed: { inTransaction: boolean; competingWrite: string } | null = null;

    mocked.hook = (gateDb) => {
      const other = new BetterSqlite3(ledgerPath);
      other.pragma("busy_timeout = 0");
      let competingWrite = "committed";
      try {
        other
          .prepare(
            `INSERT INTO positions (position_id, token_id, side, size, status)
             VALUES ('p-race', 'tok-race', 'buy', 1, 'open')`,
          )
          .run();
      } catch (err) {
        competingWrite = (err as { code?: string }).code ?? String(err);
      }
      other.close();
      // Recorded, not asserted here: throwing inside the reader would roll the gate back and
      // report a 500, masking which half actually failed.
      observed = { inTransaction: gateDb.inTransaction, competingWrite };
    };

    const res = await enable();

    // (i) an implementation that reads BEFORE `BEGIN IMMEDIATE` fails here…
    expect(observed).toEqual({ inTransaction: true, competingWrite: "SQLITE_BUSY" });
    // …and (ii) so does one whose transaction is deferred: a deferred BEGIN takes no write lock
    // under WAL, so the competing INSERT would commit and this would read "committed".
    expect(res.statusCode).toBe(200);
    // NEGATIVE CONTROLS (manual, by construction — they require editing production code):
    // hoist `readOwnershipInvariantViolations` above `gateLedger.transaction(...)` ⇒ (i) goes red;
    // drop `.immediate()` from that same call ⇒ (ii) goes red.
  });

  describe("(e) per-class boundary matrix — a gate that consults only two classes admits four", () => {
    it.each(VIOLATION_SEEDS.map((row) => [row.label, row] as const))(
      "%s ⇒ 409, and the enable does not commit",
      async (_label, row) => {
        seedCleanBaseline();
        row.seed();

        const res = await enable();
        expect(res.statusCode).toBe(409);
        const error = res.json().error as { code: string; message: string };

        if (row.nullOwnerClass) {
          expect(error.code).toBe("APPLY_TO_ALL_MARKETS_REQUIRES_CENSUS");
          expect(error.message).toMatch(/[1-9]\d* active position\(s\) still have NULL exit_owner/);
        } else {
          expect(error.code).toBe("APPLY_TO_ALL_MARKETS_INVARIANT_VIOLATION");
          expect(error.message).toMatch(new RegExp(`${row.id}=[1-9]`));
          // §9a.3 — and it names THIS class's remedy, not the one generic "run the census"
          // sentence, which is false for all five: `--apply` refuses to write while any is non-zero.
          expect(error.message).toContain(REMEDIES[row.id]);
          for (const [id, remedy] of Object.entries(REMEDIES)) {
            if (id !== row.id) expect(error.message).not.toContain(remedy);
          }
          expect(error.message).not.toContain(GENERIC_REMEDY);
        }

        const check = await app.inject({
          method: "GET",
          url: "/api/v1/profiles/simulation/execution-policy",
          headers: headers(),
        });
        expect(check.json().data.policy.bounceExit.applyToAllMarkets).toBe(false);
      },
    );
  });
});
