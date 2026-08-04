import { OWNERSHIP_INVARIANT_GUARD_SQL } from "@krabs/db";
import { describe, expect, it } from "vitest";

import { CENSUS_GUARD_IDS } from "../generate-sql.js";
import {
  OTHER_CONDITION,
  cleanSeed,
  seedSql,
  soloTargetSeed,
  WHITELISTED_CONDITION,
  type PositionSeed,
} from "./fixtures.js";
import {
  CHECK_FAILED,
  emittedGuards,
  expectRolledBack,
  findGuard,
  prepareApply,
  probeGuard,
  removeGuards,
  type GuardRef,
  type PreparedApply,
} from "./pipeline.js";

/**
 * §7 test 7a — guard-inventory completeness AND semantics, table-driven over the twelve rows of §5.4.1 C.
 *
 * `CASES` is the test's ORACLE: it is asserted equal to `CENSUS_GUARD_IDS`, so a guard added to the
 * inventory and not to this table fails here rather than shipping untested (v22 — final-fresh-review
 * Major 1). Each row is then asserted on three axes:
 *
 *  - **presence** — one `census_guard` insert carries it (the ordered-inventory test below);
 *  - **sensitivity** — with a violation of exactly that class seeded, the guard's own `SELECT` evaluates
 *    to `0` and the run reaches `ROLLBACK` with no `exit_owner` changed ANYWHERE;
 *  - **specificity** — on a clean fixture the same guard evaluates to `1`, so a guard that is simply
 *    always false — which passes a presence-only and a sensitivity-only test — fails here.
 *
 * The mutation axis carries a DECLARED expected outcome per row, not a uniform one (v20 —
 * final-fresh-review Major 6). The guards are deliberately not disjoint: rows 2 and 9 seed a nonclosed
 * NULL-owner row the manifest does not cover, which guard #5's `nullOwners` entry sees too, so demanding
 * `COMMIT` after deleting them alone would fail a CORRECT implementation. Those two rows assert the
 * overlap BY NAME instead — and then that the pair is jointly load-bearing.
 */

// ───────────────────────────── the twelve rows ─────────────────────────────

const SOLO: PositionSeed = {
  positionId: "pos-solo",
  tokenId: "tok-solo",
  conditionId: WHITELISTED_CONDITION,
  entryLane: "R23",
  size: 12.5,
};

/** The clean ledger every specificity assertion reads, and the default every violation is built on. */
const CLEAN_SEED = soloTargetSeed(SOLO);

interface GuardCase extends GuardRef {
  /** The violation this row exists to catch, in the operator's words. */
  readonly what: string;
  /** The ledger AT EXPORT TIME. Defaults to the clean single-target fixture. */
  readonly seed?: string;
  /** The violation as drift BETWEEN export and lock — the class most guards are re-checks for. */
  readonly arrive?: (applied: PreparedApply) => void;
  /** The violation as an edit of the emitted script (guard #6's class alone). */
  readonly tamper?: (applySql: string) => string;
  /** What deleting this row from the inventory does — NOT uniform; see the header. */
  readonly deleted: "commits" | "nullOwners";
}

