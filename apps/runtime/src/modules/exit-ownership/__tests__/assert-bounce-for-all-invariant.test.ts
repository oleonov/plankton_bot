import { bootstrapControlDb, bootstrapLedgerDb, type OwnershipInvariantId } from "@krabs/db";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertBounceForAllOwnershipInvariant,
  BounceForAllNullOwnerError,
  countActiveNullOwnerPositions,
  reportAbandonedDrainWaiver,
  runOwnershipInvariantStartupGate,
} from "../assert-bounce-for-all-invariant.js";

/**
 * Release A Phase 5 startup guard, widened to I1–I5 in Phase 6 — §9a.6 tests 6 and 7.
 *
 * The fixture is built from the REAL migrations (`bootstrapLedgerDb`). The Phase-5 version of this
 * file hand-rolled `CREATE TABLE positions (position_id, status, exit_owner)`, which cannot survive
 * the widening: the shared reader queries `orders` and `fills` too, so every case would die on
 * `no such table: orders`. Its five original cases are preserved verbatim in meaning below.
 *
 * KNOWN DEVIATION from §9a.6 5(e): the plan asks for ONE shared fixture helper behind both this
 * matrix and the API gate's. The two live in `apps/runtime` and `apps/api`, which cannot import
 * each other, cannot import a `packages/db` test module (its `exports` map exposes only `"."`, and
 * `rootDir: "src"` makes a relative cross-package import a TS6059 build error), and there is no
 * `packages/test-utils`. The seven seeds are therefore duplicated in the two app test files. The
 * duplication is self-checking rather than silent: every row asserts a NON-ZERO count for its OWN
 * class, so a drifted seed fails loudly instead of quietly weakening the gate.
 */

let tmpDir: string;
let ledger: ReturnType<typeof bootstrapLedgerDb>;
let control: ReturnType<typeof bootstrapControlDb>;
let db: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "krabs-startup-gate-"));
  ledger = bootstrapLedgerDb(path.join(tmpDir, "ledger.db"));
  control = bootstrapControlDb(path.join(tmpDir, "control.db"));
  // The singleton row is created by the control migrations (037/038/040 `INSERT OR IGNORE`),
  // which a freshly-bootstrapped DB records as already-applied baseline rather than running.
  // Production always has it; without it the gate's UPDATE would match nothing and every
  // persist assertion below would be vacuous.
  control.db.prepare("INSERT OR IGNORE INTO runtime_control_state (id) VALUES (1)").run();
  db = ledger.db;
});

afterEach(() => {
  ledger.close();
  control.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedPosition(s: {
  positionId: string;
  tokenId: string;
  status?: string;
  size?: number;
  exitOwner?: "bounce" | "profile" | null;
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
}): void {
  const size = s.size ?? 10;
  db.prepare(
    `INSERT INTO orders (order_id, client_order_id, token_id, side, order_type, price, size,
                         size_usdc, status, decision_rule_id, position_id, bot_run_id)
     VALUES (?, ?, ?, 'sell', 'GTC', 0.5, ?, ?, ?, ?, ?, 'test-run')`,
  ).run(
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

/** An owned position with one well-sized, rule-consistent resting SELL: clean on all six. */
function seedCleanBaseline(): void {
  seedPosition({ positionId: "p-clean", tokenId: "tok-clean", exitOwner: "profile", size: 100 });
  seedSell({ orderId: "o-clean", tokenId: "tok-clean", positionId: "p-clean", size: 10 });
}

/**
 * §9a.6 5(e)/6(g) — one seeded violation per class on an otherwise-clean ledger. The seventh row
 * is the singleton out-of-domain NULL owner: under an enumerated `status IN ('open','dust')`
 * detector the whole record reads clean and the gate lets the enable through, so this row is the
 * one that separates the two implementations at the boundary.
 */
const VIOLATION_SEEDS: ReadonlyArray<{
  id: OwnershipInvariantId;
  label: string;
  seed: () => void;
}> = [
  {
    id: "nullOwners",
    label: "nullOwners — an open position with no owner",
    seed: () => seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: null }),
  },
  {
    id: "unboundSells",
    label: "I1 — an active SELL bound to no position",
    seed: () => {
      seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: "profile", size: 100 });
      seedSell({ orderId: "o-x", tokenId: "tok-x", positionId: null, size: 10 });
    },
  },
  {
    id: "stalePointerSells",
    label: "I2 — an active SELL pointing at a closed position",
    seed: () => {
      seedPosition({ positionId: "p-live", tokenId: "tok-x", exitOwner: "profile", size: 100 });
      seedPosition({ positionId: "p-gone", tokenId: "tok-x", status: "closed" });
      seedSell({ orderId: "o-x", tokenId: "tok-x", positionId: "p-gone", size: 10 });
    },
  },
  {
    id: "overcommittedTokens",
    label: "I3 — more remaining SELL shares than the position holds",
    seed: () => {
      seedPosition({ positionId: "p-x", tokenId: "tok-x", exitOwner: "profile", size: 10 });
      seedSell({ orderId: "o-x", tokenId: "tok-x", positionId: "p-x", size: 50 });
    },
  },
  {
    id: "duplicateNonclosedTokens",
    label: "I4 — two nonclosed positions on one token (open + dust)",
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
    seed: () => seedPosition({ positionId: "p-odd", tokenId: "tok-odd", status: "repairing" }),
  },
];

/**
 * §9a.3 — the action each class actually needs. HARD-CODED rather than imported from
 * `OWNERSHIP_INVARIANT_ROW_SQL`: importing the table would assert the formatter against its own
 * source and pass on any text whatsoever, including the single generic sentence this replaces.
 *
 * `nullOwners` names the reconcile-first step because the invariant ranges over `status <> 'closed'`
 * while the census targets `status IN ('open','dust')` — "just run `--apply`" returns an operator
 * holding an out-of-domain row to the identical fatal, forever.
 */
const REMEDIES: Readonly<Record<OwnershipInvariantId, string>> = {
  nullOwners:
    "reconcile any nonclosed position whose status is outside open/dust, then run the census --apply",
  unboundSells: "cancel the listed unbound SELL order(s)",
  stalePointerSells: "cancel the listed stale-pointer SELL order(s)",
  overcommittedTokens: "cancel or reduce the excess SELL commitment on the listed token(s)",
  duplicateNonclosedTokens: "reconcile the listed token(s) down to one nonclosed position",
  wrongOwnerSells: "cancel the listed wrong-owner SELL order(s)",
};

/** The pre-v25 text, kept as an explicit anti-oracle so the fix cannot silently regress into it. */
const GENERIC_REMEDY = "run the census to repair ownership before resuming";

interface RecordingLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  fatal(obj: object, msg: string): void;
  warns: Array<{ obj: object; msg: string }>;
  errors: Array<{ obj: object; msg: string }>;
  fatals: Array<{ obj: object; msg: string }>;
}

function makeLogger(): RecordingLogger {
  const warns: Array<{ obj: object; msg: string }> = [];
  const errors: Array<{ obj: object; msg: string }> = [];
  const fatals: Array<{ obj: object; msg: string }> = [];
  return {
    warns,
    errors,
    fatals,
    warn: (obj, msg) => void warns.push({ obj, msg }),
    error: (obj, msg) => void errors.push({ obj, msg }),
    fatal: (obj, msg) => void fatals.push({ obj, msg }),
  };
}

function controlState(conn: Database.Database = control.db) {
  return conn
    .prepare("SELECT runtime_status, paused FROM runtime_control_state WHERE id = 1")
    .get() as { runtime_status: string | null; paused: number };
}

// ─── §9a.6 test 7 — the five Phase-5 cases, on the real schema ────────────────────────────────