const CASES: readonly GuardCase[] = [
  {
    id: "9",
    what: "a status outside ('open','dust','closed') arriving before the lock",
    // Built AFTER the export on purpose (v22 — author A33): the same row present BEFORE it aborts the
    // dry run at §5.3's local Status-domain gate, and the under-lock half is never exercised at all.
    // The token is shared with no other nonclosed row and carries no orders, so I1–I5 are all blind to
    // it; `nullOwners` is the one deliberate exception, which is what the mutation axis asserts.
    arrive: (a) =>
      a.fixture.seed(
        seedSql({
          positions: [
            { positionId: "pos-repairing", tokenId: "tok-repairing", status: "repairing" },
          ],
        }),
      ),
    deleted: "nullOwners",
  },
  {
    id: "1b",
    what: "the execution policy row deleted between export and lock",
    // With the row gone, #1's equality fence and #6's CROSS JOIN both range over ZERO rows and pass
    // vacuously — which is precisely why #1b exists and why deleting it alone reaches COMMIT.
    arrive: (a) =>
      a.fixture.seedControl("DELETE FROM profile_settings WHERE profile_id = 'live-lite';"),
    deleted: "commits",
  },
  {
    id: "1",
    what: "the live policy text edited between export and lock",
    // A trailing space: `json_extract` on 3.37.2 tolerates surrounding whitespace, so #6 still agrees
    // and this seeds the byte-level drift #1 owns and NOTHING else can see.
    arrive: (a) =>
      a.fixture.seedControl(
        `UPDATE profile_settings SET execution_policy_json = execution_policy_json || ' '
           WHERE profile_id = 'live-lite';`,
      ),
    deleted: "commits",
  },
  {
    id: "2",
    what: "a NULL-owner target that arrived after the export",
    arrive: (a) =>
      a.fixture.seed(
        seedSql({ positions: [{ positionId: "pos-arrival", tokenId: "tok-arrival" }] }),
      ),
    deleted: "nullOwners",
  },
  {
    id: "3",
    what: "a routing input that moved between export and lock",
    // 0.01 shares — the granularity a fill actually moves a position by. Neither the CAS nor #6 nor #8
    // reads `size`, so this is #3's class and only #3's.
    arrive: (a) =>
      a.fixture.seed("UPDATE positions SET size = 12.51 WHERE position_id = 'pos-solo';"),
    deleted: "commits",
  },
  {
    id: "3b",
    what: "a target whose token has no authoritative market row at all",
    // Seeded BEFORE the export, because absence at BOTH times is the whole class: #3 compares the two
    // and they agree (NULL against NULL), which is the blind spot #3b exists for.
    seed: soloTargetSeed(SOLO, { withMarket: false }),
    deleted: "commits",
  },
  {
    id: "4",
    what: "order evidence contradicting a populated positions.condition_id",
    // A BUY that FILLED: it carries a condition (evidence) without being an active SELL, so I1–I3/I5
    // stay silent and only #4's re-check fires.
    seed: `${CLEAN_SEED}\n${seedSql({
      orders: [
        {
          orderId: "o-conflict",
          tokenId: SOLO.tokenId,
          conditionId: OTHER_CONDITION,
          side: "buy",
          status: "filled",
        },
      ],
    })}`,
    deleted: "commits",
  },
  {
    id: "5",
    entry: "unboundSells",
    what: "an I1 violation created after the export",
    arrive: (a) =>
      a.fixture.seed(
        seedSql({
          orders: [
            { orderId: "o-unbound", tokenId: SOLO.tokenId, side: "sell", status: "open", size: 1 },
          ],
        }),
      ),
    deleted: "commits",
  },
  {
    id: "6",
    what: "a planned owner the under-lock re-derivation does not agree with",
    // The ONLY row whose violation lives in the SCRIPT rather than in the ledger: #6 compares the
    // manifest's planned owner against the rows read under the lock, so the tamper flips the plan.
    // Both emission sites move together (the `manifest_targets` row and its CAS) so that #8's map still
    // agrees — otherwise #8 would fire too and the row would not be isolated.
    tamper: (sql) =>
      sql
        .replaceAll(", 'bounce')", ", 'profile')")
        .replace("SET exit_owner = 'bounce'", "SET exit_owner = 'profile'"),
    deleted: "commits",
  },
  {
    id: "7",
    what: "a timestamp whose SHAPE the pinned conversion misreads",
    // Two-digit milliseconds: `substr(ts,21,3)` reads `0Z` and the conversion is silently wrong. The
    // lane is GATE so the owner projection short-circuits before any conversion — nothing but #7 looks.
    seed: soloTargetSeed({ ...SOLO, entryLane: "GATE", openedAt: "2026-07-21T00:01:00.00Z" }),
    deleted: "commits",
  },
  {
    id: "7b",
    what: "a timestamp of valid shape that is not a real instant",
    // `24:01` passes the GLOB, converts fine in SQLite and is NaN in `Date.parse` — shape is not
    // validity, which is the whole reason #7b is a second row rather than a stricter #7.
    seed: soloTargetSeed({ ...SOLO, entryLane: "GATE", openedAt: "2026-07-21T24:01:00.000Z" }),
    deleted: "commits",
  },
  {
    id: "8",
    what: "a target that acquired a DIFFERENT owner before the lock",
    // Its CAS then changes zero rows while nothing errors — the silent partial census #8 is a failing
    // STATEMENT (rather than a bare SELECT) to catch.
    arrive: (a) =>
      a.fixture.seed("UPDATE positions SET exit_owner = 'profile' WHERE position_id = 'pos-solo';"),
    deleted: "commits",
  },
];