describe("assertBounceForAllOwnershipInvariant (Release A Phase 5 startup guard)", () => {
  it("is a no-op when applyToAllMarkets is false, even with a NULL-owner open position", () => {
    seedPosition({ positionId: "p1", tokenId: "tok-1", exitOwner: null });
    expect(() => assertBounceForAllOwnershipInvariant(db, false)).not.toThrow();
  });

  it("passes when applyToAllMarkets is true and every active/dust position has an owner", () => {
    seedPosition({ positionId: "p1", tokenId: "tok-1", exitOwner: "bounce" });
    seedPosition({ positionId: "p2", tokenId: "tok-2", status: "dust", exitOwner: "profile" });
    // a closed NULL owner does not count
    seedPosition({ positionId: "p3", tokenId: "tok-3", status: "closed", exitOwner: null });
    expect(() => assertBounceForAllOwnershipInvariant(db, true)).not.toThrow();
  });

  it("throws when applyToAllMarkets is true and an OPEN NULL-owner position exists", () => {
    seedPosition({ positionId: "p1", tokenId: "tok-1", exitOwner: null });
    expect(() => assertBounceForAllOwnershipInvariant(db, true)).toThrow(
      BounceForAllNullOwnerError,
    );
  });

  it("throws when applyToAllMarkets is true and a DUST NULL-owner position exists", () => {
    seedPosition({ positionId: "p1", tokenId: "tok-1", status: "dust", exitOwner: null });
    let thrown: unknown;
    try {
      assertBounceForAllOwnershipInvariant(db, true);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BounceForAllNullOwnerError);
    expect((thrown as BounceForAllNullOwnerError).nullOwners).toBe(1);
  });

  it("counts only active NULL owners", () => {
    seedPosition({ positionId: "p1", tokenId: "tok-1", exitOwner: null });
    seedPosition({ positionId: "p2", tokenId: "tok-2", status: "dust", exitOwner: null });
    seedPosition({ positionId: "p3", tokenId: "tok-3", status: "closed", exitOwner: null });
    seedPosition({ positionId: "p4", tokenId: "tok-4", exitOwner: "bounce" });
    expect(countActiveNullOwnerPositions(db)).toBe(2);
  });
});

// ─── §9a.6 test 6 — the boot-time gate ────────────────────────────────────────────────────────