/** The fixture with this row's violation in place, however that row expresses one. */
function violate(c: GuardCase): PreparedApply {
  const applied = prepareApply(c.seed ?? CLEAN_SEED);
  c.arrive?.(applied);
  return c.tamper === undefined ? applied : { ...applied, applySql: c.tamper(applied.applySql) };
}

const NULL_OWNERS: GuardRef = { id: "5", entry: "nullOwners" };

describe("§7.7a — the guard inventory is exactly §5.4.1 C's twelve rows", () => {
  it("the case table below covers every row — a guard added to one and not the other fails here", () => {
    expect(CASES.map((c) => c.id)).toEqual([...CENSUS_GUARD_IDS]);
  });

  it("presence — one census_guard insert per row, in emission order, #5 expanded to its six", () => {
    const guards = emittedGuards(prepareApply(CLEAN_SEED).applySql);

    expect(guards.map((g) => g.id)).toEqual(
      CENSUS_GUARD_IDS.flatMap((id) =>
        id === "5" ? OWNERSHIP_INVARIANT_GUARD_SQL.map(() => "5") : [id],
      ),
    );
    // The six are named from the ONE definition in `@krabs/db`, so a renamed or reordered invariant
    // surfaces here instead of quietly changing which predicate guard #5 carries.
    expect(guards.filter((g) => g.id === "5").map((g) => g.title)).toEqual(
      OWNERSHIP_INVARIANT_GUARD_SQL.map(({ id }) => expect.stringContaining(id)),
    );
  });
});

// A plain loop rather than `describe.each`: the table's values ARE the test names here, and `$what`
// interpolation quotes and escapes them into something no one can read in a failure report.
for (const c of CASES) {
  describe(`§7.7a — guard #${c.id} — ${c.what}`, () => {
    it("specificity — reads 1 on a clean ledger", () => {
      expect(probeGuard(prepareApply(CLEAN_SEED), c)).toBe("1");
    });

    it("sensitivity — reads 0 under its own violation, and the whole run rolls back", () => {
      const applied = violate(c);

      expect(probeGuard(applied, c)).toBe("0");
      expectRolledBack(applied, CHECK_FAILED);
    });

    if (c.deleted === "commits") {
      it("deleting its inventory row lets the seeded violation reach COMMIT", () => {
        const applied = violate(c);
        const run = applied.fixture.runApply(removeGuards(applied.applySql, c));

        expect(run.stderr).toBe("");
        expect(run.ok).toBe(true);
        expect(applied.fixture.ownerMap()["pos-solo"]).not.toBeNull();
      });
    } else {
      it("deleting its row ALONE still rolls back — by guard #5's nullOwners entry, by name", () => {
        const applied = violate(c);

        expect(probeGuard(applied, NULL_OWNERS)).toBe("0");
        expectRolledBack(applied, CHECK_FAILED, removeGuards(applied.applySql, c));
      });

      it("deleting its row AND #5's nullOwners entry lets the arrival reach COMMIT", () => {
        const applied = violate(c);
        // The pair is jointly load-bearing: this is what keeps the test above from being a way to pass
        // without the property, and it is what would fail if a revision narrowed `nullOwners` back.
        const run = applied.fixture.runApply(
          removeGuards(removeGuards(applied.applySql, c), NULL_OWNERS),
        );

        expect(run.stderr).toBe("");
        expect(run.ok).toBe(true);
        expect(applied.fixture.ownerMap()["pos-solo"]).toBe("bounce");
      });
    }
  });
}

/**
 * The vanished-target case (final-fresh-review Critical #1), asserted where §7 test 7a asks for it: the
 * abort must be guard #3's LEFT JOIN doing its work, and the test must FAIL against v6's inner-`JOIN`
 * phrasing — under which a target whose position was deleted contributes no joined row at all, the guard
 * passes, and the remaining CASes commit a PARTIAL census.
 */
describe("§7.7a — a manifest target deleted before the lock", () => {
  function vanished(): PreparedApply {
    const applied = prepareApply(cleanSeed());
    applied.fixture.seed("DELETE FROM positions WHERE position_id = 'pos-profile';");
    return applied;
  }

  it("aborts the whole run, leaving every surviving target unowned", () => {
    expectRolledBack(vanished(), CHECK_FAILED);
  });

  it("guard #3 sees it ONLY because the join is LEFT — the inner-JOIN phrasing reads 1", () => {
    const applied = vanished();
    const guard3 = findGuard(applied.applySql, { id: "3" });

    expect(probeGuard(applied, { id: "3" })).toBe("0");
    expect(
      probeGuard(
        applied,
        { id: "3" },
        applied.applySql.replace(
          guard3.text,
          guard3.text.replace("LEFT JOIN positions", "JOIN positions"),
        ),
      ),
    ).toBe("1");
  });

  it("guard #8's cardinality half catches the same departure, from the other direction", () => {
    // #3 and #8 are directional opposites over the same set (§5.4.1 forms (i) and (ii)); only together
    // do they pin it, so the departure is asserted on both rather than on whichever fires first.
    expect(probeGuard(vanished(), { id: "8" })).toBe("0");
  });
});

/**
 * §7 test 11's negative control. Guard #2's inventory row above proves an arrival ABORTS the run; this
 * proves the guard cannot be satisfied by refusing everything — the same row, present IN the manifest,
 * must commit normally.
 *
 * It carries the `markets` and `leg_states` rows the positive case omits, and that is not cosmetic: a
 * target without them trips #3b and #6, so the run would abort for reasons that have nothing to do with
 * #2 and the control would prove nothing.
 */
describe("§7.11 — the arrival's negative control: the same row, inside the manifest", () => {
  it("commits, writing the planned owner for BOTH targets", () => {
    const applied = prepareApply(
      `${CLEAN_SEED}\n${soloTargetSeed({
        positionId: "pos-arrival",
        tokenId: "tok-arrival",
        entryLane: "R23",
      })}`,
    );
    expect(applied.plannedOwners).toEqual({ "pos-arrival": "bounce", "pos-solo": "bounce" });

    const run = applied.fixture.runApply(applied.applySql);
    expect(run.stderr).toBe("");
    expect(run.ok).toBe(true);
    expect(applied.fixture.ownerMap()).toEqual(applied.plannedOwners);
  });
});

/**
 * §7 test 12(f)'s middle fixture — the policy row PRESENT with `execution_policy_json IS NULL`. The three
 * fixtures are deliberately three: the ABSENT row is guard #1b's inventory row above, the DIFFERENT value
 * is #1's, and this one exists so a later editor cannot fold the NULL case into #1b and drop #1's `IS NOT`
 * phrasing as redundant. `IS NOT` is what makes #1 see it — under `<>` the comparison yields NULL, the row
 * drops out of the `WHERE`, and the fence passes on a policy the manifest never read.
 */
describe("§7.12(f) — the policy row present with a NULL execution_policy_json", () => {
  function nulled(): PreparedApply {
    const applied = prepareApply(CLEAN_SEED);
    applied.fixture.seedControl(
      "UPDATE profile_settings SET execution_policy_json = NULL WHERE profile_id = 'live-lite';",
    );
    return applied;
  }

  it("guard #1 reads 0 on its own — #1b fires too, but it is not what #1 depends on", () => {
    const applied = nulled();
    expect(probeGuard(applied, { id: "1" })).toBe("0");
    expect(probeGuard(applied, { id: "1b" })).toBe("0");
  });

  it("the run still aborts with #1b's inventory row deleted", () => {
    const applied = nulled();
    expectRolledBack(applied, CHECK_FAILED, removeGuards(applied.applySql, { id: "1b" }));
  });
});

/**
 * §7 test 14b — the authoritative market condition blanked to `''` between export and lock. `''` rather
 * than some other wrong value because it is what BOTH mappers manufacture from a missing upstream field
 * (`mappers.ts:248`, `:382`), so this is the shape production actually produces. The assertion is the
 * WHOLE-RUN one of test 7: every target still NULL, not merely the drifted row.
 */
describe("§7.14b — a target's market condition blanked to '' before the lock", () => {
  function blanked(): PreparedApply {
    const applied = prepareApply(cleanSeed());
    applied.fixture.seed("UPDATE markets SET condition_id = '' WHERE token_id = 'tok-bounce';");
    return applied;
  }

  it("guard #3b reads 0, and the whole run rolls back with EVERY target still unowned", () => {
    const applied = blanked();

    expect(probeGuard(applied, { id: "3b" })).toBe("0");
    expectRolledBack(applied, CHECK_FAILED);
    expect(Object.values(applied.fixture.ownerMap()).every((o) => o === null)).toBe(true);
  });

  it("#3 sees this drift too — but the abort survives #3's removal, so #3b is load-bearing", () => {
    const applied = blanked();

    expect(probeGuard(applied, { id: "3" })).toBe("0");
    expectRolledBack(applied, CHECK_FAILED, removeGuards(applied.applySql, { id: "3" }));
  });
});