describe("runOwnershipInvariantStartupGate", () => {
  it("(a) hard-stops on an I5 violation: persists failed/paused and logs the counts", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i5", tokenId: "tok-i5", exitOwner: "profile", size: 100 });
    seedSell({
      orderId: "o-i5",
      tokenId: "tok-i5",
      positionId: "p-i5",
      ruleId: "BOUNCE_EXIT_TARGET",
    });
    const log = makeLogger();

    expect(() =>
      runOwnershipInvariantStartupGate({
        ledgerDb: db,
        controlDb: control.db,
        applyToAllMarkets: true,
        log,
      }),
    ).toThrow(BounceForAllNullOwnerError);

    expect(controlState()).toEqual({ runtime_status: "failed", paused: 1 });
    expect(log.fatals).toHaveLength(1);
    // the counts, not a hard-coded NULL-owner string
    expect(log.fatals[0]!.obj).toMatchObject({ wrongOwnerSells: 1, nullOwners: 0 });
    expect(log.errors).toHaveLength(0);
  });

  it("(b) negative control: with the flag FALSE the same violating ledger boots", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i5", tokenId: "tok-i5", exitOwner: "profile", size: 100 });
    seedSell({
      orderId: "o-i5",
      tokenId: "tok-i5",
      positionId: "p-i5",
      ruleId: "BOUNCE_EXIT_TARGET",
    });
    const before = controlState();
    const log = makeLogger();

    expect(() =>
      runOwnershipInvariantStartupGate({
        ledgerDb: db,
        controlDb: control.db,
        applyToAllMarkets: false,
        log,
      }),
    ).not.toThrow();

    expect(controlState()).toEqual(before);
    expect(log.fatals).toHaveLength(0);
  });

  it("(c) reader failure (not a BounceForAllNullOwnerError) STILL persists failed/paused", () => {
    // The pre-Phase-6 typed catch let this class escape to the top-level handler, which exits
    // without persisting — leaving control.db saying `running`.
    db.exec("DROP TABLE orders");
    const log = makeLogger();

    let thrown: unknown;
    try {
      runOwnershipInvariantStartupGate({
        ledgerDb: db,
        controlDb: control.db,
        applyToAllMarkets: true,
        log,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(BounceForAllNullOwnerError);
    expect(String((thrown as Error).message)).toContain("orders");
    expect(controlState()).toEqual({ runtime_status: "failed", paused: 1 });
    expect(log.fatals).toHaveLength(1);
    expect(log.fatals[0]!.msg).toContain("startup ownership-invariant check failed");
  });

  it("(d) persist failure is LOGGED, never thrown — the invariant error still escapes", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-i5", tokenId: "tok-i5", exitOwner: "profile", size: 100 });
    seedSell({
      orderId: "o-i5",
      tokenId: "tok-i5",
      positionId: "p-i5",
      ruleId: "BOUNCE_EXIT_TARGET",
    });
    const readonlyControl = new Database(path.join(tmpDir, "control.db"), { readonly: true });
    const log = makeLogger();

    let thrown: unknown;
    try {
      runOwnershipInvariantStartupGate({
        ledgerDb: db,
        controlDb: readonlyControl,
        applyToAllMarkets: true,
        log,
      });
    } catch (err) {
      thrown = err;
    }
    readonlyControl.close();

    // Without the inner try/catch the SQLITE_READONLY write error replaces this one, and the
    // operator debugs the wrong failure.
    expect(thrown).toBeInstanceOf(BounceForAllNullOwnerError);
    expect(log.errors).toHaveLength(1);
    expect(log.errors[0]!.msg).toContain("failed to persist failed/paused control state");
    expect(log.fatals).toHaveLength(1);
  });

  describe("(g) per-class boundary matrix — a wrapper that ignores I1–I4 boots a violating ledger", () => {
    it.each(VIOLATION_SEEDS.map((s) => [s.label, s] as const))("%s ⇒ hard-stop", (_label, s) => {
      seedCleanBaseline();
      s.seed();
      const log = makeLogger();

      let thrown: unknown;
      try {
        runOwnershipInvariantStartupGate({
          ledgerDb: db,
          controlDb: control.db,
          applyToAllMarkets: true,
          log,
        });
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(BounceForAllNullOwnerError);
      expect((thrown as BounceForAllNullOwnerError).counts[s.id]).toBeGreaterThan(0);
      expect(controlState()).toEqual({ runtime_status: "failed", paused: 1 });
      expect(log.fatals[0]!.obj).toMatchObject({ [s.id]: expect.any(Number) });
      expect((log.fatals[0]!.obj as Record<string, number>)[s.id]).toBeGreaterThan(0);
    });

    it.each(VIOLATION_SEEDS.map((s) => [s.label, s] as const))(
      "%s ⇒ still boots with the flag FALSE (the widening stays inert while disabled)",
      (_label, s) => {
        seedCleanBaseline();
        s.seed();
        const before = controlState();
        const log = makeLogger();

        expect(() =>
          runOwnershipInvariantStartupGate({
            ledgerDb: db,
            controlDb: control.db,
            applyToAllMarkets: false,
            log,
          }),
        ).not.toThrow();

        expect(controlState()).toEqual(before);
        expect(log.fatals).toHaveLength(0);
      },
    );
  });

  // ─── §9a.3 — the remedy is per class, because the census writes one column ──────────────────

  describe("(h) the fatal names the remedy for the violated class, and for no other", () => {
    it.each(VIOLATION_SEEDS.map((s) => [s.label, s] as const))("%s", (_label, s) => {
      seedCleanBaseline();
      s.seed();
      const log = makeLogger();

      let thrown: unknown;
      try {
        runOwnershipInvariantStartupGate({
          ledgerDb: db,
          controlDb: control.db,
          applyToAllMarkets: true,
          log,
        });
      } catch (err) {
        thrown = err;
      }

      const error = thrown as BounceForAllNullOwnerError;
      // Self-check: every seed is built to fire exactly ONE class, which is what makes the
      // "and for no other" half below an assertion rather than an accident.
      expect(Object.entries(error.counts).filter(([, n]) => n > 0)).toEqual([[s.id, 1]]);

      const msg = log.fatals[0]!.msg;
      expect(msg).toContain(REMEDIES[s.id]);
      expect(error.message).toContain(REMEDIES[s.id]);
      for (const [id, remedy] of Object.entries(REMEDIES)) {
        if (id !== s.id) expect(msg).not.toContain(remedy);
      }
      // A single generic sentence would satisfy the old matrix (counts only) on every row.
      expect(msg).not.toContain(GENERIC_REMEDY);
    });
  });
});

/**
 * The pre-start read proves the ledger the process INHERITED. It cannot prove the ledger the fence
 * is released onto, because `supervisor.start()` writes to that same ledger in between — and one of
 * those writes is `ReconciliationModule.start()`'s awaited startup pass, whose missing-remote
 * auto-close marks a position `closed` and leaves the SELL resting against it untouched.
 */
describe("runOwnershipInvariantStartupGate — the pre-fence-release checkpoint", () => {
  /** Exactly what `closeMissingRemotePosition` writes: status only, the resting SELL untouched. */
  function reconciliationAutoClose(positionId: string): void {
    db.prepare("UPDATE positions SET status = 'closed', size = 0 WHERE position_id = ?").run(
      positionId,
    );
  }

  it("catches a violation module startup created after the pre-start read passed", () => {
    seedCleanBaseline();
    const preStart = makeLogger();
    runOwnershipInvariantStartupGate({
      ledgerDb: db,
      controlDb: control.db,
      applyToAllMarkets: true,
      log: preStart,
    });
    expect(preStart.fatals).toHaveLength(0);
    expect(controlState().runtime_status).not.toBe("failed");

    reconciliationAutoClose("p-clean");

    const preRelease = makeLogger();
    expect(() =>
      runOwnershipInvariantStartupGate({
        ledgerDb: db,
        controlDb: control.db,
        applyToAllMarkets: true,
        log: preRelease,
        phase: "pre-fence-release",
      }),
    ).toThrow(BounceForAllNullOwnerError);

    expect(controlState()).toEqual({ runtime_status: "failed", paused: 1 });
    expect(preRelease.fatals).toHaveLength(1);
    expect(preRelease.fatals[0]!.obj).toMatchObject({
      stalePointerSells: 1,
      phase: "pre-fence-release",
    });
    // The diagnosis is the whole point of the phase: "already broken on boot" and "module startup
    // broke it" send the operator to different places.
    expect(preRelease.fatals[0]!.msg).toContain("pre-fence-release");
    expect(preRelease.fatals[0]!.msg).toContain("module startup");
  });

  it("stays inert with the flag off, exactly like the pre-start read", () => {
    seedCleanBaseline();
    reconciliationAutoClose("p-clean");
    const before = controlState();
    const log = makeLogger();

    expect(() =>
      runOwnershipInvariantStartupGate({
        ledgerDb: db,
        controlDb: control.db,
        applyToAllMarkets: false,
        log,
        phase: "pre-fence-release",
      }),
    ).not.toThrow();

    expect(controlState()).toEqual(before);
    expect(log.fatals).toHaveLength(0);
  });

  it("keeps excusing the drain targets the pre-start read deferred, without re-announcing them", () => {
    seedCleanBaseline();
    seedPosition({ positionId: "p-gone", tokenId: "tok-drain", status: "closed" });
    seedSell({ orderId: "o-drain", tokenId: "tok-drain", positionId: "p-gone" });
    const drainedOrderIds = new Set(["o-drain"]);

    const preStart = makeLogger();
    runOwnershipInvariantStartupGate({
      ledgerDb: db,
      controlDb: control.db,
      applyToAllMarkets: true,
      log: preStart,
      drainedOrderIds,
    });
    expect(preStart.warns).toHaveLength(1);

    const preRelease = makeLogger();
    expect(() =>
      runOwnershipInvariantStartupGate({
        ledgerDb: db,
        controlDb: control.db,
        applyToAllMarkets: true,
        log: preRelease,
        drainedOrderIds,
        phase: "pre-fence-release",
      }),
    ).not.toThrow();
    // The cancel is still in flight, so the raw ledger still reports it — but the waiver was
    // announced once, at the checkpoint that granted it, and the fence gate has since proved it.
    expect(preRelease.warns).toHaveLength(0);
    expect(preRelease.fatals).toHaveLength(0);
  });
});

/**
 * The deferral is only sound while the excuse and its remedy are inseparable: the gate waives a
 * drain target's violation on the promise that `seedStartupTransitions` will cancel it. A boot
 * abort placed BETWEEN the two breaks that promise silently — the waiver is granted and the process
 * exits before the drain runs. So the ordering is the invariant, and boot ordering in `index.ts` is
 * plain top-level statements with no seam a unit test could drive; asserting on the source is the
 * only way to make a regression fail loudly instead of shipping.
 */
describe("boot ordering — the deferral's excuse cannot outlive its remedy", () => {
  const src = readFileSync(new URL("../../../index.ts", import.meta.url), "utf8");
  const at = (needle: string): number => {
    const i = src.indexOf(needle);
    expect(i, `${needle} not found in index.ts`).toBeGreaterThan(-1);
    return i;
  };

  it("grants the drain waiver after every abort that could skip the drain", () => {
    const gate = at("runOwnershipInvariantStartupGate({");
    const fence = at("executionModule.beginStartupFence()");
    expect(gate).toBeLessThan(fence);

    const abortsBeforeFence = [...src.slice(0, fence).matchAll(/process\.exit\(1\)/g)].map(
      (m) => m.index,
    );
    expect(abortsBeforeFence.length).toBeGreaterThan(0);
    for (const abort of abortsBeforeFence) expect(abort).toBeLessThan(gate);
  });

  it("re-proves the waiver after the drain is seeded and before the fence is released", () => {
    expect(at("seedStartupTransitions(")).toBeLessThan(at("runDrainedOrderFenceGate({"));
    expect(at("runDrainedOrderFenceGate({")).toBeLessThan(at("endStartupFence()"));
  });

  /**
   * The waiver is not the only thing the fence release depends on. `supervisor.start()` sits between
   * the pre-start gate and the release, and `ReconciliationModule.start()` `await`s a reconciliation
   * pass that can close a position out from under a correctly-bound resting SELL — a violation the
   * pre-start read cannot have seen and no drain target covers. So the ledger has to be re-proved
   * against the SAME projection right before the fence comes down.
   */
  it("re-proves the ownership invariants after module startup, before the fence is released", () => {
    const gates = [...src.matchAll(/runOwnershipInvariantStartupGate\(\{/g)].map((m) => m.index);
    expect(gates).toHaveLength(2);
    expect(gates[1]).toBeGreaterThan(at("runDrainedOrderFenceGate({"));
    expect(gates[1]).toBeLessThan(at("endStartupFence()"));
    // Same projection as the pre-start read — the drain targets it excused must stay excused, since
    // their cancels are in flight; only violations module startup CREATED may trip this one.
    expect(src.slice(gates[1], at("endStartupFence()"))).toContain("drainedOrderIds,");
    expect(src.slice(gates[1], at("endStartupFence()"))).toContain('phase: "pre-fence-release"');
  });

  /**
   * The policy is a live read, not a boot constant — `currentExecutionPolicy()` re-reads control.db
   * on every call with no throttle. The sanctioned activation sequence is "deploy, then enable
   * applyToAllMarkets", so the flag can flip ON while `supervisor.start()` is still running: the API
   * certifies the ledger it sees, the awaited reconciliation pass then breaks it, and a boot-time
   * snapshot of `false` would release the fence having never proved the ledger the flag now demands.
   */
  it("re-reads the policy at the fence release rather than trusting the pre-start snapshot", () => {
    const fresh = at("const bounceAppliesAtFenceRelease = currentExecutionPolicy()");
    expect(fresh).toBeGreaterThan(at("seedStartupTransitions("));
    expect(fresh).toBeLessThan(at("runDrainedOrderFenceGate({"));

    const gates = [...src.matchAll(/runOwnershipInvariantStartupGate\(\{/g)].map((m) => m.index);
    expect(src.slice(gates[1], at("endStartupFence()"))).toContain(
      "applyToAllMarkets: bounceAppliesAtFenceRelease,",
    );
  });

  /**
   * A fresh `true` at that checkpoint excuses `drainedOrderIds` through the projection. But if the
   * flag was off at boot, gate #1 deferred nothing and left no waiver — so gating the fence gate on
   * the latch alone would hand out the excuse with no barrier backing it, which is precisely what
   * the deferral's second half exists to refuse.
   */
  it("proves the drain whenever the checkpoint will excuse it, latch or not", () => {
    const guard = src.slice(at("if (drainWaiverOutstanding ||"), at("runDrainedOrderFenceGate({"));
    expect(guard).toContain("bounceAppliesAtFenceRelease && drainedOrderIds.size > 0");
  });

  /**
   * `classifyStartupTransitionTargets` quarantines reopening BUYs alongside stale SELLs, and the
   * status predicate reads only the status column. Without the side filter a BUY raises the latch
   * while deferring nothing, and the abandoned-waiver fatal calls it a SELL.
   */
  it("admits only SELLs to the waiver, since only SELLs are in the relation being deferred", () => {
    const decl = at("const drainedOrderIds = new Set(");
    const body = src.slice(decl, src.indexOf("runOwnershipInvariantStartupGate({", decl));
    expect(body).toContain('order.side === "sell"');
    expect(body).toContain("isWorkingSellOrderStatus(order.status)");
  });

  /**
   * The fence gate already persists failed state and names the precise subset it could not prove;
   * the broad abandoned-waiver report on top of it would bury that diagnosis under every candidate.
   */
  it("does not re-report every candidate when the fence gate already named the exact subset", () => {
    const guard = src.slice(
      at("if (drainWaiverOutstanding &&"),
      at("reportAbandonedDrainWaiver({"),
    );
    expect(guard).toContain("!(err instanceof DrainedOrderUnfencedError)");
  });

  /**
   * The ordering assertions above only bound `process.exit(1)`, and that is all they CAN bound: the
   * remaining span from the waiver to the drain contains `await supervisor.start()`, a rejecting
   * module start, and a `LifecycleSupersededError` return — none of them a literal exit, none of
   * them removable by reordering, since the drain is itself awaited work that can reject. So the
   * latch is what has to hold, and it holds only while it is cleared in exactly one place.
   */
  it("clears the waiver latch only where the drain is proven, and reports it on every abort", () => {
    // Raised where the waiver is granted, so no earlier statement can leave it stale-true.
    expect(at("let drainWaiverOutstanding")).toBeGreaterThan(
      at("runOwnershipInvariantStartupGate({"),
    );
    // Lowered in exactly one place, and that place is after the fence gate proved the drain.
    const cleared = [...src.matchAll(/drainWaiverOutstanding = false/g)].map((m) => m.index);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!).toBeGreaterThan(at("runDrainedOrderFenceGate({"));
    // And the abort path reads it, rather than the latch being write-only bookkeeping.
    expect(at("reportAbandonedDrainWaiver({")).toBeGreaterThan(cleared[0]!);
  });
});

/**
 * The third outcome of the deferral. "Drained" and "unfenced" are covered above; this is the boot
 * that died of something else entirely in between — and the only thing at stake is whether the
 * operator can still find the SELL orders the gate excused.
 */
describe("reportAbandonedDrainWaiver", () => {
  it("names the excused orders and leaves control.db failed+paused", () => {
    const log = makeLogger();
    reportAbandonedDrainWaiver({
      controlDb: control.db,
      drainedOrderIds: new Set(["o-drain-1", "o-drain-2"]),
      log,
    });

    expect(log.fatals).toHaveLength(1);
    expect(log.fatals[0]!.obj).toMatchObject({ orderIds: ["o-drain-1", "o-drain-2"] });
    expect(log.fatals[0]!.msg).toContain("resting on the exchange with no owning position");
    const row = control.db
      .prepare("SELECT runtime_status, paused FROM runtime_control_state WHERE id = 1")
      .get() as { runtime_status: string; paused: number };
    expect(row).toEqual({ runtime_status: "failed", paused: 1 });
  });

  it("stays silent when the gate never deferred anything", () => {
    const log = makeLogger();
    reportAbandonedDrainWaiver({ controlDb: control.db, drainedOrderIds: new Set(), log });

    expect(log.fatals).toHaveLength(0);
    const row = control.db
      .prepare("SELECT runtime_status FROM runtime_control_state WHERE id = 1")
      .get() as { runtime_status: string | null };
    expect(row.runtime_status).not.toBe("failed");
  });
});
